"use strict";
/**
 * MCP proxy mode — issue #411.
 *
 * The proxy is a near-transparent stdio↔socket pipe. Once it has verified
 * the daemon's hello line (same major.minor.patch as ours), it does no
 * protocol parsing of its own: every byte the MCP host writes to the proxy's
 * stdin goes straight to the daemon socket, and every byte the daemon emits
 * goes straight to the host's stdout. Server-initiated JSON-RPC requests
 * (e.g. `roots/list`) flow through the same pipe transparently.
 *
 * Lifecycle expectations:
 *   - The proxy exits when *either* stream closes (host stdin closed →
 *     daemon socket end, or daemon-side socket close → host stdout end).
 *   - Closing the socket on the proxy side is what tells the daemon to
 *     decrement its connected-clients refcount.
 *   - On a parent-process death we can't detect via stdin close (e.g. SIGKILL
 *     of the MCP host), the proxy's PPID watchdog catches it — same logic
 *     the direct-mode server uses; see issue #277.
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.runProxy = runProxy;
const fs = __importStar(require("fs"));
const net = __importStar(require("net"));
const wasm_runtime_flags_1 = require("../extraction/wasm-runtime-flags");
const daemon_1 = require("./daemon");
const version_1 = require("./version");
/** Default poll cadence for the PPID watchdog (same as the direct server). */
const DEFAULT_PPID_POLL_MS = 5000;
/**
 * Attempt to connect to the daemon at `socketPath` and pipe stdio through it.
 *
 * Returns a promise that resolves when either:
 *   - the connection succeeded and one of stdin/socket has now closed
 *     (after which the process should exit), or
 *   - the connection failed early enough that the caller can still fall
 *     back to direct mode.
 *
 * The `expectedVersion` param defaults to the package's own version — daemon
 * and proxy MUST match exactly. Mismatch resolves with
 * `outcome: 'fallback-needed'` so the caller can transparently start its own
 * server. (We accept the cost of two concurrent servers in this case as the
 * price of never silently running a stale daemon against newer client code.)
 */
async function runProxy(socketPath, expectedVersion = version_1.CodeGraphPackageVersion) {
    // POSIX: refuse to connect to a stale socket file that points at no
    // listening process. `fs.existsSync` is a cheap pre-check; a real
    // ECONNREFUSED below catches the rare "exists but unbound" race.
    if (process.platform !== 'win32' && !fs.existsSync(socketPath)) {
        return { outcome: 'fallback-needed', reason: 'socket file missing' };
    }
    const socket = net.createConnection(socketPath);
    socket.setEncoding('utf8');
    const hello = await readHelloLine(socket).catch((err) => {
        socket.destroy();
        return new Error(String(err));
    });
    if (hello instanceof Error) {
        return { outcome: 'fallback-needed', reason: hello.message };
    }
    if (hello.codegraph !== expectedVersion) {
        process.stderr.write(`[CodeGraph MCP] Found a daemon on ${socketPath} but version (${hello.codegraph}) ` +
            `differs from ours (${expectedVersion}); falling back to direct mode.\n`);
        socket.destroy();
        return { outcome: 'fallback-needed', reason: 'version mismatch' };
    }
    process.stderr.write(`[CodeGraph MCP] Attached to shared daemon on ${socketPath} (pid ${hello.pid}, v${hello.codegraph}).\n`);
    startPpidWatchdog(socket);
    await pipeUntilClose(socket);
    // Host disconnected (or the daemon went away). The proxy's only job is the
    // pipe; exit now so we don't linger — process.stdin's 'data' listener would
    // otherwise keep the event loop alive and leave a zombie launcher behind.
    process.exit(0);
}
/**
 * Read one CRLF/LF-terminated JSON line from the socket, parse it as the
 * daemon hello, and return it. Bounded to {@link MAX_HELLO_LINE_BYTES} so a
 * malicious or broken peer can't OOM us. Times out at 3s — a healthy daemon
 * sends hello immediately on accept.
 */
