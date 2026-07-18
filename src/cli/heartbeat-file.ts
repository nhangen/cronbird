/**
 * Durable persistence for the daemon heartbeat. The heartbeat doubles as the
 * double-fire guard's backing store (H1): on startup the daemon restores
 * `dispatched_minute` from here, so a `Restart=always` crash inside a fire-minute
 * does not re-run a playbook. A corrupt or missing file reads as `null` — the
 * guard starts empty rather than crashing the daemon at boot.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CompletionRecord, DispatchRecord, Heartbeat, QueueEntry } from "../core/index";

export function readHeartbeatFile(path: string): Heartbeat | null {
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.ts !== "number") return null;
  if (typeof r.dispatched_minute !== "object" || r.dispatched_minute === null) return null;
  const lastDispatch = Array.isArray(r.last_dispatch) ? (r.last_dispatch as DispatchRecord[]) : [];
  // Drop any non-numeric guard value: a string slipping in would never `===`
  // the current epoch-minute, silently disabling the double-fire guard for that
  // playbook. Keep parity with the registry path's strictness.
  const dispatchedMinute = numericMap(r.dispatched_minute);
  // last_fired drives catch-up; same numeric filter, and absent (pre-#143
  // heartbeats) reads as empty so the daemon simply re-baselines.
  const lastFired = numericMap(r.last_fired);
  return {
    ts: r.ts,
    host: typeof r.host === "string" ? r.host : "",
    runnable_count: typeof r.runnable_count === "number" ? r.runnable_count : 0,
    next_wake_ts: typeof r.next_wake_ts === "number" ? r.next_wake_ts : 0,
    last_dispatch: lastDispatch,
    dispatched_minute: dispatchedMinute,
    last_fired: lastFired,
    // Scheduler backlog + retry state. Absent (pre-priority-chain heartbeats) or
    // malformed reads as empty so the daemon simply starts with a clean queue —
    // never crashes at boot, never fabricates entries.
    queue: queueEntries(r.queue),
    running: numericMap(r.running),
    last_completed: completionMap(r.last_completed),
    attempts: numericMap(r.attempts),
    last_run: numericMap(r.last_run),
    last_success: numericMap(r.last_success),
  };
}

// Parse the persisted queue, dropping any entry missing a numeric priority/slotTs
// or a string name — a torn entry must not resurrect as a malformed queue slot.
function queueEntries(raw: unknown): QueueEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: QueueEntry[] = [];
  for (const e of raw) {
    if (
      typeof e === "object" &&
      e !== null &&
      typeof (e as QueueEntry).name === "string" &&
      typeof (e as QueueEntry).priority === "number" &&
      typeof (e as QueueEntry).slotTs === "number"
    ) {
      const { name, priority, slotTs } = e as QueueEntry;
      out.push({ name, priority, slotTs });
    }
  }
  return out;
}

// Parse the last-completion map, dropping any record without all three numeric
// fields so a torn write can't feed a bogus exit code into the retry logic.
function completionMap(raw: unknown): Record<string, CompletionRecord> {
  const out: Record<string, CompletionRecord> = {};
  if (typeof raw === "object" && raw !== null) {
    for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
      if (
        typeof v === "object" &&
        v !== null &&
        typeof (v as CompletionRecord).ts === "number" &&
        typeof (v as CompletionRecord).exitCode === "number" &&
        typeof (v as CompletionRecord).durationMs === "number"
      ) {
        const { ts, exitCode, durationMs } = v as CompletionRecord;
        out[name] = { ts, exitCode, durationMs };
      }
    }
  }
  return out;
}

// Drop any non-numeric value: a string slipping into the guard or last_fired
// would never compare correctly, silently disabling it for that playbook.
function numericMap(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof raw === "object" && raw !== null) {
    for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "number") out[name] = v;
    }
  }
  return out;
}

export function writeHeartbeatFile(path: string, hb: Heartbeat): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(hb, null, 2));
  renameSync(tmp, path);
}

/**
 * Atomically write the synced per-host heartbeat (E2 offline-owner alert). The
 * filename is the host id, so two hosts never write the same file — no sync
 * conflict. The timestamp is taken here at the I/O edge.
 */
export function writeSyncedHeartbeat(path: string, host: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ host, ts: new Date().toISOString() }, null, 2));
  renameSync(tmp, path);
}

/**
 * A local heartbeat write failed with an errno that a bare respawn cannot clear
 * (read-only fs, out of space/quota, bad perms). Thrown so the daemon entrypoint
 * can exit with a loud, distinct fatal instead of a bare `exit(1)` that launchd —
 * which has no `StartLimitBurst` cap — respawns silently every 10s forever (#13).
 * Still a fatal (the double-fire guard's backing store is unwritable, so the
 * daemon must not dispatch) — but now an *alerted* one.
 */
export class PermanentHeartbeatWriteError extends Error {
  readonly code: string;
  constructor(cause: NodeJS.ErrnoException) {
    super(`permanent local heartbeat-write failure (${cause.code ?? "?"}): ${cause.message}`);
    this.name = "PermanentHeartbeatWriteError";
    this.code = cause.code ?? "";
  }
}

/**
 * errno codes for a local-write failure that a respawn cannot fix without
 * operator action: permission denied, read-only fs, out of space/quota, or a
 * path that can't be a regular file. Everything else (EAGAIN, EBUSY, EINTR,
 * EIO, EMFILE…) is treated as transient and left to propagate for a normal
 * respawn retry.
 */
const PERMANENT_WRITE_CODES = new Set([
  "EACCES",
  "EPERM",
  "EROFS",
  "ENOSPC",
  "EDQUOT",
  "ENOTDIR",
  "EISDIR",
  "ENAMETOOLONG",
]);

export function isPermanentLocalWriteError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return typeof code === "string" && PERMANENT_WRITE_CODES.has(code);
}

/**
 * Persist the heartbeat host-local first, then best-effort the synced per-host
 * copy. Invariant: a synced-vault write failure must not crash the daemon or
 * skip the host-local heartbeat (the double-fire guard's backing store).
 *
 * The host-local write must happen before the daemon dispatches, so a failure
 * here is always fatal (we never dispatch without a persisted guard). But the
 * *shape* of that fatal matters: a permanent failure (read-only fs, disk full,
 * bad perms) that bubbles to a bare `exit(1)` becomes a silent launchd respawn
 * loop. So classify it — permanent failures get a distinct, loud fatal and a
 * typed error the entrypoint maps to `FATAL_EXIT_CODE`; transient failures
 * propagate unchanged for a normal respawn. A synced failure stays swallowed.
 */
export function writeHeartbeatWithSync(
  hb: Heartbeat,
  deps: {
    writeLocal: (hb: Heartbeat) => void;
    writeSynced: () => void;
    log: (msg: string) => void;
  },
): void {
  try {
    deps.writeLocal(hb);
  } catch (err) {
    if (isPermanentLocalWriteError(err)) {
      deps.log(
        `FATAL: permanent local heartbeat-write failure (${(err as NodeJS.ErrnoException).code}) — ` +
          "cannot persist the double-fire guard; refusing to dispatch. " +
          "Fix the filesystem/permissions and restart the daemon.",
      );
      throw new PermanentHeartbeatWriteError(err as NodeJS.ErrnoException);
    }
    // Transient (EAGAIN/EBUSY/EIO…): keep the fail-safe — propagate so the daemon
    // exits without dispatching; a respawn may clear it.
    throw err;
  }
  try {
    deps.writeSynced();
  } catch (err) {
    deps.log(`synced heartbeat write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
