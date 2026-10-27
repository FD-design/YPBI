import { AsyncLocalStorage } from "node:async_hooks";
import { expect, test } from "bun:test";
import { ReadAdmission } from "./read-admission";

function fixture(maxWaiting = 512) {
  return new ReadAdmission({ maxWaiting, cancelled: () => new Error("cancelled"), overflow: () => new Error("overflow") });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test("microtask admission prioritizes modern units and preserves FIFO within each class", async () => {
  const queue = fixture(), calls: string[] = [];
  const work = (name: string) => async () => { calls.push(name); return name; };
  const legacy = queue.run(work("legacy-1"), "legacy");
  const first = queue.run(work("modern-1"), "modern");
  const second = queue.run(work("modern-2"), "modern");
  const last = queue.run(work("legacy-2"), "legacy");
  expect(calls).toEqual([]);
  await Promise.all([legacy, first, second, last]);
  expect(calls).toEqual(["modern-1", "modern-2", "legacy-1", "legacy-2"]);
});

test("queued cancellation removes only that unit and healthy queued work resumes", async () => {
  const queue = fixture(), held = deferred<number>(), cancelled = new AbortController();
  const calls: string[] = [];
  const first = queue.run(() => held.promise, "modern");
  await flush();
  const removed = queue.run(async () => { calls.push("cancelled"); return 2; }, "modern", cancelled.signal);
  const rejected = removed.then(() => null, error => error as Error);
  const healthy = queue.run(async () => { calls.push("healthy"); return 3; }, "legacy");
  cancelled.abort();
  expect((await rejected)?.message).toBe("cancelled");
  held.resolve(1);
  expect(await first).toBe(1);
  expect(await healthy).toBe(3);
  expect(calls).toEqual(["healthy"]);
});

test("active cancellation is owned by the work, so the permit is not released before it settles", async () => {
  const queue = fixture(), held = deferred<number>(), controller = new AbortController();
  let nextStarted = false;
  const first = queue.run(() => held.promise, "modern", controller.signal);
  await flush();
  const second = queue.run(async () => { nextStarted = true; return 2; }, "modern");
  controller.abort();
  await flush();
  expect(nextStarted).toBe(false);
  held.resolve(1);
  expect(await first).toBe(1);
  expect(await second).toBe(2);
});

test("bounded queue rejects overflow and cancelled entries free waiting capacity", async () => {
  const queue = fixture(1), held = deferred<number>(), controller = new AbortController();
  const first = queue.run(() => held.promise, "modern");
  await flush();
  const second = queue.run(async () => 2, "legacy", controller.signal);
  const cancelled = second.then(() => null, error => error as Error);
  await expect(queue.run(async () => 3, "modern")).rejects.toThrow("overflow");
  controller.abort();
  expect((await cancelled)?.message).toBe("cancelled");
  const healthy = queue.run(async () => 4, "modern");
  held.resolve(1);
  expect(await first).toBe(1);
  expect(await healthy).toBe(4);
});

test("synchronous and asynchronous terminal failures preserve their error and release capacity", async () => {
  const queue = fixture(), syncError = new Error("sync"), asyncError = new Error("async");
  const sync = queue.run(() => { throw syncError; }, "modern");
  const syncRejected = expect(sync).rejects.toBe(syncError);
  const async = queue.run(async () => { throw asyncError; }, "modern");
  const asyncRejected = expect(async).rejects.toBe(asyncError);
  const healthy = queue.run(async () => 9, "modern");
  await Promise.all([syncRejected, asyncRejected]);
  expect(await healthy).toBe(9);
});

test("each admitted callback restores its submitting async context", async () => {
  const queue = fixture(), context = new AsyncLocalStorage<string>(), held = deferred<number>();
  const first = context.run("first", () => queue.run(() => held.promise, "modern"));
  await flush();
  const a = context.run("preview-a", () => queue.run(async () => context.getStore(), "modern"));
  const b = context.run("preview-b", () => queue.run(async () => context.getStore(), "modern"));
  const production = queue.run(async () => context.getStore(), "legacy");
  context.run("releasing-context", () => held.resolve(1));
  await first;
  expect(await a).toBe("preview-a");
  expect(await b).toBe("preview-b");
  expect(await production).toBeUndefined();
});

test("already-cancelled work never takes capacity", async () => {
  const queue = fixture(), controller = new AbortController();
  controller.abort();
  let started = false;
  await expect(queue.run(async () => { started = true; }, "modern", controller.signal)).rejects.toThrow("cancelled");
  expect(started).toBe(false);
  expect(await queue.run(async () => 1, "modern")).toBe(1);
});
