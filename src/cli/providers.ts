import { existsSync, readFileSync } from "node:fs";
import type { Job, Topology } from "../core/index";

export function parseJobsJson(text: string): { jobs: Job[]; warnings: string[] } {
  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { jobs: [], warnings: ["registry is not valid JSON"] };
  }
  const rows = (parsed as { jobs?: unknown }).jobs;
  if (!Array.isArray(rows)) return { jobs: [], warnings: ["registry.jobs is not an array"] };
  const jobs: Job[] = [];
  for (const r of rows) {
    const o = r as Record<string, unknown>;
    if (typeof o.name !== "string" || o.name.length === 0) { warnings.push("skipped job with missing name"); continue; }
    if (typeof o.cronSchedule !== "string") { warnings.push(`skipped ${o.name}: missing cronSchedule`); continue; }
    jobs.push({
      name: o.name,
      cronSchedule: o.cronSchedule,
      isActive: o.isActive === true,
      hosts: Array.isArray(o.hosts) && o.hosts.every((h) => typeof h === "string") && o.hosts.length > 0 ? (o.hosts as string[]) : ["*"],
      scope: o.scope === "each" ? "each" : "single",
      metadata: (o.metadata ?? {}) as unknown,
    });
  }
  return { jobs, warnings };
}

export function parseEnabledJson(text: string): Set<string> {
  try {
    const a = JSON.parse(text);
    if (Array.isArray(a)) return new Set(a.filter((x) => typeof x === "string"));
  } catch { /* fall through */ }
  return new Set();
}

export function parseTopologyJson(text: string): Topology | null {
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    const hosts = o.hosts, owners = o.owners;
    if (!Array.isArray(hosts) || typeof owners !== "object" || owners === null) return null;
    const cleanOwners: Record<string, string> = {};
    for (const [k, v] of Object.entries(owners)) if (typeof v === "string") cleanOwners[k] = v;
    return { hosts: hosts.filter((h) => typeof h === "string") as string[], owners: cleanOwners };
  } catch {
    return null;
  }
}

function readIfExists(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

export function fileJobProvider(path: string): () => { jobs: Job[]; warnings: string[] } {
  return () => parseJobsJson(readFileSync(path, "utf8"));
}
export function fileEnabledProvider(path: string | null): () => Set<string> {
  return () => (path ? parseEnabledJson(readIfExists(path)) : new Set());
}
export function fileTopologyProvider(path: string | null): () => Topology | null {
  return () => (path ? parseTopologyJson(readIfExists(path)) : null);
}
