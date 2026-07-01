/**
 * The perch scheduler control loop.
 *
 * Every tick: re-read the job registry, pick the jobs this host runs now, fire
 * each due one via the injected `dispatch` (a non-blocking spawn of the
 * dispatch command), write a liveness heartbeat, then sleep until the soonest
 * next fire (capped so the loop re-reads the registry and self-heals clock skew).
 *
 * All side effects are injected via {@link DaemonDeps} so the loop is tested
 * with a fake clock and recorders — no real sleeping or spawning. The
 * double-fire guard is persisted in the heartbeat and restored at startup so a
 * `Restart=always` crash inside a fire-minute does not re-run a job.
 */
import { catchUpFires } from "./catchup";
import type { CronMatcher } from "./cron";
import { dueAt, nextWake, selectRunnable } from "./select";
import type { DispatchRecord, Heartbeat, Job, Topology } from "./types";

const MINUTE_MS = 60_000;
/** How many recent dispatches to retain in the heartbeat for observability. */
const MAX_RECENT_DISPATCH = 20;

export interface DaemonDeps<T = unknown> {
  now(): Date;
  sleep(ms: number): Promise<void>;
  loadRegistry(): { jobs: Job<T>[]; warnings: string[] };
  /**
   * Per-tick read of this host's enabled each-scope jobs.
   * Returns an empty set on a torn/missing read — fail-safe, so an unreadable
   * host-local selection means "nothing enabled here", never "run everything".
   */
  loadEnabled(): Set<string>;
  /**
   * Per-tick read of the synced topology + single-scope owners.
   * Returns `null` on a torn/missing read so the loop can reuse its last-good
   * owners instead of acting on a half-written file.
   */
  loadTopology(): Topology | null;
  /** Fire-and-forget spawn of the dispatch command; must not block the loop. */
  dispatch(name: string): void;
  /** Prior heartbeat (if any) used to restore the guard across restarts. */
  readHeartbeat(): Heartbeat | null;
  writeHeartbeat(hb: Heartbeat): void;
  log(msg: string): void;
  host: string;
  matcher: CronMatcher;
  maxSleepMs: number;
  /**
   * Catch-up look-back resolver: given a job's schedule and the current `now`,
   * returns how far back a missed slot may be and still replay.
   * Production passes a per-schedule derived resolver (or a fixed window when
   * the host pins a lookback override).
   */
  resolveLookback(schedule: string, now: Date): number;
  shouldContinue(): boolean;
}

function epochMinute(when: Date): number {
  return Math.floor(when.getTime() / MINUTE_MS);
}

export async function runForever<T>(deps: DaemonDeps<T>): Promise<void> {
  const prior = deps.readHeartbeat();
  const guard = new Map<string, number>(prior ? Object.entries(prior.dispatched_minute) : []);
  const recent: DispatchRecord[] = prior ? [...prior.last_dispatch] : [];
  let lastFired: Record<string, number> = prior ? { ...prior.last_fired } : {};
  let lastGood: Job<T>[] = [];
  // Last-good topology owners. Unlike enabled (safe-empty on a torn read), topology
  // owners are authoritative cross-host state: transiently losing them would
  // de-own a single-scope job and skip a run that minute.
  // So a torn topology read reuses the previous tick's owners; enabled does not get
  // last-good because an empty enabled set is the safe (nothing-runs) default.
  let lastGoodOwners: Record<string, string> = {};

  while (deps.shouldContinue()) {
    const now = deps.now();
    const minute = epochMinute(now);

    let jobs = lastGood;
    try {
      const loaded = deps.loadRegistry();
      jobs = loaded.jobs;
      lastGood = jobs;
      for (const w of loaded.warnings) deps.log(`registry: ${w}`);
    } catch (err) {
      deps.log(`registry load failed, reusing last-good: ${err instanceof Error ? err.message : String(err)}`);
    }

    const enabled = deps.loadEnabled();
    const topology = deps.loadTopology();
    if (topology !== null) lastGoodOwners = topology.owners;
    const runnable = selectRunnable(jobs, deps.host, enabled, lastGoodOwners);
    const minuteStart = minute * MINUTE_MS;

    // Current-minute fires (live path), then catch-up fires for slots missed
    // while the daemon was down. The dueNames filter is defensive: catch-up only
    // returns slots strictly before the current minute, so it can't already
    // overlap `due` today — but it keeps a single tick from double-dispatching a
    // job if that exclusion ever changes.
    const due = dueAt(runnable, now, deps.matcher).filter((p) => guard.get(p.name) !== minute);
    const dueNames = new Set(due.map((p) => p.name));
    const catches = catchUpFires(runnable, lastFired, now, deps.matcher, (s) => deps.resolveLookback(s, now)).filter(
      (f) => !dueNames.has(f.job.name),
    );

    // Rebuild last_fired keyed by the current runnable set, which prunes removed
    // jobs. A first-seen job (or one that briefly left the runnable set
    // — draft/host-scope flip) has no baseline and initializes to now, so it is
    // treated as first-seen and never replayed: at-most-once over double-fire.
    const nextLastFired: Record<string, number> = {};
    for (const p of runnable) nextLastFired[p.name] = lastFired[p.name] ?? now.getTime();
    for (const p of due) {
      guard.set(p.name, minute);
      nextLastFired[p.name] = minuteStart;
      recent.push({ name: p.name, ts: now.getTime() });
    }
    for (const f of catches) {
      nextLastFired[f.job.name] = Math.max(nextLastFired[f.job.name] ?? 0, f.slot.getTime());
      recent.push({ name: f.job.name, ts: now.getTime() });
    }
    lastFired = nextLastFired;
    if (recent.length > MAX_RECENT_DISPATCH) recent.splice(0, recent.length - MAX_RECENT_DISPATCH);

    // Drop guard entries older than the previous minute — only the current
    // minute (and a same-minute restart) can produce a double-fire.
    for (const [name, mn] of guard) if (mn < minute - 1) guard.delete(name);

    const wake = nextWake(runnable, now, deps.matcher, deps.maxSleepMs);
    // Persist the guard and last_fired BEFORE firing. A crash between here and
    // the spawn must not re-fire on restart, so dispatch is at-most-once: a
    // crash drops a fire rather than doubling it (safer for write-tier jobs).
    deps.writeHeartbeat({
      ts: now.getTime(),
      host: deps.host,
      runnable_count: runnable.length,
      next_wake_ts: now.getTime() + wake,
      last_dispatch: [...recent],
      dispatched_minute: Object.fromEntries(guard),
      last_fired: lastFired,
    });
    for (const p of due) {
      try {
        deps.dispatch(p.name);
      } catch (err) {
        deps.log(`dispatch failed for ${p.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    for (const f of catches) {
      try {
        deps.dispatch(f.job.name);
      } catch (err) {
        deps.log(`dispatch failed for ${f.job.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await deps.sleep(wake);
  }
}
