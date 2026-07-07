# Priority-Chain Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn cronbird from fire-and-forget dispatch into a priority run-queue that serializes due jobs (N=1), gates each job on its dependencies' fresh success, retries failures three times, cascades cancellation to downstream jobs when an upstream finally fails, and survives a daemon restart.

**Architecture:** A pure `RunQueue` holds due jobs by priority. The daemon loop enqueues due jobs, reads file-based completion state (`running/`+`done/`) written by a separate dispatch wrapper, and drains the queue up to N=1 — dispatching only the highest-priority job that is *dependency-eligible* and not stale. Retry counters, last-run and last-success timestamps, and the queue all persist in the heartbeat so a restart resumes exactly where it left off. "Failed" is a pure function of persisted state (`attempts >= MAX && last exit ≠ 0`), so a crash mid-cascade re-derives the same decision.

**Tech Stack:** TypeScript, Bun (`bun test`, `bun:test`). Pure-logic core with side effects injected via the existing `DaemonDeps` pattern.

## Global Constraints

- Runtime: **Bun**; tests use `import { describe, expect, test } from "bun:test"`.
- Engine stays **product-agnostic**: `Job.metadata` is opaque `T`; priority, cooldown, and dependencies all come from injected resolvers, never hardcoded fields.
- Control loop **never awaits a child**; all side effects injected via `DaemonDeps`.
- **At-most-once**: persist heartbeat (incl. queue + attempts + timestamps) **before** any spawn; a crash drops, never doubles.
- **Fail-safe reads**: a torn/missing state read = "nothing runs" / reuse last-good, never "run everything".
- **State-derived decisions**: "failed" and "eligible" are recomputed each tick from persisted state so a crash re-derives the same answer (crash-safe by construction).
- Concurrency **N=1** (`MAX_CONCURRENT = 1`); read-tier parallelism is out of scope.
- Commit messages: no `claude`/`anthropic`/`co-authored` text.

**Out of scope (separate plan):** the `ceo-cron.sh` bash wrapper that *writes* `running/`+`done/` state files, reserves the fatal/skip exit codes, and demotes the `flock`/cooldown to backstops. This plan delivers the TS engine that *consumes* those files.

## Already shipped (do not rebuild)

These landed in commits `0e254a9`→`9a561d7` and are the base this plan builds on:

- **RunQueue** (`src/core/run-queue.ts`) — `enqueue(name,priority):boolean` (dedupe), `dequeue():string|null` (lowest priority number, FIFO tie via `seq`), `has`, `size`, `snapshot()`.
- **Heartbeat types** (`src/core/types.ts`) — `QueueEntry {name,priority,slotTs}`, `CompletionRecord {ts,exitCode,durationMs}`, and OPTIONAL `Heartbeat.queue?/running?/last_completed?` (Task A tightens these to required).
- **`runOneTick(deps, state)` extraction** + `TickState<T>` in `src/core/daemon.ts`.
- **Enqueue-by-priority** — due + catch-up slots enqueue (not dispatch), stamping `last_fired` at enqueue (single slot owner).
- **Cooldown gate** — `cooldownSeconds(job)` dep; a job inside cooldown is not enqueued.
- **N=1 drain** — `MAX_CONCURRENT=1` (`src/core/constants.ts`); drain dequeues up to the cap based on `readCompletions().running`; a throwing dispatch is isolated and does not consume a slot.
- Production wiring in `src/cli/main.ts` passes behavior-preserving defaults (`priority: () => 0`, `readCompletions: () => ({running:{},done:{}})`, `cooldownSeconds: () => 0`).

---

### Task A: Persist queue + attempts + last-run/last-success; restore on restart

**Files:**
- Modify: `src/core/types.ts` (tighten 3 fields to required; add `attempts`, `last_run`, `last_success`)
- Modify: `src/core/daemon.ts` (heartbeat write + `TickState` + startup restore + stamp `lastRun` at dispatch)
- Test: `tests/daemon.test.ts` (add a restart-durability block)

