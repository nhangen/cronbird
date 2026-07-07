import { describe, expect, test } from "bun:test";
import { lookbackForSchedule } from "../src/core/catchup";
import { createMatcher } from "../src/core/cron";
import type { Job, Topology, Heartbeat, CompletionRecord } from "../src/core/types";
import { type DaemonDeps, runForever } from "../src/core/daemon";
import { CATCHUP_LOOKBACK_CAP_MS, CATCHUP_LOOKBACK_FLOOR_MS, FATAL_EXIT_CODE } from "../src/core/constants";

const m = createMatcher({ timezone: "UTC" });
const d = (iso: string) => new Date(iso);

const pb = (over: Partial<Job<unknown>>): Job<unknown> => ({
  name: "p",
  cronSchedule: "0 9 * * *",
  isActive: true,
  hosts: ["*"],
  scope: "each",
  metadata: {},
  ...over,
});

/**
 * Build a full Heartbeat for restart tests. `queue` restores a backlog;
 * `attempts` seeds retry counters; `done` maps jobName → exitCode for the
 * last_completed record (ts fixed at 1). Everything else empties.
 */
const h0Heartbeat = (over: {
  queue?: { name: string; priority: number; slotTs: number }[];
  attempts?: Record<string, number>;
  done?: Record<string, number>;
  last_success?: Record<string, number>;
}): Heartbeat => ({
  ts: 0,
  host: "ml-1",
  runnable_count: 0,
  next_wake_ts: 0,
  last_dispatch: [],
  dispatched_minute: {},
  last_fired: {},
  queue: over.queue ?? [],
  running: {},
  last_completed: Object.fromEntries(
    Object.entries(over.done ?? {}).map(([n, exit]) => [n, { ts: 1, exitCode: exit, durationMs: 0 }]),
  ),
  attempts: over.attempts ?? {},
  last_run: {},
  last_success: over.last_success ?? {},
});

interface HarnessOpts {
  nows: Date[];
  playbooks: Job<unknown>[] | (() => { jobs: Job<unknown>[]; warnings: string[] });
  startHeartbeat?: Heartbeat | null;
  host?: string;
  cap?: number;
  /** Pin a fixed look-back for all schedules (the env-override path). Omit to use the production-default derived resolver. */
  lookback?: number;
  /**
   * Per-tick topology reads (mirrors `loadTopology`). `null` simulates a torn read.
   * Default: a single static topology with the given `owners`, returned every tick.
   */
  topologies?: (Topology | null)[];
  /** Owners for the default static topology (when `topologies` is not supplied). */
  owners?: Record<string, string>;
  /**
   * Per-tick enabled reads (mirrors `loadEnabled`). When supplied, REPLACES the
   * default accumulate-every-loaded-name behavior. A `null` entry simulates a
   * torn read → empty set that tick.
   */
  enabledByTick?: (Set<string> | null)[];
  /** Product precedence resolver; lower number = higher precedence. Default: () => 0. */
  priority?: (job: Job<unknown>) => number;
  /** File-based run state. Default: nothing running / nothing done. */
  readCompletions?: () => { running: Record<string, number>; done: Record<string, CompletionRecord> };
  /** Per-job cooldown in seconds. Default: () => 0 (no cooldown). */
  cooldownSeconds?: (job: Job<unknown>) => number;
  /** Upstream resolver; job name → its dependency names. Default: () => []. */
  dependencies?: (job: Job<unknown>) => string[];
}

