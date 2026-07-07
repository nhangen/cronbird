/**
 * The cronbird scheduler control loop.
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
import { MAX_CONCURRENT } from "./constants";
import type { CronMatcher } from "./cron";
import { RunQueue } from "./run-queue";
import { dueAt, nextWake, selectRunnable } from "./select";
import type { CompletionRecord, DispatchRecord, Heartbeat, Job, Topology } from "./types";

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
  /** Product-supplied precedence; lower number = higher precedence. */
  priority(job: Job<T>): number;
  /**
   * File-based run state written by the dispatch wrapper: in-flight runs
   * (`running/`) and finished runs (`done/`). Fail-safe on a torn/missing read —
   * returns empty maps so an unreadable state means "nothing runs", never
   * "run everything".
   */
  readCompletions(): { running: Record<string, number>; done: Record<string, CompletionRecord> };
}

/**
 * Cross-tick mutable state that used to live in {@link runForever}'s closure.
 * Extracted so a single tick ({@link runOneTick}) can be exercised in isolation
 * while the loop still owns the persistent queue/guard/last-good state.
 */
export interface TickState<T = unknown> {
  /** Due + catch-up jobs enqueued by priority, drained (N-capped) each tick. */
  queue: RunQueue;
  /** jobName → epoch-minute last enqueued (durable double-fire guard). */
  guard: Map<string, number>;
  /** jobName → epoch-ms of the newest slot fired (drives catch-up). */
  lastFired: Record<string, number>;
  /** Recent dispatch records retained in the heartbeat for observability. */
  recent: DispatchRecord[];
  /** Last successfully-loaded registry, reused on a torn read. */
  lastGood: Job<T>[];
  /** Last authoritative topology owners, reused on a torn topology read. */
  lastGoodOwners: Record<string, string>;
  /** jobName → slot epoch-ms of the queued entry (staleness eviction, Task 6). */
  slotTsByName: Record<string, number>;
}

function epochMinute(when: Date): number {
  return Math.floor(when.getTime() / MINUTE_MS);
}

export async function runForever<T>(deps: DaemonDeps<T>): Promise<void> {
  const prior = deps.readHeartbeat();
  // Last-good topology owners. Unlike enabled (safe-empty on a torn read), topology
  // owners are authoritative cross-host state: transiently losing them would
  // de-own a single-scope job and skip a run that minute.
  // So a torn topology read reuses the previous tick's owners; enabled does not get
  // last-good because an empty enabled set is the safe (nothing-runs) default.
  const state: TickState<T> = {
    queue: new RunQueue(),
    guard: new Map<string, number>(prior ? Object.entries(prior.dispatched_minute) : []),
    recent: prior ? [...prior.last_dispatch] : [],
    lastFired: prior ? { ...prior.last_fired } : {},
    lastGood: [],
    lastGoodOwners: {},
    slotTsByName: {},
  };

  while (deps.shouldContinue()) {
    const wake = runOneTick(deps, state);
    await deps.sleep(wake);
  }
}

/**
 * Run a single scheduler tick against the cross-tick {@link TickState}: re-read
 * the registry/topology, enqueue due + catch-up slots by priority (stamping
 * `last_fired` at ENQUEUE — a single slot owner), persist the heartbeat, then
 * drain the queue. Returns the computed wake so the caller sleeps correctly.
 *
 * Behaviour matches the former inlined loop body: dispatch stays fire-and-forget
 * and happens strictly AFTER the heartbeat write (at-most-once over double-fire).
 */
