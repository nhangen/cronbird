# cronbird: Priority-Chain Scheduler + Completion Tracking — Design

**Date:** 2026-07-07
**Status:** design / approved (approach B; audit-folded; dependency chain added as foundation)
**Scope:** cronbird engine (completion tracking + priority run-queue + N=1 chain
+ **job dependency chain** with retry + cascade) and the ceo-cron.sh integration
(lock/cooldown demotion). Not the ticket-triage schedule config fix (separate).

## Problem

cronbird's control loop (`daemon.ts`) fires every due job via `dispatch(name)` →
`ShellDispatcher` runs `Bun.spawn(...).unref()` with stdout/stderr ignored.
**cronbird never learns when a job finishes.** The dispatch target,
`ceo-cron.sh <trigger>`, serializes *all* playbooks behind **one global lock**
(`ceo-cron.lock`, `flock -w 30 200` at ceo-cron.sh:902). When a long Claude job
holds the lock, every other job dispatched in that window hits the 30s timeout,
`exit 0`s, and logs a line to `cron-skips.log`. That is a **silent drop, not a
queue** (~41 observed). The scheduler has no backpressure, no priority, and no
completion awareness.

## Goal

Replace "N processes fight one lock, losers dropped after 30s" with "cronbird
enqueues due jobs by priority and drains them as a chain — the next fires only
when the current completes." **Blocking (wait your turn), not locking (race +
drop).** A WordPress-style priority chain.

## Dependency chain (foundation)

Completion tracking exists to gate dependents on pass/fail. A job declares
prerequisites in frontmatter; the engine reads them via an injected
`dependencies(job): string[]` resolver (product-agnostic; `Job.metadata` opaque).

```yaml
dependsOn: [gather-data]   # runs only after gather-data succeeds "since I last ran"
```

**Eligibility ("succeeded since last run" — user decision 1).** A queued job `D`
is eligible to dispatch iff, for every upstream `U` in `dependencies(D)`, `U` has
a **success timestamped after `D`'s own last run** (`lastSuccess[U] > lastRun[D]`;
if `D` never ran, any `U` success qualifies). Cross-cadence-safe: a daily `D`
waits for the next success of an hourly `U`, uses a *fresh* result every time, and
never double-fires on the same upstream success (once `D` runs, `lastRun[D]`
advances, so it needs a *new* `U` success to run again). Independent jobs (no
`dependsOn`) are always eligible (subject to cooldown / retry backoff).

**Retry on failure ("three strikes, back of line" — user decision 2).** On a
non-zero `done/<job>` exit: increment `attempts[job]` (persisted) and **re-enqueue
at the back of the line** (its own priority; FIFO puts it behind current entries).
attempt 1 fails → back of line; attempt 2 fails → back of line; **attempt 3 fails
→ mark failed/not-run** (no requeue). `MAX_ATTEMPTS = 3`. Fatal exit codes (e.g.
missing-credential `requires:` gate) **fail-fast** — straight to failed — so we
don't burn 3 Claude runs on a guaranteed loss.

**Cascade on final failure.** "Failed" is a **pure function of persisted state**:
`attempts[job] >= MAX_ATTEMPTS && last done exit ≠ 0`. Each tick, any job that
(transitively) `dependsOn` a failed job is **cascade-cancelled** for this cycle —
removed from the queue, not re-enqueued, logged. Recomputing from persisted state
each tick makes a crash mid-cascade re-derive the same decision (crash-safe by
construction). Under N=1 a dependent can never be mid-run when its upstream fails
(only one runs at a time), so cascade only touches *queued* jobs — never a live
process. Diamond (D←B,C←A): A failing cancels B, C, and therefore D.

**Cycles / bad edges** are rejected at registry load (topological check): a
dependency cycle or an edge to an unknown job **fails that job** (not silently the
edge — a dropped edge would let a dependent run prematurely), logged loudly.

