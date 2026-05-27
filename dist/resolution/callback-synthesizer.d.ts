import type { QueryBuilder } from '../db/queries';
import type { ResolutionContext } from './types';
/**
 * Synthesize dispatcher→callback edges (field observers + EventEmitters +
 * React re-render + JSX children + Vue templates + RN event channel +
 * Fabric native-impl + MyBatis Java↔XML). Returns the count added. Never
 * throws into indexing — callers wrap in try/catch.
 */
export declare function synthesizeCallbackEdges(queries: QueryBuilder, ctx: ResolutionContext): number;
//# sourceMappingURL=callback-synthesizer.d.ts.map