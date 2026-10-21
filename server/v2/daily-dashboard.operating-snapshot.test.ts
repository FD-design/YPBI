import { describe, expect, test } from "bun:test";
import { DAILY_STATISTICS_VERSION, dailyDashboardMatchesQuery, dailyDashboardSuccessSchema, type DailyDashboardQuery, type DailyDashboardV2Success } from "../../contracts/daily-dashboard";
import { OPERATING_METRIC_IDS, OPERATING_SNAPSHOT_STATISTICS_REASON, operatingSnapshotDates } from "../../contracts/operating-detail-projection";
import { BI_V1_EFFECTIVE_PLAY_RULE_VERSION, BI_V1_PLAYBACK_API } from "../upstream/bi-v1.adapter";
import { BI_V1_METRICS_API } from "../upstream/bi-v1.metrics-adapter";
import { UpstreamError } from "../upstream/client";
import { CHANNEL_V2_API, DailyDashboardService, dailyDashboardMatchesMapping, PAYMENT_RATE_API } from "./daily-dashboard.service";
import { createOperatingQueryPlan, normalizeOperatingQueryResults } from "./operating-query-plan";

const query: DailyDashboardQuery = { boardId: "5.2", pid: "PH", dateRange: ["2026-10-05", "2026-10-12"] };
const snapshotQuery: DailyDashboardQuery = { ...query, projection: "operating_snapshot" };
const now = () => new Date("2026-10-14T00:00:00Z");
const shift = (date: string, days: number) => new Date(Date.parse(date) + days * 86_400_000).toISOString().slice(0, 10);
const dates = Array.from({ length: 8 }, (_, index) => shift(query.dateRange[0], index));
type Mode = "ready" | "legacy" | "processing" | "incomplete" | "missing_scope" | "scope_conflict" | "wrong_rule" | "network_failure";
type Read = { path: string; params: Record<string, string> };
const ratios = new Set(["M005", "M006", "M007", "M020", "M021", "M022", "M023", "M036", "M061", "M064", "M081", "M090", "M099", "M103", "M111", "M114"]);