**Interfaces:**
- Consumes: `Heartbeat`, `RunQueue.snapshot()`, `readCompletions()`.
- Produces: `Heartbeat` gains required `queue`, `running`, `last_completed`, plus new required `attempts: Record<string,number>`, `last_run: Record<string,number>`, `last_success: Record<string,number>`. `TickState<T>` gains `attempts`, `lastRun`, `lastSuccess`, `processedCompletionTs: Record<string,number>` (all `Record<string,number>`). `runForever` restores all of them + the queue from the prior heartbeat.

- [ ] **Step 1: Write the failing test** (append to `tests/daemon.test.ts`)

```typescript
describe("restart durability (queue + retry state)", () => {
  test("queued backlog and retry/timestamps persist and restore", async () => {
    // Run 1: two due jobs, one already running elsewhere → both queued, none drained.
    const start = d("2026-07-07T09:00:00Z");
    const h1 = harness({
      nows: [start],
      playbooks: [pb({ name: "a" }), pb({ name: "b" })],
      priority: (j) => (j.name === "a" ? 1 : 2),
      readCompletions: () => ({ running: { x: 1 }, done: {} }),
    });
    await runForever(h1.deps);
    const hb = h1.heartbeats.at(-1)!;
    expect((hb.queue ?? []).map((e) => e.name)).toEqual(["a", "b"]);
    expect(hb.attempts).toEqual({});
    expect(hb.last_run).toBeDefined();

    // Run 2: restart from hb, nothing running now → drains "a" first (priority 1).
    const h2 = harness({
      nows: [d("2026-07-07T09:01:00Z")],
      playbooks: [pb({ name: "a" }), pb({ name: "b" })],
      priority: (j) => (j.name === "a" ? 1 : 2),
      startHeartbeat: hb,
      readCompletions: () => ({ running: {}, done: {} }),
    });
    await runForever(h2.deps);
    expect(h2.dispatched).toEqual(["a"]);
    // "a" dispatched → its last_run stamped at run-2's now.
    expect(h2.heartbeats.at(-1)!.last_run!.a).toBe(d("2026-07-07T09:01:00Z").getTime());
  });
});
```

The `harness` factory returns `{ deps, dispatched, heartbeats, logs, ... }` — expose `heartbeats` and `deps` if not already. (It already collects them; return them.)

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/daemon.test.ts`
Expected: FAIL — heartbeat has no `queue`/`attempts`/`last_run` (not persisted), and run 2 starts with an empty queue so `dispatched` is `[]`.

- [ ] **Step 3: Implement**

1. `src/core/types.ts` — tighten `queue`/`running`/`last_completed` to required (drop `?`); add:

```typescript
  /** jobName → consecutive failed attempts since last success (retry counter). */
  attempts: Record<string, number>;
  /** jobName → epoch-ms it was last dispatched (drives dependency eligibility). */
  last_run: Record<string, number>;
  /** jobName → epoch-ms of its last exit-0 completion. */
  last_success: Record<string, number>;
```

2. `src/core/daemon.ts` — extend `TickState<T>`:

```typescript
  /** jobName → consecutive failures since last success. */
  attempts: Record<string, number>;
  /** jobName → epoch-ms last dispatched. */
  lastRun: Record<string, number>;
  /** jobName → epoch-ms of last exit-0 completion. */
  lastSuccess: Record<string, number>;
  /** jobName → done.ts already accounted for (so a completion is processed once). */
  processedCompletionTs: Record<string, number>;
```

3. In `runForever`, restore from `prior`:

```typescript
  const queue = new RunQueue();
  for (const e of prior?.queue ?? []) queue.enqueue(e.name, e.priority);
  const state: TickState<T> = {
    queue,
    guard: new Map<string, number>(prior ? Object.entries(prior.dispatched_minute) : []),
    recent: prior ? [...prior.last_dispatch] : [],
    lastFired: prior ? { ...prior.last_fired } : {},
    lastGood: [],
    lastGoodOwners: {},
    slotTsByName: prior ? Object.fromEntries((prior.queue ?? []).map((e) => [e.name, e.slotTs])) : {},
    attempts: prior ? { ...prior.attempts } : {},
    lastRun: prior ? { ...prior.last_run } : {},
    lastSuccess: prior ? { ...prior.last_success } : {},
    processedCompletionTs: {},
  };
