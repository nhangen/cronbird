import { describe, expect, test } from "bun:test";
import { isEligible, failedJobs, transitiveUpstreamFailed, validateDependencies } from "../src/core/dependencies";
import type { CompletionRecord, Job } from "../src/core/types";

const j = (name: string): Job => ({
  name,
  cronSchedule: "0 9 * * *",
  isActive: true,
  hosts: ["*"],
  scope: "each",
  metadata: {},
});

describe("dependency eligibility", () => {
  const depsOf = (n: string): string[] => (n === "D" ? ["U"] : []);

  test("eligible when upstream succeeded after dependent last ran", () => {
    expect(isEligible("D", depsOf("D"), { U: 200 }, { D: 100 })).toBe(true);
  });
  test("blocked when upstream success predates dependent last run", () => {
    expect(isEligible("D", depsOf("D"), { U: 50 }, { D: 100 })).toBe(false);
  });
  test("dependent never ran → any upstream success qualifies", () => {
    expect(isEligible("D", depsOf("D"), { U: 1 }, {})).toBe(true);
  });
  test("blocked when upstream never succeeded", () => {
    expect(isEligible("D", depsOf("D"), {}, {})).toBe(false);
  });
  test("no dependencies → always eligible", () => {
    expect(isEligible("I", [], {}, {})).toBe(true);
  });
});

describe("failure derivation + cascade", () => {
  const done = (exit: number): CompletionRecord => ({ ts: 1, exitCode: exit, durationMs: 0 });

  test("failed = attempts at max AND last exit non-zero", () => {
    const f = failedJobs(["a", "b", "c"], { a: 3, b: 3, c: 1 }, { a: done(1), b: done(0), c: done(1) }, 3);
    expect([...f]).toEqual(["a"]); // b succeeded on last try; c hasn't hit max
  });

  test("transitive upstream failure reaches diamond dependent", () => {
    // D←B,C ; B←A ; C←A ; A failed
    const depsOf = (n: string): string[] =>
      n === "D" ? ["B", "C"] : n === "B" || n === "C" ? ["A"] : [];
    expect(transitiveUpstreamFailed("D", depsOf, new Set(["A"]))).toBe(true);
    expect(transitiveUpstreamFailed("B", depsOf, new Set(["A"]))).toBe(true);
    expect(transitiveUpstreamFailed("A", depsOf, new Set(["A"]))).toBe(false); // itself failed ≠ upstream failed
  });
});

describe("dependency validation at load", () => {
  test("flags every job in a cycle A→B→A", () => {
    const up = (n: string): string[] => (n === "A" ? ["B"] : n === "B" ? ["A"] : []);
    const { invalid, warnings } = validateDependencies([j("A"), j("B")], up);
    expect(invalid.has("A")).toBe(true);
    expect(invalid.has("B")).toBe(true);
    expect(warnings.join(" ")).toMatch(/cycle/i);
  });

  test("flags a job with an edge to an unknown job", () => {
    const up = (n: string): string[] => (n === "D" ? ["ghost"] : []);
    const { invalid, warnings } = validateDependencies([j("D")], up);
    expect(invalid.has("D")).toBe(true);
    expect(warnings.join(" ")).toMatch(/unknown|ghost/i);
  });

  test("a clean DAG has no invalid jobs", () => {
    const up = (n: string): string[] => (n === "D" ? ["U"] : []);
    expect(validateDependencies([j("U"), j("D")], up).invalid.size).toBe(0);
  });

  test("a self-edge A→A is a cycle", () => {
    const up = (n: string): string[] => (n === "A" ? ["A"] : []);
    expect(validateDependencies([j("A")], up).invalid.has("A")).toBe(true);
  });
});
