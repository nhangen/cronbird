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

  const errnoSymbol = process.platform === "darwin" ? "__error" : "__errno_location";

  try {
    // Dynamic import of bun:ffi so environments without FFI don't fail at module load
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { dlopen, FFIType, toArrayBuffer } = require("bun:ffi");
    const libc = dlopen(libName, {
      flock: {
        args: [FFIType.i32, FFIType.i32],
        returns: FFIType.i32,
      },
      [errnoSymbol]: {
        args: [],
        returns: FFIType.ptr,
      },
    });

    cachedLibc = {
      flock: (fd: number, op: number) => libc.symbols.flock(fd, op),
      errno: () => {
        try {
          const ptr = libc.symbols[errnoSymbol]();
          if (!ptr) return -1;
          const dv = new DataView(toArrayBuffer(ptr, 0, 4));
          return dv.getInt32(0, true);
        } catch {
          return -1;
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
    // Read errno immediately before closing fd (closeSync may alter errno)
    const err = libc.errno();

    try {
      closeSync(fd);
    } catch {
      // Ignore
    }

    // 35 = EWOULDBLOCK on Darwin; 11 = EAGAIN/EWOULDBLOCK on Linux
    const isContention =
      (process.platform === "darwin" && err === 35) ||
      (process.platform === "linux" && err === 11);
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
