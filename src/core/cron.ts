import { Cron } from "croner";
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
export class CronExpressionError extends Error {
  constructor(expr: unknown, cause?: unknown) {
    const detail = cause instanceof Error ? ` (${cause.message})` : "";
    super(`invalid cron expression: ${JSON.stringify(expr)}${detail}`);
    this.name = "CronExpressionError";
  }
}

/** Thrown when a schedule's timezone (per-job or matcher-level) is not a valid
 *  IANA identifier. Distinct from {@link CronExpressionError}: the cron
 *  expression itself may be perfectly valid — the fault is the zone, and the
 *  caller (e.g. the registry loader) should report it as such. */
export class InvalidTimezoneError extends Error {
  constructor(timezone: string, cause?: unknown) {
    const detail = cause instanceof Error ? ` (${cause.message})` : "";
    super(`invalid timezone: ${JSON.stringify(timezone)}${detail} (expected an IANA identifier like "America/New_York")`);
    this.name = "InvalidTimezoneError";
  }
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

const MINUTE_MS = 60_000;
// Longest current DST overlap is two hours (Antarctica/Troll); the cap leaves slack.
const MAX_OVERLAP_PROBES = 3 * 60;

class CronerMatcher implements CronMatcher {
  constructor(private readonly opts: MatcherOptions = {}) {}

  private build(expr: string): Cron {
    // Enforce the 5-field contract before croner sees it: croner
    // also accepts a 6-field seconds form, which would break the minute
    // granularity the daemon and matchesAt() assume.
    const fields = expr.trim().split(/\s+/);
    if (expr.trim() === "" || fields.length !== 5) {
      throw new CronExpressionError(expr);
    }
    try {
      // legacyMode:true gives Vixie semantics — when BOTH day-of-month and
      // day-of-week are restricted, the cron fires if EITHER matches (the
      // behavior native cron and the registry's schedules assume).
      return new Cron(expr, { timezone: this.opts.timezone, legacyMode: true });
    } catch (cause) {
      throw new CronExpressionError(expr, cause);
    }
  }

  nextFire(expr: string, from: Date): Date | null {
    const cron = this.build(expr);
    // Inside a DST fall-back hour croner 9.1 can return an instant before `from`.
    // Step past the overlap until it returns a real successor.
    for (let probe = from.getTime(), i = 0; i < MAX_OVERLAP_PROBES; probe += MINUTE_MS, i++) {
      const next = cron.nextRun(new Date(probe));
      if (next === null || next.getTime() > from.getTime()) return next;
    }
    throw new Error(`cron ${JSON.stringify(expr)}: no fire after ${from.toISOString()} within ${MAX_OVERLAP_PROBES} minutes of probing`);
  }

