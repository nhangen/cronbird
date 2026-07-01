import { describe, expect, test } from "bun:test";
import { computeStatus, createMatcher, type Heartbeat, type Job } from "../src/core/index";

const matcher = createMatcher();
// Fixed reference instant: 2026-07-01T12:00:00Z.
const NOW = new Date("2026-07-01T12:00:00.000Z");
const NOW_MS = NOW.getTime();

function job(overrides: Partial<Job> = {}): Job {
  return {
    name: "j",
    cronSchedule: "0 * * * *", // top of every hour
    isActive: true,
    hosts: ["*"],
    scope: "each",
    metadata: {},
    ...overrides,
  };
}

function hb(lastFired: Record<string, number>, ts = NOW_MS): Heartbeat {
  return {
    ts,
    host: "ml-1",
    runnable_count: 0,
    next_wake_ts: 0,
    last_dispatch: [],
    dispatched_minute: {},
    last_fired: lastFired,
  };
}

const base = {
  host: "ml-1",
  matcher,
  now: NOW,
  options: { staleGraceMs: 60_000 },
};

describe("computeStatus health", () => {
  test("inactive job → health inactive, not runnable, no nextFire", () => {
    const r = computeStatus({
      ...base,
      jobs: [job({ name: "off", isActive: false })],
      enabled: new Set(["off"]),
      owners: {},
      heartbeat: null,
    });
    const s = r.jobs[0]!;
    expect(s.health).toBe("inactive");
    expect(s.runnable).toBe(false);
    expect(s.nextFire).toBeNull();
  });

  test("active each-scope job not in enabled set → not-runnable", () => {
    const r = computeStatus({
      ...base,
      jobs: [job({ name: "e" })],
      enabled: new Set(),
      owners: {},
      heartbeat: null,
    });
    expect(r.jobs[0]!.health).toBe("not-runnable");
    expect(r.jobs[0]!.runnable).toBe(false);
  });

  test("single-scope job owned by another host → not-runnable; owned by this host → runnable", () => {
    const other = computeStatus({
      ...base,
      jobs: [job({ name: "s", scope: "single" })],
      enabled: new Set(),
      owners: { s: "mb-pro" },
      heartbeat: null,
    });
    expect(other.jobs[0]!.runnable).toBe(false);
    expect(other.jobs[0]!.health).toBe("not-runnable");

    const mine = computeStatus({
      ...base,
      jobs: [job({ name: "s", scope: "single" })],
      enabled: new Set(),
      owners: { s: "ml-1" },
      heartbeat: null,
    });
    expect(mine.jobs[0]!.runnable).toBe(true);
    // top-of-hour after 12:00Z is 13:00Z
    expect(mine.jobs[0]!.nextFire).toBe(new Date("2026-07-01T13:00:00.000Z").getTime());
  });

  test("runnable job with no recorded last fire → never-fired", () => {
    const r = computeStatus({
      ...base,
      jobs: [job({ name: "e" })],
      enabled: new Set(["e"]),
      owners: {},
      heartbeat: hb({}),
    });
    expect(r.jobs[0]!.health).toBe("never-fired");
    expect(r.jobs[0]!.lastFired).toBeNull();
  });

  test("runnable job fired recently (no missed slot) → ok", () => {
    const r = computeStatus({
      ...base,
      jobs: [job({ name: "e" })],
      enabled: new Set(["e"]),
      owners: {},
      // fired at 12:00Z exactly; next slot 13:00Z is in the future → ok
      heartbeat: hb({ e: NOW_MS }),
    });
    expect(r.jobs[0]!.health).toBe("ok");
    expect(r.jobs[0]!.lastFired).toBe(NOW_MS);
  });

  test("runnable job whose next slot after last fire is overdue past grace → stale", () => {
    const threeHoursAgo = NOW_MS - 3 * 3_600_000;
    const r = computeStatus({
      ...base,
      jobs: [job({ name: "e" })],
      enabled: new Set(["e"]),
      owners: {},
      // last fired 3h ago; the 10:00Z / 11:00Z slots came and went → stale
      heartbeat: hb({ e: threeHoursAgo }),
    });
    expect(r.jobs[0]!.health).toBe("stale");
  });
});

describe("computeStatus report shape", () => {
  test("heartbeat age is computed; null heartbeat → null age", () => {
    const withHb = computeStatus({
      ...base,
      jobs: [job({ name: "e" })],
      enabled: new Set(["e"]),
      owners: {},
      heartbeat: hb({}, NOW_MS - 30_000),
    });
    expect(withHb.heartbeatTs).toBe(NOW_MS - 30_000);
    expect(withHb.heartbeatAgeMs).toBe(30_000);

    const noHb = computeStatus({
      ...base,
      jobs: [job({ name: "e" })],
      enabled: new Set(["e"]),
      owners: {},
      heartbeat: null,
    });
    expect(noHb.heartbeatTs).toBeNull();
    expect(noHb.heartbeatAgeMs).toBeNull();
  });

  test("jobs are returned sorted by name", () => {
    const r = computeStatus({
      ...base,
      jobs: [job({ name: "charlie" }), job({ name: "alpha" }), job({ name: "bravo" })],
      enabled: new Set(),
      owners: {},
      heartbeat: null,
    });
    expect(r.jobs.map((j) => j.name)).toEqual(["alpha", "bravo", "charlie"]);
  });

  test("invalid cron schedule on a runnable job → nextFire null, does not throw", () => {
    const r = computeStatus({
      ...base,
      jobs: [job({ name: "bad", cronSchedule: "not a cron" })],
      enabled: new Set(["bad"]),
      owners: {},
      heartbeat: hb({}),
    });
    expect(r.jobs[0]!.nextFire).toBeNull();
    // never fired, invalid schedule → still classified never-fired (not crash)
    expect(r.jobs[0]!.health).toBe("never-fired");
  });
});
