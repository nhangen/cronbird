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
const DAY_MS = 24 * 60 * MINUTE_MS;
// Longest supported DST overlap is three hours (Antarctica/Casey 2018–2023); the cap leaves slack.
const MAX_OVERLAP_PROBES = 4 * 60;
// Fall-back overlap lengths: Casey 3h (2018-2023), Troll 2h, most zones 1h, Lord_Howe 30m.
const FALL_BACK_OVERLAPS_MS = [180 * MINUTE_MS, 120 * MINUTE_MS, 60 * MINUTE_MS, 30 * MINUTE_MS];

class CronerMatcher implements CronMatcher {
  private readonly formatter: Intl.DateTimeFormat;

  constructor(private readonly opts: MatcherOptions = {}) {
    this.formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: this.opts.timezone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hour12: false,
    });
  }

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

  /** Zone offset (local minus UTC) at `date`, in ms, truncated to the second. */
  private getOffsetMs(date: Date): number {
    let year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0;
    for (const part of this.formatter.formatToParts(date)) {
      switch (part.type) {
        case "year": year = Number(part.value); break;
        case "month": month = Number(part.value); break;
        case "day": day = Number(part.value); break;
        case "hour": {
          const h = Number(part.value);
          // hour12:false can print midnight as "24".
          hour = h === 24 ? 0 : h;
          break;
        }
        case "minute": minute = Number(part.value); break;
        case "second": second = Number(part.value); break;
      }
    }
    return Date.UTC(year, month - 1, day, hour, minute, second) - (date.getTime() - date.getUTCMilliseconds());
  }

  private resolveFirstOccurrence(date: Date): Date {
    const prevDay = new Date(date.getTime() - DAY_MS);
    const shiftMs = this.getOffsetMs(prevDay) - this.getOffsetMs(date);
    if (shiftMs > 0) {
      const candidate = new Date(date.getTime() - shiftMs);
      if (this.formatter.format(candidate) === this.formatter.format(date)) {
        return candidate;
      }
    }
    return date;
  }

  /**
   * Whether `from` or `soonest` is near a UTC-offset change in this zone.
   * On days without a DST transition the zone offset is constant across
   * the probe window, so the fall-back shift loop can never discover a
   * second-occurrence candidate.
   */
  private nearOffsetChange(from: Date, soonest: Date): boolean {
    const fromOffset = this.getOffsetMs(from);
    if (fromOffset !== this.getOffsetMs(soonest)) return true;
    return fromOffset !== this.getOffsetMs(new Date(from.getTime() - DAY_MS));
  }

  private nextFirstFire(cron: Cron, expr: string, from: Date): Date | null {
    // Inside a DST fall-back hour croner 9.1 can return an instant before `from`,
    // or pick the second occurrence in zones east of UTC.
    // Step past the overlap until it returns a real successor.
    for (let probe = from.getTime(), i = 0; i < MAX_OVERLAP_PROBES; probe += MINUTE_MS, i++) {
      const raw = cron.nextRun(new Date(probe));
      if (raw === null) return null;
      const first = this.resolveFirstOccurrence(raw);
      if (first.getTime() > from.getTime()) return first;
    }
    throw new Error(`cron ${JSON.stringify(expr)}: no fire after ${from.toISOString()} within ${MAX_OVERLAP_PROBES} minutes of probing`);
  }

  nextFire(expr: string, from: Date): Date | null {
    const cron = this.build(expr);
    let soonest = this.nextFirstFire(cron, expr, from);
    if (soonest === null || !this.isSubHourly(expr)) return soonest;
    if (soonest.getTime() - from.getTime() <= MINUTE_MS) return soonest;
    if (!this.nearOffsetChange(from, soonest)) return soonest;

    for (const shiftMs of FALL_BACK_OVERLAPS_MS) {
      const probeFrom = new Date(from.getTime() - shiftMs);
      const firstCandidate = this.nextFirstFire(cron, expr, probeFrom);
      if (firstCandidate === null) continue;
      const secondCandidate = new Date(firstCandidate.getTime() + shiftMs);
      if (
        secondCandidate.getTime() > from.getTime() &&
        secondCandidate.getTime() < soonest.getTime() &&
        this.formatter.format(secondCandidate) === this.formatter.format(firstCandidate)
      ) {
        soonest = secondCandidate;
      }
    }
    return soonest;
  }

  matchesAt(expr: string, when: Date): boolean {
    const minute = Math.floor(when.getTime() / MINUTE_MS) * MINUTE_MS;
    const next = this.nextFire(expr, new Date(minute - 1));
    return next !== null && next.getTime() === minute;
  }

  /**
   * Sub-hourly: a literal `*` hour field and a minute field that is not a
   * single fixed value. Only these keep firing through the second occurrence of
   * a fall-back overlap; every other schedule fires once, at the first.
   */
  private isSubHourly(expr: string): boolean {
    const [minuteField, hourField] = expr.trim().split(/\s+/);
    if (hourField !== "*") return false;
    if (/^\d+$/.test(minuteField ?? "")) return false;
    return true;
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
 * Resolves a {@link CronMatcher} for a job. Each resolver instance owns a
 * private per-timezone cache, so different callers (tests, simulate runs,
 * daemons) never share state.
 */
export interface JobMatcherResolver {
  /**
   * Return the matcher for the given job. Jobs without a timezone return the
   * resolver's default matcher; jobs with a timezone get a per-timezone cached
   * matcher (created once per timezone string per resolver).
   */
  resolve(job: Job): CronMatcher;
}

/**
 * Create a matcher resolver with its own isolated per-timezone cache.
 *
 * Jobs without a `timezone` return `defaultMatcher` (or a host-local
 * `createMatcher()` when none is supplied). Jobs with a `timezone` get a
 * dedicated matcher, cached inside this resolver only — no module-level
 * state is shared.
 */
export function createJobMatcherResolver(defaultMatcher?: CronMatcher): JobMatcherResolver {
  const byTimezone = new Map<string, CronMatcher>();
  const fallback = defaultMatcher ?? createMatcher();

  return {
    resolve: (job: Job) => {
      if (!job.timezone) return fallback;
      const cached = byTimezone.get(job.timezone);
      if (cached) return cached;
      const m = createMatcher({ timezone: job.timezone });
      byTimezone.set(job.timezone, m);
      return m;
    },
  };
}

/**
 * Return the correct {@link CronMatcher} for a job, honouring its
 * `timezone` field. Jobs without a `timezone` fall through to
 * `defaultMatcher` (typically a host-local `createMatcher()`).
 *
 * @deprecated Use {@link createJobMatcherResolver} to get a per-caller
 * resolver with isolated state, or inject a `JobMatcherResolver` directly
 * into daemon/simulate entry points.
 */
export function matcherForJob(job: Job, defaultMatcher: CronMatcher): CronMatcher {
  if (!job.timezone) return defaultMatcher;
  return createMatcher({ timezone: job.timezone });
}
