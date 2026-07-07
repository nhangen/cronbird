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
