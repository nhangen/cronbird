/**
 * Pure simulation / dry-run schedule execution for cronbird.
 *
 * Fast-forwards the schedule across `[from, to]` using the pure decision functions
 * (selectRunnable, dueAt, catchUpFires, matcher.nextFire via nextWake).
 * Dispatches nothing and persists no state.
 */
import { catchUpFires, lookbackForSchedule } from "./catchup";
import { CATCHUP_LOOKBACK_CAP_MS, CATCHUP_LOOKBACK_FLOOR_MS } from "./constants";
import { createMatcher, type CronMatcher } from "./cron";
import { validateDependencies } from "./dependencies";
import { dueAt, nextWake, selectRunnable } from "./select";
import type { Heartbeat, Job } from "./types";

export interface SimulateOptions<T = unknown> {
  from: Date;
  to: Date;
  host: string;
  jobs: Job<T>[];
  enabled: Set<string>;
  owners: Record<string, string>;
  matcher?: CronMatcher;
  initialHeartbeat?: Heartbeat | null;
  initialLastFired?: Record<string, number>;
  resolveLookback?: (schedule: string, now: Date) => number;
  priority?: (job: Job<T>) => number;
  dependencies?: (job: Job<T>) => string[];
}

export interface SimulatedDispatch {
  job: string;
  time: number;
  timeIso: string;
  slotTs: number;
  type: "due" | "catchup";
}

export interface SimulationReport {
  host: string;
  from: number;
  fromIso: string;
  to: number;
  toIso: string;
  dispatches: SimulatedDispatch[];
  /** Active jobs this host doesn't run (owned elsewhere, not enabled here). Expected on multi-host setups. */
  skipped: string[];
  warnings: string[];
}

// selectRunnable and the matcher-driven helpers drop these without a trace,
// which is right for the daemon but hides exactly what a dry run is for.
function describeSkippedJobs<T>(
  options: SimulateOptions<T>,
  selected: Job<T>[],
  matcher: CronMatcher,
): { skipped: string[]; warnings: string[] } {
  const selectedNames = new Set(selected.map((j) => j.name));
  const skipped: string[] = [];
  const warnings: string[] = [];
  for (const job of options.jobs) {
    if (!job.isActive || job.cronSchedule.trim() === "") continue;
    if (!selectedNames.has(job.name)) {
      const why =
        job.scope === "each"
          ? "scope=each, not in enabled set"
          : job.scope === "single"
            ? `scope=single, owner=${options.owners[job.name] ?? "none"}`
            : `scope=${String(job.scope)}`;
      skipped.push(`${job.name}: not runnable on ${options.host} (${why})`);
      continue;
    }
    let next: Date | null;
    try {
      next = matcher.nextFire(job.cronSchedule, options.from);
    } catch {
      warnings.push(`${job.name}: invalid cron schedule ${JSON.stringify(job.cronSchedule)}`);
      continue;
    }
    if (next === null) warnings.push(`${job.name}: schedule ${JSON.stringify(job.cronSchedule)} never fires`);
  }
  return { skipped, warnings };
}

export function simulateSchedule<T = unknown>(options: SimulateOptions<T>): SimulationReport {
  const fromMs = options.from.getTime();
  const toMs = options.to.getTime();

  if (fromMs > toMs) {
    throw new RangeError("from must be before or equal to to");
  }

  const matcher = options.matcher ?? createMatcher();
  const priority = options.priority ?? (() => 0);
  const upstreamsOf = (n: string): string[] => {
    const job = options.jobs.find((x) => x.name === n);
    return job ? (options.dependencies?.(job) ?? []) : [];
  };

  const selected = selectRunnable(options.jobs, options.host, options.enabled, options.owners);
  const { invalid, warnings: depWarnings } = validateDependencies(options.jobs, upstreamsOf);
  const runnable = invalid.size ? selected.filter((j) => !invalid.has(j.name)) : selected;

  const { skipped, warnings: scheduleWarnings } = describeSkippedJobs(options, selected, matcher);
  const warnings = [...depWarnings, ...scheduleWarnings];
  const dispatches: SimulatedDispatch[] = [];

  if (runnable.length === 0) {
    return {
      host: options.host,
      from: fromMs,
      fromIso: options.from.toISOString(),
      to: toMs,
      toIso: options.to.toISOString(),
      dispatches,
      skipped,
      warnings,
    };
  }

  const resolveLookback =
    options.resolveLookback ??
    ((schedule, now) =>
      lookbackForSchedule(schedule, now, matcher, CATCHUP_LOOKBACK_FLOOR_MS, CATCHUP_LOOKBACK_CAP_MS));

  const lastFired: Record<string, number> = {
    ...(options.initialHeartbeat?.last_fired ?? {}),
    ...(options.initialLastFired ?? {}),
  };

  const startMinuteMs = Math.ceil(fromMs / 60_000) * 60_000;
  if (startMinuteMs > toMs) {
    return {
      host: options.host,
      from: fromMs,
      fromIso: options.from.toISOString(),
      to: toMs,
      toIso: options.to.toISOString(),
      dispatches,
      skipped,
      warnings,
    };
  }

  let cursor = new Date(startMinuteMs);
  let isFirstTick = true;

  while (cursor.getTime() <= toMs) {
    const currentMs = cursor.getTime();
    const minute = Math.floor(currentMs / 60_000);
    const minuteStart = minute * 60_000;

    const due = dueAt(runnable, cursor, matcher);
    const dueNames = new Set(due.map((j) => j.name));

    // Only T0 can have missed slots: from then on the simulation itself fires every slot.
    let catches: { job: Job<T>; slot: Date }[] = [];
    if (isFirstTick && Object.keys(lastFired).length > 0) {
      catches = catchUpFires(runnable, lastFired, cursor, matcher, (s) => resolveLookback(s, cursor)).filter(
        (f) => !dueNames.has(f.job.name),
      );
    }
    isFirstTick = false;

    for (const j of runnable) {
      if (lastFired[j.name] === undefined) {
        lastFired[j.name] = currentMs;
      }
    }

    const batch: SimulatedDispatch[] = [];

    for (const j of due) {
      batch.push({
        job: j.name,
        time: minuteStart,
        timeIso: new Date(minuteStart).toISOString(),
        slotTs: minuteStart,
        type: "due",
      });
      lastFired[j.name] = Math.max(lastFired[j.name] ?? 0, minuteStart);
    }

    for (const f of catches) {
      const slotMs = f.slot.getTime();
      batch.push({
        job: f.job.name,
        time: currentMs,
        timeIso: cursor.toISOString(),
        slotTs: slotMs,
        type: "catchup",
      });
      lastFired[f.job.name] = Math.max(lastFired[f.job.name] ?? 0, slotMs);
    }

    batch.sort((a, b) => {
      const jobA = runnable.find((x) => x.name === a.job)!;
      const jobB = runnable.find((x) => x.name === b.job)!;
      const prioDiff = priority(jobA) - priority(jobB);
      if (prioDiff !== 0) return prioDiff;
      return a.job.localeCompare(b.job);
    });

    for (const item of batch) {
      dispatches.push(item);
    }

    const wake = nextWake(runnable, cursor, matcher, Infinity);
    if (wake === Infinity || wake <= 0) {
      break;
    }

    const nextMs = cursor.getTime() + wake;
    if (nextMs > toMs) {
      break;
    }
    cursor = new Date(nextMs);
  }

  return {
    host: options.host,
    from: fromMs,
    fromIso: options.from.toISOString(),
    to: toMs,
    toIso: options.to.toISOString(),
    dispatches,
    skipped,
    warnings,
  };
}
