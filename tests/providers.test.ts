import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJobsJson, parseEnabledJson, parseTopologyJson, fileJobProvider, fileEnabledProvider } from "../src/cli/providers";

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

  test("fileEnabledProvider(null) yields an EMPTY set — enabledPath:null is not 'all enabled', so no each-scope job runs (#10)", () => {
    expect(fileEnabledProvider(null)().size).toBe(0);
  });

  test("fileJobProvider fails safe on missing registry file — returns empty jobs + warning", () => {
    const missingPath = join(tmpdir(), `cronbird-no-such-registry-${Date.now()}.json`);
    const provider = fileJobProvider(missingPath);
    let result: ReturnType<typeof provider>;
    expect(() => { result = provider(); }).not.toThrow();
    expect(result!.jobs).toEqual([]);
    expect(result!.warnings.length).toBeGreaterThan(0);
    expect(result!.warnings[0]).toContain(missingPath);
  });

  // #1: the result carries an `ok` discriminator so the daemon can tell a
  // catastrophic load (corrupt/missing → reuse last-good) apart from a
  // legitimately-empty registry (ok:true, jobs:[] → overwrite last-good).
  // Non-throwing at the provider boundary: status.ts still renders the warning.
  test("ok:false marks catastrophic loads (invalid JSON, jobs-not-array, missing file); ok:true otherwise (#1)", () => {
    expect(parseJobsJson("not json").ok).toBe(false);
    expect(parseJobsJson(JSON.stringify({ jobs: "nope" })).ok).toBe(false);

    const emptyValid = parseJobsJson(JSON.stringify({ jobs: [] }));
    expect(emptyValid.ok).toBe(true);
    expect(emptyValid.jobs).toEqual([]);

    // A structurally-valid registry with a bad row is NOT catastrophic: the
    // good subset loads and ok stays true (per-job skip, not a load failure).
    const partial = parseJobsJson(JSON.stringify({ jobs: [
      { name: "a", cronSchedule: "0 6 * * *" },
      { name: "", cronSchedule: "0 6 * * *" },
    ]}));
    expect(partial.ok).toBe(true);
    expect(partial.jobs.map((j) => j.name)).toEqual(["a"]);
    expect(partial.warnings.length).toBe(1);

    const missingPath = join(tmpdir(), `cronbird-ok-missing-${Date.now()}.json`);
    expect(fileJobProvider(missingPath)().ok).toBe(false);
  });
});
