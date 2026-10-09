import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireFlock } from "../src/cli/flock";

const MAIN = join(import.meta.dir, "../src/cli/main.ts");

describe("acquireFlock", () => {
  test("acquires lock, writes pid, and prevents concurrent acquisition", () => {
    const dir = mkdtempSync(join(tmpdir(), "cronbird-flock-test-"));
    const lockPath = join(dir, "cronbird.lock");

    try {
      const lock1 = acquireFlock(lockPath);
      expect(lock1).not.toBeNull();
      expect(existsSync(lockPath)).toBe(true);

      const content = readFileSync(lockPath, "utf8").trim();
      expect(content).toBe(String(process.pid));

      // Second attempt on the same lockPath returns null (contention)
      const lock2 = acquireFlock(lockPath);
      expect(lock2).toBeNull();

      // Release first lock
      lock1?.release();

      // After release, file remains on disk (no unlink race)
      expect(existsSync(lockPath)).toBe(true);

      // Now a second acquire succeeds
      const lock3 = acquireFlock(lockPath);
      expect(lock3).not.toBeNull();
      lock3?.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("creates parent directories recursively if absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "cronbird-flock-nested-"));
    const lockPath = join(dir, "nested", "dir", "cronbird.lock");

    try {
      const lock = acquireFlock(lockPath);
      expect(lock).not.toBeNull();
      expect(existsSync(lockPath)).toBe(true);
      lock?.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CLI daemon exits 0 when another instance holds the lock", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cronbird-cli-lock-"));
    const reg = join(dir, "r.json");
    writeFileSync(reg, JSON.stringify({ jobs: [] }));
    const lockPath = join(dir, "hb.json.lock");
    const cfg = join(dir, "c.json");
    writeFileSync(
      cfg,
      JSON.stringify({
        hostname: "ml-1",
        registryPath: reg,
        enabledPath: null,
        topologyPath: null,
        heartbeatPath: join(dir, "hb.json"),
        lockPath,
        syncedHeartbeatDir: null,
        dispatchCommand: ["./run.sh"],
        dispatchArgsTemplate: ["{job}"],
        maxSleepMs: 60_000,
        catchupLookbackFloorMs: 3_600_000,
        catchupLookbackCapMs: 21_600_000,
      }),
    );

    try {
      // Hold the lock in this process
      const heldLock = acquireFlock(lockPath);
      expect(heldLock).not.toBeNull();

      // Spawn daemon via CLI pointing to the same config
      const r = Bun.spawnSync(["bun", MAIN, cfg], { stdout: "pipe", stderr: "pipe" });

      heldLock?.release();

      // Second daemon must exit 0 (so launchd/systemd won't respawn storm)
      expect(r.exitCode).toBe(0);
      expect(r.stderr.toString()).toContain("another instance is already running");
      expect(r.stderr.toString()).toContain(lockPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("release() is idempotent and does not throw on multiple invocations", () => {
    const dir = mkdtempSync(join(tmpdir(), "cronbird-flock-idempotent-"));
    const lockPath = join(dir, "cronbird.lock");
    try {
      const lock = acquireFlock(lockPath);
      expect(lock).not.toBeNull();
      expect(() => {
        lock?.release();
        lock?.release();
        lock?.release();
      }).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fails open if directory creation or file open fails", () => {
    const logs: string[] = [];
    const handle = acquireFlock("/dev/null/cannot_create_dir/test.lock", (msg) => logs.push(msg));
    expect(handle).not.toBeNull();
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0]).toContain("flock: failed to open");
  });

  test("CLI daemon runs normally when lockPath is explicitly null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cronbird-cli-null-lock-"));
    const reg = join(dir, "r.json");
    writeFileSync(reg, JSON.stringify({ jobs: [] }));
    const cfg = join(dir, "c.json");
    writeFileSync(
      cfg,
      JSON.stringify({
        hostname: "ml-1",
        registryPath: reg,
        enabledPath: null,
        topologyPath: null,
        heartbeatPath: join(dir, "hb.json"),
        lockPath: null,
        syncedHeartbeatDir: null,
        dispatchCommand: ["./run.sh"],
        dispatchArgsTemplate: ["{job}"],
        maxSleepMs: 60_000,
        catchupLookbackFloorMs: 3_600_000,
        catchupLookbackCapMs: 21_600_000,
      }),
    );

    try {
      const proc = Bun.spawn(["bun", MAIN, cfg], { stdout: "pipe", stderr: "pipe" });
      await Bun.sleep(100);
      proc.kill(15);
      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);
      const stderr = await new Response(proc.stderr).text();
      expect(stderr).toContain("started — host=ml-1");
      expect(stderr).not.toContain("another instance is already running");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
