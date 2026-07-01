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
});
