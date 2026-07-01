import { describe, expect, test } from "bun:test";
import { ShellDispatcher } from "../src/cli/shell-dispatcher";

describe("ShellDispatcher", () => {
  test("builds argv as [...command, ...template with {job} substituted]", () => {
    const calls: string[][] = [];
    const d = new ShellDispatcher(["ceo-cron.sh"], ["{job}", "--scheduled"], () => {}, (argv) => {
      calls.push(argv);
    });
    d.dispatch("morning-scan");
    expect(calls).toEqual([["ceo-cron.sh", "morning-scan", "--scheduled"]]);
  });

  test("a spawn error is caught and logged, never thrown", () => {
    const logs: string[] = [];
    const d = new ShellDispatcher(["x"], ["{job}"], (m) => logs.push(m), () => {
      throw new Error("ENOENT");
    });
    expect(() => d.dispatch("job1")).not.toThrow();
    expect(logs.some((l) => l.includes("dispatch failed") && l.includes("job1"))).toBe(true);
  });
});
