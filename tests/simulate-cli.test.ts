import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSimulateCommand, type SimulateCliDeps } from "../src/cli/index";

const MAIN = join(import.meta.dir, "../src/cli/main.ts");

const dir = mkdtempSync(join(tmpdir(), "cronbird-simulate-cli-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const registryPath = join(dir, "registry.json");
const enabledPath = join(dir, "enabled.json");
const topologyPath = join(dir, "topology.json");
const configPath = join(dir, "config.json");

const quickstartConfigPath = join(dir, "quickstart-config.json");
const missingRegistryConfigPath = join(dir, "missing-registry-config.json");
const corruptEnabledPath = join(dir, "corrupt-enabled.json");
const corruptEnabledConfigPath = join(dir, "corrupt-enabled-config.json");

function writeConfig(path: string, over: Record<string, unknown>): void {
  writeFileSync(
    path,
    JSON.stringify({
      hostname: "ml-1",
      registryPath,
      enabledPath,
      topologyPath,
      heartbeatPath: join(dir, "hb.json"),
      syncedHeartbeatDir: null,
      dispatchCommand: ["./run.sh"],
      dispatchArgsTemplate: ["{job}"],
      maxSleepMs: 60_000,
      catchupLookbackFloorMs: 3_600_000,
      catchupLookbackCapMs: 21_600_000,
      ...over,
    }),
  );
}

const NOW = new Date("2026-07-01T12:00:00.000Z");

// createMatcher() in the CLI evaluates crons in host-local time; pin it so the
// UTC-anchored expectations below hold on hosts with a non-whole-hour offset.
const originalTz = process.env.TZ;
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

beforeAll(() => {
  process.env.TZ = "UTC";
  writeFileSync(
    registryPath,
    JSON.stringify({
      jobs: [
        { name: "hourly", cronSchedule: "0 * * * *", isActive: true, hosts: ["*"], scope: "each", metadata: {} },
        { name: "daily", cronSchedule: "0 6 * * *", isActive: true, hosts: ["*"], scope: "single", metadata: {} },
        { name: "inactive", cronSchedule: "0 * * * *", isActive: false, hosts: ["*"], scope: "each", metadata: {} },
      ],
    }),
  );

  writeFileSync(enabledPath, JSON.stringify(["hourly"]));
  writeFileSync(topologyPath, JSON.stringify({ hosts: ["ml-1"], owners: { daily: "ml-1" } }));

  writeFileSync(
    configPath,
    JSON.stringify({
      hostname: "ml-1",
      registryPath,
      enabledPath,
      topologyPath,
      heartbeatPath: join(dir, "hb.json"),
      syncedHeartbeatDir: null,
      dispatchCommand: ["./run.sh"],
      dispatchArgsTemplate: ["{job}"],
      maxSleepMs: 60_000,
      catchupLookbackFloorMs: 3_600_000,
      catchupLookbackCapMs: 21_600_000,
    }),
  );

  writeConfig(missingRegistryConfigPath, { registryPath: join(dir, "no-such-registry.json") });
  writeFileSync(corruptEnabledPath, "nope");
  writeConfig(corruptEnabledConfigPath, { enabledPath: corruptEnabledPath });

  // Quickstart config reproducing #10 (enabledPath: null, topologyPath: null)
  writeFileSync(
    quickstartConfigPath,
    JSON.stringify({
      hostname: "ml-1",
      registryPath,
      enabledPath: null,
      topologyPath: null,
      heartbeatPath: join(dir, "hb-qs.json"),
      syncedHeartbeatDir: null,
      dispatchCommand: ["./run.sh"],
      dispatchArgsTemplate: ["{job}"],
      maxSleepMs: 60_000,
      catchupLookbackFloorMs: 3_600_000,
      catchupLookbackCapMs: 21_600_000,
    }),
  );
});

function run(args: string[], env: Record<string, string | undefined> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: SimulateCliDeps = {
    now: () => NOW,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    env,
  };
  const code = runSimulateCommand(args, deps);
  return { code, out: out.join(""), err: err.join("") };
}

describe("simulate CLI — arguments and validation", () => {
  test("missing --from exits 2 with usage", () => {
    const { code, err } = run([configPath, "--to", "2026-07-01T15:00:00Z"]);
    expect(code).toBe(2);
    expect(err).toContain("usage: cronbird simulate");
  });

  test("missing --to exits 2 with usage", () => {
    const { code, err } = run([configPath, "--from", "2026-07-01T12:00:00Z"]);
    expect(code).toBe(2);
    expect(err).toContain("usage: cronbird simulate");
  });

  test("missing config exits 2 with usage", () => {
    const { code, err } = run(["--from", "2026-07-01T12:00:00Z", "--to", "2026-07-01T15:00:00Z"]);
    expect(code).toBe(2);
    expect(err).toContain("usage: cronbird simulate");
  });

  test("config can be provided via CRONBIRD_CONFIG env var", () => {
    const { code, out } = run(
      ["--from", "2026-07-01T12:00:00Z", "--to", "2026-07-01T14:00:00Z"],
      { CRONBIRD_CONFIG: configPath },
    );
    expect(code).toBe(0);
    expect(out).toContain("hourly");
  });

  test("invalid --from value exits 2", () => {
    const { code, err } = run([configPath, "--from", "not-a-date", "--to", "2026-07-01T15:00:00Z"]);
    expect(code).toBe(2);
    expect(err).toContain("invalid --from");
  });

  test("invalid --to value exits 2", () => {
    const { code, err } = run([configPath, "--from", "2026-07-01T12:00:00Z", "--to", "garbage"]);
    expect(code).toBe(2);
    expect(err).toContain("invalid --to");
  });

  test("--from > --to exits 2", () => {
    const { code, err } = run([
      configPath,
      "--from",
      "2026-07-01T16:00:00Z",
      "--to",
      "2026-07-01T12:00:00Z",
    ]);
    expect(code).toBe(2);
    expect(err).toContain("--from must be before or equal to --to");
  });

  test("missing config file on disk exits 1 with config error", () => {
    const { code, err } = run([
      join(dir, "nonexistent.json"),
      "--from",
      "2026-07-01T12:00:00Z",
      "--to",
      "2026-07-01T15:00:00Z",
    ]);
    expect(code).toBe(1);
    expect(err).toContain("config error:");
  });
});

describe("simulate CLI — flag parsing", () => {
  test("flag with no value exits 2", () => {
    const { code, err } = run([configPath, "--from", "--to", "2026-07-01T15:00:00Z"]);
    expect(code).toBe(2);
    expect(err).toContain("missing argument for --from");
  });

  test("unknown flag exits 2", () => {
    const { code, err } = run([configPath, "--from", "now", "--to", "+1h", "--bogus"]);
    expect(code).toBe(2);
    expect(err).toContain("unknown flag: --bogus");
  });
});

describe("simulate CLI — time parsing", () => {
  const windowOf = (from: string, to: string) => {
    const { code, out } = run([configPath, "--from", from, "--to", to, "--json"]);
    expect(code).toBe(0);
    const r = JSON.parse(out);
    return [r.fromIso, r.toIso];
  };

  test("bare duration is in the past for --from and the future for --to", () => {
    expect(windowOf("1h", "1h")).toEqual(["2026-07-01T11:00:00.000Z", "2026-07-01T13:00:00.000Z"]);
  });

  test("signed durations go the direction of their sign", () => {
    expect(windowOf("-30m", "+30m")).toEqual(["2026-07-01T11:30:00.000Z", "2026-07-01T12:30:00.000Z"]);
  });

  test("epoch-ms is accepted", () => {
    const ms = String(Date.parse("2026-07-01T10:00:00Z"));
    expect(windowOf(ms, "now")).toEqual(["2026-07-01T10:00:00.000Z", "2026-07-01T12:00:00.000Z"]);
  });
});

describe("simulate CLI — load failures", () => {
  test("missing registry exits 1 instead of reporting an empty window", () => {
    const { code, out, err } = run([missingRegistryConfigPath, "--from", "now", "--to", "+2h"]);
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toContain("registry file not found");
    expect(err).toContain("config error:");
  });

  test("present-but-unparseable enabled file exits 1", () => {
    const { code, out, err } = run([corruptEnabledConfigPath, "--from", "now", "--to", "+2h"]);
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toContain("warning: enabled file present but unparseable");
    expect(err).toContain("config error:");
  });
});

describe("simulate CLI — output rendering", () => {
  test("renders human-readable table of scheduled dispatches", () => {
    const { code, out } = run([
      configPath,
      "--from",
      "2026-07-01T12:00:00Z",
      "--to",
      "2026-07-01T14:00:00Z",
    ]);
    expect(code).toBe(0);
    expect(out).toContain("TIME");
    expect(out).toContain("JOB");
    expect(out).toContain("hourly");
    expect(out.split("\n").filter((l) => l.includes("hourly")).length).toBe(3); // 12:00, 13:00, 14:00
  });

  test("--json emits structured SimulationReport", () => {
    const { code, out } = run([
      configPath,
      "--from",
      "2026-07-01T12:00:00Z",
      "--to",
      "2026-07-01T13:00:00Z",
      "--json",
    ]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.host).toBe("ml-1");
    expect(parsed.dispatches.length).toBe(2); // 12:00, 13:00
    expect(parsed.dispatches[0].job).toBe("hourly");
    expect(parsed.dispatches[0].timeIso).toBe("2026-07-01T12:00:00.000Z");
  });

  test("empty dispatch window prints 'no dispatches in window'", () => {
    const { code, out } = run([
      configPath,
      "--from",
      "2026-07-01T12:01:00Z",
      "--to",
      "2026-07-01T12:59:00Z",
    ]);
    expect(code).toBe(0);
    expect(out).toBe("no dispatches in window\n");
  });

  test("supports relative durations (+2h, now)", () => {
    // NOW is 12:00Z; from now to +2h should catch 12:00, 13:00, 14:00
    const { code, out } = run([configPath, "--from", "now", "--to", "+2h"]);
    expect(code).toBe(0);
    expect(out).toContain("hourly");
    expect(out.split("\n").filter((l) => l.includes("hourly")).length).toBe(3);
  });
});

describe("simulate CLI — Issue #10 regression / integration", () => {
  test("quickstart with null enabledPath and null topologyPath reports every skipped job (#10)", () => {
    // Reproduces #10: fileEnabledProvider(null) returns empty set, fileTopologyProvider(null) returns null.
    // single-scope job 'daily' has no owner; each-scope 'hourly' is not enabled.
    const { code, out, err } = run([
      quickstartConfigPath,
      "--from",
      "2026-07-01T00:00:00Z",
      "--to",
      "2026-07-02T00:00:00Z",
    ]);
    expect(code).toBe(0);
    expect(out).toBe("no dispatches in window\n");
    expect(err).toContain("skipped: hourly: not runnable on ml-1 (scope=each, not in enabled set)");
    expect(err).toContain("skipped: daily: not runnable on ml-1 (scope=single, owner=none)");
  });
});

describe("simulate CLI — end-to-end binary execution", () => {
  test("runs via `cronbird simulate` subcommand", () => {
    const r = Bun.spawnSync(
      [
        "bun",
        MAIN,
        "simulate",
        configPath,
        "--from",
        "2026-07-01T12:00:00Z",
        "--to",
        "2026-07-01T13:00:00Z",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain("hourly");
  });

  test("piped output larger than a pipe buffer arrives complete", () => {
    // A shell pipe to a slower reader is what exposes an exit before stdout
    // drains; Bun.spawnSync reads fast enough to hide it.
    const cmd = `"${process.execPath}" "${MAIN}" simulate "${configPath}" --from 2026-01-01T00:00:00Z --to 2027-01-01T00:00:00Z | grep -c hourly`;
    const r = Bun.spawnSync(["sh", "-c", cmd], { stdout: "pipe", stderr: "pipe", env: { ...process.env, TZ: "UTC" } });
    expect(r.stdout.toString().trim()).toBe(String(365 * 24 + 1));
  });
});
