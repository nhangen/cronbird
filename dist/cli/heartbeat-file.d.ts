import type { Heartbeat } from "../core/index";
export declare function readHeartbeatFile(path: string): Heartbeat | null;
export declare function writeHeartbeatFile(path: string, hb: Heartbeat): void;
/**
 * Atomically write the synced per-host heartbeat (E2 offline-owner alert). The
 * filename is the host id, so two hosts never write the same file — no sync
 * conflict. The timestamp is taken here at the I/O edge.
 */
export declare function writeSyncedHeartbeat(path: string, host: string): void;
/**
 * A local heartbeat write failed with an errno that a bare respawn cannot clear
 * (read-only fs, out of space/quota, bad perms). Thrown so the daemon entrypoint
 * can exit with a loud, distinct fatal instead of a bare `exit(1)` that launchd —
 * which has no `StartLimitBurst` cap — respawns silently every 10s forever (#13).
 * Still a fatal (the double-fire guard's backing store is unwritable, so the
 * daemon must not dispatch) — but now an *alerted* one.
 */
export declare class PermanentHeartbeatWriteError extends Error {
    readonly code: string;
    constructor(cause: NodeJS.ErrnoException);
}
export declare function isPermanentLocalWriteError(err: unknown): boolean;
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
export declare function writeHeartbeatWithSync(hb: Heartbeat, deps: {
    writeLocal: (hb: Heartbeat) => void;
    writeSynced: () => void;
    log: (msg: string) => void;
}): void;
