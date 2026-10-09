/**
 * Structured run-history query and retention engine for cronbird/core.
 *
 * Pure, clock-injected, filesystem-free: operates on in-memory {@link RunRecord}
 * structures. Provides query filtering (by job, time range, outcome, limit),
 * append-log folding (merging in-flight and completed records by unique dispatch key),
 * and bounded retention pruning.
 */
import { DEFAULT_HISTORY_RETENTION_MS, DEFAULT_MAX_HISTORY_RECORDS } from "./constants";
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
export function runRecordKey(r: Pick<RunRecord, "job" | "scheduledFor" | "startedAt">): string {
  return `${r.job}:${r.scheduledFor}:${r.startedAt}`;
}

/**
 * Folds a sequence of append-oriented records by their dispatch key.
 * When multiple records share the same key (e.g. initial dispatch as "running"
 * followed by a later completion entry), terminal outcomes ("success" | "failure")
 * dominate "running", preserving the final state of the run.
 */
export function mergeRunRecords(records: RunRecord[]): RunRecord[] {
  const byKey = new Map<string, RunRecord>();

  for (const r of records) {
    const key = runRecordKey(r);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...r });
      continue;
    }

    // Terminal outcome dominates running: a completed run is never rolled back
    // to "running" if records arrive out-of-order or duplicate.
    if (existing.outcome !== "running" && r.outcome === "running") {
      continue;
    }

    byKey.set(key, {
      ...existing,
      ...r,
      finishedAt: r.finishedAt ?? existing.finishedAt,
      exitCode: r.exitCode ?? existing.exitCode,
      durationMs: r.durationMs ?? existing.durationMs,
      outcome: r.outcome,
    });
  }

  return Array.from(byKey.values());
}

/**
 * Query run records with filtering by job, time range (since/until on scheduledFor),
 * outcome, and limit. Returns records sorted descending (newest scheduledFor first).
 */
export function queryRunHistory(records: RunRecord[], query: RunHistoryQuery = {}): RunRecord[] {
  const merged = mergeRunRecords(records);

  const filtered = merged.filter((r) => {
    if (query.job !== undefined && r.job !== query.job) return false;
    if (query.since !== undefined && r.scheduledFor < query.since) return false;
    if (query.until !== undefined && r.scheduledFor > query.until) return false;
    if (query.outcome !== undefined && r.outcome !== query.outcome) return false;
    return true;
  });

  filtered.sort((a, b) => {
    if (b.scheduledFor !== a.scheduledFor) return b.scheduledFor - a.scheduledFor;
    return b.startedAt - a.startedAt;
  });

  if (query.limit !== undefined) {
    if (query.limit <= 0) return [];
    return filtered.slice(0, query.limit);
  }

  return filtered;
}

/**
 * Prunes records according to retention bounds (maxAgeMs and maxRecords).
 * Returns retained records in ascending chronological order (ready for append-log storage).
 */
export function pruneRunHistory(
  records: RunRecord[],
  options: RunHistoryRetentionOptions = {},
  now: number = Date.now(),
): RunRecord[] {
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_HISTORY_RECORDS;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_HISTORY_RETENTION_MS;
  const cutoff = now - maxAgeMs;

  const merged = mergeRunRecords(records);
  const unexpired = merged.filter((r) => r.scheduledFor >= cutoff);

  unexpired.sort((a, b) => {
    if (a.scheduledFor !== b.scheduledFor) return a.scheduledFor - b.scheduledFor;
    return a.startedAt - b.startedAt;
  });

  if (unexpired.length > maxRecords) {
    return unexpired.slice(unexpired.length - maxRecords);
  }

  return unexpired;
}
