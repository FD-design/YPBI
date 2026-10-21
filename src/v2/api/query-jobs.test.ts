import { afterEach, describe, expect, test } from "bun:test";
import type { z } from "zod";
import type { BiQueryJobRequest, biQueryJobRowSchema } from "../../../contracts/query-jobs";
import {
  BiQueryJobTerminalError, BiQueryJobWaitError, createBiQueryJobRunner, runBiQueryJob,
  type BiQueryJobProgress
} from "./query-jobs";
import { setDataEnvironmentPreference } from "./dataEnvironmentPreference";
import { V2_AUTHENTICATION_REQUIRED_EVENT } from "./authEvents";

const handle = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const request = (): BiQueryJobRequest => ({ queries: [{ query: {
  pid: "PH", metricCodes: "M016", startDate: "2020-01-01", endDate: "2020-01-02", granularity: "day", includeIncomplete: true
} }] });
const created = (reused = false) => Response.json({ success: true, data: { handle, reused } });
const progress = (status: BiQueryJobProgress["status"] = "RUNNING", extra = {}) => ({ handle, status, completedUnits: status === "SUCCEEDED" ? 1 : 0, totalUnits: 1, ...extra });
const state = (status: BiQueryJobProgress["status"] = "RUNNING", extra = {}) => Response.json({ success: true, data: progress(status, extra) });
const resultPayload = () => ({ success: true as const, data: { ...progress("SUCCEEDED"), status: "SUCCEEDED" as const, results: [{
  generatedAt: "2026-10-20T09:00:00+08:00", watermark: null,
  rows: [{ metricCode: "M016", dimensions: { pid: "PH" }, businessDate: "2020-01-01",
    value: 0, numerator: 0, denominator: null, unit: "count", dataStatus: "READY", ruleVersion: "fixture-rule" }] as z.infer<typeof biQueryJobRowSchema>[]
}] } });
const completed = () => Response.json(resultPayload());
const failure = (status: number, code = "QUERY_JOB_UPSTREAM_REJECTED") => Response.json({ success: false,
  error: { code, message: "请求未完成", requestId: "fixture-query-job" } }, { status });
