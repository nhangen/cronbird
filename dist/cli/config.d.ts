export declare class ConfigError extends Error {
}
export interface CronbirdConfig {
    hostname: string;
    registryPath: string;
    enabledPath: string | null;
    topologyPath: string | null;
    heartbeatPath: string;
    syncedHeartbeatDir: string | null;
    lockPath: string | null;
    historyPath: string | null;
    maxHistoryRecords: number | null;
    historyRetentionMs: number | null;
    dispatchCommand: string[];
    dispatchArgsTemplate: string[];
    maxSleepMs: number;
    catchupLookbackFloorMs: number;
    catchupLookbackCapMs: number;
}
export declare function parseConfig(raw: string, env: Record<string, string | undefined>): CronbirdConfig;
