/**
 * Cron next-fire matcher for the cronbird scheduler daemon.
 *
 * The daemon reads 5-field cron schedules from jobs, asks this module
 * for the next fire instant, and sleeps until then. The croner dependency is
 * isolated behind {@link CronMatcher} so the engine can be swapped without
 * touching the daemon.
 */
/** Thrown for any expression croner cannot parse, or that is not 5-field. */
export declare class CronExpressionError extends Error {
    constructor(expr: unknown, cause?: unknown);
}
export interface CronMatcher {
    /** The next fire instant strictly after `from`, or null if the cron never fires again. */
    nextFire(expr: string, from: Date): Date | null;
    /** Whether `expr` fires during the minute containing `when` (seconds ignored). */
    matchesAt(expr: string, when: Date): boolean;
}
export interface MatcherOptions {
    /** IANA timezone the schedule is evaluated in (e.g. "America/New_York"). Defaults to host-local. */
    timezone?: string;
}
export declare function createMatcher(opts?: MatcherOptions): CronMatcher;
