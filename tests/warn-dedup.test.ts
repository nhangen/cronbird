import { describe, expect, test } from "bun:test";
import { createSurfacer, createWarningLogger } from "../src/cli/warn-dedup";

describe("createWarningLogger", () => {
  test("logs a warning once while it persists across ticks", () => {
    const out: string[] = [];
    const warn = createWarningLogger((m) => out.push(m));
    warn("enabled", ["bad file"]);
    warn("enabled", ["bad file"]);
    expect(out).toEqual(["enabled: bad file"]);
  });

  test("logs again after the warning clears and returns", () => {
    const out: string[] = [];
    const warn = createWarningLogger((m) => out.push(m));
    warn("enabled", ["bad file"]);
    warn("enabled", []);
    warn("enabled", ["bad file"]);
    expect(out).toEqual(["enabled: bad file", "enabled: bad file"]);
  });

  test("sources are tracked independently", () => {
    const out: string[] = [];
    const warn = createWarningLogger((m) => out.push(m));
    warn("enabled", ["x"]);
    warn("topology", ["x"]);
    expect(out).toEqual(["enabled: x", "topology: x"]);
  });
});

describe("createSurfacer", () => {
  test("returns the loader value and logs its warnings once per source", () => {
    const out: string[] = [];
    const surface = createSurfacer((m) => out.push(m));
    const r = { value: new Set<string>(), warnings: ["enabled file present but unparseable: /p"] };
    expect(surface("enabled", r)).toBe(r.value);
    surface("enabled", r);
    expect(out).toEqual(["enabled: enabled file present but unparseable: /p"]);
  });
});
