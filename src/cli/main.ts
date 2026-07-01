#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { createMatcher, lookbackForSchedule, runForever, type DaemonDeps } from "../core/index";
import { parseConfig } from "./config";
import { fileJobProvider, fileEnabledProvider, fileTopologyProvider } from "./providers";
import { ShellDispatcher } from "./shell-dispatcher";
import { readHeartbeatFile, writeHeartbeatFile, writeSyncedHeartbeat, writeHeartbeatWithSync } from "./heartbeat-file";

function nowStamp(): string { return new Date().toISOString(); }

async function main(): Promise<void> {
  const configPath = process.argv[2] ?? process.env.PERCH_CONFIG;
  if (!configPath) throw new Error("usage: perch <config.json> (or set PERCH_CONFIG)");
  const cfg = parseConfig(readFileSync(configPath, "utf8"), process.env);
  const log = (m: string) => process.stderr.write(`[${nowStamp()}] perch: ${m}\n`);

  let running = true;
  let wakeEarly: (() => void) | null = null;
  const stop = (sig: string) => { log(`${sig} received, shutting down`); running = false; wakeEarly?.(); };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  const matcher = createMatcher();
  const dispatcher = new ShellDispatcher(cfg.dispatchCommand, cfg.dispatchArgsTemplate, log);
  const syncedHbPath = cfg.syncedHeartbeatDir ? `${cfg.syncedHeartbeatDir}/${cfg.hostname}.json` : null;

  const deps: DaemonDeps = {
    now: () => new Date(),
    sleep: (ms) => new Promise<void>((resolve) => {
      const t = setTimeout(() => { wakeEarly = null; resolve(); }, ms);
      wakeEarly = () => { clearTimeout(t); wakeEarly = null; resolve(); };
    }),
    loadRegistry: fileJobProvider(cfg.registryPath),
    loadEnabled: fileEnabledProvider(cfg.enabledPath),
    loadTopology: fileTopologyProvider(cfg.topologyPath),
    dispatch: (name) => dispatcher.dispatch(name),
    readHeartbeat: () => readHeartbeatFile(cfg.heartbeatPath),
    writeHeartbeat: (hb) => writeHeartbeatWithSync(hb, {
      writeLocal: (h) => writeHeartbeatFile(cfg.heartbeatPath, h),
      writeSynced: syncedHbPath ? () => writeSyncedHeartbeat(syncedHbPath, cfg.hostname) : () => {},
      log,
    }),
    log,
    host: cfg.hostname,
    matcher,
    maxSleepMs: cfg.maxSleepMs,
    resolveLookback: (schedule, now) => lookbackForSchedule(schedule, now, matcher, cfg.catchupLookbackFloorMs, cfg.catchupLookbackCapMs),
    shouldContinue: () => running,
  };

  log(`started — host=${cfg.hostname} registry=${cfg.registryPath}`);
  await runForever(deps);
  log("stopped");
}

main().catch((err) => {
  process.stderr.write(`[${nowStamp()}] perch: fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
