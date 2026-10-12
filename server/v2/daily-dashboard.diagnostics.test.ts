import { describe, expect, test } from "bun:test";
import type { DailyDashboardQuery, DailyDashboardV2Success } from "../../contracts/daily-dashboard";
import { BI_V1_METRICS_API } from "../upstream/bi-v1.metrics-adapter";
import { UpstreamError, type UpstreamClient } from "../upstream/client";
import { CHECKIN_OVERVIEW_API, DailyDashboardService, PAYMENT_RATE_API } from "./daily-dashboard.service";

type Logger = NonNullable<ConstructorParameters<typeof DailyDashboardService>[2]>;
type Entry = Parameters<Logger["info"]>[0];
const now = () => new Date("2026-10-12T00:00:00Z");
const query: DailyDashboardQuery = { boardId: "5.11", pid: "PH", dateRange: ["2020-01-01", "2020-01-04"] };
const emptyMetrics = { code: 200, msg: { metricVersion: "bi-v1", generatedAt: "2026-10-12T00:00:00Z", watermark: null, rows: [] } };
const capture = () => {
  const entries: Entry[] = [];
  const logger: Logger = { info: (fields, message) => {
    expect(message).toBe("daily dashboard source reads completed");
    entries.push(fields);
  } };
  return { entries, logger };
};
const normalize = (result: DailyDashboardV2Success) => ({ ...result, data: { ...result.data, queryId: "query-id" } });

function paymentClient(): Pick<UpstreamClient, "get"> {
  return { get: async (path, params) => {
    if (path === BI_V1_METRICS_API) return emptyMetrics;
    if (path === PAYMENT_RATE_API) {
      if (params.startTime.startsWith("2020-01-02")) throw new UpstreamError("UPSTREAM_REQUEST_FAILED", "secret-token Cookie=password https://secret.example/?filter=private", 502);
      return { msg: { pageData: [], secret: "raw-user-detail" } };
    }
    return { msg: { pageData: [], totalCount: 0, secret: "raw-user-detail" } };
  } };
}