function harness(opts: HarnessOpts) {
  let i = 0;
  const dispatched: string[] = [];
  const sleeps: number[] = [];
  const heartbeats: Heartbeat[] = [];
  const logs: string[] = [];
  let lastHb: Heartbeat | null = null;
  // For each dispatch, the guard minute already persisted to the heartbeat at
  // the moment dispatch is called. undefined ⇒ the guard was NOT yet durable
  // (ordering bug: a crash here would re-fire on restart).
  const guardAtDispatch: Record<string, number | undefined> = {};
  // Same idea for last_fired: the value already persisted to the heartbeat when
  // dispatch is called. Proves catch-up keeps at-most-once even if the two
  // fields are ever split into separate heartbeat writes.
  const lastFiredAtDispatch: Record<string, number | undefined> = {};
  const rawLoader =
    typeof opts.playbooks === "function"
      ? opts.playbooks
      : () => ({ jobs: opts.playbooks as Job<unknown>[], warnings: [] });
  // B3 made selection scope-aware; the legacy dispatch tests predate per-host
  // enablement and assert each-scope jobs dispatch. Default behavior:
  // accumulate every loaded name into `enabled` as the loop loads — wrapping
  // (not pre-calling) the loader so its call counter / throw-on-Nth-call
  // behavior is preserved. The accumulated set is returned each tick by
  // `loadEnabled` unless a per-tick `enabledByTick` override is supplied.
  const enabled = new Set<string>();
  const loader = () => {
    const loaded = rawLoader();
    for (const p of loaded.jobs) enabled.add(p.name);
    return loaded;
  };
  let enabledTick = 0;
  const loadEnabled = (): Set<string> => {
    if (opts.enabledByTick) {
      return opts.enabledByTick[enabledTick++] ?? new Set<string>();
    }
    return new Set(enabled);
  };
  let topologyTick = 0;
  const defaultTopology: Topology = { hosts: [], owners: opts.owners ?? {} };
  const loadTopology = (): Topology | null => {
    if (opts.topologies) {
      return opts.topologies[topologyTick++] ?? null;
    }
    return defaultTopology;
  };

  const deps: DaemonDeps<unknown> = {
    now: () => opts.nows[i++]!,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    loadRegistry: loader,
    loadEnabled,
    loadTopology,
    dispatch: (name) => {
      guardAtDispatch[name] = lastHb?.dispatched_minute[name];
      lastFiredAtDispatch[name] = lastHb?.last_fired[name];
      dispatched.push(name);
    },
    readHeartbeat: () => opts.startHeartbeat ?? null,
    writeHeartbeat: (hb) => {
      heartbeats.push(hb);
      lastHb = hb;
    },
    log: (msg) => {
      logs.push(msg);
    },
    host: opts.host ?? "ml-1",
    matcher: m,
    maxSleepMs: opts.cap ?? 60_000,
    resolveLookback:
      opts.lookback !== undefined
        ? () => opts.lookback as number
        : (schedule, now) => lookbackForSchedule(schedule, now, m, CATCHUP_LOOKBACK_FLOOR_MS, CATCHUP_LOOKBACK_CAP_MS),
    shouldContinue: () => i < opts.nows.length,
    priority: opts.priority ?? (() => 0),
    readCompletions: opts.readCompletions ?? (() => ({ running: {}, done: {} })),
    cooldownSeconds: opts.cooldownSeconds ?? (() => 0),
    dependencies: opts.dependencies ?? (() => []),
  };
  return {
    deps,
    dispatched,
    sleeps,
    heartbeats,
    logs,
    guardAtDispatch: () => guardAtDispatch,
    lastFiredAtDispatch: () => lastFiredAtDispatch,
  };
}

describe("runForever — dispatch + sleep", () => {
  test("dispatches every due job once per tick and sleeps the computed wake", async () => {
    const h = harness({
      nows: [d("2026-06-01T09:00:00Z")],
      playbooks: [pb({ name: "nine", cronSchedule: "0 9 * * *" }), pb({ name: "ten", cronSchedule: "0 10 * * *" })],
    });
    await runForever(h.deps);
    expect(h.dispatched).toEqual(["nine"]);
    // next fire after 09:00 is "nine" at 09:00 tomorrow vs "ten" at 10:00 today → 10:00 today (3600s), capped.
    expect(h.sleeps).toEqual([60_000]);
  });

  test("a mid-minute tick still fires that minute's due set (H2 minute granularity)", async () => {
    const h = harness({ nows: [d("2026-06-01T09:00:43Z")], playbooks: [pb({ name: "nine", cronSchedule: "0 9 * * *" })] });
    await runForever(h.deps);
    expect(h.dispatched).toEqual(["nine"]);
  });

  test("writes a liveness heartbeat every tick even when nothing is due", async () => {
    const h = harness({ nows: [d("2026-06-01T09:30:00Z")], playbooks: [pb({ cronSchedule: "0 9 * * *" })] });
    await runForever(h.deps);
    expect(h.dispatched).toEqual([]);
    expect(h.heartbeats).toHaveLength(1);
    expect(h.heartbeats[0]!.runnable_count).toBe(1);
    expect(h.heartbeats[0]!.ts).toBe(d("2026-06-01T09:30:00Z").getTime());
    expect(h.heartbeats[0]!.next_wake_ts).toBe(d("2026-06-01T09:30:00Z").getTime() + 60_000);
  });
});

