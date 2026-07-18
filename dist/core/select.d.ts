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
export declare function selectRunnable<T>(jobs: Job<T>[], host: string, enabled: Set<string>, owners: Record<string, string>): Job<T>[];
/** Jobs firing during the minute containing `when`. Invalid schedules are skipped. */
export declare function dueAt<T>(jobs: Job<T>[], when: Date, matcher: CronMatcher): Job<T>[];
/**
 * Milliseconds to sleep until the soonest next fire across `jobs`, clamped
 * to `maxSleepMs`. The cap means the loop re-reads the registry at least that
 * often (picking up edits and self-healing clock skew). Returns the cap when
 * nothing is scheduled or every schedule never fires again. Invalid schedules
 * are ignored.
 */
export declare function nextWake<T>(jobs: Job<T>[], from: Date, matcher: CronMatcher, maxSleepMs: number): number;