describe("daily dashboard private source diagnostics", () => {
  test("来源耗时及逻辑读取计数沿用查询ID，失败来源与健康来源分别计数", async () => {
    const { entries, logger } = capture();
    const result = await new DailyDashboardService(paymentClient(), now, logger).execute(query);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.queryId).toBe(result.data.queryId);
    expect(entry.boardId).toBe(query.boardId);
    expect(entry.sources.map(source => source.sourceId)).toEqual(["daily", "payment", "metrics"]);
    const payment = entry.sources.find(source => source.sourceId === "payment")!;
    expect(payment.readCallCount).toBe(4);
    expect(payment.successfulReadCallCount).toBe(3);
    expect(payment.failedReadCallCount).toBe(1);
    for (const source of entry.sources) {
      expect(Number.isFinite(source.durationMs)).toBe(true);
      expect(source.durationMs).toBeGreaterThanOrEqual(0);
      expect(source.readCallCount).toBe(source.successfulReadCallCount + source.failedReadCallCount);
    }
    expect(normalize(result)).toEqual(normalize(await new DailyDashboardService(paymentClient(), now).execute(query)));
    expect(result.data).not.toHaveProperty("sources");
    const serialized = JSON.stringify(entry);
    for (const privateValue of ["secret-token", "Cookie", "password", "https://", "filter", "raw-user-detail", "2020-01-01", "PH", "/api/"]) {
      expect(serialized).not.toContain(privateValue);
    }
    expect(Object.keys(entry).sort()).toEqual(["boardId", "queryId", "sources"]);
    for (const source of entry.sources) expect(Object.keys(source).sort()).toEqual(["durationMs", "failedReadCallCount", "readCallCount", "sourceId", "successfulReadCallCount"]);
  });

  test("日志异常不改变已解析的成功和部分失败结果，未注入logger的请求保持原读取", async () => {
    let attemptedLogs = 0;
    const logger: Logger = { info: () => { attemptedLogs++; throw new Error("log unavailable"); } };
    const result = await new DailyDashboardService(paymentClient(), now, logger).execute(query);
    const withoutLogger = await new DailyDashboardService(paymentClient(), now).execute(query);
    expect(attemptedLogs).toBe(1);
    expect(normalize(result)).toEqual(normalize(withoutLogger));
  });

  test("并行查询独立记录来源计数，未读取的来源不输出", async () => {
    const { entries, logger } = capture();
    const client: Pick<UpstreamClient, "get"> = { get: async (path, params) => {
      expect(path).toBe(CHECKIN_OVERVIEW_API);
      await Promise.resolve();
      return { msg: { pid: params.pid, date: params.date, checkinUserCount: 2 } };
    } };
    const service = new DailyDashboardService(client, now, logger);
    const results = await Promise.all([1, 2].map(days => service.execute({ boardId: "5.14", pid: "PH", dateRange: ["2020-01-01", `2020-01-0${days}`] })));
    expect(entries).toHaveLength(2);
    expect(results[0].data.queryId).not.toBe(results[1].data.queryId);
    results.forEach((result, index) => {
      const entry = entries.find(entry => entry.queryId === result.data.queryId)!;
      expect(entry.sources).toHaveLength(1);
      expect(entry.sources[0].sourceId).toBe("checkin");
      expect(entry.sources[0].readCallCount).toBe(index + 1);
      expect(entry.sources[0].failedReadCallCount).toBe(0);
    });
  });

  test("计数覆盖有界拆单，单指标拒绝及其来源状态保持原行为", async () => {
    const { entries, logger } = capture();
    const reads: Record<string, string>[] = [];
    const client: Pick<UpstreamClient, "get"> = { get: async (path, params) => {
      if (path !== BI_V1_METRICS_API) return paymentClient().get(path, params);
      reads.push(params);
      const codes = params.metricCodes.split(",");
      if (codes.length > 1 || codes[0] === "M113") throw new UpstreamError("BI_V1_REQUEST_REJECTED", "不支持的指标编码: M113", 422);
      return emptyMetrics;
    } };
    const result = await new DailyDashboardService(client, now, logger).execute(query);
    const source = entries[0].sources.find(source => source.sourceId === "metrics")!;
    expect(source.readCallCount).toBe(reads.length);
    const failed = reads.filter(params => params.metricCodes.includes(",") || params.metricCodes === "M113").length;
    expect(source.failedReadCallCount).toBe(failed);
    expect(source.successfulReadCallCount).toBe(reads.length - failed);
    const groups = new Map<string, Record<string, string>[]>();
    for (const params of reads) {
      const key = params.dimensionFilters ?? "overall";
      const calls = groups.get(key) ?? [];
      calls.push(params);
      groups.set(key, calls);
    }
    for (const calls of groups.values()) {
      const codes = calls[0].metricCodes.split(",");
      expect(calls.length).toBe(codes.length + 1);
      expect(calls.slice(1).map(call => call.metricCodes)).toEqual(codes);
    }
    expect(result.data.series.find(series => series.metric.id === "M113")!.points.every(point => point.state === "source_failure")).toBe(true);
    expect(JSON.stringify(entries)).not.toContain("不支持的指标编码");
  });

  test("诊断保留原分域三工作者上限以及域间并行", async () => {
    const { entries, logger } = capture();
    let paymentActive = 0, metricsActive = 0, paymentPeak = 0, metricsPeak = 0, totalPeak = 0;
    const client: Pick<UpstreamClient, "get"> = { get: async (path, params) => {
      if (path !== PAYMENT_RATE_API && path !== BI_V1_METRICS_API) return paymentClient().get(path, params);
      if (path === PAYMENT_RATE_API) paymentPeak = Math.max(paymentPeak, ++paymentActive);
      else metricsPeak = Math.max(metricsPeak, ++metricsActive);
      totalPeak = Math.max(totalPeak, paymentActive + metricsActive);
      await new Promise<void>(resolve => setImmediate(resolve));
      if (path === PAYMENT_RATE_API) { paymentActive--; return { msg: { pageData: [] } }; }
      metricsActive--;
      return emptyMetrics;
    } };
    await new DailyDashboardService(client, now, logger).execute(query);
    expect(paymentPeak).toBe(3);
    expect(metricsPeak).toBe(3);
    expect(totalPeak).toBe(6);
    expect(entries).toHaveLength(1);
  });
});