describe("double-fire guard", () => {
  test("does not re-dispatch the same job twice within one minute", async () => {
    // Two ticks 20s apart, both inside the 09:00 minute, every-minute schedule.
    const h = harness({
      nows: [d("2026-06-01T09:00:05Z"), d("2026-06-01T09:00:25Z")],
      playbooks: [pb({ name: "ev", cronSchedule: "* * * * *" })],
    });
    await runForever(h.deps);
    expect(h.dispatched).toEqual(["ev"]);
  });

  test("fires again in the next minute", async () => {
    const h = harness({
      nows: [d("2026-06-01T09:00:05Z"), d("2026-06-01T09:01:05Z")],
      playbooks: [pb({ name: "ev", cronSchedule: "* * * * *" })],
    });
    await runForever(h.deps);
    expect(h.dispatched).toEqual(["ev", "ev"]);
  });

  test("durable guard: a restart inside the same fire-minute does not re-dispatch (H1)", async () => {
    const minute = Math.floor(d("2026-06-01T09:00:00Z").getTime() / 60_000);
    const h = harness({
      nows: [d("2026-06-01T09:00:30Z")],
      playbooks: [pb({ name: "ev", cronSchedule: "* * * * *" })],
      startHeartbeat: {
        ts: d("2026-06-01T09:00:02Z").getTime(),
        host: "ml-1",
        runnable_count: 1,
        next_wake_ts: 0,
        last_dispatch: [{ name: "ev", ts: d("2026-06-01T09:00:02Z").getTime() }],
        dispatched_minute: { ev: minute },
        last_fired: {},
        queue: [],
        running: {},
        last_completed: {},
        attempts: {},
        last_run: {},
        last_success: {},
      },
    });
    await runForever(h.deps);
    expect(h.dispatched).toEqual([]);
  });

  test("persists the guard to the heartbeat BEFORE dispatching (no crash-window double-fire)", async () => {
    const minute = Math.floor(d("2026-06-01T09:00:00Z").getTime() / 60_000);
    const h = harness({ nows: [d("2026-06-01T09:00:05Z")], playbooks: [pb({ name: "ev", cronSchedule: "* * * * *" })] });
    await runForever(h.deps);
    // If the heartbeat were written after dispatch, this would be undefined.
    expect(h.guardAtDispatch().ev).toBe(minute);
  });

  test("the heartbeat carries the dispatched-minute guard forward", async () => {
    const minute = Math.floor(d("2026-06-01T09:00:00Z").getTime() / 60_000);
    const h = harness({ nows: [d("2026-06-01T09:00:05Z")], playbooks: [pb({ name: "ev", cronSchedule: "* * * * *" })] });
    await runForever(h.deps);
    expect(h.heartbeats[0]!.dispatched_minute.ev).toBe(minute);
    expect(h.heartbeats[0]!.last_dispatch.map((x) => x.name)).toEqual(["ev"]);
  });
});

describe("registry resilience", () => {
  test("a load failure keeps the last-good registry and logs, without crashing the loop", async () => {
    let call = 0;
    const h = harness({
      nows: [d("2026-06-01T09:00:05Z"), d("2026-06-01T09:01:05Z")],
      playbooks: () => {
        call++;
        if (call === 2) throw new Error("invalid registry: boom");
        return { jobs: [pb({ name: "ev", cronSchedule: "* * * * *" })], warnings: [] };
      },
    });
    await runForever(h.deps);
    // Tick 1 loads ev and dispatches; tick 2's load throws → reuse ev → dispatch again (new minute).
    expect(h.dispatched).toEqual(["ev", "ev"]);
    expect(h.logs.some((l) => l.includes("boom"))).toBe(true);
  });
});

