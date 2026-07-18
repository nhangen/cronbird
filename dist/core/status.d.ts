/**
 * Read-only status derivation for the cronbird scheduler.
 *
 * Pure, clock-injected, filesystem-free: the CLI (or any consumer) loads jobs,
 * enablement, topology, and the heartbeat, then asks this module to project a
 * {@link StatusReport}. No I/O and no product coupling — same discipline as
 * {@link ./select}. This is the substrate a `cronbird status`/`list`/`next-runs`
 * command renders, and the data any future dashboard would read.
 */
import type { CronMatcher } from "./cron";
import type { Heartbeat, Job } from "./types";
export type JobHealth = 
/** `isActive === false` — the daemon never fires it. */
"inactive"
/** Active, but not gated to this host (scope/enabled/owner). */
 | "not-runnable"
/** Runnable, but the `cronSchedule` cannot be parsed — the daemon can never
 *  fire it. Dominates fire history: a broken schedule is the headline. */
 | "invalid-schedule"
/** Runnable, valid schedule, but the heartbeat records no prior fire. */
 | "never-fired"
/** Runnable, fired, and no scheduled slot has been missed past the grace. */
 | "ok"
/** Runnable and fired, but a slot scheduled after the last fire is overdue
 *  past the grace window — the daemon likely missed it (outage/clock skew). */
 | "stale";
export interface JobStatus {
    name: string;
    schedule: string;
    scope: "each" | "single";
    isActive: boolean;
    /** Active AND gated to this host — i.e. the daemon would fire it here. */
    runnable: boolean;
    /** Epoch ms of the newest recorded fire, or null if never fired. */
    lastFired: number | null;
    /** Epoch ms of the next scheduled fire; null when not runnable, when the
     *  schedule never fires again, or when the expression is invalid. */
    nextFire: number | null;
    health: JobHealth;
}
export interface StatusReport {
    host: string;
    /** Epoch ms the report was computed for. */
    now: number;
    /** Epoch ms of the daemon's last heartbeat, or null if none on disk. */
    heartbeatTs: number | null;
    /** `now - heartbeatTs`, or null when there is no heartbeat. */
    heartbeatAgeMs: number | null;
    /** All jobs, sorted by name. */
    jobs: JobStatus[];
}
export interface StatusOptions {
    /** A runnable, previously-fired job is "stale" when a slot scheduled after
     *  its last fire is more than this many ms in the past. Callers should set
     *  this above the daemon's wake cap so a just-woken daemon isn't flagged. */
    staleGraceMs: number;
}
export declare function computeStatus<T>(args: {
    jobs: Job<T>[];
    host: string;
    enabled: Set<string>;
    owners: Record<string, string>;
    heartbeat: Heartbeat | null;
    matcher: CronMatcher;
    now: Date;
    options: StatusOptions;
}): StatusReport;
