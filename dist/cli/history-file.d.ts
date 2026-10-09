import { type RunHistoryRetentionOptions, type RunRecord } from "../core/index";
/**
 * Appends a single run record to the history file.
 */
export declare function appendRunRecordFile(path: string, record: RunRecord): void;
/**
 * Reads run records from disk. Tolerates corrupt lines (drops them rather than
 * crashing), parses valid JSON lines, merges in-flight and completion records,
 * and returns the merged set. Also parses a top-level JSON array fallback.
 */
export declare function readRunHistoryFile(path: string): RunRecord[];
/**
 * Atomically rewrites the run-history file via tmp + rename, preserving records
 * in ascending chronological order so subsequent appends remain ordered.
 */
export declare function writeRunHistoryFile(path: string, records: RunRecord[]): void;
/**
 * Prunes the run-history file according to retention bounds (maxRecords, maxAgeMs)
 * and rewrites it atomically.
 */
export declare function rotateRunHistoryFile(path: string, options?: RunHistoryRetentionOptions, now?: number): void;
/**
 * Creates an append sink function for DaemonDeps.recordRun that appends each
 * record and periodically rotates the file every `interval` writes.
 */
export declare function createFileRunHistorySink(path: string, options?: RunHistoryRetentionOptions, interval?: number): (record: RunRecord) => void;
