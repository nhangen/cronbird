import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJobsJson, parseEnabledJson, parseTopologyJson, fileJobProvider, fileEnabledProvider, fileTopologyProvider } from "../src/cli/providers";

describe("providers", () => {
  test("parseJobsJson maps registry entries to Job and collects warnings for bad rows", () => {
    const text = JSON.stringify({ jobs: [
      { name: "a", cronSchedule: "0 6 * * *", isActive: true, hosts: ["*"], scope: "each", metadata: {} },
      { name: "", cronSchedule: "0 6 * * *", isActive: true, hosts: ["*"], scope: "each", metadata: {} },
    ]});
    const r = parseJobsJson(text);
    expect(r.jobs.map((j) => j.name)).toEqual(["a"]);
    expect(r.value.map((j) => j.name)).toEqual(["a"]);
    expect(r.warnings.length).toBe(1);
  });

  test("parseJobsJson carries a valid timezone and skips rows with an invalid one", () => {
    const row = (name: string, extra: Record<string, unknown>) => ({ name, cronSchedule: "0 9 * * *", isActive: true, ...extra });
    const r = parseJobsJson(JSON.stringify({ jobs: [
      row("ny", { timezone: "America/New_York" }),
      row("local", {}),
      row("mars", { timezone: "Mars/Olympus_Mons" }),
      row("empty", { timezone: "" }),
      row("num", { timezone: 123 }),
    ]}));
    expect(r.jobs.map((j) => [j.name, j.timezone])).toEqual([["ny", "America/New_York"], ["local", undefined]]);
    expect(r.warnings.length).toBe(3);
    expect(r.warnings.find((w) => w.startsWith("skipped mars:"))).toContain("Mars/Olympus_Mons");
    expect(r.warnings).toContain("skipped empty: timezone must be a non-empty IANA string");
    expect(r.warnings).toContain("skipped num: timezone must be a non-empty IANA string");
  });

  test("parseEnabledJson returns empty set on malformed input (fail-safe) with warning", () => {
    const bad = parseEnabledJson("not json");
    expect(bad.value.size).toBe(0);
    expect(bad.warnings).toEqual(["enabled file present but unparseable"]);

    const badWithPath = parseEnabledJson("not json", "/path/to/enabled.json");
    expect(badWithPath.value.size).toBe(0);
    expect(badWithPath.warnings).toEqual(["enabled file present but unparseable: /path/to/enabled.json"]);

    const good = parseEnabledJson(JSON.stringify(["x", "y"]));
    expect([...good.value].sort()).toEqual(["x", "y"]);
    expect(good.warnings).toEqual([]);

    const absent = parseEnabledJson(null);
    expect(absent.value.size).toBe(0);
    expect(absent.warnings).toEqual([]);
  });

  test("parseTopologyJson returns null on malformed input (reuse last-good) with warning", () => {
    const bad = parseTopologyJson("not json");
    expect(bad.value).toBeNull();
    expect(bad.warnings).toEqual(["topology file present but unparseable"]);

    const badWithPath = parseTopologyJson("not json", "/path/to/topology.json");
    expect(badWithPath.value).toBeNull();
    expect(badWithPath.warnings).toEqual(["topology file present but unparseable: /path/to/topology.json"]);

    const good = parseTopologyJson(JSON.stringify({ hosts: ["h"], owners: { j: "h" } }));
    expect(good.value?.owners.j).toBe("h");
    expect(good.warnings).toEqual([]);

    const absent = parseTopologyJson(null);
    expect(absent.value).toBeNull();
    expect(absent.warnings).toEqual([]);
  });

  test("fileEnabledProvider(null) yields an EMPTY set — enabledPath:null is not 'all enabled', so no each-scope job runs (#10)", () => {
    const res = fileEnabledProvider(null)();
    expect(res.value.size).toBe(0);
    expect(res.warnings).toEqual([]);
  });

  test("fileEnabledProvider handles missing file as benign empty set without warnings", () => {
    const missing = join(tmpdir(), `cronbird-missing-enabled-${Date.now()}.json`);
    const res = fileEnabledProvider(missing)();
    expect(res.value.size).toBe(0);
    expect(res.warnings).toEqual([]);
  });

  test("fileEnabledProvider warns on corrupt enabled file", () => {
    const p = join(tmpdir(), `cronbird-corrupt-enabled-${Date.now()}.json`);
    writeFileSync(p, "{ not json");
    const res = fileEnabledProvider(p)();
    rmSync(p, { force: true });
    expect(res.value.size).toBe(0);
    expect(res.warnings).toEqual([`enabled file present but unparseable: ${p}`]);
  });

  test("fileTopologyProvider(null) and missing file return null without warnings", () => {
    expect(fileTopologyProvider(null)()).toEqual({ value: null, warnings: [] });
    const missing = join(tmpdir(), `cronbird-missing-topology-${Date.now()}.json`);
    expect(fileTopologyProvider(missing)()).toEqual({ value: null, warnings: [] });
  });

  test("fileTopologyProvider warns on corrupt topology file", () => {
    const p = join(tmpdir(), `cronbird-corrupt-topology-${Date.now()}.json`);
    writeFileSync(p, "{ not json");
    const res = fileTopologyProvider(p)();
    rmSync(p, { force: true });
    expect(res.value).toBeNull();
    expect(res.warnings).toEqual([`topology file present but unparseable: ${p}`]);
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

  test("parseJobsJson warns and skips on unknown scope, defaulting unset scope to 'single' (linus L5)", () => {
    const text = JSON.stringify({
      jobs: [
        { name: "good-single", cronSchedule: "0 6 * * *", scope: "single" },
        { name: "good-each", cronSchedule: "0 6 * * *", scope: "each" },
        { name: "default-single", cronSchedule: "0 6 * * *" },
        { name: "typo-each", cronSchedule: "0 6 * * *", scope: "eahc" },
        { name: "typo-single", cronSchedule: "0 6 * * *", scope: "singel" },
      ],
    });
    const res = parseJobsJson(text);
    expect(res.ok).toBe(true);
    expect(res.jobs.map((j) => j.name)).toEqual(["good-single", "good-each", "default-single"]);
    expect(res.jobs.find((j) => j.name === "default-single")?.scope).toBe("single");
    expect(res.warnings).toEqual([
      'skipped typo-each: unknown scope "eahc" (expected "single" | "each")',
      'skipped typo-single: unknown scope "singel" (expected "single" | "each")',
    ]);
  });
});

describe("providers: unreadable sidecars (read error is not a parse error)", () => {
  const asDir = (): string => mkdtempSync(join(tmpdir(), "cronbird-asdir-"));

  test("fileEnabledProvider on a directory warns 'unreadable' with the errno, not 'unparseable'", () => {
    const d = asDir();
    try {
      const res = fileEnabledProvider(d)();
      expect(res.value.size).toBe(0);
      expect(res.warnings).toEqual([`enabled file present but unreadable: ${d} (EISDIR)`]);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test("fileTopologyProvider on a directory warns 'unreadable' with the errno", () => {
    const d = asDir();
    try {
      const res = fileTopologyProvider(d)();
      expect(res.value).toBeNull();
      expect(res.warnings).toEqual([`topology file present but unreadable: ${d} (EISDIR)`]);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test("fileJobProvider on a directory is ok:false and says unreadable, not 'not found'", () => {
    const d = asDir();
    try {
      const res = fileJobProvider(d)();
      expect(res.ok).toBe(false);
      expect(res.warnings).toEqual([`registry file unreadable: ${d} (EISDIR)`]);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test("valid JSON of the wrong shape still warns unparseable (enabled not an array, topology missing owners)", () => {
    expect(parseEnabledJson("{}", "/p").warnings).toEqual(["enabled file present but unparseable: /p"]);
    expect(parseTopologyJson(JSON.stringify({ hosts: [] }), "/p").warnings).toEqual(["topology file present but unparseable: /p"]);
  });
});
