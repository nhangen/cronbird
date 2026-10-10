import type { Job } from "./types";
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
/** Thrown when a schedule's timezone (per-job or matcher-level) is not a valid
 *  IANA identifier. Distinct from {@link CronExpressionError}: the cron
 *  expression itself may be perfectly valid — the fault is the zone, and the
 *  caller (e.g. the registry loader) should report it as such. */
export declare class InvalidTimezoneError extends Error {
    constructor(timezone: string, cause?: unknown);
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
/**
 * Validate an IANA timezone identifier without side effects.
 *
 * croner lazily resolves the zone inside {@link Cron.nextRun}, so an unknown
 * zone only throws at query time — far from the registry parse where the
 * operator can actually act on it. This check runs the same resolution croner
 * uses, at parse time: a bad zone is a load-time skip, not a runtime failure.
 */
export declare function assertValidTimezone(timezone: string): void;
export declare function createMatcher(opts?: MatcherOptions): CronMatcher;
/**
 * Return the correct {@link CronMatcher} for a job, honouring its
 * `timezone` field. Jobs without a `timezone` fall through to
 * `defaultMatcher` (typically a host-local `createMatcher()`).
 *
 * Matchers are cached per timezone string so repeated calls for jobs that
 * share a zone do not re-validate or re-allocate.
 */
export declare function matcherForJob(job: Job, defaultMatcher: CronMatcher): CronMatcher;