describe("missed-slot catch-up (#143)", () => {
  const hbWith = (lastFired: Record<string, number>): Heartbeat => ({
    ts: 0,
    host: "ml-1",
    runnable_count: 0,
    next_wake_ts: 0,
    last_dispatch: [],
    dispatched_minute: {},
    last_fired: lastFired,
    queue: [],
    running: {},
    last_completed: {},
    attempts: {},
    last_run: {},
    last_success: {},
  });

  test("fires once for the newest missed slot after a downtime gap and advances last_fired", async () => {
    // Restored last_fired = 09:00; back at 09:17:30; */5 → 09:05/09:10/09:15 missed; fire 09:15 once.
    const h = harness({
      nows: [d("2026-06-01T09:17:30Z")],
      playbooks: [pb({ name: "ev", cronSchedule: "*/5 * * * *" })],
      startHeartbeat: hbWith({ ev: d("2026-06-01T09:00:00Z").getTime() }),
    });
    await runForever(h.deps);
    expect(h.dispatched).toEqual(["ev"]);
    expect(h.heartbeats[0]!.last_fired.ev).toBe(d("2026-06-01T09:15:00Z").getTime());
  });

  test("a job due now AND owing a missed slot fires once (not twice)", async () => {
    // every minute, last_fired 09:00, now exactly on the 09:05 fire.
    const minuteStart = Math.floor(d("2026-06-01T09:05:00Z").getTime() / 60_000) * 60_000;
    const h = harness({
      nows: [d("2026-06-01T09:05:00Z")],
      playbooks: [pb({ name: "ev", cronSchedule: "* * * * *" })],
      startHeartbeat: hbWith({ ev: d("2026-06-01T09:00:00Z").getTime() }),
    });
    await runForever(h.deps);
    expect(h.dispatched).toEqual(["ev"]);
    expect(h.heartbeats[0]!.last_fired.ev).toBe(minuteStart);
  });

  test("a first-seen job (no baseline) gets no catch-up; last_fired initializes to now", async () => {
    const now = d("2026-06-01T09:30:00Z");
    const h = harness({
      nows: [now],
      playbooks: [pb({ name: "ev", cronSchedule: "*/5 * * * *" })], // 09:30 is a fire, but no prior baseline
      startHeartbeat: null,
    });
    await runForever(h.deps);
    // It IS due at 09:30 (live path), so it fires once for the current minute — but NOT a catch-up replay.
    expect(h.dispatched).toEqual(["ev"]);
    expect(h.heartbeats[0]!.last_fired.ev).toBe(now.getTime());
  });

  test("no catch-up replay for a brand-new, not-currently-due job", async () => {
    const now = d("2026-06-01T09:32:00Z"); // not a */5 fire
    const h = harness({
      nows: [now],
      playbooks: [pb({ name: "ev", cronSchedule: "*/5 * * * *" })],
      startHeartbeat: null,
    });
    await runForever(h.deps);
    expect(h.dispatched).toEqual([]);
    expect(h.heartbeats[0]!.last_fired.ev).toBe(now.getTime());
  });

  test("a slot too stale for the derived look-back window is not replayed", async () => {
    // daily 09:00 derives a 6h look-back; back at 16:00 (7h after 09:00) → too stale → no replay.
    const h = harness({
      nows: [d("2026-06-01T16:00:00Z")],
      playbooks: [pb({ name: "daily", cronSchedule: "0 9 * * *" })],
      startHeartbeat: hbWith({ daily: d("2026-05-31T09:00:00Z").getTime() }),
    });
    await runForever(h.deps);
    expect(h.dispatched).toEqual([]);
  });

  test("derived look-back (#157): a daily slot 3h stale catches up where the old global 1h would have skipped it", async () => {
    // daily 09:00, down since yesterday, back at 12:00 (3h after the 09:00 slot).
    // The derived daily look-back is 6h, so 09:00 today is within window → replay once.
    const h = harness({
      nows: [d("2026-06-01T12:00:00Z")],
      playbooks: [pb({ name: "daily", cronSchedule: "0 9 * * *" })],
      startHeartbeat: hbWith({ daily: d("2026-05-31T09:00:00Z").getTime() }),
    });
    await runForever(h.deps);
    expect(h.dispatched).toEqual(["daily"]);
    expect(h.heartbeats[0]!.last_fired.daily).toBe(d("2026-06-01T09:00:00Z").getTime());

    // Same scenario, but the host pins a fixed 1h window (env override) → too stale → skipped.
    const fixed = harness({
      nows: [d("2026-06-01T12:00:00Z")],
      playbooks: [pb({ name: "daily", cronSchedule: "0 9 * * *" })],
      startHeartbeat: hbWith({ daily: d("2026-05-31T09:00:00Z").getTime() }),
      lookback: 3_600_000,
    });
    await runForever(fixed.deps);
    expect(fixed.dispatched).toEqual([]);
  });

  test("advances last_fired to the missed slot and persists it BEFORE dispatch (at-most-once)", async () => {
    const h = harness({
      nows: [d("2026-06-01T09:17:30Z")],
      playbooks: [pb({ name: "ev", cronSchedule: "*/5 * * * *" })],
      startHeartbeat: hbWith({ ev: d("2026-06-01T09:00:00Z").getTime() }),
    });
    await runForever(h.deps);
    expect(h.dispatched).toEqual(["ev"]);
    // Real ordering assertion: at the moment dispatch was called, the advanced
    // last_fired was ALREADY in the persisted heartbeat. Fails if writeHeartbeat
    // moves after dispatch (even if last_fired ends up correct).
    expect(h.lastFiredAtDispatch().ev).toBe(d("2026-06-01T09:15:00Z").getTime());
  });

  test("prunes last_fired for jobs no longer runnable", async () => {
    const h = harness({
      nows: [d("2026-06-01T09:30:00Z")],
      playbooks: [pb({ name: "stillhere", cronSchedule: "0 9 * * *" })],
      startHeartbeat: hbWith({ stillhere: d("2026-06-01T09:00:00Z").getTime(), gone: 123 }),
    });
    await runForever(h.deps);
    expect(Object.keys(h.heartbeats[0]!.last_fired)).toEqual(["stillhere"]);
  });
});

