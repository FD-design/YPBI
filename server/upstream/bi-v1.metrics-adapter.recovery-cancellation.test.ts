import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { loadEnv } from "../config/env";
import { UpstreamClient, UpstreamError, getUpstreamReadFailure } from "./client";
import { BI_V1_METRICS_API, queryBiV1Metrics, readBiV1MetricDays, type BiV1MetricCode } from "./bi-v1.metrics-adapter";

const query = { pid: "PH", startDate: "2020-01-01", endDate: "2020-01-01", metricCodes: ["M008", "M113", "M112", "M060"] as const };
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(condition: () => boolean) {
  for (let i = 0; i < 100 && !condition(); i++) await turn();
  expect(condition()).toBe(true);
}
const payload = (code: BiV1MetricCode) => ({ code: 200, msg: { metricVersion: "bi-v1", generatedAt: "2026-10-23T00:00:00Z", watermark: null, rows: [{
  metricCode: code, businessDate: query.startDate, dimensions: { pid: query.pid }, value: 1, numerator: 1, denominator: 0,
  unit: "count", dataStatus: "READY", metricVersion: "bi-v1", ruleVersion: "synthetic-v1"
}] } });

function fixture() {
  const held: Array<{ path: string; code: string; signal?: AbortSignal | null; finish: (response?: Response) => void }> = [];
  const calls: string[] = [];
  let fatal: unknown;
  const upstream = new UpstreamClient(loadEnv({ NODE_ENV: "test", UPSTREAM_API_BASE_URL: "https://in-memory.invalid",
    UPSTREAM_USER_NAME: "synthetic-user", UPSTREAM_X_TOKEN: "synthetic-token", REQUEST_TIMEOUT_MS: "2000",
    UPSTREAM_CREDENTIALS_FILE: `/private/tmp/ypbi-metric-recovery-absent-${randomUUID()}.json`
  }), async (input, init) => {
    const url = new URL(String(input)), code = url.searchParams.get("metricCodes") ?? "";
    calls.push(code || url.pathname);
    if (code.includes(",")) return Response.json({ code: 400, err: "unsupported metrics" }, { status: 422 });
    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const abort = () => { if (!settled) { settled = true; reject(new DOMException("synthetic cancellation", "AbortError")); } };
      init?.signal?.addEventListener("abort", abort, { once: true });
      held.push({ path: url.pathname, code, signal: init?.signal, finish: response => {
        if (settled) return;
        settled = true; init?.signal?.removeEventListener("abort", abort);
        resolve(response ?? (code ? Response.json(payload(code as BiV1MetricCode)) : Response.json({ code: 200, msg: [] })));
      } });
    });
  }, { maxActiveRequests: 3, maxQueuedRequests: 8 });
  const client = { get: async (path: string, params: Record<string, string>, token?: string, signal?: AbortSignal) => {
    try { return await upstream.get(path, params, token, signal); }
    catch (error) { if (params.metricCodes === "M008") fatal = error; throw error; }
  } };
  return { client, upstream, held, calls, fatal: () => fatal,
    async cleanup() { for (let i = 0; i < 10; i++) { held.forEach(read => read.finish()); await turn(); } }
  };
}

test("真实三槽客户端：拆单鉴权失败后取消同组兄弟，原fatal透传且三个新请求立即获得槽位", async () => {
  const f = fixture(), probes: Promise<unknown>[] = [];
  try {
    const pending = readBiV1MetricDays(f.client, query).catch(error => error);
    await until(() => f.held.filter(read => read.path === BI_V1_METRICS_API).length === 3);
    f.held.find(read => read.code === "M008")!.finish(Response.json({ code: 2002, err: "synthetic auth rejection" }, { status: 401 }));
    const error = await pending;
    expect(error).toBe(f.fatal()); expect(error).toMatchObject({ code: "UPSTREAM_AUTH_FAILED", statusCode: 401 });
    for (let i = 0; i < 3; i++) probes.push(f.upstream.get("/api/fixture/probe", { pid: "PH", slot: String(i) }));
    await turn(); await turn();
    expect(f.held.filter(read => read.path === "/api/fixture/probe")).toHaveLength(3);
    expect(f.held.filter(read => ["M113", "M112"].includes(read.code)).every(read => read.signal?.aborted)).toBe(true);
    expect(f.calls).not.toContain("M060");
  } finally { await f.cleanup(); await Promise.allSettled(probes); }
});

