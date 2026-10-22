import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { DailyDashboardSuccess } from "../../contracts/daily-dashboard";
import { OPERATING_METRIC_IDS, operatingSnapshotDates } from "../../contracts/operating-detail-projection";
import { loadEnv } from "../config/env";
import type { Principal } from "../identity/identity-provider";
import { getEnabledPlatformByPid, platformRegistry, type PlatformSiteId } from "../platforms/registry";
import { BI_V1_EFFECTIVE_PLAY_RULE_VERSION, BI_V1_PLAYBACK_API } from "../upstream/bi-v1.adapter";
import { BI_V1_METRICS_API, type BiV1MetricDataStatus } from "../upstream/bi-v1.metrics-adapter";
import { UpstreamClient } from "../upstream/client";
import { QueryJobsClient, type QueryJobCreateRequest } from "../upstream/query-jobs";
import { DailyDashboardService, dailyDashboardMatchesMapping } from "./daily-dashboard.service";
import { OperatingQueryJobService } from "./operating-query-jobs.service";
import { BiQueryJobService } from "./query-jobs.service";

const businessDate = "2026-10-17";
const dateRange: [string, string] = ["2026-10-10", businessDate];
const generatedAt = "2026-10-22T04:00:00.000Z";
const now = () => new Date(generatedAt);
const selectedDates = operatingSnapshotDates(dateRange);
const platforms = platformRegistry.filter(platform => platform.enabled);
const statuses: BiV1MetricDataStatus[] = ["READY", "PROCESSING", "SOURCE_INCOMPLETE", "NOT_MATURE", "FAILED"];
const ratios = new Set(["M005", "M006", "M007", "M020", "M021", "M022", "M023", "M061", "M064", "M081", "M090", "M099", "M103", "M111", "M114"]);
const siteProfiles = {
  primary: { hostname: "primary.parity.invalid", token: "fixture-primary-token", userName: "fixture-primary-user" },
  secondary: { hostname: "secondary.parity.invalid", token: "fixture-secondary-token", userName: "fixture-secondary-user" }
};
type SourceQuery = NonNullable<QueryJobCreateRequest["queries"][number]["query"]>;
type Read = { site: PlatformSiteId; path: string; method: string; pids: string[]; query?: SourceQuery };
type FixtureRow = {
  metricCode: string; businessDate?: string; dimensions: Record<string, string>; value: number | null;
  numerator: number; denominator: number; unit: string; dataStatus: BiV1MetricDataStatus; metricVersion: string; ruleVersion: string;
  month?: string; cutoffDate?: string; isComplete?: boolean;
};
const shift = (date: string, days: number) => new Date(Date.parse(date) + days * 86_400_000).toISOString().slice(0, 10);
const filterKey = (filters: Record<string, unknown>) => JSON.stringify(Object.entries(filters).sort(([a], [b]) => a.localeCompare(b)));
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

/** One deterministic business fixture serves both HTTP transports; no global fetch or backend data is used. */
function sourceRows(query: SourceQuery): FixtureRow[] {
  const filters = JSON.parse(query.dimensionFilters ?? "{}") as Record<string, string>;
  const codes = query.metricCodes!.split(",");
  const playback = query.dimensions === "videoType";
  const dates = query.granularity === "summary" ? [""]
    : Array.from({ length: (Date.parse(query.endDate) - Date.parse(query.startDate)) / 86_400_000 }, (_, index) => shift(query.startDate, index));
  return query.pid.split(",").flatMap(pid => dates.flatMap(date => codes.flatMap(code => {
    const platformIndex = platforms.findIndex(platform => platform.pid === pid);
    const seed = platformIndex + (date ? Number(date.slice(-2)) : 0) + Number(code.slice(1)) + Object.values(filters).join("").length;
    const dataStatus: BiV1MetricDataStatus = ["M016", "M018", "M058", "M059", "M102", "M006"].includes(code) || playback ? "READY" : statuses[seed % statuses.length];
    const zero = code === "M059" && filters.userCohort === "new" || code === "M058" && platformIndex === 0 && !Object.keys(filters).length;
    const ratio = ratios.has(code) || code === "M110";
    const numerator = zero || code === "M006" ? 0 : code === "M058" ? 12.34 + platformIndex
      : code === "M102" ? 64 + platformIndex : 2 + platformIndex;
    const denominator = code === "M006" ? 0 : ratio ? 100 : 0;
    const base: FixtureRow = { metricCode: code, ...(date ? { businessDate: date } : {}), dimensions: { pid, ...filters },
      value: dataStatus !== "READY" ? null : ratio ? denominator === 0 ? null : numerator / denominator : numerator,
      numerator, denominator, unit: code === "M058" ? "currency" : code === "M102" ? "seconds" : code === "M110" ? "count_per_user" : ratio ? "ratio" : "count",
      dataStatus, metricVersion: "bi-v1", ruleVersion: code === "M058" ? "paid-order-value-rmb-v2"
        : code === "M102" ? "foreground-watch-duration-v1" : "production-parity-fixture-v1" };
    if (code === "M018") return [{ ...base, month: query.startDate.slice(0, 7), cutoffDate: shift(query.endDate, -1), isComplete: query.startDate.slice(0, 7) < generatedAt.slice(0, 7) }];
    if (!playback) return [base];
    return ["short_video", "long_video"].map((videoType, index) => {
      const effective = 2 + index + platformIndex, starts = effective + 3;
      const numerator = code === "M097" ? starts : effective, denominator = code === "M036" ? starts : 0;
      return { ...base, dimensions: { pid, videoType }, value: code === "M036" ? numerator / denominator : numerator,
        numerator, denominator, unit: code === "M036" ? "ratio" : "count", ruleVersion: BI_V1_EFFECTIVE_PLAY_RULE_VERSION };
    });
  })));
}

