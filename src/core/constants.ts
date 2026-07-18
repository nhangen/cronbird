/** Cap on a single sleep: the loop re-reads the registry at least this often. */
export const MAX_SLEEP_MS = 60_000;

/**
 * Max jobs the scheduler runs concurrently. N=1 serializes the whole chain: a
 * newly-drained job waits until the running one completes (observed via the
 * dispatch wrapper's `done/` state files). This is the "blocking, not locking"
 * behavior — queued jobs wait their turn instead of racing a lock and dropping.
 */
export const MAX_CONCURRENT = 1;

/**
 * Retry budget for a failing job: it re-enqueues at the back of the line after
 * each failure, and on the MAX_ATTEMPTS-th failure is marked failed (not
 * re-queued). "Failed" is a pure function of persisted state — `attempts >=
 * MAX_ATTEMPTS && last exit ≠ 0` — so a crash mid-decision re-derives it.
 */
export const MAX_ATTEMPTS = 3;

/**
 * Dispatch-wrapper-reserved exit code for an unrecoverable failure (e.g. a
 * missing-credential `requires:` gate). Fails fast — the retry logic jumps
 * straight to the cap rather than burning MAX_ATTEMPTS runs on a guaranteed loss.
 * 78 = EX_CONFIG (sysexits.h).
 */
export const FATAL_EXIT_CODE = 78;

/**
 * Exit code for `cronbird status` when the daemon's own heartbeat is stale
 * (presumed dead / not scheduling). Lets an external monitor detect a stopped
 * scheduler by exit code alone, without parsing output (#17). 69 = EX_UNAVAILABLE
 * (sysexits.h) — the service is unavailable. Distinct from 1 (config error) and
 * 2 (usage).
 */
export const STALE_EXIT_CODE = 69;

/**
 * Bounds for the per-schedule missed-slot catch-up look-back. The daemon
 * derives each job's look-back from its own cadence and clamps it here: a
 * sub-floor cadence (e.g. 5-minutely) clamps up to the floor, a long cadence
 * (daily, weekly) clamps down to the cap.
 */
export const CATCHUP_LOOKBACK_FLOOR_MS = 3_600_000; // 1 hour
export const CATCHUP_LOOKBACK_CAP_MS = 21_600_000; // 6 hours
