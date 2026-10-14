/**
 * Pure scheduling decisions for the cronbird daemon.
 *
 * These functions hold no clock, filesystem, or process state — the daemon loop
 * injects `now` and a {@link CronMatcher}. That keeps the scheduling logic
 * exhaustively unit-testable without sleeping or spawning.
 */
import { CronExpressionError, InvalidTimezoneError, type CronMatcher } from "./cron";
import type { Job } from "./types";

/**
 * Error classification for per-job matcher failures in the scheduling
 * decisions below. Invalid schedules (and invalid timezones) are the
 * operator-fixable, per-job condition: the job is skipped for this decision
 * and the fault is surfaced once through `onInvalid` instead of being
 * invisible. Every other error — probe exhaustion, a matcher-engine
 * (croner/Intl) failure, an injected matcher throwing — is internal, so it
 * is surfaced through `onInternalError` and left to the caller to decide
 * what to do: the daemon logs it and continues (skip, as before), simulate
 * aborts.
 */
export interface MatcherFaultHandlers {
  /**
   * Called once per (job, error) pair in a single call. The same job failing
   * both the `dueAt` and `nextWake` pass of one daemon tick therefore logs
   * twice — each decision is a distinct event.
   */
  onInvalid?(job: Job<unknown>, error: Error): void;
  /** Optional; called once per (job, error) pair for non-expected errors. */
  onInternalError?(job: Job<unknown>, error: Error): void;
}

export function classifyMatcherError(err: unknown): "invalid" | "internal" {
  if (err instanceof CronExpressionError || err instanceof InvalidTimezoneError) return "invalid";
  return "internal";
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function reportMatcherFault(job: Job<unknown>, err: unknown, handlers: MatcherFaultHandlers | undefined): void {
  const error = err instanceof Error ? err : new Error(errMessage(err));
  if (classifyMatcherError(err) === "invalid") handlers?.onInvalid?.(job, error);
  else handlers?.onInternalError?.(job, error);
}

/**
 * The jobs this host may run on a schedule: active, with a non-blank
 * cronSchedule, gated by scope. A `scope: "each"` job runs iff it is in this
 * host's local `enabled` set; a `scope: "single"` job runs iff this host is
 * its owner (`owners[name] === host`). Ownership is authoritative —
 * local enablement does not gate single-scope jobs.
 */
export function selectRunnable<T>(
  jobs: Job<T>[],
  host: string,
  enabled: Set<string>,
  owners: Record<string, string>,
): Job<T>[] {
  return jobs.filter((p) => {
    if (!p.isActive || p.cronSchedule.trim() === "") return false;
    if (p.scope === "single") return owners[p.name] === host;
    if (p.scope === "each") return enabled.has(p.name);
    return false;
  });
}

/**
 * Jobs firing during the minute containing `when`. Invalid schedules are
 * skipped and reported once per job via {@link MatcherFaultHandlers.onInvalid};
 * unexpected matcher errors (probe exhaustion, engine failures, an injected
 * matcher throwing) are reported once per job via `onInternalError` and also
 * skipped — the daemon treats both as "not due this minute", but the log line
 * tells the operator whether to fix the schedule or to investigate the host.
 * `matcherFor` resolves the per-job timezone-aware matcher for each job.
 */
export function dueAt<T>(
  jobs: Job<T>[],
  when: Date,
  matcherFor: (job: Job<T>) => CronMatcher,
  handlers?: MatcherFaultHandlers,
): Job<T>[] {
  return jobs.filter((p) => {
    try {
      return matcherFor(p).matchesAt(p.cronSchedule, when);
    } catch (err) {
      reportMatcherFault(p, err, handlers);
      return false;
    }
  });
}

/**
 * Milliseconds to sleep until the soonest next fire across `jobs`, clamped
 * to `maxSleepMs`. The cap means the loop re-reads the registry at least that
 * often (picking up edits and self-healing clock skew). Returns the cap when
 * nothing is scheduled or every schedule never fires again. Invalid schedules
 * are ignored and reported once per job via {@link MatcherFaultHandlers.onInvalid}.
 * An unexpected matcher error (probe exhaustion, engine failure, an injected
 * matcher throwing) is reported via `onInternalError` and, like an invalid
 * schedule, does not count toward the soonest fire — the cap still bounds the
 * sleep, so the loop re-reads the registry and the fault is not silently lost.
 * `matcherFor` resolves the per-job timezone-aware matcher for each job.
 */
export function nextWake<T>(
  jobs: Job<T>[],
  from: Date,
  matcherFor: (job: Job<T>) => CronMatcher,
  maxSleepMs: number,
  handlers?: MatcherFaultHandlers,
): number {
  let soonest = Infinity;
  for (const p of jobs) {
    let next: Date | null;
    try {
      next = matcherFor(p).nextFire(p.cronSchedule, from);
    } catch (err) {
      reportMatcherFault(p, err, handlers);
      continue;
    }
    if (next !== null) soonest = Math.min(soonest, next.getTime());
  }
  if (soonest === Infinity) return maxSleepMs;
  return Math.max(0, Math.min(soonest - from.getTime(), maxSleepMs));
}
