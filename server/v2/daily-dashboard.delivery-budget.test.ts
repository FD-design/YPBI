import { expect, test } from "bun:test";
import type { DailyDashboardQuery } from "../../contracts/daily-dashboard";
import { DailyDashboardService } from "./daily-dashboard.service";

const date = "2020-01-01";
const generatedAt = "2020-01-02T00:00:00Z";
const now = () => new Date("2026-10-24T00:00:00Z");
type Logger = NonNullable<ConstructorParameters<typeof DailyDashboardService>[2]>;
type LogEntry = Parameters<Logger["info"]>[0];
const payload = (metricCode: string, dimensions: Record<string, string> = { pid: "PH" }) => ({
  code: 200, msg: { metricVersion: "bi-v1", generatedAt, watermark: null, rows: [{
    metricCode, businessDate: date, dimensions, value: 7, numerator: 7, denominator: 0,
    unit: "count", dataStatus: "READY", metricVersion: "bi-v1", ruleVersion: "synthetic-v1"
  }] }
});
const emptyMetrics = () => ({ code: 200, msg: { metricVersion: "bi-v1", generatedAt, watermark: null, rows: [] } });
const emptyLegacy = () => ({ msg: { pageData: [], totalData: [], totalCount: 0 }, data: [] });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function block(ms: number) {
  const end = performance.now() + ms;
  while (performance.now() < end) {}
}
const point = (result: Awaited<ReturnType<DailyDashboardService["execute"]>>, id: string) =>
  result.data.series.find(series => series.metric.id === id)!.points[0];

test("真实看板：get按时交付后微任务阻塞越期的主批次不能进入READY", async () => {
  const raw = deferred<unknown>();
  const logs: LogEntry[] = [];
  let rawStarted = false;
  const client = { get: (path: string, params: Record<string, string>): Promise<unknown> => {
    if (path === "/api/admin/bi/v1/metrics") {
      if (!params.dimensionFilters && params.granularity === "day") {
        rawStarted = true;
        return raw.promise;
      }
      return Promise.resolve(emptyMetrics());
    }
    return Promise.resolve(emptyLegacy());
  } };
  const service = new DailyDashboardService(client, now, { info: value => { logs.push(value); } }, { sourceReadTimeoutMs: 100 });
  const read = service.execute({ boardId: "5.10", pid: "PH", dateRange: [date, date] });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(rawStarted).toBe(true);
  raw.resolve(payload("M059"));
  queueMicrotask(() => block(130));
  const result = await read;
  const metricsSource = logs.flatMap(log => log.sources ?? []).find(source => source.sourceId === "metrics")!;
  expect(metricsSource.durationMs).toBeGreaterThan(100);
  expect(metricsSource.budgetExpired).toBe(true);
  expect(point(result, "M059")).toMatchObject({ state: "source_failure", value: null });
  expect(point(result, "M059").sourceStatus).not.toBe("READY");
});

test("真实看板：早完成的独立readGroup保留，晚组失败且日志与追踪开关结果一致", async () => {
  const query: DailyDashboardQuery = {
    boardId: "5.2", pid: "PH", dateRange: [date, "2020-01-08"], projection: "operating_snapshot"
  };
  const results: Awaited<ReturnType<DailyDashboardService["execute"]>>[] = [];
  for (const mode of [
    { logging: false, tracing: false }, { logging: true, tracing: false }, { logging: true, tracing: true }
  ]) {
    const raw = deferred<unknown>();
    const entries: Array<{ fields: LogEntry; message: string }> = [];
    let rawStarted = false;
    const client = { get: (path: string, params: Record<string, string>): Promise<unknown> => {
      if (path === "/api/admin/bi/v1/metrics") {
        if (params.granularity === "day" && params.dimensionFilters === '{"userCohort":"new"}') {
          rawStarted = true;
          return raw.promise;
        }
        return Promise.resolve(!params.dimensionFilters && params.granularity === "day" ? payload("M016") : emptyMetrics());
      }
      return Promise.resolve(emptyLegacy());
    } };
    const logger: Logger | undefined = mode.logging ? {
      info: (fields, message) => { entries.push({ fields, message }); }
    } : undefined;
    const read = new DailyDashboardService(client, now, logger, {
      sourceReadTimeoutMs: 1000, readTraceEnabled: mode.tracing
    }).execute(query);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(rawStarted).toBe(true);
    // The ordinary event-loop turn lets the healthy group's complete validation
    // and merge finish before the other group's held response is released.
    await new Promise<void>(resolve => setImmediate(resolve));
    raw.resolve(payload("M016", { pid: "PH", userCohort: "new" }));
    queueMicrotask(() => block(1100));
    const result = await read;
    expect(point(result, "M016")).toMatchObject({ state: "available", sourceStatus: "READY", value: 7 });
    expect(point(result, "M016.new")).toMatchObject({ state: "source_failure", value: null });
    expect(point(result, "M016.new").sourceStatus).not.toBe("READY");
    if (mode.logging) expect(entries.flatMap(entry => entry.fields.sources ?? [])
      .find(source => source.sourceId === "metrics")!.budgetExpired).toBe(true);
    expect(entries.some(entry => entry.message === "daily dashboard read trace completed")).toBe(mode.tracing);
    expect(result.data).not.toHaveProperty("readTrace");
    results.push({ ...result, data: { ...result.data, queryId: "fixed-query" } });
  }
  expect(results[1]).toEqual(results[0]);
  expect(results[2]).toEqual(results[0]);
});
