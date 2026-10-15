import { describe, expect, test } from "bun:test";
import { createMatcher, CronExpressionError } from "../src/core/cron";

// All tests pin an explicit UTC timezone so they are deterministic regardless
// of the CI/host timezone. The DST/tz section uses named zones on purpose.
const m = createMatcher({ timezone: "UTC" });

const d = (iso: string) => new Date(iso);

// Collect every fire strictly after `start` and at-or-before `end`.
function firesBetween(expr: string, start: Date, end: Date): Date[] {
  const out: Date[] = [];
  let cur = start;
  // Hard cap to fail loudly rather than hang if nextFire ever stalls.
  for (let i = 0; i < 10000; i++) {
    const next = m.nextFire(expr, cur);
    if (next === null || next.getTime() > end.getTime()) break;
    out.push(next);
    cur = next;
  }
  return out;
}

describe("nextFire — wildcards, ranges, lists, steps", () => {
  test("every-minute fires at the next minute boundary", () => {
    expect(m.nextFire("* * * * *", d("2026-06-01T12:00:30Z"))).toEqual(d("2026-06-01T12:01:00Z"));
  });

  test("nextFire is strictly after `from` (a fire minute returns the NEXT one)", () => {
    expect(m.nextFire("* * * * *", d("2026-06-01T12:00:00Z"))).toEqual(d("2026-06-01T12:01:00Z"));
    expect(m.nextFire("30 9 * * *", d("2026-06-01T09:30:00Z"))).toEqual(d("2026-06-02T09:30:00Z"));
  });

  test("specific minute+hour", () => {
    expect(m.nextFire("30 9 * * *", d("2026-06-01T00:00:00Z"))).toEqual(d("2026-06-01T09:30:00Z"));
    expect(m.nextFire("30 9 * * *", d("2026-06-01T10:00:00Z"))).toEqual(d("2026-06-02T09:30:00Z"));
  });

  test("hour range 9-17", () => {
    const fires = firesBetween("0 9-17 * * *", d("2026-06-01T00:00:00Z"), d("2026-06-01T23:59:00Z"));
    expect(fires).toEqual([
      d("2026-06-01T09:00:00Z"), d("2026-06-01T10:00:00Z"), d("2026-06-01T11:00:00Z"),
      d("2026-06-01T12:00:00Z"), d("2026-06-01T13:00:00Z"), d("2026-06-01T14:00:00Z"),
      d("2026-06-01T15:00:00Z"), d("2026-06-01T16:00:00Z"), d("2026-06-01T17:00:00Z"),
    ]);
  });

  test("hour list 9,12,17", () => {
    const fires = firesBetween("0 9,12,17 * * *", d("2026-06-01T00:00:00Z"), d("2026-06-01T23:59:00Z"));
    expect(fires).toEqual([
      d("2026-06-01T09:00:00Z"), d("2026-06-01T12:00:00Z"), d("2026-06-01T17:00:00Z"),
    ]);
  });

  test("minute step */15", () => {
    const fires = firesBetween("*/15 * * * *", d("2026-06-01T12:00:00Z"), d("2026-06-01T12:59:00Z"));
    expect(fires).toEqual([
      d("2026-06-01T12:15:00Z"), d("2026-06-01T12:30:00Z"), d("2026-06-01T12:45:00Z"),
    ]);
  });

  test("step within a range 0-12/3 (hours)", () => {
    // Start 1ms before midnight so the 00:00 fire (a valid 0-12/3 occurrence)
    // is included — firesBetween returns fires strictly AFTER its start.
    const fires = firesBetween("0 0-12/3 * * *", d("2026-05-31T23:59:59Z"), d("2026-06-01T23:59:00Z"));
    expect(fires).toEqual([
      d("2026-06-01T00:00:00Z"), d("2026-06-01T03:00:00Z"), d("2026-06-01T06:00:00Z"),
      d("2026-06-01T09:00:00Z"), d("2026-06-01T12:00:00Z"),
    ]);
  });

  test("month field restricts to January", () => {
    expect(m.nextFire("0 0 1 1 *", d("2026-02-01T00:00:00Z"))).toEqual(d("2027-01-01T00:00:00Z"));
  });
});

