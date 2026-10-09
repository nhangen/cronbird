export interface FlockHandle {
    release(): void;
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
export declare function acquireFlock(lockPath: string, log?: (msg: string) => void): FlockHandle | null;
