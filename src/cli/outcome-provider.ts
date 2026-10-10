/**
 * Scan the outcome directory for *.json files and build a map of
 * playbook-name -> DispatchOutcome records. Defensive validation:
 * - Each file must contain an object with numeric `ts` and exitCode fields
 * - Missing files, unreadable files, or malformed entries are silently ignored
 * - Returns empty object if no outcomes exist (pre-outcome-capture state)
 */
import { readdirSync, readFileSync } from "node:fs";
import type { DispatchOutcome } from "../core/types";

/**
 * Scan outcome directory and return a map of outcome records by playbook name.
 * Defensive validation ensures only well-formed records are returned; absent or
 * malformed entries are filtered out so the overlap guard starts clean at boot.
 */
export function loadOutcomes(outcomeDir: string): Record<string, DispatchOutcome> {
  const out: Record<string, DispatchOutcome> = {};

  if (!outcomeDir) return out;

  try {
    const entries = readdirSync(outcomeDir, { withFileTypes: true });

    // Filter only JSON files (ignore temp files and directories)
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".json")) continue;

      const name = e.name;
      let raw: unknown;

      try {
        const text = readFileSync(`${outcomeDir}/${name}`, "utf8");
        raw = JSON.parse(text);
      } catch {
        // Unreadable or malformed file — silently skip
        continue;
      }

      if (typeof raw !== "object" || raw === null) continue;

      const r = raw as Record<string, unknown>;

      // Defensive: must have both ts and exitCode fields with numeric types
      const ts = r.ts;
      const exitCode = r.exitCode;

      if (
        typeof ts === "number" &&
        typeof exitCode === "number"
      ) {
        out[name.slice(0, -5)] = { ts: ts as number, exitCode: exitCode as number };
      }
    }
  } catch {
    // Outcome directory unreadable — return empty map so overlap guard doesn't crash
  }

  return out;
}
