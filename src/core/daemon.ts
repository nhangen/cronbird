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
import { FATAL_EXIT_CODE, MAX_ATTEMPTS, MAX_CONCURRENT } from "./constants";
import type { CronMatcher } from "./cron";
import { failedJobs, isEligible, transitiveUpstreamFailed, validateDependencies } from "./dependencies";
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
   * Product-supplied upstream job names this job depends on. A dependent is
   * dispatched only after every upstream has succeeded since the dependent last
   * ran; when an upstream finally fails, the dependent is cascade-cancelled.
   * Default resolver returns `[]` (no dependencies).
   */
  dependencies(job: Job<T>): string[];
  /**
   * File-based run state written by the dispatch wrapper: in-flight runs
   * (`running/`) and finished runs (`done/`). Fail-safe on a torn/missing read —
   * returns empty maps so an unreadable state means "nothing runs", never
   * "run everything".
   */
  readCompletions(): { running: Record<string, number>; done: Record<string, CompletionRecord> };
  /**
   * Product-supplied per-job cooldown in seconds. A job whose last completion
   * (from `readCompletions().done`) is more recent than its cooldown is NOT
   * enqueued — cronbird is the single owner of the cooldown gate, so a job is
   * never dispatched into a downstream cooldown-skip that would look like a
   * clean success. Default resolver returns 0 (no cooldown).
   */
  cooldownSeconds(job: Job<T>): number;
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
  /** jobName → consecutive failures since last success (retry counter). */
  attempts: Record<string, number>;
  /** jobName → epoch-ms last dispatched (drives dependency eligibility). */
  lastRun: Record<string, number>;
  /** jobName → epoch-ms of last exit-0 completion. */
  lastSuccess: Record<string, number>;
  /** jobName → done.ts already accounted for, so a completion is processed once. */
  processedCompletionTs: Record<string, number>;
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
  const queue = new RunQueue();
  for (const e of prior?.queue ?? []) queue.enqueue(e.name, e.priority);
  const state: TickState<T> = {
    queue,
    guard: new Map<string, number>(prior ? Object.entries(prior.dispatched_minute) : []),
    recent: prior ? [...prior.last_dispatch] : [],
    lastFired: prior ? { ...prior.last_fired } : {},
    lastGood: [],
    lastGoodOwners: {},
    slotTsByName: prior ? Object.fromEntries((prior.queue ?? []).map((e) => [e.name, e.slotTs])) : {},
    attempts: prior ? { ...prior.attempts } : {},
    lastRun: prior ? { ...prior.last_run } : {},
    lastSuccess: prior ? { ...prior.last_success } : {},
    // Seed from the persisted last_completed: the restored attempts/lastSuccess
    // already account for those completions, so re-reading the same done/ files
    // on restart must NOT re-count them. Only a completion newer than what the
    // heartbeat recorded is fresh.
    processedCompletionTs: prior
      ? Object.fromEntries(Object.entries(prior.last_completed).map(([n, r]) => [n, r.ts]))
      : {},
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
  const selected = selectRunnable(jobs, deps.host, enabled, state.lastGoodOwners);

  // Upstream resolver over the full loaded registry — shared by dependency
  // validation (here), the cascade, and the eligibility gate. Uses `jobs` (not
  // the runnable subset) so an edge to an off-host/disabled job still resolves.
  const upstreamsOf = (n: string): string[] => {
    const job = jobs.find((x) => x.name === n);
    return job ? deps.dependencies(job) : [];
  };
  // Reject dependency cycles and edges to unknown jobs at load: fail the whole
  // job (exclude from runnable), not just the edge — a dropped edge would let a
  // dependent run before an upstream that can never satisfy it. Validate over the
  // FULL registry, not the runnable subset: an edge to a temporarily disabled /
  // off-host / inactive but registered job is NOT an unknown-edge error (the
  // eligibility gate handles a legitimately-absent upstream at runtime).
  const { invalid, warnings: depWarnings } = validateDependencies(jobs, upstreamsOf);
  for (const w of depWarnings) deps.log(`dependency: ${w}`);
  const runnable = invalid.size ? selected.filter((j) => !invalid.has(j.name)) : selected;

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
  // Read run state once per tick: drives completion processing, the cooldown
  // gate (below), and the drain.
  const completions = deps.readCompletions();

  // Process fresh completions (done.ts newer than what we've accounted for):
  // a success resets the retry counter and stamps last_success; a failure
  // consumes an attempt and re-enqueues at the back of the line, until the
  // MAX_ATTEMPTS-th failure marks the job failed (no requeue). A fatal exit code
  // fails fast to the cap. Runs before the cascade so a job hitting the cap this
  // tick lands in the failed set that cancels its dependents this same tick.
  for (const [name, rec] of Object.entries(completions.done)) {
    if (rec.ts <= (state.processedCompletionTs[name] ?? 0)) continue; // already accounted for
    state.processedCompletionTs[name] = rec.ts;
    if (rec.exitCode === 0) {
      state.lastSuccess[name] = rec.ts;
      state.attempts[name] = 0;
      continue;
    }
    state.attempts[name] = rec.exitCode === FATAL_EXIT_CODE ? MAX_ATTEMPTS : (state.attempts[name] ?? 0) + 1;
    if (state.attempts[name]! < MAX_ATTEMPTS) {
      const job = jobByName.get(name) ?? jobs.find((x) => x.name === name);
      if (job) state.queue.enqueue(name, deps.priority(job)); // back of line (dedup-safe)
      deps.log(`retry ${name} (attempt ${state.attempts[name]}/${MAX_ATTEMPTS})`);
    } else {
      deps.log(`failed ${name} (gave up after ${MAX_ATTEMPTS} attempts)`);
    }
  }

  // A job whose last completion is within its cooldown is skipped at enqueue —
  // cronbird owns the cooldown gate (single scheduler of truth), so nothing is
  // dispatched into a downstream cooldown-skip that would read as success.
  const withinCooldown = (job: Job<T>): boolean => {
    const done = completions.done[job.name];
    return done !== undefined && now.getTime() - done.ts < deps.cooldownSeconds(job) * 1000;
  };
  // ENQUEUE (not dispatch) due + catch-up slots by priority; stamp last_fired at
  // enqueue so the queued entry is the single slot owner. Draining happens after
  // the heartbeat write below.
  for (const p of due) {
    state.guard.set(p.name, minute);
    const job = jobByName.get(p.name)!;
    if (withinCooldown(job)) {
      deps.log(`cooldown skip ${p.name}`);
      continue;
    }
    if (state.queue.enqueue(p.name, deps.priority(job))) {
      // A fresh scheduled slot is a new cycle → restore the full three-strikes
      // budget. Without this, a recurring job that once exhausted its retries
      // stays at the cap forever and gets only a single attempt per later slot,
      // and a since-recovered upstream keeps cascade-cancelling its dependents.
      state.attempts[p.name] = 0;
      nextLastFired[p.name] = minuteStart;
      state.slotTsByName[p.name] = minuteStart;
      state.recent.push({ name: p.name, ts: now.getTime() });
    }
  }
  for (const f of catches) {
    if (withinCooldown(f.job)) {
      deps.log(`cooldown skip ${f.job.name}`);
      continue;
    }
    if (state.queue.enqueue(f.job.name, deps.priority(f.job))) {
      state.attempts[f.job.name] = 0; // fresh (missed) slot → fresh retry budget
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

  // Cascade: derive the failed set from persisted state, then drop any queued
  // job whose (transitive) upstream has finally failed. Pure function of state,
  // so a crash mid-cascade re-derives the same decision next tick. Under N=1 a
  // dependent is never mid-run when its upstream fails, so this only touches
  // queued entries — never a live process.
  // Domain is every job with a retry counter — a failed upstream is usually NOT
  // itself queued, so deriving the failed set from queued names alone would miss
  // it. Only jobs at the attempt cap can be "failed", so attempts keys suffice.
  const failed = failedJobs(Object.keys(state.attempts), state.attempts, completions.done, MAX_ATTEMPTS);
  for (const e of state.queue.snapshot()) {
    if (transitiveUpstreamFailed(e.name, upstreamsOf, failed)) {
      state.queue.remove(e.name);
      delete state.slotTsByName[e.name];
      deps.log(`cascade-cancel ${e.name} (upstream failed)`);
    }
  }

  const wake = nextWake(runnable, now, deps.matcher, deps.maxSleepMs);

  // SELECT the drain set up to MAX_CONCURRENT, highest priority first among the
  // dependency-eligible. `running` comes from the wrapper's `done/`+`running/`
  // state, so the count reflects jobs that have actually completed — that is what
  // advances the chain. Blocked entries stay queued (liveness: a tick with only
  // blocked jobs idles and re-evaluates next tick), so an independent job drains
  // past a waiting dependent.
  //
  // Selection removes the chosen jobs from the queue and stamps `lastRun` BEFORE
  // the heartbeat write, so the persisted queue excludes them. This is the
  // at-most-once boundary: a crash after the write but before (or during) the
  // spawn drops the fire rather than doubling it — the restored queue no longer
  // lists a job we committed to spawning. Persist-before-spawn, queue-minus-drain.
  const toDispatch: string[] = [];
  let runningCount = Object.keys(completions.running).length;
  while (runningCount + toDispatch.length < MAX_CONCURRENT) {
    const candidate = state.queue
      .snapshot()
      .find((e) => isEligible(e.name, upstreamsOf(e.name), state.lastSuccess, state.lastRun));
    if (candidate === undefined) break;
    // Evict a slot older than its schedule's catch-up look-back: don't run a
    // stale 3am slot at noon. Retry re-enqueues carry no slotTsByName entry, so
    // they default to `now` and are never stale. Eviction removes and continues,
    // so it never wedges the chain — the next eligible entry is picked.
    const slotTs = state.slotTsByName[candidate.name] ?? now.getTime();
    const schedule = jobByName.get(candidate.name)?.cronSchedule ?? "";
    if (now.getTime() - slotTs > deps.resolveLookback(schedule, now)) {
      state.queue.remove(candidate.name);
      delete state.slotTsByName[candidate.name];
      deps.log(`evicted stale slot ${candidate.name} (age ${now.getTime() - slotTs}ms)`);
      continue;
    }
    state.queue.remove(candidate.name);
    delete state.slotTsByName[candidate.name];
    state.lastRun[candidate.name] = now.getTime();
    toDispatch.push(candidate.name);
  }

  deps.writeHeartbeat({
    ts: now.getTime(),
    host: deps.host,
    runnable_count: runnable.length,
    next_wake_ts: now.getTime() + wake,
    last_dispatch: [...state.recent],
    dispatched_minute: Object.fromEntries(state.guard),
    last_fired: state.lastFired,
    queue: state.queue.snapshot().map((e) => ({ ...e, slotTs: state.slotTsByName[e.name] ?? now.getTime() })),
    running: completions.running,
    last_completed: completions.done,
    attempts: state.attempts,
    last_run: state.lastRun,
    last_success: state.lastSuccess,
  });

  // SPAWN after the durable write. A throwing dispatch is error-isolated; the job
  // was already removed from the queue, so a failed spawn drops the fire (retried
  // at its next slot) rather than wedging the chain.
  for (const name of toDispatch) {
    try {
      deps.dispatch(name);
    } catch (err) {
      deps.log(`dispatch failed for ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return wake;
}
