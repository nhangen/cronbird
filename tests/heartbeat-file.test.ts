import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Heartbeat } from "../src/core/index";
import {
  isPermanentLocalWriteError,
  PermanentHeartbeatWriteError,
  readHeartbeatFile,
  writeHeartbeatFile,
  writeHeartbeatWithSync,
  writeSyncedHeartbeat,
} from "../src/cli/heartbeat-file";

function errno(code: string, message = code): NodeJS.ErrnoException {
  const e = new Error(message) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

const dir = mkdtempSync(join(tmpdir(), "cronbird-hb-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const hb: Heartbeat = {
  ts: 1_780_000_000_000,
  host: "ml-1",
  runnable_count: 3,
  next_wake_ts: 1_780_000_060_000,
  last_dispatch: [{ name: "morning-scan", ts: 1_780_000_000_000 }],
  dispatched_minute: { "morning-scan": 29_666_666 },
  last_fired: { "morning-scan": 1_780_000_000_000 },
  queue: [],
  running: {},
  last_completed: {},
  attempts: {},
  last_run: {},
  last_success: {},
};

describe("heartbeat round-trip", () => {
  test("writes then reads back an identical heartbeat (creates ~/.ceo/schedulerd)", () => {
    const path = join(dir, "schedulerd", "heartbeat.json");
    writeHeartbeatFile(path, hb);
    expect(readHeartbeatFile(path)).toEqual(hb);
  });

  test("missing file reads as null (guard simply starts empty)", () => {
    expect(readHeartbeatFile(join(dir, "nope.json"))).toBeNull();
  });

  test("malformed JSON reads as null rather than throwing at startup", () => {
    const path = join(dir, "corrupt.json");
    writeFileSync(path, "{ this is not json");
    expect(readHeartbeatFile(path)).toBeNull();
  });

  test("structurally wrong heartbeat (no dispatched_minute) reads as null", () => {
    const path = join(dir, "wrong.json");
    writeFileSync(path, JSON.stringify({ ts: 1, host: "x" }));
    expect(readHeartbeatFile(path)).toBeNull();
  });

  test("non-numeric dispatched_minute values are dropped so the guard never holds a string", () => {
    const path = join(dir, "badguard.json");
    writeFileSync(
      path,
      JSON.stringify({ ts: 1, host: "x", dispatched_minute: { good: 5, bad: "abc", alsobad: null } }),
    );
    expect(readHeartbeatFile(path)!.dispatched_minute).toEqual({ good: 5 });
  });

  test("a pre-#143 heartbeat with no last_fired reads as empty (re-baselines, no crash)", () => {
    const path = join(dir, "prev143.json");
    writeFileSync(path, JSON.stringify({ ts: 1, host: "x", dispatched_minute: { a: 5 } }));
    expect(readHeartbeatFile(path)!.last_fired).toEqual({});
  });

  test("non-numeric last_fired values are dropped", () => {
    const path = join(dir, "badlastfired.json");
    writeFileSync(
      path,
      JSON.stringify({ ts: 1, host: "x", dispatched_minute: {}, last_fired: { good: 99, bad: "x" } }),
    );
    expect(readHeartbeatFile(path)!.last_fired).toEqual({ good: 99 });
  });
});

describe("synced heartbeat", () => {
  test("writes {host, ts} atomically and leaves no .tmp on success", () => {
    const path = join(dir, "heartbeats", "ml-1.json");
    writeSyncedHeartbeat(path, "ml-1");
    expect(existsSync(`${path}.tmp`)).toBe(false);
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.host).toBe("ml-1");
    expect(typeof written.ts).toBe("string");
  });
});

describe("writeHeartbeatWithSync", () => {
  test("a synced-write failure does not skip the host-local heartbeat and is logged, not thrown", () => {
    const localWrites: Heartbeat[] = [];
    const logs: string[] = [];
    expect(() =>
      writeHeartbeatWithSync(hb, {
        writeLocal: (h) => localWrites.push(h),
        writeSynced: () => {
          throw new Error("EROFS: read-only synced vault");
        },
        log: (m) => logs.push(m),
      }),
    ).not.toThrow();
    // Invariant: host-local write happened even though the synced write failed.
    expect(localWrites).toEqual([hb]);
    expect(logs.some((m) => m.includes("synced heartbeat write failed"))).toBe(true);
  });

  test("on success both writes run and nothing is logged", () => {
    let local = false;
    let synced = false;
    const logs: string[] = [];
    writeHeartbeatWithSync(hb, {
      writeLocal: () => {
        local = true;
      },
      writeSynced: () => {
        synced = true;
      },
      log: (m) => logs.push(m),
    });
    expect(local).toBe(true);
    expect(synced).toBe(true);
    expect(logs).toEqual([]);
  });

  test("a permanent local-write failure (EROFS) logs a distinct fatal, throws PermanentHeartbeatWriteError, and never attempts the synced write (#13)", () => {
    let synced = false;
    const logs: string[] = [];
    let thrown: unknown;
    try {
      writeHeartbeatWithSync(hb, {
        writeLocal: () => {
          throw errno("EROFS", "EROFS: read-only file system, open '/x/heartbeat.json'");
        },
        writeSynced: () => {
          synced = true;
        },
        log: (m) => logs.push(m),
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(PermanentHeartbeatWriteError);
    expect((thrown as PermanentHeartbeatWriteError).code).toBe("EROFS");
    // Loud + distinct — not the swallowed "synced heartbeat write failed" line.
    expect(logs.some((m) => m.includes("FATAL") && m.includes("permanent local heartbeat-write failure") && m.includes("EROFS"))).toBe(true);
    // Fail-safe intact: the local write failed, so the synced write is never reached and nothing is dispatched.
    expect(synced).toBe(false);
  });

  test("a transient local-write failure (EAGAIN) propagates as-is for a normal respawn, with no permanent banner and no synced write", () => {
    let synced = false;
    const logs: string[] = [];
    let thrown: unknown;
    try {
      writeHeartbeatWithSync(hb, {
        writeLocal: () => {
          throw errno("EAGAIN", "EAGAIN: resource temporarily unavailable");
        },
        writeSynced: () => {
          synced = true;
        },
        log: (m) => logs.push(m),
      });
    } catch (e) {
      thrown = e;
    }
    // Not reclassified: the original transient error propagates for a bare respawn.
    expect(thrown).not.toBeInstanceOf(PermanentHeartbeatWriteError);
    expect((thrown as NodeJS.ErrnoException).code).toBe("EAGAIN");
    expect(logs.some((m) => m.includes("permanent"))).toBe(false);
    expect(synced).toBe(false);
  });
});

describe("isPermanentLocalWriteError", () => {
  test("classifies unrecoverable-without-intervention errno codes as permanent", () => {
    for (const code of ["EACCES", "EPERM", "EROFS", "ENOSPC", "EDQUOT", "ENOTDIR", "EISDIR", "ENAMETOOLONG"]) {
      expect(isPermanentLocalWriteError(errno(code))).toBe(true);
    }
  });

  test("classifies transient / unknown errno as not permanent", () => {
    for (const code of ["EAGAIN", "EBUSY", "EINTR", "EIO", "EMFILE"]) {
      expect(isPermanentLocalWriteError(errno(code))).toBe(false);
    }
    expect(isPermanentLocalWriteError(new Error("no code"))).toBe(false);
    expect(isPermanentLocalWriteError(null)).toBe(false);
    expect(isPermanentLocalWriteError("EROFS")).toBe(false);
  });
});
