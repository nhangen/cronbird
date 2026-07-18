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
 * Persist the heartbeat host-local first, then best-effort the synced per-host
 * copy. Invariant: a synced-vault write failure must not crash the daemon or
 * skip the host-local heartbeat (the double-fire guard's backing store). The
 * host-local write happens before the try so it cannot be skipped; a synced
 * failure is swallowed and logged.
 */
export declare function writeHeartbeatWithSync(hb: Heartbeat, deps: {
    writeLocal: (hb: Heartbeat) => void;
    writeSynced: () => void;
    log: (msg: string) => void;
}): void;
