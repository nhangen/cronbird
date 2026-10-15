/**
 * Missed-slot catch-up for the cronbird daemon.
 *
 * When the daemon was down or a sleep overshot (suspend), schedules that should
 * have fired during the gap were skipped — the live loop only fires the current
 * minute via `matchesAt`. Catch-up fires **once** for the newest missed slot of
 * each job and skips the rest (no replay storm), bounded by a look-back
 * window so a slot that is too stale to be useful is not replayed.
 *
 * Pure: the daemon injects `now`, the matcher, and the look-back. The current
 * minute is deliberately excluded — that is the live dueAt path's responsibility.
 */
import type { CronMatcher } from "./cron";
import { classifyMatcherError, type MatcherFaultHandlers } from "./select";
import type { Job } from "./types";

const MINUTE_MS = 60_000;
/** Bound on forward iteration when scanning for missed fires (defensive). */
const MAX_SCAN = 100_000;
/** Fires sampled forward to estimate a schedule's cadence (yields N-1 gaps). */
const PERIOD_SAMPLES = 5;

/**
 * A per-schedule catch-up look-back derived from the schedule's own cadence,
 * so a registry with mixed cadences isn't served by one global value:
 * a 5-minutely slot shouldn't replay hours late, but a daily slot missed by an
 * overnight suspend should still catch up within a few hours.
 *
 * The cadence proxy is the MIN gap between the next {@link PERIOD_SAMPLES} fires
 * — the tightest interval the schedule fires at. Min-of-gaps (not the single
 * next gap) is deliberate: a forward sample anchored at `now` varies with wake
 * time for irregular schedules (e.g. fires at 09:00 and 12:00 give a 3h-then-21h
 * or 21h-then-3h pattern depending on `now`), whereas the min is
 * cadence-intrinsic. The result is
 * clamped to [floorMs, capMs]: sub-floor cadences clamp up (catch-up fires the
 * newest slot once regardless), and long cadences (daily, weekly) clamp down to
 * the cap — a weekly slot missed by more than the cap is deliberately not
 * replayed (don't run a stale job late at night). Unparseable / single-fire
 * schedules fall back to the floor and never throw.
 *
 * A matcher fault (invalid schedule, probe exhaustion, an engine failure) is
 * reported through `handlers` and the floor is still returned — the look-back
 * is only a bound on replay, so a fault must not crash the tick: the job is
 * dropped for this decision, exactly as in {@link ./select} (#72, #74).
 *
 * The min over a fixed sample window is an upper-bound estimate: a schedule
 * whose tightest gap only recurs beyond the window would round *up* toward the
 * cap. That errs conservative — a too-large look-back only ever replays the one
 * already-newest slot once (newest-slot semantics) and is still clamped to the
 * cap — so under-sampling can't cause a replay storm.
 */
export function lookbackForSchedule(
  schedule: string,
  now: Date,
  matcher: CronMatcher,
  floorMs: number,
  capMs: number,
  handlers?: MatcherFaultHandlers,
): number {
  let cursor = now;
  let prev: Date | null = null;
  let minGap = Number.POSITIVE_INFINITY;
  for (let i = 0; i < PERIOD_SAMPLES; i++) {
    let next: Date | null;
    try {
      next = matcher.nextFire(schedule, cursor);
    } catch (err) {
      reportFault(schedule, err, handlers);
      break;
    }
    if (next === null) break;
    if (prev !== null) {
      const gap = next.getTime() - prev.getTime();
      if (gap < minGap) minGap = gap;
    }
    prev = next;
    cursor = next;
  }
  if (!Number.isFinite(minGap)) return floorMs;
  return Math.min(Math.max(minGap, floorMs), capMs);
}

/**
 * The newest fire strictly after `lastFired` (clamped to `now - lookbackMs`) and
 * strictly before the start of the minute containing `now`, or `null` if none.
 * An unparseable schedule yields `null` rather than throwing; a matcher fault
 * (invalid schedule, probe exhaustion, an engine failure) is reported through
 * `handlers` and likewise yields `null` — the job is dropped for this decision,
 * exactly as in {@link ./select} (#72, #74).
 */
