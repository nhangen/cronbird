import { describe, expect, test } from "bun:test";
import type { Heartbeat, QueueEntry, CompletionRecord } from "../src/core/types";

describe("heartbeat shape", () => {
  test("carries queue, running, last_completed", () => {
    const q: QueueEntry = { name: "morning", priority: 1, slotTs: 0 };
    const c: CompletionRecord = { ts: 1, exitCode: 0, durationMs: 42 };
    const hb: Heartbeat = {
      ts: 0, host: "ml-1", runnable_count: 0, next_wake_ts: 0,
      last_dispatch: [], dispatched_minute: {}, last_fired: {},
      queue: [q], running: { morning: 5 }, last_completed: { morning: c },
      attempts: {}, last_run: {}, last_success: {},
    };
    expect(hb.queue[0].name).toBe("morning");
    expect(hb.running.morning).toBe(5);
    expect(hb.last_completed.morning.exitCode).toBe(0);
  });
});