describe("scope gating wired from loaders (B4)", () => {
  test("dispatches enabled each-scope jobs and single-scope jobs owned by this host", async () => {
    // Both `each-on` and `single-mine` are runnable on this host; `single-theirs`
    // is owned by mac and must NOT dispatch. Under N=1 serialization the two
    // runnable jobs drain one-per-tick (the default "nothing running" models the
    // prior job completing by the next tick), so two ticks drain both — proving
    // scope selection is correct AND the chain advances.
    const h = harness({
      nows: [d("2026-06-01T09:00:00Z"), d("2026-06-01T09:01:00Z")],
      host: "ml-1",
      playbooks: [
        pb({ name: "each-on", cronSchedule: "0 9 * * *", scope: "each" }),
        pb({ name: "single-mine", cronSchedule: "0 9 * * *", scope: "single" }),
        pb({ name: "single-theirs", cronSchedule: "0 9 * * *", scope: "single" }),
      ],
      enabledByTick: [new Set(["each-on"]), new Set(["each-on"])],
      owners: { "single-mine": "ml-1", "single-theirs": "mac" },
    });
    await runForever(h.deps);
    expect(h.dispatched.sort()).toEqual(["each-on", "single-mine"]);
    expect(h.dispatched).not.toContain("single-theirs");
  });

  test("last-good topology: a torn topology read keeps the prior tick's owners so an owned single-scope job still fires", async () => {
    // Tick 1: topology names ml-1 as owner → single-scope fires. Tick 2 (next
    // minute): topology read is torn (null) → owners reused from tick 1 → it still
    // fires. Without last-good, owners would empty and the job be dropped.
    const topology: Topology = { hosts: ["ml-1"], owners: { mine: "ml-1" } };
    const h = harness({
      nows: [d("2026-06-01T09:00:05Z"), d("2026-06-01T09:01:05Z")],
      host: "ml-1",
      playbooks: [pb({ name: "mine", cronSchedule: "* * * * *", scope: "single" })],
      enabledByTick: [new Set<string>(), new Set<string>()],
      topologies: [topology, null],
    });
    await runForever(h.deps);
    expect(h.dispatched).toEqual(["mine", "mine"]);
  });

  test("a fresh good topology read overwrites last-good owners (reassignment is not stuck)", async () => {
    // Tick 1: ml-1 owns `mine` → fires here. Tick 2: a fresh good read reassigns
    // ownership to mac → ml-1 must DROP it. If last-good owners were only ever
    // set (never overwritten), ml-1 would keep firing — a stuck-owners bug.
    const tick1: Topology = { hosts: ["ml-1", "mac"], owners: { mine: "ml-1" } };
    const tick2: Topology = { hosts: ["ml-1", "mac"], owners: { mine: "mac" } };
    const h = harness({
      nows: [d("2026-06-01T09:00:05Z"), d("2026-06-01T09:01:05Z")],
      host: "ml-1",
      playbooks: [pb({ name: "mine", cronSchedule: "* * * * *", scope: "single" })],
      enabledByTick: [new Set<string>(), new Set<string>()],
      topologies: [tick1, tick2],
    });
    await runForever(h.deps);
    expect(h.dispatched).toEqual(["mine"]);
  });

  test("torn enabled read (empty set) disables each-scope dispatch that tick, safe and without crashing", async () => {
    // Tick 1 enabled has the job → fires. Tick 2 (next minute) torn read
    // (null → empty set) → not enabled → does NOT fire. No last-good for enabled.
    const h = harness({
      nows: [d("2026-06-01T09:00:05Z"), d("2026-06-01T09:01:05Z")],
      playbooks: [pb({ name: "ev", cronSchedule: "* * * * *", scope: "each" })],
      enabledByTick: [new Set(["ev"]), null],
      owners: {},
    });
    await runForever(h.deps);
    expect(h.dispatched).toEqual(["ev"]);
  });
});

describe("dispatch error isolation", () => {
  test("a throwing dispatch does not wedge the chain: the failure is logged and the next job fires on the following tick", async () => {
    // N=1: tick 1 selects "boom" (higher priority) and it throws → dropped, not
    // left running. tick 2 (same minute, so nothing re-enqueues) finds nothing
    // running and drains the still-queued "ok". A throw must not stall the chain.
    const h = harness({
      nows: [d("2026-06-01T09:00:00Z"), d("2026-06-01T09:00:30Z")],
      playbooks: [
        pb({ name: "boom", cronSchedule: "0 9 * * *" }),
        pb({ name: "ok", cronSchedule: "0 9 * * *" }),
      ],
      priority: (j) => (j.name === "boom" ? 1 : 2), // boom drains first
    });
    // Replace dispatch with one that throws for "boom" only.
    const origDispatch = h.deps.dispatch;
    h.deps.dispatch = (name) => {
      if (name === "boom") throw new Error("ENOENT: no such file");
      origDispatch(name);
    };
    await expect(runForever(h.deps)).resolves.toBeUndefined();
    expect(h.dispatched).toContain("ok");
    expect(h.logs.some((l) => l.includes("boom") && l.includes("ENOENT"))).toBe(true);
  });
});

