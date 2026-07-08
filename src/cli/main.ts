#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { createMatcher, lookbackForSchedule, runForever, type DaemonDeps } from "../core/index";
import { parseConfig } from "./config";
import { fileJobProvider, fileEnabledProvider, fileTopologyProvider } from "./providers";
import { ShellDispatcher } from "./shell-dispatcher";
import { readHeartbeatFile, writeHeartbeatFile, writeSyncedHeartbeat, writeHeartbeatWithSync } from "./heartbeat-file";
import { runStatusCommand, STATUS_SUBCOMMANDS, type StatusSubcommand } from "./status";
import { HELP_TOKENS, usageText } from "./usage";

function nowStamp(): string { return new Date().toISOString(); }

async function main(): Promise<void> {
  const first = process.argv[2];

  // `help` / `--help` / `-h` → usage on stdout, exit 0.
  if (first !== undefined && HELP_TOKENS.has(first)) {
    process.stdout.write(usageText());
    process.exit(0);
  }
  // No args → the binary is self-describing: usage on stderr, exit 2. (A
  // config path as argv[2] still runs the daemon below — unchanged.)
  if (first === undefined) {
    process.stderr.write(usageText());
    process.exit(2);
  }

  // Read-only subcommands (status/list/next-runs) route before the daemon.
  // With no subcommand, argv[2] is the config path and the daemon runs — the
  // launchd/systemd entrypoint (`cronbird <config>`) is unchanged.
  const sub = first;
  if (sub && STATUS_SUBCOMMANDS.has(sub)) {
    const code = runStatusCommand(sub as StatusSubcommand, process.argv.slice(3), {
      now: () => new Date(),
      out: (s) => process.stdout.write(s),
      err: (s) => process.stderr.write(s),
      env: process.env,
    });
    process.exit(code);
  }

  const configPath = process.argv[2] ?? process.env.CRONBIRD_CONFIG;
  if (!configPath) throw new Error("usage: cronbird <config.json> (or set CRONBIRD_CONFIG)");
  const cfg = parseConfig(readFileSync(configPath, "utf8"), process.env);
  const log = (m: string) => process.stderr.write(`[${nowStamp()}] cronbird: ${m}\n`);

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
    // Product precedence resolver. No priority source is wired yet, so all jobs
    // share precedence 0 (FIFO) — identical ordering to the pre-queue dispatch.
    priority: () => 0,
    // No dependency resolver wired yet: every job has zero upstreams, so the
    // eligibility gate is a no-op and behavior matches the pre-dependency chain.
    // The CEO layer will read `dependsOn` frontmatter here.
    dependencies: () => [],
    // File-based run state written by the dispatch wrapper (separate plan). Until
    // that wrapper lands, the fail-safe empty read means "nothing running", so the
    // queue drains every tick — identical to the prior fire-and-forget dispatch.
    readCompletions: () => ({ running: {}, done: {} }),
    // Cooldown gate. 0 = no cooldown until the product resolver (reads each job's
    // cooldown_seconds metadata) is wired alongside the dispatch wrapper — keeps
    // current behavior (no cooldown enforced in the engine yet).
    cooldownSeconds: () => 0,
  };

  log(`started — host=${cfg.hostname} registry=${cfg.registryPath}`);
  await runForever(deps);
  log("stopped");
}

main().catch((err) => {
  process.stderr.write(`[${nowStamp()}] cronbird: fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
