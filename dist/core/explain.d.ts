/**
 * Read-only "why a job is/isn't runnable here" derivation for the cronbird
 * scheduler.
 *
 * Pure, clock-injected, filesystem-free: the CLI (or any consumer) loads the
 * same config, registry, enablement, topology, and heartbeat the daemon uses,
 * then asks this module to explain a single job's gating. No I/O and no
 * scheduling — same discipline as {@link ./select} and {@link ./status}.
 *
 * This is the `explain <job>` projection for issue #16: it dissolves the
 * "why didn't my job run" debugging session into one command by spelling out
 * every gate — active? scope? enabled-membership? owner match? schedule
 * validity? — plus the next N fires and the last recorded fire.
 */
import { type CronMatcher } from "./cron";
import type { Heartbeat, Job, RunRecord } from "./types";
/** A single gate the job must pass to be runnable on this host, with the
 *  gate's outcome and a human-readable reason. */
export interface ExplainGate {
    /** Stable gate id: "active" | "schedule" | "scope" | "enabled-membership" | "owner-match". */
    gate: string;
    /** Whether the job passes this gate. */
    passed: boolean;
    /** Human-readable reason for the outcome. */
    reason: string;
}
export interface ExplainReport {
    name: string;
    host: string;
    /** Epoch ms the explanation was computed for. */
    now: number;
    schedule: string;
    scope: "each" | "single";
    isActive: boolean;
    /** Active, with a non-blank schedule, and gated to this host — i.e.
     *  {@link ./select.selectRunnable} would pick it. Mirrors
     *  {@link JobStatus.runnable} in ./status. */
    runnable: boolean;
    /** The ordered gates applied, and how each one went. The first failing gate
     *  (if any) is the reason the job is not runnable. */
    gates: ExplainGate[];
    /** True when the `cronSchedule` cannot be parsed. Distinct from "not
     *  runnable": a runnable job with an invalid schedule never fires. */
    scheduleValid: boolean;
    /** Why the schedule is invalid ("cronSchedule is blank" or the parser's
     *  message), or null when it parses. */
    scheduleError: string | null;
    /** Epoch ms of the newest recorded fire: heartbeat `last_fired`, else the
     *  newest run-history slot (same fallback as {@link JobStatus.lastFired}), or null. */
    lastFired: number | null;
    /** Up to `N` upcoming fire instants (epoch ms) strictly after `now`, or an
     *  empty list when not runnable / schedule invalid / never fires again. */
    nextFires: number[];
}
export interface ExplainOptions {
    /** How many upcoming fires to include (default 5). */
    count?: number;
}
/** Why the enabled set or topology owners are empty when the source file was
 *  never read (e.g. "enabledPath is not configured"). Appended to the failing
 *  gate's reason so a misconfigured path isn't mistaken for a missing entry. */
export interface ExplainSourceNotes {
    enabled?: string;
    topology?: string;
}
/**
 * Explain why `name` is or isn't runnable on `host`, and when it next fires.
 *
 * `name` must name a job in `jobs` — the caller (CLI) does the lookup and
 * erroring. The gates mirror {@link ./select.selectRunnable} exactly:
 *
 *   1. active            — `isActive === true` (invariant gate for all jobs)
 *   2. schedule          — `cronSchedule` is not blank
 *   3. scope             — the job's declared `scope` (informational)
 *   4. enabled-membership — `scope === "each"`: job is in this host's enabled set
 *   5. owner-match        — `scope === "single"`: `owners[name] === host`
 *
 * A job is runnable iff it passes gates 1, 2, and 4/5 (as applicable). Gates
 * are reported in order; a failing gate is a hard stop for the *runnable*
 * conclusion but subsequent gates are still evaluated and reported so the
 * operator sees the full picture (e.g. an inactive each-job that's also not
 * in the enabled set shows both failures).
 */
export declare function explainJob<T>(args: {
    jobs: Job<T>[];
    name: string;
    host: string;
    enabled: Set<string>;
    owners: Record<string, string>;
    heartbeat: Heartbeat | null;
    matcher: CronMatcher;
    now: Date;
    options?: ExplainOptions;
    history?: RunRecord[];
    sourceNotes?: ExplainSourceNotes;
}): ExplainReport;
