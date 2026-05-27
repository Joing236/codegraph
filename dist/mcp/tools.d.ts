/**
 * MCP Tool Definitions
 *
 * Defines the tools exposed by the CodeGraph MCP server.
 */
import CodeGraph from '../index';
import type { PendingFile } from '../sync';
/**
 * Calculate the recommended number of codegraph_explore calls based on project size.
 * Larger codebases need more exploration calls to cover their surface area,
 * but smaller ones should use fewer to avoid unnecessary overhead.
 */
export declare function getExploreBudget(fileCount: number): number;
/**
 * Adaptive output budget for `codegraph_explore`, scaled to project size.
 *
 * Smaller codebases get a tighter total cap, fewer default files, smaller
 * per-file cap, and tighter clustering — so a focused query on a 100-file
 * project doesn't dump a whole file's worth of source into the agent's
 * context. Larger codebases keep the generous defaults because the
 * agent's native discovery cost (grep + find + many Reads) genuinely
 * dwarfs a fat explore call at that scale.
 *
 * Meta-text (relationships map, "additional relevant files" list,
 * completeness signal, budget note) is gated off for tiny projects
 * where one rich call is the whole story and the extra prose is just
 * overhead.
 *
 * Tier breakpoints mirror `getExploreBudget` so a project sits in the
 * same tier across both knobs.
 */
export interface ExploreOutputBudget {
    /** Hard cap on total output characters. */
    maxOutputChars: number;
    /** Default `maxFiles` when the caller didn't specify one. */
    defaultMaxFiles: number;
    /** Cap on contiguous source returned per file (across all its clusters). */
    maxCharsPerFile: number;
    /** Cluster gap threshold in lines — tighter clustering on small projects. */
    gapThreshold: number;
    /** Max symbols listed in the per-file header (`#### path — sym(kind), ...`). */
    maxSymbolsInFileHeader: number;
    /** Max edges shown per relationship kind in the Relationships section. */
    maxEdgesPerRelationshipKind: number;
    /** Include the "Relationships" section. */
    includeRelationships: boolean;
    /** Include the "Additional relevant files (not shown)" trailing list. */
    includeAdditionalFiles: boolean;
    /** Include the "Complete source code is included above…" reminder. */
    includeCompletenessSignal: boolean;
    /** Include the explore-budget reminder at the end. */
    includeBudgetNote: boolean;
}
export declare function getExploreOutputBudget(fileCount: number): ExploreOutputBudget;
/**
 * Per-file staleness banner emitted at the top of a tool response when the
 * file watcher has pending events for files referenced by the response.
 * The agent uses this to fall back to Read for those specific files
 * without waiting for the debounced sync (issue #403).
 */
export declare function formatStaleBanner(stale: PendingFile[]): string;
/**
 * Compact footer listing pending files that are NOT referenced in this
 * response. Gives the agent a complete project-wide freshness picture
 * without bloating the main banner.
 */
export declare function formatStaleFooter(stale: PendingFile[]): string;
/**
 * MCP Tool definition
 */
export interface ToolDefinition {
    name: string;
    description: string;
    inputSchema: {
        type: 'object';
        properties: Record<string, PropertySchema>;
        required?: string[];
    };
}
interface PropertySchema {
    type: string;
    description: string;
    enum?: string[];
    default?: unknown;
}
/**
 * Tool execution result
 */
export interface ToolResult {
    content: Array<{
        type: 'text';
        text: string;
    }>;
    isError?: boolean;
}
/**
 * All CodeGraph MCP tools
 *
 * Designed for minimal context usage - use codegraph_context as the primary tool,
 * and only use other tools for targeted follow-up queries.
 *
 * All tools support cross-project queries via the optional `projectPath` parameter.
 */
export declare const tools: ToolDefinition[];
/**
 * Tool handler that executes tools against a CodeGraph instance
 *
 * Supports cross-project queries via the projectPath parameter.
 * Other projects are opened on-demand and cached for performance.
 */
