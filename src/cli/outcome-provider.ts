/**
 * Scan the outcome directory for `*.json` files and build a map of
 * playbook-name → {@link DispatchOutcome} records. The filename (minus the
 * `.json` extension) is the playbook name.
 *
 * Defensive validation:
 * - Each file must contain an object with numeric `ts` and `exitCode` fields.
 * - Missing/unreadable/malformed files are silently skipped so a torn write
 *   never crashes the daemon at boot.
 * - Returns `{}` when the directory is absent or empty — the overlap guard
 *   then has no records to consult and behaves exactly like the pre-guard
 *   dispatch.
 */
import { readdirSync, readFileSync } from "node:fs";
import type { DispatchOutcome } from "../core/types";

const JSON_SUFFIX_LEN = ".json".length;

export function loadOutcomes(outcomeDir: string): Record<string, DispatchOutcome> {
  const out: Record<string, DispatchOutcome> = {};
  if (!outcomeDir) return out;

  let entries;
  try {
    entries = readdirSync(outcomeDir, { withFileTypes: true });
  } catch {
    // Directory absent or unreadable → no outcomes, guard is a no-op.
    return out;
  }

  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".json")) continue;
    const jobName = e.name.slice(0, e.name.length - JSON_SUFFIX_LEN);

    let raw: unknown;
    try {
      const text = readFileSync(`${outcomeDir}/${e.name}`, "utf8");
      raw = JSON.parse(text);
    } catch {
      // Unreadable or malformed file — skip, keep the rest.
      continue;
    }

    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.ts === "number" && typeof r.exitCode === "number") {
      out[jobName] = { ts: r.ts, exitCode: r.exitCode };
    }
  }

  return out;
}
