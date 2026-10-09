import type { RunOutcome, RunRecord } from "./types";
export interface RunHistoryQuery {
    /** Filter to a specific job name. */
    job?: string;
    /** Filter to records with scheduledFor >= since (epoch ms). */
    since?: number;
    /** Filter to records with scheduledFor <= until (epoch ms). */
    until?: number;
    /** Filter to records with a specific outcome. */
    outcome?: RunOutcome;
    /** Maximum number of records to return. */
    limit?: number;
}
export interface RunHistoryRetentionOptions {
    /** Maximum number of total records to retain. Defaults to 1000. */
    maxRecords?: number;
    /** Maximum age in ms relative to `now`. Defaults to 7 days. */
    maxAgeMs?: number;
}
/**
 * Unique key identifying a specific dispatch attempt of a job.
 * Keyed by job + scheduledFor + startedAt so retries of the same scheduled slot
 * are preserved as distinct runs rather than overwriting previous attempts.
 */
export declare function runRecordKey(r: Pick<RunRecord, "job" | "scheduledFor" | "startedAt">): string;
/**
 * Folds a sequence of append-oriented records by their dispatch key.
 * When multiple records share the same key (e.g. initial dispatch as "running"
 * followed by a later completion entry), terminal outcomes ("success" | "failure")
 * dominate "running", preserving the final state of the run.
 */
export declare function mergeRunRecords(records: RunRecord[]): RunRecord[];
/**
 * Query run records with filtering by job, time range (since/until on scheduledFor),
 * outcome, and limit. Returns records sorted descending (newest scheduledFor first).
 */
export declare function queryRunHistory(records: RunRecord[], query?: RunHistoryQuery): RunRecord[];
/**
 * Prunes records according to retention bounds (maxAgeMs and maxRecords).
 * Returns retained records in ascending chronological order (ready for append-log storage).
 */
export declare function pruneRunHistory(records: RunRecord[], options?: RunHistoryRetentionOptions, now?: number): RunRecord[];
