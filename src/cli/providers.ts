import { existsSync, readFileSync } from "node:fs";
import type { Job, Topology } from "../core/index";
import { InvalidTimezoneError, assertValidTimezone } from "../core/index";

// `ok` discriminates a CATASTROPHIC load (invalid JSON / jobs-not-array —
// caller should reuse last-good) from a usable registry (ok:true), including a
// legitimately-empty one and one with per-job skips. The daemon loop keys its
// reuse-last-good decision on `ok === false`; string-matching warnings would be
// fragile and can't tell a corrupt registry from one whose rows all skipped.
export function parseJobsJson(text: string): { jobs: Job[]; value: Job[]; warnings: string[]; ok: boolean } {
  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { jobs: [], value: [], warnings: ["registry is not valid JSON"], ok: false };
  }
  const rows = (parsed as { jobs?: unknown }).jobs;
  if (!Array.isArray(rows)) return { jobs: [], value: [], warnings: ["registry.jobs is not an array"], ok: false };
  const jobs: Job[] = [];
  for (const r of rows) {
    const o = r as Record<string, unknown>;
    if (typeof o.name !== "string" || o.name.length === 0) { warnings.push("skipped job with missing name"); continue; }
    if (typeof o.cronSchedule !== "string") { warnings.push(`skipped ${o.name}: missing cronSchedule`); continue; }
    if (o.scope !== undefined && o.scope !== "each" && o.scope !== "single") {
      warnings.push(`skipped ${o.name}: unknown scope "${String(o.scope)}" (expected "single" | "each")`);
      continue;
    }
    let timezone: string | undefined;
    if (o.timezone !== undefined) {
      if (typeof o.timezone !== "string" || o.timezone.length === 0) {
        warnings.push(`skipped ${o.name}: timezone must be a non-empty IANA string`);
        continue;
      }
      try {
        assertValidTimezone(o.timezone);
        timezone = o.timezone;
      } catch (e) {
        if (e instanceof InvalidTimezoneError) {
          warnings.push(`skipped ${o.name}: ${e.message}`);
        } else {
          throw e;
        }
        continue;
      }
    }
    jobs.push({
      name: o.name,
      cronSchedule: o.cronSchedule,
      timezone,
      isActive: o.isActive === true,
      hosts: Array.isArray(o.hosts) && o.hosts.every((h) => typeof h === "string") && o.hosts.length > 0 ? (o.hosts as string[]) : ["*"],
      scope: o.scope === "each" ? "each" : "single",
      metadata: (o.metadata ?? {}) as unknown,
    });
  }
  return { jobs, value: jobs, warnings, ok: true };
}

export function parseEnabledJson(text: string | null, path?: string): { value: Set<string>; warnings: string[] } {
  if (text === null) return { value: new Set(), warnings: [] };
  try {
    const a = JSON.parse(text);
    if (Array.isArray(a)) return { value: new Set(a.filter((x) => typeof x === "string")), warnings: [] };
  } catch { /* fall through */ }
  const warn = path
    ? `enabled file present but unparseable: ${path}`
    : "enabled file present but unparseable";
  return { value: new Set(), warnings: [warn] };
}

export function parseTopologyJson(text: string | null, path?: string): { value: Topology | null; warnings: string[] } {
  if (text === null) return { value: null, warnings: [] };
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    const hosts = o.hosts, owners = o.owners;
    if (Array.isArray(hosts) && typeof owners === "object" && owners !== null) {
      const cleanOwners: Record<string, string> = {};
      for (const [k, v] of Object.entries(owners)) if (typeof v === "string") cleanOwners[k] = v;
      return {
        value: { hosts: hosts.filter((h) => typeof h === "string") as string[], owners: cleanOwners },
        warnings: [],
      };
    }
  } catch { /* fall through */ }
  const warn = path
    ? `topology file present but unparseable: ${path}`
    : "topology file present but unparseable";
  return { value: null, warnings: [warn] };
}

type Sidecar = { kind: "ok"; text: string } | { kind: "absent" } | { kind: "unreadable"; code: string };

// ENOENT between existsSync and the read is a vanished file — absent, not corrupt.
// Anything else (EISDIR, EACCES, EIO) is present-but-unreadable and keeps its errno.
function readSidecar(path: string): Sidecar {
  try {
    return { kind: "ok", text: readFileSync(path, "utf8") };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "unknown";
    return code === "ENOENT" ? { kind: "absent" } : { kind: "unreadable", code };
  }
}

export function fileJobProvider(path: string): () => { jobs: Job[]; value: Job[]; warnings: string[]; ok: boolean } {
  return () => {
    if (!existsSync(path)) return { jobs: [], value: [], warnings: [`registry file not found: ${path}`], ok: false };
    const r = readSidecar(path);
    if (r.kind === "ok") return parseJobsJson(r.text);
    const warning = r.kind === "absent" ? `registry file not found: ${path}` : `registry file unreadable: ${path} (${r.code})`;
    return { jobs: [], value: [], warnings: [warning], ok: false };
  };
}

export function fileEnabledProvider(path: string | null): () => { value: Set<string>; warnings: string[] } {
  return () => {
    if (!path || !existsSync(path)) return { value: new Set(), warnings: [] };
    const r = readSidecar(path);
    if (r.kind === "ok") return parseEnabledJson(r.text, path);
    if (r.kind === "absent") return { value: new Set(), warnings: [] };
    return { value: new Set(), warnings: [`enabled file present but unreadable: ${path} (${r.code})`] };
  };
}

export function fileTopologyProvider(path: string | null): () => { value: Topology | null; warnings: string[] } {
  return () => {
    if (!path || !existsSync(path)) return { value: null, warnings: [] };
    const r = readSidecar(path);
    if (r.kind === "ok") return parseTopologyJson(r.text, path);
    if (r.kind === "absent") return { value: null, warnings: [] };
    return { value: null, warnings: [`topology file present but unreadable: ${path} (${r.code})`] };
  };
}