**Liveness.** A backing-off / re-queued job stays a live queue entry, so a tick
where every queued job is dependency-blocked simply idles and re-evaluates next
tick — the queue never declares "done" while any entry remains.

## Invariants preserved

- **At-most-once dispatch** — a crash drops a fire rather than doubling it.
- **Catch-up replay** of slots missed while the daemon was down.
- **Product-agnostic engine** — `Job.metadata` stays opaque `T`; priority is
  injected, not baked in.
- **Non-blocking control loop** — the tick never awaits a child.
- **Fail-safe reads** — a torn/missing state read means "nothing runs" or
  "reuse last-good", never "run everything".

## Components

### 1. Completion tracking — file-based (children stay detached)

A thin dispatch wrapper owns the run lifecycle via durable state files under
`CEO/log/.cronbird/`:

- On entry: write `running/<job>` = `{ startedTs, pid }`.
- On exit (shell `trap … EXIT`): write `done/<job>` =
  `{ exitCode, endedTs, durationMs }` and remove `running/<job>`.

cronbird **reads** `running/` and `done/` each tick — the same file-state pattern
it already uses for heartbeat/enabled/topology. Children remain detached
(`unref()` retained), so a daemon restart never kills an in-flight Claude job,
and the loop stays non-blocking. The chain advances on the tick that observes a
`done/` file (event-on-next-tick, consistent with cronbird's file-state model).

New heartbeat fields for observability: `last_completed: Record<name, {ts,
exitCode, durationMs}>` — the "handy metric a cron tool should have."

> **Why not an in-process `exit` listener?** It would force un-`unref()`-ing
> children, tying them to daemon lifetime (restart orphans/kills in-flight jobs)
> and changing the crash model. File-based reaping avoids that entirely.

### 2. Priority run-queue

In-memory `RunQueue` (product-agnostic):

- `enqueue(name, priority): boolean` — dedupe by name (already queued → `false`);
  lower priority number = higher precedence.
- `dequeue(): string | null` — lowest priority number; FIFO among equal priority.
- `has(name): boolean`, `size(): number`.

Each tick, due jobs are **enqueued by priority** instead of dispatched
immediately.

### 3. The chain (concurrency policy)

- At most **N = 1** job running (full serialization — the ask; mirrors today's
  behavior minus the drops).
- While `running.size >= N`, hold the queue. On a completion (`done/` observed) →
  dequeue the next highest-priority job and dispatch it. Jobs wait in priority
  order; none are dropped.

### 4. Priority source (injected)

Engine reads priority via an injected `priority(job): number` resolver. The CEO
layer maps tier/importance → number (lower = higher precedence). Engine stays
agnostic; `Job.metadata` untouched.

### 5. cronbird as single scheduler-of-truth

Now that cronbird has completion data, it owns **concurrency and cooldown**:
it enforces `cooldown` before enqueue (using `last_completed`). ceo-cron.sh's
global `flock -w 30` and per-trigger cooldown **demote to backstops** — they
still guard a stray/manual/second-host caller, but are no longer the primary
serialization. This resolves the double-gating false-success trap (a job
dispatched into a ceo-cron cooldown-skip would `exit 0` and be recorded as a
clean success — the `non-throwing-client-success-check` failure mode). The
wrapper distinguishes ran vs skipped via a reserved exit code so a backstop skip
is recorded as **skip**, not success.

### 6. Staleness eviction — one slot owner

`last_fired` is stamped at **enqueue**, not dispatch. `catchUpFires` already keys
on `last_fired`, so a queued slot counts as "fired" for catch-up — eviction and
catch-up can never double-count the same slot. A queued job whose schedule has
since produced a newer slot is evicted (don't run a stale 3am morning at noon),
bounded by the existing catch-up look-back.

### 7. Timeout — one kill owner

ceo-cron.sh keeps its existing `TIMEOUT_BIN` wall-clock cap (the killer).
cronbird only **observes** a stale `running/<job>` (age > cap) to un-wedge the
chain if a kill somehow didn't record. No duplicate timeout logic.

## Restart durability

- The queue is **persisted in the heartbeat** (`queue: {name, priority,
  slotTs}[]`) and re-enqueued on startup — an in-memory-only queue would lose the
  whole backlog on a daemon restart (a regression vs today's independent
  processes). Stale entries are dropped on restore per §6.
- `running` is restored by reading the `running/` state dir, not assumed empty.
- At-most-once holds: heartbeat + queue persisted **before** any spawn; a job in
  `running` whose process is gone on restart is **not** auto-resumed (drop, not
  double — matching current semantics).

## Data flow

```
tick → select runnable → enqueue due jobs by priority (dedupe, stamp last_fired)
     → persist heartbeat (queue + running snapshot) BEFORE any spawn
     → read done/ files → record completion, decrement running
     → drain queue up to N → wrapper spawns detached child (writes running/)
child exits → wrapper writes done/ → next tick observes it → drain next (chain)
```

## Error handling

- **Crash mid-run:** heartbeat+queue persisted before spawn; `running` job not
  auto-resumed on restart (at-most-once = drop not double).
- **Hung child:** ceo-cron `TIMEOUT_BIN` kills; cronbird's stale-`running`
  observation un-wedges the chain.
- **Backstop cooldown/lock skip:** wrapper records it as skip (reserved exit
  code), never a false success.
- **Unbounded queue:** prevented by dedupe + staleness eviction.
- **Torn state read:** fail-safe (nothing runs / reuse last-good), per existing
  daemon contract.

## Testing (fake clock + fake Dispatcher, matching existing daemon test style)

- **RunQueue units:** dedupe on enqueue; dequeue priority + FIFO tie-break;
  has/size. (Adversarial ordering case included — the position-blind-comparator
  trap that passes small N by luck.)
- **Daemon:** due jobs enqueue by priority; concurrency cap holds at N=1; a
  `done/` observation drains the next; stale slot evicted; at-most-once across a
  restart with a job left in `running`; queue restored from heartbeat on restart.
- **Cooldown ownership:** a job inside cooldown is not enqueued; a backstop skip
  is recorded as skip, not success.
- **Integration:** two clustered write-tier jobs → serialized, **zero drops**;
  lower priority runs only after higher completes.
- Each test fails when its guard is reverted.

## Decisions

- **Concurrency = N=1 global** — the ask ("serialize the chain, no drops").
  Read-tier parallelism is a deferred future toggle, not v1.
- **Lock demotion assumes ceo-cron.sh is single-caller on ML-1** (only cronbird
  invokes it). If a second caller ever exists, the backstop lock still guards it.
- **Dependency success = "succeeded since the dependent last ran"** (user
  decision 1): `lastSuccess[U] > lastRun[D]`.
- **Retry = three strikes, back of line** (user decision 2): fail → re-enqueue at
  back; 3rd failure → mark failed/not-run; fatal exit codes fail-fast.

## Build order (dependency chain is foundation, so it precedes staleness)

1. Persistence (queue + `attempts` + `lastRun`/`lastSuccess`) — prerequisite for
   surviving retry counts and dependency state across restart.
2. Dependency resolver + eligibility gate + transitive cascade-cancel.
3. Retry (three-strikes, back-of-line, fatal fail-fast).
4. Registry-load cycle/unknown-edge rejection.
5. Staleness eviction (shares the slot/eligibility machinery).

Already built (priority enqueue, N=1 chain, cooldown gate, `runOneTick`
extraction) stands; the drain becomes dependency-eligibility-aware.

## Out of scope

- ticket-triage-autopilot schedule/cooldown config fix (`*/30` vs cooldown
  mismatch, ~670 skip lines) — separate one-line change.
- Tier-aware / parallel read-tier concurrency (future toggle).
- Discord/observability surfacing of the new completion metrics.
