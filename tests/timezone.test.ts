import { describe, expect, test } from "bun:test";
import { createMatcher, matcherForJob, assertValidTimezone, InvalidTimezoneError, simulateSchedule, computeStatus, dueAt, nextWake, type Job } from "../src/core/index";

const d = (iso: string) => new Date(iso);
const defaultMatcher = createMatcher({ timezone: "UTC" });
const mf = (job: Job<unknown>) => matcherForJob(job, defaultMatcher);

const pb = (over: Partial<Job<unknown>>): Job<unknown> => ({
  name: "p",
  cronSchedule: "0 9 * * *",
  isActive: true,
  hosts: ["*"],
  scope: "each",
  metadata: {},
  ...over,
});

describe("matcherForJob", () => {
  test("returns the default matcher when the job has no timezone", () => {
    expect(matcherForJob(pb({ name: "plain" }), defaultMatcher)).toBe(defaultMatcher);
  });

  test("returns a timezone-aware matcher when the job declares a timezone", () => {
    const job = pb({ name: "ny", timezone: "America/New_York" });
    const m = matcherForJob(job, defaultMatcher);
    expect(m).not.toBe(defaultMatcher);
    // America/New_York is UTC-4 in June (EDT). 9:00 local = 13:00 UTC.
    const nf = m.nextFire("0 9 * * *", d("2026-06-01T00:00:00Z"));
    expect(nf!.toISOString()).toBe("2026-06-01T13:00:00.000Z");
  });

  test("caches: same timezone returns the same matcher instance", () => {
    const job1 = pb({ name: "a", timezone: "Europe/Berlin" });
    const job2 = pb({ name: "b", timezone: "Europe/Berlin" });
    expect(matcherForJob(job1, defaultMatcher)).toBe(matcherForJob(job2, defaultMatcher));
  });
});

describe("assertValidTimezone", () => {
  test("accepts valid IANA identifiers", () => {
    expect(() => assertValidTimezone("America/New_York")).not.toThrow();
    expect(() => assertValidTimezone("UTC")).not.toThrow();
    expect(() => assertValidTimezone("Asia/Tokyo")).not.toThrow();
  });

  test("rejects invalid identifiers with InvalidTimezoneError", () => {
    expect(() => assertValidTimezone("Mars/Olympus_Mons")).toThrow(InvalidTimezoneError);
  });
});

describe("mixed-timezone registry — simulate", () => {
  test("jobs in different timezones fire at their local time", () => {
    // "ny" fires at 9:00 America/New_York (EDT = UTC-4) → 13:00 UTC
    // "tokyo" fires at 9:00 Asia/Tokyo (JST = UTC+9) → 00:00 UTC
    const report = simulateSchedule({
      from: d("2026-06-15T00:00:00Z"),
      to: d("2026-06-15T23:59:00Z"),
      host: "ml-1",
      jobs: [
        pb({ name: "ny", cronSchedule: "0 9 * * *", timezone: "America/New_York" }),
        pb({ name: "tokyo", cronSchedule: "0 9 * * *", timezone: "Asia/Tokyo" }),
        pb({ name: "utc", cronSchedule: "0 9 * * *" }), // no timezone → UTC
      ],
      enabled: new Set(["ny", "tokyo", "utc"]),
      owners: {},
      matcher: defaultMatcher,
    });

    const byJob = new Map(report.dispatches.map((x) => [x.job, x.timeIso]));
    // 9:00 JST = 00:00 UTC
    expect(byJob.get("tokyo")).toBe("2026-06-15T00:00:00.000Z");
    // 9:00 UTC
    expect(byJob.get("utc")).toBe("2026-06-15T09:00:00.000Z");
    // 9:00 EDT (UTC-4) = 13:00 UTC
    expect(byJob.get("ny")).toBe("2026-06-15T13:00:00.000Z");

    // All three fired exactly once
    expect(report.dispatches.length).toBe(3);
  });

  test("chronological ordering is correct across timezones", () => {
    const report = simulateSchedule({
      from: d("2026-06-15T00:00:00Z"),
      to: d("2026-06-15T23:59:00Z"),
      host: "ml-1",
      jobs: [
        pb({ name: "ny", cronSchedule: "0 9 * * *", timezone: "America/New_York" }),
        pb({ name: "tokyo", cronSchedule: "0 9 * * *", timezone: "Asia/Tokyo" }),
        pb({ name: "utc", cronSchedule: "0 9 * * *" }),
      ],
      enabled: new Set(["ny", "tokyo", "utc"]),
      owners: {},
      matcher: defaultMatcher,
    });

    // tokyo (00:00Z) < utc (09:00Z) < ny (13:00Z)
    expect(report.dispatches.map((x) => x.job)).toEqual(["tokyo", "utc", "ny"]);
  });
});

describe("mixed-timezone registry — dueAt / nextWake", () => {
  test("dueAt respects per-job timezone", () => {
    const jobs = [
      pb({ name: "ny", cronSchedule: "0 9 * * *", timezone: "America/New_York" }),
      pb({ name: "utc", cronSchedule: "0 9 * * *" }),
    ];
    // At 13:00 UTC, the "ny" job (9:00 EDT) is due but "utc" (9:00 UTC) is not
    const dueNy = dueAt(jobs, d("2026-06-15T13:00:00Z"), mf);
    expect(dueNy.map((x) => x.name)).toEqual(["ny"]);

    // At 09:00 UTC, the "utc" job is due but "ny" (9:00 EDT = 13:00 UTC) is not
    const dueUtc = dueAt(jobs, d("2026-06-15T09:00:00Z"), mf);
    expect(dueUtc.map((x) => x.name)).toEqual(["utc"]);
  });

  test("nextWake respects per-job timezone", () => {
    const jobs = [
      pb({ name: "ny", cronSchedule: "0 9 * * *", timezone: "America/New_York" }),
      pb({ name: "utc", cronSchedule: "0 9 * * *" }),
    ];
    // From 08:00 UTC: utc fires at 09:00 UTC (1h), ny fires at 13:00 UTC (5h)
    // nextWake should return 1h in ms (the soonest)
    const wake = nextWake(jobs, d("2026-06-15T08:00:00Z"), mf, 3600_000 * 12);
    expect(wake).toBe(3_600_000); // 1 hour

    // From 09:30 UTC: utc already fired (9:00 UTC), next fire tomorrow 09:00 (23.5h)
    // ny fires at 13:00 UTC (3.5h) → soonest
    const wake2 = nextWake(jobs, d("2026-06-15T09:30:00Z"), mf, 3600_000 * 48);
    expect(wake2).toBe(12_600_000); // 3.5 hours (to ny at 13:00 UTC)
  });
});

describe("mixed-timezone registry — computeStatus", () => {
  test("nextFire reflects the job's timezone", () => {
    const job = pb({ name: "ny", cronSchedule: "0 9 * * *", timezone: "America/New_York" });
    const report = computeStatus({
      jobs: [job],
      host: "ml-1",
      enabled: new Set(["ny"]),
      owners: {},
      heartbeat: null,
      matcherFor: mf,
      now: d("2026-06-15T00:00:00Z"),
      options: { staleGraceMs: 3_600_000, daemonHeartbeatStaleMs: 3_600_000 },
    });
    // 9:00 EDT = 13:00 UTC
    expect(report.jobs[0]!.nextFire).toBe(Date.parse("2026-06-15T13:00:00Z"));
  });
});
