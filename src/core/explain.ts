/**
 * Read-only "why a job is/isn't runnable here" derivation for the cronbird
 * scheduler.
 *
 * Pure, clock-injected, filesystem-free: the CLI (or any consumer) loads the
 * same config, registry, enablement, topology, and heartbeat the daemon uses,
 * then asks this module to explain a single job's gating. No I/O and no
 * scheduling — same discipline as {@link ./select} and {@link ./status}.
 *
 * This is the `explain <job>` projection for issue #16: it dissolves the
 * "why didn't my job run" debugging session into one command by spelling out
 * every gate — active? scope? enabled-membership? owner match? schedule
 * validity? — plus the next N fires and the last recorded fire.
 */
import { CronExpressionError, type CronMatcher } from "./cron";
import { mergeRunRecords } from "./history";
import { selectRunnable } from "./select";
import type { Heartbeat, Job, RunRecord } from "./types";

/** A single gate the job must pass to be runnable on this host, with the
 *  gate's outcome and a human-readable reason. */
export interface ExplainGate {
  /** Stable gate id: "active" | "schedule" | "scope" | "enabled-membership" | "owner-match". */
  gate: string;
  /** Whether the job passes this gate. Always true when `applicable` is false. */
  passed: boolean;
  /** False for the scope-specific gate that does not apply to this job's scope
   *  (owner-match for an each-job, enabled-membership for a single-job). */
  applicable: boolean;
  /** Human-readable reason for the outcome. */
  reason: string;
}

export interface ExplainReport {
  name: string;
  host: string;
  /** Epoch ms the explanation was computed for. */
  now: number;
  schedule: string;
  scope: "each" | "single";
  isActive: boolean;
  /** Active, with a non-blank schedule, and gated to this host — i.e.
   *  {@link ./select.selectRunnable} would pick it. Mirrors
   *  {@link JobStatus.runnable} in ./status. */
  runnable: boolean;
  /** The ordered gates applied, and how each one went. The first failing gate
   *  (if any) is the reason the job is not runnable. */
  gates: ExplainGate[];
  /** True when the `cronSchedule` cannot be parsed. Distinct from "not
   *  runnable": a runnable job with an invalid schedule never fires. */
  scheduleValid: boolean;
  /** Why the schedule is invalid ("cronSchedule is blank" or the parser's
   *  message), or null when it parses. */
  scheduleError: string | null;
  /** Epoch ms of the newest recorded fire: heartbeat `last_fired`, else the
   *  newest run-history slot (same fallback as {@link JobStatus.lastFired}), or null. */
  lastFired: number | null;
  /** Up to `N` upcoming fire instants (epoch ms) strictly after `now`, or an
   *  empty list when not runnable / schedule invalid / never fires again. */
  nextFires: number[];
}

export interface ExplainOptions {
  /** How many upcoming fires to include (default 5). */
  count?: number;
}

/** Why the enabled set or topology owners are empty when the source file was
 *  never read (e.g. "enabledPath is not configured"). Appended to the failing
 *  gate's reason so a misconfigured path isn't mistaken for a missing entry. */
export interface ExplainSourceNotes {
  enabled?: string;
  topology?: string;
}

/**
 * Explain why `name` is or isn't runnable on `host`, and when it next fires.
 *
 * `name` must name a job in `jobs` — the caller (CLI) does the lookup and
 * erroring. The gates mirror {@link ./select.selectRunnable} exactly:
 *
 *   1. active            — `isActive === true` (invariant gate for all jobs)
 *   2. schedule          — `cronSchedule` is not blank
 *   3. scope             — the job's declared `scope` (informational)
 *   4. enabled-membership — `scope === "each"`: job is in this host's enabled set
 *   5. owner-match        — `scope === "single"`: `owners[name] === host`
 *
 * A job is runnable iff it passes gates 1, 2, and 4/5 (as applicable). Gates
 * are reported in order; a failing gate is a hard stop for the *runnable*
 * conclusion but subsequent gates are still evaluated and reported so the
 * operator sees the full picture (e.g. an inactive each-job that's also not
 * in the enabled set shows both failures).
 */
