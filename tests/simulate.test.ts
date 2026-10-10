import { describe, expect, test } from "bun:test";
import { createMatcher, simulateSchedule, type Job } from "../src/core/index";

const m = createMatcher({ timezone: "UTC" });
const d = (iso: string) => new Date(iso);

const pb = (over: Partial<Job<unknown>>): Job<unknown> => ({
  name: "p",
  cronSchedule: "0 9 * * *",
  isActive: true,
  hosts: ["*"],
  scope: "each",
  metadata: {},
  ...over,
});

describe("simulateSchedule — core fast-forward engine", () => {
  test("fast-forwards single job across multi-day window with zero wall-clock wait", () => {
    const report = simulateSchedule({
      from: d("2026-06-01T00:00:00Z"),
      to: d("2026-06-03T12:00:00Z"),
      host: "ml-1",
      jobs: [pb({ name: "nine", cronSchedule: "0 9 * * *" })],
      enabled: new Set(["nine"]),
      owners: {},
      matcher: m,
    });

    expect(report.host).toBe("ml-1");
    expect(report.dispatches.length).toBe(3);
    expect(report.dispatches.map((x) => x.timeIso)).toEqual([
      "2026-06-01T09:00:00.000Z",
      "2026-06-02T09:00:00.000Z",
      "2026-06-03T09:00:00.000Z",
    ]);
    expect(report.dispatches.every((x) => x.type === "due")).toBe(true);
  });

  test("interleaves multiple cadences in exact chronological order", () => {
    const report = simulateSchedule({
      from: d("2026-06-01T09:00:00Z"),
      to: d("2026-06-01T09:30:00Z"),
      host: "ml-1",
      jobs: [
        pb({ name: "ten", cronSchedule: "*/10 * * * *" }),
        pb({ name: "fifteen", cronSchedule: "*/15 * * * *" }),
      ],
      enabled: new Set(["ten", "fifteen"]),
      owners: {},
      matcher: m,
    });

    // 09:00 -> ten + fifteen
    // 09:10 -> ten
    // 09:15 -> fifteen
    // 09:20 -> ten
    // 09:30 -> ten + fifteen
    const trace = report.dispatches.map((x) => `${x.timeIso.slice(11, 16)}:${x.job}`);
    expect(trace).toEqual([
      "09:00:fifteen",
      "09:00:ten",
      "09:10:ten",
      "09:15:fifteen",
      "09:20:ten",
      "09:30:fifteen",
      "09:30:ten",
    ]);
  });

  test("boundary: from with sub-minute seconds does not fire prior minute slot", () => {
    // 09:00:30 is strictly after 09:00:00, so a 09:00 slot is not eligible
    const report = simulateSchedule({
      from: d("2026-06-01T09:00:30Z"),
      to: d("2026-06-01T09:30:00Z"),
      host: "ml-1",
      jobs: [pb({ name: "nine", cronSchedule: "0 9 * * *" })],
      enabled: new Set(["nine"]),
      owners: {},
      matcher: m,
    });

    expect(report.dispatches.length).toBe(0);
  });

  test("boundary: exact minute from == to fires due jobs on that minute", () => {
    const report = simulateSchedule({
      from: d("2026-06-01T09:00:00Z"),
      to: d("2026-06-01T09:00:00Z"),
      host: "ml-1",
      jobs: [pb({ name: "nine", cronSchedule: "0 9 * * *" })],
      enabled: new Set(["nine"]),
      owners: {},
      matcher: m,
    });

    expect(report.dispatches.length).toBe(1);
    expect(report.dispatches[0]!.job).toBe("nine");
    expect(report.dispatches[0]!.timeIso).toBe("2026-06-01T09:00:00.000Z");
  });

  test("boundary: from > to throws RangeError", () => {
    expect(() =>
      simulateSchedule({
        from: d("2026-06-01T10:00:00Z"),
        to: d("2026-06-01T09:00:00Z"),
        host: "ml-1",
        jobs: [],
        enabled: new Set(),
        owners: {},
      }),
    ).toThrow(RangeError);
  });

  test("scope gating: single-scope without owner and each-scope without enabled do not run", () => {
    const report = simulateSchedule({
      from: d("2026-06-01T09:00:00Z"),
      to: d("2026-06-01T10:00:00Z"),
      host: "ml-1",
      jobs: [
        pb({ name: "singleNoOwner", scope: "single" }),
        pb({ name: "singleOtherHost", scope: "single" }),
        pb({ name: "singleMine", scope: "single" }),
        pb({ name: "eachDisabled", scope: "each" }),
        pb({ name: "eachEnabled", scope: "each" }),
      ],
      enabled: new Set(["eachEnabled"]),
      owners: { singleOtherHost: "ml-2", singleMine: "ml-1" },
      matcher: m,
    });

    const dispatchedNames = report.dispatches.map((x) => x.job).sort();
    expect(dispatchedNames).toEqual(["eachEnabled", "singleMine"]);
  });

  test("priority ordering: same-minute dispatches order by priority then name", () => {
    const report = simulateSchedule({
      from: d("2026-06-01T09:00:00Z"),
      to: d("2026-06-01T09:00:00Z"),
      host: "ml-1",
      jobs: [
        pb({ name: "lowPrio", metadata: { p: 10 } }),
        pb({ name: "highPrio", metadata: { p: 1 } }),
        pb({ name: "alsoHighPrio", metadata: { p: 1 } }),
      ],
      enabled: new Set(["lowPrio", "highPrio", "alsoHighPrio"]),
      owners: {},
      matcher: m,
      priority: (j) => (j.metadata as { p: number }).p,
    });

    expect(report.dispatches.map((x) => x.job)).toEqual(["alsoHighPrio", "highPrio", "lowPrio"]);
  });

  test("dependency validation: invalid cycle jobs are excluded with warnings", () => {
    const report = simulateSchedule({
      from: d("2026-06-01T09:00:00Z"),
      to: d("2026-06-01T09:00:00Z"),
      host: "ml-1",
      jobs: [
        pb({ name: "jobA" }),
        pb({ name: "jobB" }),
        pb({ name: "independent" }),
      ],
      enabled: new Set(["jobA", "jobB", "independent"]),
      owners: {},
      matcher: m,
      dependencies: (j) => {
        if (j.name === "jobA") return ["jobB"];
        if (j.name === "jobB") return ["jobA"];
        return [];
      },
    });

    expect(report.warnings.length).toBeGreaterThan(0);
    expect(report.warnings.some((w) => w.includes("cycle"))).toBe(true);
    expect(report.dispatches.map((x) => x.job)).toEqual(["independent"]);
  });

  test("catch-up: initialLastFired baseline catches up missed slots at T0", () => {
    const report = simulateSchedule({
      from: d("2026-06-01T09:00:00Z"),
      to: d("2026-06-01T09:00:00Z"),
      host: "ml-1",
      // job fires at 08:00, but not 09:00
      jobs: [pb({ name: "eight", cronSchedule: "0 8 * * *" })],
      enabled: new Set(["eight"]),
      owners: {},
      matcher: m,
      // last fired was 2026-05-31 08:00 (missed today's 08:00 slot)
      initialLastFired: { eight: d("2026-05-31T08:00:00Z").getTime() },
    });

    expect(report.dispatches.length).toBe(1);
    expect(report.dispatches[0]!.job).toBe("eight");
    expect(report.dispatches[0]!.type).toBe("catchup");
    expect(report.dispatches[0]!.timeIso).toBe("2026-06-01T09:00:00.000Z");
    expect(new Date(report.dispatches[0]!.slotTs).toISOString()).toBe("2026-06-01T08:00:00.000Z");
  });
});

