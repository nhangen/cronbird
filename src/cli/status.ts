/**
 * Read-only status subcommands for the cronbird CLI: `list`, `next-runs`,
 * `status`. Each loads the same config the daemon uses, reads the registry /
 * enabled / topology / heartbeat via the existing file providers, and renders a
 * projection of {@link computeStatus}. No scheduling, no writes.
 */
import { existsSync, readFileSync } from "node:fs";
import { computeStatus, createMatcher, explainJob, queryRunHistory, STALE_EXIT_CODE, type ExplainReport, type Heartbeat, type Job, type JobStatus, type RunRecord, type StatusReport } from "../core/index";
import { parseConfig, type CronbirdConfig } from "./config";
import { readHeartbeatFile } from "./heartbeat-file";
import { readRunHistoryFile } from "./history-file";
import { fileEnabledProvider, fileJobProvider, fileTopologyProvider } from "./providers";

const MAX_EXPLAIN_COUNT = 1000;

export type StatusSubcommand = "status" | "list" | "next-runs" | "history" | "explain";

export const STATUS_SUBCOMMANDS: ReadonlySet<string> = new Set(["status", "list", "next-runs", "history", "explain"]);

export interface StatusCliDeps {
  now: () => Date;
  out: (s: string) => void;
  err: (s: string) => void;
  env: Record<string, string | undefined>;
}

interface ParsedArgs {
  configPath: string | undefined;
  jobName: string | undefined;
  json: boolean;
  withinMs: number | null;
  job: string | undefined;
  since: number | null;
  until: number | null;
  limit: number | null;
  count: number | null;
}

/** Parse `Nd`/`Nh`/`Nm`/`Ns` into ms. Returns null on any other shape. */
function parseDuration(s: string | undefined): number | null {
  if (!s) return null;
  const m = /^(\d+)(s|m|h|d)$/.exec(s.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
  return n * unit;
}

/** Parse duration string, epoch-ms, or ISO date string into epoch-ms. */
function parseTimeFilter(s: string | undefined, nowMs: number): number | null {
  if (!s) return null;
  const trimmed = s.trim();
  const dur = parseDuration(trimmed);
  if (dur !== null) return nowMs - dur;
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isFinite(n)) return n;
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) return parsed;
  return null;
}

function usage(sub: StatusSubcommand): string {
  if (sub === "next-runs") return `usage: cronbird next-runs <config.json> [--json] [--within <dur>]\n`;
  if (sub === "history") return `usage: cronbird history <config.json> [--json] [--job <name>] [--since <time>] [--until <time>] [--limit <n>]\n`;
  if (sub === "explain") return `usage: cronbird explain <config.json> <job-name> [--json] [--count <n>]\n`;
  return `usage: cronbird ${sub} <config.json> [--json]\n`;
}

