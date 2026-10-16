import { describe, expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import { dailyDashboardSuccessSchema, type DailyDashboardQuery, type DailyDashboardSuccess } from "../../contracts/daily-dashboard";
import { OPERATING_METRIC_IDS, operatingSnapshotDates } from "../../contracts/operating-detail-projection";
import { OPERATING_EVIDENCE_BOUNDARY, OPERATING_EVIDENCE_VERSION, operatingEvidenceQuerySchema, type OperatingEvidenceQuery } from "../../contracts/operating-evidence";
import { BI_V1_EFFECTIVE_PLAY_RULE_VERSION, BI_V1_PLAYBACK_API } from "../upstream/bi-v1.adapter";
import { BI_V1_METRICS_API } from "../upstream/bi-v1.metrics-adapter";
import { UpstreamError } from "../upstream/client";
import { CHANNEL_V2_API, DailyDashboardService, PAYMENT_RATE_API } from "./daily-dashboard.service";
import type { OperatingEvidenceBusinessRow } from "./operating-evidence-collector";
import { readOperatingEvidence } from "./operating-evidence.service";

const now = () => new Date("2026-10-15T00:00:00Z");
const input: OperatingEvidenceQuery = { pid: "PH", date: "2026-10-12", view: "snapshot", environment: "production" };
const shift = (date: string, days: number) => new Date(Date.parse(date) + days * 86_400_000).toISOString().slice(0, 10);
const options = (signal = new AbortController().signal) => ({ sourceReadTimeoutMs: 1_000, signal, now });
const queryFor = (request: OperatingEvidenceQuery): DailyDashboardQuery => request.view === "snapshot"
  ? { boardId: "5.2", pid: request.pid, dateRange: [shift(request.date, -7), request.date], projection: "operating_snapshot" }
  : { boardId: "5.2", pid: request.pid, dateRange: [request.date, request.date] };
const normalize = (result: DailyDashboardSuccess) => ({ ...result, data: { ...result.data, queryId: "fixed-query-id" } });
const series = (result: DailyDashboardSuccess, id: string) => result.data.series.find(candidate => candidate.metric.id === id)!;
const isMutableTree = (value: unknown): boolean => value === null || typeof value !== "object"
  || !Object.isFrozen(value) && Object.values(value).every(isMutableTree);
const ratios = new Set(["M005", "M006", "M007", "M020", "M021", "M022", "M023", "M036", "M061", "M064", "M081", "M090", "M099", "M103", "M111", "M114"]);
type Mode = "ready" | "processing" | "range_processing" | "incomplete" | "wrong_rule" | "missing_scope" | "scope_conflict" | "legacy" | "network_failure";
type Read = { path: string; params: Record<string, string>; inboundToken: string | undefined; signal: AbortSignal | undefined };
type MetricRow = { metricCode: string; businessDate?: string; dimensions: Record<string, string>; value: number | null;
  numerator: number; denominator: number; unit: string; dataStatus: string; metricVersion: string; ruleVersion: string };

function fixture(request: OperatingEvidenceQuery, mode: Mode = "ready", held = false) {
  const query = queryFor(request), reads: Read[] = [], payloads: { value: unknown; before: string }[] = [], releases: (() => void)[] = [];
  const dates = Array.from({ length: request.view === "snapshot" ? 8 : 1 }, (_, index) => shift(query.dateRange[0], index));
  const build = (path: string, params: Record<string, string>): unknown => {
    const envelope = (rows: unknown[]) => ({ code: 200, msg: { metricVersion: "bi-v1", generatedAt: now().toISOString(), watermark: null, rows } });
    if (path === BI_V1_METRICS_API || path === BI_V1_PLAYBACK_API) {
      if (mode === "legacy") return envelope([]);
      const filters = JSON.parse(params.dimensionFilters ?? "{}") as Record<string, string>;
      if (params.granularity === "summary") return envelope([{ metricCode: "M018", dimensions: { pid: request.pid }, value: 42, numerator: 42,
        denominator: 0, unit: "count", dataStatus: "READY", metricVersion: "bi-v1", ruleVersion: "monthly-fixture-v1" }]);
      return envelope(dates.flatMap(date => params.metricCodes.split(",").flatMap(metricCode => {
        if (mode === "missing_scope" && filters.clientPlatform === "ios" && date === request.date) return [];
        const ratio = ratios.has(metricCode) || metricCode === "M110", zero = date === "2026-10-05";
        const value = zero ? 0 : ratio ? 0.5 : metricCode === "M058" ? 12.34 : metricCode === "M102" ? 7200 : 2;
        const row: MetricRow = { metricCode, businessDate: date, dimensions: { pid: request.pid, ...filters,
          ...(path === BI_V1_PLAYBACK_API ? { videoType: "short_video" } : {}) },
          value, numerator: ratio ? zero ? 0 : 1 : value, denominator: ratio ? 2 : 0,
          unit: metricCode === "M058" ? "currency" : metricCode === "M102" ? "seconds" : metricCode === "M110" ? "count_per_user" : ratio ? "ratio" : "count",
          dataStatus: "READY", metricVersion: "bi-v1", ruleVersion: metricCode === "M058" ? "paid-order-value-rmb-v2"
            : metricCode === "M102" ? "foreground-watch-duration-v1" : ["M034", "M036"].includes(metricCode) ? BI_V1_EFFECTIVE_PLAY_RULE_VERSION : "evidence-fixture-v1" };
        if (path === BI_V1_PLAYBACK_API && metricCode === "M034") Object.assign(row, { value: zero ? 0 : 1, numerator: zero ? 0 : 1 });
        if (path === BI_V1_PLAYBACK_API && metricCode === "M036") Object.assign(row, { value: zero ? null : 0.5, denominator: zero ? 0 : 2 });
        if (["processing", "range_processing"].includes(mode) && metricCode === "M016") {
          Object.assign(row, { dataStatus: "PROCESSING", value: null, numerator: 999 });
          if (mode === "range_processing") {
            if (date !== dates[0]) return [];
            delete row.businessDate;
          }
        }
        if (mode === "incomplete" && ["M020", "M081", "M058"].includes(metricCode)) Object.assign(row, {
          dataStatus: "SOURCE_INCOMPLETE", value: null, numerator: ratio ? 1 : 999, denominator: ratio ? 2 : 0
        });
        if (mode === "wrong_rule" && ["M058", "M102", "M034", "M036"].includes(metricCode)) row.ruleVersion = "older-rule-fixture";
        if (mode === "scope_conflict" && filters.userCohort === "old" && filters.clientPlatform === "android") row.dimensions.pid = "OTHER";
        return [row];
      })));
    }
    if (path.endsWith("pDaySum")) return { msg: { totalCount: dates.length, pageData: dates.map(sumDate => ({ pid: request.pid, sumDate,
      loginUserCount: 100, registerUserCount: 10, watchUserCount: 60, androidLoginUserCount: 70, iosLoginUserCount: 30,
      oldUserLoginCount: 50, oldUserLoginUserCount: 50, androidNewUserCount: 10, iosNewUserCount: 0,
      androidWatchUserCount: 40, iosWatchUserCount: 20, newUserWatchUserCount: 30, adsCount: 20, adsClickedNewCount: 5 })) } };
    if (path.includes("reletionsStatPlus")) return { data: dates.map(sumDate => ({ pid: request.pid, sumDate, registerCount: 10,
      ...Object.fromEntries([1, 3, 7, 30].map(day => ["afterFirstData" + day, { date: shift(sumDate, day), loginCnt: sumDate === dates[0] ? 0 : 5 }])) })) };
    if (path === PAYMENT_RATE_API) return { msg: { pid: request.pid, sumDate: params.startTime.slice(0, 10), pageData: [], totalAllCount: 4, totalSurCount: 2 } };
    if (path === CHANNEL_V2_API) return { msg: { pageData: [], totalData: [{ pid: request.pid, sumDate: params.sumDateBegin.slice(0, 10),
      oldUserWatchCount: 30, oldUserWatchUserCount: 30, oldUserLoginCount: 50, oldUserLoginUserCount: 50,
      totalDownCountNoDedup: 10, visiCountNoDedup: 20, registerUserCount: 10, totalDownCountByIp: 5, ipStatTotalCount: 10,
      vipChargeAmt: 12.34, goldChargeAmt: 0, newUserVipChargeAmt: 0, newUserGoldChargeAmt: 0 }] } };
    if (path.endsWith("pRealDayLine")) return { msg: [] };
    throw new Error(`Unexpected evidence fixture source: ${path}`);
  };
  const client = {
    isProtectedDiagnosticText: (_value: string) => false,
    get: async (path: string, params: Record<string, string>, inboundToken?: string, signal?: AbortSignal): Promise<unknown> => {
      reads.push({ path, params, inboundToken, signal });
      if (held) await new Promise<void>(resolve => releases.push(resolve));
      if (mode === "network_failure") throw new UpstreamError("UPSTREAM_NETWORK_ERROR", "fixture source unavailable", 502);
      const value = build(path, params);
      payloads.push({ value, before: JSON.stringify(value) });
      return value;
    }
  };
  return { client, reads, payloads, release: () => releases.splice(0).forEach(resolve => resolve()) };
}

describe("operating evidence query contract", () => {
  test("requires exactly the four supported fields", () => {
    expect(operatingEvidenceQuerySchema.parse(input)).toEqual(input);
    for (const field of ["pid", "date", "view", "environment"] as const) {
      const missing: Record<string, unknown> = { ...input };
      delete missing[field];
      expect(operatingEvidenceQuerySchema.safeParse(missing).success).toBe(false);
    }
    for (const invalid of [
      { ...input, boardId: "5.2" }, { ...input, date: "2026-02-30" }, { ...input, date: "2026-10-12T00:00:00Z" },
      { ...input, pid: "ph" }, { ...input, pid: "PH/OTHER" }, { ...input, pid: "" }, { ...input, pid: "P".repeat(33) },
      { ...input, view: "full" }, { ...input, environment: "preview" }
    ]) expect(operatingEvidenceQuerySchema.safeParse(invalid).success).toBe(false);
  });
});

describe("operating evidence authoritative service integration", () => {
  for (const view of ["snapshot", "day"] as const) for (const mode of ["ready", "processing", "incomplete", "wrong_rule", "missing_scope", "scope_conflict", "legacy", "network_failure"] as const) {
    test(`${view}/${mode} preserves the independent daily-service projection and source requests`, async () => {
      const request = { ...input, view }, observed = fixture(request, mode), baseline = fixture(request, mode), query = queryFor(request);
      const evidence = await readOperatingEvidence(observed.client, request, options());
      const expected = await new DailyDashboardService(baseline.client, now, undefined, { sourceReadTimeoutMs: 1_000 }).execute(query);
      expect(normalize(evidence.projection)).toEqual(normalize(expected));
      expect(evidence.query).toEqual(query);
      expect(evidence.environment).toBe("production");
      expect(evidence.observedAt).toBe(now().toISOString());
      expect(evidence.schemaVersion).toBe(OPERATING_EVIDENCE_VERSION);
      expect(evidence.boundary).toEqual(OPERATING_EVIDENCE_BOUNDARY);
      expect(dailyDashboardSuccessSchema.safeParse(evidence.projection).success).toBe(true);
      expect(observed.reads.map(({ path, params, inboundToken }) => ({ path, params, inboundToken })))
        .toEqual(baseline.reads.map(({ path, params, inboundToken }) => ({ path, params, inboundToken })));
      if (view === "snapshot") {
        expect(observed.reads).toHaveLength(22);
        expect(evidence.projection.data.series.map(item => item.metric.id)).toEqual([...OPERATING_METRIC_IDS]);
        expect(evidence.projection.data.series.every(item => item.points.map(point => point.date).join() === operatingSnapshotDates(query.dateRange).join())).toBe(true);
      } else {
        expect(evidence.projection.data.series).toHaveLength(121);
        expect(evidence.projection.data.series.every(item => item.points.length === 1 && item.points[0].date === request.date)).toBe(true);
      }
      const recorded = observed.reads.filter(read => [BI_V1_METRICS_API, BI_V1_PLAYBACK_API].includes(read.path));
      expect(evidence.calls).toHaveLength(recorded.length);
      expect(evidence.omittedCallCount).toBe(0);
      for (const [index, call] of evidence.calls.entries()) {
        const actual = recorded[index];
        expect(call.sequence).toBe(index + 1);
        expect(String(call.path)).toBe(actual.path);
        expect(call.params).toMatchObject({ ...actual.params,
          ...(actual.params.dimensionFilters ? { dimensionFilters: JSON.parse(actual.params.dimensionFilters) } : {}) });
        expect(call).toMatchObject({ transportEvidence: "client_business_projection", httpStatus: null, cacheHit: null });
        expect(call.state).toBe(mode === "network_failure" ? "rejected" : "fulfilled");
        expect(call.errorCode).toBe(mode === "network_failure" ? "UPSTREAM_NETWORK_ERROR" : null);
        if (mode === "network_failure") expect(call.response).toBeNull();
        if (actual.params.granularity === "day") {
          expect(call.params.startDate).toBe(query.dateRange[0]);
          expect(call.params.endDate).toBe(shift(request.date, 1));
        }
        expect(actual.params.metricCodes.split(",")).toEqual(actual.params.metricCodes.split(",").sort());
      }
      if (view === "snapshot") {
        expect(evidence.calls).toHaveLength(14);
        expect(evidence.calls.filter(call => call.path === BI_V1_METRICS_API && call.params.granularity === "day")).toHaveLength(12);
      }
      for (const { value, before } of observed.payloads) {
        expect(JSON.stringify(value)).toBe(before);
        expect(isMutableTree(value)).toBe(true);
      }
      if (mode === "ready") {
        expect(series(evidence.projection, "M058").metric.unit).toBe("元");
        expect(series(evidence.projection, "M067").metric.unit).toBe("元/人");
        expect(series(evidence.projection, "M058").points.at(-1)).toMatchObject({ state: "available", value: 12.34, sourceStatus: "READY", inputs: [{ value: 12.34 }] });
      }
      if (mode === "processing") expect(series(evidence.projection, "M016").points.at(-1)).toMatchObject({ state: "no_value", value: null, sourceStatus: "PROCESSING" });
      if (mode === "incomplete") expect(series(evidence.projection, "M020.android").points.at(-1)).toMatchObject({ state: "no_value", value: null, sourceStatus: "SOURCE_INCOMPLETE", inputs: [{ value: 1 }, { value: 2 }] });
      if (mode === "wrong_rule") {
        for (const id of ["M058", "M102", "M034", "M036"]) expect(series(evidence.projection, id).points.at(-1)).toMatchObject({ state: "invalid_value", value: null });
        const raw = evidence.calls.flatMap(call => call.response?.rows ?? [])
          .find(row => row.scope === "in_scope" && row.metricCode === "M058" && row.businessDate === request.date);
        expect(raw).toMatchObject({ value: 12.34, dataStatus: "READY", ruleVersion: "older-rule-fixture" });
      }
    });
  }

  for (const [date, startDate, endDate] of [["2026-09-21", "2026-09-01", "2026-10-01"], ["2026-10-12", "2026-10-01", "2026-10-15"], ["2026-10-14", "2026-10-01", "2026-10-15"]] as const) {
    test(`M018 uses its independent natural-month summary at ${date}`, async () => {
      const request: OperatingEvidenceQuery = { ...input, date, view: "day", environment: "test" };
      const source = fixture(request), evidence = await readOperatingEvidence(source.client, request, options());
      const monthly = evidence.calls.filter(call => call.params.granularity === "summary");
      expect(evidence.environment).toBe("test");
      expect(monthly).toHaveLength(1);
      expect(monthly[0].params).toMatchObject({ pid: "PH", startDate, endDate, granularity: "summary", metricCodes: "M018", includeIncomplete: "true" });
      expect(monthly[0].params.dimensions).toBeUndefined();
      expect(monthly[0].params.dimensionFilters).toBeUndefined();
      expect(monthly[0].response!.rows[0]).toMatchObject({ dateScope: "undated", metricCode: "M018", value: 42, dataStatus: "READY", ruleVersion: "monthly-fixture-v1" });
      expect(evidence.calls.filter(call => call.params.granularity === "day").every(call => !call.params.metricCodes!.split(",").includes("M018"))).toBe(true);
    });
  }

  test("selecting only the current business day preserves the M018 no-value boundary", async () => {
    const request: OperatingEvidenceQuery = { ...input, date: "2026-10-15", view: "day" };
    const source = fixture(request), evidence = await readOperatingEvidence(source.client, request, options());
    const baseline = await new DailyDashboardService(fixture(request).client, now).execute(queryFor(request));
    expect(normalize(evidence.projection)).toEqual(normalize(baseline));
    expect(evidence.calls.some(call => call.params.metricCodes?.split(",").includes("M018"))).toBe(false);
    expect(series(evidence.projection, "M018").points[0]).toMatchObject({ state: "no_value", value: null });
  });

  test("undated range PROCESSING and dated PROCESSING stay distinguishable with identical projections", async () => {
    const rangeSource = fixture(input, "range_processing"), datedSource = fixture(input, "processing");
    const range = await readOperatingEvidence(rangeSource.client, input, options());
    const dated = await readOperatingEvidence(datedSource.client, input, options());
    expect(normalize(range.projection)).toEqual(normalize(dated.projection));
    const rows = (evidence: typeof range) => evidence.calls.flatMap(call => call.response?.rows ?? [])
      .filter((row): row is OperatingEvidenceBusinessRow => row.scope === "in_scope" && row.metricCode === "M016");
    expect(rows(range).length).toBeGreaterThan(0);
    expect(rows(range).every(row => row.dateScope === "undated" && row.businessDate === undefined && row.dataStatus === "PROCESSING" && row.numerator === 999)).toBe(true);
    expect(rows(dated).length).toBe(rows(range).length * 8);
    expect(rows(dated).every(row => row.dateScope === "dated" && row.businessDate !== undefined && row.dataStatus === "PROCESSING" && row.numerator === 999)).toBe(true);
    expect(series(range.projection, "M016").points.every(point => point.value === null && point.sourceStatus === "PROCESSING" && point.inputs.every(item => item.value === null))).toBe(true);
  });

  test("future dates and already cancelled requests perform no client reads", async () => {
    const source = fixture(input), cancelled = new AbortController();
    await expect(readOperatingEvidence(source.client, { ...input, date: "2026-10-16" }, options()))
      .rejects.toMatchObject({ code: "INVALID_OPERATING_EVIDENCE_QUERY", statusCode: 400 });
    await expect(readOperatingEvidence(source.client, { ...input, date: "0000-01-01" }, options()))
      .rejects.toMatchObject({ code: "INVALID_OPERATING_EVIDENCE_QUERY", statusCode: 400 });
    cancelled.abort();
    await expect(readOperatingEvidence(source.client, input, options(cancelled.signal)))
      .rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT", statusCode: 504 });
    expect(source.reads).toHaveLength(0);
    expect(getEventListeners(cancelled.signal, "abort")).toHaveLength(0);
  });

  test("source cancellation reaches the client and cannot contaminate a concurrent healthy evidence read", async () => {
    const source = fixture(input, "ready", true), cancelled = new AbortController(), healthy = new AbortController();
    const rejected = readOperatingEvidence(source.client, input, options(cancelled.signal)).catch(error => error);
    const successful = readOperatingEvidence(source.client, input, options(healthy.signal));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(source.reads).toHaveLength(44);
    const cancelledReads = source.reads.slice(0, 22), healthyReads = source.reads.slice(22);
    expect(source.reads.every(read => read.signal instanceof AbortSignal && !read.signal.aborted && read.inboundToken === undefined)).toBe(true);
    cancelled.abort();
    expect(await rejected).toMatchObject({ code: "UPSTREAM_TIMEOUT", statusCode: 504 });
    expect(cancelledReads.every(read => read.signal!.aborted)).toBe(true);
    expect(healthyReads.every(read => !read.signal!.aborted)).toBe(true);
    expect(getEventListeners(cancelled.signal, "abort")).toHaveLength(0);
    source.release();
    const evidence = await successful;
    const baseline = await new DailyDashboardService(fixture(input).client, now).execute(queryFor(input));
    expect(normalize(evidence.projection)).toEqual(normalize(baseline));
    expect(evidence.calls).toHaveLength(14);
    expect(evidence.calls.every(call => call.state === "fulfilled" && call.errorCode === null && call.response?.truncated === false)).toBe(true);
    expect(evidence.calls.map(call => call.sequence)).toEqual(Array.from({ length: 14 }, (_, index) => index + 1));
    expect(getEventListeners(healthy.signal, "abort")).toHaveLength(0);
  });
});
