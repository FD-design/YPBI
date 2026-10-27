import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { DailyDashboardQuery, DailyDashboardV2Success } from "../../contracts/daily-dashboard";
import { OPERATING_METRIC_IDS, operatingSnapshotDates } from "../../contracts/operating-detail-projection";
import { loadEnv } from "../config/env";
import { BI_V1_EFFECTIVE_PLAY_RULE_VERSION, BI_V1_PLAYBACK_API } from "../upstream/bi-v1.adapter";
import { BI_V1_METRICS_API, type BiV1MetricDimensionFilters } from "../upstream/bi-v1.metrics-adapter";
import { UpstreamClient, UpstreamError } from "../upstream/client";
import { P_DAY_SUM_API } from "../upstream/overview.adapter";
import { RETENTION_PLUS_API } from "../upstream/retention.adapter";
import { CHANNEL_V2_API, DailyDashboardService, PAYMENT_RATE_API } from "./daily-dashboard.service";

const query: DailyDashboardQuery = { boardId: "5.2", pid: "PH", dateRange: ["2026-10-05", "2026-10-12"], projection: "operating_snapshot" };
const now = () => new Date("2026-10-14T00:00:00Z");
const selectedDates = operatingSnapshotDates(query.dateRange);
const allDates = Array.from({ length: 8 }, (_, index) => new Date(Date.parse(query.dateRange[0]) + index * 86_400_000).toISOString().slice(0, 10));
const ratios = new Set(["M005", "M006", "M007", "M020", "M021", "M022", "M023", "M036", "M061", "M064", "M081", "M090", "M099", "M103", "M111", "M114"]);
type ModernStatus = "READY" | "PROCESSING" | "FAILED" | "NOT_MATURE" | "SOURCE_INCOMPLETE" | "empty" | "invalid";
type ChannelRead = { date: string; params: Record<string, string>; signal?: AbortSignal; resolve: (value?: unknown) => void };
type LegacySource = "daily" | "cohort" | "payment";
type LegacyRead = { source: LegacySource; date?: string; signal?: AbortSignal; resolve: () => void };
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(condition: () => boolean) {
  for (let index = 0; index < 100 && !condition(); index++) await flush();
  expect(condition()).toBe(true);
}
async function releaseSerialReads<T, R extends { resolve: () => void; signal?: AbortSignal }>(pending: Promise<T>, reads: R[]) {
  const released = new Set<R>();
  let completed = false;
  const result = pending.then(value => { completed = true; return value; });
  for (let index = 0; index < 100 && !completed; index++) {
    const started = reads.filter(read => !released.has(read));
    expect(started.length).toBeLessThanOrEqual(1);
    for (const read of started) {
      // The unit budget is disposed after settlement, so its signal is only
      // meaningful for cancellation while the read is still active.
      expect(read.signal?.aborted).toBe(false);
      released.add(read);
      read.resolve();
    }
    await flush();
  }
  expect(completed).toBe(true);
  return result;
}
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
function channelPayload(date: string) {
  return { code: 200, msg: { pageData: [], totalData: [{ pid: "PH", sumDate: date,
    oldUserWatchUserCount: 6, oldUserLoginUserCount: 10, totalDownCountNoDedup: 6, visiCountNoDedup: 8,
    registerUserCount: 3, totalDownCountByIp: 2, ipStatTotalCount: 4,
    vipChargeAmt: 12.34, goldChargeAmt: 0, newUserVipChargeAmt: 0, newUserGoldChargeAmt: 0 }] } };
}
function fixture(options: {
  status?: (code: string, date: string, filters: BiV1MetricDimensionFilters) => ModernStatus;
  holdChannel?: boolean;
  modernGate?: Promise<void>;
  metricGroupGate?: { filters: BiV1MetricDimensionFilters; promise: Promise<void> };
  beforeMetricRead?: (params: Record<string, string>) => void | Promise<void>;
  dailyGate?: Promise<void>;
  playbackGate?: Promise<void>;
  monthlyGate?: Promise<void>;
  cohortGate?: Promise<void>;
  paymentGate?: Promise<void>;
  metricsFailure?: boolean;
  zeroInputs?: boolean;
  holdLegacy?: LegacySource;
  legacyCohorts?: boolean;
  rowVersion?: (code: string, filters: BiV1MetricDimensionFilters) => string;
} = {}) {
  const channels: ChannelRead[] = [];
  const legacyReads: LegacyRead[] = [];
  const logs: { sources: Array<{ sourceId: string; readCallCount: number; successfulReadCallCount: number; failedReadCallCount: number; cancelledReadCallCount?: number; budgetExpired: boolean; errorCodeCounts: Record<string, number> }> }[] = [];
  const client = { get: async (path: string, params: Record<string, string>, _token?: string, signal?: AbortSignal): Promise<unknown> => {
    if (path === CHANNEL_V2_API) {
      const date = params.sumDateBegin.slice(0, 10);
      const pending = deferred<unknown>();
      channels.push({ date, params, signal, resolve: (value = channelPayload(date)) => pending.resolve(value) });
      return options.holdChannel ? pending.promise : channelPayload(date);
    }
    const envelope = (rows: unknown[]) => ({ code: 200, msg: { metricVersion: "bi-v1", generatedAt: now().toISOString(), watermark: null, rows } });
    if (path === BI_V1_METRICS_API || path === BI_V1_PLAYBACK_API) {
      const filters = JSON.parse(params.dimensionFilters ?? "{}");
      if (path === BI_V1_METRICS_API) {
        await options.modernGate;
        if (params.granularity === "summary") await options.monthlyGate;
        else if (options.metricGroupGate
          && Object.keys(filters).length === Object.keys(options.metricGroupGate.filters).length
          && Object.entries(options.metricGroupGate.filters).every(([key, value]) => filters[key] === value)) {
          await options.metricGroupGate.promise;
        }
        await options.beforeMetricRead?.(params);
        if (options.metricsFailure) throw new UpstreamError("UPSTREAM_NETWORK_ERROR", "fixture unavailable");
      } else await options.playbackGate;
      const dates = params.granularity === "summary" ? [""] : allDates;
      return envelope(dates.flatMap(date => params.metricCodes.split(",").flatMap(code => {
        const status = path === BI_V1_PLAYBACK_API ? "READY" : options.status?.(code, date, filters) ?? "READY";
        if (status === "empty") return [];
        const ratio = ratios.has(code) || code === "M110";
        const scalar = options.zeroInputs && ["M095", "M002"].includes(code) ? 0 : code === "M058" ? 12.34 : code === "M102" ? 7200 : code === "M034" ? 1 : 2;
        const numerator = ratio ? 1 : scalar;
        const ready = status === "READY" || status === "invalid";
        return [{ metricCode: code, ...(date ? { businessDate: date } : {}), dimensions: { pid: "PH", ...filters,
          ...(path === BI_V1_PLAYBACK_API ? { videoType: "short_video" } : {}) },
          value: ready ? ratio ? 0.5 : scalar : null, numerator, denominator: ratio ? 2 : 0,
          unit: status === "invalid" ? "currency" : code === "M058" ? "currency" : code === "M102" ? "seconds" : code === "M110" ? "count_per_user" : ratio ? "ratio" : "count",
          dataStatus: status === "invalid" ? "READY" : status, metricVersion: options.rowVersion?.(code, filters) ?? "bi-v1",
          ruleVersion: code === "M058" ? "paid-order-value-rmb-v2" : code === "M102" ? "foreground-watch-duration-v1"
            : ["M034", "M036"].includes(code) ? BI_V1_EFFECTIVE_PLAY_RULE_VERSION : "channel-dependency-fixture-v1" }];
      })));
    }
    if (path.endsWith("pDaySum")) {
      if (options.holdLegacy === "daily") await new Promise<void>(resolve => legacyReads.push({ source: "daily", signal, resolve }));
      await options.dailyGate;
      return { msg: { totalCount: allDates.length, pageData: allDates.map(sumDate => ({ pid: "PH", sumDate,
        loginUserCount: 100, registerUserCount: 10, watchUserCount: 60 })) } };
    }
    if (path.includes("reletionsStatPlus")) {
      if (options.holdLegacy === "cohort") await new Promise<void>(resolve => legacyReads.push({ source: "cohort", signal, resolve }));
      await options.cohortGate;
      return { data: options.legacyCohorts ? allDates.map(sumDate => ({ pid: "PH", sumDate, registerCount: 10,
        afterFirstData1: { loginCnt: 4, date: new Date(Date.parse(sumDate) + 86400000).toISOString().slice(0, 10) } })) : [] };
    }
    if (path === PAYMENT_RATE_API) {
      if (options.holdLegacy === "payment") await new Promise<void>(resolve => legacyReads.push({ source: "payment", date: params.startTime.slice(0, 10), signal, resolve }));
      await options.paymentGate;
      return { msg: { pid: "PH", sumDate: params.startTime.slice(0, 10), pageData: [], totalAllCount: 4, totalSurCount: 2 } };
    }
    return { msg: [] };
  } };
  const logger = { info: (value: (typeof logs)[number]) => { logs.push(value); } };
  return { client, channels, legacyReads, logs, service: new DailyDashboardService(client, now, logger, { sourceReadTimeoutMs: 1000 }) };
}
const point = (result: DailyDashboardV2Success, id: string, date = selectedDates.at(-1)!) => result.data.series.find(series => series.metric.id === id)!.points.find(value => value.date === date)!;
function assertProjection(actual: DailyDashboardV2Success, expected: DailyDashboardV2Success) {
  expect(actual.data.series).toEqual(expected.data.series);
  expect(actual.data.series.map(series => series.metric.id)).toEqual([...OPERATING_METRIC_IDS]);
  expect(actual.data.series.every(series => series.points.map(point => point.date).join() === selectedDates.join())).toBe(true);
  expect(actual.data.sourceApiIds).toEqual(expected.data.sourceApiIds);
}