function fixture(mode: Mode) {
  const reads: Read[] = [];
  const client = { get: async (path: string, params: Record<string, string>) => {
    reads.push({ path, params });
    if (mode === "network_failure") throw new UpstreamError("UPSTREAM_NETWORK_ERROR", "fixture source unavailable", 502);
    const envelope = (rows: unknown[]) => ({ code: 200, msg: { metricVersion: "bi-v1", generatedAt: now().toISOString(), watermark: null, rows } });
    if (path === BI_V1_METRICS_API || path === BI_V1_PLAYBACK_API) {
      if (mode === "legacy") return envelope([]);
      const filters = JSON.parse(params.dimensionFilters ?? "{}") as Record<string, string>;
      if (params.granularity === "summary") return envelope([{ metricCode: "M018", dimensions: { pid: query.pid }, value: 42, numerator: 42, denominator: 0,
        unit: "count", dataStatus: "READY", metricVersion: "bi-v1", ruleVersion: "monthly-fixture-v1" }]);
      return envelope(dates.flatMap(date => params.metricCodes.split(",").flatMap(code => {
        if (mode === "missing_scope" && filters.clientPlatform === "ios" && date === query.dateRange[1]) return [];
        const ratio = ratios.has(code) || code === "M110", zero = date === query.dateRange[0];
        const value = zero ? 0 : ratio ? 0.5 : code === "M058" ? 12.34 : code === "M102" ? 7200 : 2;
        const row = { metricCode: code, businessDate: date, dimensions: { pid: query.pid, ...filters, ...(path === BI_V1_PLAYBACK_API ? { videoType: "short_video" } : {}) },
          value: value as number | null, numerator: ratio ? zero ? 0 : 1 : value, denominator: ratio ? 2 : 0,
          unit: code === "M058" ? "currency" : code === "M102" ? "seconds" : code === "M110" ? "count_per_user" : ratio ? "ratio" : "count",
          dataStatus: "READY", metricVersion: "bi-v1", ruleVersion: code === "M058" ? "paid-order-value-rmb-v2" : code === "M102" ? "foreground-watch-duration-v1"
            : ["M034", "M036"].includes(code) ? BI_V1_EFFECTIVE_PLAY_RULE_VERSION : "snapshot-fixture-v1" };
        if (path === BI_V1_PLAYBACK_API && code === "M034") Object.assign(row, { value: zero ? 0 : 1, numerator: zero ? 0 : 1 });
        if (path === BI_V1_PLAYBACK_API && code === "M036") Object.assign(row, { value: zero ? null : 0.5, denominator: zero ? 0 : 2 });
        if (mode === "processing" && ["M016", "M006"].includes(code)) Object.assign(row, { dataStatus: "PROCESSING", value: null, numerator: 999 });
        if (mode === "processing" && code === "M007") Object.assign(row, { dataStatus: "FAILED", value: null, numerator: 999 });
        if (mode === "incomplete" && ["M020", "M081", "M058"].includes(code)) Object.assign(row, { dataStatus: "SOURCE_INCOMPLETE", value: null,
          numerator: ratio ? 1 : 999, denominator: ratio ? 2 : 0 });
        if (mode === "scope_conflict" && filters.userCohort === "old" && filters.clientPlatform === "android") row.dimensions.pid = "OTHER";
        if (mode === "wrong_rule" && ["M058", "M102", "M034", "M036"].includes(code)) row.ruleVersion = "older-rule-fixture";
        return [row];
      })));
    }
    if (path.endsWith("pDaySum")) return { msg: { totalCount: dates.length, pageData: dates.map(sumDate => ({ pid: query.pid, sumDate,
      loginUserCount: 100, registerUserCount: 10, watchUserCount: 60, androidLoginUserCount: 70, iosLoginUserCount: 30,
      oldUserLoginCount: 50, oldUserLoginUserCount: 50, androidNewUserCount: 10, iosNewUserCount: 0,
      androidWatchUserCount: 40, iosWatchUserCount: 20, newUserWatchUserCount: 30, adsCount: 20, adsClickedNewCount: 5 })) } };
    if (path.includes("reletionsStatPlus")) return { data: dates.map(sumDate => ({ pid: query.pid, sumDate, registerCount: 10,
      ...Object.fromEntries([1, 3, 7, 30].map(day => ["afterFirstData" + day, { date: shift(sumDate, day), loginCnt: sumDate === dates[0] ? 0 : 5 }])) })) };
    if (path === PAYMENT_RATE_API) return { msg: { pid: query.pid, sumDate: params.startTime.slice(0, 10), pageData: [], totalAllCount: 4, totalSurCount: 2 } };
    if (path === CHANNEL_V2_API) return { msg: { pageData: [], totalData: [{ pid: query.pid, sumDate: params.sumDateBegin.slice(0, 10),
      oldUserWatchCount: 30, oldUserWatchUserCount: 30, oldUserLoginCount: 50, oldUserLoginUserCount: 50,
      totalDownCountNoDedup: 10, visiCountNoDedup: 20, registerUserCount: 10, totalDownCountByIp: 5, ipStatTotalCount: 10,
      vipChargeAmt: 12.34, goldChargeAmt: 0, newUserVipChargeAmt: 0, newUserGoldChargeAmt: 0 }] } };
    if (path.endsWith("pRealDayLine")) return { msg: [] };
    throw new Error("Unexpected snapshot fixture source");
  } };
  return { reads, client };
}

const point = (result: DailyDashboardV2Success, id: string, date = query.dateRange[1]) => result.data.series.find(series => series.metric.id === id)!.points.find(point => point.date === date)!;