export function explainJob<T>(args: {
  jobs: Job<T>[];
  name: string;
  host: string;
  enabled: Set<string>;
  owners: Record<string, string>;
  heartbeat: Heartbeat | null;
  matcher: CronMatcher;
  now: Date;
  options?: ExplainOptions;
  history?: RunRecord[];
  sourceNotes?: ExplainSourceNotes;
}): ExplainReport {
  const { jobs, name, host, enabled, owners, heartbeat, matcher, now, options, history, sourceNotes } = args;
  const enabledNote = sourceNotes?.enabled ? ` — ${sourceNotes.enabled}` : "";
  const topologyNote = sourceNotes?.topology ? ` — ${sourceNotes.topology}` : "";
  const job = jobs.find((j) => j.name === name);
  if (!job) {
    throw new Error(`unknown job: ${JSON.stringify(name)} (not in registry)`);
  }
  const nowMs = now.getTime();

  // Gate 1: active (invariant for all jobs).
  const activeGate: ExplainGate = job.isActive
    ? { gate: "active", passed: true, applicable: true, reason: "job is active" }
    : { gate: "active", passed: false, applicable: true, reason: "job is inactive (isActive === false) — the daemon never fires it" };

  const scheduleGate: ExplainGate = job.cronSchedule.trim() === ""
    ? { gate: "schedule", passed: false, applicable: true, reason: "cronSchedule is blank — the daemon skips jobs with no schedule" }
    : { gate: "schedule", passed: true, applicable: true, reason: `schedule is ${JSON.stringify(job.cronSchedule)}` };

  // Gate 2: scope (informational — the job's declared intent).
  const scopeGate: ExplainGate = {
    gate: "scope",
    passed: true,
    applicable: true,
    reason: `scope is "${job.scope}"` + (job.scope === "single" ? " (runs only on its owner)" : " (runs on every host that enables it)"),
  };

  // Gates 3/4: the scope-specific gate. Both are evaluated for reporting, but
  // only the scope-applicable one is authoritative for the runnable conclusion.
  const enabledGate: ExplainGate =
    enabled.has(job.name)
      ? { gate: "enabled-membership", passed: true, applicable: true, reason: `job is in this host's enabled set (${JSON.stringify(host)})` }
      : { gate: "enabled-membership", passed: false, applicable: true, reason: `job is NOT in this host's enabled set (${JSON.stringify(host)})${enabledNote}` };
  const ownerGate: ExplainGate = (() => {
    const owner = owners[job.name];
    if (owner === undefined) {
      return { gate: "owner-match", passed: false, applicable: true, reason: `no owner declared for this job in topology.owners${topologyNote}` };
    }
    return owner === host
      ? { gate: "owner-match", passed: true, applicable: true, reason: `owner is ${JSON.stringify(owner)} (this host)` }
      : { gate: "owner-match", passed: false, applicable: true, reason: `owner is ${JSON.stringify(owner)} (not this host ${JSON.stringify(host)})` };
  })();

  const runnable = selectRunnable([job], host, enabled, owners).length === 1;

  // Report the gates in the order they apply for this job's scope. The
  // scope-applicable gate is authoritative; the scope-inapplicable one is
  // included with `passed: true` and a "not applicable" reason so the operator
  // sees the full state (e.g. an each-job that also happens to have an owner
  // entry) without it reading as a failure.
  const gates: ExplainGate[] = [activeGate, scheduleGate, scopeGate];
  const naEnabled: ExplainGate = { gate: "enabled-membership", passed: true, applicable: false, reason: "not applicable — scope is \"single\" (gated by owner-match)" };
  const naOwner: ExplainGate = { gate: "owner-match", passed: true, applicable: false, reason: "not applicable — scope is \"each\" (gated by enabled-membership)" };
  if (job.scope === "each") {
    gates.push(enabledGate, naOwner);
  } else {
    gates.push(ownerGate, naEnabled);
  }

  // Schedule validity (distinct from runnable — a runnable job with a broken
  // schedule never fires; this is the "invalid-schedule" health in ./status).
  let scheduleError: string | null = null;
  if (job.cronSchedule.trim() === "") {
    scheduleError = "cronSchedule is blank";
  } else {
    try {
      matcher.nextFire(job.cronSchedule, now);
    } catch (e) {
      if (!(e instanceof CronExpressionError)) throw e;
      scheduleError = e.message;
    }
  }
  const scheduleValid = scheduleError === null;

  // Next N fires, strictly after `now`. Only computed when runnable AND the
  // schedule parses — otherwise the daemon can't fire it on this host anyway.
  const count = Math.max(0, options?.count ?? 5);
  const nextFires: number[] = [];
  if (runnable && scheduleValid) {
    let cursor: Date = now;
    for (let i = 0; i < count; i++) {
      const next = matcher.nextFire(job.cronSchedule, cursor);
      if (next === null) break;
      nextFires.push(next.getTime());
      cursor = next;
    }
  }

  const lastFiredRaw = heartbeat?.last_fired?.[job.name];
  let lastFired = typeof lastFiredRaw === "number" ? lastFiredRaw : null;
  if (lastFired === null && history) {
    for (const r of mergeRunRecords(history.filter((h) => h.job === job.name))) {
      if (lastFired === null || r.scheduledFor > lastFired) lastFired = r.scheduledFor;
    }
  }

  return {
    name: job.name,
    host,
    now: nowMs,
    schedule: job.cronSchedule,
    scope: job.scope,
    isActive: job.isActive,
    runnable,
    gates,
    scheduleValid,
    scheduleError,
    lastFired,
    nextFires,
  };
}
