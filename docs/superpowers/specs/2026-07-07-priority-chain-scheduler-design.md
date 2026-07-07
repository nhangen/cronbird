# cronbird: Priority-Chain Scheduler + Completion Tracking — Design

**Date:** 2026-07-07
**Status:** design / approved (approach B; audit-folded)
**Scope:** cronbird engine (completion tracking + priority run-queue + N=1 chain)
and the ceo-cron.sh integration (lock/cooldown demotion). Not the ticket-triage
schedule config fix (tracked separately).

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

## Decisions (were open questions; answerable, not the user's to adjudicate)

- **Concurrency = N=1 global** — that is the ask ("serialize the chain, no
  drops"). Read-tier parallelism is a deferred future toggle, not v1.
- **Lock demotion assumes ceo-cron.sh is single-caller on ML-1** (only cronbird
  invokes it). If a second caller ever exists, the backstop lock still guards it.

## Out of scope

- ticket-triage-autopilot schedule/cooldown config fix (`*/30` vs cooldown
  mismatch, ~670 skip lines) — separate one-line change.
- Tier-aware / parallel read-tier concurrency (future toggle).
- Discord/observability surfacing of the new completion metrics.