describe("simulateSchedule — skipped-job diagnostics", () => {
  test("warns for each active job that is not runnable on this host", () => {
    const report = simulateSchedule({
      from: d("2026-06-01T09:00:00Z"),
      to: d("2026-06-01T09:00:00Z"),
      host: "ml-1",
      jobs: [
        pb({ name: "eachDisabled", scope: "each" }),
        pb({ name: "singleNoOwner", scope: "single" }),
        pb({ name: "singleOther", scope: "single" }),
        pb({ name: "inactive", scope: "each", isActive: false }),
      ],
      enabled: new Set(),
      owners: { singleOther: "ml-2" },
      matcher: m,
    });

    expect(report.warnings).toEqual([
      "eachDisabled: not runnable on ml-1 (scope=each, not in enabled set)",
      "singleNoOwner: not runnable on ml-1 (scope=single, owner=none)",
      "singleOther: not runnable on ml-1 (scope=single, owner=ml-2)",
    ]);
  });

  test("warns for a runnable job whose schedule does not parse", () => {
    const report = simulateSchedule({
      from: d("2026-06-01T09:00:00Z"),
      to: d("2026-06-01T10:00:00Z"),
      host: "ml-1",
      jobs: [pb({ name: "typo", cronSchedule: "0 25 * * *" }), pb({ name: "ok", cronSchedule: "0 * * * *" })],
      enabled: new Set(["typo", "ok"]),
      owners: {},
      matcher: m,
    });

    expect(report.warnings).toEqual(['typo: invalid cron schedule "0 25 * * *"']);
    expect(report.dispatches.map((x) => x.job)).toEqual(["ok", "ok"]);
  });
});
