import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJobsJson, parseEnabledJson, parseTopologyJson, fileJobProvider } from "../src/cli/providers";

describe("providers", () => {
  test("parseJobsJson maps registry entries to Job and collects warnings for bad rows", () => {
    const text = JSON.stringify({ jobs: [
      { name: "a", cronSchedule: "0 6 * * *", isActive: true, hosts: ["*"], scope: "each", metadata: {} },
      { name: "", cronSchedule: "0 6 * * *", isActive: true, hosts: ["*"], scope: "each", metadata: {} },
    ]});
    const r = parseJobsJson(text);
    expect(r.jobs.map((j) => j.name)).toEqual(["a"]);
    expect(r.warnings.length).toBe(1);
  });

  test("parseEnabledJson returns empty set on malformed input (fail-safe)", () => {
    expect(parseEnabledJson("not json").size).toBe(0);
    expect([...parseEnabledJson(JSON.stringify(["x", "y"]))].sort()).toEqual(["x", "y"]);
  });

  test("parseTopologyJson returns null on malformed input (reuse last-good)", () => {
    expect(parseTopologyJson("not json")).toBeNull();
    expect(parseTopologyJson(JSON.stringify({ hosts: ["h"], owners: { j: "h" } }))?.owners.j).toBe("h");
  });

  test("fileJobProvider fails safe on missing registry file — returns empty jobs + warning", () => {
    const missingPath = join(tmpdir(), `perch-no-such-registry-${Date.now()}.json`);
    const provider = fileJobProvider(missingPath);
    let result: ReturnType<typeof provider>;
    expect(() => { result = provider(); }).not.toThrow();
    expect(result!.jobs).toEqual([]);
    expect(result!.warnings.length).toBeGreaterThan(0);
    expect(result!.warnings[0]).toContain(missingPath);
  });
});