function fixture() {
  const reads: Read[] = [], emittedRows: FixtureRow[] = [];
  const jobs = new Map<PlatformSiteId, { request: QueryJobCreateRequest; taskId: string; polls: number }>();
  const env = loadEnv({ NODE_ENV: "test", UPSTREAM_API_BASE_URL: `https://${siteProfiles.primary.hostname}`,
    UPSTREAM_USER_NAME: siteProfiles.primary.userName, UPSTREAM_X_TOKEN: siteProfiles.primary.token,
    UPSTREAM_SECONDARY_API_BASE_URL: `https://${siteProfiles.secondary.hostname}`,
    UPSTREAM_SECONDARY_USER_NAME: siteProfiles.secondary.userName, UPSTREAM_SECONDARY_X_TOKEN: siteProfiles.secondary.token,
    UPSTREAM_CREDENTIALS_FILE: `/private/tmp/ypbi-production-parity-absent-${randomUUID()}.json` });
  const upstream = new UpstreamClient(env, async (input, init) => {
    const url = new URL(String(input)), headers = new Headers(init?.headers);
    const site = (Object.keys(siteProfiles) as PlatformSiteId[]).find(site => siteProfiles[site].hostname === url.hostname);
    if (!site) throw new Error("Unexpected in-memory transport origin");
    expect(headers.get("x-token")).toBe(siteProfiles[site].token);
    expect(headers.get("name")).toBe(siteProfiles[site].userName);
    const params = Object.fromEntries(url.searchParams), method = init?.method ?? "GET";
    const read: Read = { site, path: url.pathname, method, pids: params.pid?.split(",") ?? [] }; reads.push(read);
    const checkPids = (pids: string[]) => {
      expect(pids.length).toBeGreaterThan(0);
      expect(pids.every(pid => getEnabledPlatformByPid(pid)?.siteId === site)).toBe(true);
    };
    const unit = (query: SourceQuery) => {
      const rows = sourceRows(query); emittedRows.push(...rows);
      return { generatedAt, metricVersion: "bi-v1", watermark: null, rows };
    };
    if (url.pathname.startsWith("/api/admin/bi/v1/queryJobs")) {
      if (method === "POST") {
        const request = JSON.parse(String(init!.body)) as QueryJobCreateRequest;
        for (const { query } of request.queries) checkPids(query.pid.split(","));
        read.pids = request.queries[0].query.pid.split(",");
        jobs.set(site, { request, taskId: `${site}_parity_task`, polls: 0 });
        return Response.json({ code: 200, msg: { taskId: `${site}_parity_task`, reused: false } });
      }
      const job = jobs.get(site);
      if (!job || !url.pathname.includes(job.taskId)) throw new Error("Unbound in-memory query task");
      const result = url.pathname.endsWith("/result");
      read.pids = job.request.queries[0].query.pid.split(",");
      const status = result || job.polls++ > 0 ? "SUCCEEDED" : "RUNNING";
      return Response.json({ code: 200, msg: { taskId: job.taskId, status, totalUnits: job.request.queries.length,
        completedUnits: status === "SUCCEEDED" ? job.request.queries.length : 0,
        ...(result ? { results: job.request.queries.map(({ query }) => unit(query)) } : {}) } });
    }
    checkPids(read.pids);
    if ([BI_V1_METRICS_API, BI_V1_PLAYBACK_API].includes(url.pathname)) {
      const query = { ...params, includeIncomplete: params.includeIncomplete === "true" } as SourceQuery;
      read.query = query;
      return Response.json({ code: 200, msg: unit(query) });
    }
    if (url.pathname.endsWith("pDaySum") || url.pathname.includes("channelStatByTypeV2") || url.pathname.endsWith("getRechargeSucRate")) {
      return Response.json({ code: 200, msg: { pageData: [], totalData: [], totalCount: 0 } });
    }
    if (url.pathname.includes("reletionsStatPlus")) return Response.json({ code: 200, data: [] });
    if (url.pathname.endsWith("pRealDayLine")) return Response.json({ code: 200, msg: [] });
    throw new Error(`Unexpected in-memory source path: ${url.pathname}`);
  });
  const daily = new DailyDashboardService(upstream, now);
  const service = new OperatingQueryJobService(new BiQueryJobService(new QueryJobsClient(upstream), () => now().getTime()), daily,
    () => now().getTime(), { productionEnabled: true });
  return { reads, emittedRows, jobs, daily, service };
}