export function runStatusCommand(sub: StatusSubcommand, args: string[], deps: StatusCliDeps): number {
  const parsed = parseFlags(sub, args, deps);
  if (typeof parsed === "number") return parsed;

  let configPath = parsed.configPath ?? deps.env.CRONBIRD_CONFIG;
  let jobName = parsed.jobName;

  if (sub === "explain") {
    // Accommodate both `cronbird explain <config.json> <job-name>` and
    // `cronbird explain <job-name> <config.json>` (issue #16), as well as
    // `CRONBIRD_CONFIG=... cronbird explain <job-name>`.
    if (parsed.configPath && parsed.jobName) {
      if (parsed.jobName.endsWith(".json") && !parsed.configPath.endsWith(".json")) {
        configPath = parsed.jobName;
        jobName = parsed.configPath;
      }
    } else if (parsed.configPath && !parsed.jobName && deps.env.CRONBIRD_CONFIG) {
      if (!parsed.configPath.endsWith(".json")) {
        configPath = deps.env.CRONBIRD_CONFIG;
        jobName = parsed.configPath;
      }
    }
  }

  if (!configPath) {
    deps.err(usage(sub));
    return 2;
  }

  if (sub === "history") {
    let historyPath: string | null;
    try {
      historyPath = parseConfig(readFileSync(configPath, "utf8"), deps.env).historyPath;
    } catch (e) {
      deps.err(`config error: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
    if (historyPath === null) {
      deps.err(`error: config.historyPath is not configured in ${configPath}\n`);
      return 1;
    }
    try {
      const records = queryRunHistory(readRunHistoryFile(historyPath), {
        job: parsed.job,
        since: parsed.since ?? undefined,
        until: parsed.until ?? undefined,
        limit: parsed.limit ?? undefined,
      });
      renderHistory(records, parsed, deps);
      return 0;
    } catch (e) {
      deps.err(`error: could not read run history ${historyPath}: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
  }

  if (sub === "explain") {
    if (!jobName) {
      deps.err(`error: explain requires a job name — usage: cronbird explain <config.json> <job-name>\n`);
      return 2;
    }
    let cfg: CronbirdConfig;
    let inputs: LoadedInputs;
    try {
      cfg = parseConfig(readFileSync(configPath, "utf8"), deps.env);
      inputs = loadInputs(cfg, deps);
    } catch (e) {
      deps.err(`config error: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
    if (!inputs.registryOk) {
      deps.err(`error: registry could not be loaded from ${cfg.registryPath}\n`);
      return 1;
    }
    if (!inputs.jobs.some((j) => j.name === jobName)) {
      const skip = inputs.registryWarnings.find((w) => w.startsWith(`skipped ${jobName}: `));
      deps.err(
        skip
          ? `error: job ${JSON.stringify(jobName)} is in the registry but was skipped: ${skip.slice(`skipped ${jobName}: `.length)}\n`
          : `error: unknown job: ${JSON.stringify(jobName)} (not in registry)\n`,
      );
      return 1;
    }
    let report: ExplainReport;
    try {
      report = explainJob({
        jobs: inputs.jobs,
        name: jobName,
        host: cfg.hostname,
        enabled: inputs.enabled,
        owners: inputs.owners,
        heartbeat: inputs.heartbeat,
        matcher: createMatcher(),
        now: deps.now(),
        options: { count: parsed.count ?? 5 },
        history: inputs.history,
        sourceNotes: {
          enabled: absentSourceNote("enabled", cfg.enabledPath),
          topology: absentSourceNote("topology", cfg.topologyPath),
        },
      });
    } catch (e) {
      deps.err(`error: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
    renderExplain(report, parsed, deps);
    return 0;
  }

  let report: StatusReport;
  try {
    const cfg = parseConfig(readFileSync(configPath, "utf8"), deps.env);
    const inputs = loadInputs(cfg, deps);
    report = computeStatus({
      jobs: inputs.jobs,
      host: cfg.hostname,
      enabled: inputs.enabled,
      owners: inputs.owners,
      heartbeat: inputs.heartbeat,
      matcher: createMatcher(),
      now: deps.now(),
      // Above the wake cap so a just-woken daemon isn't flagged stale — for both
      // per-job staleness and the daemon's own heartbeat.
      options: { staleGraceMs: 2 * cfg.maxSleepMs, daemonHeartbeatStaleMs: 2 * cfg.maxSleepMs },
      history: inputs.history,
    });
  } catch (e) {
    deps.err(`config error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  render(sub, report, parsed, deps);

  // A stopped scheduler should say so without the operator parsing output: the
  // `status` health check exits nonzero (and logs a distinct alert to stderr) so
  // a monitor or the CEO swarm sees a dead daemon by exit code alone (#17).
  // `list`/`next-runs` are inventory views, not health checks — they stay exit 0.
  if (sub === "status" && report.daemonStale) {
    // daemonStale ⇒ heartbeatAgeMs is non-null (absence is a warning, not stale).
    deps.err(`ALERT: daemon heartbeat stale (${fmtRelative(-report.heartbeatAgeMs!)}) on host=${report.host} — scheduler is not running.\n`);
    return STALE_EXIT_CODE;
  }
  return 0;
}

function absentSourceNote(kind: "enabled" | "topology", path: string | null): string | undefined {
  if (path === null) return `${kind}Path is not configured`;
  if (!existsSync(path)) return `${kind} file not found: ${path}`;
  return undefined;
}

interface LoadedInputs {
  jobs: Job[];
  registryOk: boolean;
  registryWarnings: string[];
  enabled: Set<string>;
  owners: Record<string, string>;
  heartbeat: Heartbeat | null;
  history: RunRecord[] | undefined;
}

function loadInputs(cfg: CronbirdConfig, deps: StatusCliDeps): LoadedInputs {
  const registryResult = fileJobProvider(cfg.registryPath)();
  const enabledResult = fileEnabledProvider(cfg.enabledPath)();
  const topologyResult = fileTopologyProvider(cfg.topologyPath)();
  const heartbeatResult = readHeartbeatFile(cfg.heartbeatPath);

  for (const { warnings } of [registryResult, enabledResult, topologyResult, heartbeatResult]) {
    for (const w of warnings) deps.err(`warning: ${w}\n`);
  }
  let history: RunRecord[] | undefined;
  if (cfg.historyPath) {
    try {
      history = readRunHistoryFile(cfg.historyPath);
    } catch (e) {
      deps.err(`warning: could not read run history ${cfg.historyPath}: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
  return {
    jobs: registryResult.jobs,
    registryOk: registryResult.ok,
    registryWarnings: registryResult.warnings,
    enabled: enabledResult.value,
    owners: topologyResult.value?.owners ?? {},
    heartbeat: heartbeatResult.value,
    history,
  };
}

function parseFlags(sub: StatusSubcommand, args: string[], deps: StatusCliDeps): ParsedArgs | number {
  let json = false;
  let withinMs: number | null = null;
  let job: string | undefined;
  let since: number | null = null;
  let until: number | null = null;
  let limit: number | null = null;
  let count: number | null = null;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json") {
      json = true;
    } else if (a === "--within") {
      if (sub !== "next-runs") {
        deps.err(`--within is only valid for next-runs\n`);
        return 2;
      }
      const ms = parseDuration(args[++i]);
      if (ms === null) {
        deps.err(`invalid --within duration: ${JSON.stringify(args[i])} (use e.g. 30m, 2h, 1d)\n`);
        return 2;
      }
      withinMs = ms;
    } else if (a === "--job") {
      if (sub !== "history") {
        deps.err(`--job is only valid for history\n`);
        return 2;
      }
      const val = args[++i];
      if (!val || val.startsWith("--")) {
        deps.err(`missing argument for --job\n`);
        return 2;
      }
      job = val;
    } else if (a === "--since") {
      if (sub !== "history") {
        deps.err(`--since is only valid for history\n`);
        return 2;
      }
      const val = args[++i];
      const ms = parseTimeFilter(val, deps.now().getTime());
      if (ms === null) {
        deps.err(`invalid --since value: ${JSON.stringify(val)} (use e.g. 30m, 2h, or ISO timestamp)\n`);
        return 2;
      }
      since = ms;
    } else if (a === "--until") {
      if (sub !== "history") {
        deps.err(`--until is only valid for history\n`);
        return 2;
      }
      const val = args[++i];
      const ms = parseTimeFilter(val, deps.now().getTime());
      if (ms === null) {
        deps.err(`invalid --until value: ${JSON.stringify(val)} (use e.g. 30m, 2h, or ISO timestamp)\n`);
        return 2;
      }
      until = ms;
    } else if (a === "--limit") {
      if (sub !== "history") {
        deps.err(`--limit is only valid for history\n`);
        return 2;
      }
      const val = args[++i];
      const n = Number(val);
      if (!Number.isInteger(n) || n <= 0) {
        deps.err(`invalid --limit: ${JSON.stringify(val)} (must be a positive integer)\n`);
        return 2;
      }
      limit = n;
    } else if (a === "--count") {
      if (sub !== "explain") {
        deps.err(`--count is only valid for explain\n`);
        return 2;
      }
      const val = args[++i];
      const n = val === undefined || val.trim() === "" ? NaN : Number(val);
      if (!Number.isInteger(n) || n < 0 || n > MAX_EXPLAIN_COUNT) {
        deps.err(`invalid --count: ${JSON.stringify(val)} (must be an integer from 0 to ${MAX_EXPLAIN_COUNT})\n`);
        return 2;
      }
      count = n;
    } else if (a.startsWith("--")) {
      deps.err(`unknown flag: ${a}\n`);
      return 2;
    } else {
      positional.push(a);
    }
  }

  return { configPath: positional[0], jobName: positional[1], json, withinMs, job, since, until, limit, count };
}

function render(sub: StatusSubcommand, report: StatusReport, parsed: ParsedArgs, deps: StatusCliDeps): void {
  if (sub === "list") return renderList(report, parsed, deps);
  if (sub === "next-runs") return renderNextRuns(report, parsed, deps);
  return renderStatus(report, parsed, deps);
}

function fmtTs(ms: number | null): string {
  return ms === null ? "-" : new Date(ms).toISOString();
}

/** "in 1h 5m" / "2m ago" / "now". */
function fmtRelative(deltaMs: number): string {
  const past = deltaMs < 0;
  let s = Math.floor(Math.abs(deltaMs) / 1000);
  if (s < 1) return "now";
  const d = Math.floor(s / 86_400); s -= d * 86_400;
  const h = Math.floor(s / 3_600); s -= h * 3_600;
  const m = Math.floor(s / 60);
  const parts = [d && `${d}d`, h && `${h}h`, m && `${m}m`].filter(Boolean).slice(0, 2);
  const body = parts.length ? parts.join(" ") : "<1m";
  return past ? `${body} ago` : `in ${body}`;
}

function table(rows: string[][]): string {
  if (rows.length === 0) return "";
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => (r[c] ?? "").length)));
  return rows.map((r) => r.map((cell, c) => (cell ?? "").padEnd(widths[c]!)).join("  ").trimEnd()).join("\n") + "\n";
}

function renderList(report: StatusReport, parsed: ParsedArgs, deps: StatusCliDeps): void {
  if (parsed.json) {
    deps.out(JSON.stringify({ host: report.host, jobs: report.jobs.map((j) => ({
      name: j.name, schedule: j.schedule, scope: j.scope, isActive: j.isActive, runnable: j.runnable,
    })) }, null, 2) + "\n");
    return;
  }
  const rows: string[][] = [["NAME", "SCHEDULE", "SCOPE", "ACTIVE", "RUNNABLE"]];
  for (const j of report.jobs) {
    rows.push([j.name, j.schedule, j.scope, yesno(j.isActive), yesno(j.runnable)]);
  }
  deps.out(table(rows));
}

function renderNextRuns(report: StatusReport, parsed: ParsedArgs, deps: StatusCliDeps): void {
  const cutoff = parsed.withinMs === null ? Infinity : report.now + parsed.withinMs;
  const upcoming = report.jobs
    .filter((j) => j.nextFire !== null && j.nextFire <= cutoff)
    .sort((a, b) => a.nextFire! - b.nextFire!);
  if (parsed.json) {
    deps.out(JSON.stringify({ now: report.now, nextRuns: upcoming.map((j) => ({
      name: j.name, nextFire: j.nextFire, nextFireIso: fmtTs(j.nextFire),
    })) }, null, 2) + "\n");
    return;
  }
  const rows: string[][] = [["NAME", "NEXT FIRE", "IN"]];
  for (const j of upcoming) rows.push([j.name, fmtTs(j.nextFire), fmtRelative(j.nextFire! - report.now)]);
  if (upcoming.length === 0) {
    deps.out("no upcoming runs" + (parsed.withinMs !== null ? " in window" : "") + "\n");
    return;
  }
  deps.out(table(rows));
}

function renderStatus(report: StatusReport, parsed: ParsedArgs, deps: StatusCliDeps): void {
  if (parsed.json) {
    deps.out(JSON.stringify(report, null, 2) + "\n");
    return;
  }
  const hb = report.heartbeatAgeMs === null
    ? "no heartbeat on disk"
    : `heartbeat ${fmtRelative(-report.heartbeatAgeMs)}`;
  const marker = report.daemonStale ? "STALE — " : "";
  deps.out(`host=${report.host}  daemon: ${marker}${hb}\n\n`);
  const rows: string[][] = [["NAME", "SCOPE", "RUNNABLE", "LAST FIRE", "NEXT FIRE", "HEALTH"]];
  for (const j of report.jobs) {
    rows.push([
      j.name,
      j.scope,
      yesno(j.runnable),
      j.lastFired === null ? "-" : fmtRelative(j.lastFired - report.now),
      j.nextFire === null ? "-" : fmtRelative(j.nextFire - report.now),
      j.health,
    ]);
  }
  deps.out(table(rows));
}

function renderHistory(records: RunRecord[], parsed: ParsedArgs, deps: StatusCliDeps): void {
  if (parsed.json) {
    deps.out(JSON.stringify(records, null, 2) + "\n");
    return;
  }
  if (records.length === 0) {
    deps.out("no run history found" + (parsed.job ? ` for job=${parsed.job}` : "") + "\n");
    return;
  }
  const nowMs = deps.now().getTime();
  const rows: string[][] = [["JOB", "SCHEDULED", "STARTED", "DURATION", "OUTCOME", "EXIT"]];
  for (const r of records) {
    rows.push([
      r.job,
      fmtTs(r.scheduledFor),
      fmtRelative(r.startedAt - nowMs),
      r.durationMs !== null ? `${(r.durationMs / 1000).toFixed(1)}s` : "-",
      r.outcome,
      r.exitCode !== null ? String(r.exitCode) : "-",
    ]);
  }
  deps.out(table(rows));
}

function renderExplain(report: ExplainReport, parsed: ParsedArgs, deps: StatusCliDeps): void {
  if (parsed.json) {
    deps.out(JSON.stringify(report, null, 2) + "\n");
    return;
  }
  // Human-readable rendering: the headline verdict, the gate table, and the
  // fire times. The gate table is the core of #16 — it makes the opaque
  // "why didn't my job run" question one command.
  const verdict = !report.runnable ? "NOT RUNNABLE" : report.scheduleValid ? "RUNNABLE" : "RUNNABLE (schedule invalid — never fires)";
  deps.out(`job=${report.name}  host=${report.host}  ${verdict}\n\n`);
  deps.out(`schedule:       ${report.schedule}\n`);
  deps.out(`scope:          ${report.scope}\n`);
  deps.out(`active:         ${yesno(report.isActive)}\n`);
  deps.out(`schedule valid: ${yesno(report.scheduleValid)}\n`);
  if (report.scheduleError !== null) deps.out(`schedule error: ${report.scheduleError}\n`);
  deps.out(`\n`);

  const gateRows: string[][] = [["GATE", "PASSED", "REASON"]];
  for (const g of report.gates) {
    gateRows.push([g.gate, g.passed ? "yes" : "no", g.reason]);
  }
  deps.out(table(gateRows) + "\n");

  const nowMs = report.now;
  const lastFired = report.lastFired === null ? "-" : fmtRelative(report.lastFired - nowMs);
  deps.out(`last fired: ${lastFired}\n`);
  if (parsed.count === 0) {
    deps.out(`next fires: (not requested — --count 0)\n`);
  } else if (report.nextFires.length === 0) {
    deps.out(`next fires: (none — not runnable, schedule invalid, or never fires again)\n`);
  } else {
    const fireRows: string[][] = [["#", "NEXT FIRE", "IN"]];
    report.nextFires.forEach((ts, i) => {
      fireRows.push([String(i + 1), fmtTs(ts), fmtRelative(ts - nowMs)]);
    });
    deps.out(table(fireRows));
  }
}

function yesno(b: boolean): string {
  return b ? "yes" : "no";
}