function fixture(responder: (path: string, init: RequestInit, index: number) => Response | Promise<Response>) {
  let clock = 0;
  const sleeps: number[] = [], calls: Array<{ path: string; init: RequestInit }> = [];
  const run = createBiQueryJobRunner({
    fetch: async (path, init) => { calls.push({ path, init }); return responder(path, init, calls.length - 1); },
    now: () => clock,
    sleep: async milliseconds => { sleeps.push(milliseconds); clock += milliseconds; }
  });
  return { run, sleeps, calls, now: () => clock, advance: (milliseconds: number) => { clock += milliseconds; } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalWarning = console.warn;
afterEach(() => {
  setDataEnvironmentPreference("production");
  console.warn = originalWarning;
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

describe("BI 查询任务独立协议客户端", () => {
  test("仅显式调用启用；请求和环境固定快照，2秒轮询后再验证结果", async () => {
    expect(typeof runBiQueryJob).toBe("function");
    setDataEnvironmentPreference("test");
    const input = request(), expectedBody = JSON.stringify(input);
    const responses = [created(), state("QUEUED"), state("RUNNING"), state("SUCCEEDED"), completed()];
    const f = fixture((_path, _init, index) => {
      if (index === 0) { setDataEnvironmentPreference("production"); input.queries.push(request().queries[0]!); }
      return responses[index]!;
    });
    expect(f.calls).toHaveLength(0);
    const updates: Readonly<BiQueryJobProgress>[] = [];
    const value = await f.run(input, { onProgress: item => { updates.push(item); expect(Object.isFrozen(item)).toBe(true); } });
    expect(value).toEqual(resultPayload());
    expect(updates.map(item => item.status)).toEqual(["QUEUED", "RUNNING", "SUCCEEDED", "SUCCEEDED"]);
    expect(updates.every(item => !("results" in item))).toBe(true);
    expect(f.sleeps).toEqual([2000, 2000, 2000]);
    expect(f.calls.map(item => item.path)).toEqual([
      "/api/bi/v2/queries/jobs", ...Array(3).fill(`/api/bi/v2/queries/jobs/${handle}`), `/api/bi/v2/queries/jobs/${handle}/result`
    ]);
    expect(f.calls[0]!.init.body).toBe(expectedBody);
    expect(f.calls.map(item => item.init.method)).toEqual(["POST", "GET", "GET", "GET", "GET"]);
    for (const { init } of f.calls) {
      expect(new Headers(init.headers).get("x-ypbi-data-environment")).toBe("test");
      expect(init.cache).toBe("no-store"); expect(init.credentials).toBe("same-origin");
      expect(new Headers(init.headers).has("x-token")).toBe(false);
    }
  });

  test("复用任务也必须读状态与结果，不能把 reused 当作成功结果", async () => {
    const responses = [created(true), state("SUCCEEDED"), completed()];
    const f = fixture((_path, _init, index) => responses[index]!);
    await f.run(request()); expect(f.calls).toHaveLength(3);
  });

  test("创建网络失败仅发送一次，不自动重复创建或轮询", async () => {
    const f = fixture(() => { throw new TypeError("fixture network failure"); });
    await expect(f.run(request())).rejects.toBeInstanceOf(TypeError);
    expect(f.calls).toHaveLength(1); expect(f.sleeps).toHaveLength(0);
  });

  test("两次暂时网络失败只重试同一 handle 状态，不重新创建", async () => {
    const f = fixture((_path, _init, index) => {
      if (index === 0) return created();
      if (index < 3) throw new TypeError("fixture network failure");
      return index === 3 ? state("SUCCEEDED") : completed();
    });
    await f.run(request());
    expect(f.calls.filter(item => item.init.method === "POST")).toHaveLength(1);
    expect(f.calls.slice(1, 4).every(item => item.path === `/api/bi/v2/queries/jobs/${handle}`)).toBe(true);
    expect(f.sleeps).toEqual([2000, 2000, 2000]);
  });

  test("状态/结果共用两次重试预算，持续失败不会无限重试", async () => {
    const f = fixture((_path, _init, index) => {
      if (index === 0) return created();
      if (index === 2) return state("SUCCEEDED");
      throw new TypeError("fixture network failure");
    });
    await expect(f.run(request())).rejects.toBeInstanceOf(TypeError);
    expect(f.calls.map(item => item.init.method)).toEqual(["POST", "GET", "GET", "GET", "GET"]);
    expect(f.calls.slice(-2).every(item => item.path.endsWith("/result"))).toBe(true);
  });

  test("明确的读取超时可以有界重试原 handle，业务拒绝不自动重试", async () => {
    const responses = [created(), failure(504, "V2_UPSTREAM_TIMEOUT"), state("SUCCEEDED"), completed()];
    const f = fixture((_path, _init, index) => responses[index]!);
    await f.run(request()); expect(f.calls).toHaveLength(4);
  });

  for (const httpStatus of [400, 401, 403, 404, 409, 429, 500, 502, 503]) test(`HTTP ${httpStatus} 停止当前任务，不重建或吞为空结果`, async () => {
    const f = fixture((_path, _init, index) => index === 0 ? created() : failure(httpStatus));
    await expect(f.run(request())).rejects.toMatchObject({ status: httpStatus });
    expect(f.calls).toHaveLength(2);
  });

  for (const taskStatus of ["FAILED", "EXPIRED"] as const) test(`${taskStatus} 保留任务真实终态并停止`, async () => {
    const updates: Readonly<BiQueryJobProgress>[] = [];
    const f = fixture((_path, _init, index) => index === 0 ? created() : state(taskStatus));
    const error = await f.run(request(), { onProgress: item => updates.push(item) }).catch(error => error);
    expect(error).toBeInstanceOf(BiQueryJobTerminalError);
    expect(error.progress.status).toBe(taskStatus);
    expect(updates.map(item => item.status)).toEqual([taskStatus]); expect(f.calls).toHaveLength(2);
  });

  test("状态成功后结果已过期，以结果实际状态失败关闭", async () => {
    const responses = [created(), state("SUCCEEDED"), state("EXPIRED")];
    const updates: Readonly<BiQueryJobProgress>[] = [];
    const f = fixture((_path, _init, index) => responses[index]!);
    await expect(f.run(request(), { onProgress: item => updates.push(item) })).rejects.toMatchObject({ code: "QUERY_JOB_EXPIRED" });
    expect(updates.map(item => item.status)).toEqual(["SUCCEEDED", "EXPIRED"]); expect(f.calls).toHaveLength(3);
  });

  test("恢复后进度可重置，结果非终态继续同 handle 而非重建", async () => {
    const responses = [created(), state("RUNNING", { completedUnits: 1, attempts: 1 }), state("RUNNING", { completedUnits: 0, attempts: 2 }),
      state("SUCCEEDED"), state("RUNNING"), state("SUCCEEDED"), completed()];
    const f = fixture((_path, _init, index) => responses[index]!);
    await f.run(request());
    expect(f.calls.filter(item => item.init.method === "POST")).toHaveLength(1); expect(f.sleeps).toHaveLength(4);
  });

  test("排队超过120秒仍继续，不伪造服务端执行期限", async () => {
    const f = fixture((path, _init, index) => index === 0 ? created() : path.endsWith("/result") ? completed() : state(index < 62 ? "QUEUED" : "SUCCEEDED"));
    await f.run(request()); expect(f.now()).toBe(124_000);
  });

  test("450秒本地等待结束独立抛错，不把真实 QUEUED 改成 FAILED", async () => {
    const updates: Readonly<BiQueryJobProgress>[] = [];
    const f = fixture((_path, _init, index) => index === 0 ? created() : state("QUEUED"));
    const error = await f.run(request(), { onProgress: item => updates.push(item) }).catch(error => error);
    expect(error).toBeInstanceOf(BiQueryJobWaitError); expect(error.code).toBe("QUERY_JOB_LOCAL_WAIT_TIMEOUT");
    expect(error.handle).toBe(handle); expect(f.now()).toBe(450_000);
    expect(updates.every(item => item.status === "QUEUED")).toBe(true);
    expect(f.calls.filter(item => item.init.method === "POST")).toHaveLength(1);
  });

  test("成功结果保留真实0、null与非READY诊断输入，不补算或补零", async () => {
    const result = resultPayload();
    result.data.results[0]!.rows.push({ ...result.data.results[0]!.rows[0]!, value: null, numerator: 3, denominator: 0, dataStatus: "SOURCE_INCOMPLETE" });
    const f = fixture((_path, _init, index) => index === 0 ? created() : index === 1 ? state("SUCCEEDED") : Response.json(result));
    expect((await f.run(request())).data.results[0]!.rows.map(row => [row.value, row.numerator, row.denominator, row.dataStatus])).toEqual([
      [0, 0, null, "READY"], [null, 3, 0, "SOURCE_INCOMPLETE"]
    ]);
  });

  test("结果必须包含对应单元；缺失/多单元、错handle和进度不匹配均拒绝", async () => {
    console.warn = () => undefined;
    const raw = resultPayload();
    const invalid = [
      { ...raw.data, results: undefined }, { ...raw.data, results: [] }, { ...raw.data, results: [...raw.data.results, ...raw.data.results] },
      { ...raw.data, handle: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, { ...raw.data, totalUnits: 2 }, { ...raw.data, completedUnits: 0 },
      { ...raw.data, results: [{ rows: [], generatedAt: undefined }] }
    ];
    for (const data of invalid) {
      const f = fixture((_path, _init, index) => index === 0 ? created() : index === 1 ? state("SUCCEEDED") : Response.json({ success: true, data }));
      await expect(f.run(request())).rejects.toMatchObject({ code: expect.stringMatching(/^INVALID_V2_/) });
      expect(f.calls).toHaveLength(3);
    }
  });

  test("未知状态不能成为进度或成功，非法请求不发网络", async () => {
    console.warn = () => undefined;
    const f = fixture((_path, _init, index) => index === 0 ? created() : Response.json({ success: true, data: { handle, status: "UNKNOWN" } }));
    const updates: Readonly<BiQueryJobProgress>[] = [];
    await expect(f.run(request(), { onProgress: item => updates.push(item) })).rejects.toMatchObject({ code: "INVALID_V2_RESPONSE" });
    expect(updates).toHaveLength(0);
    const invalid = fixture(() => created());
    await expect(invalid.run({ queries: [] })).rejects.toMatchObject({ code: "QUERY_JOB_INVALID" }); expect(invalid.calls).toHaveLength(0);
  });
});

describe("BI 查询任务取消与迟到隔离", () => {
  test("调用前取消不创建任务", async () => {
    const f = fixture(() => created());
    await expect(f.run(request(), { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(f.calls).toHaveLength(0);
  });

  test("创建期间取消立即结束，即使fetch迟到兑现也不开始轮询", async () => {
    const pending = deferred<Response>(), controller = new AbortController();
    const f = fixture(() => pending.promise);
    const result = f.run(request(), { signal: controller.signal }).catch(error => error);
    controller.abort(); expect((await result).name).toBe("AbortError");
    pending.resolve(created()); await Promise.resolve();
    expect(f.calls).toHaveLength(1); expect(f.sleeps).toHaveLength(0);
  });

  test("等待轮询期间取消不会发出下一条读取", async () => {
    const sleeping = deferred<void>(), entered = deferred<void>(), controller = new AbortController(); let calls = 0;
    const run = createBiQueryJobRunner({ fetch: async () => { calls++; return created(); }, sleep: async () => { entered.resolve(); await sleeping.promise; } });
    const result = run(request(), { signal: controller.signal }).catch(error => error);
    await entered.promise; controller.abort(); expect((await result).name).toBe("AbortError");
    sleeping.resolve(); await Promise.resolve(); expect(calls).toBe(1);
  });

  for (const stage of ["status", "result"] as const) test(`${stage} JSON迟到不能发进度或返回旧结果`, async () => {
    const reading = deferred<void>(), json = deferred<unknown>(), controller = new AbortController();
    const delayed = new Response(); delayed.json = () => { reading.resolve(); return json.promise; };
    const f = fixture((_path, _init, index) => index === 0 ? created() : stage === "status" || index === 2 ? delayed : state("SUCCEEDED"));
    const updates: Readonly<BiQueryJobProgress>[] = [];
    const result = f.run(request(), { signal: controller.signal, onProgress: item => updates.push(item) }).catch(error => error);
    await reading.promise; controller.abort(); expect((await result).name).toBe("AbortError");
    json.resolve(stage === "status" ? { success: true, data: progress("SUCCEEDED") } : resultPayload());
    await Promise.resolve(); await Promise.resolve();
    expect(updates).toHaveLength(stage === "status" ? 0 : 1); expect(f.calls).toHaveLength(stage === "status" ? 2 : 3);
  });

  test("onProgress触发取消后不继续请求结果", async () => {
    const controller = new AbortController();
    const f = fixture((_path, _init, index) => index === 0 ? created() : state("SUCCEEDED"));
    await expect(f.run(request(), { signal: controller.signal, onProgress: () => controller.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(f.calls).toHaveLength(2);
  });

  test("取消后迟到401不能触发其他查询的登录失效通知", async () => {
    const target = new EventTarget(), controller = new AbortController(); let notifications = 0;
    Object.defineProperty(globalThis, "window", { configurable: true, value: target });
    target.addEventListener(V2_AUTHENTICATION_REQUIRED_EVENT, () => notifications++);
    const f = fixture(() => { controller.abort(); return failure(401); });
    await expect(f.run(request(), { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(notifications).toBe(0);
  });

  test("JSON在本地等待期限后返回也不能作为本次结果", async () => {
    const f = fixture((_path, _init, index) => {
      if (index === 0) return created();
      const late = state("SUCCEEDED");
      late.json = async () => { f.advance(450_000); return { success: true, data: progress("SUCCEEDED") }; };
      return late;
    });
    const updates: Readonly<BiQueryJobProgress>[] = [];
    await expect(f.run(request(), { onProgress: item => updates.push(item) })).rejects.toBeInstanceOf(BiQueryJobWaitError);
    expect(updates).toHaveLength(0); expect(f.calls).toHaveLength(2);
  });
});