describe("经营快照按最终投影保留渠道依赖", () => {
  for (const source of ["daily", "cohort", "payment"] as const) for (const status of ["READY", "PROCESSING", "FAILED", "NOT_MATURE"] as const)
    test(`${status}现代选择充分时不等待挂起${source}旧源，279点保持`, async () => {
    const options = { status: () => status };
    const held = fixture({ ...options, holdLegacy: source }), baseline = fixture(options);
    let completed = false;
    const pending = held.service.execute(query).then(result => { completed = true; return result; });
    for (let index = 0; index < 6; index++) await flush();
    const completedBeforeRelease = completed;
    const result = await pending;
    expect(held.legacyReads).toEqual([]);
    expect(completedBeforeRelease).toBe(true);
    expect(result.data.series.reduce((count, series) => count + series.points.length, 0)).toBe(279);
    assertProjection(result, await baseline.service.execute(query));
  });

  for (const [source, code, legacyValue] of [["daily", "M008", 10], ["cohort", "M020", 0.4], ["payment", "M112", 4]] as const)
    test(`${source}逐日混合选择不启动无用途读取，保留必要回退`, async () => {
      const status = (metric: string, date: string, filters: BiV1MetricDimensionFilters): ModernStatus =>
        metric === code && !Object.keys(filters).length && date === selectedDates[1] ? "SOURCE_INCOMPLETE" : "READY";
      const held = fixture({ holdLegacy: source, legacyCohorts: true, status });
      let completed = false;
      const pending = held.service.execute(query).then(result => { completed = true; return result; });
      for (let index = 0; index < 6; index++) await flush();
      const aborted = held.legacyReads.map(read => read.signal?.aborted), completedBeforeRelease = completed;
      const result = await releaseSerialReads(pending, held.legacyReads);
      expect(aborted).toEqual([false]);
      expect(held.legacyReads).toHaveLength(1);
      if (source === "payment") expect(held.legacyReads.map(read => read.date)).toEqual([selectedDates[1]]);
      expect(completedBeforeRelease).toBe(false);
      expect(point(result, code, selectedDates[1])).toMatchObject({ state: "available", value: legacyValue });
      assertProjection(result, await fixture({ legacyCohorts: true, status }).service.execute(query));
    });

  for (const [source, code, legacyValue] of [["daily", "M008", 10], ["cohort", "M020", 0.4], ["payment", "M112", 4]] as const)
    for (const failure of ["SOURCE_INCOMPLETE", "empty", "invalid", "wrong_version", "transport"] as const)
      test(`${source}现代${failure}保留必要旧源与合法回退`, async () => {
        const target = (metric: string, filters: BiV1MetricDimensionFilters) => metric === code && !Object.keys(filters).length;
        const options = { legacyCohorts: true,
          status: (metric: string, _date: string, filters: BiV1MetricDimensionFilters): ModernStatus =>
            target(metric, filters) && ["SOURCE_INCOMPLETE", "empty", "invalid"].includes(failure) ? failure as ModernStatus : "READY",
          rowVersion: (metric: string, filters: BiV1MetricDimensionFilters) => failure === "wrong_version" && target(metric, filters) ? "unknown-version" : "bi-v1",
          metricsFailure: failure === "transport" };
        const held = fixture({ ...options, holdLegacy: source });
        let completed = false;
        const pending = held.service.execute(query).then(result => { completed = true; return result; });
        for (let index = 0; index < 6; index++) await flush();
        const aborted = held.legacyReads.map(read => read.signal?.aborted), completedBeforeRelease = completed;
        const result = await releaseSerialReads(pending, held.legacyReads);
        expect(aborted).toEqual([false]);
        expect(held.legacyReads).toHaveLength(source === "payment" ? selectedDates.length : 1);
        if (source === "payment") expect(held.legacyReads.map(read => read.date)).toEqual(selectedDates);
        expect(completedBeforeRelease).toBe(false);
        expect(point(result, code)).toMatchObject({ state: "available", value: legacyValue });
        assertProjection(result, await fixture(options).service.execute(query));
      });

  for (const status of ["READY", "PROCESSING", "FAILED", "NOT_MATURE"] as const) test(`${status}现代结果不等待无用途渠道，93列三期保持`, async () => {
    const options = { status: () => status };
    const held = fixture({ ...options, holdChannel: true }), baseline = fixture(options);
    const result = await held.service.execute(query);
    assertProjection(result, await baseline.service.execute(query));
    expect(held.channels).toEqual([]);
    const source = held.logs[0].sources.find(source => source.sourceId === "channel")!;
    expect(source).toMatchObject({ readCallCount: 0, successfulReadCallCount: 0, failedReadCallCount: 0, budgetExpired: false, errorCodeCounts: {} });
    expect(source.cancelledReadCallCount).toBeUndefined();
    const before = JSON.stringify(result);
    held.channels.forEach(read => read.resolve()); await flush();
    expect(JSON.stringify(result)).toBe(before);
  });

  for (const status of ["SOURCE_INCOMPLETE", "empty", "invalid"] as const) test(`${status}现代结果保留可用旧渠道`, async () => {
    const held = fixture({ status: () => status, holdChannel: true });
    const pending = held.service.execute(query);
    await flush();
    expect(held.channels).toHaveLength(1);
    expect(held.channels.every(read => !read.signal?.aborted)).toBe(true);
    const result = await releaseSerialReads(pending, held.channels);
    expect(held.channels.map(read => read.date)).toEqual(selectedDates);
    expect(point(result, "M003")).toMatchObject({ state: "available", value: 6 });
    expect(point(result, "M005")).toMatchObject({ state: "available", value: 0.75 });
    expect(held.logs[0].sources.find(source => source.sourceId === "channel")!.cancelledReadCallCount).toBeUndefined();
  });

  test("现代传输失败仍等待合法旧源，不把失败当成无回退需求", async () => {
    const held = fixture({ metricsFailure: true, holdChannel: true });
    const pending = held.service.execute(query); await flush();
    expect(held.channels.every(read => !read.signal?.aborted)).toBe(true);
    expect(held.channels).toHaveLength(1);
    const result = await releaseSerialReads(pending, held.channels);
    expect(held.channels.map(read => read.date)).toEqual(selectedDates);
    expect(point(result, "M003")).toMatchObject({ state: "available", value: 6 });
    expect(point(result, "M006")).toMatchObject({ state: "available", value: 1.5 });
  });

  for (const zeroInputs of [false, true]) test(`M006/M007使用同日READY输入派生，零分母=${zeroInputs}不等待渠道`, async () => {
    const held = fixture({ holdChannel: true, zeroInputs, status: code => ["M006", "M007"].includes(code) ? "PROCESSING" : "READY" });
    const result = await held.service.execute(query);
    for (const id of ["M006", "M007"]) {
      expect(point(result, id)).toMatchObject({ state: zeroInputs ? "zero_denominator" : "available", value: zeroInputs ? null : 1, sourceStatus: "READY" });
      expect(point(result, id).inputs.map(input => input.value)).toEqual([2, zeroInputs ? 0 : 2]);
    }
    expect(held.channels).toEqual([]);
    held.channels.forEach(read => read.resolve());
  });

  test("有效READY比率优先于READY基础输入派生", async () => {
    const held = fixture({ holdChannel: true });
    const result = await held.service.execute(query);
    expect(point(result, "M006")).toMatchObject({ state: "available", value: 0.5, sourceStatus: "READY" });
    expect(point(result, "M006").inputs.map(input => input.value)).toEqual([1, 2]);
    expect(held.channels).toEqual([]);
    held.channels.forEach(read => read.resolve());
  });

  test("只发需要旧源的日期，保留原请求并等待", async () => {
    const status = (_code: string, date: string): ModernStatus => date === selectedDates[1] ? "SOURCE_INCOMPLETE" : "READY";
    const held = fixture({ holdChannel: true, status }), baseline = fixture({ status });
    const pending = held.service.execute(query); let completed = false;
    void pending.then(() => { completed = true; });
    await flush();
    expect(held.channels.map(read => [read.date, read.signal?.aborted])).toEqual([[selectedDates[1], false]]);
    expect(completed).toBe(false);
    held.channels[0].resolve();
    const result = await pending;
    assertProjection(result, await baseline.service.execute(query));
    expect(point(result, "M005", selectedDates[1])).toMatchObject({ value: 0.75, state: "available" });
    expect(held.logs[0].sources.find(source => source.sourceId === "channel")).toMatchObject({ readCallCount: 1, successfulReadCallCount: 1, failedReadCallCount: 0, budgetExpired: false });
    expect(held.logs[0].sources.find(source => source.sourceId === "channel")!.cancelledReadCallCount).toBeUndefined();
    held.channels.forEach(read => read.resolve());
  });

  test("晚到现代不完整后读取必要旧渠道，原渠道参数与合法回退保持", async () => {
    const modern = deferred();
    const held = fixture({ modernGate: modern.promise, status: () => "SOURCE_INCOMPLETE" });
    const pending = held.service.execute(query); await flush();
    expect(held.channels).toEqual([]);
    modern.resolve();
    const result = await pending;
    expect(held.channels).toHaveLength(3);
    expect(held.channels.map(read => read.date)).toEqual(selectedDates);
    expect(held.channels.every(read => read.params.page === "1" && read.params.count === "1")).toBe(true);
    expect(point(result, "M005")).toMatchObject({ value: 0.75, state: "available" });
    expect(point(result, "M006")).toMatchObject({ value: 1.5, state: "available" });
  });

  test("现代依赖完成前不预发渠道，使用完整输入判定无需回退", async () => {
    const dependency = deferred(), held = fixture({ modernGate: dependency.promise, holdChannel: true });
    const pending = held.service.execute(query); await flush();
    expect(held.channels).toEqual([]);
    dependency.resolve(); await pending;
    expect(held.channels).toEqual([]);
    held.channels.forEach(read => read.resolve());
  });

  for (const derived of [false, true]) test(`现代已足够时不启动日汇总或渠道，READY基础派生=${derived}且93列三期保持`, async () => {
    const daily = deferred();
    const status = (code: string): ModernStatus => derived && ["M006", "M007"].includes(code) ? "PROCESSING" : "READY";
    const held = fixture({ dailyGate: daily.promise, holdChannel: true, status });
    const pending = held.service.execute(query); let completed = false;
    void pending.then(() => { completed = true; });
    await flush();
    const cancelledBeforeDaily = held.channels.map(read => read.signal?.aborted);
    const completedBeforeDaily = completed;
    daily.resolve();
    const result = await pending;
    held.channels.forEach(read => read.resolve());
    expect(cancelledBeforeDaily).toEqual([]);
    expect(completedBeforeDaily).toBe(true);
    assertProjection(result, await fixture({ status }).service.execute(query));
    for (const id of ["M006", "M007"]) expect(point(result, id)).toMatchObject({
      state: "available", value: derived ? 1 : 0.5, sourceStatus: "READY"
    });
  });

  for (const sourceStatus of ["SOURCE_INCOMPLETE", "empty", "invalid"] as const)
    test(`备用M008为${sourceStatus}时仍等待实际日汇总与渠道，不把旧源当READY基础`, async () => {
      const daily = deferred();
      const status = (code: string, _date: string, filters: BiV1MetricDimensionFilters): ModernStatus =>
        !Object.keys(filters).length && code === "M008" ? sourceStatus
          : ["M006", "M007"].includes(code) ? "SOURCE_INCOMPLETE" : "READY";
      const held = fixture({ dailyGate: daily.promise, holdChannel: true, status });
      const pending = held.service.execute(query); let completed = false;
      void pending.then(() => { completed = true; });
      await flush();
      // Necessary legacy reads retain FIFO order: the daily read holds the
      // permit before any channel date is allowed to start.
      expect(held.channels).toEqual([]);
      const completedBeforeDaily = completed;
      daily.resolve();
      const result = await releaseSerialReads(pending, held.channels);
      expect(held.channels.map(read => read.date)).toEqual(selectedDates);
      expect(completedBeforeDaily).toBe(false);
      assertProjection(result, await fixture({ status }).service.execute(query));
      expect(point(result, "M008")).toMatchObject({ state: "available", value: 10 });
      expect(point(result, "M008").sourceStatus).toBeUndefined();
      expect(point(result, "M006")).toMatchObject({ state: "available", value: 1.5 });
      expect(point(result, "M007")).toMatchObject({ state: "available", value: 0.75 });
      expect(point(result, "M006").sourceStatus).toBeUndefined();
      expect(point(result, "M007").sourceStatus).toBeUndefined();
      expect(point(result, "M088")).toMatchObject({ state: "available", value: 1.234 });
    });

  for (const filters of [
    { paymentMethod: "ali_pay" },
    { userCohort: "new" },
    { sourceType: "natural" },
    { sourceType: "internal_channel" },
    { clientPlatform: "android" }
  ] as const) test(`无关现代分组${JSON.stringify(filters)}挂起时不预发无用渠道，93列三期保持`, async () => {
    const unrelated = deferred();
    const held = fixture({ metricGroupGate: { filters, promise: unrelated.promise }, holdChannel: true });
    const pending = held.service.execute(query); let completed = false;
    void pending.then(() => { completed = true; });
    await flush();
    const cancelledBeforeRelease = held.channels.map(read => read.signal?.aborted);
    const completedBeforeRelease = completed;
    unrelated.resolve();
    const result = await pending;
    held.channels.forEach(read => read.resolve());
    assertProjection(result, await fixture().service.execute(query));
    expect(cancelledBeforeRelease).toEqual([]);
    expect(completedBeforeRelease).toBe(false);
    expect(held.channels).toEqual([]);
  });

  for (const filters of [{}, { userCohort: "old" }] as const)
    test(`渠道实际依赖分组${JSON.stringify(filters)}挂起时不得提前读取，93列三期保持`, async () => {
      const dependency = deferred();
      const held = fixture({ metricGroupGate: { filters, promise: dependency.promise }, holdChannel: true });
      const pending = held.service.execute(query); let completed = false;
      void pending.then(() => { completed = true; });
      await flush();
      const cancelledBeforeRelease = held.channels.map(read => read.signal?.aborted);
      const completedBeforeRelease = completed;
      dependency.resolve();
      const result = await pending;
      held.channels.forEach(read => read.resolve());
      assertProjection(result, await fixture().service.execute(query));
      expect(cancelledBeforeRelease).toEqual([]);
      expect(completedBeforeRelease).toBe(false);
      expect(held.channels).toEqual([]);
    });

  test("总体组晚到传输失败仍等待合法旧渠道，93列三期保持", async () => {
    const dependency = deferred();
    const beforeMetricRead = (params: Record<string, string>) => {
      if (params.granularity === "day" && !params.dimensionFilters) {
        throw new UpstreamError("UPSTREAM_NETWORK_ERROR", "fixture overall unavailable");
      }
    };
    const held = fixture({ beforeMetricRead, metricGroupGate: { filters: {}, promise: dependency.promise }, holdChannel: true });
    const pending = held.service.execute(query); let completed = false;
    void pending.then(() => { completed = true; });
    await flush();
    const cancelledBeforeFailure = held.channels.map(read => read.signal?.aborted);
    dependency.resolve(); await flush();
    const cancelledAfterFailure = held.channels.map(read => read.signal?.aborted);
    const completedBeforeLegacy = completed;
    const result = await releaseSerialReads(pending, held.channels);
    assertProjection(result, await fixture({ beforeMetricRead }).service.execute(query));
    expect(cancelledBeforeFailure).toEqual([]);
    expect(cancelledAfterFailure).toEqual([false]);
    expect(completedBeforeLegacy).toBe(false);
    expect(held.channels.map(read => read.date)).toEqual(selectedDates);
    expect(point(result, "M003")).toMatchObject({ state: "available", value: 6 });
    expect(point(result, "M006")).toMatchObject({ state: "available", value: 1.5 });
  });

  test("old组晚到SOURCE_INCOMPLETE仍等待合法旧渠道，93列三期保持", async () => {
    const dependency = deferred();
    const status = (code: string, _date: string, filters: BiV1MetricDimensionFilters): ModernStatus =>
      filters.userCohort === "old" && !filters.clientPlatform && ["M026", "M081"].includes(code) ? "SOURCE_INCOMPLETE" : "READY";
    const held = fixture({ status, metricGroupGate: { filters: { userCohort: "old" }, promise: dependency.promise }, holdChannel: true });
    const pending = held.service.execute(query); let completed = false;
    void pending.then(() => { completed = true; });
    await flush();
    const cancelledBeforeIncomplete = held.channels.map(read => read.signal?.aborted);
    dependency.resolve(); await flush();
    const cancelledAfterIncomplete = held.channels.map(read => read.signal?.aborted);
    const completedBeforeLegacy = completed;
    const result = await releaseSerialReads(pending, held.channels);
    assertProjection(result, await fixture({ status }).service.execute(query));
    expect(cancelledBeforeIncomplete).toEqual([]);
    expect(cancelledAfterIncomplete).toEqual([false]);
    expect(completedBeforeLegacy).toBe(false);
    expect(held.channels.map(read => read.date)).toEqual(selectedDates);
    expect(point(result, "M026.old")).toMatchObject({ state: "available", value: 6 });
    expect(point(result, "M081.old")).toMatchObject({ state: "available", value: 0.6 });
  });

  test("总体批量拒绝后单指标隔离按原顺序逐项完成，不预发渠道且93列三期保持", async () => {
    const recovery = deferred();
    const requests: string[] = [];
    const rejectOverallBatch = (params: Record<string, string>) => {
      if (params.granularity === "day" && !params.dimensionFilters && params.metricCodes.includes(",")) {
        throw new UpstreamError("UPSTREAM_INVALID_REQUEST", "unsupported metrics", 422);
      }
    };
    const held = fixture({ holdChannel: true, beforeMetricRead: async params => {
      if (params.granularity === "day" && !params.dimensionFilters) requests.push(params.metricCodes);
      rejectOverallBatch(params);
      if (params.granularity === "day" && !params.dimensionFilters && params.metricCodes === "M003") await recovery.promise;
    } });
    const pending = held.service.execute(query); let completed = false;
    void pending.then(() => { completed = true; });
    await flush();
    const requestedBeforeRecovery = [...requests];
    const cancelledBeforeRecovery = held.channels.map(read => read.signal?.aborted);
    const completedBeforeRecovery = completed;
    recovery.resolve();
    const result = await pending;
    held.channels.forEach(read => read.resolve());
    assertProjection(result, await fixture({ beforeMetricRead: rejectOverallBatch }).service.execute(query));
    const registeredCodes = requestedBeforeRecovery[0].split(",");
    // A held validation unit prevents later recovery work from starting, while
    // the final trace still proves one attempt per metric in registered order.
    expect(requestedBeforeRecovery.slice(1)).toEqual(registeredCodes.slice(0, registeredCodes.indexOf("M003") + 1));
    expect(requests.slice(1)).toEqual(registeredCodes);
    expect(new Set(requests.slice(1)).size).toBe(requests.length - 1);
    expect(cancelledBeforeRecovery).toEqual([]);
    expect(completedBeforeRecovery).toBe(false);
    expect(held.channels).toEqual([]);
    expect(point(result, "M003")).toMatchObject({ state: "available", value: 2, sourceStatus: "READY" });
  });

  for (const gate of ["playbackGate", "monthlyGate", "cohortGate", "paymentGate"] as const) test(`${gate}不引起无用渠道预读取，完整投影保持`, async () => {
    const unrelated = deferred(), held = fixture({ [gate]: unrelated.promise, holdChannel: true });
    const pending = held.service.execute(query); let completed = false;
    void pending.then(() => { completed = true; });
    await flush();
    const cancelled = held.channels.map(read => read.signal?.aborted);
    const completedBeforeRelease = completed;
    unrelated.resolve();
    const result = await pending;
    expect(cancelled).toEqual([]);
    expect(completedBeforeRelease).toBe(gate === "cohortGate" || gate === "paymentGate");
    assertProjection(result, await fixture().service.execute(query));
    expect(held.channels).toEqual([]);
    held.channels.forEach(read => read.resolve());
  });

  test("无关慢现代来源完成后只读取必要渠道日期，完整投影保持", async () => {
    const playback = deferred();
    const status = (_code: string, date: string): ModernStatus => date === selectedDates[1] ? "SOURCE_INCOMPLETE" : "READY";
    const held = fixture({ status, playbackGate: playback.promise, holdChannel: true });
    const pending = held.service.execute(query);
    await flush();
    const cancelled = held.channels.map(read => read.signal?.aborted);
    playback.resolve();
    const result = await releaseSerialReads(pending, held.channels);
    expect(cancelled).toEqual([]);
    expect(held.channels.map(read => read.date)).toEqual([selectedDates[1]]);
    assertProjection(result, await fixture({ status }).service.execute(query));
    held.channels.forEach(read => read.resolve());
  });

  for (const gate of ["playback", "daily"] as const) test(`${gate === "playback" ? "慢现代播放" : "无用旧日汇总"}不预发渠道，后续读取与默认40容量保持`, async () => {
    const base = fixture();
    const dependency = deferred(), background = deferred();
    const physicalChannels: AbortSignal[] = [];
    const dispatched: string[] = [];
    let active = 0, peak = 0;
    const upstream = new UpstreamClient({ ...loadEnv({ NODE_ENV: "test", UPSTREAM_API_BASE_URL: "https://in-memory.invalid",
      UPSTREAM_USER_NAME: "fixture-user", UPSTREAM_X_TOKEN: "fixture-token",
      UPSTREAM_CREDENTIALS_FILE: `/private/tmp/ypbi-channel-capacity-absent-${randomUUID()}.json` }), REQUEST_TIMEOUT_MS: 1000 }, async (input, init) => {
      const url = new URL(String(input)), params = Object.fromEntries(url.searchParams);
      active++; peak = Math.max(peak, active); dispatched.push(url.pathname);
      try {
        if (url.pathname === CHANNEL_V2_API) {
          physicalChannels.push(init!.signal!);
          return await new Promise<Response>((_resolve, reject) => {
            init!.signal!.addEventListener("abort", () => reject(new DOMException("fixture cancelled", "AbortError")), { once: true });
          });
        }
        if (url.pathname === "/api/fixture/background") { await background.promise; return Response.json({ code: 200 }); }
        if (url.pathname === "/api/fixture/later") { await background.promise; return Response.json({ code: 200 }); }
        if (gate === "playback" ? url.pathname === BI_V1_PLAYBACK_API : url.pathname.endsWith("pDaySum")) await dependency.promise;
        return Response.json(await base.client.get(url.pathname, params));
      } finally { active--; }
    });
    const pending = new DailyDashboardService(upstream, now, undefined, { sourceReadTimeoutMs: 1000 }).execute(query);
    await flush();
    const blockers = Array.from({ length: gate === "playback" ? 36 : 37 }, (_, index) => upstream.get("/api/fixture/background", { pid: "PH", index: String(index) }));
    const later = Array.from({ length: 3 }, (_, index) => upstream.get("/api/fixture/later", { pid: "PH", index: String(index) }));
    await flush();
    const dispatchedBeforeDependency = dispatched.filter(path => path === "/api/fixture/later").length;
    const cancelledBeforeDependency = physicalChannels.map(signal => signal.aborted);
    dependency.resolve(); background.resolve();
    const [result] = await Promise.all([pending, ...blockers, ...later]);
    expect(dispatchedBeforeDependency).toBe(3);
    expect(cancelledBeforeDependency).toEqual([]);
    expect(dispatched.filter(path => path === CHANNEL_V2_API)).toEqual([]);
    if (gate === "daily") expect(dispatched.filter(path => path === P_DAY_SUM_API)).toEqual([]);
    expect(peak).toBe(40);
    expect(active).toBe(0);
    assertProjection(result, await fixture().service.execute(query));
  });

  test("默认121整板保留全部渠道日期与独立旧源指标", async () => {
    const held = fixture({ holdChannel: true });
    const { projection: _projection, ...fullQuery } = query;
    const pending = held.service.execute(fullQuery); await flush();
    expect(held.channels).toHaveLength(1);
    expect(held.channels.every(read => !read.signal?.aborted)).toBe(true);
    const result = await releaseSerialReads(pending, held.channels);
    expect(result.data.series).toHaveLength(121);
    expect(held.channels.map(read => read.date)).toEqual(allDates);
    expect(point(result, "M065")).toMatchObject({ state: "available", value: 12.34 });
    expect(held.logs[0].sources.find(source => source.sourceId === "channel")!.cancelledReadCallCount).toBeUndefined();
  });

  test("无用快照不订阅渠道，必要旧源消费者取消仍保留同请求的健康共享消费者", async () => {
    const physical: Array<{ date: string; signal?: AbortSignal | null; resolve: () => void }> = [];
    const upstream = new UpstreamClient({ ...loadEnv({ NODE_ENV: "test", UPSTREAM_API_BASE_URL: "https://in-memory.invalid",
      UPSTREAM_USER_NAME: "fixture-user", UPSTREAM_X_TOKEN: "fixture-token",
      UPSTREAM_CREDENTIALS_FILE: `/private/tmp/ypbi-channel-dependency-absent-${randomUUID()}.json` }), REQUEST_TIMEOUT_MS: 1000 }, async (input, init) => {
      const url = new URL(String(input)), date = url.searchParams.get("sumDateBegin")!.slice(0, 10);
      return new Promise<Response>((resolve, reject) => {
        const abort = () => reject(new DOMException("fixture cancelled", "AbortError"));
        init?.signal?.addEventListener("abort", abort, { once: true });
        physical.push({ date, signal: init?.signal, resolve: () => { init?.signal?.removeEventListener("abort", abort); resolve(Response.json(channelPayload(date))); } });
      });
    });
    const healthyController = new AbortController();
    const params = { pid: "PH", page: "1", count: "1", sumDateBegin: selectedDates[0] + " 00:00:00", sumDateEnd: "2026-10-06 00:00:00" };
    const healthy = upstream.get(CHANNEL_V2_API, params, undefined, healthyController.signal);
    const playback = deferred(), base = fixture({ playbackGate: playback.promise });
    const client = { get: (path: string, values: Record<string, string>, token?: string, signal?: AbortSignal) => path === CHANNEL_V2_API
      ? upstream.get(path, values, token, signal) : base.client.get(path, values, token, signal) };
    const pending = new DailyDashboardService(client, now, undefined, { sourceReadTimeoutMs: 1000 }).execute(query);
    await flush();
    const cancelledBeforePlayback = physical.map(read => read.signal?.aborted);
    playback.resolve();
    const result = await pending;
    expect(result.data.series).toHaveLength(93);
    expect(physical).toHaveLength(1);
    expect(physical.map(read => read.signal?.aborted)).toEqual([false]);
    expect(cancelledBeforePlayback).toEqual([false]);

    const fallback = fixture({ status: (_code, date) => date === selectedDates[0] ? "SOURCE_INCOMPLETE" : "READY" });
    const consumer = new AbortController();
    let sharedChannelReads = 0;
    const sharedClient = { get: (path: string, values: Record<string, string>, token?: string, signal?: AbortSignal) => {
      if (path !== CHANNEL_V2_API) return fallback.client.get(path, values, token, signal);
      sharedChannelReads++;
      return upstream.get(path, values, token, signal);
    } };
    const cancelled = new DailyDashboardService(sharedClient, now, undefined, { sourceReadTimeoutMs: 1000 })
      .execute(query, consumer.signal).catch(error => error);
    await until(() => sharedChannelReads === 1);
    expect(physical).toHaveLength(1);
    consumer.abort();
    expect(await cancelled).toMatchObject({ code: "UPSTREAM_TIMEOUT", statusCode: 504 });
    expect(physical[0].signal?.aborted).toBe(false);
    physical[0].resolve();
    expect(await healthy).toEqual(channelPayload(selectedDates[0]));
    expect(healthyController.signal.aborted).toBe(false);
  });

  for (const source of ["daily", "cohort", "payment"] as const) for (const fullFirst of [true, false])
    test(`${source}共享客户端${fullFirst ? "整板先创建" : "快照先创建"}时仅整板读取必要旧源，121/93投影保持`, async () => {
      const modern = deferred(), base = fixture({ modernGate: modern.promise });
      const path = source === "daily" ? P_DAY_SUM_API : source === "cohort" ? RETENTION_PLUS_API : PAYMENT_RATE_API;
      const physical: Array<{ date?: string; signal?: AbortSignal | null; settled: boolean; resolve: () => void }> = [];
      const upstream = new UpstreamClient({ ...loadEnv({ NODE_ENV: "test", UPSTREAM_API_BASE_URL: "https://in-memory.invalid",
        UPSTREAM_USER_NAME: "fixture-user", UPSTREAM_X_TOKEN: "fixture-token",
        UPSTREAM_CREDENTIALS_FILE: `/private/tmp/ypbi-legacy-dependency-absent-${randomUUID()}.json` }), REQUEST_TIMEOUT_MS: 1000 }, async (input, init) => {
        const url = new URL(String(input)), params = Object.fromEntries(url.searchParams);
        return new Promise<Response>((resolve, reject) => {
          const read = { date: params.startTime?.slice(0, 10), signal: init?.signal, settled: false, resolve: () => {
            if (read.settled) return;
            read.settled = true; init?.signal?.removeEventListener("abort", abort);
            void base.client.get(path, params).then(value => resolve(Response.json(value)), reject);
          } };
          const abort = () => { read.settled = true; reject(new DOMException("fixture cancelled", "AbortError")); };
          init?.signal?.addEventListener("abort", abort, { once: true });
          physical.push(read);
        });
      });
      const client = { get: (api: string, params: Record<string, string>, token?: string, signal?: AbortSignal) =>
        api === path ? upstream.get(api, params, token, signal) : base.client.get(api, params, token, signal) };
      const service = new DailyDashboardService(client, now, undefined, { sourceReadTimeoutMs: 1000 });
      const { projection: _projection, ...fullQuery } = query;
      let fullCompleted = false;
      const readFull = () => service.execute(fullQuery).then(result => { fullCompleted = true; return result; });
      let full: ReturnType<typeof readFull>, snapshot: ReturnType<DailyDashboardService["execute"]>;
      if (fullFirst) { full = readFull(); await flush(); snapshot = service.execute(query); }
      else { snapshot = service.execute(query); await flush(); full = readFull(); }
      await flush(); modern.resolve();
      const snapshotResult = await snapshot;
      expect(fullCompleted).toBe(false);
      await until(() => physical.length > 0);
      expect(physical.find(read => source !== "payment" || read.date === selectedDates[0])!.signal?.aborted).toBe(false);
      for (let index = 0; index < 20 && !fullCompleted; index++) {
        physical.forEach(read => read.resolve()); await flush();
      }
      const fullResult = await full;
      const baseline = fixture();
      expect(fullResult.data.series).toHaveLength(121);
      expect(physical).toHaveLength(source === "payment" ? allDates.length : 1);
      expect(physical.every(read => !read.signal?.aborted)).toBe(true);
      expect(fullResult.data.series).toEqual((await baseline.service.execute(fullQuery)).data.series);
      assertProjection(snapshotResult, await baseline.service.execute(query));
    });
});
