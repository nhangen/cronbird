import type { CompletionRecord, Job } from "./types";
/**
 * Dependency-chain helpers. All pure functions of the daemon's persisted state
 * so a crash mid-cascade re-derives the same decision on the next tick.
 */
/** A dependent is eligible iff every upstream succeeded strictly after it last ran. */
export declare function isEligible(name: string, upstreams: string[], lastSuccess: Record<string, number>, lastRun: Record<string, number>): boolean;
/** Failed = retry budget exhausted AND the last observed completion was non-zero. */
export declare function failedJobs(names: string[], attempts: Record<string, number>, done: Record<string, CompletionRecord>, maxAttempts: number): Set<string>;
/**
 * Topological validation at registry load. Returns the jobs that must be failed
 * rather than run: any job in a dependency cycle, and any job with an edge to a
 * name not in the registry. Failing the whole job (not silently dropping the
 * offending edge) is deliberate — a dropped edge would let a dependent run
 * before an upstream that can never satisfy it.
 */
export declare function validateDependencies<T>(jobs: Job<T>[], upstreamsOf: (n: string) => string[]): {
    invalid: Set<string>;
    warnings: string[];
};
/** DFS: does any (transitive) upstream of `name` sit in `failed`? */
export declare function transitiveUpstreamFailed(name: string, upstreamsOf: (n: string) => string[], failed: Set<string>): boolean;