describe("day-of-month vs day-of-week semantics (Vixie OR)", () => {
  // 2026-01-13 is a Tuesday (the 13th, not Friday).
  // 2026-01-16 is a Friday (the 16th, not the 13th).
  // 2026-01-20 is a Tuesday (neither the 13th nor a Friday).
  test("both DOM and DOW restricted → fires if EITHER matches", () => {
    expect(m.matchesAt("0 0 13 * 5", d("2026-01-13T00:00:00Z"))).toBe(true);  // 13th (DOM)
    expect(m.matchesAt("0 0 13 * 5", d("2026-01-16T00:00:00Z"))).toBe(true);  // Friday (DOW)
    expect(m.matchesAt("0 0 13 * 5", d("2026-01-20T00:00:00Z"))).toBe(false); // neither
  });

  test("DOM restricted, DOW wildcard → only the 13th", () => {
    expect(m.matchesAt("0 0 13 * *", d("2026-01-13T00:00:00Z"))).toBe(true);
    expect(m.matchesAt("0 0 13 * *", d("2026-01-16T00:00:00Z"))).toBe(false); // Friday but not 13th
  });

  test("DOW restricted, DOM wildcard → only Fridays", () => {
    expect(m.matchesAt("0 0 * * 5", d("2026-01-16T00:00:00Z"))).toBe(true);
    expect(m.matchesAt("0 0 * * 5", d("2026-01-13T00:00:00Z"))).toBe(false); // 13th but Tuesday
  });
});

describe("matchesAt — minute granularity, ignores seconds", () => {
  test("true exactly on the fire minute", () => {
    expect(m.matchesAt("30 9 * * *", d("2026-06-01T09:30:00Z"))).toBe(true);
  });
  test("ignores the seconds component", () => {
    expect(m.matchesAt("30 9 * * *", d("2026-06-01T09:30:59Z"))).toBe(true);
  });
  test("false on a non-fire minute", () => {
    expect(m.matchesAt("30 9 * * *", d("2026-06-01T09:31:00Z"))).toBe(false);
    expect(m.matchesAt("30 9 * * *", d("2026-06-01T08:30:00Z"))).toBe(false);
  });
});

describe("invalid expressions", () => {
  test("nextFire throws CronExpressionError", () => {
    expect(() => m.nextFire("not a cron", d("2026-06-01T00:00:00Z"))).toThrow(CronExpressionError);
    expect(() => m.nextFire("99 * * * *", d("2026-06-01T00:00:00Z"))).toThrow(CronExpressionError);
  });
  test("matchesAt throws CronExpressionError", () => {
    expect(() => m.matchesAt("60 * * * *", d("2026-06-01T00:00:00Z"))).toThrow(CronExpressionError);
  });
  test("wrong field count is rejected (5-field only)", () => {
    expect(() => m.nextFire("* * * *", d("2026-06-01T00:00:00Z"))).toThrow(CronExpressionError);
  });

  // croner ACCEPTS the 6-field seconds form; the length guard is the only thing
  // rejecting it. Without the guard "* * * * * *" fires every second, breaking
  // the daemon's (and matchesAt's) minute-granularity contract. This is the
  // guard's sole unique coverage — every other invalid input croner throws on.
  test("6-field seconds form is rejected (minute granularity only)", () => {
    expect(() => m.nextFire("* * * * * *", d("2026-06-01T00:00:00Z"))).toThrow(CronExpressionError);
    expect(() => m.matchesAt("* * * * * *", d("2026-06-01T00:00:00Z"))).toThrow(CronExpressionError);
  });
});

describe("never-fires", () => {
  // Feb 30 is a valid expression that can never match → null (the daemon treats
  // this as "no next fire," not an error). Pins the Date|null return contract.
  test("nextFire returns null for an unsatisfiable schedule", () => {
    expect(m.nextFire("0 0 30 2 *", d("2026-06-01T00:00:00Z"))).toBeNull();
  });
});

describe("timezone handling", () => {
  test("the same expression fires at a different UTC instant per timezone", () => {
    const utc = createMatcher({ timezone: "UTC" });
    const ny = createMatcher({ timezone: "America/New_York" });
    const from = d("2026-06-01T00:00:00Z"); // EDT (UTC-4) in June
    expect(utc.nextFire("0 12 * * *", from)).toEqual(d("2026-06-01T12:00:00Z"));
    expect(ny.nextFire("0 12 * * *", from)).toEqual(d("2026-06-01T16:00:00Z")); // 12:00 EDT
  });

  test("default matcher (no timezone) still produces monotonic fires", () => {
    const local = createMatcher();
    const a = local.nextFire("*/5 * * * *", d("2026-06-01T00:00:00Z"));
    expect(a).not.toBeNull();
    const b = local.nextFire("*/5 * * * *", a!);
    expect(b!.getTime()).toBeGreaterThan(a!.getTime());
  });
});

