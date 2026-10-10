import { type CronMatcher, type JobMatcherResolver } from "./cron";
import type { Heartbeat, Job } from "./types";
export interface SimulateOptions<T = unknown> {
    from: Date;
    to: Date;
    host: string;
    jobs: Job<T>[];
    enabled: Set<string>;
    owners: Record<string, string>;
    /** Resolver for per-job matchers; takes precedence over `matcher` when provided. */
    matcherResolver?: JobMatcherResolver;
    /** Default matcher for jobs without a timezone. Shortcut for passing a resolver via `matcherResolver`. */
    matcher?: CronMatcher;
    initialHeartbeat?: Heartbeat | null;
    initialLastFired?: Record<string, number>;
    resolveLookback?: (job: Job<T>, now: Date) => number;
    priority?: (job: Job<T>) => number;
    dependencies?: (job: Job<T>) => string[];
}
export interface SimulatedDispatch {
    job: string;
    time: number;
    timeIso: string;
    slotTs: number;
    type: "due" | "catchup";
}
export interface SimulationReport {
    host: string;
    from: number;
    fromIso: string;
    to: number;
    toIso: string;
    dispatches: SimulatedDispatch[];
    /** Active jobs this host doesn't run (owned elsewhere, not enabled here). Expected on multi-host setups. */
    skipped: string[];
    warnings: string[];
}
export declare function simulateSchedule<T = unknown>(options: SimulateOptions<T>): SimulationReport;