describe("priority enqueue + last_fired-at-enqueue (Task 3)", () => {
  test("two jobs due in the same tick drain in PRIORITY order across the serialized chain", async () => {
    const now = d("2026-06-01T09:00:00Z");
    const minuteStart = Math.floor(now.getTime() / 60_000) * 60_000;
    // Both are due at 09:00 and enqueued that tick; the priority resolver makes
    // `high` higher-precedence (lower number). Under N=1 only `high` drains on
    // tick 1; `low` waits and drains on tick 2 (the default "nothing running"
    // models `high` completing by the next tick). If dispatch still went in
    // due/registry order the first out would be `low` — the queue must reorder.
    const h = harness({
      nows: [now, d("2026-06-01T09:01:00Z")],
      playbooks: [
        pb({ name: "low", cronSchedule: "0 9 * * *" }),
        pb({ name: "high", cronSchedule: "0 9 * * *" }),
      ],
      priority: (j) => (j.name === "high" ? 1 : 10),
    });
    await runForever(h.deps);
    // Serialized: high (tick 1) then low (tick 2), priority order preserved.
    expect(h.dispatched).toEqual(["high", "low"]);
    // last_fired is stamped for BOTH at ENQUEUE (tick 1) — proven by both being
    // in the tick-1 heartbeat persisted BEFORE any dispatch ran.
    expect(h.heartbeats[0]!.last_fired.high).toBe(minuteStart);
    expect(h.heartbeats[0]!.last_fired.low).toBe(minuteStart);
    expect(h.lastFiredAtDispatch().high).toBe(minuteStart);
    expect(h.lastFiredAtDispatch().low).toBe(minuteStart);
  });

  test("N=1 holds the queue while a job is already running", async () => {
    // A run is in flight (readCompletions reports one running). Even with a
    // higher-priority job queued and due, nothing drains this tick — the chain
    // blocks until the running job completes.
    const h = harness({
      nows: [d("2026-06-01T09:00:00Z")],
      playbooks: [pb({ name: "waiting", cronSchedule: "0 9 * * *" })],
      readCompletions: () => ({ running: { inflight: 100 }, done: {} }),
    });
    await runForever(h.deps);
    expect(h.dispatched).toEqual([]);
    // `waiting` was enqueued (last_fired stamped) but held, not dispatched.
    expect(h.heartbeats[0]!.last_fired.waiting).toBeDefined();
  });
});

describe("cooldown gate at enqueue (Task 3.5)", () => {
  const now = d("2026-06-01T09:00:00Z");
  const done = (agoMs: number) => ({
    running: {},
    done: { job1: { ts: now.getTime() - agoMs, exitCode: 0, durationMs: 0 } },
  });

  test("a job whose last completion is within its cooldown is NOT enqueued", async () => {
    const h = harness({
      nows: [now],
      playbooks: [pb({ name: "job1", cronSchedule: "0 9 * * *" })],
      cooldownSeconds: () => 1800, // 30 min
      readCompletions: () => done(5 * 60_000), // completed 5 min ago → within cooldown
    });
    await runForever(h.deps);
    expect(h.dispatched).toEqual([]); // gated at enqueue → never dispatched
    expect(h.logs.some((l) => l.includes("cooldown skip job1"))).toBe(true);
  });

  test("a job whose last completion is older than its cooldown IS enqueued and dispatched", async () => {
    const h = harness({
      nows: [now],
      playbooks: [pb({ name: "job1", cronSchedule: "0 9 * * *" })],
      cooldownSeconds: () => 1800,
      readCompletions: () => done(60 * 60_000), // completed 60 min ago → past cooldown
    });
    await runForever(h.deps);
    expect(h.dispatched).toEqual(["job1"]);
  });
});

