import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendRunRecordFile,
  createFileRunHistorySink,
  readRunHistoryFile,
  rotateRunHistoryFile,
  writeRunHistoryFile,
  type RunRecord,
} from "../src/cli/index";

const dir = mkdtempSync(join(tmpdir(), "cronbird-history-file-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const baseSlot = Date.now();

function rec(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    job: "alpha",
    scheduledFor: baseSlot,
    startedAt: baseSlot + 10,
    finishedAt: baseSlot + 500,
    exitCode: 0,
    outcome: "success",
    durationMs: 490,
    ...overrides,
  };
}

describe("history-file round-trip & append", () => {
  test("appends and reads back valid JSONL records", () => {
    const file = join(dir, "append.jsonl");
    const r1 = rec({ job: "job-1", scheduledFor: baseSlot });
    const r2 = rec({ job: "job-2", scheduledFor: baseSlot + 60_000 });

    appendRunRecordFile(file, r1);
    appendRunRecordFile(file, r2);

    const loaded = readRunHistoryFile(file);
    expect(loaded.length).toBe(2);
    expect(loaded.find((r) => r.job === "job-1")).toEqual(r1);
    expect(loaded.find((r) => r.job === "job-2")).toEqual(r2);
  });

  test("missing file reads as empty array", () => {
    expect(readRunHistoryFile(join(dir, "nonexistent.jsonl"))).toEqual([]);
  });

  test("tolerates corrupt lines and blank lines without throwing", () => {
    const file = join(dir, "corrupt.jsonl");
    const r1 = rec({ job: "good-1" });
    const r2 = rec({ job: "good-2", scheduledFor: baseSlot + 100_000 });

    writeFileSync(
      file,
      [
        JSON.stringify(r1),
        "this is not json",
        "",
        JSON.stringify({ not: "a valid run record" }),
        JSON.stringify(r2),
      ].join("\n"),
    );

    const loaded = readRunHistoryFile(file);
    expect(loaded.length).toBe(2);
    expect(loaded.map((r) => r.job)).toEqual(["good-1", "good-2"]);
  });

  test("reads whole-file JSON array fallback", () => {
    const file = join(dir, "legacy-array.json");
    const r1 = rec({ job: "arr-1" });
    writeFileSync(file, JSON.stringify([r1], null, 2));

    const loaded = readRunHistoryFile(file);
    expect(loaded.length).toBe(1);
    expect(loaded[0]!.job).toBe("arr-1");
  });
});

describe("history-file rotation & sink", () => {
  test("rotateRunHistoryFile bounds file size and writes ascending order even from unordered appends", () => {
    const file = join(dir, "rotate.jsonl");
    const r1 = rec({ scheduledFor: baseSlot + 10 });
    const r2 = rec({ scheduledFor: baseSlot + 20 });
    const r3 = rec({ scheduledFor: baseSlot + 30 });

    // Append in non-chronological order: r3, r1, r2
    appendRunRecordFile(file, r3);
    appendRunRecordFile(file, r1);
    appendRunRecordFile(file, r2);

    // Rotate with maxRecords = 2
    rotateRunHistoryFile(file, { maxRecords: 2, maxAgeMs: 1_000_000 }, baseSlot + 100);

    const content = readFileSync(file, "utf8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(2);

    const loaded = readRunHistoryFile(file);
    expect(loaded.map((r) => r.scheduledFor)).toEqual([baseSlot + 20, baseSlot + 30]);
  });

  test("rotateRunHistoryFile throws and leaves a non-empty file untouched when no record parses", () => {
    const file = join(dir, "corrupt.jsonl");
    const corruptContent = "not-json\nalso-corrupt\n";
    writeFileSync(file, corruptContent);

    expect(() => rotateRunHistoryFile(file, { maxRecords: 10 })).toThrow(/rotation skipped/);
    expect(readFileSync(file, "utf8")).toBe(corruptContent);
  });

  test("readRunHistoryFile throws on a read error other than a missing file", () => {
    const asDir = join(dir, "history-is-a-dir.jsonl");
    mkdirSync(asDir);
    expect(() => readRunHistoryFile(asDir)).toThrow();
    expect(readRunHistoryFile(join(dir, "does-not-exist.jsonl"))).toEqual([]);
  });

  test("writeRunHistoryFile sorts records chronologically ascending", () => {
    const file = join(dir, "write-ordered.jsonl");
    const r1 = rec({ scheduledFor: baseSlot + 10 });
    const r2 = rec({ scheduledFor: baseSlot + 20 });
    writeRunHistoryFile(file, [r2, r1]);

    const loaded = readRunHistoryFile(file);
    expect(loaded.map((r) => r.scheduledFor)).toEqual([baseSlot + 10, baseSlot + 20]);
  });

  test("createFileRunHistorySink writes records and triggers periodic rotation", () => {
    const file = join(dir, "sink.jsonl");
    const logs: string[] = [];
    // Sink configured with rotation interval = 3 writes and maxRecords = 2
    const sink = createFileRunHistorySink(file, { maxRecords: 2, maxAgeMs: 1_000_000 }, 3, (msg) => logs.push(msg));

    sink(rec({ scheduledFor: baseSlot + 1 }));
    sink(rec({ scheduledFor: baseSlot + 2 }));
    expect(readRunHistoryFile(file).length).toBe(2);

    // 3rd write hits interval -> triggers rotation to maxRecords=2
    sink(rec({ scheduledFor: baseSlot + 3 }));

    const loaded = readRunHistoryFile(file);
    expect(loaded.length).toBe(2);
    expect(loaded.map((r) => r.scheduledFor)).toEqual([baseSlot + 2, baseSlot + 3]);
    expect(logs.length).toBe(0);
  });

  test("createFileRunHistorySink logs rotation error on failure", () => {
    const file = join(dir, "sink-fail.jsonl");
    appendRunRecordFile(file, rec({ scheduledFor: baseSlot + 1 }));
    appendRunRecordFile(file, rec({ scheduledFor: baseSlot + 2 }));
    mkdirSync(`${file}.tmp`);

    const logs: string[] = [];
    const sink = createFileRunHistorySink(file, { maxRecords: 1 }, 1, (msg) => logs.push(msg));
    sink(rec({ scheduledFor: baseSlot + 3 }));
    expect(logs.length).toBe(1);
    expect(logs[0]!).toContain("history rotation failed");
  });
});
