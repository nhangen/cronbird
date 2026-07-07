import type { CompletionRecord, Job } from "./types";

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

/**
 * Topological validation at registry load. Returns the jobs that must be failed
 * rather than run: any job in a dependency cycle, and any job with an edge to a
 * name not in the registry. Failing the whole job (not silently dropping the
 * offending edge) is deliberate — a dropped edge would let a dependent run
 * before an upstream that can never satisfy it.
 */
export function validateDependencies<T>(
  jobs: Job<T>[],
  upstreamsOf: (n: string) => string[],
): { invalid: Set<string>; warnings: string[] } {
  const known = new Set(jobs.map((jb) => jb.name));
  const invalid = new Set<string>();
  const warnings: string[] = [];

  for (const jb of jobs) {
    for (const u of upstreamsOf(jb.name)) {
      if (!known.has(u)) {
        invalid.add(jb.name);
        warnings.push(`job ${jb.name} depends on unknown job ${u}`);
      }
    }
  }

  // Cycle detection via DFS coloring; every node on a back-edge is invalid.
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>(jobs.map((jb) => [jb.name, WHITE]));
  const path: string[] = [];
  const visit = (n: string): void => {
    if (!color.has(n)) return; // edge to an unknown job — already flagged above
    color.set(n, GRAY);
    path.push(n);
    for (const u of upstreamsOf(n)) {
      if (color.get(u) === GRAY) {
        const cyc = path.slice(path.indexOf(u)).concat(u);
        for (const c of cyc) invalid.add(c);
        warnings.push(`dependency cycle: ${cyc.join(" → ")}`);
      } else if (color.get(u) === WHITE) {
        visit(u);
      }
    }
    path.pop();
    color.set(n, BLACK);
  };
  for (const jb of jobs) if (color.get(jb.name) === WHITE) visit(jb.name);

  return { invalid, warnings };
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