describe("restart durability (queue + retry state) — Task A", () => {
  test("queued backlog and retry/timestamps persist and restore", async () => {
    // Run 1: two due jobs, one already running elsewhere → both queued, none drained.
    const h1 = harness({
      nows: [d("2026-07-07T09:00:00Z")],
      playbooks: [pb({ name: "a", cronSchedule: "0 9 * * *" }), pb({ name: "b", cronSchedule: "0 9 * * *" })],
      priority: (j) => (j.name === "a" ? 1 : 2),
      readCompletions: () => ({ running: { x: 1 }, done: {} }),
    });
    await runForever(h1.deps);
    expect(h1.dispatched).toEqual([]); // cap reached by the foreign running job
    const hb = h1.heartbeats.at(-1)!;
    expect((hb.queue ?? []).map((e) => e.name)).toEqual(["a", "b"]);
    expect(hb.attempts).toEqual({});
    expect(hb.last_run).toBeDefined();

    // Run 2: restart from hb, nothing running now → drains "a" first (priority 1).
    const h2 = harness({
      nows: [d("2026-07-07T09:01:00Z")],
      playbooks: [pb({ name: "a", cronSchedule: "0 9 * * *" }), pb({ name: "b", cronSchedule: "0 9 * * *" })],
      priority: (j) => (j.name === "a" ? 1 : 2),
      startHeartbeat: hb,
      readCompletions: () => ({ running: {}, done: {} }),
    });
    await runForever(h2.deps);
    expect(h2.dispatched).toEqual(["a"]);
    // "a" dispatched → its last_run stamped at run-2's now.
    expect(h2.heartbeats.at(-1)!.last_run!.a).toBe(d("2026-07-07T09:01:00Z").getTime());
  });

  test("a job dispatched this tick is NOT left in the persisted queue (at-most-once across restart)", async () => {
    // The persisted queue is the restart source; if a just-dispatched job stayed
    // in it, a crash after spawn would re-dispatch it — a double-fire on a
    // write-tier job. The heartbeat must reflect the post-drain queue.
    const h = harness({
      nows: [d("2026-07-07T09:00:00Z")],
      playbooks: [pb({ name: "a", cronSchedule: "0 9 * * *" })],
      readCompletions: () => ({ running: {}, done: {} }),
    });
    await runForever(h.deps);
    expect(h.dispatched).toEqual(["a"]);
    expect(h.heartbeats.at(-1)!.queue ?? []).toEqual([]); // drained → not persisted
  });
});

describe("dependency gate + cascade in the drain — Task B", () => {
  test("dependency-blocked job is held; independent drains past it despite lower priority", async () => {
    const h = harness({
      nows: [d("2026-07-07T09:00:00Z")],
      playbooks: [
        pb({ name: "gate", cronSchedule: "0 9 * * *" }),
        pb({ name: "dep", cronSchedule: "0 9 * * *" }),
        pb({ name: "free", cronSchedule: "0 9 * * *" }),
      ],
      priority: (j) => (j.name === "dep" ? 1 : j.name === "free" ? 2 : 3),
      dependencies: (j) => (j.name === "dep" ? ["gate"] : []),
      readCompletions: () => ({ running: {}, done: {} }),
    });
    await runForever(h.deps);
    // gate never succeeded → dep (priority 1) blocked; the highest-priority
    // ELIGIBLE entry is free (priority 2). N=1 → exactly one drains this tick.
    expect(h.dispatched).toEqual(["free"]);
  });

  test("cascade-cancels a queued dependent when its upstream has finally failed", async () => {
    const start = d("2026-07-07T09:00:00Z");
    // dep is a restored backlog entry; gate is off-tick (10:00) so nothing new is
    // due — isolates the cascade. gate has exhausted its retries and last exited
    // non-zero → failed.
    const hb = h0Heartbeat({
      queue: [{ name: "dep", priority: 1, slotTs: start.getTime() }],
      attempts: { gate: 3 },
      done: { gate: 1 },
    });
    const h = harness({
      nows: [start],
      playbooks: [pb({ name: "gate", cronSchedule: "0 10 * * *" }), pb({ name: "dep", cronSchedule: "0 10 * * *" })],
      dependencies: (j) => (j.name === "dep" ? ["gate"] : []),
      startHeartbeat: hb,
      readCompletions: () => ({ running: {}, done: { gate: { ts: 1, exitCode: 1, durationMs: 0 } } }),
    });
    await runForever(h.deps);
    expect(h.dispatched).toEqual([]); // dep cascade-cancelled, gate not due
    expect(h.logs.some((l) => l.includes("cascade-cancel dep"))).toBe(true);
    // dep dropped from the persisted queue too.
    expect((h.heartbeats.at(-1)!.queue ?? []).some((e) => e.name === "dep")).toBe(false);
  });
});