export function runOneTick<T>(deps: DaemonDeps<T>, state: TickState<T>): number {
  const now = deps.now();
  const minute = epochMinute(now);

  let jobs = state.lastGood;
  try {
    const loaded = deps.loadRegistry();
    jobs = loaded.jobs;
    state.lastGood = jobs;
    for (const w of loaded.warnings) deps.log(`registry: ${w}`);
  } catch (err) {
    deps.log(`registry load failed, reusing last-good: ${err instanceof Error ? err.message : String(err)}`);
  }

  const enabled = deps.loadEnabled();
  const topology = deps.loadTopology();
  if (topology !== null) state.lastGoodOwners = topology.owners;
  const runnable = selectRunnable(jobs, deps.host, enabled, state.lastGoodOwners);
  const minuteStart = minute * MINUTE_MS;
  const jobByName = new Map(runnable.map((j) => [j.name, j]));

  // Current-minute fires (live path), then catch-up fires for slots missed
  // while the daemon was down. The dueNames filter is defensive: catch-up only
  // returns slots strictly before the current minute, so it can't already
  // overlap `due` today — but it keeps a single tick from double-dispatching a
  // job if that exclusion ever changes.
  const due = dueAt(runnable, now, deps.matcher).filter((p) => state.guard.get(p.name) !== minute);
  const dueNames = new Set(due.map((p) => p.name));
  const catches = catchUpFires(runnable, state.lastFired, now, deps.matcher, (s) => deps.resolveLookback(s, now)).filter(
    (f) => !dueNames.has(f.job.name),
  );

  // Rebuild last_fired keyed by the current runnable set, which prunes removed
  // jobs. A first-seen job (or one that briefly left the runnable set
  // — draft/host-scope flip) has no baseline and initializes to now, so it is
  // treated as first-seen and never replayed: at-most-once over double-fire.
  const nextLastFired: Record<string, number> = {};
  for (const p of runnable) nextLastFired[p.name] = state.lastFired[p.name] ?? now.getTime();
  // ENQUEUE (not dispatch) due + catch-up slots by priority; stamp last_fired at
  // enqueue so the queued entry is the single slot owner. Draining happens after
  // the heartbeat write below.
  for (const p of due) {
    state.guard.set(p.name, minute);
    if (state.queue.enqueue(p.name, deps.priority(jobByName.get(p.name)!))) {
      nextLastFired[p.name] = minuteStart;
      state.slotTsByName[p.name] = minuteStart;
      state.recent.push({ name: p.name, ts: now.getTime() });
    }
  }
  for (const f of catches) {
    if (state.queue.enqueue(f.job.name, deps.priority(f.job))) {
      nextLastFired[f.job.name] = Math.max(nextLastFired[f.job.name] ?? 0, f.slot.getTime());
      state.slotTsByName[f.job.name] = f.slot.getTime();
      state.recent.push({ name: f.job.name, ts: now.getTime() });
    }
  }
  state.lastFired = nextLastFired;
  if (state.recent.length > MAX_RECENT_DISPATCH) state.recent.splice(0, state.recent.length - MAX_RECENT_DISPATCH);

  // Drop guard entries older than the previous minute — only the current
  // minute (and a same-minute restart) can produce a double-fire.
  for (const [name, mn] of state.guard) if (mn < minute - 1) state.guard.delete(name);

  const wake = nextWake(runnable, now, deps.matcher, deps.maxSleepMs);
  // Persist the guard and last_fired BEFORE firing. A crash between here and
  // the spawn must not re-fire on restart, so dispatch is at-most-once: a
  // crash drops a fire rather than doubling it (safer for write-tier jobs).
  deps.writeHeartbeat({
    ts: now.getTime(),
    host: deps.host,
    runnable_count: runnable.length,
    next_wake_ts: now.getTime() + wake,
    last_dispatch: [...state.recent],
    dispatched_minute: Object.fromEntries(state.guard),
    last_fired: state.lastFired,
  });

  // Drain up to MAX_CONCURRENT running jobs, highest priority first. `running`
  // is read from the wrapper's `done/`+`running/` state files, so on later ticks
  // the count reflects jobs that have actually completed — that is what advances
  // the chain. A throwing dispatch is error-isolated AND does not consume a slot
  // (a failed spawn never started a job), so one bad job can't wedge the chain.
  let runningCount = Object.keys(deps.readCompletions().running).length;
  while (runningCount < MAX_CONCURRENT) {
    const next = state.queue.dequeue();
    if (next === null) break;
    delete state.slotTsByName[next];
    try {
      deps.dispatch(next);
      runningCount++; // only a successful dispatch occupies a slot
    } catch (err) {
      deps.log(`dispatch failed for ${next}: ${err instanceof Error ? err.message : String(err)}`);
      // no increment: the failed spawn didn't start a job — keep draining.
    }
  }

  return wake;
}