```

4. In the heartbeat write inside `runOneTick`, add the new fields:

```typescript
    queue: state.queue.snapshot().map((e) => ({ ...e, slotTs: state.slotTsByName[e.name] ?? now.getTime() })),
    running: completions.running,
    last_completed: completions.done,
    attempts: state.attempts,
    last_run: state.lastRun,
    last_success: state.lastSuccess,
```

5. Stamp `lastRun` at dispatch, in the drain loop after a successful `deps.dispatch(next)`:

```typescript
      state.lastRun[next] = now.getTime();
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/daemon.test.ts && bun test`
Expected: PASS across the suite (all heartbeat writers now populate the required fields; the CLI wiring already returns `{running:{},done:{}}` so `completions` is always defined).

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts src/core/daemon.ts tests/daemon.test.ts
git commit -m "feat: persist and restore queue + retry state across restart"
```

---

### Task B: Dependency eligibility gate + transitive cascade-cancel

**Files:**
- Modify: `src/core/daemon.ts` (add `dependencies` dep; eligibility in the drain; cascade before drain)
- Create: `src/core/dependencies.ts` (pure helpers: `failedJobs`, `transitiveUpstreamFailed`, `isEligible`)
- Modify: `src/cli/main.ts` (wire `dependencies: () => []` default)
- Test: `tests/dependencies.test.ts` (pure helpers) + a daemon eligibility/cascade block in `tests/daemon.test.ts`

**Interfaces:**
- Consumes: `TickState.attempts/lastRun/lastSuccess` (Task A), `readCompletions().done`, `RunQueue`.
- Produces:
  - `DaemonDeps.dependencies(job: Job<T>): string[]` — upstream job names.
  - `src/core/dependencies.ts` exports:
    - `isEligible(name, deps, lastSuccess, lastRun): boolean` — every upstream `U` has `lastSuccess[U] > (lastRun[name] ?? 0)`.
    - `failedJobs(names, attempts, done, maxAttempts): Set<string>` — `attempts[n] >= maxAttempts && done[n]?.exitCode` truthy (≠ 0).
    - `transitiveUpstreamFailed(name, depsOf, failed): boolean` — DFS over `depsOf` reaching any failed node.
  - `RunQueue.remove(name: string): boolean` — remove a specific queued entry (needed to drop a cascade-cancelled or skip-past a dependency-blocked job without disturbing FIFO of the rest).

- [ ] **Step 1: Write the failing tests**

`tests/dependencies.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { isEligible, failedJobs, transitiveUpstreamFailed } from "../src/core/dependencies";
import type { CompletionRecord } from "../src/core/types";

describe("dependency eligibility", () => {
  const depsOf = (n: string): string[] => (n === "D" ? ["U"] : []);

  test("eligible when upstream succeeded after dependent last ran", () => {
    expect(isEligible("D", depsOf("D"), { U: 200 }, { D: 100 })).toBe(true);
  });
  test("blocked when upstream success predates dependent last run", () => {
    expect(isEligible("D", depsOf("D"), { U: 50 }, { D: 100 })).toBe(false);
  });
  test("dependent never ran → any upstream success qualifies", () => {
    expect(isEligible("D", depsOf("D"), { U: 1 }, {})).toBe(true);
  });
  test("blocked when upstream never succeeded", () => {
    expect(isEligible("D", depsOf("D"), {}, {})).toBe(false);
  });
  test("no dependencies → always eligible", () => {
    expect(isEligible("I", [], {}, {})).toBe(true);
  });
});

describe("failure derivation + cascade", () => {
  const done = (exit: number): CompletionRecord => ({ ts: 1, exitCode: exit, durationMs: 0 });
  test("failed = attempts at max AND last exit non-zero", () => {
    const f = failedJobs(["a", "b", "c"], { a: 3, b: 3, c: 1 }, { a: done(1), b: done(0), c: done(1) }, 3);
    expect([...f]).toEqual(["a"]); // b succeeded on last try; c hasn't hit max
  });
  test("transitive upstream failure reaches diamond dependent", () => {
    // D←B,C ; B←A ; C←A ; A failed
    const depsOf = (n: string): string[] =>
      n === "D" ? ["B", "C"] : n === "B" || n === "C" ? ["A"] : [];
    expect(transitiveUpstreamFailed("D", depsOf, new Set(["A"]))).toBe(true);
    expect(transitiveUpstreamFailed("B", depsOf, new Set(["A"]))).toBe(true);
    expect(transitiveUpstreamFailed("A", depsOf, new Set(["A"]))).toBe(false); // itself failed ≠ upstream failed
  });
});
```

