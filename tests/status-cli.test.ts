import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStatusCommand, type StatusCliDeps } from "../src/cli/index";

const dir = mkdtempSync(join(tmpdir(), "cronbird-status-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const registryPath = join(dir, "registry.json");
const enabledPath = join(dir, "enabled.json");
const heartbeatPath = join(dir, "heartbeat.json");
const configPath = join(dir, "config.json");

const NOW = new Date("2026-07-01T12:00:00.000Z");
const NOW_MS = NOW.getTime();

beforeAll(() => {
  writeFileSync(
    registryPath,
    JSON.stringify({
      jobs: [
        { name: "alpha", cronSchedule: "0 * * * *", isActive: true, hosts: ["*"], scope: "each", metadata: {} },
        { name: "bravo", cronSchedule: "0 6 * * *", isActive: true, hosts: ["*"], scope: "each", metadata: {} },
        { name: "off", cronSchedule: "0 * * * *", isActive: false, hosts: ["*"], scope: "each", metadata: {} },
      ],
    }),
  );
  writeFileSync(enabledPath, JSON.stringify(["alpha", "bravo", "off"]));
  writeFileSync(
    heartbeatPath,
    JSON.stringify({
      ts: NOW_MS - 20_000,
      host: "ml-1",
      dispatched_minute: {},
      last_fired: { alpha: NOW_MS }, // alpha fired at 12:00Z; bravo never fired
    }),
  );
  writeFileSync(
    configPath,
    JSON.stringify({
      hostname: "ml-1",
      registryPath,
      enabledPath,
      topologyPath: null,
      heartbeatPath,
      syncedHeartbeatDir: null,
      dispatchCommand: ["./run.sh"],
      dispatchArgsTemplate: ["{job}"],
      maxSleepMs: 60_000,
      catchupLookbackFloorMs: 3_600_000,
      catchupLookbackCapMs: 21_600_000,
    }),
  );
});

function run(sub: "status" | "list" | "next-runs", args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: StatusCliDeps = {
    now: () => NOW,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    env: {},
  };
  const code = runStatusCommand(sub, [configPath, ...args], deps);
  return { code, out: out.join(""), err: err.join("") };
}

describe("list", () => {
  test("lists all jobs with runnable flag, exit 0", () => {
    const { code, out } = run("list", []);
    expect(code).toBe(0);
    expect(out).toContain("alpha");
    expect(out).toContain("bravo");
    expect(out).toContain("off");
    // inactive job's ACTIVE + RUNNABLE columns are both "no" (last two tokens)
    const offLine = out.split("\n").find((l) => l.startsWith("off"))!;
    expect(offLine.trim().split(/\s+/).slice(-2)).toEqual(["no", "no"]);
  });

  test("--json emits a parseable jobs array", () => {
    const { code, out } = run("list", ["--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed.jobs)).toBe(true);
    expect(parsed.jobs.map((j: { name: string }) => j.name).sort()).toEqual(["alpha", "bravo", "off"]);
  });
});

describe("next-runs", () => {
  test("sorted ascending by next fire, only runnable jobs with a next fire", () => {
    const { code, out } = run("next-runs", []);
    expect(code).toBe(0);
    // alpha next fires 13:00Z, bravo next fires tomorrow 06:00Z → alpha before bravo
    expect(out.indexOf("alpha")).toBeLessThan(out.indexOf("bravo"));
    // inactive 'off' is not runnable → excluded
    expect(out).not.toContain("off");
  });

  test("--within filters to the window", () => {
    // 2h window: alpha (in 1h) included, bravo (tomorrow) excluded
    const { code, out } = run("next-runs", ["--within", "2h"]);
    expect(code).toBe(0);
    expect(out).toContain("alpha");
    expect(out).not.toContain("bravo");
  });

  test("invalid --within duration → exit 2", () => {
    const { code, err } = run("next-runs", ["--within", "banana"]);
    expect(code).toBe(2);
    expect(err).toContain("--within");
  });

  test("--json emits parseable output", () => {
    const { code, out } = run("next-runs", ["--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed.nextRuns)).toBe(true);
    expect(parsed.nextRuns[0].name).toBe("alpha");
  });
});

describe("status", () => {
  test("reports health per job and the daemon heartbeat age", () => {
    const { code, out } = run("status", []);
    expect(code).toBe(0);
    expect(out).toContain("alpha");
    expect(out).toContain("ok"); // alpha fired recently
    expect(out).toContain("never-fired"); // bravo
    expect(out).toContain("inactive"); // off
    // heartbeat 20s old
    expect(/heartbeat/i.test(out)).toBe(true);
  });

  test("--json includes the full report shape", () => {
    const { code, out } = run("status", ["--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.host).toBe("ml-1");
    expect(parsed.heartbeatAgeMs).toBe(20_000);
    expect(parsed.jobs.find((j: { name: string }) => j.name === "alpha").health).toBe("ok");
  });
});

// Fixtures built per-test so we can vary maxSleepMs, corrupt sidecars, etc.
function runWith(
  opts: {
    registry?: unknown | string;
    enabled?: unknown;
    topology?: unknown | string | null;
    heartbeat?: string; // omit → no heartbeat file written
    maxSleepMs?: number;
  },
  sub: "status" | "list" | "next-runs",
  args: string[] = [],
) {
  const d = mkdtempSync(join(tmpdir(), "cronbird-status-w-"));
  const reg = join(d, "registry.json");
  writeFileSync(reg, typeof opts.registry === "string" ? opts.registry : JSON.stringify(opts.registry ?? { jobs: [] }));
  const en = join(d, "enabled.json");
  writeFileSync(en, JSON.stringify(opts.enabled ?? []));
  let tp: string | null = null;
  if (opts.topology !== undefined) {
    tp = join(d, "topology.json");
    writeFileSync(tp, typeof opts.topology === "string" ? opts.topology : JSON.stringify(opts.topology));
  }
  const hbp = join(d, "hb.json");
  if (opts.heartbeat !== undefined) writeFileSync(hbp, opts.heartbeat);
  const cfg = join(d, "config.json");
  writeFileSync(
    cfg,
    JSON.stringify({
      hostname: "ml-1",
      registryPath: reg,
      enabledPath: en,
      topologyPath: tp,
      heartbeatPath: hbp,
      syncedHeartbeatDir: null,
      dispatchCommand: ["./run.sh"],
      dispatchArgsTemplate: ["{job}"],
      maxSleepMs: opts.maxSleepMs ?? 60_000,
      catchupLookbackFloorMs: 3_600_000,
      catchupLookbackCapMs: 21_600_000,
    }),
  );
  const out: string[] = [];
  const err: string[] = [];
  const code = runStatusCommand(sub, [cfg, ...args], { now: () => NOW, out: (s) => out.push(s), err: (s) => err.push(s), env: {} });
  rmSync(d, { recursive: true, force: true });
  return { code, out: out.join(""), err: err.join("") };
}

const everyMinute = (name: string) => ({
  name,
  cronSchedule: "* * * * *",
  isActive: true,
  hosts: ["*"],
  scope: "each",
  metadata: {},
});

describe("stale-grace wiring (staleGraceMs = 2 * maxSleepMs)", () => {
  // maxSleepMs 60s → grace 120s. Both jobs fire every minute; the next slot
  // after a fire is the following :00 boundary.
  // near: fired 90s ago (11:58:30) → next slot 11:59:00 = 60s overdue (< 120s grace) → ok.
  // past: fired 300s ago (11:55:00) → next slot 11:56:00 = 240s overdue (> 120s grace) → stale.
  const heartbeat = JSON.stringify({
    ts: NOW_MS - 10_000,
    host: "ml-1",
    dispatched_minute: {},
    last_fired: { near: NOW_MS - 90_000, past: NOW_MS - 300_000 },
  });
  const registry = { jobs: [everyMinute("near"), everyMinute("past")] };
  const enabled = ["near", "past"];

  test("overdue within 2x grace → ok; overdue past 2x grace → stale (pins the doubling)", () => {
    const { code, out } = runWith({ registry, enabled, heartbeat, maxSleepMs: 60_000 }, "status", ["--json"]);
    expect(code).toBe(0);
    const jobs = JSON.parse(out).jobs as { name: string; health: string }[];
    expect(jobs.find((j) => j.name === "near")!.health).toBe("ok");
    expect(jobs.find((j) => j.name === "past")!.health).toBe("stale");
  });
});

describe("stale-daemon alert (#17)", () => {
  // maxSleepMs 60s → daemon-stale threshold 120s. Both jobs fire every minute.
  const registry = { jobs: [everyMinute("tick")] };
  const enabled = ["tick"];
  const fresh = JSON.stringify({ ts: NOW_MS - 10_000, host: "ml-1", dispatched_minute: {}, last_fired: {} });
  const old = JSON.stringify({ ts: NOW_MS - 300_000, host: "ml-1", dispatched_minute: {}, last_fired: {} });

  test("status with a fresh heartbeat → exit 0, no alert", () => {
    const { code, err } = runWith({ registry, enabled, heartbeat: fresh, maxSleepMs: 60_000 }, "status", []);
    expect(code).toBe(0);
    expect(err).not.toMatch(/ALERT/);
  });

  test("status with a stale heartbeat (5m old > 2m threshold) → STALE_EXIT_CODE (69) + stderr ALERT + STALE marker", () => {
    const { code, out, err } = runWith({ registry, enabled, heartbeat: old, maxSleepMs: 60_000 }, "status", []);
    expect(code).toBe(69);
    expect(err).toMatch(/ALERT: daemon heartbeat stale/);
    expect(err).toContain("scheduler is not running");
    expect(out).toContain("STALE");
  });

  test("stale daemon reflected in --json as daemonStale:true", () => {
    const { code, out } = runWith({ registry, enabled, heartbeat: old, maxSleepMs: 60_000 }, "status", ["--json"]);
    expect(code).toBe(69);
    expect(JSON.parse(out).daemonStale).toBe(true);
  });

  test("stale daemon does NOT fail list / next-runs — those are inventory, not a health check", () => {
    expect(runWith({ registry, enabled, heartbeat: old, maxSleepMs: 60_000 }, "list", []).code).toBe(0);
    expect(runWith({ registry, enabled, heartbeat: old, maxSleepMs: 60_000 }, "next-runs", []).code).toBe(0);
  });

  test("absent heartbeat is NOT a stale alert (never-checked-in warns, exits 0)", () => {
    const { code, err } = runWith({ registry, enabled, maxSleepMs: 60_000 }, "status", []);
    expect(code).toBe(0);
    expect(err).not.toMatch(/ALERT/);
  });
});

describe("next-runs edge cases", () => {
  test("runnable job with an invalid schedule is excluded from next-runs but present in list/status", () => {
    const registry = {
      jobs: [
        { name: "good", cronSchedule: "0 * * * *", isActive: true, hosts: ["*"], scope: "each", metadata: {} },
        { name: "bad", cronSchedule: "nope", isActive: true, hosts: ["*"], scope: "each", metadata: {} },
      ],
    };
    const enabled = ["good", "bad"];
    const nr = runWith({ registry, enabled }, "next-runs", []);
    expect(nr.code).toBe(0);
    expect(nr.out).toContain("good");
    expect(nr.out).not.toContain("bad"); // nextFire null → excluded
    const ls = runWith({ registry, enabled }, "list", []);
    expect(ls.out).toContain("bad"); // but still listed
    const st = runWith({ registry, enabled }, "status", ["--json"]);
    expect(JSON.parse(st.out).jobs.find((j: { name: string }) => j.name === "bad").health).toBe("invalid-schedule");
  });

  test("--within cutoff is inclusive (<=): a job firing exactly at now+window is included", () => {
    // every-minute job next fires at 12:01:00Z = NOW + 60s; --within 1m cutoff = NOW + 60s.
    const { code, out } = runWith({ registry: { jobs: [everyMinute("tick")] }, enabled: ["tick"] }, "next-runs", ["--within", "1m"]);
    expect(code).toBe(0);
    expect(out).toContain("tick");
  });

  test("--within 0 excludes everything (empty window)", () => {
    const { code, out } = runWith({ registry: { jobs: [everyMinute("tick")] }, enabled: ["tick"] }, "next-runs", ["--within", "0h"]);
    expect(code).toBe(0);
    expect(out).toContain("no upcoming runs");
  });

  test("--within as the last arg with no value → exit 2", () => {
    const { code, err } = runWith({ registry: { jobs: [everyMinute("tick")] }, enabled: ["tick"] }, "next-runs", ["--within"]);
    expect(code).toBe(2);
    expect(err).toContain("--within");
  });
});

describe("corrupt sidecar warnings (present-but-unparseable → stderr, still exit 0)", () => {
  test("corrupt heartbeat file warns and exits 0", () => {
    const { code, err } = runWith({ heartbeat: "{ not json" }, "status", []);
    expect(code).toBe(0);
    expect(err).toMatch(/heartbeat file present but unparseable/i);
  });

  test("corrupt topology file warns and exits 0", () => {
    const { code, err } = runWith({ topology: "{ not json" }, "status", []);
    expect(code).toBe(0);
    expect(err).toMatch(/topology file present but unparseable/i);
  });

  test("absent heartbeat (never run) does NOT warn", () => {
    const { code, err } = runWith({ /* no heartbeat file */ }, "status", []);
    expect(code).toBe(0);
    expect(err).not.toMatch(/unparseable/i);
  });

  test("corrupt (non-JSON) registry surfaces a parse warning, exit 0", () => {
    const { code, err } = runWith({ registry: "{ not json" }, "list", []);
    expect(code).toBe(0);
    expect(err).toMatch(/warning:.*not valid JSON/i);
  });

  test("registry with a non-array jobs field surfaces a warning, exit 0", () => {
    const { code, err } = runWith({ registry: '{"jobs":"x"}' }, "list", []);
    expect(code).toBe(0);
    expect(err).toMatch(/warning:.*not an array/i);
  });
});

describe("argument errors", () => {
  test("--within on a non-next-runs subcommand → exit 2", () => {
    const { code, err } = run("status", ["--within", "1h"]);
    expect(code).toBe(2);
    expect(err).toContain("--within");
  });

  test("unknown flag → exit 2", () => {
    const { code, err } = run("list", ["--bogus"]);
    expect(code).toBe(2);
    expect(err).toContain("--bogus");
  });

  test("missing config path → exit 2 with usage", () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = runStatusCommand("list", [], { now: () => NOW, out: (s) => out.push(s), err: (s) => err.push(s), env: {} });
    expect(code).toBe(2);
    expect(err.join("")).toContain("usage");
  });

  test("a missing registry surfaces a warning to stderr but still exits 0", () => {
    const badRegDir = mkdtempSync(join(tmpdir(), "cronbird-status-badreg-"));
    const badConfig = join(badRegDir, "config.json");
    writeFileSync(
      badConfig,
      JSON.stringify({
        hostname: "ml-1",
        registryPath: join(badRegDir, "does-not-exist.json"),
        enabledPath: null,
        topologyPath: null,
        heartbeatPath: join(badRegDir, "hb.json"),
        syncedHeartbeatDir: null,
        dispatchCommand: ["./run.sh"],
        dispatchArgsTemplate: ["{job}"],
        maxSleepMs: 60_000,
        catchupLookbackFloorMs: 3_600_000,
        catchupLookbackCapMs: 21_600_000,
      }),
    );
    const out: string[] = [];
    const err: string[] = [];
    const code = runStatusCommand("list", [badConfig], {
      now: () => NOW,
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      env: {},
    });
    rmSync(badRegDir, { recursive: true, force: true });
    expect(code).toBe(0);
    expect(err.join("")).toMatch(/warning:.*not found/i);
  });

  test("config with a bad path → exit 1", () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = runStatusCommand("list", [join(dir, "nope.json")], {
      now: () => NOW,
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      env: {},
    });
    expect(code).toBe(1);
    expect(err.join("")).toContain("config");
  });
});
