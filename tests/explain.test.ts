import { describe, expect, test } from "bun:test";
import { explainJob, createMatcher, type Heartbeat, type Job } from "../src/core/index";

const matcher = createMatcher();
// Fixed reference instant: 2026-07-01T12:00:00Z (noon UTC, top of hour).
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

function hb(lastFired: Record<string, number> = {}, ts = NOW_MS): Heartbeat {
  return {
    ts,
    host: "ml-1",
    runnable_count: 0,
    next_wake_ts: 0,
    last_dispatch: [],
    dispatched_minute: {},
    last_fired: lastFired,
    queue: [],
    running: {},
    last_completed: {},
    attempts: {},
    last_run: {},
    last_success: {},
  };
}

interface BaseArgs {
  host: string;
  heartbeat: Heartbeat | null;
  enabled: Set<string>;
  owners: Record<string, string>;
}

const base: BaseArgs = {
  host: "ml-1",
  heartbeat: null,
  enabled: new Set<string>(),
  owners: {},
};

function explain(j: Job, overrides: Partial<BaseArgs> = {}) {
  const rest = { ...base, ...overrides };
  return explainJob({
    jobs: [j],
    name: j.name,
    host: rest.host,
    enabled: rest.enabled,
    owners: rest.owners,
    heartbeat: rest.heartbeat,
    matcher,
    now: NOW,
  });
}

describe("explainJob — runnable each-job", () => {
  test("active each-job in enabled set → runnable, all gates pass, next fires populated", () => {
    const r = explain(job({ name: "alpha" }), { enabled: new Set(["alpha"]) });
    expect(r.runnable).toBe(true);
    expect(r.isActive).toBe(true);
    expect(r.scheduleValid).toBe(true);
    // "0 * * * *" at 12:00Z → next fires at 13:00, 14:00, 15:00, 16:00, 17:00
    expect(r.nextFires.length).toBe(5);
    expect(r.nextFires[0]).toBe(new Date("2026-07-01T13:00:00.000Z").getTime());
    expect(r.nextFires[1]).toBe(new Date("2026-07-01T14:00:00.000Z").getTime());
    // All gates passed
    expect(r.gates.every((g) => g.passed)).toBe(true);
    expect(r.gates.map((g) => g.gate)).toEqual(["active", "schedule", "scope", "enabled-membership", "owner-match"]);
    // The owner-match gate is "not applicable" for each-scope (passed: true)
    const ownerGate = r.gates.find((g) => g.gate === "owner-match")!;
    expect(ownerGate.passed).toBe(true);
    expect(ownerGate.reason).toContain("not applicable");
  });

  test("--count: 0 → no next fires", () => {
    const r = explainJob({
      jobs: [job({ name: "alpha" })],
      name: "alpha",
      host: "ml-1",
      enabled: new Set(["alpha"]),
      owners: {},
      heartbeat: null,
      matcher,
      now: NOW,
      options: { count: 0 },
    });
    expect(r.runnable).toBe(true);
    expect(r.nextFires).toEqual([]);
  });

  test("--count: 2 → exactly two next fires", () => {
    const r = explainJob({
      jobs: [job({ name: "alpha" })],
      name: "alpha",
      host: "ml-1",
      enabled: new Set(["alpha"]),
      owners: {},
      heartbeat: null,
      matcher,
      now: NOW,
      options: { count: 2 },
    });
    expect(r.nextFires.length).toBe(2);
  });

  test("last_fired from heartbeat is surfaced", () => {
    const r = explain(
      job({ name: "alpha" }),
      { enabled: new Set(["alpha"]), heartbeat: hb({ alpha: NOW_MS - 3600_000 }) },
    );
    expect(r.lastFired).toBe(NOW_MS - 3600_000);
  });

  test("last_fired is null when heartbeat is null", () => {
    const r = explain(job({ name: "alpha" }), { enabled: new Set(["alpha"]) });
    expect(r.lastFired).toBeNull();
  });

  test("last_fired is null when job not in heartbeat.last_fired", () => {
    const r = explain(
      job({ name: "alpha" }),
      { enabled: new Set(["alpha"]), heartbeat: hb({ other: NOW_MS }) },
    );
    expect(r.lastFired).toBeNull();
  });
});

describe("explainJob — not runnable: each-job not enabled", () => {
  test("each-job not in enabled set → not runnable, enabled-membership gate fails", () => {
    const r = explain(job({ name: "bravo" }), { enabled: new Set() });
    expect(r.runnable).toBe(false);
    const enabledGate = r.gates.find((g) => g.gate === "enabled-membership")!;
    expect(enabledGate.passed).toBe(false);
    expect(enabledGate.reason).toContain("NOT in this host's enabled set");
    expect(r.nextFires).toEqual([]);
  });

  test("inactive each-job → active gate fails, enabled gate also reported", () => {
    const r = explain(job({ name: "off", isActive: false }), { enabled: new Set(["off"]) });
    expect(r.runnable).toBe(false);
    const activeGate = r.gates.find((g) => g.gate === "active")!;
    expect(activeGate.passed).toBe(false);
    expect(activeGate.reason).toContain("inactive");
    // The enabled-membership gate is reported even though the job is inactive
    const enabledGate = r.gates.find((g) => g.gate === "enabled-membership")!;
    expect(enabledGate.passed).toBe(true); // it IS in the enabled set
  });
});