for (const healthyFirst of [true, false]) test(`真实共享消费者：${healthyFirst ? "健康读取先创建" : "拆单先创建"}时取消拆单不终止健康M113`, async () => {
  const f = fixture(), healthyController = new AbortController();
  let healthy: Promise<unknown> | undefined;
  const startHealthy = () => queryBiV1Metrics(f.upstream, { ...query, metricCodes: ["M113"] }, healthyController.signal);
  try {
    if (healthyFirst) { healthy = startHealthy(); await until(() => f.held.some(read => read.code === "M113")); }
    const pending = readBiV1MetricDays(f.client, query).catch(error => error);
    await until(() => f.held.filter(read => read.path === BI_V1_METRICS_API).length === 3);
    if (!healthyFirst) healthy = startHealthy();
    await turn();
    expect(f.held.filter(read => read.code === "M113")).toHaveLength(1);
    f.held.find(read => read.code === "M008")!.finish(Response.json({ code: 2002, err: "synthetic auth rejection" }, { status: 401 }));
    expect(await pending).toBe(f.fatal());
    await turn();
    expect(f.held.find(read => read.code === "M113")!.signal?.aborted).toBe(false);
    expect(f.held.find(read => read.code === "M112")!.signal?.aborted).toBe(true);
    expect(healthyController.signal.aborted).toBe(false);
    f.held.find(read => read.code === "M113")!.finish();
    expect(await healthy).toMatchObject({ rows: [{ metricCode: "M113", value: 1, dataStatus: "READY" }] });
    expect(f.calls).not.toContain("M060");
  } finally { await f.cleanup(); await healthy?.catch(() => {}); }
});

for (const [label, fatal] of [
  ["鉴权", new UpstreamError("UPSTREAM_AUTH_FAILED", "synthetic auth failure", 401)],
  ["范围冲突", new UpstreamError("BI_V1_SCOPE_CONFLICT", "synthetic scope failure", 502)],
  ["外部取消", new UpstreamError("UPSTREAM_TIMEOUT", "后台接口请求超时", 504, { origin: "consumer_cancelled" })]
] as const) test(`source_budget后独立${label}继续整体透传，内部取消不能覆盖原错误`, async () => {
  const pendingReads = new Map<string, { signal?: AbortSignal; fail: (error: unknown) => void }>();
  const expiry = new UpstreamError("UPSTREAM_TIMEOUT", "后台来源读取超时", 504, { origin: "source_budget" });
  const pending = readBiV1MetricDays({ get: async (_path, params, _token, signal) => {
    if (params.metricCodes.includes(",")) return { code: 400, err: "unsupported metrics" };
    if (params.metricCodes === "M008") return payload("M008");
    return new Promise((_resolve, reject) => {
      const abort = () => reject(new UpstreamError("UPSTREAM_TIMEOUT", "后台接口请求超时", 504, { origin: "consumer_cancelled" }));
      signal?.addEventListener("abort", abort, { once: true });
      pendingReads.set(params.metricCodes, { signal, fail: error => { signal?.removeEventListener("abort", abort); reject(error); } });
    });
  } }, query).catch(error => error);
  await until(() => pendingReads.size === 3);
  pendingReads.get("M113")!.fail(expiry); await turn();
  expect([...pendingReads.values()].every(read => !read.signal?.aborted)).toBe(true);
  pendingReads.get("M112")!.fail(fatal);
  expect(await pending).toBe(fatal);
  expect(getUpstreamReadFailure(fatal)?.origin).toBe(label === "外部取消" ? "consumer_cancelled" : undefined);
  expect(pendingReads.get("M060")!.signal?.aborted).toBe(true);
});
