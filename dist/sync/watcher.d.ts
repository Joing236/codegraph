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
/**
 * Options for the file watcher
 */
export interface WatchOptions {
    /**
     * Debounce delay in milliseconds.
     * After the last file change, wait this long before triggering sync.
     * Default: 2000ms
     */
    debounceMs?: number;
    /**
     * Callback when a sync completes (for logging/diagnostics).
     */
    onSyncComplete?: (result: {
        filesChanged: number;
        durationMs: number;
    }) => void;
    /**
     * Callback when a sync errors (for logging/diagnostics).
     */
    onSyncError?: (error: Error) => void;
}
/**
 * Thrown by a `syncFn` to signal that the underlying sync couldn't acquire
 * the cross-process write lock (#449). The watcher treats this as "no
 * progress" — preserves `pendingFiles`, skips `onSyncComplete`, and the
 * `finally` block reschedules. Quiet (debug-only) because a long-running
 * external indexer can hit this every debounce cycle.
 */
export declare class LockUnavailableError extends Error {
    constructor(message?: string);
}
/**
 * Per-file pending entry — tracks a source file the watcher saw an event for
 * but hasn't yet synced into the index. Exposed via {@link FileWatcher.getPendingFiles}
 * so MCP tool responses can mark stale results without forcing a wait.
 */
export interface PendingFile {
    /** Project-relative POSIX path (e.g. "src/foo.ts"). */
    path: string;
    /** Wall-clock ms at the first event we saw for this path since the last sync. */
    firstSeenMs: number;
    /** Wall-clock ms at the most recent event we saw for this path. */
    lastSeenMs: number;
    /**
     * True when a sync is currently in flight that began AFTER this file's most
     * recent event — i.e. the next successful sync will pick it up. False when
     * the file is still in the debounce window (no sync running yet).
     */
    indexing: boolean;
}
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
export declare class FileWatcher {
    private watcher;
    private debounceTimer;
    /**
     * Files seen by the watcher since the last successful sync — populated on
     * every chokidar event, cleared at the start of a sync, and re-populated by
     * events that arrive mid-sync (or restored on sync failure). Keyed by the
     * same project-relative POSIX path the rest of the codebase uses, so a
     * caller can intersect tool-response file paths against this map cheaply.
     */
    private pendingFiles;
    /**
     * Wall-clock ms at which the in-flight sync began. Combined with
     * {@link pendingFiles}'s `lastSeenMs`, this distinguishes "still in the
     * debounce window" (lastSeen > syncStarted, sync hasn't started yet for
     * this edit) from "currently being indexed" (lastSeen <= syncStarted).
     */
    private syncStartedMs;
    private syncing;
    private stopped;
    /**
     * False until chokidar fires its `ready` event. Gates `pendingFiles`
     * insertion so the initial crawl's `add` events (one per pre-existing
     * source file) don't pollute the per-file staleness signal. The events
     * still flow into `scheduleSync()` to preserve the previous "initial
     * scan triggers a reconciling sync" behavior.
     */
    private chokidarReady;
    /**
     * Callbacks that resolve when chokidar fires `ready`. Used by tests (and
     * any production caller that cares about a clean baseline) to deterministically
     * gate on the end of the initial scan instead of guessing at a sleep duration.
     */
    private readyWaiters;
    private ignoreMatcher;
    private readonly projectRoot;
    private readonly debounceMs;
    private readonly syncFn;
    private readonly onSyncComplete?;
    private readonly onSyncError?;
    constructor(projectRoot: string, syncFn: () => Promise<{
        filesChanged: number;
        durationMs: number;
    }>, options?: WatchOptions);
    /**
     * Start watching for file changes.
     * Returns true if watching started successfully, false otherwise.
     */
    start(): boolean;
    /** Our own dirs are always ignored, regardless of .gitignore. */
    private isAlwaysIgnored;
    /**
     * chokidar `ignored` predicate — true for any path that should NOT be watched.
     * Uses chokidar's provided `stats` to decide directory-vs-file so a dir-only
     * rule like `build/` matches, without an extra `statSync` per path.
     */
    private shouldIgnore;
    /**
     * Stop watching for file changes.
     */
    stop(): void;
    /**
     * Whether the watcher is currently active.
     */
    isActive(): boolean;
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
    waitUntilReady(timeoutMs?: number): Promise<void>;
    /**
     * Schedule a debounced sync.
     */
    private scheduleSync;
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
    private flush;
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
    getPendingFiles(): PendingFile[];
}
//# sourceMappingURL=watcher.d.ts.map