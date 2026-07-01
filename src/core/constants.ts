/** Cap on a single sleep: the loop re-reads the registry at least this often. */
export const MAX_SLEEP_MS = 60_000;

/**
 * Bounds for the per-schedule missed-slot catch-up look-back. The daemon
 * derives each job's look-back from its own cadence and clamps it here: a
 * sub-floor cadence (e.g. 5-minutely) clamps up to the floor, a long cadence
 * (daily, weekly) clamps down to the cap.
 */
export const CATCHUP_LOOKBACK_FLOOR_MS = 3_600_000; // 1 hour
export const CATCHUP_LOOKBACK_CAP_MS = 21_600_000; // 6 hours
