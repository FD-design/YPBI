import { expect, test } from "bun:test";
import { dailyDashboardMatchesQuery, dailyDashboardSuccessSchema, type DailyDashboardQuery } from "../../contracts/daily-dashboard";
import { OPERATING_METRIC_IDS, operatingSnapshotDates } from "../../contracts/operating-detail-projection";
import { BI_V1_RETENTION_DAYS } from "../upstream/bi-v1.metrics-adapter";
import { UpstreamError } from "../upstream/client";
import { P_DAY_SUM_API } from "../upstream/overview.adapter";
import { RETENTION_PLUS_API } from "../upstream/retention.adapter";
import { CHANNEL_V2_API, DailyDashboardService, PAYMENT_RATE_API, dailyDashboardMatchesMapping } from "./daily-dashboard.service";

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

const snapshot: DailyDashboardQuery = {
  boardId: "5.2", pid: "PH", dateRange: [date, "2020-01-08"], projection: "operating_snapshot"
};
const snapshotDates = operatingSnapshotDates(snapshot.dateRange);
function snapshotCounts(metricCode: string, dimensions?: Record<string, string>) {
  const result = payload(metricCode, dimensions);
  const row = result.msg.rows[0];
  result.msg.rows = snapshotDates.map((businessDate, index) => ({
    ...row, businessDate, value: index, numerator: index
  }));
  return result;
}
function heldSnapshot(splitOverall = false) {
  const stalled = deferred<unknown>();
  const started = deferred<AbortSignal | undefined>();
  const calls: Array<{ path: string; codes?: string; filters?: string }> = [];
  const entries: Array<{ fields: LogEntry; message: string }> = [];
  const logger: Logger = { info: (fields, message) => { entries.push({ fields, message }); } };
  const client = { get: async (path: string, params: Record<string, string>, _token?: string, signal?: AbortSignal) => {
    calls.push({ path, codes: params.metricCodes, filters: params.dimensionFilters });
    if (path !== "/api/admin/bi/v1/metrics") return emptyLegacy();
    if (params.granularity !== "day") return emptyMetrics();
    if (!params.dimensionFilters) {
      if (!splitOverall) {
        const ready = snapshotCounts("M016");
        const incomplete = snapshotCounts("M026").msg.rows.map(row => ({ ...row, dataStatus: "SOURCE_INCOMPLETE", value: null }));
        return { ...ready, msg: { ...ready.msg, rows: [...ready.msg.rows, ...incomplete] } };
      }
      if (params.metricCodes.includes(",")) throw new UpstreamError("BI_V1_REQUEST_REJECTED", "unsupported metrics", 400);
      if (params.metricCodes === "M001") return snapshotCounts("M001");
      if (params.metricCodes === "M002") {
        started.resolve(signal);
        return stalled.promise;
      }
    } else if (!splitOverall && params.dimensionFilters === '{"userCohort":"new"}') {
      started.resolve(signal);
      return stalled.promise;
    }
    return emptyMetrics();
  } };
  return { client, logger, stalled, started, calls, entries };
}

