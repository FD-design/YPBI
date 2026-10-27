import { expect, test } from "bun:test";
import { UpstreamError } from "../upstream/client";
import { BI_V1_METRICS_API } from "../upstream/bi-v1.metrics-adapter";
import { DailyDashboardService } from "./daily-dashboard.service";

const date = "2020-01-01";
const timeoutMs = 50;
const query = { boardId: "5.10", pid: "PH", dateRange: [date, date] as [string, string] };
const now = () => new Date("2026-10-27T00:00:00Z");
const codes = ["M008", "M016", "M058", "M059", "M061", "M064"];

function fixture(timedOutCodes: readonly string[], holdPrimary = false, terminal?: UpstreamError) {
  const calls: Array<{ codes: string[]; overall: boolean }> = [];
  const timeouts: Array<{ code: string; elapsedMs: number }> = [];
  const budgets: boolean[] = [];
  const client = { get: async (path: string, params: Record<string, string>, _token?: string, signal?: AbortSignal): Promise<unknown> => {
    if (path !== BI_V1_METRICS_API) return { msg: { pageData: [], totalData: [], totalCount: 0 }, data: [] };
    const requested = params.metricCodes.split(","), overall = !params.dimensionFilters;
    calls.push({ codes: requested, overall });
    if (overall && (requested.length > 1 ? holdPrimary : timedOutCodes.includes(requested[0]))) {
      const startedAt = performance.now();
      return new Promise((_resolve, reject) => {
        const cancel = () => {
          timeouts.push({ code: requested.join(","), elapsedMs: performance.now() - startedAt });
          reject(new Error("synthetic unit transport cancelled"));
        };
        if (signal?.aborted) cancel();
        else signal?.addEventListener("abort", cancel, { once: true });
      });
    }
    if (requested.length > 1) throw new UpstreamError("UPSTREAM_INVALID_REQUEST", "unsupported metrics", 422);
    if (overall && requested[0] === "M008" && terminal) throw terminal;
    const metricCode = requested[0], filters = JSON.parse(params.dimensionFilters ?? "{}");
    const ratio = ["M061", "M064"].includes(metricCode), currency = metricCode === "M058";
    return { code: 200, msg: { metricVersion: "bi-v1", generatedAt: now().toISOString(), watermark: null, rows: [{
      metricCode, businessDate: date, dimensions: { pid: params.pid, ...filters }, value: ratio ? 0.5 : 7,
      numerator: ratio ? 1 : 7, denominator: ratio ? 2 : 0, unit: ratio ? "ratio" : currency ? "currency" : "count",
      dataStatus: "READY", metricVersion: "bi-v1", ruleVersion: currency ? "paid-order-value-rmb-v2" : "synthetic-v1"
    }] } };
  } };
  const logger = { info: (fields: { sources?: Array<{ sourceId: string; budgetExpired: boolean }> }) => {
    const source = fields.sources?.find(source => source.sourceId === "metrics");
    if (source) budgets.push(source.budgetExpired);
  } };
  return { calls, timeouts, budgets, service: new DailyDashboardService(client, now, logger, { sourceReadTimeoutMs: timeoutMs }) };
}

const point = (result: Awaited<ReturnType<DailyDashboardService["execute"]>>, id: string) =>
  result.data.series.find(series => series.metric.id === id)!.points[0];

test("恢复单元超时只关闭该项，后续健康M058/M059/M061/M064继续读取", async () => {
  const f = fixture(["M008"]);
  const result = await f.service.execute(query);
  expect(f.calls.filter(call => call.overall && call.codes.length === 1).map(call => call.codes[0])).toEqual(codes);
  expect(f.timeouts.map(timeout => timeout.code)).toEqual(["M008"]);
  expect(f.timeouts[0].elapsedMs).toBeGreaterThanOrEqual(timeoutMs - 1);
  for (const id of ["M058", "M059", "M058.new", "M059.new"]) expect(point(result, id)).toMatchObject({ state: "available", sourceStatus: "READY", value: 7 });
  for (const id of ["M061", "M064"]) expect(point(result, id)).toMatchObject({ state: "available", sourceStatus: "READY", value: 0.5 });
  expect(f.budgets).toEqual([true]);
});

test("两个恢复单元分别受原真实期限约束，已接受M058及后续健康项不被覆盖", async () => {
  const f = fixture(["M008", "M059"]);
  const result = await f.service.execute(query);
  expect(f.calls.filter(call => call.overall && call.codes.length === 1).map(call => call.codes[0])).toEqual(codes);
  expect(f.timeouts.map(timeout => timeout.code)).toEqual(["M008", "M059"]);
  expect(f.timeouts.every(timeout => timeout.elapsedMs >= timeoutMs - 1)).toBe(true);
  expect(point(result, "M059")).toMatchObject({ state: "source_failure", value: null });
  expect(point(result, "M058")).toMatchObject({ state: "available", sourceStatus: "READY", value: 7 });
  for (const id of ["M061", "M064"]) expect(point(result, id)).toMatchObject({ state: "available", sourceStatus: "READY", value: 0.5 });
  expect(f.budgets).toEqual([true]);
});

test("主批次单元直接超时仍不自动扩大单指标拆单", async () => {
  const f = fixture([], true);
  const result = await f.service.execute(query);
  expect(f.calls.filter(call => call.overall).map(call => call.codes)).toEqual([codes]);
  expect(f.timeouts.map(timeout => timeout.code)).toEqual([codes.join(",")]);
  for (const id of ["M058", "M059", "M061", "M064"]) expect(point(result, id)).toMatchObject({ state: "source_failure", value: null });
});

for (const origin of ["fatal", "consumer_cancelled"] as const) test(`真实service先分类${origin}再调度恢复，后续总体单项不出站且独立组保持`, async () => {
  const terminal = origin === "fatal"
    ? new UpstreamError("UPSTREAM_AUTH_FAILED", "synthetic auth rejection", 401)
    : new UpstreamError("UPSTREAM_TIMEOUT", "后台来源读取已取消", 504, { origin });
  const f = fixture([], false, terminal);
  const result = await f.service.execute(query);
  expect(f.calls.filter(call => call.overall).map(call => call.codes)).toEqual([codes, ["M008"]]);
  for (const id of ["M058", "M059", "M061", "M064"]) expect(point(result, id)).toMatchObject({ state: "source_failure", value: null });
  for (const id of ["M058.new", "M059.new"]) expect(point(result, id)).toMatchObject({ state: "available", sourceStatus: "READY", value: 7 });
  expect(f.budgets).toEqual([false]);
});
