import { expect, test } from "bun:test";
import { readBiV1MetricDays, type BiV1MetricCode, type BiV1MetricQuery } from "./bi-v1.metrics-adapter";
import { getUpstreamReadFailure, UpstreamError, type UpstreamClient } from "./client";
import { runWithReadDeliveryBoundary } from "./read-delivery";
import { SourceReadBudget } from "../v2/source-read-budget";

const date = "2020-01-01";
const generatedAt = "2020-01-02T00:00:00Z";
const query: BiV1MetricQuery = { pid: "PH", startDate: date, endDate: date, metricCodes: ["M008", "M016"] };
const payload = (metricCode: BiV1MetricCode, value = 7) => ({
  code: 200, msg: { metricVersion: "bi-v1", generatedAt, watermark: null, rows: [{
    metricCode, businessDate: date, dimensions: { pid: "PH" }, value, numerator: value, denominator: 0,
    unit: "count", dataStatus: "READY", metricVersion: "bi-v1", ruleVersion: "synthetic-v1"
  }] }
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function block(ms: number) {
  const end = performance.now() + ms;
  while (performance.now() < end) {}
}
async function until(condition: () => boolean) {
  for (let i = 0; i < 100 && !condition(); i++) await new Promise<void>(resolve => setImmediate(resolve));
  expect(condition()).toBe(true);
}
function boundedRead(budget: SourceReadBudget, client: Pick<UpstreamClient, "get">, request = query) {
  return runWithReadDeliveryBoundary((start, signal) => budget.read(start, signal), () =>
    readBiV1MetricDays({ get: (...args) => budget.read(() => client.get(...args), args[3]) }, request));
}
const expectSourceExpiry = (error: unknown) => {
  expect(error).toMatchObject({ code: "UPSTREAM_TIMEOUT", statusCode: 504 });
  expect(getUpstreamReadFailure(error)?.origin).toBe("source_budget");
};

test("主批次：get先交付、后续微任务阻塞越期时拒绝校验结果", async () => {
  const budget = new SourceReadBudget(100);
  const raw = deferred<unknown>();
  const started = performance.now();
  try {
    const read = boundedRead(budget, { get: () => raw.promise }, { ...query, metricCodes: ["M008"] }).catch(error => error);
    raw.resolve(payload("M008"));
    queueMicrotask(() => block(130));
    expectSourceExpiry(await read);
    expect(performance.now() - started).toBeGreaterThan(100);
    expect(budget.expired).toBe(true);
  } finally { budget.dispose(); }
});

test("主批次：50001条普通对象行的范围过滤与解析越期不能交付READY", async () => {
  const envelope = payload("M008");
  const unrelatedDimensionRow = { ...envelope.msg.rows[0], dimensions: { pid: "PH", userCohort: "new" } };
  envelope.msg.rows.push(...Array.from({ length: 50_000 }, () => unrelatedDimensionRow));
  const budget = new SourceReadBudget(20);
  const started = performance.now();
  try {
    const error = await boundedRead(budget, { get: async () => envelope }, { ...query, metricCodes: ["M008"] }).catch(error => error);
    expect(envelope.msg.rows).toHaveLength(50_001);
    expect(performance.now() - started).toBeGreaterThan(20);
    expectSourceExpiry(error);
    expect(budget.expired).toBe(true);
  } finally { budget.dispose(); }
});

test("拆单恢复：保留先校验完成的兄弟，迟到、未完成及未启动项保持失败", async () => {
  const budget = new SourceReadBudget(100);
  const held = new Map<string, ReturnType<typeof deferred<unknown>>>();
  const calls: string[] = [];
  const codes = ["M008", "M016", "M113", "M112", "M060"] as const;
  try {
    const read = boundedRead(budget, { get: (_path, params) => {
      calls.push(params.metricCodes);
      if (params.metricCodes.includes(",")) return Promise.resolve({ code: 400, err: "unsupported metrics" });
      const raw = deferred<unknown>();
      held.set(params.metricCodes, raw);
      return raw.promise;
    } }, { ...query, metricCodes: codes });
    await until(() => held.size === 3);
    held.get("M008")!.resolve(payload("M008"));
    await until(() => held.has("M112"));
    held.get("M016")!.resolve(payload("M016"));
    held.get("M113")!.resolve(payload("M113"));
    queueMicrotask(() => block(130));
    const result = await read;
    expect(result.message).toBeNull();
    expect(result.days[0].metrics.M008).toMatchObject({ state: "available", dataStatus: "READY", value: 7 });
    for (const code of codes.slice(1)) expect(result.days[0].metrics[code]).toMatchObject({
      state: "source_failure", dataStatus: null, value: null, numerator: null, denominator: null
    });
    expect(calls).toEqual([codes.join(","), "M008", "M016", "M113", "M112"]);
    expect(budget.expired).toBe(true);
  } finally { budget.dispose(); }
});

test("拆单恢复：两个get均先交付、校验前微任务越期时均不能进入READY", async () => {
  const budget = new SourceReadBudget(100);
  const held = new Map<string, ReturnType<typeof deferred<unknown>>>();
  try {
    const read = boundedRead(budget, { get: (_path, params) => {
      if (params.metricCodes.includes(",")) return Promise.resolve({ code: 400, err: "unsupported metrics" });
      const raw = deferred<unknown>();
      held.set(params.metricCodes, raw);
      return raw.promise;
    } });
    await until(() => held.size === 2);
    held.get("M008")!.resolve(payload("M008"));
    held.get("M016")!.resolve(payload("M016"));
    queueMicrotask(() => block(130));
    const result = await read;
    expect(result.message).toBeNull();
    for (const code of ["M008", "M016"]) expect(result.days[0].metrics[code]).toMatchObject({
      state: "source_failure", dataStatus: null, value: null
    });
    expect(budget.expired).toBe(true);
  } finally { budget.dispose(); }
});

test("拆单恢复：预算已接受的健康结果延迟交接时仍保留，兄弟到期只关闭未完成项", async () => {
  const budget = new SourceReadBudget(100);
  const held = new Map<string, ReturnType<typeof deferred<unknown>>>();
  let delivery = 0, accepted = false, startedAfterExpiry = false;
  try {
    const read = runWithReadDeliveryBoundary((start, signal) => {
      const current = delivery++;
      const result = budget.read(start, signal);
      if (current !== 1) return result;
      return result.then(async value => {
        accepted = true;
        block(130);
        await budget.read(async () => { startedAfterExpiry = true; }).catch(() => {});
        // Complete the pending sibling's rejection before handing the already
        // accepted healthy value back to the recovery worker.
        await new Promise<void>(resolve => setImmediate(resolve));
        return value;
      });
    }, () => readBiV1MetricDays({ get: (_path, params, _token, signal) => budget.read(() => {
      if (params.metricCodes.includes(",")) return Promise.resolve({ code: 400, err: "unsupported metrics" });
      const raw = deferred<unknown>();
      held.set(params.metricCodes, raw);
      return raw.promise;
    }, signal) }, query));
    await until(() => held.size === 2);
    held.get("M008")!.resolve(payload("M008"));
    const result = await read;
    expect(accepted).toBe(true);
    expect(startedAfterExpiry).toBe(false);
    expect(budget.expired).toBe(true);
    expect(result.days[0].metrics.M008).toMatchObject({ state: "available", dataStatus: "READY", value: 7 });
    expect(result.days[0].metrics.M016).toMatchObject({ state: "source_failure", dataStatus: null, value: null });
  } finally { budget.dispose(); }
});

test("嵌套并行来源：短预算过期不能占用长预算的交付边界", async () => {
  const shortBudget = new SourceReadBudget(40);
  const longBudget = new SourceReadBudget(1000);
  const shortRaw = deferred<unknown>(), longRaw = deferred<unknown>();
  let longRead!: ReturnType<typeof readBiV1MetricDays>;
  try {
    const shortRead = runWithReadDeliveryBoundary((start, signal) => shortBudget.read(start, signal), () => {
      longRead = boundedRead(longBudget, { get: () => longRaw.promise }, { ...query, metricCodes: ["M016"] });
      return readBiV1MetricDays({ get: (...args) => shortBudget.read(() => shortRaw.promise, args[3]) }, { ...query, metricCodes: ["M008"] });
    }).catch(error => error);
    shortRaw.resolve(payload("M008"));
    longRaw.resolve(payload("M016", 11));
    queueMicrotask(() => block(60));
    expectSourceExpiry(await shortRead);
    expect((await longRead).days[0].metrics.M016).toMatchObject({ state: "available", dataStatus: "READY", value: 11 });
    expect(shortBudget.expired).toBe(true);
    expect(longBudget.expired).toBe(false);
  } finally { shortBudget.dispose(); longBudget.dispose(); }
});

test("拆单恢复：消费者取消与致命错误仍终止整组且不再启动新指标", async () => {
  for (const mode of ["consumer_cancelled", "fatal"] as const) {
    const consumer = new AbortController();
    const budget = new SourceReadBudget(1000, consumer.signal);
    const held = new Map<string, ReturnType<typeof deferred<unknown>>>();
    const calls: string[] = [];
    const fatal = new UpstreamError("UPSTREAM_AUTH_FAILED", "synthetic auth rejection", 401);
    try {
      const read = boundedRead(budget, { get: async (_path, params) => {
        calls.push(params.metricCodes);
        if (params.metricCodes.includes(",")) return { code: 400, err: "unsupported metrics" };
        const raw = deferred<unknown>();
        held.set(params.metricCodes, raw);
        return raw.promise;
      } }, { ...query, metricCodes: ["M008", "M016", "M113", "M112"] }).catch(error => error);
      await until(() => held.size === 3);
      if (mode === "consumer_cancelled") consumer.abort();
      else held.get("M008")!.reject(fatal);
      const error = await read;
      if (mode === "consumer_cancelled") expect(getUpstreamReadFailure(error)?.origin).toBe("consumer_cancelled");
      else expect(error).toBe(fatal);
      expect(calls).not.toContain("M112");
      expect(budget.expired).toBe(false);
    } finally { budget.dispose(); }
  }
});