for (const splitOverall of [false, true]) {
  test(`经营快照总预算截止时保留${splitOverall ? "同组拆单" : "独立查询组"}已就绪数据和93列三日期`, async () => {
    const fixture = heldSnapshot(splitOverall);
    const service = new DailyDashboardService(fixture.client, now, fixture.logger, {
      sourceReadTimeoutMs: 1_000, operatingSnapshotReadTimeoutMs: 150, readTraceEnabled: true
    });
    const read = service.execute(snapshot);
    const signal = await fixture.started.promise;
    const callsBeforeExpiry = fixture.calls.length;
    const result = await read;
    expect(signal?.aborted).toBe(true);
    expect(dailyDashboardSuccessSchema.safeParse(result).success).toBe(true);
    expect(dailyDashboardMatchesQuery(result, snapshot, OPERATING_METRIC_IDS)).toBe(true);
    expect(dailyDashboardMatchesMapping(result)).toBe(true);
    expect(result.data.series.map(series => series.metric.id)).toEqual([...OPERATING_METRIC_IDS]);
    for (const series of result.data.series) expect(series.points.map(point => point.date)).toEqual(snapshotDates);
    const seriesPoints = (id: string) => result.data.series.find(series => series.metric.id === id)!.points;
    const accepted = splitOverall ? "M001" : "M016";
    expect(seriesPoints(accepted).map(({ state, sourceStatus, value }) => ({ state, sourceStatus, value }))).toEqual(
      [0, 1, 2].map(value => ({ state: "available", sourceStatus: "READY", value }))
    );
    if (!splitOverall) for (const item of seriesPoints("M026")) {
      expect(item).toMatchObject({ state: "no_value", sourceStatus: "SOURCE_INCOMPLETE", value: null });
    }
    for (const id of splitOverall ? ["M002", "M003"] : ["M016.new"]) {
      for (const item of seriesPoints(id)) {
        expect(item).toMatchObject({ state: "source_failure", value: null });
        expect(item.sourceStatus).toBeUndefined();
      }
    }
    const source = fixture.entries.flatMap(entry => entry.fields.sources ?? []).find(item => item.sourceId === "metrics");
    expect(source?.errorCodeCounts.UPSTREAM_TIMEOUT).toBeGreaterThanOrEqual(1);
    const trace = fixture.entries.find(entry => entry.message === "daily dashboard read trace completed")?.fields;
    expect(trace?.sourceFailureOrigins?.find(item => item.sourceId === "metrics")?.counts.snapshot_deadline).toBeGreaterThanOrEqual(1);
    if (splitOverall) {
      expect(fixture.calls.filter(call => call.path === "/api/admin/bi/v1/metrics" && !call.filters && call.codes?.startsWith("M00") && !call.codes.includes(","))
        .map(call => call.codes)).toEqual(["M001", "M002"]);
    }
    fixture.stalled.resolve(splitOverall ? snapshotCounts("M002") : snapshotCounts("M016", { pid: "PH", userCohort: "new" }));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(fixture.calls).toHaveLength(callsBeforeExpiry);
    expect(seriesPoints(splitOverall ? "M002" : "M016.new").every(item => item.state === "source_failure")).toBe(true);
  });
}

test("客户端中断同步经营快照时拒绝查询，独立的内部总预算不会返回部分数据", async () => {
  const fixture = heldSnapshot();
  const controller = new AbortController();
  const service = new DailyDashboardService(fixture.client, now, fixture.logger, {
    sourceReadTimeoutMs: 1_000, operatingSnapshotReadTimeoutMs: 800
  });
  const read = service.execute(snapshot, controller.signal);
  const signal = await fixture.started.promise;
  const callsBeforeAbort = fixture.calls.length;
  controller.abort();
  await expect(read).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT" });
  expect(signal?.aborted).toBe(true);
  fixture.stalled.resolve(snapshotCounts("M016", { pid: "PH", userCohort: "new" }));
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(fixture.calls).toHaveLength(callsBeforeAbort);
});