describe("explainJob — single-scope gating", () => {
  test("single-job owned by this host → runnable", () => {
    const r = explain(job({ name: "solo", scope: "single" }), { owners: { solo: "ml-1" } });
    expect(r.runnable).toBe(true);
    const ownerGate = r.gates.find((g) => g.gate === "owner-match")!;
    expect(ownerGate.passed).toBe(true);
    expect(ownerGate.reason).toContain("this host");
    // enabled-membership is not applicable for single-scope
    const enabledGate = r.gates.find((g) => g.gate === "enabled-membership")!;
    expect(enabledGate.passed).toBe(true);
    expect(enabledGate.reason).toContain("not applicable");
  });

  test("single-job owned by another host → not runnable, owner gate fails", () => {
    const r = explain(job({ name: "solo", scope: "single" }), { owners: { solo: "other" } });
    expect(r.runnable).toBe(false);
    const ownerGate = r.gates.find((g) => g.gate === "owner-match")!;
    expect(ownerGate.passed).toBe(false);
    expect(ownerGate.reason).toContain("other");
    expect(ownerGate.reason).toContain("not this host");
  });

  test("single-job with no owner entry → not runnable, owner gate fails with 'no owner'", () => {
    const r = explain(job({ name: "orphan", scope: "single" }), { owners: {} });
    expect(r.runnable).toBe(false);
    const ownerGate = r.gates.find((g) => g.gate === "owner-match")!;
    expect(ownerGate.passed).toBe(false);
    expect(ownerGate.reason).toContain("no owner declared");
  });

  test("single-job is gated by owner even if also in enabled set", () => {
    const r = explain(
      job({ name: "solo", scope: "single" }),
      { owners: { solo: "other" }, enabled: new Set(["solo"]) },
    );
    expect(r.runnable).toBe(false);
  });
});

describe("explainJob — schedule validity", () => {
  test("invalid schedule → scheduleValid false, nextFires empty even if runnable", () => {
    const r = explain(job({ name: "bad", cronSchedule: "not-a-cron" }), { enabled: new Set(["bad"]) });
    expect(r.runnable).toBe(true); // gating is separate from schedule validity
    expect(r.scheduleValid).toBe(false);
    expect(r.nextFires).toEqual([]);
  });

  test("blank schedule → not runnable, schedule gate is the failing gate", () => {
    const r = explain(job({ name: "blank", cronSchedule: "  " }), { enabled: new Set(["blank"]) });
    expect(r.runnable).toBe(false);
    const failing = r.gates.filter((g) => !g.passed);
    expect(failing.map((g) => g.gate)).toEqual(["schedule"]);
    expect(failing[0]!.reason).toContain("blank");
  });
});

describe("explainJob — unknown job", () => {
  test("throws when job name not in registry", () => {
    expect(() =>
      explainJob({
        jobs: [job({ name: "known" })],
        name: "unknown",
        host: "ml-1",
        enabled: new Set(),
        owners: {},
        heartbeat: null,
        matcher,
        now: NOW,
      }),
    ).toThrow("unknown job");
  });
});

describe("explainJob — never-fires-again schedule", () => {
  test("schedule that never fires again → runnable but nextFires empty", () => {
    const r = explain(job({ name: "never", cronSchedule: "0 0 31 2 *" }), { enabled: new Set(["never"]) });
    expect(r.runnable).toBe(true);
    expect(r.scheduleValid).toBe(true);
    expect(r.nextFires).toEqual([]);
  });
});

describe("explainJob — gates account for the verdict", () => {
  const cases: Array<[string, Partial<Job>, Partial<BaseArgs>, boolean]> = [
    ["active each enabled", {}, { enabled: new Set(["j"]) }, true],
    ["active each not enabled", {}, {}, false],
    ["inactive each enabled", { isActive: false }, { enabled: new Set(["j"]) }, false],
    ["blank each enabled", { cronSchedule: "" }, { enabled: new Set(["j"]) }, false],
    ["active single owned", { scope: "single" }, { owners: { j: "ml-1" } }, true],
    ["active single foreign", { scope: "single" }, { owners: { j: "other" } }, false],
    ["active single unowned", { scope: "single" }, {}, false],
    ["inactive single owned", { scope: "single", isActive: false }, { owners: { j: "ml-1" } }, false],
    ["blank single owned", { scope: "single", cronSchedule: "" }, { owners: { j: "ml-1" } }, false],
  ];
  for (const [label, jobOverrides, args, expected] of cases) {
    test(`${label} → runnable=${expected}, and runnable iff every gate passed`, () => {
      const r = explain(job(jobOverrides), args);
      expect(r.runnable).toBe(expected);
      expect(r.gates.every((g) => g.passed)).toBe(expected);
    });
  }
});
