import { hostname as osHostname } from "node:os";

export class ConfigError extends Error {}

export interface CronbirdConfig {
  hostname: string;
  registryPath: string;
  enabledPath: string | null;
  topologyPath: string | null;
  heartbeatPath: string;
  syncedHeartbeatDir: string | null;
  dispatchCommand: string[];
  dispatchArgsTemplate: string[];
  maxSleepMs: number;
  catchupLookbackFloorMs: number;
  catchupLookbackCapMs: number;
}

function expandTilde(p: string, home: string | undefined): string {
  if (!p.startsWith("~")) return p;
  if (!home) throw new ConfigError(`cannot expand '~' in path without HOME: ${p}`);
  return p.replace(/^~/, home);
}

function reqString(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  if (typeof v !== "string" || v.length === 0) throw new ConfigError(`config.${k} must be a non-empty string`);
  return v;
}

function optString(o: Record<string, unknown>, k: string): string | null {
  const v = o[k];
  if (v === null || v === undefined) return null;
  if (typeof v !== "string" || v.length === 0) throw new ConfigError(`config.${k} must be a non-empty string or null`);
  return v;
}

function reqStringArray(o: Record<string, unknown>, k: string): string[] {
  const v = o[k];
  if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== "string")) {
    throw new ConfigError(`config.${k} must be a non-empty array of strings`);
  }
  return v as string[];
}

function reqPosInt(o: Record<string, unknown>, k: string): number {
  const v = o[k];
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) throw new ConfigError(`config.${k} must be a positive integer`);
  return v;
}

export function parseConfig(raw: string, env: Record<string, string | undefined>): CronbirdConfig {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    throw new ConfigError(`config is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const home = env.HOME;
  const rawHost = reqString(o, "hostname");
  const hostname = rawHost === "auto" ? (osHostname().split(".")[0] ?? "unknown") : rawHost;
  return {
    hostname,
    registryPath: expandTilde(reqString(o, "registryPath"), home),
    enabledPath: (() => { const ep = optString(o, "enabledPath"); return ep ? expandTilde(ep, home) : null; })(),
    topologyPath: (() => { const tp = optString(o, "topologyPath"); return tp ? expandTilde(tp, home) : null; })(),
    heartbeatPath: expandTilde(reqString(o, "heartbeatPath"), home),
    syncedHeartbeatDir: (() => { const sd = optString(o, "syncedHeartbeatDir"); return sd ? expandTilde(sd, home) : null; })(),
    dispatchCommand: reqStringArray(o, "dispatchCommand"),
    dispatchArgsTemplate: reqStringArray(o, "dispatchArgsTemplate"),
    maxSleepMs: reqPosInt(o, "maxSleepMs"),
    catchupLookbackFloorMs: reqPosInt(o, "catchupLookbackFloorMs"),
    catchupLookbackCapMs: reqPosInt(o, "catchupLookbackCapMs"),
  };
}
