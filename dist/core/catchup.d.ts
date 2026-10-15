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
import { type MatcherFaultHandlers } from "./select";
import type { Job } from "./types";
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
 * reported through `handlers` when given and the floor is still returned — the
 * look-back is only a bound on replay, so a fault must not crash the tick. The
 * daemon and simulate resolvers leave `handlers` off on purpose: the same
 * matcher's fault is reported with the real job by {@link catchUpFires},
 * `dueAt` and `nextWake`, and reporting here too would log it again on every
 * look-back lookup, including stale-slot eviction (#74).
 *
 * The min over a fixed sample window is an upper-bound estimate: a schedule
 * whose tightest gap only recurs beyond the window would round *up* toward the
 * cap. That errs conservative — a too-large look-back only ever replays the one
 * already-newest slot once (newest-slot semantics) and is still clamped to the
 * cap — so under-sampling can't cause a replay storm.
 */
export declare function lookbackForSchedule(schedule: string, now: Date, matcher: CronMatcher, floorMs: number, capMs: number, handlers?: MatcherFaultHandlers): number;
/**
 * The newest fire strictly after `lastFired` (clamped to `now - lookbackMs`) and
 * strictly before the start of the minute containing `now`, or `null` if none.
 * An unparseable schedule yields `null` rather than throwing; a matcher fault
 * (invalid schedule, probe exhaustion, an engine failure) is reported through
 * `handlers` and likewise yields `null` — the job is dropped for this decision,
 * exactly as in {@link ./select} (#72, #74).
 */
export declare function newestMissedSlot(schedule: string, lastFired: number, now: Date, matcher: CronMatcher, lookbackMs: number, handlers?: MatcherFaultHandlers): Date | null;
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
 * Matcher faults are reported against the owning job through `handlers` (see
 * {@link ./select.MatcherFaultHandlers}) and the job is skipped for this
 * decision — the same "not due, but not invisible" policy as `dueAt`/`nextWake`
 * (#72, #74).
 */
export declare function catchUpFires<T>(jobs: Job<T>[], lastFired: Record<string, number>, now: Date, matcherFor: (job: Job<T>) => CronMatcher, lookbackFor: (job: Job<T>) => number, handlers?: MatcherFaultHandlers): CatchUpFire<T>[];
