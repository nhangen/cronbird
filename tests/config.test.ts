import { describe, expect, test } from "bun:test";
import { parseConfig, ConfigError } from "../src/cli/config";

const base = {
  registryPath: "/r.json", enabledPath: null, topologyPath: null,
  heartbeatPath: "/hb.json", syncedHeartbeatDir: null,
  dispatchCommand: ["run.sh"], dispatchArgsTemplate: ["{job}"],
  maxSleepMs: 60000, catchupLookbackFloorMs: 3600000, catchupLookbackCapMs: 21600000,
};

describe("parseConfig", () => {
  test("resolves hostname 'auto' to the short os hostname", () => {
    const c = parseConfig(JSON.stringify({ ...base, hostname: "auto" }), {});
    expect(c.hostname).not.toBe("auto");
    expect(c.hostname.length).toBeGreaterThan(0);
  });

  test("a literal hostname is kept verbatim", () => {
    const c = parseConfig(JSON.stringify({ ...base, hostname: "ml-1" }), {});
    expect(c.hostname).toBe("ml-1");
  });

  test("missing dispatchCommand throws ConfigError, not a silent default", () => {
    const bad = { ...base, hostname: "ml-1" } as Record<string, unknown>;
    delete bad.dispatchCommand;
    expect(() => parseConfig(JSON.stringify(bad), {})).toThrow(ConfigError);
  });

  test("~-prefixed paths expand against env.HOME", () => {
    const c = parseConfig(JSON.stringify({ ...base, hostname: "ml-1", registryPath: "~/.cronbird/r.json" }), { HOME: "/home/x" });
    expect(c.registryPath).toBe("/home/x/.cronbird/r.json");
  });

  test("dispatchArgsTemplate missing a {job} token throws ConfigError (would dispatch every job with identical, name-less argv) (#11)", () => {
    expect(() => parseConfig(JSON.stringify({ ...base, hostname: "ml-1", dispatchArgsTemplate: ["cron", "run"] }), {})).toThrow(ConfigError);
  });

  test("{job} embedded in a larger string (not an exact element) is rejected — the dispatcher substitutes an exact {job} element only", () => {
    expect(() => parseConfig(JSON.stringify({ ...base, hostname: "ml-1", dispatchArgsTemplate: ["--job={job}"] }), {})).toThrow(ConfigError);
  });

  test("an exact {job} element parses and is preserved", () => {
    const c = parseConfig(JSON.stringify({ ...base, hostname: "ml-1", dispatchArgsTemplate: ["ceo", "cron", "{job}"] }), {});
    expect(c.dispatchArgsTemplate).toEqual(["ceo", "cron", "{job}"]);
  });

  test("history retention fields resolve to null when absent or null, and reject non-positive values", () => {
    const absent = parseConfig(JSON.stringify({ ...base, hostname: "ml-1" }), {});
    expect(absent.maxHistoryRecords).toBeNull();
    expect(absent.historyRetentionMs).toBeNull();
    const nulls = parseConfig(JSON.stringify({ ...base, hostname: "ml-1", maxHistoryRecords: null, historyRetentionMs: null }), {});
    expect(nulls.maxHistoryRecords).toBeNull();
    expect(nulls.historyRetentionMs).toBeNull();
    const set = parseConfig(JSON.stringify({ ...base, hostname: "ml-1", maxHistoryRecords: 5, historyRetentionMs: 1000 }), {});
    expect(set.maxHistoryRecords).toBe(5);
    expect(set.historyRetentionMs).toBe(1000);
    expect(() => parseConfig(JSON.stringify({ ...base, hostname: "ml-1", maxHistoryRecords: 0 }), {})).toThrow(/positive integer or null/);
  });

  test("lockPath defaults to heartbeatPath.lock when absent, respects null, and expands tilde", () => {
    const absent = parseConfig(JSON.stringify({ ...base, hostname: "ml-1" }), {});
    expect(absent.lockPath).toBe("/hb.json.lock");

    const disabled = parseConfig(JSON.stringify({ ...base, hostname: "ml-1", lockPath: null }), {});
    expect(disabled.lockPath).toBeNull();

    const custom = parseConfig(JSON.stringify({ ...base, hostname: "ml-1", lockPath: "~/locks/cron.lock" }), { HOME: "/home/u" });
    expect(custom.lockPath).toBe("/home/u/locks/cron.lock");
  });
});