export declare class ToolHandler {
    private cg;
    private projectCache;
    private defaultProjectHint;
    private worktreeMismatchCache;
    constructor(cg: CodeGraph | null);
    /**
     * Update the default CodeGraph instance (e.g. after lazy initialization)
     */
    setDefaultCodeGraph(cg: CodeGraph): void;
    /**
     * Record the directory the server tried to resolve the default project from.
     * Used only to make the "no default project" error actionable.
     */
    setDefaultProjectHint(searchedPath: string): void;
    /**
     * Whether a default CodeGraph instance is available
     */
    hasDefaultCodeGraph(): boolean;
    /**
     * Optional allowlist of exposed tools, parsed from the CODEGRAPH_MCP_TOOLS
     * env var (comma-separated short names, e.g. "trace,search,node,context").
     * Unset/empty → every tool is exposed. Lets an operator (or an A/B harness)
     * trim the tool surface without rebuilding the client config; the ablated
     * tool is then truly absent from ListTools rather than merely denied on call.
     * Matching is on the short form, so "trace" and "codegraph_trace" both work.
     */
    private toolAllowlist;
    /** Whether a tool name passes the CODEGRAPH_MCP_TOOLS allowlist (if any). */
    private isToolAllowed;
    /**
     * Get tool definitions with dynamic descriptions based on project size.
     * The codegraph_explore tool description includes a budget recommendation
     * scaled to the number of indexed files. Honors the CODEGRAPH_MCP_TOOLS
     * allowlist so a trimmed surface is reflected in ListTools.
     */
    getTools(): ToolDefinition[];
    /**
     * Get CodeGraph instance for a project
     *
     * If projectPath is provided, opens that project's CodeGraph (cached).
     * Otherwise returns the default CodeGraph instance.
     *
     * Walks up parent directories to find the nearest .codegraph/ folder,
     * similar to how git finds .git/ directories.
     */
    private getCodeGraph;
    /**
     * Close all cached project connections
     */
    closeAll(): void;
    /**
     * Validate that a value is a non-empty string within length bounds.
     *
     * The `maxLength` cap protects against MCP clients that ship huge
     * payloads (10MB+ query strings either by accident or maliciously).
     * Without this, a single oversized input can pin the FTS5 index or
     * exhaust memory before any real work runs.
     */
    private validateString;
    /**
     * Validate an optional path-like string input. Returns the value if
     * valid (or undefined), or a ToolResult with the error.
     */
    private validateOptionalPath;
    /**
     * Cached git worktree/index mismatch for a tool call's effective project.
     *
     * The "effective project" is what the request targets: an explicit
     * `projectPath` arg, else the directory the server resolved its default
     * project from (`defaultProjectHint`), else cwd. Memoized per start path —
     * see `worktreeMismatchCache`. Best-effort: if the project can't be resolved
     * (e.g. nothing initialized yet), it reports "no mismatch" so a tool is never
     * broken by this check.
     */
    private worktreeMismatchFor;
    /**
     * Prefix a successful read-tool result with a compact worktree-mismatch
     * notice when the resolved index belongs to a different git working tree than
     * the caller's (issue #155). Without this, an agent in a nested worktree
     * silently trusts main-branch results. No-op on error results and when there
     * is no mismatch. `codegraph_status` is excluded — it embeds its own verbose
     * warning — so it stays out of this path.
     */
    private withWorktreeNotice;
    /**
     * Annotate a successful read-tool result with per-file staleness — the
     * non-blocking answer to issue #403. The file watcher tracks every event
     * it sees per path; here we intersect "files referenced in this response"
     * against that pending set and prepend a compact banner so the agent can
     * fall back to Read for those *specific* files without waiting for the
     * debounced sync to fire. Other pending files in the project (not
     * referenced by this response) get a small footer so the agent has a
     * complete picture without bloating the banner.
     *
     * Cost when nothing is pending — the common case — is one boolean check.
     * No I/O, no parsing of markdown beyond a per-pending-file substring scan.
     */
    private withStalenessNotice;
    /**
     * Execute a tool by name
     */
    execute(toolName: string, args: Record<string, unknown>): Promise<ToolResult>;
    /**
     * Handle codegraph_search
     */
    private handleSearch;
    /**
     * Handle codegraph_context
     */
    private handleContext;
    /**
     * Heuristic to detect if a query looks like a feature request
     */
    private looksLikeFeatureRequest;
    /**
     * Handle codegraph_callers
     */
    private handleCallers;
    /**
     * Handle codegraph_callees
     */
    private handleCallees;
    /**
     * Handle codegraph_impact
     */
    private handleImpact;
    /**
     * Handle codegraph_trace — shortest CALL PATH between two symbols.
     *
     * Exposes GraphTraverser.findPath: the chain of functions from `from` to `to`,
     * each hop annotated with file:line and the call-site line. This is the
     * capability grep/Read structurally cannot provide. When no static path
     * exists, the chain has almost certainly broken at dynamic dispatch
     * (callbacks, descriptors, metaclasses) — we say so and surface the start
     * symbol's outgoing calls so the agent bridges the one missing hop with
     * codegraph_node rather than blindly reading.
     */
    private handleTrace;
    /**
     * Describe a synthesized (dynamic-dispatch) edge for human output: how the
     * callback was wired up — the bridge static parsing can't see. Returns null
     * for ordinary static edges. Used by trace + the node trail so a synthesized
     * hop reads as "registered via onUpdate at App.tsx:3148", not a bare arrow.
     */
    private synthEdgeNote;
    /**
     * Read one trimmed source line at "relpath:line" (relative to the project
     * root). `cache` holds split file contents so a multi-hop trace reads each
     * file at most once. Returns null if the file/line can't be resolved.
     */
    private sourceLineAt;
    /**
     * Read a hop's body — filePath lines [startLine..endLine] — for inlining into
     * a trace, capped (lines + chars) so the whole path stays path-scoped even on
     * a 7-hop chain. Dedents to the body's own indentation and marks truncation.
     * Shares `cache` with sourceLineAt so each file is read at most once per trace.
     */
    private sourceRangeAt;
    /**
     * Flow-from-named-symbols: an agent's codegraph_explore query is a bag of
     * symbol names that usually spans the flow it's investigating (e.g.
     * "PmsProductController getList PmsProductService list PmsProductServiceImpl").
     * Surface the longest call chain AMONG those named symbols — scoped to what the
     * agent explicitly named, so (unlike a fuzzy relevance set) there's no
     * wrong-feature wandering. Rides synthesized edges, so controller→service-
     * interface→impl shows up. Returns '' if no chain of >=3 nodes exists.
     *
     * Ambiguous tokens (Java `list` → dozens of nodes) are disambiguated by
     * CO-NAMING: the agent names the class too, so we keep only `list` candidates
     * whose qualifiedName contains another named token (`PmsProductServiceImpl::list`),
     * dropping unrelated `OmsOrderService::list`.
     */
    private buildFlowFromNamedSymbols;
    /**
     * Handle codegraph_explore — deep exploration in a single call
     *
     * Strategy: find relevant symbols via graph traversal, group by file,
     * then read contiguous file sections covering all symbols per file.
     * This replaces multiple codegraph_node + Read calls.
     *
     * Output size is adaptive to project file count via
     * `getExploreOutputBudget` — see #185 for why a fixed 35k cap was a
     * tax on small projects while earning its keep on large ones.
     */
    private handleExplore;
    /**
     * Handle codegraph_node
     */
    private handleNode;
    /**
     * Build the "trail" for a symbol: its direct callees (what it calls) and
     * callers (what calls it), each with file:line — so codegraph_node doubles as
     * the structural Grep→Read→expand primitive: a spot PLUS where to go next.
     * Capped to stay cheap. Walk the graph by calling codegraph_node on a trail
     * entry; no Read needed for covered hops. Empty edges on a non-leaf often mean
     * dynamic dispatch the static graph couldn't resolve — that absence is itself
     * a signal (read that one hop) rather than a dead end.
     */
    private formatTrail;
    /**
     * Handle codegraph_status
     */
    private handleStatus;
    /**
     * Handle codegraph_files - get project file structure from the index
     */
    private handleFiles;
    /**
     * Convert glob pattern to regex
     */
    private globToRegex;
    /**
     * Format files as a flat list
     */
    private formatFilesFlat;
    /**
     * Format files grouped by language
     */
    private formatFilesGrouped;
    /**
     * Format files as a tree structure
     */
    private formatFilesTree;
    /**
     * Find a symbol by name, handling disambiguation when multiple matches exist.
     * Returns the best match and a note about alternatives if any.
     */
    /**
     * Check if a node matches a symbol query.
     *
     * Accepts simple names (`run`) and three flavors of qualifier:
     *   - dotted     `Session.request`         (TS/JS/Python)
     *   - colon-pair `stage_apply::run`        (Rust, C++, Ruby)
     *   - slash      `configurator/stage_apply` (path-ish)
     *
     * Multi-level qualifiers compose: `crate::configurator::stage_apply::run`
     * works. Rust path prefixes (`crate`, `super`, `self`) are stripped so
     * the canonical `crate::module::symbol` form resolves.
     *
     * Resolution order, last part must always equal `node.name`:
     *   1. Suffix-match against `qualifiedName` (handles class-scoped methods
     *      where the extractor builds the qualified name from the AST stack)
     *   2. File-path containment (handles file-derived modules in Rust/
     *      Python — `stage_apply::run` matches a `run` in `stage_apply.rs`)
     */
    private matchesSymbol;
    private findSymbol;
    /**
     * Find ALL symbols matching a name. Used by callers/callees/impact to aggregate
     * results across all matching symbols (e.g., multiple classes with an `execute` method).
     */
    private findAllSymbols;
    /**
     * Truncate output if it exceeds the maximum length
     */
    private truncateOutput;
    private formatSearchResults;
    private formatNodeList;
    private formatImpact;
    /**
     * Build a compact structural outline of a container symbol from its
     * indexed children (methods, fields, properties, …) — name, kind,
     * line number, and signature — so the agent gets the shape of a class
     * without the full source of every method. Returns '' when the container
     * has no indexed children, so the caller can fall back to full source.
     */
    private buildContainerOutline;
    private formatNodeDetails;
    private formatTaskContext;
    private textResult;
    private errorResult;
}
export {};
//# sourceMappingURL=tools.d.ts.map