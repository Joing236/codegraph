"use strict";
/**
 * File Watcher
 *
 * Watches the project directory for file changes and triggers debounced sync
 * operations to keep the code graph up-to-date.
 *
 * Uses chokidar, whose `ignored` callback filters directories BEFORE they are
 * watched — so we never register inotify watches on excluded trees like
 * node_modules/, dist/, .git/ (fixes #276: recursive fs.watch exhausted the
 * kernel watch budget on large repos). The ignore decision reuses the indexer's
 * `buildDefaultIgnore` (built-in default-ignore dirs + the project's .gitignore)
 * so the watcher watches exactly the set the indexer indexes — in particular,
 * node_modules/build/cache dirs are excluded even when the repo has no
 * .gitignore (#407), which a .gitignore-only filter would miss.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileWatcher = exports.LockUnavailableError = void 0;
const path = __importStar(require("path"));
const chokidar_1 = __importDefault(require("chokidar"));
const extraction_1 = require("../extraction");
const errors_1 = require("../errors");
const utils_1 = require("../utils");
const watch_policy_1 = require("./watch-policy");
/**
 * Thrown by a `syncFn` to signal that the underlying sync couldn't acquire
 * the cross-process write lock (#449). The watcher treats this as "no
 * progress" — preserves `pendingFiles`, skips `onSyncComplete`, and the
 * `finally` block reschedules. Quiet (debug-only) because a long-running
 * external indexer can hit this every debounce cycle.
 */
class LockUnavailableError extends Error {
    constructor(message = 'CodeGraph file lock unavailable; another process is writing') {
        super(message);
        this.name = 'LockUnavailableError';
    }
}
exports.LockUnavailableError = LockUnavailableError;
/**
 * FileWatcher monitors a project directory for changes and triggers
 * debounced sync operations via a provided callback.
 *
 * Design goals:
 * - Minimal resource usage (chokidar filters excluded directories before
 *   registering an inotify watch — see module docs / #276)
 * - Debounced to avoid thrashing on rapid saves
 * - Filters to supported source files by extension
 * - Ignores .codegraph/ and .git/ regardless of .gitignore
 * - Tracks per-file pending state so MCP tools can flag stale results
 *   without blocking on a sync (issue #403)
 */