function readHelloLine(socket) {
    return new Promise((resolve, reject) => {
        let buffer = '';
        const cleanup = () => {
            socket.removeListener('data', onData);
            socket.removeListener('error', onError);
            socket.removeListener('close', onClose);
            clearTimeout(timer);
        };
        const onData = (chunk) => {
            buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
            const idx = buffer.indexOf('\n');
            if (idx === -1) {
                if (buffer.length > daemon_1.MAX_HELLO_LINE_BYTES) {
                    cleanup();
                    reject(new Error('daemon hello line exceeded size limit'));
                }
                return;
            }
            const line = buffer.slice(0, idx);
            // Re-emit anything past the newline so the pipe-stage sees it.
            const tail = buffer.slice(idx + 1);
            cleanup();
            if (tail.length > 0) {
                // Push back via unshift — Node's net.Socket supports it on readable streams.
                socket.unshift(tail);
            }
            try {
                const parsed = JSON.parse(line);
                if (typeof parsed.codegraph !== 'string' || typeof parsed.pid !== 'number') {
                    reject(new Error('daemon hello missing required fields'));
                    return;
                }
                resolve(parsed);
            }
            catch (err) {
                reject(new Error(`daemon hello not JSON: ${err instanceof Error ? err.message : String(err)}`));
            }
        };
        const onError = (err) => { cleanup(); reject(err); };
        const onClose = () => { cleanup(); reject(new Error('daemon closed connection before hello')); };
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error('timed out waiting for daemon hello'));
        }, 3000);
        timer.unref?.();
        socket.on('data', onData);
        socket.on('error', onError);
        socket.on('close', onClose);
    });
}
/**
 * Pipe stdin → socket and socket → stdout. Resolves once either end closes
 * so the process can exit. Note: we deliberately do NOT use
 * `process.stdin.pipe(socket)` because pipe propagates 'end' onto the
 * downstream, which would close the socket prematurely if stdin happens to
 * end early — the MCP spec allows it to stay open across reconnects.
 */
function pipeUntilClose(socket) {
    return new Promise((resolve) => {
        let resolved = false;
        const done = () => { if (!resolved) {
            resolved = true;
            resolve();
        } };
        process.stdin.on('data', (chunk) => {
            try {
                socket.write(chunk);
            }
            catch { /* socket may have errored — close path catches it */ }
        });
        process.stdin.on('end', () => {
            try {
                socket.end();
            }
            catch { /* ignore */ }
            done();
        });
        process.stdin.on('close', () => {
            try {
                socket.destroy();
            }
            catch { /* ignore */ }
            done();
        });
        socket.on('data', (chunk) => {
            try {
                process.stdout.write(chunk);
            }
            catch { /* ignore */ }
        });
        socket.on('end', () => done());
        socket.on('close', () => done());
        socket.on('error', (err) => {
            process.stderr.write(`[CodeGraph MCP] daemon socket error: ${err.message}\n`);
            done();
        });
    });
}
/**
 * PPID watchdog mirroring the one in `MCPServer.start` — kills the proxy if
 * the MCP host (or its proxy of a host, see HOST_PPID_ENV) goes away without
 * closing stdin. Issue #277 documents why we can't rely on stdin EOF on
 * Linux: the parent may be SIGKILL'd and reparenting doesn't close pipes.
 *
 * The proxy's "kill" is just a socket close + process.exit — no SQLite or
 * watchers to clean up, so this is cheap.
 */
function startPpidWatchdog(socket) {
    const pollMs = parsePollMs(process.env.CODEGRAPH_PPID_POLL_MS);
    if (pollMs <= 0)
        return;
    const originalPpid = process.ppid;
    const hostPpid = parseHostPpid(process.env[wasm_runtime_flags_1.HOST_PPID_ENV]);
    const timer = setInterval(() => {
        const current = process.ppid;
        const ppidChanged = current !== originalPpid;
        const hostGone = hostPpid !== null && !isProcessAliveLocal(hostPpid);
        if (ppidChanged || hostGone) {
            const reason = ppidChanged
                ? `ppid ${originalPpid} -> ${current}`
                : `host pid ${hostPpid} exited`;
            process.stderr.write(`[CodeGraph MCP] Parent process exited (${reason}); shutting down.\n`);
            try {
                socket.destroy();
            }
            catch { /* ignore */ }
            process.exit(0);
        }
    }, pollMs);
    timer.unref?.();
}
function parsePollMs(raw) {
    if (raw === undefined || raw === '')
        return DEFAULT_PPID_POLL_MS;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed))
        return DEFAULT_PPID_POLL_MS;
    if (parsed < 0)
        return DEFAULT_PPID_POLL_MS;
    return Math.floor(parsed);
}
function parseHostPpid(raw) {
    if (raw === undefined || raw === '')
        return null;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 1)
        return null;
    return parsed;
}
function isProcessAliveLocal(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        const e = err;
        if (e.code === 'EPERM')
            return true;
        return false;
    }
}
//# sourceMappingURL=proxy.js.map