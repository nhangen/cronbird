import { hostname as osHostname } from "node:os";

export class ConfigError extends Error {}

export interface CronbirdConfig {
  hostname: string;
  registryPath: string;
  enabledPath: string | null;
  topologyPath: string | null;
  heartbeatPath: string;
  syncedHeartbeatDir: string | null;
  lockPath: string | null;
  historyPath: string | null;
  maxHistoryRecords: number | null;
  historyRetentionMs: number | null;
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

// dispatchArgsTemplate must carry an exact "{job}" element: ShellDispatcher.argv
// substitutes the job name only for an element strictly === "{job}", so a
// template without it (or with {job} embedded in a larger string) would dispatch
// every job with identical, name-less argv — silent wrong-job dispatch (#11).
function reqDispatchArgsTemplate(o: Record<string, unknown>): string[] {
  const v = reqStringArray(o, "dispatchArgsTemplate");
  if (!v.includes("{job}")) {
    throw new ConfigError(
      'config.dispatchArgsTemplate must include a "{job}" element — the dispatcher ' +
        'substitutes the job name only for an exact "{job}" token, so a template without ' +
        "it dispatches every job with identical, name-less argv",
    );
  }
  return v;
}

function reqPosInt(o: Record<string, unknown>, k: string): number {
  const v = o[k];
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) throw new ConfigError(`config.${k} must be a positive integer`);
  return v;
}

function optPosInt(o: Record<string, unknown>, k: string): number | null {
  const v = o[k];
  if (v === null || v === undefined) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) throw new ConfigError(`config.${k} must be a positive integer or null`);
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
  const heartbeatPath = expandTilde(reqString(o, "heartbeatPath"), home);
  return {
    hostname,
    registryPath: expandTilde(reqString(o, "registryPath"), home),
    enabledPath: (() => { const ep = optString(o, "enabledPath"); return ep ? expandTilde(ep, home) : null; })(),
    topologyPath: (() => { const tp = optString(o, "topologyPath"); return tp ? expandTilde(tp, home) : null; })(),
    heartbeatPath,
    syncedHeartbeatDir: (() => { const sd = optString(o, "syncedHeartbeatDir"); return sd ? expandTilde(sd, home) : null; })(),
    lockPath: (() => {
      if (o.lockPath === null) return null;
      if (o.lockPath === undefined) return `${heartbeatPath}.lock`;
      const lp = optString(o, "lockPath");
      return lp ? expandTilde(lp, home) : null;
    })(),
    historyPath: (() => { const hp = optString(o, "historyPath"); return hp ? expandTilde(hp, home) : null; })(),
    maxHistoryRecords: optPosInt(o, "maxHistoryRecords"),
    historyRetentionMs: optPosInt(o, "historyRetentionMs"),
    dispatchCommand: reqStringArray(o, "dispatchCommand"),
    dispatchArgsTemplate: reqDispatchArgsTemplate(o),
    maxSleepMs: reqPosInt(o, "maxSleepMs"),
    catchupLookbackFloorMs: reqPosInt(o, "catchupLookbackFloorMs"),
    catchupLookbackCapMs: reqPosInt(o, "catchupLookbackCapMs"),
  };
}