describe("three-strikes retry — Task C", () => {
  const doneRec = (exit: number, ts: number) => ({ ts, exitCode: exit, durationMs: 0 });

  test("a fresh failure re-enqueues at back of line up to MAX-1, then marks failed", async () => {
    const base = d("2026-07-07T09:00:00Z").getTime();
    // Three consecutive failing completions across three same-minute ticks.
    const doneByTick = [
      { j: doneRec(1, base + 1) },
      { j: doneRec(1, base + 2) },
      { j: doneRec(1, base + 3) },
    ];
    let call = 0;
    const h = harness({
      nows: [d("2026-07-07T09:00:00Z"), d("2026-07-07T09:00:10Z"), d("2026-07-07T09:00:20Z")],
      playbooks: [pb({ name: "j", cronSchedule: "0 9 * * *" })],
      readCompletions: () => ({ running: {}, done: doneByTick[Math.min(call++, 2)]! }),
    });
    await runForever(h.deps);
    const hb = h.heartbeats.at(-1)!;
    expect(hb.attempts.j).toBe(3); // hit the cap
    expect((hb.queue ?? []).some((e) => e.name === "j")).toBe(false); // not requeued after the 3rd
    expect(h.logs.some((l) => l.includes("failed j"))).toBe(true);
  });

  test("a success resets the attempt counter and stamps last_success", async () => {
    const base = d("2026-07-07T09:00:00Z").getTime();
    const h = harness({
      nows: [d("2026-07-07T09:00:00Z")],
      playbooks: [pb({ name: "j", cronSchedule: "0 10 * * *" })], // off-tick: only completion matters
      startHeartbeat: h0Heartbeat({ attempts: { j: 2 } }),
      readCompletions: () => ({ running: {}, done: { j: doneRec(0, base + 5) } }),
    });
    await runForever(h.deps);
    const hb = h.heartbeats.at(-1)!;
    expect(hb.attempts.j).toBe(0);
    expect(hb.last_success.j).toBe(base + 5);
  });

  test("a fatal exit code fails fast (jumps straight to the cap, no retries consumed)", async () => {
    const base = d("2026-07-07T09:00:00Z").getTime();
    const h = harness({
      nows: [d("2026-07-07T09:00:00Z")],
      playbooks: [pb({ name: "j", cronSchedule: "0 10 * * *" })],
      readCompletions: () => ({ running: {}, done: { j: doneRec(FATAL_EXIT_CODE, base + 1) } }),
    });
    await runForever(h.deps);
    expect(h.heartbeats.at(-1)!.attempts.j).toBe(3);
  });

  test("a completion already reflected in the restored state is not re-counted", async () => {
    // Restart: attempts.j=1 and last_completed.j is the failure that produced it.
    // readCompletions still shows that same (stale) done → must NOT bump to 2.
    const h = harness({
      nows: [d("2026-07-07T09:00:00Z")],
      playbooks: [pb({ name: "j", cronSchedule: "0 10 * * *" })],
      startHeartbeat: h0Heartbeat({ attempts: { j: 1 }, done: { j: 1 } }), // last_completed.j.ts = 1
      readCompletions: () => ({ running: {}, done: { j: doneRec(1, 1) } }), // same ts=1
    });
    await runForever(h.deps);
    expect(h.heartbeats.at(-1)!.attempts.j).toBe(1); // unchanged
  });
});

describe("dependency cycle/unknown-edge rejection at load — Task D", () => {
  test("a job in a cycle is excluded from dispatch and logged", async () => {
    const h = harness({
      nows: [d("2026-07-07T09:00:00Z")],
      playbooks: [pb({ name: "a", cronSchedule: "0 9 * * *" }), pb({ name: "b", cronSchedule: "0 9 * * *" })],
      dependencies: (j) => (j.name === "a" ? ["b"] : j.name === "b" ? ["a"] : []), // a↔b cycle
      readCompletions: () => ({ running: {}, done: {} }),
    });
    await runForever(h.deps);
    expect(h.dispatched).toEqual([]); // both invalid → neither runs
    expect(h.logs.some((l) => l.includes("dependency:") && l.toLowerCase().includes("cycle"))).toBe(true);
  });

  test("a job depending on an unknown job is excluded; the valid independent still runs", async () => {
    const h = harness({
      nows: [d("2026-07-07T09:00:00Z")],
      playbooks: [pb({ name: "d", cronSchedule: "0 9 * * *" }), pb({ name: "free", cronSchedule: "0 9 * * *" })],
      dependencies: (j) => (j.name === "d" ? ["ghost"] : []),
      priority: (j) => (j.name === "d" ? 1 : 2),
      readCompletions: () => ({ running: {}, done: {} }),
    });
    await runForever(h.deps);
    expect(h.dispatched).toEqual(["free"]); // d excluded despite higher priority
    expect(h.logs.some((l) => l.includes("unknown job ghost"))).toBe(true);
  });
});
