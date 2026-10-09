/**
 * Durable append-oriented persistence and rotation for run-history records.
 *
 * Stores run records as a newline-delimited JSON (JSONL) file. Dispatches and
 * completions append single lines atomically. `readRunHistoryFile` loads and
 * merges lines by unique dispatch key (`mergeRunRecords`). `rotateRunHistoryFile`
 * prunes stale/overflow records and rewrites the file atomically via tmp+rename
 * in ascending chronological order.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  HISTORY_ROTATION_INTERVAL_WRITES,
  mergeRunRecords,
  pruneRunHistory,
  type RunHistoryRetentionOptions,
  type RunOutcome,
  type RunRecord,
} from "../core/index";

/**
 * Appends a single run record to the history file.
 */
export function appendRunRecordFile(path: string, record: RunRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(record) + "\n", "utf8");
}

/**
 * Reads run records from disk. Tolerates corrupt lines (drops them rather than
 * crashing), parses valid JSON lines, merges in-flight and completion records,
 * and returns the merged set. Also parses a top-level JSON array fallback.
 */
export function readRunHistoryFile(path: string): RunRecord[] {
  if (!existsSync(path)) return [];

  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return [];
  }

  const trimmed = content.trim();
  if (trimmed.length === 0) return [];

  // Fallback: support a whole-file JSON array [ ... ] if created manually or by tools
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const valid = parsed.filter(isValidRunRecord);
        return mergeRunRecords(valid);
      }
    } catch {
      // Not valid JSON array; fall through to line-by-line parsing
    }
  }

  const records: RunRecord[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    const l = line.trim();
    if (l.length === 0) continue;
    try {
      const parsed = JSON.parse(l);
      if (isValidRunRecord(parsed)) {
        records.push(parsed);
      }
    } catch {
      // Drop malformed/torn lines — fail-safe posture matching readHeartbeatFile
    }
  }

  return mergeRunRecords(records);
}

function isValidRunRecord(o: unknown): o is RunRecord {
  if (typeof o !== "object" || o === null) return false;
  const r = o as Record<string, unknown>;
  if (typeof r.job !== "string" || r.job.length === 0) return false;
  if (typeof r.scheduledFor !== "number" || !Number.isFinite(r.scheduledFor)) return false;
  if (typeof r.startedAt !== "number" || !Number.isFinite(r.startedAt)) return false;
  if (r.finishedAt !== null && typeof r.finishedAt !== "number") return false;
  if (r.exitCode !== null && typeof r.exitCode !== "number") return false;
  if (r.durationMs !== null && typeof r.durationMs !== "number") return false;
  if (r.outcome !== "running" && r.outcome !== "success" && r.outcome !== "failure") return false;
  return true;
}

/**
 * Atomically rewrites the run-history file via tmp + rename, preserving records
 * in ascending chronological order so subsequent appends remain ordered.
 */
export function writeRunHistoryFile(path: string, records: RunRecord[]): void {
  mkdirSync(dirname(path), { recursive: true });

  // Ensure records are ordered chronologically ascending
  const sorted = [...records].sort((a, b) => {
    if (a.scheduledFor !== b.scheduledFor) return a.scheduledFor - b.scheduledFor;
    return a.startedAt - b.startedAt;
  });

  const content = sorted.map((r) => JSON.stringify(r)).join("\n") + (sorted.length > 0 ? "\n" : "");
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

/**
 * Prunes the run-history file according to retention bounds (maxRecords, maxAgeMs)
 * and rewrites it atomically.
 */
export function rotateRunHistoryFile(
  path: string,
  options: RunHistoryRetentionOptions = {},
  now: number = Date.now(),
): void {
  if (!existsSync(path)) return;
  const current = readRunHistoryFile(path);
  const pruned = pruneRunHistory(current, options, now);
  writeRunHistoryFile(path, pruned);
}

/**
 * Creates an append sink function for DaemonDeps.recordRun that appends each
 * record and periodically rotates the file every `interval` writes.
 */
export function createFileRunHistorySink(
  path: string,
  options: RunHistoryRetentionOptions = {},
  interval: number = HISTORY_ROTATION_INTERVAL_WRITES,
): (record: RunRecord) => void {
  let appendsSinceRotation = 0;

  return (record: RunRecord): void => {
    appendRunRecordFile(path, record);
    appendsSinceRotation++;
    if (appendsSinceRotation >= interval) {
      appendsSinceRotation = 0;
      try {
        rotateRunHistoryFile(path, options);
      } catch {
        // Rotation failure should not throw to daemon loop
      }
    }
  };
}