describe("正式经营全平台同步／异步同源差分", () => {
  test("两站20平台×93列×三期逐点同值、状态、单位和输入一致，覆盖混合状态及真实零", async () => {
    const sync = fixture(), async = fixture();
    try {
      expect(platforms).toHaveLength(20);
      const groups = (["primary", "secondary"] as const).map(site => platforms.filter(platform => platform.siteId === site).map(platform => platform.pid));
      expect(groups.map(group => group.length)).toEqual([9, 11]);
      const principal: Principal = { subjectId: "production-parity-reader", securityVersion: "v1", roles: ["viewer"], permissions: ["bi:read"], pidScope: platforms.map(platform => platform.pid) };
      const baseline = await Promise.all(platforms.map(platform => sync.daily.execute({ boardId: "5.2", pid: platform.pid, dateRange, projection: "operating_snapshot" })));
      const handles = await Promise.all(groups.map(pids => async.service.create(principal, { kind: "operating-snapshot", pids, date: businessDate })));
      const projected: DailyDashboardSuccess[] = [];
      for (const created of handles) {
        expect((await async.service.status(principal, created.data.handle)).data.status).toBe("RUNNING");
        expect((await async.service.status(principal, created.data.handle)).data.status).toBe("SUCCEEDED");
        let response = await async.service.result(principal, created.data.handle);
        for (let attempt = 0; attempt < 8 && response.data.phase !== "complete"; attempt++) {
          await flush(); response = await async.service.result(principal, created.data.handle);
        }
        expect(response.data.phase).toBe("complete");
        projected.push(...response.data.dashboards!);
      }
      expect(projected).toHaveLength(platforms.length);
      const observations = { points: 0, nonzero: 0, zero: 0, null: 0, zeroDenominator: 0, statuses: new Set<string>(), units: new Set<string>() };
      for (const expected of baseline) {
        const actual = projected.find(result => result.data.query.pid === expected.data.query.pid)!;
        expect(actual).toBeDefined();
        expect(dailyDashboardMatchesMapping(actual)).toBe(true);
        expect(actual.data.query).toEqual(expected.data.query);
        expect(actual.data.sourceApiIds).toEqual(expected.data.sourceApiIds);
        const { queryId: _actualQueryId, fetchedAt: _actualFetchedAt, ...actualData } = actual.data;
        const { queryId: _expectedQueryId, fetchedAt: _expectedFetchedAt, ...expectedData } = expected.data;
        expect(actualData).toEqual(expectedData);
        expect(actual.data.series.map(series => series.metric.id)).toEqual([...OPERATING_METRIC_IDS]);
        const platformIndex = platforms.findIndex(platform => platform.pid === actual.data.query.pid);
        const duration = actual.data.series.find(series => series.metric.id === "M102")!;
        expect(duration.metric.inputs[0].unit).toBe("秒");
        expect(duration.points.every(point => point.value === (64 + platformIndex) / 3600 && point.inputs[0].value === 64 + platformIndex)).toBe(true);
        expect(actual.data.series.find(series => series.metric.id === "M058")!.points.every(point => point.value === (platformIndex === 0 ? 0 : 12.34 + platformIndex))).toBe(true);
        let platformNonzero = 0;
        for (const [index, series] of actual.data.series.entries()) {
          expect(series.metric).toEqual(expected.data.series[index].metric);
          expect(series.points.map(point => point.date)).toEqual(selectedDates);
          observations.units.add(series.metric.unit);
          for (const [pointIndex, point] of series.points.entries()) {
            expect(point).toEqual(expected.data.series[index].points[pointIndex]);
            observations.points++;
            if (point.value !== null && point.value > 0) { observations.nonzero++; platformNonzero++; }
            if (point.value === 0) observations.zero++;
            if (point.value === null) observations.null++;
            if (point.state === "zero_denominator") observations.zeroDenominator++;
            if (point.sourceStatus) observations.statuses.add(point.sourceStatus);
          }
        }
        expect(platformNonzero).toBeGreaterThan(0);
      }
      expect(observations.points).toBe(20 * 93 * 3);
      expect([...observations.statuses].sort()).toEqual([...statuses].sort());
      expect(observations.zero).toBeGreaterThan(0); expect(observations.null).toBeGreaterThan(0);
      expect(observations.zeroDenominator).toBeGreaterThan(0);
      expect([...observations.units]).toEqual(expect.arrayContaining(["元", "小时", "%", "人"]));
      for (const f of [sync, async]) {
        expect(f.emittedRows.some(row => row.metricCode === "M018" && row.month === "2026-10" && row.cutoffDate === "2026-10-21" && row.isComplete === false)).toBe(true);
        expect(new Set(f.emittedRows.filter(row => row.dimensions.videoType).map(row => row.dimensions.videoType))).toEqual(new Set(["short_video", "long_video"]));
      }
      const expectedFilters = [{}, { userCohort: "new" }, { userCohort: "old" }, { clientPlatform: "android" }, { clientPlatform: "ios" },
        { clientPlatform: "android", userCohort: "old" }, { clientPlatform: "ios", userCohort: "old" },
        { paymentMethod: "ali_pay" }, { paymentMethod: "wx_pay" }, { paymentMethod: "usdt_pay" }, { sourceType: "natural" }, { sourceType: "internal_channel" }];
      const modern = sync.reads.filter(read => read.query);
      for (const platform of platforms) expect(new Set(modern.filter(read => read.pids.includes(platform.pid) && read.path === BI_V1_METRICS_API && read.query!.granularity !== "summary")
        .map(read => filterKey(JSON.parse(read.query!.dimensionFilters ?? "{}"))))).toEqual(new Set(expectedFilters.map(filterKey)));
      for (const [index, site] of (["primary", "secondary"] as const).entries()) {
        const task = async.jobs.get(site)!;
        expect(task.request.queries).toHaveLength(14);
        expect(task.request.queries.every(unit => unit.query.pid.split(",").sort().join() === [...groups[index]].sort().join())).toBe(true);
        expect(new Set(task.request.queries.filter(unit => unit.query.granularity === "day" && unit.query.dimensions !== "videoType")
          .map(unit => filterKey(JSON.parse(unit.query.dimensionFilters ?? "{}"))))).toEqual(new Set(expectedFilters.map(filterKey)));
      }
      expect(modern).toHaveLength(20 * 14);
      expect(async.reads.filter(read => read.query)).toHaveLength(0);
      const jobReads = async.reads.filter(read => read.path.startsWith("/api/admin/bi/v1/queryJobs"));
      const counts = { syncModernReads: modern.length, asyncCreate: jobReads.filter(read => read.method === "POST").length,
        asyncPoll: jobReads.filter(read => read.method === "GET" && !read.path.endsWith("/result")).length,
        asyncResult: jobReads.filter(read => read.path.endsWith("/result")).length };
      expect(counts).toMatchObject({ syncModernReads: 280, asyncCreate: 2, asyncPoll: 4 });
      expect(counts.asyncResult).toBeGreaterThanOrEqual(2);
      console.info("production-parity in-memory request counts; no live latency claim", JSON.stringify({ ...counts,
        points: observations.points, nonzero: observations.nonzero, zero: observations.zero, null: observations.null, zeroDenominator: observations.zeroDenominator }));
    } finally { sync.service.close(); async.service.close(); }
  });
});
