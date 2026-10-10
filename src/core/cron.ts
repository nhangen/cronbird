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
    return this.build(expr).nextRun(from);
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

const matcherCache = new Map<string, CronMatcher>();

/**
 * Return the correct {@link CronMatcher} for a job, honouring its
 * `timezone` field. Jobs without a `timezone` fall through to
 * `defaultMatcher` (typically a host-local `createMatcher()`).
 *
 * Matchers are cached per timezone string so repeated calls for jobs that
 * share a zone do not re-validate or re-allocate.
 */
export function matcherForJob(job: Job, defaultMatcher: CronMatcher): CronMatcher {
  if (!job.timezone) return defaultMatcher;
  const cached = matcherCache.get(job.timezone);
  if (cached) return cached;
  const m = createMatcher({ timezone: job.timezone });
  matcherCache.set(job.timezone, m);
  return m;
}
