import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HELP_TOKENS, usageText } from "../src/cli/index";

const MAIN = join(import.meta.dir, "../src/cli/main.ts");

function runCli(args: string[]) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("usageText", () => {
  test("lists every subcommand and the daemon mode", () => {
    const u = usageText();
    for (const token of ["cronbird <config.json>", "list", "next-runs", "status", "help", "--within"]) {
      expect(u).toContain(token);
    }
  });

  test("HELP_TOKENS covers help / --help / -h", () => {
    expect(HELP_TOKENS.has("help")).toBe(true);
    expect(HELP_TOKENS.has("--help")).toBe(true);
    expect(HELP_TOKENS.has("-h")).toBe(true);
  });
});

describe("cronbird help / usage (end-to-end via spawn)", () => {
  test("`help` → usage on stdout, exit 0", () => {
    const { code, out } = runCli(["help"]);
    expect(code).toBe(0);
    expect(out).toContain("Usage:");
    expect(out).toContain("next-runs");
  });

  test("`--help` and `-h` → exit 0 with usage", () => {
    for (const flag of ["--help", "-h"]) {
      const { code, out } = runCli([flag]);
      expect(code).toBe(0);
      expect(out).toContain("Usage:");
    }
  });

  test("no args → usage on stderr, exit 2 (self-describing)", () => {
    const { code, err } = runCli([]);
    expect(code).toBe(2);
    expect(err).toContain("Usage:");
  });

  test("a config path first arg is still treated as the daemon (not a usage error)", () => {
    // A non-help, non-subcommand token is a config path → daemon reads it →
    // fails to find the file → fatal exit 1. Proves it did NOT hit the usage
    // (exit 2) or help (exit 0) branch.
    const dir = mkdtempSync(join(tmpdir(), "cronbird-help-"));
    const missing = join(dir, "nope.json");
    const { code, err } = runCli([missing]);
    rmSync(dir, { recursive: true, force: true });
    expect(code).toBe(1);
    expect(err.toLowerCase()).toContain("fatal");
  });

  test("a valid config starts the daemon (routing unchanged), then SIGTERM stops it", () => {
    const dir = mkdtempSync(join(tmpdir(), "cronbird-help-d-"));
    const reg = join(dir, "r.json");
    writeFileSync(reg, JSON.stringify({ jobs: [] }));
    const cfg = join(dir, "c.json");
    writeFileSync(
      cfg,
      JSON.stringify({
        hostname: "ml-1",
        registryPath: reg,
        enabledPath: null,
        topologyPath: null,
        heartbeatPath: join(dir, "hb.json"),
        syncedHeartbeatDir: null,
        dispatchCommand: ["./run.sh"],
        dispatchArgsTemplate: ["{job}"],
        maxSleepMs: 60_000,
        catchupLookbackFloorMs: 3_600_000,
        catchupLookbackCapMs: 21_600_000,
      }),
    );
    // timeout kills the forever-running daemon; we only assert it started.
    const r = Bun.spawnSync(["bun", MAIN, cfg], { stdout: "pipe", stderr: "pipe", timeout: 1500 });
    rmSync(dir, { recursive: true, force: true });
    expect(r.stderr.toString()).toContain("started");
  });
});