function assertProjection(defaultResult: DailyDashboardV2Success, snapshot: DailyDashboardV2Success) {
  const selected = operatingSnapshotDates(query.dateRange);
  expect(snapshot.data.series.map(series => series.metric.id)).toEqual([...OPERATING_METRIC_IDS]);
  expect(defaultResult.data.series).toHaveLength(121);
  expect(defaultResult.data.series.every(series => series.points.length === 8)).toBe(true);
  for (const series of snapshot.data.series) {
    const baseline = defaultResult.data.series.find(candidate => candidate.metric.id === series.metric.id)!;
    expect(series.metric).toEqual(baseline.metric);
    expect(series.points).toEqual(baseline.points.filter(point => selected.includes(point.date)));
    expect(series.points.map(point => point.date)).toEqual(selected);
    expect(series.periodStatistics).toEqual({ aggregationVersion: DAILY_STATISTICS_VERSION, dateRange: query.dateRange, dayCount: 8,
      state: "unsupported", values: [], reason: OPERATING_SNAPSHOT_STATISTICS_REASON });
  }
  for (const key of ["schemaVersion", "fetchedAt", "timezone", "validationStatus", "completeness", "watermark"] as const)
    expect(snapshot.data[key]).toEqual(defaultResult.data[key]);
  expect(dailyDashboardSuccessSchema.safeParse(snapshot).success).toBe(true);
  expect(dailyDashboardMatchesQuery(snapshot, snapshotQuery, OPERATING_METRIC_IDS)).toBe(true);
  expect(dailyDashboardMatchesMapping(snapshot)).toBe(true);
  expect(dailyDashboardMatchesMapping(defaultResult)).toBe(true);
}

