import { closeSync, constants, ftruncateSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

export interface FlockHandle {
  release(): void;
}

interface LibcFlock {
  flock(fd: number, operation: number): number;
  errno(): number;
}

let cachedLibc: LibcFlock | null | undefined = undefined;

function getLibc(): LibcFlock | null {
  if (cachedLibc !== undefined) return cachedLibc;

  const libName =
    process.platform === "darwin"
      ? "libSystem.B.dylib"
      : process.platform === "linux"
      ? "libc.so.6"
      : null;

  if (!libName) {
    cachedLibc = null;
    return null;
  }

  try {
    // Dynamic import of bun:ffi so environments without FFI don't fail at module load
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { dlopen, FFIType } = require("bun:ffi");
    const libc = dlopen(libName, {
      flock: {
        args: [FFIType.i32, FFIType.i32],
        returns: FFIType.i32,
      },
    });

    cachedLibc = {
      flock: (fd: number, op: number) => libc.symbols.flock(fd, op),
      errno: () => {
        try {
          return (process as { errno?: number }).errno ?? 0;
        } catch {
          return 0;
        }
      },
    };
    return cachedLibc;
  } catch {
    cachedLibc = null;
    return null;
  }
}

/**
 * Acquire an exclusive, non-blocking advisory lock on `lockPath`.
 *
 * Returns:
 * - A {@link FlockHandle} on success; calling `release()` closes the file and releases the lock.
 * - `null` if the lock is held by another process (contention: EWOULDBLOCK / EAGAIN).
 * - A no-op {@link FlockHandle} if libc/FFI is unsupported or fails with an unrecoverable fs error,
 *   so unsupported platforms fail open rather than halting the daemon.
 */
export function acquireFlock(lockPath: string, log?: (msg: string) => void): FlockHandle | null {
  const libc = getLibc();
  if (!libc) {
    log?.(`flock: platform ${process.platform} or bun:ffi not supported; running without single-instance lock`);
    return { release: () => {} };
  }

  try {
    mkdirSync(dirname(lockPath), { recursive: true });
    // Open with O_CREAT | O_RDWR (no truncation on open so we never wipe a held lock file)
    const fd = openSync(lockPath, constants.O_CREAT | constants.O_RDWR, 0o644);

    const ret = libc.flock(fd, LOCK_EX | LOCK_NB);
    if (ret === 0) {
      try {
        ftruncateSync(fd, 0);
        writeSync(fd, `${process.pid}\n`);
      } catch {
        // PID write failure is non-fatal; the lock is held regardless
      }

      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          try {
            libc.flock(fd, LOCK_UN);
          } catch {
            // Ignore unlock errors during teardown
          }
          try {
            closeSync(fd);
          } catch {
            // Ignore close errors during teardown
          }
        },
      };
    }

    // flock returned -1
    // In POSIX, EWOULDBLOCK is usually 35 on Darwin and 11 on Linux (EAGAIN)
    // Close the descriptor immediately
    try {
      closeSync(fd);
    } catch {
      // Ignore
    }

    const err = libc.errno();
    // 35 = EWOULDBLOCK on Darwin; 11 = EAGAIN/EWOULDBLOCK on Linux
    const isContention = err === 35 || err === 11 || err === 0;
    if (isContention) {
      return null;
    }

    // Unexpected errno (e.g. ENOLCK on some network shares) -> fail open
    log?.(`flock: unexpected errno ${err} on ${lockPath}; running without lock`);
    return { release: () => {} };
  } catch (err) {
    log?.(`flock: failed to open ${lockPath}: ${err instanceof Error ? err.message : String(err)}; running without lock`);
    return { release: () => {} };
  }
}