export function newestMissedSlot(
  schedule: string,
  lastFired: number,
  now: Date,
  matcher: CronMatcher,
  lookbackMs: number,
  handlers?: MatcherFaultHandlers,
): Date | null {
  const floor = Math.max(lastFired, now.getTime() - lookbackMs);
  const currentMinuteStart = Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS;
  if (floor >= currentMinuteStart) return null;

  let cursor = new Date(floor);
  let newest: Date | null = null;
  for (let i = 0; i < MAX_SCAN; i++) {
    let next: Date | null;
    try {
      next = matcher.nextFire(schedule, cursor);
    } catch (err) {
      reportFault(schedule, err, handlers);
      return null;
    }
    if (next === null || next.getTime() >= currentMinuteStart) break;
    newest = next;
    cursor = next;
  }
  return newest;
}

/**
 * Report a per-schedule matcher fault the same way {@link ./select} does:
 * invalid schedules (and invalid timezones) go to `onInvalid`, everything else
 * — probe exhaustion, an engine failure, an injected matcher throwing — to
 * `onInternalError`. `schedule` stands in for the job name (the catch-up
 * primitives are job-free); the owning job is known at the call sites that
 * wire a handler.
 */
function reportFault(schedule: string, err: unknown, handlers?: MatcherFaultHandlers): void {
  const error = err instanceof Error ? err : new Error(String(err));
  const pseudo: Job<unknown> = { name: schedule, cronSchedule: schedule, isActive: true, hosts: ["*"], scope: "each", metadata: {} };
  if (classifyMatcherError(err) === "invalid") handlers?.onInvalid?.(pseudo, error);
  else handlers?.onInternalError?.(pseudo, error);
}

export interface CatchUpFire<T = unknown> {
  job: Job<T>;
  slot: Date;
}

/**
 * Catch-up fires for a set of jobs. A job with no `last_fired` baseline
 * is skipped — the daemon has no basis to claim a slot was missed before it
 * started watching, so first-sight never triggers a replay.
 *
 * `matcherFor` resolves the per-job timezone-aware matcher for each job.
 *
 * `lookbackFor` resolves each job's look-back from its own schedule:
 * the daemon passes a period-derived resolver ({@link lookbackForSchedule}) or a
 * fixed `() => n` when the host pins the window via the env override.
 *
 * Matcher faults are reported once per job through `handlers` (see
 * {@link ./select.MatcherFaultHandlers}) and the job is skipped for this
 * decision — the same "not due, but not invisible" policy as `dueAt`/`nextWake`
 * (#72, #74).
 */
export function catchUpFires<T>(
  jobs: Job<T>[],
  lastFired: Record<string, number>,
  now: Date,
  matcherFor: (job: Job<T>) => CronMatcher,
  lookbackFor: (job: Job<T>) => number,
  handlers?: MatcherFaultHandlers,
): CatchUpFire<T>[] {
  const fires: CatchUpFire<T>[] = [];
  for (const p of jobs) {
    const baseline = lastFired[p.name];
    if (baseline === undefined) continue;
    let slot: Date | null;
    try {
      slot = newestMissedSlot(p.cronSchedule, baseline, now, matcherFor(p), lookbackFor(p), handlers);
    } catch (err) {
      // `matcherFor`/`lookbackFor` are injected resolvers (per-timezone matcher
      // creation, period sampling) — they can throw for the same reasons the
      // matcher does. Classify instead of letting the tick crash (#74).
      const error = err instanceof Error ? err : new Error(String(err));
      if (classifyMatcherError(err) === "invalid") handlers?.onInvalid?.(p, error);
      else handlers?.onInternalError?.(p, error);
      continue;
    }
    if (slot !== null) fires.push({ job: p, slot });
  }
  return fires;
}
