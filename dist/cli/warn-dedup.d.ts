/**
 * Per-tick loaders re-report the same corrupt file every tick. Log a warning
 * when it first appears and again only after it has cleared and returned, so a
 * persistent corruption is visible without flooding the daemon log.
 */
export declare function createWarningLogger(log: (msg: string) => void): (source: string, warnings: string[]) => void;
/** Wraps a `{ value, warnings }` loader result: logs its warnings (deduped per source) and returns the value. */
export declare function createSurfacer(log: (msg: string) => void): <T>(source: string, r: {
    value: T;
    warnings: string[];
}) => T;
