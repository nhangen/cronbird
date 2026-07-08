export interface Job<T = unknown> {
  name: string;
  /** 5-field cron expression, evaluated in the host's local timezone. */
  cronSchedule: string;
  /** Only active jobs fire. */
  isActive: boolean;
  /** ["*"] = every host; ["ml-1"] = this host only. */
  hosts: string[];
  /** "each" → fires where enabled; "single" → fires on its topology owner. */
  scope: "each" | "single";
  /** Product-specific fields the engine ignores (model, tier, runner, ...). */
  metadata: T;
}

export interface Topology {
  hosts: string[];
  /** jobName → owning host (for scope:"single"). */
  owners: Record<string, string>;
}

export interface DispatchRecord {
  name: string;
  ts: number;
}

export interface QueueEntry {
  name: string;
  priority: number;
  /** epoch-ms of the slot that enqueued this job (drives staleness eviction). */
  slotTs: number;
}

export interface CompletionRecord {
  ts: number;
  exitCode: number;
  durationMs: number;
}

export interface Heartbeat {
  ts: number;
  host: string;
  runnable_count: number;
  next_wake_ts: number;
  last_dispatch: DispatchRecord[];
  /** jobName → epoch-minute last dispatched (durable double-fire guard). */
  dispatched_minute: Record<string, number>;
  /** jobName → epoch-ms of the newest slot fired (drives catch-up). */
  last_fired: Record<string, number>;
  /** Persisted priority queue so a restart resumes the backlog. */
  queue: QueueEntry[];
  /** jobName → startedTs of an in-flight run (restored from running/ dir). */
  running: Record<string, number>;
  /** jobName → last completion (exit code + duration) for cooldown + metrics. */
  last_completed: Record<string, CompletionRecord>;
  /** jobName → consecutive failed attempts since last success (retry counter). */
  attempts: Record<string, number>;
  /** jobName → epoch-ms it was last dispatched (drives dependency eligibility). */
  last_run: Record<string, number>;
  /** jobName → epoch-ms of its last exit-0 completion. */
  last_success: Record<string, number>;
}
