/**
 * Pure simulation / dry-run schedule execution for cronbird.
 *
 * Fast-forwards the schedule across `[from, to]` using the pure decision functions
 * (selectRunnable, dueAt, catchUpFires, matcher.nextFire via nextWake).
 * Dispatches nothing and persists no state.
 */
import { catchUpFires, lookbackForSchedule } from "./catchup";
import { CATCHUP_LOOKBACK_CAP_MS, CATCHUP_LOOKBACK_FLOOR_MS } from "./constants";
import { createMatcher, createJobMatcherResolver, type CronMatcher, type JobMatcherResolver } from "./cron";
import { validateDependencies } from "./dependencies";
import { classifyMatcherError, dueAt, nextWake, selectRunnable, type MatcherFaultHandlers } from "./select";
import type { Heartbeat, Job } from "./types";

export interface SimulateOptions<T = unknown> {
  from: Date;
  to: Date;
  host: string;
  jobs: Job<T>[];
  enabled: Set<string>;
  owners: Record<string, string>;
  /** Resolver for per-job matchers; takes precedence over `matcher` when provided. */
  matcherResolver?: JobMatcherResolver;
  /** Default matcher for jobs without a timezone. Shortcut for passing a resolver via `matcherResolver`. */
  matcher?: CronMatcher;
  initialHeartbeat?: Heartbeat | null;
  initialLastFired?: Record<string, number>;
  resolveLookback?: (job: Job<T>, now: Date) => number;
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
  resolve: (job: Job<T>) => CronMatcher,
  warnedInvalid: Set<string>,
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
      const m = resolve(job);
      next = m.nextFire(job.cronSchedule, options.from);
    } catch (err) {
      if (classifyMatcherError(err) === "internal") {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`simulate: internal matcher error for ${job.name} (schedule ${JSON.stringify(job.cronSchedule)}): ${msg}`);
      }
      warnedInvalid.add(job.name);
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

  const defaultMatcher = options.matcher ?? createMatcher();
  const resolver = options.matcherResolver ?? createJobMatcherResolver(defaultMatcher);
  const priority = options.priority ?? (() => 0);
  const upstreamsOf = (n: string): string[] => {
    const job = options.jobs.find((x) => x.name === n);
    return job ? (options.dependencies?.(job) ?? []) : [];
  };

  const selected = selectRunnable(options.jobs, options.host, options.enabled, options.owners);
  const { invalid, warnings: depWarnings } = validateDependencies(options.jobs, upstreamsOf);
  const runnable = invalid.size ? selected.filter((j) => !invalid.has(j.name)) : selected;

  const warnedInvalid = new Set<string>();
  const { skipped, warnings: scheduleWarnings } = describeSkippedJobs(options, selected, (job) => resolver.resolve(job), warnedInvalid);
  const warnings = [...depWarnings, ...scheduleWarnings];
  const dispatches: SimulatedDispatch[] = [];

  // Matcher faults during the fast-forward: invalid schedules are surfaced as
  // warnings (a dry run exists to show them, and the per-tick loop would
  // otherwise re-warn every minute); unexpected matcher errors (probe
  // exhaustion, engine failures, an injected matcher throwing) abort the run —
  // a dry run that silently drops a job's fires would be exactly the "not due"
  // lie the daemon must not tell (#72). `warnedInvalid` is seeded by the
  // pre-start probe so a job it already reported is not warned about twice.
  const matcherFaults: MatcherFaultHandlers = {
    onInvalid: (job, error) => {
      if (warnedInvalid.has(job.name)) return;
      warnedInvalid.add(job.name);
      warnings.push(`${job.name}: invalid cron schedule ${JSON.stringify(job.cronSchedule)} (${error.message})`);
    },
    onInternalError: (job, error) => {
      throw new Error(`simulate: internal matcher error for ${job.name} (schedule ${JSON.stringify(job.cronSchedule)}): ${error.message}`);
    },
  };

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
    ((job, now) =>
      lookbackForSchedule(job.cronSchedule, now, resolver.resolve(job), CATCHUP_LOOKBACK_FLOOR_MS, CATCHUP_LOOKBACK_CAP_MS));

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

    const due = dueAt(runnable, cursor, (p) => resolver.resolve(p), matcherFaults);
    const dueNames = new Set(due.map((j) => j.name));

    // Only T0 can have missed slots: from then on the simulation itself fires every slot.
    let catches: { job: Job<T>; slot: Date }[] = [];
    if (isFirstTick && Object.keys(lastFired).length > 0) {
      catches = catchUpFires(runnable, lastFired, cursor, (p) => resolver.resolve(p), (p) => resolveLookback(p, cursor), matcherFaults).filter(
        (f) => !dueNames.has(f.job.name),
      );
    }
    isFirstTick = false;

    const batch: SimulatedDispatch[] = [];

    for (const j of due) {
      batch.push({
        job: j.name,
        time: minuteStart,
        timeIso: new Date(minuteStart).toISOString(),
        slotTs: minuteStart,
        type: "due",
      });
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

    const wake = nextWake(runnable, cursor, (p) => resolver.resolve(p), Infinity, matcherFaults);
    if (wake === Infinity) {
      break;
    }
    // The built-in matcher always advances; an injected one that doesn't would stall the cursor forever.
    if (wake <= 0) {
      throw new Error(
        `simulate: matcher returned a next fire at or before ${cursor.toISOString()} for jobs ${runnable
          .map((j) => j.name)
          .join(", ")}; CronMatcher.nextFire must return an instant strictly after 'from'`,
      );
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
