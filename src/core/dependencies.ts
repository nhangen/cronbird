import type { CompletionRecord } from "./types";

/**
 * Dependency-chain helpers. All pure functions of the daemon's persisted state
 * so a crash mid-cascade re-derives the same decision on the next tick.
 */

/** A dependent is eligible iff every upstream succeeded strictly after it last ran. */
export function isEligible(
  name: string,
  upstreams: string[],
  lastSuccess: Record<string, number>,
  lastRun: Record<string, number>,
): boolean {
  const since = lastRun[name] ?? 0;
  return upstreams.every((u) => (lastSuccess[u] ?? -1) > since);
}

/** Failed = retry budget exhausted AND the last observed completion was non-zero. */
export function failedJobs(
  names: string[],
  attempts: Record<string, number>,
  done: Record<string, CompletionRecord>,
  maxAttempts: number,
): Set<string> {
  const failed = new Set<string>();
  for (const n of names) {
    if ((attempts[n] ?? 0) >= maxAttempts && (done[n]?.exitCode ?? 0) !== 0) failed.add(n);
  }
  return failed;
}

/** DFS: does any (transitive) upstream of `name` sit in `failed`? */
export function transitiveUpstreamFailed(
  name: string,
  upstreamsOf: (n: string) => string[],
  failed: Set<string>,
): boolean {
  const seen = new Set<string>();
  const stack = [...upstreamsOf(name)];
  while (stack.length) {
    const u = stack.pop()!;
    if (seen.has(u)) continue;
    seen.add(u);
    if (failed.has(u)) return true;
    stack.push(...upstreamsOf(u));
  }
  return false;
}
