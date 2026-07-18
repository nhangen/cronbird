import type { CronMatcher } from "./cron";
import { RunQueue } from "./run-queue";
import type { CompletionRecord, DispatchRecord, Heartbeat, Job, Topology } from "./types";
export interface DaemonDeps<T = unknown> {
    now(): Date;
    sleep(ms: number): Promise<void>;
    loadRegistry(): {
        jobs: Job<T>[];
        warnings: string[];
    };
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
    readCompletions(): {
        running: Record<string, number>;
        done: Record<string, CompletionRecord>;
    };
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
export declare function runForever<T>(deps: DaemonDeps<T>): Promise<void>;
/**
 * Run a single scheduler tick against the cross-tick {@link TickState}: re-read
 * the registry/topology, enqueue due + catch-up slots by priority (stamping
 * `last_fired` at ENQUEUE — a single slot owner), persist the heartbeat, then
 * drain the queue. Returns the computed wake so the caller sleeps correctly.
 *
 * Behaviour matches the former inlined loop body: dispatch stays fire-and-forget
 * and happens strictly AFTER the heartbeat write (at-most-once over double-fire).
 */
export declare function runOneTick<T>(deps: DaemonDeps<T>, state: TickState<T>): number;
