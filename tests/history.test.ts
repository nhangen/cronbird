import { describe, expect, test } from "bun:test";
import {
  mergeRunRecords,
  pruneRunHistory,
  queryRunHistory,
  runRecordKey,
  type RunRecord,
} from "../src/core/index";

const baseSlot = 1_720_000_000_000;

function rec(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    job: "scan",
    scheduledFor: baseSlot,
    startedAt: baseSlot + 100,
    finishedAt: null,
    exitCode: null,
    outcome: "running",
    durationMs: null,
    ...overrides,
  };
}

describe("mergeRunRecords", () => {
  test("completion record updates an earlier in-flight record", () => {
    const r1 = rec({ outcome: "running" });
    const r2 = rec({ finishedAt: baseSlot + 5_000, exitCode: 0, outcome: "success", durationMs: 4_900 });

    const merged = mergeRunRecords([r1, r2]);
    expect(merged.length).toBe(1);
    expect(merged[0]!).toEqual({
      job: "scan",
      scheduledFor: baseSlot,
      startedAt: baseSlot + 100,
      finishedAt: baseSlot + 5_000,
      exitCode: 0,
      outcome: "success",
      durationMs: 4_900,
    });
  });

  test("terminal outcome dominates running even if out-of-order", () => {
    const successRec = rec({ finishedAt: baseSlot + 5_000, exitCode: 0, outcome: "success", durationMs: 4_900 });
    const runningRec = rec({ outcome: "running" });

    // Completed record arrived first or duplicate running arrived later
    const merged = mergeRunRecords([successRec, runningRec]);
    expect(merged.length).toBe(1);
    expect(merged[0]!.outcome).toBe("success");
    expect(merged[0]!.finishedAt).toBe(baseSlot + 5_000);
  });

  test("retries with the same scheduledFor but distinct startedAt are preserved", () => {
    // Attempt 1: started at +100, failed at +1_000
    const attempt1 = rec({
      startedAt: baseSlot + 100,
      finishedAt: baseSlot + 1_000,
      exitCode: 1,
      outcome: "failure",
      durationMs: 900,
    });
    // Attempt 2: started at +2_000, succeeded at +4_000
    const attempt2 = rec({
      startedAt: baseSlot + 2_000,
      finishedAt: baseSlot + 4_000,
      exitCode: 0,
      outcome: "success",
      durationMs: 2_000,
    });

    const merged = mergeRunRecords([attempt1, attempt2]);
    expect(merged.length).toBe(2);
    expect(merged.map((r) => r.outcome)).toEqual(["failure", "success"]);
    expect(merged.map((r) => r.exitCode)).toEqual([1, 0]);
  });

  test("runRecordKey incorporates job, scheduledFor, and startedAt", () => {
    const r = rec({ job: "report", scheduledFor: 1000, startedAt: 1050 });
    expect(runRecordKey(r)).toBe("report:1000:1050");
  });
});

describe("queryRunHistory", () => {
  const r1 = rec({ job: "alpha", scheduledFor: baseSlot, startedAt: baseSlot, outcome: "success", finishedAt: baseSlot + 100, exitCode: 0, durationMs: 100 });
  const r2 = rec({ job: "alpha", scheduledFor: baseSlot + 60_000, startedAt: baseSlot + 60_000, outcome: "failure", finishedAt: baseSlot + 60_200, exitCode: 1, durationMs: 200 });
  const r3 = rec({ job: "beta", scheduledFor: baseSlot + 120_000, startedAt: baseSlot + 120_000, outcome: "running" });

  test("queries all records sorted descending by scheduledFor", () => {
    const results = queryRunHistory([r1, r2, r3]);
    expect(results.length).toBe(3);
    expect(results.map((r) => r.job)).toEqual(["beta", "alpha", "alpha"]);
    expect(results.map((r) => r.scheduledFor)).toEqual([baseSlot + 120_000, baseSlot + 60_000, baseSlot]);
  });

  test("filters by job", () => {
    const results = queryRunHistory([r1, r2, r3], { job: "alpha" });
    expect(results.length).toBe(2);
    expect(results.every((r) => r.job === "alpha")).toBe(true);
  });

  test("filters by time range (since / until)", () => {
    // Window selecting only r2 (at baseSlot + 60_000)
    const results = queryRunHistory([r1, r2, r3], {
      since: baseSlot + 30_000,
      until: baseSlot + 90_000,
    });
    expect(results.length).toBe(1);
    expect(results[0]!.scheduledFor).toBe(baseSlot + 60_000);
  });

  test("filters by outcome", () => {
    const successes = queryRunHistory([r1, r2, r3], { outcome: "success" });
    expect(successes.length).toBe(1);
    expect(successes[0]!.job).toBe("alpha");

    const running = queryRunHistory([r1, r2, r3], { outcome: "running" });
    expect(running.length).toBe(1);
    expect(running[0]!.job).toBe("beta");
  });

  test("applies limit", () => {
    const results = queryRunHistory([r1, r2, r3], { limit: 2 });
    expect(results.length).toBe(2);
    expect(results.map((r) => r.scheduledFor)).toEqual([baseSlot + 120_000, baseSlot + 60_000]);
  });
});

describe("pruneRunHistory", () => {
  test("prunes records older than maxAgeMs", () => {
    const now = baseSlot + 100_000;
    const oldRec = rec({ scheduledFor: baseSlot - 50_000, startedAt: baseSlot - 50_000 });
    const freshRec = rec({ scheduledFor: baseSlot + 80_000, startedAt: baseSlot + 80_000 });

    // maxAgeMs = 30_000 -> cutoff is now - 30_000 = baseSlot + 70_000
    const pruned = pruneRunHistory([oldRec, freshRec], { maxAgeMs: 30_000 }, now);
    expect(pruned.length).toBe(1);
    expect(pruned[0]!.scheduledFor).toBe(baseSlot + 80_000);
  });

  test("caps records to maxRecords, retaining the newest in chronological order", () => {
    const r1 = rec({ scheduledFor: baseSlot + 10, startedAt: baseSlot + 10 });
    const r2 = rec({ scheduledFor: baseSlot + 20, startedAt: baseSlot + 20 });
    const r3 = rec({ scheduledFor: baseSlot + 30, startedAt: baseSlot + 30 });

    const pruned = pruneRunHistory([r1, r2, r3], { maxRecords: 2, maxAgeMs: 1_000_000 }, baseSlot + 100);
    expect(pruned.length).toBe(2);
    // Keeps newest two (r2 and r3) in ascending chronological order
    expect(pruned.map((r) => r.scheduledFor)).toEqual([baseSlot + 20, baseSlot + 30]);
  });
});
