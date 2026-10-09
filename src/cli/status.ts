/**
 * Read-only status subcommands for the cronbird CLI: `list`, `next-runs`,
 * `status`. Each loads the same config the daemon uses, reads the registry /
 * enabled / topology / heartbeat via the existing file providers, and renders a
 * projection of {@link computeStatus}. No scheduling, no writes.
 */
import { existsSync, readFileSync } from "node:fs";
import { computeStatus, createMatcher, queryRunHistory, STALE_EXIT_CODE, type JobStatus, type RunRecord, type StatusReport } from "../core/index";
import { parseConfig } from "./config";
import { readHeartbeatFile } from "./heartbeat-file";
import { readRunHistoryFile } from "./history-file";
import { fileEnabledProvider, fileJobProvider, fileTopologyProvider } from "./providers";

export type StatusSubcommand = "status" | "list" | "next-runs" | "history";

export const STATUS_SUBCOMMANDS: ReadonlySet<string> = new Set(["status", "list", "next-runs", "history"]);

export interface StatusCliDeps {
  now: () => Date;
  out: (s: string) => void;
  err: (s: string) => void;
  env: Record<string, string | undefined>;
}

interface ParsedArgs {
  configPath: string | undefined;
  json: boolean;
  withinMs: number | null;
  job: string | undefined;
  since: number | null;
  until: number | null;
  limit: number | null;
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
  return `usage: cronbird ${sub} <config.json> [--json]\n`;
}

export function runStatusCommand(sub: StatusSubcommand, args: string[], deps: StatusCliDeps): number {
  const parsed = parseFlags(sub, args, deps);
  if (typeof parsed === "number") return parsed;

  const configPath = parsed.configPath ?? deps.env.CRONBIRD_CONFIG;
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

  let report: StatusReport;
  try {
    const cfg = parseConfig(readFileSync(configPath, "utf8"), deps.env);
    const { jobs, warnings } = fileJobProvider(cfg.registryPath)();
    // Surface registry parse warnings (missing file, corrupt JSON, skipped
    // rows) — a status tool that prints an empty table on a broken registry
    // is indistinguishable from "no jobs". Diagnostic, not fatal: still exit 0.
    for (const w of warnings) deps.err(`warning: ${w}\n`);
    const enabled = fileEnabledProvider(cfg.enabledPath)();
    // A sidecar that exists but reads as null/absent is corrupt — warn rather
    // than silently rendering it as "not-runnable" / "no heartbeat", which
    // would masquerade as a different (daemon) problem. Same rationale as the
    // registry warnings above; the enabled-set corruption case (empty-set is
    // ambiguous with a valid empty list) is tracked separately as a follow-up.
    const topology = fileTopologyProvider(cfg.topologyPath)();
    if (cfg.topologyPath && topology === null && existsSync(cfg.topologyPath)) {
      deps.err(`warning: topology file present but unparseable: ${cfg.topologyPath}\n`);
    }
    const heartbeat = readHeartbeatFile(cfg.heartbeatPath);
    if (heartbeat === null && existsSync(cfg.heartbeatPath)) {
      deps.err(`warning: heartbeat file present but unparseable: ${cfg.heartbeatPath}\n`);
    }
    let history: RunRecord[] | undefined;
    if (cfg.historyPath) {
      try {
        history = readRunHistoryFile(cfg.historyPath);
      } catch (e) {
        deps.err(`warning: could not read run history ${cfg.historyPath}: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    }
    report = computeStatus({
      jobs,
      host: cfg.hostname,
      enabled,
      owners: topology?.owners ?? {},
      heartbeat,
      matcher: createMatcher(),
      now: deps.now(),
      // Above the wake cap so a just-woken daemon isn't flagged stale — for both
      // per-job staleness and the daemon's own heartbeat.
      options: { staleGraceMs: 2 * cfg.maxSleepMs, daemonHeartbeatStaleMs: 2 * cfg.maxSleepMs },
      history,
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

function parseFlags(sub: StatusSubcommand, args: string[], deps: StatusCliDeps): ParsedArgs | number {
  let json = false;
  let withinMs: number | null = null;
  let job: string | undefined;
  let since: number | null = null;
  let until: number | null = null;
  let limit: number | null = null;
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
    } else if (a.startsWith("--")) {
      deps.err(`unknown flag: ${a}\n`);
      return 2;
    } else {
      positional.push(a);
    }
  }

  return { configPath: positional[0], json, withinMs, job, since, until, limit };
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

function yesno(b: boolean): string {
  return b ? "yes" : "no";
}
