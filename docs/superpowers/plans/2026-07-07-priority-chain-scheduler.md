# Priority-Chain Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn cronbird from fire-and-forget dispatch into a priority run-queue that serializes due jobs (N=1) and advances the chain on completion, so clustered fires queue instead of racing a lock and dropping.

**Architecture:** A pure `RunQueue` holds due jobs by priority. The daemon loop enqueues due jobs (instead of dispatching them), reads file-based completion state written by the dispatch wrapper, and drains the queue up to a concurrency cap. Queue + running state persist in the heartbeat so a daemon restart resumes the backlog. Children stay detached (`unref()`), so completion is observed via `done/` state files on the next tick, not an in-process listener.

**Tech Stack:** TypeScript, Bun (`bun test`, `bun:test`). Pure-logic core with injected side effects (existing `DaemonDeps` pattern).

## Global Constraints

- Runtime: **Bun**; tests use `import { describe, expect, test } from "bun:test"`.
- Engine stays **product-agnostic**: `Job.metadata` is opaque `T`; priority comes from an injected resolver, never a hardcoded field.
- Control loop **never awaits a child**; all side effects injected via `DaemonDeps`.
- **At-most-once**: persist heartbeat (incl. queue) **before** any spawn; a crash drops, never doubles.
- **Fail-safe reads**: a torn/missing state read = "nothing runs" / reuse last-good, never "run everything".
- Concurrency **N=1** (constant `MAX_CONCURRENT = 1`); read-tier parallelism is out of scope.
- Commit messages: no `claude`/`anthropic`/`co-authored` text.

**Out of scope (separate plan):** `ceo-cron.sh` wrapper changes — writing `running/`+`done/` state files, reserved skip exit code, and demoting the `flock`/cooldown to backstops. That is bash in the `claude-ceo` repo; this plan delivers the TS engine that consumes those files.

---

### Task 1: RunQueue (pure priority queue)

**Files:**
- Create: `src/core/run-queue.ts`
- Test: `tests/run-queue.test.ts`

**Interfaces:**
- Produces: `class RunQueue { enqueue(name: string, priority: number): boolean; dequeue(): string | null; has(name: string): boolean; size(): number; snapshot(): {name: string; priority: number}[] }`
- Consumes: nothing.

Lower priority number = higher precedence; FIFO among equal priority; `enqueue` dedupes by name (returns `false` if already queued). `snapshot()` returns queued entries in dequeue order (for heartbeat persistence, Task 5).

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, test } from "bun:test";
import { RunQueue } from "../src/core/run-queue";