Daemon block in `tests/daemon.test.ts`:

```typescript
describe("dependency gate + cascade in the drain", () => {
  test("dependency-blocked job is held; independent drains past it", async () => {
    const start = d("2026-07-07T09:00:00Z");
    const h = harness({
      nows: [start],
      playbooks: [pb({ name: "gate" }), pb({ name: "dep" }), pb({ name: "free" })],
      priority: (j) => (j.name === "dep" ? 1 : j.name === "free" ? 2 : 3),
      dependencies: (j) => (j.name === "dep" ? ["gate"] : []),
      // "gate" never succeeded → "dep" blocked; "free" independent drains.
      readCompletions: () => ({ running: {}, done: {} }),
    });
    await runForever(h.deps);
    expect(h.dispatched).toEqual(["free"]); // dep blocked despite higher priority
  });

  test("cascade-cancels a dependent when its upstream has finally failed", async () => {
    const start = d("2026-07-07T09:00:00Z");
    const failedHb = h0Heartbeat({ attempts: { gate: 3 }, done: { gate: 1 } }); // helper below
    const h = harness({
      nows: [start],
      playbooks: [pb({ name: "gate" }), pb({ name: "dep" })],
      dependencies: (j) => (j.name === "dep" ? ["gate"] : []),
      startHeartbeat: failedHb,
      readCompletions: () => ({ running: {}, done: { gate: { ts: 1, exitCode: 1, durationMs: 0 } } }),
    });
    // "dep" was in the restored queue; gate is failed → dep cascade-cancelled.
    await runForever(h.deps);
    expect(h.dispatched).toEqual([]);
    expect(h.logs.some((l) => l.includes("cascade-cancel dep"))).toBe(true);
  });
});
```

