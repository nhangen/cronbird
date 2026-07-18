import { describe, expect, test } from "bun:test";
import { createMatcher } from "../src/core/cron";
import type { Job } from "../src/core/types";
import { dueAt, nextWake, selectRunnable } from "../src/core/select";

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

describe("selectRunnable — status + schedule gating", () => {
  const enabled = new Set(["a", "b", "c", "p"]);

  test("drops non-active jobs", () => {
    const pbs = [pb({ name: "a", isActive: false }), pb({ name: "b", isActive: false }), pb({ name: "c", isActive: true })];
    expect(selectRunnable(pbs, "ml-1", enabled, {}).map((p) => p.name)).toEqual(["c"]);
  });

  test("drops entries with a blank schedule", () => {
    const pbs = [pb({ name: "a", cronSchedule: "   " }), pb({ name: "b", cronSchedule: "0 9 * * *" })];
    expect(selectRunnable(pbs, "ml-1", enabled, {}).map((p) => p.name)).toEqual(["b"]);
  });
});

describe("selectRunnable — scope gating", () => {
  const owners = { soloA: "ml-1", soloB: "mac" };
  const enabled = new Set(["eachOn"]);
  test("each runs only when locally enabled", () => {
    const pbs = [pb({ name: "eachOn", scope: "each" }), pb({ name: "eachOff", scope: "each" })];
    expect(selectRunnable(pbs, "ml-1", enabled, owners).map((p) => p.name)).toEqual(["eachOn"]);
  });
  test("single runs only on its owner, ignoring local enable state", () => {
    const pbs = [pb({ name: "soloA", scope: "single" }), pb({ name: "soloB", scope: "single" })];
    expect(selectRunnable(pbs, "ml-1", enabled, owners).map((p) => p.name)).toEqual(["soloA"]);
  });
  test("single with no owner runs nowhere", () => {
    const pbs = [pb({ name: "orphan", scope: "single" })];
    expect(selectRunnable(pbs, "ml-1", new Set(), {})).toEqual([]);
  });
  test("a single job NOT owned by this host is excluded even if enabled", () => {
    const pbs = [pb({ name: "soloB", scope: "single" })];
    expect(selectRunnable(pbs, "ml-1", new Set(["soloB"]), owners)).toEqual([]);
  });
  test("status/blank-schedule gating still applies to each", () => {
    const pbs = [
      pb({ name: "draft", scope: "each", isActive: false }),
      pb({ name: "blank", scope: "each", cronSchedule: "  " }),
      pb({ name: "ok", scope: "each" }),
    ];
    expect(selectRunnable(pbs, "ml-1", new Set(["draft","blank","ok"]), {}).map((p) => p.name)).toEqual(["ok"]);
  });

  test("Job.hosts is NOT a runtime gate — a job whose hosts excludes this host still runs when enabled/owned (#12)", () => {
    // each-scope enabled here, hosts names only another host → still runs (enabled set gates, not hosts).
    const eachElsewhere = pb({ name: "eachElsewhere", scope: "each", hosts: ["other-host"] });
    expect(selectRunnable([eachElsewhere], "ml-1", new Set(["eachElsewhere"]), {}).map((p) => p.name)).toEqual(["eachElsewhere"]);
    // single-scope owned here, hosts names only another host → still runs (owners gates, not hosts).
    const singleElsewhere = pb({ name: "singleElsewhere", scope: "single", hosts: ["other-host"] });
    expect(selectRunnable([singleElsewhere], "ml-1", new Set(), { singleElsewhere: "ml-1" }).map((p) => p.name)).toEqual(["singleElsewhere"]);
  });
});

describe("dueAt — minute-granular fire set", () => {
  test("returns only jobs firing during the given minute", () => {
    const pbs = [
      pb({ name: "nine", cronSchedule: "0 9 * * *" }),
      pb({ name: "every15", cronSchedule: "*/15 * * * *" }),
      pb({ name: "noon", cronSchedule: "0 12 * * *" }),
    ];
    expect(dueAt(pbs, d("2026-06-01T09:00:00Z"), m).map((p) => p.name)).toEqual(["nine", "every15"]);
  });

  test("fires regardless of the seconds component (minute granularity)", () => {
    expect(dueAt([pb({ cronSchedule: "0 9 * * *" })], d("2026-06-01T09:00:43Z"), m)).toHaveLength(1);
  });

  test("a job with an invalid schedule is silently skipped, not crashing the tick", () => {
    const pbs = [pb({ name: "bad", cronSchedule: "not a cron" }), pb({ name: "ok", cronSchedule: "0 9 * * *" })];
    expect(dueAt(pbs, d("2026-06-01T09:00:00Z"), m).map((p) => p.name)).toEqual(["ok"]);
  });
});

describe("nextWake — ms until the soonest next fire, capped", () => {
  const CAP = 60_000;

  test("sleeps exactly until the soonest next-fire when under the cap", () => {
    const pbs = [pb({ cronSchedule: "*/5 * * * *" })];
    // from 12:00:00 → next */5 fire is 12:05:00 → 300_000ms, capped at 60_000.
    expect(nextWake(pbs, d("2026-06-01T12:00:00Z"), m, CAP)).toBe(CAP);
    // from 12:04:00 → next fire 12:05:00 → 60_000ms, exactly the cap boundary.
    expect(nextWake(pbs, d("2026-06-01T12:04:00Z"), m, CAP)).toBe(60_000);
    // from 12:04:30 → next fire 12:05:00 → 30_000ms, under the cap.
    expect(nextWake(pbs, d("2026-06-01T12:04:30Z"), m, CAP)).toBe(30_000);
  });

  test("takes the minimum across all jobs", () => {
    const pbs = [pb({ name: "hourly", cronSchedule: "0 * * * *" }), pb({ name: "soon", cronSchedule: "*/5 * * * *" })];
    // from 12:01:00 → hourly fires 13:00 (3540s), */5 fires 12:05 (240s) → 240_000, capped to 60_000.
    expect(nextWake(pbs, d("2026-06-01T12:01:00Z"), m, CAP)).toBe(CAP);
    // from 12:04:10 → */5 fires 12:05:00 → 50_000ms (< cap), wins over hourly.
    expect(nextWake(pbs, d("2026-06-01T12:04:10Z"), m, CAP)).toBe(50_000);
  });

  test("falls back to the cap when nothing is scheduled (or all never-fire)", () => {
    expect(nextWake([], d("2026-06-01T12:00:00Z"), m, CAP)).toBe(CAP);
    expect(nextWake([pb({ cronSchedule: "0 0 30 2 *" })], d("2026-06-01T12:00:00Z"), m, CAP)).toBe(CAP);
  });

  test("ignores invalid schedules rather than throwing", () => {
    const pbs = [pb({ name: "bad", cronSchedule: "99 * * * *" }), pb({ name: "ok", cronSchedule: "*/5 * * * *" })];
    expect(nextWake(pbs, d("2026-06-01T12:04:30Z"), m, CAP)).toBe(30_000);
  });
});
