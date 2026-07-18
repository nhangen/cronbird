/**
 * Read-only status derivation for the cronbird scheduler.
 *
 * Pure, clock-injected, filesystem-free: the CLI (or any consumer) loads jobs,
 * enablement, topology, and the heartbeat, then asks this module to project a
 * {@link StatusReport}. No I/O and no product coupling — same discipline as
 * {@link ./select}. This is the substrate a `cronbird status`/`list`/`next-runs`
 * command renders, and the data any future dashboard would read.
 */
import type { CronMatcher } from "./cron";
import { selectRunnable } from "./select";
import type { Heartbeat, Job } from "./types";

export type JobHealth =
  /** `isActive === false` — the daemon never fires it. */
  | "inactive"
  /** Active, but not gated to this host (scope/enabled/owner). */
  | "not-runnable"
  /** Runnable, but the `cronSchedule` cannot be parsed — the daemon can never
   *  fire it. Dominates fire history: a broken schedule is the headline. */
  | "invalid-schedule"
  /** Runnable, valid schedule, but the heartbeat records no prior fire. */
  | "never-fired"
  /** Runnable, fired, and no scheduled slot has been missed past the grace. */
  | "ok"
  /** Runnable and fired, but a slot scheduled after the last fire is overdue
   *  past the grace window — the daemon likely missed it (outage/clock skew). */
  | "stale";

export interface JobStatus {
  name: string;
  schedule: string;
  scope: "each" | "single";
  isActive: boolean;
  /** Active AND gated to this host — i.e. the daemon would fire it here. */
  runnable: boolean;
  /** Epoch ms of the newest recorded fire, or null if never fired. */
  lastFired: number | null;
  /** Epoch ms of the next scheduled fire; null when not runnable, when the
   *  schedule never fires again, or when the expression is invalid. */
  nextFire: number | null;
  health: JobHealth;
}

export interface StatusReport {
  host: string;
  /** Epoch ms the report was computed for. */
  now: number;
  /** Epoch ms of the daemon's last heartbeat, or null if none on disk. */
  heartbeatTs: number | null;
  /** `now - heartbeatTs`, or null when there is no heartbeat. */
  heartbeatAgeMs: number | null;
  /** True when a present heartbeat is older than
   *  {@link StatusOptions.daemonHeartbeatStaleMs} — the daemon was running and
   *  stopped. A live scheduler rewrites the heartbeat every wake, so an old one
   *  means it has stopped scheduling. An absent/corrupt heartbeat (age null) is
   *  NOT stale here — that "never checked in" condition is surfaced as a CLI
   *  warning instead, avoiding a first-boot false positive. The `status` CLI
   *  turns a true value into a nonzero exit (#17). */
  daemonStale: boolean;
  /** All jobs, sorted by name. */
  jobs: JobStatus[];
}

export interface StatusOptions {
  /** A runnable, previously-fired job is "stale" when a slot scheduled after
   *  its last fire is more than this many ms in the past. Callers should set
   *  this above the daemon's wake cap so a just-woken daemon isn't flagged. */
  staleGraceMs: number;
  /** The daemon's own heartbeat is "stale" (daemon presumed dead) once it is
   *  older than this. Set above the wake cap (e.g. 2×maxSleepMs) so a just-woken
   *  daemon isn't flagged. */
  daemonHeartbeatStaleMs: number;
}

export function computeStatus<T>(args: {
  jobs: Job<T>[];
  host: string;
  enabled: Set<string>;
  owners: Record<string, string>;
  heartbeat: Heartbeat | null;
  matcher: CronMatcher;
  now: Date;
  options: StatusOptions;
}): StatusReport {
  const { jobs, host, enabled, owners, heartbeat, matcher, now, options } = args;
  const nowMs = now.getTime();
  const runnableNames = new Set(selectRunnable(jobs, host, enabled, owners).map((j) => j.name));
  const lastFiredMap = heartbeat?.last_fired ?? {};

  const jobStatuses: JobStatus[] = jobs.map((j) => {
    const runnable = runnableNames.has(j.name);
    const lf = lastFiredMap[j.name];
    const lastFired = typeof lf === "number" ? lf : null;

    let nextFire: number | null = null;
    if (runnable) {
      try {
        const nf = matcher.nextFire(j.cronSchedule, now);
        nextFire = nf ? nf.getTime() : null;
      } catch {
        nextFire = null;
      }
    }

    return {
      name: j.name,
      schedule: j.cronSchedule,
      scope: j.scope,
      isActive: j.isActive,
      runnable,
      lastFired,
      nextFire,
      health: deriveHealth(j, runnable, lastFired, matcher, nowMs, options.staleGraceMs),
    };
  });

  jobStatuses.sort((a, b) => a.name.localeCompare(b.name));

  const heartbeatTs = heartbeat?.ts ?? null;
  const heartbeatAgeMs = heartbeatTs === null ? null : nowMs - heartbeatTs;
  // "Stale" means the daemon WAS running and stopped: a present heartbeat older
  // than the threshold. An absent/corrupt heartbeat (age null) is a different
  // condition — never-started / never-checked-in — which the CLI surfaces as a
  // diagnostic warning, not a stale-daemon alert (avoids a first-boot false
  // positive). See #17.
  const daemonStale = heartbeatAgeMs !== null && heartbeatAgeMs > options.daemonHeartbeatStaleMs;
  return {
    host,
    now: nowMs,
    heartbeatTs,
    heartbeatAgeMs,
    daemonStale,
    jobs: jobStatuses,
  };
}

function deriveHealth<T>(
  job: Job<T>,
  runnable: boolean,
  lastFired: number | null,
  matcher: CronMatcher,
  nowMs: number,
  staleGraceMs: number,
): JobHealth {
  if (!job.isActive) return "inactive";
  if (!runnable) return "not-runnable";
  // An unparseable schedule is the headline regardless of fire history — it
  // never fires, so it's neither "ok" nor "stale". Checked before never-fired.
  try {
    matcher.nextFire(job.cronSchedule, new Date(nowMs));
  } catch {
    return "invalid-schedule";
  }
  if (lastFired === null) return "never-fired";
  // The schedule parsed above, so this call cannot throw.
  // The first scheduled slot strictly after the last fire; if it is already
  // overdue past the grace window, a fire was missed.
  const dueAfterLast = matcher.nextFire(job.cronSchedule, new Date(lastFired));
  if (dueAfterLast !== null && dueAfterLast.getTime() <= nowMs - staleGraceMs) return "stale";
  return "ok";
}