  matchesAt(expr: string, when: Date): boolean {
    const cron = this.build(expr);
    const minute = Math.floor(when.getTime() / MINUTE_MS) * MINUTE_MS;
    // nextRun is strictly-after, so probe from 1ms before the minute boundary:
    // a fire at `minute` is then returned exactly.
    const next = cron.nextRun(new Date(minute - 1));
    return next !== null && next.getTime() === minute;
  }
}

/**
 * Validate an IANA timezone identifier without side effects.
 *
 * croner lazily resolves the zone inside {@link Cron.nextRun}, so an unknown
 * zone only throws at query time — far from the registry parse where the
 * operator can actually act on it. This check runs the same resolution croner
 * uses, at parse time: a bad zone is a load-time skip, not a runtime failure.
 */
export function assertValidTimezone(timezone: string): void {
  let cron: Cron;
  try {
    cron = new Cron("* * * * *", { timezone, legacyMode: true });
  } catch (cause) {
    throw new InvalidTimezoneError(timezone, cause);
  }
  // Force croner's lazy zone resolution now: a zone that exists in Intl but
  // fails at run time (e.g. an exotic abbreviation) must not survive parsing.
  try {
    cron.nextRun(new Date(0));
  } catch (cause) {
    throw new InvalidTimezoneError(timezone, cause);
  }
}

export function createMatcher(opts: MatcherOptions = {}): CronMatcher {
  if (opts.timezone !== undefined) assertValidTimezone(opts.timezone);
  return new CronerMatcher(opts);
}

/**
 * JobMatcherResolver wraps a private per-call cache Map.
 * Each caller creates a fresh resolver with its own isolated state.
 */
export interface JobMatcherResolver {
  /**
   * Resolve a matcher for the given job. Creates one on first use for each timezone.
   * The resolver maintains its own cache of timezones → matchers, preventing
   * state leakage across test boundaries and simulate runs.
   */
  resolve(job: Job): CronMatcher;
}

/**
 * Factory function that creates a matcher resolver with its own isolated cache.
 * Each call to this function produces a fresh resolver instance with a private Map.
 */
export function createJobMatcherResolver(): JobMatcherResolver {
  const byTimezone = new Map<string, CronMatcher>();

  return {
    resolve: (job: Job) => {
      if (!job.timezone) return defaultFallback(); // fallback for jobs without timezone
      let cached = byTimezone.get(job.timezone);
      if (cached) return cached;
      const m = createMatcher({ timezone: job.timezone });
      byTimezone.set(job.timezone, m);
      return m;
    },
  };
}

/**
 * Default resolver that caches without per-job scoping. For use where a single
 * host-wide cache is acceptable (e.g., the host-local default matcher).
 */
const hostCache = new Map<string, CronMatcher>();

/**
 * Create a host-wide resolver that uses the provided defaultMatcher for jobs without timezone.
 * When creating matchers, uses createMatcher() for non-timezone jobs or
 * createMatcher({timezone: job.timezone}) for timezone-aware jobs.
 */
export function createHostMatcherResolver(options?: { matcher?: CronMatcher }): JobMatcherResolver {
  // Jobs with explicit timezone must use fresh matchers - no fallback allowed
  // This prevents timezone-aware jobs from being incorrectly matched with UTC/other fallbacks.

  return {
    resolve: (job: Job) => {
      if (!job.timezone) {
        // No timezone on job → use fallback matcher if provided, otherwise fresh UTC
        // Using fresh UTC for non-timezone jobs provides per-resolver isolation.
        const m = options?.matcher ?? createMatcher({ timezone: "UTC" });
        return m;
      }

      // Timezone is specified - always create a fresh timezone-aware matcher
      // Don't use fallback matcher (options.matcher) even if provided - it may have wrong timezone
      // Fresh instances avoid state leakage across tests and prevent DST mismatch issues
      const m = createMatcher({ timezone: job.timezone });
      hostCache.set(job.timezone, m);
      return m;
    },
  };
}

/** Default matcher fallback for jobs without explicit timezone (returns fresh UTC matcher). */
const defaultFallback = (): CronMatcher => createMatcher();

/**
 * Compatibility function for existing code that passes a default matcher directly.
 * Creates and wires a fresh resolver internally to avoid module-level state leakage.
 */
export function matcherForJobFromDefault(defaultMatcher: CronMatcher): JobMatcherResolver {
  return createHostMatcherResolver({ matcher: defaultMatcher });
}

/**
 * Return the correct {@link CronMatcher} for a job, honouring its
 * `timezone` field. Jobs without a `timezone` fall through to
 * `defaultMatcher` (typically a host-local `createMatcher()`).
 *
 * This is now deprecated — use {@link matcherForJobFromDefault} to get a fresh
 * resolver per caller, or inject a resolver directly into entry points.
 *
 * Matchers are cached per timezone string so repeated calls for jobs that
 * share a zone do not re-validate or re-allocate.
 */
export function matcherForJob(job: Job, defaultMatcher: CronMatcher): CronMatcher {
  if (!job.timezone) return defaultMatcher;

  // For timezone-aware jobs, use a fresh matcher - no caching
  // This ensures each job gets matchers for its correct timezone without state leakage.
  return createMatcher({ timezone: job.timezone });
}
