import { describe, expect, test } from "bun:test";
import { RequestWorkQueue } from "./request-work-queue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

describe("shared physical request queue", () => {
  test("defaults to forty active requests and fills each released slot in FIFO order", async () => {
    const queue = new RequestWorkQueue(), started: number[] = [], pending = Array.from({ length: 65 }, () => deferred<number>());
    let active = 0, peak = 0;
    const results = pending.map((item, index) => queue.run(async () => {
      started.push(index); peak = Math.max(peak, ++active);
      try { return await item.promise; } finally { active--; }
    }, 1000));
    expect(started).toEqual(Array.from({ length: 40 }, (_, index) => index));
    pending[17].resolve(17);
    await flush();
    expect(started.at(-1)).toBe(40);
    expect(started).toHaveLength(41);
    for (let index = 0; index < pending.length; index++) pending[index].resolve(index);
    expect(await Promise.all(results)).toEqual(Array.from({ length: 65 }, (_, index) => index));
    expect(started).toEqual(Array.from({ length: 65 }, (_, index) => index));
    expect(peak).toBe(40);
    expect(active).toBe(0);
  });

  test("releases capacity after asynchronous rejection and synchronous exceptions", async () => {
    const queue = new RequestWorkQueue({ maxActive: 1 }), held = deferred<number>(), original = new Error("fixture failure"), started: number[] = [];
    const first = queue.run(() => { started.push(1); return held.promise; }, 1000);
    const rejected = first.catch(error => error);
    const second = queue.run(() => { started.push(2); throw original; }, 1000);
    const thrown = second.catch(error => error);
    const third = queue.run(() => { started.push(3); return 3; }, 1000);
    held.reject(original);
    expect(await rejected).toBe(original);
    expect(await thrown).toBe(original);
    expect(await third).toBe(3);
    expect(started).toEqual([1, 2, 3]);
    expect(await queue.run(() => 4, 1000)).toBe(4);
  });

  test("waiting consumes the original deadline and passes only the remaining time", async () => {
    const queue = new RequestWorkQueue({ maxActive: 1 }), held = deferred<number>();
    const first = queue.run(() => held.promise, 1000);
    let remaining = 0;
    const second = queue.run(timeout => { remaining = timeout; return 2; }, 500);
    await new Promise(resolve => setTimeout(resolve, 50));
    held.resolve(1);
    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(455);
  });

  test("expired queued work never starts, frees its waiting position, and keeps later work", async () => {
    const timeout = new Error("fixture timeout"), queue = new RequestWorkQueue({ maxActive: 1, maxQueued: 1, timeoutError: () => timeout });
    const held = deferred<number>();
    const first = queue.run(() => held.promise, 1000);
    let expiredStarts = 0, nextStarts = 0;
    await expect(queue.run(() => { expiredStarts++; return 2; }, 20)).rejects.toBe(timeout);
    const next = queue.run(() => { nextStarts++; return 3; }, 1000);
    held.resolve(1);
    expect(await first).toBe(1);
    expect(await next).toBe(3);
    expect(expiredStarts).toBe(0);
    expect(nextStarts).toBe(1);
  });

  test("waiting capacity is finite and rejected work never enters the FIFO", async () => {
    const overflow = new Error("fixture overflow"), queue = new RequestWorkQueue({ maxActive: 1, maxQueued: 2, overflowError: () => overflow });
    const held = deferred<number>(), started: number[] = [];
    const first = queue.run(() => held.promise, 1000);
    const second = queue.run(() => { started.push(2); return 2; }, 1000);
    const third = queue.run(() => { started.push(3); return 3; }, 1000);
    await expect(queue.run(() => { started.push(4); return 4; }, 1000)).rejects.toBe(overflow);
    held.resolve(1);
    expect(await Promise.all([first, second, third])).toEqual([1, 2, 3]);
    expect(started).toEqual([2, 3]);
  });

  test("default waiting capacity stops at 512 unique requests", async () => {
    const queue = new RequestWorkQueue(), held = deferred<number>();
    const active = Array.from({ length: 40 }, () => queue.run(() => held.promise, 1000));
    const waiting = Array.from({ length: 512 }, () => queue.run(() => 1, 1000));
    let started = false;
    await expect(queue.run(() => { started = true; return 2; }, 1000)).rejects.toThrow("capacity exceeded");
    held.resolve(1);
    expect(await Promise.all([...active, ...waiting])).toHaveLength(552);
    expect(started).toBe(false);
  });

  test("cancelling waiting work removes it while running work keeps its capacity until completion", async () => {
    const queue = new RequestWorkQueue({ maxActive: 1, maxQueued: 1 }), running = new AbortController(), waiting = new AbortController();
    const held = deferred<number>();
    const first = queue.run(() => held.promise, 1000, running.signal);
    let cancelledStarts = 0;
    const cancelled = queue.run(() => { cancelledStarts++; return 2; }, 1000, waiting.signal);
    waiting.abort();
    await expect(cancelled).rejects.toThrow("timeout");
    running.abort();
    let nextStarts = 0;
    const next = queue.run(() => { nextStarts++; return 3; }, 1000);
    expect(nextStarts).toBe(0);
    held.resolve(1);
    expect(await Promise.all([first, next])).toEqual([1, 3]);
    expect(cancelledStarts).toBe(0);
    expect(nextStarts).toBe(1);
  });

  test("already cancelled work fails before taking a physical slot", async () => {
    const queue = new RequestWorkQueue(), cancelled = new AbortController();
    cancelled.abort();
    let started = false;
    await expect(queue.run(() => { started = true; return 1; }, 1000, cancelled.signal)).rejects.toThrow("timeout");
    expect(started).toBe(false);
    expect(await queue.run(() => 2, 1000)).toBe(2);
  });

  test("invalid bounds and deadlines are rejected before starting work", () => {
    const queue = new RequestWorkQueue();
    for (const value of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new RequestWorkQueue({ maxActive: value })).toThrow(RangeError);
      expect(() => new RequestWorkQueue({ maxQueued: value })).toThrow(RangeError);
      expect(() => queue.run(() => { throw new Error("must not run"); }, value)).toThrow(RangeError);
    }
  });
});
