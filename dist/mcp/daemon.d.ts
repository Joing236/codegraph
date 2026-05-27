/**
 * Shared MCP daemon — issue #411.
 *
 * One detached `codegraph serve --mcp` daemon process per project root,
 * accepting N concurrent MCP clients over a Unix-domain socket (or named pipe
 * on Windows). Each incoming connection gets its own {@link MCPSession}; all
 * sessions share a single {@link MCPEngine}, which means a single file watcher
 * (one inotify set), a single SQLite connection (one WAL writer), and a single
 * tree-sitter warm-up — paid once, amortized across every agent talking to the
 * project.
 *
 * Lifecycle (see also `./index.ts` and `./proxy.ts`):
 *   - The daemon is spawned **detached** (its own session/process group, stdio
 *     decoupled) by the first launcher that finds no daemon running. It is NOT
 *     a child of any MCP host, so closing one terminal / Ctrl-C'ing one session
 *     can't take it down and sever the others. That's why this process has no
 *     PPID watchdog: it deliberately outlives every individual client.
 *   - Every MCP host talks to the daemon through a thin `proxy` process (the
 *     thing the host actually spawned). The proxy keeps the #277 PPID watchdog,
 *     so a SIGKILL'd host still reaps its proxy promptly; the proxy's socket
 *     close then decrements the daemon's refcount.
 *   - When the last client disconnects the daemon lingers for
 *     `CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS` (default 300s) so back-to-back agent
 *     runs in the same project don't repay startup, then exits cleanly. This is
 *     what keeps a single-agent session from leaking a daemon forever (#277).
 *
 * What this file owns:
 *   - Listening on the daemon socket and spawning per-connection sessions.
 *   - The handshake "hello" line that lets a proxy verify it found a
 *     same-version daemon before piping any JSON-RPC through it.
 *   - The lockfile (`.codegraph/daemon.pid`) competing daemons arbitrate
 *     against — atomic `O_EXCL` create with the full record written in the same
 *     breath (no empty-file window) + cleanup on exit.
 *   - Reference counting + idle timeout.
 *   - Graceful shutdown on SIGTERM/SIGINT and idle exit.
 *
 * What this file does NOT own:
 *   - The proxy side (`./proxy.ts`).
 *   - The decision of *whether* to run as daemon at all — that's `MCPServer`.
 *   - The MCP protocol state machine — that's `./session.ts`.
 */
import { DaemonLockInfo } from './daemon-paths';
/** Bytes/parse-window for an oversized hello line — bounded against a malicious peer. */
declare const MAX_HELLO_LINE_BYTES = 4096;
/**
 * Wire format for the one-shot hello line the daemon emits on every new
 * connection. Versioned with the package's own semver so a 0.9.x proxy never
 * pipes through a 0.10.x daemon (or vice-versa) — the proxy falls back to
 * direct mode on mismatch rather than risk subtle wire incompatibilities.
 */
export interface DaemonHello {
    codegraph: string;
    pid: number;
    socketPath: string;
    protocol: 1;
}
export interface DaemonStartResult {
    /** Always-non-null for a successfully-started daemon. */
    socketPath: string;
    /** Lockfile contents as written. */
    lock: DaemonLockInfo;
}
/**
 * Run as the shared daemon for `projectRoot`. Resolves once the socket is
 * listening. The Daemon owns the socket, the engine, and the lockfile until
 * `stop()` is called or it exits on idle/signal.
 *
 * Race-safe: callers must first call `tryAcquireDaemonLock(projectRoot)` and
 * only construct a Daemon if they got the lock (`kind: 'acquired'`). The atomic
 * `O_EXCL` create inside the acquire helper — which now also writes the full
 * record before returning — is the only synchronization between competing
 * daemons.
 */
export declare class Daemon {
    private projectRoot;
    private server;
    private clients;
    private idleTimer;
    private idleTimeoutMs;
    private engine;
    private stopping;
    private socketPath;
    private pidPath;
    constructor(projectRoot: string, opts?: {
        idleTimeoutMs?: number;
    });
    /**
     * Bind the socket, kick off engine init, and register signal handlers. The
     * lockfile body was already written atomically by `tryAcquireDaemonLock`, so
     * there is nothing to write here. The promise resolves once the server is
     * listening — the daemon then sticks around until idle/shutdown.
     */
    start(): Promise<DaemonStartResult>;
    /** Currently-connected client count. Exposed for tests / status output. */
    getClientCount(): number;
    /** The socket path the daemon is (or will be) listening on. */
    getSocketPath(): string;
    /** Graceful shutdown: close all sessions, the engine, and clean up the lock. */
    stop(reason?: string): Promise<void>;
    private handleConnection;
    private dropClient;
    private armIdleTimer;
    private disarmIdleTimer;
    private cleanupLockfile;
}
/**
 * Result of `tryAcquireDaemonLock`. Either we got the lockfile (caller becomes
 * the daemon), or it already existed (caller should connect to the existing
 * daemon as a proxy, or — if the holder is dead — clear it and retry).
 */
export type AcquireResult = {
    kind: 'acquired';
    pidPath: string;
    info: DaemonLockInfo;
} | {
    kind: 'taken';
    existing: DaemonLockInfo | null;
    pidPath: string;
};
/**
 * Atomically create the daemon pidfile with its full record already in place.
 * Returns either an `acquired` result (the caller is the daemon-elect and may
 * construct a {@link Daemon}) or a `taken` result.
 *
 * must-fix 1 (issue #411 review): the lockfile must appear in ONE atomic step,
 * already complete — never empty, even momentarily. The first attempt at this
 * (`O_EXCL` create then a separate `writeSync`) left a microsecond window where
 * the file existed but was empty; under concurrent daemon startup a third
 * candidate could read that empty file, decode it as `null`, and `unlink` the
 * winner's lock → two daemons (two watchers, two writers). The window was
 * normally too small to hit, but the chokidar watcher's extra startup time made
 * concurrent daemons overlap enough to reproduce it reliably.
 *
 * The fix writes the complete record to a private temp file, then hard-links it
 * into place: `link()` is atomic AND exclusive (EEXIST if the target exists), so
 * the pidfile becomes visible in one step already containing a full record.
 * Whoever links first wins; everyone else gets EEXIST and reads a complete file.
 * There is no empty-file window at all.
 */
export declare function tryAcquireDaemonLock(projectRoot: string): AcquireResult;
/**
 * Remove a stale pidfile, but only if it still names a dead process. Re-reads
 * the file immediately before unlinking so we never delete a lock that a live
 * daemon (re)acquired in the meantime.
 *
 * must-fix 1 (issue #411 review): the original unconditionally `unlink`'d,
 * which let a racing candidate delete a healthy daemon's lock. Passing
 * `expectedDeadPid` (the pid the caller believed was dead) makes the clear a
 * compare-and-delete: bail if the file now holds a different pid, or any live
 * pid. Returns true when the stale lock is gone (or was already gone).
 */
export declare function clearStaleDaemonLock(pidPath: string, expectedDeadPid?: number): boolean;
/**
 * Probe whether `pid` is currently alive (signal-0). Treats EPERM as alive on
 * every platform (the process exists, it's just not ours to signal) so we never
 * mistake a live daemon for a dead one and clear its lock.
 */
export declare function isProcessAlive(pid: number): boolean;
/** Exported for test stubs that need to bound the hello-line read. */
export { MAX_HELLO_LINE_BYTES };
//# sourceMappingURL=daemon.d.ts.map