class FileWatcher {
    watcher = null;
    debounceTimer = null;
    /**
     * Files seen by the watcher since the last successful sync — populated on
     * every chokidar event, cleared at the start of a sync, and re-populated by
     * events that arrive mid-sync (or restored on sync failure). Keyed by the
     * same project-relative POSIX path the rest of the codebase uses, so a
     * caller can intersect tool-response file paths against this map cheaply.
     */
    pendingFiles = new Map();
    /**
     * Wall-clock ms at which the in-flight sync began. Combined with
     * {@link pendingFiles}'s `lastSeenMs`, this distinguishes "still in the
     * debounce window" (lastSeen > syncStarted, sync hasn't started yet for
     * this edit) from "currently being indexed" (lastSeen <= syncStarted).
     */
    syncStartedMs = 0;
    syncing = false;
    stopped = false;
    /**
     * False until chokidar fires its `ready` event. Gates `pendingFiles`
     * insertion so the initial crawl's `add` events (one per pre-existing
     * source file) don't pollute the per-file staleness signal. The events
     * still flow into `scheduleSync()` to preserve the previous "initial
     * scan triggers a reconciling sync" behavior.
     */
    chokidarReady = false;
    /**
     * Callbacks that resolve when chokidar fires `ready`. Used by tests (and
     * any production caller that cares about a clean baseline) to deterministically
     * gate on the end of the initial scan instead of guessing at a sleep duration.
     */
    readyWaiters = [];
    // The shared ignore matcher (built-in defaults + project .gitignore), built
    // once at start(). Same source of truth the indexer uses, so watcher scope
    // can never diverge from index scope.
    ignoreMatcher = null;
    projectRoot;
    debounceMs;
    syncFn;
    onSyncComplete;
    onSyncError;
    constructor(projectRoot, syncFn, options = {}) {
        this.projectRoot = projectRoot;
        this.syncFn = syncFn;
        this.debounceMs = options.debounceMs ?? 2000;
        this.onSyncComplete = options.onSyncComplete;
        this.onSyncError = options.onSyncError;
    }
    /**
     * Start watching for file changes.
     * Returns true if watching started successfully, false otherwise.
     */
    start() {
        if (this.watcher)
            return true; // Already watching
        this.stopped = false;
        // Some environments make filesystem watching unusable — most notably
        // WSL2 /mnt/ drives, where the underlying fs.watch calls block long
        // enough to break MCP startup handshakes (issue #199). Skip watching
        // there; callers fall back to manual `codegraph sync` or git sync hooks.
        const disabledReason = (0, watch_policy_1.watchDisabledReason)(this.projectRoot);
        if (disabledReason) {
            (0, errors_1.logDebug)('File watcher disabled', { reason: disabledReason, projectRoot: this.projectRoot });
            return false;
        }
        // Reuse the indexer's ignore set so the watcher and indexer agree on scope.
        // chokidar only registers an inotify watch on directories that pass this
        // filter — that's the #276 fix.
        this.ignoreMatcher = (0, extraction_1.buildDefaultIgnore)(this.projectRoot);
        try {
            this.watcher = chokidar_1.default.watch(this.projectRoot, {
                // chokidar calls this for every path it encounters and only watches
                // those that pass — so excluded trees (node_modules/, dist/, .git/, …)
                // never get an inotify watch in the first place.
                ignored: (testPath, stats) => this.shouldIgnore(testPath, stats),
            });
            // Chokidar emits `add` for every pre-existing source file during its
            // initial scan. Those events should still trigger the post-startup
            // reconciling sync (preserving prior behavior), but they must NOT land
            // in pendingFiles — otherwise every file in the project shows up as
            // "edited but not indexed" on startup, which is the opposite of the
            // signal #403 is supposed to provide. Flip the flag on chokidar's
            // `ready` event; from then on, real edits populate pendingFiles.
            //
            // We also clear `pendingFiles` here as defense-in-depth: chokidar can
            // emit late initial-scan `add` events via setImmediate AFTER the
            // `ready` callback runs (observed under test-parallelism load).
            // Clearing once at ready guarantees a clean baseline; real subsequent
            // edits repopulate the set normally.
            this.watcher.on('ready', () => {
                this.chokidarReady = true;
                this.pendingFiles.clear();
                for (const cb of this.readyWaiters)
                    cb();
                this.readyWaiters.length = 0;
            });
            // chokidar emits 'all' for every event type; we only sync source files.
            this.watcher.on('all', (_event, filePath) => {
                if (this.stopped)
                    return;
                const normalized = (0, utils_1.normalizePath)(path.relative(this.projectRoot, filePath));
                // Defense in depth: `ignored` should already keep these out, but events
                // can still arrive during setup or via symlink traversal.
                if (this.isAlwaysIgnored(normalized))
                    return;
                if (!(0, extraction_1.isSourceFile)(normalized))
                    return;
                (0, errors_1.logDebug)('File change detected', { file: normalized });
                // Only track events from after chokidar's initial scan as pending
                // edits — pre-existing files on disk are already represented by
                // (or about to be reconciled by) the index, not a user edit.
                if (this.chokidarReady) {
                    const now = Date.now();
                    const existing = this.pendingFiles.get(normalized);
                    this.pendingFiles.set(normalized, {
                        firstSeenMs: existing?.firstSeenMs ?? now,
                        lastSeenMs: now,
                    });
                }
                this.scheduleSync();
            });
            // Handle watcher errors gracefully — don't crash, the user can restart.
            this.watcher.on('error', (err) => {
                (0, errors_1.logWarn)('File watcher error', { error: String(err) });
            });
            (0, errors_1.logDebug)('File watcher started', { projectRoot: this.projectRoot, debounceMs: this.debounceMs });
            return true;
        }
        catch (err) {
            // Watcher setup failed (e.g., permission denied, missing directory).
            (0, errors_1.logWarn)('Could not start file watcher', { error: String(err) });
            return false;
        }
    }
    /** Our own dirs are always ignored, regardless of .gitignore. */
    isAlwaysIgnored(rel) {
        return (rel === '.codegraph' || rel.startsWith('.codegraph/') ||
            rel === '.git' || rel.startsWith('.git/'));
    }
    /**
     * chokidar `ignored` predicate — true for any path that should NOT be watched.
     * Uses chokidar's provided `stats` to decide directory-vs-file so a dir-only
     * rule like `build/` matches, without an extra `statSync` per path.
     */
    shouldIgnore(testPath, stats) {
        const rel = (0, utils_1.normalizePath)(path.relative(this.projectRoot, testPath));
        if (!rel || rel === '.' || rel.startsWith('..'))
            return false; // root / outside
        if (this.isAlwaysIgnored(rel))
            return true;
        if (!this.ignoreMatcher)
            return false;
        if (stats) {
            return this.ignoreMatcher.ignores(stats.isDirectory() ? rel + '/' : rel);
        }
        // Stats unknown: test both forms so a directory match isn't missed.
        return this.ignoreMatcher.ignores(rel) || this.ignoreMatcher.ignores(rel + '/');
    }
    /**
     * Stop watching for file changes.
     */
    stop() {
        this.stopped = true;
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
        }
        this.pendingFiles.clear();
        this.chokidarReady = false;
        this.ignoreMatcher = null;
        (0, errors_1.logDebug)('File watcher stopped');
    }
    /**
     * Whether the watcher is currently active.
     */
    isActive() {
        return this.watcher !== null && !this.stopped;
    }
    /**
     * Resolves once chokidar has fired its `ready` event (or immediately if
     * it has already done so). Useful for tests that need a deterministic
     * boundary before asserting on `pendingFiles` — guessing a sleep duration
     * is flaky under load because chokidar can take longer than expected to
     * finish its initial crawl on slow filesystems / parallel test runs.
     *
     * Production callers don't need this: `pendingFiles` is read continuously,
     * the staleness banner is always correct (empty or populated), and the
     * initial-scan window is a small one-time startup cost.
     */
    waitUntilReady(timeoutMs = 10000) {
        if (this.chokidarReady)
            return Promise.resolve();
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => {
                const idx = this.readyWaiters.indexOf(handler);
                if (idx >= 0)
                    this.readyWaiters.splice(idx, 1);
                reject(new Error(`FileWatcher.waitUntilReady timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            const handler = () => { clearTimeout(t); resolve(); };
            this.readyWaiters.push(handler);
        });
    }
    /**
     * Schedule a debounced sync.
     */
    scheduleSync() {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            this.flush();
        }, this.debounceMs);
    }
    /**
     * Flush pending changes by running sync.
     *
     * pendingFiles is NOT cleared at the start of sync — entries are removed
     * only after sync commits successfully, and only for entries whose
     * lastSeenMs <= syncStartedMs. That way, a query that arrives mid-sync
     * still sees the affected files marked stale (the DB hasn't been updated
     * yet), and an event that lands mid-sync persists into the follow-up.
     *
     * On sync failure pendingFiles is left untouched — every edit is still
     * unindexed, and the rescheduled sync will absorb the same set next time.
     */
    async flush() {
        // If already syncing, the post-sync check will re-trigger
        if (this.syncing || this.stopped)
            return;
        this.syncStartedMs = Date.now();
        this.syncing = true;
        try {
            const result = await this.syncFn();
            // Remove entries whose most recent event predates this sync — those
            // edits are now in the DB. Entries with lastSeenMs > syncStartedMs
            // arrived mid-sync; whether the in-flight sync captured them depends
            // on when sync read that file, so we keep them as pending and let
            // the follow-up sync handle them. We prefer false positives ("shown
            // stale, actually fresh" → at worst one extra Read) over false
            // negatives ("shown fresh, actually stale" → misleads the agent).
            for (const [filePath, info] of this.pendingFiles) {
                if (info.lastSeenMs <= this.syncStartedMs) {
                    this.pendingFiles.delete(filePath);
                }
            }
            this.onSyncComplete?.(result);
        }
        catch (err) {
            if (err instanceof LockUnavailableError) {
                // Lock-failure no-op (another writer holds the lock). pendingFiles
                // stays intact and the `finally` block reschedules. Debug-only —
                // a long external index would otherwise spam stderr every cycle.
                (0, errors_1.logDebug)('Watch sync skipped: file lock unavailable', {
                    pendingFiles: this.pendingFiles.size,
                });
            }
            else {
                const error = err instanceof Error ? err : new Error(String(err));
                (0, errors_1.logWarn)('Watch sync failed', { error: error.message });
                this.onSyncError?.(error);
            }
            // Failure: leave pendingFiles untouched. Every edit it tracks is
            // still unindexed; the rescheduled sync sees the same set.
        }
        finally {
            this.syncing = false;
            // If pending files remain (mid-sync events, or this sync failed),
            // schedule another pass.
            if (this.pendingFiles.size > 0 && !this.stopped) {
                this.scheduleSync();
            }
        }
    }
    /**
     * Snapshot of files seen by the watcher since the last successful sync.
     *
     * Used by MCP tool responses to mark stale results without blocking on a
     * sync: a tool that returns a hit in `src/foo.ts` while `src/foo.ts` is in
     * this list tells the agent "Read this file directly, the index lags."
     *
     * `indexing` is true when a sync is currently in flight whose start time is
     * AFTER this file's most recent event — i.e. that sync will absorb the
     * edit. False means the file is still inside the debounce window and no
     * sync has started yet (a follow-up call a few hundred ms later may show
     * `indexing: true` or the file may have left the list entirely).
     *
     * Cheap: O(pendingFiles.size), no I/O, no locks.
     */
    getPendingFiles() {
        const result = [];
        for (const [filePath, info] of this.pendingFiles) {
            result.push({
                path: filePath,
                firstSeenMs: info.firstSeenMs,
                lastSeenMs: info.lastSeenMs,
                indexing: this.syncing && this.syncStartedMs >= info.lastSeenMs,
            });
        }
        return result;
    }
}
exports.FileWatcher = FileWatcher;
//# sourceMappingURL=watcher.js.map