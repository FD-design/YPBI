import { describe, expect, spyOn, test } from "bun:test";
import { DailyReadingWorkQueue } from "./daily-reading-work-queue";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const pump = () => new Promise<void>(resolve => queueMicrotask(resolve));

describe("日看板共享读取调度", () => {
  test("同批先提交快照时仍由主查询先发，两种优先级各自FIFO", async () => {
    const queue = new DailyReadingWorkQueue({ maxActive: 1 });
    const started: string[] = [];
    const first = deferred<string>();
    const snapshot1 = queue.run(async () => { started.push("snapshot-1"); return "snapshot-1"; }, { priority: "snapshot" });
    const snapshot2 = queue.run(async () => { started.push("snapshot-2"); return "snapshot-2"; }, { priority: "snapshot" });
    const foreground1 = queue.run(() => { started.push("foreground-1"); return first.promise; }, { priority: "foreground" });
    const foreground2 = queue.run(async () => { started.push("foreground-2"); return "foreground-2"; }, { priority: "foreground" });

    expect(started).toEqual([]);
    await pump();
    expect(started).toEqual(["foreground-1"]);
    first.resolve("foreground-1");
    await expect(Promise.all([snapshot1, snapshot2, foreground1, foreground2])).resolves.toEqual([
      "snapshot-1", "snapshot-2", "foreground-1", "foreground-2"
    ]);
    expect(started).toEqual(["foreground-1", "foreground-2", "snapshot-1", "snapshot-2"]);
  });

  test("默认六槽全部供快照使用，没有永久预留空槽", async () => {
    const queue = new DailyReadingWorkQueue();
    const gates = Array.from({ length: 8 }, () => deferred<number>());
    const started: number[] = [];
    const pending = gates.map((gate, index) => queue.run(() => {
      started.push(index);
      return gate.promise;
    }, { priority: "snapshot" }));
    await pump();
    expect(started).toEqual([0, 1, 2, 3, 4, 5]);
    gates[0].resolve(0);
    await pending[0];
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6]);
    gates.slice(1).forEach((gate, index) => gate.resolve(index + 1));
    await expect(Promise.all(pending)).resolves.toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  test("整个生命周期不超过注入的并发上限，完成后立即补位", async () => {
    const queue = new DailyReadingWorkQueue({ maxActive: 2 });
    const gates = Array.from({ length: 7 }, () => deferred<number>());
    let active = 0, peak = 0;
    const started: number[] = [];
    const pending = gates.map((gate, index) => queue.run(async () => {
      active++;
      peak = Math.max(peak, active);
      started.push(index);
      try { return await gate.promise; }
      finally { active--; }
    }, { priority: "snapshot" }));

    await pump();
    expect(started).toEqual([0, 1]);
    for (let index = 0; index < gates.length; index++) {
      gates[index].resolve(index);
      await expect(pending[index]).resolves.toBe(index);
      expect(active).toBeLessThanOrEqual(2);
      expect(started.length).toBe(Math.min(index + 3, gates.length));
    }
    expect(peak).toBe(2);
    expect(active).toBe(0);
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  test("运行中快照不被抢占，下个空槽优先处理新主查询", async () => {
    const queue = new DailyReadingWorkQueue({ maxActive: 1 });
    const gate = deferred<string>();
    const started: string[] = [];
    const active = queue.run(() => { started.push("active"); return gate.promise; }, { priority: "snapshot" });
    await pump();
    const snapshot = queue.run(async () => { started.push("snapshot"); return "snapshot"; }, { priority: "snapshot" });
    const foreground = queue.run(async () => { started.push("foreground"); return "foreground"; }, { priority: "foreground" });
    await pump();
    expect(started).toEqual(["active"]);
    gate.resolve("active");
    await Promise.all([active, snapshot, foreground]);
    expect(started).toEqual(["active", "foreground", "snapshot"]);
  });

  test("入队前已取消时保留原始原因且不执行工作或安装监听", async () => {
    const queue = new DailyReadingWorkQueue();
    const controller = new AbortController();
    const reason = { message: "fixture-cancelled" };
    controller.abort(reason);
    const add = spyOn(controller.signal, "addEventListener");
    let calls = 0;
    const pending = queue.run(async () => { calls++; }, { priority: "foreground", signal: controller.signal });
    expect(await pending.catch(error => error)).toBe(reason);
    await pump();
    expect(calls).toBe(0);
    expect(add).not.toHaveBeenCalled();
    add.mockRestore();
  });

  test("微任务开始前取消不执行工作，默认取消原因保持一致", async () => {
    const queue = new DailyReadingWorkQueue();
    const controller = new AbortController();
    const remove = spyOn(controller.signal, "removeEventListener");
    let calls = 0;
    const failure = queue.run(async () => { calls++; }, { priority: "snapshot", signal: controller.signal }).catch(error => error);
    controller.abort();
    expect(await failure).toBe(controller.signal.reason);
    expect(controller.signal.reason.name).toBe("AbortError");
    await pump();
    expect(calls).toBe(0);
    expect(remove).toHaveBeenCalledTimes(1);
    remove.mockRestore();
  });

  test("等待中取消仅移除自身，后续等待任务仍按FIFO补位", async () => {
    const queue = new DailyReadingWorkQueue({ maxActive: 1 });
    const gate = deferred<string>();
    const active = queue.run(() => gate.promise, { priority: "foreground" });
    await pump();
    const controller = new AbortController();
    const reason = new Error("fixture queued abort");
    const remove = spyOn(controller.signal, "removeEventListener");
    const started: string[] = [];
    const failure = queue.run(async () => { started.push("cancelled"); }, {
      priority: "snapshot", signal: controller.signal
    }).catch(error => error);
    const survivor1 = queue.run(async () => { started.push("survivor-1"); return 1; }, { priority: "snapshot" });
    const survivor2 = queue.run(async () => { started.push("survivor-2"); return 2; }, { priority: "snapshot" });
    controller.abort(reason);
    expect(await failure).toBe(reason);
    expect(started).toEqual([]);
    expect(remove).toHaveBeenCalledTimes(1);
    gate.resolve("active");
    await Promise.all([active, survivor1, survivor2]);
    expect(started).toEqual(["survivor-1", "survivor-2"]);
    remove.mockRestore();
  });

  test("取消队尾立即清理监听，队列空后仍可继续使用", async () => {
    const queue = new DailyReadingWorkQueue({ maxActive: 1 });
    const gate = deferred<void>();
    const active = queue.run(() => gate.promise, { priority: "foreground" });
    await pump();
    const controllers = Array.from({ length: 20 }, () => new AbortController());
    const removed = controllers.map(controller => spyOn(controller.signal, "removeEventListener"));
    let cancelledCalls = 0;
    const cancelled = controllers.map(controller => queue.run(async () => { cancelledCalls++; }, {
      priority: "snapshot", signal: controller.signal
    }).catch(error => error));
    for (let index = controllers.length - 1; index >= 0; index--) controllers[index].abort(`cancelled-${index}`);
    expect(await Promise.all(cancelled)).toEqual(controllers.map(controller => controller.signal.reason));
    removed.forEach(remove => expect(remove).toHaveBeenCalledTimes(1));
    gate.resolve();
    await active;
    await expect(queue.run(async () => "reused", { priority: "snapshot" })).resolves.toBe("reused");
    expect(cancelledCalls).toBe(0);
    removed.forEach(remove => remove.mockRestore());
  });

  test("开始后取消交由工作处理，工作未结束时不释放容量", async () => {
    const queue = new DailyReadingWorkQueue({ maxActive: 1 });
    const controller = new AbortController();
    const remove = spyOn(controller.signal, "removeEventListener");
    const gate = deferred<string>();
    const reason = new Error("fixture started abort");
    let settled = false, nextStarted = false;
    const active = queue.run(() => gate.promise, { priority: "snapshot", signal: controller.signal });
    const failure = active.catch(error => error).finally(() => { settled = true; });
    await pump();
    expect(remove).toHaveBeenCalledTimes(1);
    const next = queue.run(async () => { nextStarted = true; return "next"; }, { priority: "foreground" });
    controller.abort(reason);
    await pump();
    expect(settled).toBe(false);
    expect(nextStarted).toBe(false);
    gate.reject(reason);
    expect(await failure).toBe(reason);
    await expect(next).resolves.toBe("next");
    expect(remove).toHaveBeenCalledTimes(1);
    remove.mockRestore();
  });

  test("开始后的工作自行成功时返回原结果，不把取消转换为其他错误", async () => {
    const queue = new DailyReadingWorkQueue({ maxActive: 1 });
    const controller = new AbortController();
    const gate = deferred<{ value: number }>();
    const pending = queue.run(() => gate.promise, { priority: "foreground", signal: controller.signal });
    await pump();
    controller.abort("work handles this signal");
    const result = { value: 42 };
    gate.resolve(result);
    expect(await pending).toBe(result);
  });

  test("容量覆盖完整工作，响应取得后仍等待解析与校验完成", async () => {
    const queue = new DailyReadingWorkQueue({ maxActive: 1 });
    const response = deferred<void>(), parsed = deferred<string>();
    let parsing = false, nextStarted = false;
    const pending = queue.run(async () => {
      await response.promise;
      parsing = true;
      return await parsed.promise;
    }, { priority: "snapshot" });
    const next = queue.run(async () => { nextStarted = true; return "next"; }, { priority: "snapshot" });
    await pump();
    response.resolve();
    await pump();
    expect(parsing).toBe(true);
    expect(nextStarted).toBe(false);
    parsed.resolve("complete");
    await expect(pending).resolves.toBe("complete");
    await expect(next).resolves.toBe("next");
  });

  for (const failureMode of ["throw", "reject"] as const) test(`${failureMode}保留原错误并释放槽位，失败不污染后续队列`, async () => {
    const queue = new DailyReadingWorkQueue({ maxActive: 1 });
    const controller = new AbortController();
    const remove = spyOn(controller.signal, "removeEventListener");
    const reason = new Error(`fixture ${failureMode}`);
    const failure = queue.run(() => {
      if (failureMode === "throw") throw reason;
      return Promise.reject(reason);
    }, { priority: "foreground", signal: controller.signal }).catch(error => error);
    const following = queue.run(async () => "following", { priority: "snapshot" });
    expect(await failure).toBe(reason);
    await expect(following).resolves.toBe("following");
    expect(remove).toHaveBeenCalledTimes(1);
    await expect(queue.run(async () => "reused", { priority: "foreground" })).resolves.toBe("reused");
    remove.mockRestore();
  });

  test("同一调度器中的不同环境闭包与结果互不借用", async () => {
    const queue = new DailyReadingWorkQueue({ maxActive: 1 });
    const gate = deferred<{ mode: string; request: number }>();
    const production = { mode: "production", request: 1 };
    const testing = { mode: "test", request: 2 };
    const started: Array<typeof production> = [];
    const first = queue.run(() => { started.push(production); return gate.promise; }, { priority: "snapshot" });
    await pump();
    const second = queue.run(async () => { started.push(testing); return testing; }, { priority: "foreground" });
    const third = queue.run(async () => { started.push(production); return production; }, { priority: "snapshot" });
    gate.resolve(production);
    const results = await Promise.all([first, second, third]);
    expect(started).toEqual([production, testing, production]);
    expect(results[0]).toBe(production);
    expect(results[1]).toBe(testing);
    expect(results[2]).toBe(production);
    expect(results[0]).not.toBe(results[1]);
  });

  test("独立实例拥有各自容量，不共享等待任务", async () => {
    const firstQueue = new DailyReadingWorkQueue({ maxActive: 1 });
    const secondQueue = new DailyReadingWorkQueue({ maxActive: 1 });
    const gate = deferred<void>();
    const first = firstQueue.run(() => gate.promise, { priority: "snapshot" });
    const second = secondQueue.run(async () => "independent", { priority: "foreground" });
    await expect(second).resolves.toBe("independent");
    gate.resolve();
    await first;
  });

  test("并发配置只接受正安全整数", () => {
    for (const maxActive of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new DailyReadingWorkQueue({ maxActive })).toThrow(RangeError);
    }
  });
});