describe("RunQueue", () => {
  test("enqueue dedupes by name", () => {
    const q = new RunQueue();
    expect(q.enqueue("a", 5)).toBe(true);
    expect(q.enqueue("a", 1)).toBe(false); // already queued, priority NOT updated
    expect(q.size()).toBe(1);
  });

  test("dequeue returns lowest priority number first", () => {
    const q = new RunQueue();
    q.enqueue("lo", 10); q.enqueue("hi", 1); q.enqueue("mid", 5);
    expect(q.dequeue()).toBe("hi");
    expect(q.dequeue()).toBe("mid");
    expect(q.dequeue()).toBe("lo");
  });

  test("FIFO among equal priority", () => {
    const q = new RunQueue();
    q.enqueue("first", 5); q.enqueue("second", 5); q.enqueue("third", 5);
    expect([q.dequeue(), q.dequeue(), q.dequeue()]).toEqual(["first", "second", "third"]);
  });

  test("dequeue on empty returns null; has/size track state", () => {
    const q = new RunQueue();
    expect(q.dequeue()).toBeNull();
    q.enqueue("a", 1);
    expect(q.has("a")).toBe(true);
    q.dequeue();
    expect(q.has("a")).toBe(false);
    expect(q.size()).toBe(0);
  });

  test("snapshot returns entries in dequeue order", () => {
    const q = new RunQueue();
    q.enqueue("lo", 10); q.enqueue("hi", 1);
    expect(q.snapshot()).toEqual([{ name: "hi", priority: 1 }, { name: "lo", priority: 10 }]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/run-queue.test.ts`
Expected: FAIL — `Cannot find module '../src/core/run-queue'`.

- [ ] **Step 3: Implement**

```typescript
interface Entry { name: string; priority: number; seq: number }

export class RunQueue {
  private entries: Entry[] = [];
  private names = new Set<string>();
  private seq = 0;

  enqueue(name: string, priority: number): boolean {
    if (this.names.has(name)) return false;
    this.names.add(name);
    this.entries.push({ name, priority, seq: this.seq++ });
    return true;
  }

  private ordered(): Entry[] {
    // lowest priority number first; FIFO (insertion seq) among equal priority.
    return [...this.entries].sort((a, b) => a.priority - b.priority || a.seq - b.seq);
  }

  dequeue(): string | null {
    if (this.entries.length === 0) return null;
    const next = this.ordered()[0];
    this.entries.splice(this.entries.indexOf(next), 1);
    this.names.delete(next.name);
    return next.name;
  }

  has(name: string): boolean { return this.names.has(name); }
  size(): number { return this.entries.length; }
  snapshot(): { name: string; priority: number }[] {
    return this.ordered().map(({ name, priority }) => ({ name, priority }));
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/run-queue.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/run-queue.ts tests/run-queue.test.ts
git commit -m "feat: add RunQueue priority queue for the scheduler chain"
```

---

### Task 2: Heartbeat + completion-state types

**Files:**
- Modify: `src/core/types.ts`
- Test: `tests/types-shape.test.ts` (new — compile-time shape guard via a typed fixture)

**Interfaces:**
- Produces: extended `Heartbeat` with `queue: QueueEntry[]`, `running: Record<string, number>` (name → startedTs), `last_completed: Record<string, CompletionRecord>`. New exported types `QueueEntry = { name: string; priority: number; slotTs: number }` and `CompletionRecord = { ts: number; exitCode: number; durationMs: number }`.
- Consumes: existing `Heartbeat`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import type { Heartbeat, QueueEntry, CompletionRecord } from "../src/core/types";

describe("heartbeat shape", () => {
  test("carries queue, running, last_completed", () => {
    const q: QueueEntry = { name: "morning", priority: 1, slotTs: 0 };
    const c: CompletionRecord = { ts: 1, exitCode: 0, durationMs: 42 };
    const hb: Heartbeat = {
      ts: 0, host: "ml-1", runnable_count: 0, next_wake_ts: 0,
      last_dispatch: [], dispatched_minute: {}, last_fired: {},
      queue: [q], running: { morning: 5 }, last_completed: { morning: c },
    };
    expect(hb.queue[0].name).toBe("morning");
    expect(hb.running.morning).toBe(5);
    expect(hb.last_completed.morning.exitCode).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/types-shape.test.ts`
Expected: FAIL — TS error: `queue`/`running`/`last_completed` not on `Heartbeat`; `QueueEntry`/`CompletionRecord` not exported.

- [ ] **Step 3: Implement — extend `src/core/types.ts`**

```typescript
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
```

Add to the existing `Heartbeat` interface:

```typescript
  /** Persisted priority queue so a restart resumes the backlog. */
  queue: QueueEntry[];
  /** jobName → startedTs of an in-flight run (restored from running/ dir). */
  running: Record<string, number>;
  /** jobName → last completion (exit code + duration) for cooldown + metrics. */
  last_completed: Record<string, CompletionRecord>;
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/types-shape.test.ts`
Expected: PASS. Also run `bun test` — existing heartbeat writers will now fail to typecheck until Task 5 fills the fields; if the daemon test breaks on the missing fields, that's expected and fixed in Task 5. If you want a green tree between tasks, add the three fields as `?`-optional here and tighten to required in Task 5. **Choose optional-now → required-in-Task-5** to keep the tree green.

Revise the three additions to optional for now:

```typescript
  queue?: QueueEntry[];
  running?: Record<string, number>;
  last_completed?: Record<string, CompletionRecord>;
```

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts tests/types-shape.test.ts
git commit -m "feat: add queue/running/last_completed to Heartbeat types"
```

---

### Task 3: Completion-state + priority deps; enqueue due jobs

**Files:**
- Modify: `src/core/daemon.ts` (DaemonDeps + tick body)
- Test: `tests/daemon-enqueue.test.ts`

**Interfaces:**
- Consumes: `RunQueue` (Task 1); `Heartbeat.queue/running/last_completed` (Task 2).
- Produces: two new `DaemonDeps` methods — `priority(job: Job<T>): number` and `readCompletions(): { running: Record<string, number>; done: Record<string, CompletionRecord> }` (reads the wrapper's `running/`+`done/` dirs; fail-safe → `{running:{}, done:{}}` on torn read). Behavior: due jobs are **enqueued** (not dispatched); `last_fired` is stamped at **enqueue**.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { runOneTick } from "../src/core/daemon"; // extracted single-tick helper (Step 3)
import { makeDeps } from "./helpers/deps"; // test helper factory (create alongside)

describe("daemon enqueues due jobs by priority", () => {
  test("two due jobs are enqueued, not dispatched; higher priority drains first", () => {
    const dispatched: string[] = [];
    const q = new RunQueue();
    const deps = makeDeps({
      dueNames: ["low", "high"],
      priority: (j) => (j.name === "high" ? 1 : 10),
      dispatch: (n) => dispatched.push(n),
      readCompletions: () => ({ running: {}, done: {} }),
      queue: q,
    });
    runOneTick(deps);
    // N=1: exactly one drained (the higher-priority), the other waits in queue
    expect(dispatched).toEqual(["high"]);
    expect(q.has("low")).toBe(true);
  });
});
```

(Create `tests/helpers/deps.ts` exporting `makeDeps(overrides)` that returns a full `DaemonDeps` with a fake clock, a matcher whose `dueAt` yields `dueNames`, and no-op recorders. Import `RunQueue` in the test.)

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/daemon-enqueue.test.ts`
Expected: FAIL — `runOneTick` not exported; `priority`/`readCompletions` not on deps.

- [ ] **Step 3: Implement**

1. Add to `DaemonDeps<T>`:

```typescript
  /** Product-supplied precedence; lower number = higher precedence. */
  priority(job: Job<T>): number;
  /** File-based run state written by the dispatch wrapper. Fail-safe on torn read. */
  readCompletions(): { running: Record<string, number>; done: Record<string, CompletionRecord> };
```

2. Extract the per-tick body of `runForever` into an exported `runOneTick(deps, state)` where `state` holds the persistent `RunQueue`, `guard`, `lastFired`, `recent`, `lastGood*`. `runForever` becomes: build `state`, then `while (shouldContinue()) { runOneTick(deps, state); await sleep(wake) }`.

3. In `runOneTick`, replace the two dispatch loops. First compute `due`/`catches` as today, but **enqueue** each instead of dispatching, stamping `last_fired` at enqueue:

```typescript
for (const p of due) {
  state.guard.set(p.name, minute);
  if (state.queue.enqueue(p.name, deps.priority(jobByName.get(p.name)!))) {
    state.lastFired[p.name] = minuteStart; // stamp at ENQUEUE (single slot owner)
  }
}
for (const f of catches) {
  if (state.queue.enqueue(f.job.name, deps.priority(f.job))) {
    state.lastFired[f.job.name] = Math.max(state.lastFired[f.job.name] ?? 0, f.slot.getTime());
  }
}
```

(Draining happens in Task 4. For this task's test to pass with N=1, add a minimal drain: `if (running.size < 1) { const n = state.queue.dequeue(); if (n) deps.dispatch(n); }` — Task 4 replaces it with the full policy.)

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/daemon-enqueue.test.ts && bun test`
Expected: enqueue test PASS; existing daemon tests still PASS (dispatch still happens, just via the queue).

- [ ] **Step 5: Commit**

```bash
git add src/core/daemon.ts tests/daemon-enqueue.test.ts tests/helpers/deps.ts
git commit -m "feat: enqueue due jobs by priority, stamp last_fired at enqueue"
```

---

### Task 4: Drain up to concurrency cap from running count

**Files:**
- Modify: `src/core/daemon.ts`
- Modify: `src/core/constants.ts` (add `MAX_CONCURRENT = 1`)
- Test: `tests/daemon-drain.test.ts`

**Interfaces:**
- Consumes: `readCompletions()` (Task 3), `RunQueue`, `MAX_CONCURRENT`.
- Produces: drain step — while `runningCount < MAX_CONCURRENT` and queue non-empty, dequeue + `dispatch`; `runningCount` = size of `readCompletions().running` plus jobs dispatched this tick not yet reflected in `running/`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { runOneTick } from "../src/core/daemon";
import { makeDeps } from "./helpers/deps";
import { RunQueue } from "../src/core/run-queue";

describe("drain respects N=1 and advances on completion", () => {
  test("holds queue while one is running", () => {
    const dispatched: string[] = [];
    const q = new RunQueue(); q.enqueue("a", 1); q.enqueue("b", 2);
    const deps = makeDeps({
      dueNames: [], dispatch: (n) => dispatched.push(n),
      readCompletions: () => ({ running: { x: 100 }, done: {} }), // one already running
      queue: q,
    });
    runOneTick(deps);
    expect(dispatched).toEqual([]); // cap reached, nothing drained
    expect(q.size()).toBe(2);
  });

  test("drains next when nothing running", () => {
    const dispatched: string[] = [];
    const q = new RunQueue(); q.enqueue("a", 1); q.enqueue("b", 2);
    const deps = makeDeps({
      dueNames: [], dispatch: (n) => dispatched.push(n),
      readCompletions: () => ({ running: {}, done: {} }),
      queue: q,
    });
    runOneTick(deps);
    expect(dispatched).toEqual(["a"]); // one drained, N=1
    expect(q.size()).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/daemon-drain.test.ts`
Expected: FAIL — first test drains despite a running job (minimal drain from Task 3 ignores `running`).

- [ ] **Step 3: Implement**

In `src/core/constants.ts`: `export const MAX_CONCURRENT = 1;`

Replace the minimal drain with:

```typescript
const completions = deps.readCompletions();
let runningCount = Object.keys(completions.running).length;
while (runningCount < MAX_CONCURRENT) {
  const next = state.queue.dequeue();
  if (next === null) break;
  deps.dispatch(next);       // wrapper will write running/<next> shortly
  runningCount++;            // count this tick's dispatch immediately (avoid over-draining before running/ appears)
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/daemon-drain.test.ts && bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/daemon.ts src/core/constants.ts tests/daemon-drain.test.ts
git commit -m "feat: drain queue up to N=1 based on running count"
```

---

### Task 5: Persist queue + running/completions in heartbeat; restore on restart

**Files:**
- Modify: `src/core/daemon.ts` (heartbeat write + startup restore); `src/core/types.ts` (tighten the three fields to required)
- Test: `tests/daemon-restart.test.ts`

**Interfaces:**
- Consumes: `Heartbeat.queue/running/last_completed`, `RunQueue.snapshot()`, `readCompletions()`.
- Produces: heartbeat now includes `queue: state.queue.snapshot() (+slotTs)`, `running` (from `readCompletions`), `last_completed` (merged from `done`); `runForever` restores the `RunQueue` from `prior.queue` at startup.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { runForever } from "../src/core/daemon";
import { makeDeps } from "./helpers/deps";

describe("restart durability", () => {
  test("queued backlog is persisted and re-enqueued on restart", async () => {
    const written: any[] = [];
    // Run 1: two jobs due, one running elsewhere → both queued, none drained, heartbeat persists queue.
    const deps1 = makeDeps({
      dueNames: ["a", "b"], priority: (j) => (j.name === "a" ? 1 : 2),
      readCompletions: () => ({ running: { x: 1 }, done: {} }),
      writeHeartbeat: (hb) => written.push(hb), ticks: 1,
    });
    await runForever(deps1);
    const hb = written.at(-1);
    expect(hb.queue.map((e: any) => e.name)).toEqual(["a", "b"]);

    // Run 2: restart with that heartbeat, nothing running now → drains "a" first.
    const dispatched: string[] = [];
    const deps2 = makeDeps({
      dueNames: [], readHeartbeat: () => hb,
      readCompletions: () => ({ running: {}, done: {} }),
      dispatch: (n) => dispatched.push(n), ticks: 1,
    });
    await runForever(deps2);
    expect(dispatched).toEqual(["a"]);
  });
});
```

(Extend `makeDeps` with a `ticks` count so `shouldContinue()` returns true that many times; and a settable `readHeartbeat`.)

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/daemon-restart.test.ts`
Expected: FAIL — heartbeat has no `queue`, or restart starts with an empty queue.

- [ ] **Step 3: Implement**

1. In the heartbeat write, add:

```typescript
queue: state.queue.snapshot().map((e) => ({ ...e, slotTs: state.lastFired[e.name] ?? now.getTime() })),
running: deps.readCompletions().running,
last_completed: { ...priorCompleted, ...deps.readCompletions().done },
```

2. At `runForever` startup, restore the queue from the prior heartbeat:

```typescript
const queue = new RunQueue();
for (const e of prior?.queue ?? []) queue.enqueue(e.name, e.priority);
```

Put `queue` into `state`.

3. Tighten the three `Heartbeat` fields in `types.ts` from optional to required (remove the `?`).

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/daemon-restart.test.ts && bun test`
Expected: PASS across the suite (all heartbeat writers now populate the required fields).

- [ ] **Step 5: Commit**

```bash
git add src/core/daemon.ts src/core/types.ts tests/daemon-restart.test.ts
git commit -m "feat: persist and restore the run-queue across restart"
```

---

### Task 6: Staleness eviction of superseded slots

**Files:**
- Modify: `src/core/daemon.ts` (drain step)
- Test: `tests/daemon-staleness.test.ts`

**Interfaces:**
- Consumes: `QueueEntry.slotTs`, `resolveLookback(schedule, now)` (existing dep), `RunQueue`.
- Produces: before dispatching a dequeued job, if its `slotTs` is older than `now - resolveLookback(schedule, now)`, evict (skip dispatch, log) — don't run a stale slot late.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { runOneTick } from "../src/core/daemon";
import { makeDeps } from "./helpers/deps";
import { RunQueue } from "../src/core/run-queue";

describe("staleness eviction", () => {
  test("a slot older than the lookback is evicted, not dispatched", () => {
    const dispatched: string[] = [];
    const q = new RunQueue(); q.enqueue("stale", 1);
    const deps = makeDeps({
      dueNames: [], dispatch: (n) => dispatched.push(n),
      readCompletions: () => ({ running: {}, done: {} }),
      resolveLookback: () => 60_000, // 1 min window
      queueEntrySlotTs: { stale: 0 }, // enqueued at epoch 0; now is far later
      nowMs: 10 * 60_000, // 10 min later → stale
      queue: q,
    });
    runOneTick(deps);
    expect(dispatched).toEqual([]);
    expect(q.has("stale")).toBe(false); // evicted
  });
});
```

(For eviction the drain needs each entry's `slotTs`. Track it in `state` as `slotTsByName: Record<string, number>` populated at enqueue, or have `RunQueue.dequeue` return the entry. Simplest: extend `state` with `slotTsByName`; `makeDeps` seeds it via `queueEntrySlotTs`.)

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/daemon-staleness.test.ts`
Expected: FAIL — "stale" is dispatched.

- [ ] **Step 3: Implement**

In the drain loop, after `dequeue()`:

```typescript
const slotTs = state.slotTsByName[next] ?? now.getTime();
const schedule = jobByName.get(next)?.cronSchedule ?? "";
if (now.getTime() - slotTs > deps.resolveLookback(schedule, now)) {
  deps.log(`evicted stale slot ${next} (age ${now.getTime() - slotTs}ms)`);
  delete state.slotTsByName[next];
  continue; // do not count against runningCount
}
delete state.slotTsByName[next];
deps.dispatch(next);
runningCount++;
```

Populate `state.slotTsByName[name] = <slotTs>` at enqueue (Task 3 site) and restore it from `prior.queue` (Task 5 site).

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/daemon-staleness.test.ts && bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/daemon.ts tests/daemon-staleness.test.ts
git commit -m "feat: evict stale queued slots past the catch-up lookback"
```

---

## Self-Review

**Spec coverage:**
- §1 completion tracking (file-based) → consumed via `readCompletions()` dep (Task 3); the wrapper that *writes* the files is the separate bash plan (noted in Global Constraints).
- §2 RunQueue → Task 1. §3 chain/N=1 → Task 4. §4 priority resolver → Task 3 (`priority` dep). §5 single-scheduler cooldown → the *enqueue-gate* on cooldown belongs to the `priority`/enqueue path; **cooldown-before-enqueue is not yet its own task** — see gap below. §6 staleness/one-slot-owner → Task 6 + last_fired-at-enqueue (Task 3). §7 timeout → out of scope (ceo-cron keeps the killer). Restart durability → Task 5.
- **Gap found:** the spec's "cronbird enforces cooldown before enqueue (§5)" has no task. **Add Task 3.5:** in the enqueue step, skip enqueue when `now - last_completed[name].ts < cooldown(job)` (cooldown via a `cooldownSeconds(job): number` resolver dep, product-agnostic). Test: a job completed 5 min ago with a 30-min cooldown is not enqueued when due. Insert between Tasks 3 and 4.

**Placeholder scan:** no TBD/TODO; every code step has concrete code. The `makeDeps` helper is described with its required knobs (dueNames, priority, dispatch, readCompletions, readHeartbeat, ticks, resolveLookback, queueEntrySlotTs, nowMs, queue) — implement it in Task 3 Step 1 and extend per later tasks.

**Type consistency:** `readCompletions()` returns `{running, done}` consistently (Tasks 3–5); `QueueEntry`/`CompletionRecord` names match Task 2; `MAX_CONCURRENT` used in Task 4; `snapshot()` shape matches Task 1 + Task 5 usage (Task 5 adds `slotTs` at write time).

---

## Execution Handoff

Add **Task 3.5 (cooldown-before-enqueue)** per the self-review before executing. Then implement Tasks 1 → 6 in order (each is independently testable and committable).
