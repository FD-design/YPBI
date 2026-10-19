import { describe, expect, spyOn, test } from "bun:test";
import { getEventListeners } from "node:events";
import { UpstreamError } from "../upstream/client";
import { SourceReadBudget } from "./source-read-budget";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

describe("private source read budget", () => {
  test("单次读取预先取消时不启动工作，也不取消同域预算", async () => {
    const budget = new SourceReadBudget(1000), read = new AbortController();
    read.abort();
    let started = 0;
    try {
      await expect(budget.read(async () => ++started, read.signal)).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT" });
      expect(started).toBe(0);
      expect(getEventListeners(read.signal, "abort")).toHaveLength(0);
      expect(budget.signal.aborted).toBe(false);
      expect(budget.expired).toBe(false);
      expect(await budget.read(async () => 2)).toBe(2);
    } finally { budget.dispose(); }
  });

  test("已无用途的单次读取立即结束，其他日期和共享健康消费者继续", async () => {
    const budget = new SourceReadBudget(1000), read = new AbortController(), shared = deferred<number>();
    try {
      const cancelled = budget.read(() => shared.promise, read.signal);
      const healthy = budget.read(() => shared.promise);
      expect(getEventListeners(read.signal, "abort")).toHaveLength(1);
      read.abort();
      await expect(cancelled).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT" });
      expect(getEventListeners(read.signal, "abort")).toHaveLength(0);
      expect(budget.signal.aborted).toBe(false);
      expect(budget.expired).toBe(false);
      shared.resolve(42);
      expect(await healthy).toBe(42);
      expect(await budget.read(async () => 0)).toBe(0);
    } finally { budget.dispose(); }
  });

  for (const outcome of ["success", "failure", "sync_failure", "expire", "dispose"] as const)
    test(`单次读取${outcome}清理取消监听，保留原错误和预算语义`, async () => {
      const budget = new SourceReadBudget(outcome === "expire" ? 15 : 1000), read = new AbortController();
      const pending = deferred<number>(), original = new Error("isolated source failure");
      try {
        const result = budget.read(() => {
          if (outcome === "sync_failure") throw original;
          return pending.promise;
        }, read.signal);
        if (outcome === "success") pending.resolve(0);
        if (outcome === "failure") pending.reject(original);
        if (outcome === "dispose") budget.dispose();
        if (outcome === "success") expect(await result).toBe(0);
        else if (outcome === "failure" || outcome === "sync_failure") await expect(result).rejects.toBe(original);
        else await expect(result).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT" });
        expect(getEventListeners(read.signal, "abort")).toHaveLength(0);
        expect(budget.expired).toBe(outcome === "expire");
        read.abort();
        if (outcome !== "sync_failure") pending.reject(new Error("late isolated failure"));
        await Promise.resolve();
      } finally { budget.dispose(); }
    });

  test("外部查询已取消时不启动读取、不登记监听且不判来源预算到期", async () => {
    const controller = new AbortController(); controller.abort();
    const budget = new SourceReadBudget(1000, controller.signal);
    let started = false;
    await expect(budget.read(async () => { started = true; return 1; })).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT" });
    expect(started).toBe(false);
    expect(budget.signal.aborted).toBe(true);
    expect(budget.expired).toBe(false);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    budget.dispose();
  });

  test("多个并行读取共用一个外部取消监听，取消清理并隔离全部迟到结果", async () => {
    const controller = new AbortController(), budget = new SourceReadBudget(1000, controller.signal);
    const pending = Array.from({ length: 36 }, () => deferred<number>());
    const reads = pending.map(item => budget.read(() => item.promise).catch(error => error));
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
    expect(getEventListeners(budget.signal, "abort")).toHaveLength(0);
    controller.abort();
    const results = await Promise.all(reads);
    expect(results.every(error => error.code === "UPSTREAM_TIMEOUT")).toBe(true);
    expect(budget.expired).toBe(false);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    pending.forEach((item, index) => index % 2 ? item.reject(new Error("late fixture failure")) : item.resolve(7));
    await Promise.resolve();
    budget.dispose();
  });

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

  for (const mode of ["async_rejection", "sync_throw"] as const)
    test(`计时器尚未运行时${mode}按绝对deadline结算并清理监听`, async () => {
      let now = 100;
      const clock = spyOn(performance, "now").mockImplementation(() => now);
      const budget = new SourceReadBudget(10), read = new AbortController();
      const upstream = deferred<number>();
      const original = new UpstreamError("UPSTREAM_TIMEOUT", "后台接口请求超时", 504);
      try {
        expect(budget.expired).toBe(false);
        const result = budget.read(() => {
          if (mode === "sync_throw") { now = 110; throw original; }
          return upstream.promise;
        }, read.signal);
        if (mode === "async_rejection") { now = 110; upstream.reject(original); }
        const failure = await result.catch(error => error);
        expect(failure).not.toBe(original);
        expect(failure).toMatchObject({ code: "UPSTREAM_TIMEOUT", statusCode: 504, message: "后台来源读取超时" });
        expect(budget.expired).toBe(true);
        expect(budget.signal.aborted).toBe(true);
        expect(getEventListeners(read.signal, "abort")).toHaveLength(0);
        let started = false;
        await expect(budget.read(async () => { started = true; return 1; })).rejects.toMatchObject({ message: "后台来源读取超时" });
        expect(started).toBe(false);
      } finally { budget.dispose(); clock.mockRestore(); }
    });

  for (const code of ["UPSTREAM_AUTH_FAILED", "BI_V1_SCOPE_CONFLICT"] as const)
    test(`${code}预算内保留原错误，超出墙钟deadline后使用既有预算失败`, async () => {
      let now = 100;
      const clock = spyOn(performance, "now").mockImplementation(() => now);
      const budget = new SourceReadBudget(10);
      const original = new UpstreamError(code, "source details stay private", 502);
      try {
        now = 109;
        await expect(budget.read(async () => { throw original; })).rejects.toBe(original);
        expect(budget.expired).toBe(false);
        const failed = budget.read(() => { now = 111; throw original; });
        const actual = await failed.catch(error => error);
        expect(actual).not.toBe(original);
        expect(actual).toMatchObject({ code: "UPSTREAM_TIMEOUT", message: "后台来源读取超时" });
        expect(budget.expired).toBe(true);
      } finally { budget.dispose(); clock.mockRestore(); }
    });

  test("墙钟到期错误结束全部同域等待，但其他共享消费者保留原结果和预算", async () => {
    let now = 100;
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    const short = new SourceReadBudget(10), long = new SourceReadBudget(1000);
    const shared = deferred<number>(), sibling = deferred<number>();
    const firstRead = new AbortController(), siblingRead = new AbortController();
    const original = new UpstreamError("UPSTREAM_NETWORK_ERROR", "private shared error", 502);
    try {
      const first = short.read(() => shared.promise, firstRead.signal).catch(error => error);
      const other = short.read(() => sibling.promise, siblingRead.signal).catch(error => error);
      const healthy = long.read(() => shared.promise).catch(error => error);
      now = 111;
      shared.reject(original);
      const results = await Promise.all([first, other]);
      expect(results.every(error => error.code === "UPSTREAM_TIMEOUT" && error.message === "后台来源读取超时")).toBe(true);
      expect(await healthy).toBe(original);
      expect(short.expired).toBe(true);
      expect(long.expired).toBe(false);
      expect(getEventListeners(firstRead.signal, "abort")).toHaveLength(0);
      expect(getEventListeners(siblingRead.signal, "abort")).toHaveLength(0);
      sibling.reject(new Error("late private sibling error"));
      await Promise.resolve();
      expect(await long.read(async () => 0)).toBe(0);
    } finally { short.dispose(); long.dispose(); clock.mockRestore(); }
  });
});