describe("operating snapshot service", () => {
  for (const mode of ["ready", "legacy", "processing", "incomplete", "missing_scope", "wrong_rule"] as const)
    test(`async ${mode} shares all 93 values, states, inputs and statistics with synchronous projection`, async () => {
      const sync = fixture(mode), asyncLegacy = fixture(mode), asyncModern = fixture(mode);
      const plan = createOperatingQueryPlan([query.pid], query.dateRange, "2026-10-14");
      const units = await Promise.all(plan.request.queries.map(async ({ query: unit }, index) => {
        const params = Object.fromEntries(Object.entries(unit).map(([key, value]) => [key, String(value)]));
        const payload = await asyncModern.client.get(plan.units[index].kind === "playback" ? BI_V1_PLAYBACK_API : BI_V1_METRICS_API, params);
        const message = payload.msg as { rows: unknown[]; generatedAt: string };
        return { rows: message.rows, generatedAt: message.generatedAt };
      }));
      const source = normalizeOperatingQueryResults(plan, units).get(query.pid)!;
      const [baseline, result] = await Promise.all([
        new DailyDashboardService(sync.client, now).execute(snapshotQuery),
        new DailyDashboardService(asyncLegacy.client, now).executeOperating(snapshotQuery, Promise.resolve(source))
      ]);
      expect(result.data.series).toEqual(baseline.data.series);
      expect(result.data.series).toHaveLength(93);
      expect(result.data.series.every(series => series.points.map(point => point.date).join() === operatingSnapshotDates(query.dateRange).join())).toBe(true);
      expect(result.data.watermark).toBeNull();
      expect(result.data.completeness).toBe("unknown");
      expect(dailyDashboardMatchesMapping(result)).toBe(true);
      expect(asyncLegacy.reads.some(read => [BI_V1_METRICS_API, BI_V1_PLAYBACK_API].includes(read.path))).toBe(false);
    });

  test("legacy reads begin while modern job is pending, and job failure rejects without synchronous fallback", async () => {
    const base = fixture("ready");
    let rejectSource!: (reason: unknown) => void;
    const pending = new Promise<never>((_, reject) => { rejectSource = reject; });
    const result = new DailyDashboardService(base.client, now).executeOperating(snapshotQuery, pending);
    await Promise.resolve();
    expect(base.reads.some(read => read.path.endsWith("pDaySum"))).toBe(true);
    expect(base.reads.some(read => [BI_V1_METRICS_API, BI_V1_PLAYBACK_API].includes(read.path))).toBe(false);
    rejectSource(new UpstreamError("QUERY_JOB_FAILED", "任务失败", 502));
    await expect(result).rejects.toMatchObject({ code: "QUERY_JOB_FAILED" });
  });

  test("pending modern source can be cancelled without waiting for job completion", async () => {
    const controller = new AbortController();
    const result = new DailyDashboardService(fixture("ready").client, now)
      .executeOperating(snapshotQuery, new Promise(() => {}), controller.signal);
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT" });
  });

  test("server projection rejects an incompatible board, PID or range binding", async () => {
    const base = fixture("ready"), service = new DailyDashboardService(base.client, now);
    const source = { pid: "PH", dateRange: query.dateRange, metricDays: [], playbackDays: [], monthlyDays: [] };
    await expect(service.executeOperating(query, Promise.resolve(source))).rejects.toMatchObject({ code: "INVALID_DAILY_READING_QUERY" });
    expect(base.reads).toHaveLength(0);
    await expect(service.executeOperating(snapshotQuery, Promise.resolve({ ...source, pid: "FBI" })))
      .rejects.toMatchObject({ code: "BI_V1_SCOPE_CONFLICT" });
    await expect(service.executeOperating(snapshotQuery, Promise.resolve({ ...source, dateRange: ["2026-10-06", "2026-10-13"] })))
      .rejects.toMatchObject({ code: "BI_V1_SCOPE_CONFLICT" });
  });

  for (const mode of ["ready", "legacy", "processing", "incomplete", "missing_scope", "scope_conflict", "wrong_rule", "network_failure"] as const)
    test(`${mode} preserves the existing 93 projections at all three observation dates`, async () => {
      const full = fixture(mode), sparse = fixture(mode);
      const defaultResult = await new DailyDashboardService(full.client, now).execute(query);
      const snapshot = await new DailyDashboardService(sparse.client, now).execute(snapshotQuery);
      assertProjection(defaultResult, snapshot);
      expect(full.reads).toHaveLength(44);
      expect(sparse.reads).toHaveLength(22);
      expect(sparse.reads.filter(read => read.path === BI_V1_METRICS_API && read.params.granularity === "day")).toHaveLength(12);
      expect(sparse.reads.some(read => read.path.endsWith("pRealDayLine"))).toBe(false);
      for (const path of [PAYMENT_RATE_API, CHANNEL_V2_API]) {
        const selected = sparse.reads.filter(read => read.path === path).map(read => (read.params.startTime ?? read.params.sumDateBegin).slice(0, 10));
        expect(selected).toEqual(operatingSnapshotDates(query.dateRange));
      }
      expect(sparse.reads.filter(read => [BI_V1_METRICS_API, BI_V1_PLAYBACK_API].includes(read.path) && read.params.granularity === "day")
        .every(read => read.params.startDate === dates[0] && read.params.endDate === shift(dates.at(-1)!, 1))).toBe(true);
      if (mode === "ready") {
        expect(point(snapshot, "M058", dates[0])).toMatchObject({ state: "available", value: 0, sourceStatus: "READY" });
        expect(snapshot.data.series.find(series => series.metric.id === "M058")!.metric.unit).toBe("元");
        expect(snapshot.data.series.find(series => series.metric.id === "M067")!.metric.unit).toBe("元/人");
      }
      if (mode === "processing") {
        expect(point(snapshot, "M016")).toMatchObject({ state: "no_value", value: null, sourceStatus: "PROCESSING" });
        for (const id of ["M006", "M007"]) expect(point(snapshot, id)).toMatchObject({ state: "available", value: 1, sourceStatus: "READY" });
      }
      if (mode === "incomplete") {
        expect(point(snapshot, "M020.android")).toMatchObject({ state: "no_value", value: null, sourceStatus: "SOURCE_INCOMPLETE", inputs: [{ value: 1 }, { value: 2 }] });
        expect(point(snapshot, "M081.new")).toMatchObject({ state: "no_value", value: null, sourceStatus: "SOURCE_INCOMPLETE" });
      }
      if (mode === "legacy") {
        expect(point(snapshot, "M020")).toMatchObject({ state: "available", value: 0.5 });
        expect(point(snapshot, "M021")).toMatchObject({ state: "immature", value: null });
        expect(point(snapshot, "M022", dates[0])).toMatchObject({ state: "available", value: 0 });
      }
      if (mode === "missing_scope") expect(point(snapshot, "M020.ios")).toMatchObject({ state: "no_record", value: null });
      if (mode === "scope_conflict") expect(point(snapshot, "M016.androidOld")).toMatchObject({ state: "source_failure", value: null });
      if (mode === "wrong_rule") for (const id of ["M058", "M102", "M034", "M036"]) expect(point(snapshot, id)).toMatchObject({ state: "invalid_value", value: null });
    });

  test("snapshot mapping rejects extra series, extra days, missing statistics, and disguised projections", async () => {
    const snapshot = await new DailyDashboardService(fixture("ready").client, now).execute(snapshotQuery);
    const extraSeries = structuredClone(snapshot);
    extraSeries.data.series.push(structuredClone(extraSeries.data.series[0]));
    expect(dailyDashboardMatchesMapping(extraSeries)).toBe(false);
    const extraDay = structuredClone(snapshot);
    extraDay.data.series[0].points.splice(1, 0, { ...extraDay.data.series[0].points[0], date: "2026-10-06" });
    expect(dailyDashboardMatchesMapping(extraDay)).toBe(false);
    const period = structuredClone(snapshot);
    period.data.series[0].periodStatistics = { ...period.data.series[0].periodStatistics, state: "available", values: [{ kind: "period_sum", value: 9 }], reason: null };
    expect(dailyDashboardMatchesMapping(period)).toBe(false);
    const missingPeriod = structuredClone(snapshot);
    Reflect.deleteProperty(missingPeriod.data.series[0], "periodStatistics");
    expect(dailyDashboardMatchesMapping(missingPeriod)).toBe(false);
    const defaultProjection = structuredClone(snapshot);
    Reflect.deleteProperty(defaultProjection.data.query, "projection");
    expect(dailyDashboardMatchesMapping(defaultProjection)).toBe(false);
    const invalidProjection = await new DailyDashboardService(fixture("ready").client, now).execute(query);
    Reflect.set(invalidProjection.data.query, "projection", "invalid_projection");
    expect(dailyDashboardMatchesMapping(invalidProjection)).toBe(false);
  });

  test("direct service callers cannot start reads with an invalid snapshot projection", async () => {
    const source = fixture("ready");
    for (const invalid of [
      { ...snapshotQuery, boardId: "5.8" },
      { ...snapshotQuery, dateRange: ["2026-10-06", "2026-10-12"] },
      { ...query, projection: "invalid_projection" }
    ]) await expect(new DailyDashboardService(source.client, now).execute(invalid as DailyDashboardQuery)).rejects.toMatchObject({ code: "INVALID_DAILY_READING_QUERY", statusCode: 400 });
    expect(source.reads).toHaveLength(0);
  });

  test("a stalled channel preserves the existing source budget and every snapshot observation", async () => {
    const base = fixture("incomplete");
    const attempted: string[] = [];
    const snapshot = await new DailyDashboardService({ get: async (path, params) => {
      if (path !== CHANNEL_V2_API) return base.client.get(path, params);
      attempted.push(params.sumDateBegin.slice(0, 10));
      return new Promise(() => {});
    } }, now, undefined, { sourceReadTimeoutMs: 100 }).execute(snapshotQuery);
    expect(attempted).toEqual(operatingSnapshotDates(query.dateRange));
    expect(point(snapshot, "M016")).toMatchObject({ state: "available", value: 2, sourceStatus: "READY" });
    expect(point(snapshot, "M081.new")).toMatchObject({ state: "no_value", value: null, sourceStatus: "SOURCE_INCOMPLETE" });
    expect(snapshot.data.series.every(series => series.points.length === 3)).toBe(true);
    expect(dailyDashboardMatchesMapping(snapshot)).toBe(true);
  });
});