for (const stallNewUsers of [false, true]) test(`PH跨月经营快照先读取独立批组，慢新用户批组=${stallNewUsers}`, async () => {
  const query: DailyDashboardQuery = {
    ...snapshot, dateRange: ["2026-10-27", "2026-11-03"]
  };
  const dates = operatingSnapshotDates(query.dateRange);
  const calls: Array<{ path: string; scope: string; startDate?: string; endDate?: string }> = [];
  const heldNewUsers = deferred<unknown>();
  const startedNewUsers = deferred<void>();
  let active = 0, peak = 0;
  const rows = (code: string, dimensions: Record<string, string> = { pid: "PH" }) => {
    const row = payload(code, dimensions).msg.rows[0];
    return dates.map(businessDate => ({ ...row, businessDate }));
  };
  const envelope = (rows: unknown[]) => ({ code: 200, msg: { ...emptyMetrics().msg, rows } });
  const client = { get: async (path: string, params: Record<string, string>) => {
    const filters = JSON.parse(params.dimensionFilters ?? "{}") as Record<string, string>;
    const scope = params.metricCodes === "M115" ? "retentionDay"
      : params.metricCodes === "M018" ? "monthly"
      : filters.clientPlatform ? [filters.clientPlatform, filters.userCohort].filter(Boolean).join("_")
      : filters.sourceType ?? filters.paymentMethod ?? filters.userCohort ?? "overall";
    calls.push({ path, scope, startDate: params.startDate, endDate: params.endDate });
    active++;
    peak = Math.max(active, peak);
    try {
      if (path !== "/api/admin/bi/v1/metrics") {
        if (path === RETENTION_PLUS_API) return { data: [] };
        return emptyLegacy();
      }
      if (scope === "overall") {
        await new Promise(resolve => setTimeout(resolve, 25));
        throw new UpstreamError("UPSTREAM_INVALID_REQUEST", "upstream calculation failed", 422,
          { origin: "business", upstreamHttpStatus: 200, upstreamBusinessCode: 500 });
      }
      if (scope === "new") {
        startedNewUsers.resolve();
        return stallNewUsers ? await heldNewUsers.promise : emptyMetrics();
      }
      if (scope === "monthly") {
        const { businessDate: _unused, ...row } = payload("M018").msg.rows[0];
        return envelope([row]);
      }
      if (scope === "retentionDay") return envelope(BI_V1_RETENTION_DAYS.flatMap(retentionDay =>
        rows("M115", { pid: "PH", retentionDay }).map(row => ({ ...row, denominator: 10, ruleVersion: `retention-${retentionDay.toLowerCase()}-v1` }))
      ));
      if (scope === "android" || scope === "ios") return envelope(rows("M016", { pid: "PH", ...filters }));
      if (scope === "internal_channel") return envelope(rows("M008", { pid: "PH", ...filters }));
      return emptyMetrics();
    } finally {
      active--;
    }
  } };
  const read = new DailyDashboardService(client, () => new Date("2026-11-07T09:00:00Z"), undefined, {
    sourceReadTimeoutMs: 1000, operatingSnapshotReadTimeoutMs: 500
  }).execute(query);
  await Promise.race([startedNewUsers.promise, read]);
  const beforeDeadline = calls.slice();
  const result = await read;
  heldNewUsers.resolve(emptyMetrics());
  const modernBeforeNew = beforeDeadline.filter(call => call.path === "/api/admin/bi/v1/metrics").map(call => call.scope);
  expect(modernBeforeNew[0]).toBe("overall");
  expect(modernBeforeNew.indexOf("new")).toBe(13);
  expect(modernBeforeNew.slice(1, 13).sort()).toEqual([
    "ali_pay", "android", "android_old", "internal_channel", "ios", "ios_old", "monthly", "natural",
    "old", "retentionDay", "usdt_pay", "wx_pay"
  ]);
  expect(beforeDeadline.filter(call => call.scope === "monthly")).toEqual([{
    path: "/api/admin/bi/v1/metrics", scope: "monthly", startDate: "2026-11-01", endDate: "2026-11-07"
  }]);
  for (const [path, count] of [[P_DAY_SUM_API, 1], [RETENTION_PLUS_API, 1], [PAYMENT_RATE_API, 3], [CHANNEL_V2_API, 3]] as const) {
    expect(beforeDeadline.filter(call => call.path === path)).toHaveLength(count);
    expect(calls.filter(call => call.path === path)).toHaveLength(count);
  }
  expect(peak).toBe(1);
  expect(result.data.series.map(series => series.metric.id)).toEqual([...OPERATING_METRIC_IDS]);
  expect(result.data.series.every(series => series.points.map(point => point.date).join() === dates.join())).toBe(true);
  for (const id of ["M016.android", "M016.ios", "M008.internal", "M115.d1", "M115.d3", "M115.d7", "M115.d30", "M018"])
    expect(result.data.series.find(series => series.metric.id === id)!.points.at(-1)).toMatchObject({ state: "available", sourceStatus: "READY", value: 7 });
  expect(point(result, "M016.new")).toMatchObject({ state: stallNewUsers ? "source_failure" : "no_record", value: null });
});
