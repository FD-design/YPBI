import { describe, expect, test } from "bun:test";
import { UpstreamError } from "../upstream/client";
import { SourceReadBudget } from "./source-read-budget";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

describe("private source read budget", () => {
  test("returns successful results and original source errors within the budget", async () => {
    const budget = new SourceReadBudget(1000);
    const original = new UpstreamError("UPSTREAM_AUTH_FAILED", "private details", 403);
    try {
      expect(await budget.read(async () => ({ value: 0 }))).toEqual({ value: 0 });
      await expect(budget.read(async () => { throw original; })).rejects.toBe(original);
      expect(budget.expired).toBe(false);
    } finally { budget.dispose(); }
  });

  test("expires a stalled read and does not start subsequent queued reads", async () => {
    const pending = deferred<number>();
    const budget = new SourceReadBudget(10);
    let started = 0;
    try {
      await expect(budget.read(() => { started++; return pending.promise; })).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT", statusCode: 504 });
      expect(budget.expired).toBe(true);
      await expect(budget.read(async () => { started++; return 2; })).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT" });
      expect(started).toBe(1);
      pending.resolve(5);
    } finally { budget.dispose(); }
  });

  test("one expired consumer does not cancel another consumer of the same upstream promise", async () => {
    const upstream = deferred<number>();
    const short = new SourceReadBudget(10), long = new SourceReadBudget(1000);
    try {
      const first = short.read(() => upstream.promise);
      const second = long.read(() => upstream.promise);
      await expect(first).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT" });
      upstream.resolve(42);
      expect(await second).toBe(42);
      expect(long.expired).toBe(false);
    } finally { short.dispose(); long.dispose(); }
  });

  test("late upstream failure is consumed after the caller has timed out", async () => {
    const upstream = deferred<number>();
    const budget = new SourceReadBudget(10);
    try {
      await expect(budget.read(() => upstream.promise)).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT" });
      upstream.reject(new Error("late private source details"));
      await Promise.resolve();
      expect(budget.expired).toBe(true);
    } finally { budget.dispose(); }
  });

  test("dispose stops pending and future consumer reads without claiming source expiry", async () => {
    const budget = new SourceReadBudget(1000);
    const pending = deferred<number>();
    const result = budget.read(() => pending.promise);
    budget.dispose();
    await expect(result).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT" });
    let started = false;
    await expect(budget.read(async () => { started = true; return 1; })).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT" });
    expect(started).toBe(false);
    expect(budget.expired).toBe(false);
    pending.resolve(1);
    budget.dispose();
  });

  test("synchronous delegate errors retain identity and release the listener", async () => {
    const budget = new SourceReadBudget(1000);
    const original = new Error("synchronous source failure");
    try {
      await expect(budget.read(() => { throw original; })).rejects.toBe(original);
      expect(await budget.read(async () => 1)).toBe(1);
    } finally { budget.dispose(); }
  });

  test("invalid private configuration is rejected", () => {
    for (const timeout of [0, -1, 0.5, NaN, Infinity, 60001]) expect(() => new SourceReadBudget(timeout)).toThrow(RangeError);
  });
});
