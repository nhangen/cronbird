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
    // inactive job shows not runnable
    expect(/off\b.*\bno\b/i.test(out) || /off\b.*false/i.test(out)).toBe(true);
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