Add a small `h0Heartbeat` helper in the test file that builds a `Heartbeat` with a restored `queue: [{name:"dep",priority:1,slotTs:start}]`, the given `attempts`, and `last_completed` derived from `done`. (Keeps the cascade test's setup explicit.)

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/dependencies.test.ts tests/daemon.test.ts`
Expected: FAIL — `src/core/dependencies` missing; `dependencies` not on deps; drain ignores eligibility and cascade.

- [ ] **Step 3: Implement**

1. `src/core/dependencies.ts`:

```typescript
import type { CompletionRecord } from "./types";

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
```

2. `src/core/run-queue.ts` — add:

```typescript
  remove(name: string): boolean {
    if (!this.names.has(name)) return false;
    const i = this.entries.findIndex((e) => e.name === name);
    this.entries.splice(i, 1);
    this.names.delete(name);
    return true;
  }
```

3. `src/core/daemon.ts` — add the dep and rework the drain. Add `dependencies(job: Job<T>): string[]` to `DaemonDeps`. Import the helpers + `MAX_ATTEMPTS` (Task C adds it; for Task B use a local `const MAX_ATTEMPTS = 3` and Task C promotes it to `constants.ts`). Before the drain:

```typescript
  // Cascade: derive the failed set from persisted state, then drop any queued
  // job whose (transitive) upstream has finally failed. Pure function of state,
  // so a crash mid-cascade re-derives the same decision next tick.
  const upstreamsOf = (n: string): string[] => {
    const j = jobByName.get(n);
    return j ? deps.dependencies(j) : [];
  };
  const failed = failedJobs(
    state.queue.snapshot().map((e) => e.name),
    state.attempts,
    completions.done,
    MAX_ATTEMPTS,
  );
  for (const e of state.queue.snapshot()) {
    if (transitiveUpstreamFailed(e.name, upstreamsOf, failed)) {
      state.queue.remove(e.name);
      delete state.slotTsByName[e.name];
      deps.log(`cascade-cancel ${e.name} (upstream failed)`);
    }
  }
```

Replace the drain's `dequeue()` with an eligibility-aware pick (skip blocked, keep them queued):

```typescript
  let runningCount = Object.keys(completions.running).length;
  while (runningCount < MAX_CONCURRENT) {
    // First queued entry that is dependency-eligible; blocked ones stay put.
    const candidate = state.queue
      .snapshot()
      .find((e) => isEligible(e.name, upstreamsOf(e.name), state.lastSuccess, state.lastRun));
    if (!candidate) break; // nothing eligible this tick → idle, re-evaluate next tick
    state.queue.remove(candidate.name);
    delete state.slotTsByName[candidate.name];
    try {
      deps.dispatch(candidate.name);
      state.lastRun[candidate.name] = now.getTime();
      runningCount++;
    } catch (err) {
      deps.log(`dispatch failed for ${candidate.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
```

4. `src/cli/main.ts` — add `dependencies: () => []` to the deps object (behavior-preserving: no job has upstreams until the CEO resolver reads `dependsOn` frontmatter).

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/dependencies.test.ts tests/daemon.test.ts && bun test`
Expected: PASS. Existing drain tests still pass — with no `dependencies` resolver every job is eligible, so behavior is unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/core/dependencies.ts src/core/run-queue.ts src/core/daemon.ts src/cli/main.ts tests/dependencies.test.ts tests/daemon.test.ts
git commit -m "feat: gate the drain on dependency eligibility + transitive cascade-cancel"
```

---

### Task C: Three-strikes retry (back-of-line, fatal fail-fast)

**Files:**
- Modify: `src/core/constants.ts` (add `MAX_ATTEMPTS = 3`, `FATAL_EXIT_CODE`)
- Modify: `src/core/daemon.ts` (process fresh completions: success resets, failure retries/fails)
- Test: `tests/daemon.test.ts` (retry block)

**Interfaces:**
- Consumes: `readCompletions().done`, `TickState.attempts/lastSuccess/processedCompletionTs`, `RunQueue`, `priority`.
- Produces: completion-processing step at the top of `runOneTick` (after `readCompletions`): for each `done[name]` whose `ts > processedCompletionTs[name]`, mark it processed, then:
  - exit 0 → `lastSuccess[name] = ts`, `attempts[name] = 0`.
  - exit ≠ 0 → `attempts[name]++`; if `exitCode === FATAL_EXIT_CODE` set `attempts[name] = MAX_ATTEMPTS` (fail-fast); if `attempts[name] < MAX_ATTEMPTS` re-enqueue at its own priority (back of line via `enqueue`); else leave it failed (no requeue) and log.

- [ ] **Step 1: Write the failing test**

```typescript
describe("three-strikes retry", () => {
  const doneRec = (exit: number, ts: number) => ({ ts, exitCode: exit, durationMs: 0 });

  test("a fresh failure re-enqueues at back of line up to MAX-1, then fails", async () => {
    const base = d("2026-07-07T09:00:00Z").getTime();
    // Simulate three consecutive failing completions across three ticks.
    let call = 0;
    const doneByTick = [
      { j: doneRec(1, base + 1) },
      { j: doneRec(1, base + 2) },
      { j: doneRec(1, base + 3) },
    ];
    const h = harness({
      nows: [d("2026-07-07T09:00:00Z"), d("2026-07-07T09:00:10Z"), d("2026-07-07T09:00:20Z")],
      playbooks: [pb({ name: "j", cronSchedule: "*/1 * * * *" })],
      readCompletions: () => ({ running: {}, done: doneByTick[Math.min(call++, 2)] }),
    });
    await runForever(h.deps);
    const hb = h.heartbeats.at(-1)!;
    expect(hb.attempts.j).toBe(3); // hit the cap
    expect((hb.queue ?? []).some((e) => e.name === "j")).toBe(false); // not requeued after 3rd
    expect(h.logs.some((l) => l.includes("failed j") || l.includes("gave up"))).toBe(true);
  });

  test("a success resets the attempt counter and stamps last_success", async () => {
    const base = d("2026-07-07T09:00:00Z").getTime();
    const h = harness({
      nows: [d("2026-07-07T09:00:00Z")],
      playbooks: [pb({ name: "j" })],
      startHeartbeat: h0Heartbeat({ attempts: { j: 2 }, done: {} }),
      readCompletions: () => ({ running: {}, done: { j: doneRec(0, base + 5) } }),
    });
    await runForever(h.deps);
    const hb = h.heartbeats.at(-1)!;
    expect(hb.attempts.j).toBe(0);
    expect(hb.last_success.j).toBe(base + 5);
  });

  test("fatal exit code fails fast (no retries consumed)", async () => {
    const base = d("2026-07-07T09:00:00Z").getTime();
    const h = harness({
      nows: [d("2026-07-07T09:00:00Z")],
      playbooks: [pb({ name: "j" })],
      readCompletions: () => ({ running: {}, done: { j: doneRec(FATAL_EXIT_CODE, base + 1) } }),
    });
    await runForever(h.deps);
    expect(h.heartbeats.at(-1)!.attempts.j).toBe(3); // jumped straight to cap
  });
});
```

Import `FATAL_EXIT_CODE` from `../src/core/constants` in the test.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/daemon.test.ts`
Expected: FAIL — completions are never processed into `attempts`/`lastSuccess`; nothing re-enqueues.

- [ ] **Step 3: Implement**

1. `src/core/constants.ts`:

```typescript
export const MAX_ATTEMPTS = 3;
/** Wrapper-reserved code for an unrecoverable failure (e.g. missing credential). */
export const FATAL_EXIT_CODE = 78; // EX_CONFIG
```

Replace Task B's local `const MAX_ATTEMPTS = 3` with the import.

2. `src/core/daemon.ts` — after `const completions = deps.readCompletions();`, process fresh completions before the cascade/drain:

```typescript
  for (const [name, rec] of Object.entries(completions.done)) {
    if (rec.ts <= (state.processedCompletionTs[name] ?? 0)) continue; // already accounted for
    state.processedCompletionTs[name] = rec.ts;
    if (rec.exitCode === 0) {
      state.lastSuccess[name] = rec.ts;
      state.attempts[name] = 0;
      continue;
    }
    // Failure: fatal fails fast, else consume one attempt.
    state.attempts[name] = rec.exitCode === FATAL_EXIT_CODE ? MAX_ATTEMPTS : (state.attempts[name] ?? 0) + 1;
    if (state.attempts[name] < MAX_ATTEMPTS) {
      const job = jobByName.get(name);
      if (job) state.queue.enqueue(name, deps.priority(job)); // back of line (dedup-safe)
      deps.log(`retry ${name} (attempt ${state.attempts[name]}/${MAX_ATTEMPTS})`);
    } else {
      deps.log(`failed ${name} (gave up after ${MAX_ATTEMPTS} attempts)`);
    }
  }
```

Note ordering: this runs *before* the Task B cascade block, so a job that hits the cap this tick is in the `failed` set the cascade reads (same tick). A retry re-enqueue with `slotTsByName` unset defaults to `now` in the heartbeat's slotTs map — acceptable (retry is failure-driven, not a stale slot).

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/daemon.test.ts && bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/constants.ts src/core/daemon.ts tests/daemon.test.ts
git commit -m "feat: three-strikes retry with back-of-line requeue and fatal fail-fast"
```

---

### Task D: Reject dependency cycles and unknown edges at registry load

**Files:**
- Modify: `src/core/dependencies.ts` (add `validateDependencies`)
- Modify: `src/core/daemon.ts` (exclude invalid jobs from `runnable`, log loudly)
- Test: `tests/dependencies.test.ts` (validation block)

**Interfaces:**
- Consumes: loaded `Job<T>[]`, `dependencies(job)`.
- Produces: `validateDependencies(jobs, upstreamsOf): { invalid: Set<string>; warnings: string[] }` — flags any job in a dependency cycle, and any job with an edge to a name not in the registry. `runOneTick` removes `invalid` jobs from the runnable set before enqueue (a failed edge fails *that job*, not silently the edge — a dropped edge would let a dependent run prematurely).

- [ ] **Step 1: Write the failing test** (`tests/dependencies.test.ts`)

```typescript
import { validateDependencies } from "../src/core/dependencies";
import type { Job } from "../src/core/types";

const j = (name: string): Job => ({
  name, cronSchedule: "0 9 * * *", isActive: true, hosts: ["*"], scope: "each", metadata: {},
});

describe("dependency validation at load", () => {
  test("flags a cycle A→B→A", () => {
    const up = (n: string) => (n === "A" ? ["B"] : n === "B" ? ["A"] : []);
    const { invalid, warnings } = validateDependencies([j("A"), j("B")], up);
    expect(invalid.has("A")).toBe(true);
    expect(invalid.has("B")).toBe(true);
    expect(warnings.join(" ")).toMatch(/cycle/i);
  });
  test("flags an edge to an unknown job", () => {
    const up = (n: string) => (n === "D" ? ["ghost"] : []);
    const { invalid, warnings } = validateDependencies([j("D")], up);
    expect(invalid.has("D")).toBe(true);
    expect(warnings.join(" ")).toMatch(/unknown|ghost/i);
  });
  test("clean DAG has no invalid jobs", () => {
    const up = (n: string) => (n === "D" ? ["U"] : []);
    expect(validateDependencies([j("U"), j("D")], up).invalid.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/dependencies.test.ts`
Expected: FAIL — `validateDependencies` not exported.

- [ ] **Step 3: Implement**

1. `src/core/dependencies.ts`:

```typescript
import type { Job } from "./types";

/**
 * Topological validation. Returns the jobs that must be failed rather than run:
 * any job in a dependency cycle, and any job with an edge to a name not in the
 * registry. Failing the job (not silently dropping the edge) prevents a
 * dependent from running before an upstream that will never satisfy it.
 */
export function validateDependencies<T>(
  jobs: Job<T>[],
  upstreamsOf: (n: string) => string[],
): { invalid: Set<string>; warnings: string[] } {
  const known = new Set(jobs.map((j) => j.name));
  const invalid = new Set<string>();
  const warnings: string[] = [];

  for (const j of jobs) {
    for (const u of upstreamsOf(j.name)) {
      if (!known.has(u)) {
        invalid.add(j.name);
        warnings.push(`job ${j.name} depends on unknown job ${u}`);
      }
    }
  }

  // Cycle detection (DFS coloring). Any node on a back-edge is invalid.
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>(jobs.map((j) => [j.name, WHITE]));
  const path: string[] = [];
  const visit = (n: string): void => {
    if (!color.has(n)) return; // unknown edge already flagged above
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
  for (const j of jobs) if (color.get(j.name) === WHITE) visit(j.name);

  return { invalid, warnings };
}
```

2. `src/core/daemon.ts` — after computing `runnable`, filter out invalid jobs:

```typescript
  const upstreamsOf = (n: string): string[] => {
    const j = jobByName.get(n) ?? jobs.find((x) => x.name === n);
    return j ? deps.dependencies(j) : [];
  };
  const { invalid, warnings: depWarnings } = validateDependencies(runnable, upstreamsOf);
  for (const w of depWarnings) deps.log(`dependency: ${w}`);
  const runnableValid = invalid.size ? runnable.filter((j) => !invalid.has(j.name)) : runnable;
```

Use `runnableValid` from here on (dueAt/catchUpFires/selectRunnable-derived list). Move the `upstreamsOf` definition up so both validation (here) and cascade (Task B) share it — dedupe the two definitions into one.

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/dependencies.test.ts && bun test`
Expected: PASS. With the default `dependencies: () => []`, `validateDependencies` returns empty `invalid` and behavior is unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/core/dependencies.ts src/core/daemon.ts tests/dependencies.test.ts
git commit -m "feat: reject dependency cycles and unknown edges at registry load"
```

---

### Task E: Evict stale queued slots past the catch-up lookback

**Files:**
- Modify: `src/core/daemon.ts` (drain step)
- Test: `tests/daemon.test.ts` (staleness block)

**Interfaces:**
- Consumes: `TickState.slotTsByName`, `resolveLookback(schedule, now)` (existing dep), `RunQueue`.
- Produces: in the eligibility-aware drain, before dispatching a chosen candidate, if its `slotTs` is older than `now - resolveLookback(job.cronSchedule, now)`, evict it (remove, log, don't dispatch, don't count a slot) and continue picking. Retry re-enqueues (whose `slotTsByName` is unset → treated as `now`) are never evicted for staleness.

- [ ] **Step 1: Write the failing test**

```typescript
describe("staleness eviction", () => {
  test("a queued slot older than the lookback is evicted, not dispatched", async () => {
    // Restore a queue entry stamped 10 min ago; lookback is 1 min → stale.
    const now = d("2026-07-07T09:10:00Z");
    const staleTs = d("2026-07-07T09:00:00Z").getTime();
    const hb = h0Heartbeat({ attempts: {}, done: {} });
    hb.queue = [{ name: "stale", priority: 1, slotTs: staleTs }];
    const h = harness({
      nows: [now],
      playbooks: [pb({ name: "stale", cronSchedule: "0 9 * * *" })],
      startHeartbeat: hb,
      lookback: 60_000, // 1 min
      readCompletions: () => ({ running: {}, done: {} }),
    });
    await runForever(h.deps);
    expect(h.dispatched).toEqual([]);
    expect(h.logs.some((l) => l.includes("evicted stale") && l.includes("stale"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/daemon.test.ts`
Expected: FAIL — "stale" is dispatched (drain ignores slotTs age).

- [ ] **Step 3: Implement**

In the drain loop (Task B), after choosing `candidate` and before `deps.dispatch`:

```typescript
    const slotTs = state.slotTsByName[candidate.name] ?? now.getTime();
    const schedule = jobByName.get(candidate.name)?.cronSchedule ?? "";
    if (now.getTime() - slotTs > deps.resolveLookback(schedule, now)) {
      state.queue.remove(candidate.name);
      delete state.slotTsByName[candidate.name];
      deps.log(`evicted stale slot ${candidate.name} (age ${now.getTime() - slotTs}ms)`);
      continue; // pick the next candidate; don't consume a slot
    }
```

Because a stale candidate is removed and we `continue`, the loop re-picks the next eligible entry — eviction never wedges the chain.

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/daemon.test.ts && bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/daemon.ts tests/daemon.test.ts
git commit -m "feat: evict stale queued slots past the catch-up lookback"
```

---

## Self-Review

**Spec coverage (against `docs/superpowers/specs/2026-07-07-priority-chain-scheduler-design.md`):**
- §Dependency chain / eligibility ("succeeded since last run") → Task B `isEligible` (`lastSuccess[U] > lastRun[D]`).
- §Retry ("three strikes, back of line") → Task C; fatal fail-fast → Task C `FATAL_EXIT_CODE`.
- §Cascade on final failure (pure function of state, transitive, diamond) → Task B `failedJobs` + `transitiveUpstreamFailed`.
- §Cycles / bad edges rejected at load → Task D `validateDependencies`.
- §Liveness (blocked jobs stay queued, tick idles) → Task B drain picks first *eligible*, blocked entries remain.
- §Restart durability (queue + attempts persisted before spawn) → Task A.
- §Staleness eviction / one slot owner → Task E + `last_fired`-at-enqueue (already shipped).
- Build order matches spec §"Build order": persistence → deps eligibility+cascade → retry → cycle rejection → staleness.

**Placeholder scan:** no TBD/TODO; every code step has concrete code. `h0Heartbeat` test helper is introduced in Task B Step 1 and reused in C/E — define it once with fields `{attempts, done}` building a full `Heartbeat`.

**Type consistency:** `readCompletions()` returns `{running, done}` throughout; `attempts`/`last_run`/`last_success` are `Record<string,number>` in both `Heartbeat` (Task A) and `TickState` (Task A); `MAX_ATTEMPTS`/`FATAL_EXIT_CODE` live in `constants.ts` (Task C) and are imported by daemon + tests; `upstreamsOf` is defined once and shared by validation (Task D) and cascade (Task B) — Task D's step notes the dedupe. `RunQueue.remove` (Task B) is used by cascade, eligibility-skip, and staleness (Tasks B/E).

**Ordering note:** Task B introduces a local `MAX_ATTEMPTS`; Task C promotes it to `constants.ts` and Task B's site switches to the import. If executing strictly in order this is a two-line follow-up in Task C — flagged so the executor doesn't leave a duplicate const.

---

## Execution Handoff

Implement Tasks A → E in order; each is independently testable and committable. Recommended: subagent-driven-development (fresh subagent per task, review between). Given the shared `daemon.ts` surface across all five tasks, inline execution with a full `bun test` after each task is also reasonable and avoids worktree churn on one file.