describe("DST transitions stay monotonic (no gap stall, no fall-back replay)", () => {
  const ny = createMatcher({ timezone: "America/New_York" });

  // Spring forward: 2026-03-08, clocks jump 02:00 → 03:00 in America/New_York.
  test("hourly schedule advances strictly through the spring-forward gap", () => {
    let cur = d("2026-03-08T04:00:00Z"); // 23:00 EST the night before
    let prev = cur.getTime();
    for (let i = 0; i < 12; i++) {
      const next = ny.nextFire("0 * * * *", cur);
      expect(next).not.toBeNull();
      expect(next!.getTime()).toBeGreaterThan(prev);
      prev = next!.getTime();
      cur = next!;
    }
  });

  // Fall back: 2026-11-01, clocks repeat 01:00 → 01:59 twice in America/New_York.
  test("hourly schedule does not stall or rewind across the fall-back overlap", () => {
    let cur = d("2026-11-01T04:00:00Z"); // 00:00 EDT
    let prev = cur.getTime();
    for (let i = 0; i < 12; i++) {
      const next = ny.nextFire("0 * * * *", cur);
      expect(next).not.toBeNull();
      expect(next!.getTime()).toBeGreaterThan(prev);
      prev = next!.getTime();
      cur = next!;
    }
  });

  // Exact wall-clock policy (pins croner's gap/overlap contract — a croner
  // upgrade that changed it must break here, not silently in the daemon).
  test("spring-forward: a 02:00 schedule shifts to 03:00 EDT (does not skip the day)", () => {
    // 2026-03-08 02:00 EST does not exist; croner fires at 03:00 EDT = 07:00Z.
    expect(ny.nextFire("0 2 * * *", d("2026-03-07T12:00:00Z"))).toEqual(d("2026-03-08T07:00:00Z"));
  });

  test("fall-back: a 01:30 schedule fires once, at the first (EDT) occurrence", () => {
    // 2026-11-01 01:30 happens twice; croner fires at 01:30 EDT = 05:30Z (not 06:30Z EST).
    expect(ny.nextFire("30 1 * * *", d("2026-10-31T12:00:00Z"))).toEqual(d("2026-11-01T05:30:00Z"));
  });

  test("fall-back: nextFire from inside the repeated hour is still strictly after `from`", () => {
    for (let ms = d("2026-11-01T06:00:00Z").getTime(); ms < d("2026-11-01T07:00:00Z").getTime(); ms += 60_000) {
      const from = new Date(ms);
      const next = ny.nextFire("* * * * *", from);
      expect(next).not.toBeNull();
      expect(next!.getTime()).toBeGreaterThan(ms);
    }
    expect(ny.nextFire("* * * * *", d("2026-11-01T06:10:00Z"))).toEqual(d("2026-11-01T07:00:00Z"));
    expect(ny.nextFire("30 1 * * *", d("2026-11-01T06:00:00Z"))).toEqual(d("2026-11-02T06:30:00Z"));
  });

  const london = createMatcher({ timezone: "Europe/London" });

  test("fall-back (east of UTC): a 01:30 schedule fires once, at the first (BST) occurrence", () => {
    // 2026-10-25 01:30 happens twice; fires at 01:30 BST = 00:30Z (not 01:30Z GMT).
    expect(london.nextFire("30 1 * * *", d("2026-10-24T12:00:00Z"))).toEqual(d("2026-10-25T00:30:00Z"));
  });

  test("fall-back (east of UTC): every-minute schedule steps through first occurrence and skips second", () => {
    // Stepping from 2026-10-24T23:59Z visits 00:00Z (01:00 BST), not 01:00Z (GMT).
    expect(london.nextFire("* * * * *", d("2026-10-24T23:59:00Z"))).toEqual(d("2026-10-25T00:00:00Z"));
    // At the end of the first occurrence, it skips the second occurrence (01:00Z-01:59Z) and lands on 02:00Z.
    expect(london.nextFire("* * * * *", d("2026-10-25T00:59:00Z"))).toEqual(d("2026-10-25T02:00:00Z"));
  });

  test("fall-back (east of UTC): nextFire from inside the repeated hour is still strictly after `from`", () => {
    for (let ms = d("2026-10-25T01:00:00Z").getTime(); ms < d("2026-10-25T02:00:00Z").getTime(); ms += 60_000) {
      const from = new Date(ms);
      const next = london.nextFire("* * * * *", from);
      expect(next).not.toBeNull();
      expect(next!.getTime()).toBeGreaterThan(ms);
    }
    expect(london.nextFire("* * * * *", d("2026-10-25T01:10:00Z"))).toEqual(d("2026-10-25T02:00:00Z"));
    expect(london.nextFire("30 1 * * *", d("2026-10-25T01:00:00Z"))).toEqual(d("2026-10-26T01:30:00Z"));
  });

  test("fall-back with a 30-minute overlap (Australia/Lord_Howe) fires at the first occurrence", () => {
    // 2026-04-05 02:00 +11 → 01:30 +10:30; 01:30 local fires at +11 = 14:30Z (not 15:00Z).
    const lordHowe = createMatcher({ timezone: "Australia/Lord_Howe" });
    expect(lordHowe.nextFire("30 1 * * *", d("2026-04-04T12:00:00Z"))).toEqual(d("2026-04-04T14:30:00Z"));
    expect(lordHowe.matchesAt("30 1 * * *", d("2026-04-04T14:30:00Z"))).toBe(true);
    expect(lordHowe.matchesAt("30 1 * * *", d("2026-04-04T15:00:00Z"))).toBe(false);
  });

  test("fall-back with a 2-hour overlap (Antarctica/Troll) fires at the first occurrence", () => {
    // 2026-10-25 03:00 +02 → 01:00 +00; 01:30 local fires at +02 = 23:30Z the day before (not 01:30Z).
    const troll = createMatcher({ timezone: "Antarctica/Troll" });
    expect(troll.nextFire("30 1 * * *", d("2026-10-24T12:00:00Z"))).toEqual(d("2026-10-24T23:30:00Z"));
    expect(troll.matchesAt("30 1 * * *", d("2026-10-24T23:30:00Z"))).toBe(true);
    expect(troll.matchesAt("30 1 * * *", d("2026-10-25T01:30:00Z"))).toBe(false);
  });

  test("fall-back with a 3-hour overlap (Antarctica/Casey) fires at the first occurrence", () => {
    // 2023-03-09 03:00 +11 → 00:00 +08; 01:30 local fires at +11 = 2023-03-08T14:30:00Z (not 17:30:00Z).
    const casey = createMatcher({ timezone: "Antarctica/Casey" });
    expect(casey.nextFire("30 1 * * *", d("2023-03-08T12:00:00Z"))).toEqual(d("2023-03-08T14:30:00Z"));
    expect(casey.matchesAt("30 1 * * *", d("2023-03-08T14:30:00Z"))).toBe(true);
    expect(casey.matchesAt("30 1 * * *", d("2023-03-08T17:30:00Z"))).toBe(false);
  });

  test("fall-back with a 3-hour overlap (Antarctica/Casey): every-minute schedule skips the second occurrence", () => {
    const casey = createMatcher({ timezone: "Antarctica/Casey" });
    expect(casey.nextFire("* * * * *", d("2023-03-08T15:59:00Z"))).toEqual(d("2023-03-08T19:00:00Z"));
    expect(casey.nextFire("* * * * *", d("2023-03-08T17:00:00Z"))).toEqual(d("2023-03-08T19:00:00Z"));
    // Starting at the transition instant needs 180 probes; a cap of 179 or less throws.
    expect(casey.nextFire("* * * * *", d("2023-03-08T16:00:00Z"))).toEqual(d("2023-03-08T19:00:00Z"));
  });

  test("fall-back with a 3-hour overlap (Antarctica/Casey): instants after the overlap are not rewritten", () => {
    const casey = createMatcher({ timezone: "Antarctica/Casey" });
    expect(casey.matchesAt("0 4 * * *", d("2023-03-08T20:00:00Z"))).toBe(true);
    expect(casey.nextFire("0 4 * * *", d("2023-03-08T19:30:00Z"))).toEqual(d("2023-03-08T20:00:00Z"));
  });

  test("fall-back: matchesAt returns true for first occurrence and false for second across zones", () => {
    // West of UTC (America/New_York)
    expect(ny.matchesAt("30 1 * * *", d("2026-11-01T05:30:00Z"))).toBe(true);  // first (EDT)
    expect(ny.matchesAt("30 1 * * *", d("2026-11-01T06:30:00Z"))).toBe(false); // second (EST) — fire-once

    // East of UTC (Europe/London)
    expect(london.matchesAt("30 1 * * *", d("2026-10-25T00:30:00Z"))).toBe(true);  // first (BST)
    expect(london.matchesAt("30 1 * * *", d("2026-10-25T01:30:00Z"))).toBe(false); // second (GMT) — fire-once
  });

  test("fall-back: sub-hourly schedules fire in both occurrences", () => {
    // West of UTC (America/New_York): 06:00Z-06:59Z is the second (EST) 01:00-01:59.
    expect(ny.matchesAt("* * * * *", d("2026-11-01T05:30:00Z"))).toBe(true);  // first occurrence
    expect(ny.matchesAt("* * * * *", d("2026-11-01T06:30:00Z"))).toBe(true);  // second occurrence — real-time

    // Step schedule: */10 fires at :00 :10 :20 :30 :40 :50 in both occurrences.
    expect(ny.matchesAt("*/10 * * * *", d("2026-11-01T06:00:00Z"))).toBe(true);  // 01:00 EST
    expect(ny.matchesAt("*/10 * * * *", d("2026-11-01T06:30:00Z"))).toBe(true);  // 01:30 EST
    expect(ny.matchesAt("*/10 * * * *", d("2026-11-01T06:35:00Z"))).toBe(false); // 01:35 EST — not a */10 slot

    // East of UTC (Europe/London): 01:00Z-01:59Z is the second (GMT) 01:00-01:59.
    expect(london.matchesAt("* * * * *", d("2026-10-25T00:30:00Z"))).toBe(true); // first occurrence
    expect(london.matchesAt("* * * * *", d("2026-10-25T01:30:00Z"))).toBe(true); // second occurrence — real-time
  });

  test("fall-back: fixed-minute and hour-restricted schedules stay fire-once in the second occurrence", () => {
    expect(ny.matchesAt("0 * * * *", d("2026-11-01T06:00:00Z"))).toBe(false);
    expect(ny.matchesAt("30 * * * *", d("2026-11-01T06:30:00Z"))).toBe(false);
    expect(ny.matchesAt("*/10 1 * * *", d("2026-11-01T06:30:00Z"))).toBe(false);
    expect(ny.matchesAt("*/10 1 * * *", d("2026-11-01T05:30:00Z"))).toBe(true);
  });

  test("fall-back: a comma-list minute counts as sub-hourly", () => {
    expect(ny.matchesAt("0,30 * * * *", d("2026-11-01T06:00:00Z"))).toBe(true);
    expect(ny.matchesAt("0,30 * * * *", d("2026-11-01T06:30:00Z"))).toBe(true);
    expect(ny.matchesAt("0,30 * * * *", d("2026-11-01T06:15:00Z"))).toBe(false);
  });

  test("fall-back: sub-hourly range respects the minute bounds and the overlap edges", () => {
    expect(ny.matchesAt("30-35 * * * *", d("2026-11-01T06:35:00Z"))).toBe(true);
    expect(ny.matchesAt("30-35 * * * *", d("2026-11-01T06:36:00Z"))).toBe(false);
    expect(ny.matchesAt("* * * * *", d("2026-11-01T06:00:00Z"))).toBe(true);
    expect(ny.matchesAt("* * * * *", d("2026-11-01T06:59:00Z"))).toBe(true);
    expect(ny.matchesAt("* * * * *", d("2026-11-01T07:00:00Z"))).toBe(true);
  });

  test("fall-back: sub-hourly schedules fire in the second occurrence for 30-minute, 2-hour, and 3-hour overlaps", () => {
    const lordHowe = createMatcher({ timezone: "Australia/Lord_Howe" });
    expect(lordHowe.matchesAt("* * * * *", d("2026-04-04T15:10:00Z"))).toBe(true);
    const troll = createMatcher({ timezone: "Antarctica/Troll" });
    expect(troll.matchesAt("*/10 * * * *", d("2026-10-25T01:30:00Z"))).toBe(true);
    expect(troll.matchesAt("*/10 * * * *", d("2026-10-25T01:35:00Z"))).toBe(false);
    const casey = createMatcher({ timezone: "Antarctica/Casey" });
    expect(casey.matchesAt("*/10 * * * *", d("2023-03-08T14:30:00Z"))).toBe(true);
    expect(casey.matchesAt("*/10 * * * *", d("2023-03-08T17:30:00Z"))).toBe(true);
    expect(casey.matchesAt("*/10 * * * *", d("2023-03-08T17:35:00Z"))).toBe(false);
  });
});
