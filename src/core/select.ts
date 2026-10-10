/**
 * Pure scheduling decisions for the cronbird daemon.
 *
 * These functions hold no clock, filesystem, or process state — the daemon loop
 * injects `now` and a {@link CronMatcher}. That keeps the scheduling logic
 * exhaustively unit-testable without sleeping or spawning.
 */
import type { CronMatcher } from "./cron";
import type { Job } from "./types";

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
 * Jobs firing during the minute containing `when`. Invalid schedules are skipped.
 * `matcherFor` resolves the per-job timezone-aware matcher for each job.
 */
export function dueAt<T>(jobs: Job<T>[], when: Date, matcherFor: (job: Job<T>) => CronMatcher): Job<T>[] {
  return jobs.filter((p) => {
    try {
      return matcherFor(p).matchesAt(p.cronSchedule, when);
    } catch {
      return false;
    }
  });
}

/**
 * Milliseconds to sleep until the soonest next fire across `jobs`, clamped
 * to `maxSleepMs`. The cap means the loop re-reads the registry at least that
 * often (picking up edits and self-healing clock skew). Returns the cap when
 * nothing is scheduled or every schedule never fires again. Invalid schedules
 * are ignored.
 * `matcherFor` resolves the per-job timezone-aware matcher for each job.
 */
export function nextWake<T>(
  jobs: Job<T>[],
  from: Date,
  matcherFor: (job: Job<T>) => CronMatcher,
  maxSleepMs: number,
): number {
  let soonest = Infinity;
  for (const p of jobs) {
    let next: Date | null;
    try {
      next = matcherFor(p).nextFire(p.cronSchedule, from);
    } catch {
      continue;
    }
    if (next !== null) soonest = Math.min(soonest, next.getTime());
  }
  if (soonest === Infinity) return maxSleepMs;
  return Math.max(0, Math.min(soonest - from.getTime(), maxSleepMs));
}
