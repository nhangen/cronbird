/**
 * Per-tick loaders re-report the same corrupt file every tick. Log a warning
 * when it first appears and again only after it has cleared and returned, so a
 * persistent corruption is visible without flooding the daemon log.
 */
export function createWarningLogger(log: (msg: string) => void): (source: string, warnings: string[]) => void {
  const active = new Map<string, Set<string>>();
  return (source, warnings) => {
    const prev = active.get(source) ?? new Set<string>();
    for (const w of warnings) if (!prev.has(w)) log(`${source}: ${w}`);
    active.set(source, new Set(warnings));
  };
}

/** Wraps a `{ value, warnings }` loader result: logs its warnings (deduped per source) and returns the value. */
export function createSurfacer(log: (msg: string) => void): <T>(source: string, r: { value: T; warnings: string[] }) => T {
  const warnOnce = createWarningLogger(log);
  return (source, r) => {
    warnOnce(source, r.warnings);
    return r.value;
  };
}
