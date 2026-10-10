/**
 * `cronbird simulate` subcommand: dry-run / fast-forward the schedule across
 * `[T0, T1]`. Loads the real config and wires real file providers (catching
 * configuration faults like #10), runs pure simulation, and prints the would-dispatch
 * schedule. Dispatches nothing and writes no state to disk.
 */
import { readFileSync } from "node:fs";
import { createMatcher, simulateSchedule } from "../core/index";
import { parseConfig } from "./config";
import { fileEnabledProvider, fileJobProvider, fileTopologyProvider } from "./providers";

export interface SimulateCliDeps {
  now: () => Date;
  out: (s: string) => void;
  err: (s: string) => void;
  env: Record<string, string | undefined>;
}

interface ParsedArgs {
  configPath: string | undefined;
  json: boolean;
  fromRaw: string | undefined;
  toRaw: string | undefined;
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

/**
 * Parse time string into epoch ms.
 * Supports:
 * - "now" -> nowMs
 * - ISO timestamps (e.g. "2026-07-01T09:00:00Z")
 * - Epoch ms (e.g. "1782896400000")
 * - Signed relative durations: "+1h", "-30m"
 * - Bare durations: defaultDir indicates whether bare "1h" means past (-1) or future (+1)
 */
function parseTime(s: string | undefined, nowMs: number, defaultDir: -1 | 1): number | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (trimmed === "now") return nowMs;

  if (trimmed.startsWith("+")) {
    const dur = parseDuration(trimmed.slice(1));
    return dur !== null ? nowMs + dur : null;
  }
  if (trimmed.startsWith("-")) {
    const dur = parseDuration(trimmed.slice(1));
    return dur !== null ? nowMs - dur : null;
  }

  const dur = parseDuration(trimmed);
  if (dur !== null) {
    return nowMs + defaultDir * dur;
  }

  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isFinite(n)) return n;
  }

  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) return parsed;

  return null;
}

function usage(): string {
  return "usage: cronbird simulate <config.json> --from <time> --to <time> [--json]\n";
}

function table(rows: string[][]): string {
  if (rows.length === 0) return "";
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => (r[c] ?? "").length)));
  return rows.map((r) => r.map((cell, c) => (cell ?? "").padEnd(widths[c]!)).join("  ").trimEnd()).join("\n") + "\n";
}

export function runSimulateCommand(args: string[], deps: SimulateCliDeps): number {
  const parsed = parseFlags(args, deps);
  if (typeof parsed === "number") return parsed;

  const configPath = parsed.configPath ?? deps.env.CRONBIRD_CONFIG;
  if (!configPath || !parsed.fromRaw || !parsed.toRaw) {
    deps.err(usage());
    return 2;
  }

  const nowMs = deps.now().getTime();
  const fromMs = parseTime(parsed.fromRaw, nowMs, -1);
  if (fromMs === null) {
    deps.err(`invalid --from value: ${JSON.stringify(parsed.fromRaw)} (use ISO timestamp, epoch-ms, or duration like 1h)\n`);
    return 2;
  }

  const toMs = parseTime(parsed.toRaw, nowMs, 1);
  if (toMs === null) {
    deps.err(`invalid --to value: ${JSON.stringify(parsed.toRaw)} (use ISO timestamp, epoch-ms, or duration like 1h)\n`);
    return 2;
  }

  if (fromMs > toMs) {
    deps.err("error: --from must be before or equal to --to\n");
    return 2;
  }

  let cfg;
  try {
    cfg = parseConfig(readFileSync(configPath, "utf8"), deps.env);
  } catch (e) {
    deps.err(`config error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  const registryResult = fileJobProvider(cfg.registryPath)();
  const enabledResult = fileEnabledProvider(cfg.enabledPath)();
  const topologyResult = fileTopologyProvider(cfg.topologyPath)();

  for (const { warnings } of [registryResult, enabledResult, topologyResult]) {
    for (const w of warnings) deps.err(`warning: ${w}\n`);
  }

  // The daemon keeps running on these by falling back to last-good or an empty
  // set; a dry run has nothing to fall back to, so an empty schedule would be fiction.
  // Sidecar providers only warn when a file is present but unreadable/unparseable.
  if (!registryResult.ok || enabledResult.warnings.length > 0 || topologyResult.warnings.length > 0) {
    deps.err("config error: required input could not be loaded; simulation not run\n");
    return 1;
  }

  const report = simulateSchedule({
    from: new Date(fromMs),
    to: new Date(toMs),
    host: cfg.hostname,
    jobs: registryResult.jobs,
    enabled: enabledResult.value,
    owners: topologyResult.value?.owners ?? {},
    matcher: createMatcher(),
  });

  for (const s of report.skipped) deps.err(`skipped: ${s}\n`);
  for (const w of report.warnings) {
    deps.err(`warning: ${w}\n`);
  }

  if (parsed.json) {
    deps.out(JSON.stringify(report, null, 2) + "\n");
    return 0;
  }

  if (report.dispatches.length === 0) {
    deps.out("no dispatches in window\n");
    return 0;
  }

  const rows: string[][] = [["TIME", "JOB"]];
  for (const d of report.dispatches) {
    rows.push([d.timeIso, d.job]);
  }
  deps.out(table(rows));
  return 0;
}

function parseFlags(args: string[], deps: SimulateCliDeps): ParsedArgs | number {
  let json = false;
  let fromRaw: string | undefined;
  let toRaw: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json") {
      json = true;
    } else if (a === "--from") {
      const val = args[++i];
      if (!val || val.startsWith("--")) {
        deps.err("missing argument for --from\n");
        return 2;
      }
      fromRaw = val;
    } else if (a === "--to") {
      const val = args[++i];
      if (!val || val.startsWith("--")) {
        deps.err("missing argument for --to\n");
        return 2;
      }
      toRaw = val;
    } else if (a.startsWith("--")) {
      deps.err(`unknown flag: ${a}\n`);
      return 2;
    } else {
      positional.push(a);
    }
  }

  return { configPath: positional[0], json, fromRaw, toRaw };
}
