import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { DailyDashboardQuery, DailyDashboardV2Success } from "../../contracts/daily-dashboard";
import { OPERATING_METRIC_IDS, operatingSnapshotDates } from "../../contracts/operating-detail-projection";
import { loadEnv } from "../config/env";
import { BI_V1_EFFECTIVE_PLAY_RULE_VERSION, BI_V1_PLAYBACK_API } from "../upstream/bi-v1.adapter";
import { BI_V1_METRICS_API } from "../upstream/bi-v1.metrics-adapter";
import { UpstreamClient, UpstreamError } from "../upstream/client";
import { CHANNEL_V2_API, DailyDashboardService, PAYMENT_RATE_API } from "./daily-dashboard.service";

const query: DailyDashboardQuery = { boardId: "5.2", pid: "PH", dateRange: ["2026-10-05", "2026-10-12"], projection: "operating_snapshot" };
const now = () => new Date("2026-10-14T00:00:00Z");
const selectedDates = operatingSnapshotDates(query.dateRange);
const allDates = Array.from({ length: 8 }, (_, index) => new Date(Date.parse(query.dateRange[0]) + index * 86_400_000).toISOString().slice(0, 10));
const ratios = new Set(["M005", "M006", "M007", "M020", "M021", "M022", "M023", "M036", "M061", "M064", "M081", "M090", "M099", "M103", "M111", "M114"]);
type ModernStatus = "READY" | "PROCESSING" | "FAILED" | "NOT_MATURE" | "SOURCE_INCOMPLETE" | "empty" | "invalid";
type ChannelRead = { date: string; params: Record<string, string>; signal?: AbortSignal; resolve: (value?: unknown) => void };
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
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
  status?: (code: string, date: string) => ModernStatus;
  holdChannel?: boolean;
  modernGate?: Promise<void>;
  dailyGate?: Promise<void>;
  playbackGate?: Promise<void>;
  monthlyGate?: Promise<void>;
  cohortGate?: Promise<void>;
  paymentGate?: Promise<void>;
  metricsFailure?: boolean;
  zeroInputs?: boolean;
} = {}) {
  const channels: ChannelRead[] = [];
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
      if (path === BI_V1_METRICS_API) {
        await options.modernGate;
        if (params.granularity === "summary") await options.monthlyGate;
        if (options.metricsFailure) throw new UpstreamError("UPSTREAM_NETWORK_ERROR", "fixture unavailable");
      } else await options.playbackGate;
      const filters = JSON.parse(params.dimensionFilters ?? "{}");
      const dates = params.granularity === "summary" ? [""] : allDates;
      return envelope(dates.flatMap(date => params.metricCodes.split(",").flatMap(code => {
        const status = path === BI_V1_PLAYBACK_API ? "READY" : options.status?.(code, date) ?? "READY";
        if (status === "empty") return [];
        const ratio = ratios.has(code) || code === "M110";
        const scalar = options.zeroInputs && ["M095", "M002"].includes(code) ? 0 : code === "M058" ? 12.34 : code === "M102" ? 7200 : code === "M034" ? 1 : 2;
        const numerator = ratio ? 1 : scalar;
        const ready = status === "READY" || status === "invalid";
        return [{ metricCode: code, ...(date ? { businessDate: date } : {}), dimensions: { pid: "PH", ...filters,
          ...(path === BI_V1_PLAYBACK_API ? { videoType: "short_video" } : {}) },
          value: ready ? ratio ? 0.5 : scalar : null, numerator, denominator: ratio ? 2 : 0,
          unit: status === "invalid" ? "currency" : code === "M058" ? "currency" : code === "M102" ? "seconds" : code === "M110" ? "count_per_user" : ratio ? "ratio" : "count",
          dataStatus: status === "invalid" ? "READY" : status, metricVersion: "bi-v1",
          ruleVersion: code === "M058" ? "paid-order-value-rmb-v2" : code === "M102" ? "foreground-watch-duration-v1"
            : ["M034", "M036"].includes(code) ? BI_V1_EFFECTIVE_PLAY_RULE_VERSION : "channel-dependency-fixture-v1" }];
      })));
    }
    if (path.endsWith("pDaySum")) {
      await options.dailyGate;
      return { msg: { totalCount: allDates.length, pageData: allDates.map(sumDate => ({ pid: "PH", sumDate,
        loginUserCount: 100, registerUserCount: 10, watchUserCount: 60 })) } };
    }
    if (path.includes("reletionsStatPlus")) { await options.cohortGate; return { data: [] }; }
    if (path === PAYMENT_RATE_API) { await options.paymentGate; return { msg: { pid: "PH", sumDate: params.startTime.slice(0, 10), pageData: [], totalAllCount: 4, totalSurCount: 2 } }; }
    return { msg: [] };
  } };
  const logger = { info: (value: (typeof logs)[number]) => { logs.push(value); } };
  return { client, channels, logs, service: new DailyDashboardService(client, now, logger, { sourceReadTimeoutMs: 1000 }) };
}
const point = (result: DailyDashboardV2Success, id: string, date = selectedDates.at(-1)!) => result.data.series.find(series => series.metric.id === id)!.points.find(value => value.date === date)!;
function assertProjection(actual: DailyDashboardV2Success, expected: DailyDashboardV2Success) {
  expect(actual.data.series).toEqual(expected.data.series);
  expect(actual.data.series.map(series => series.metric.id)).toEqual([...OPERATING_METRIC_IDS]);
  expect(actual.data.series.every(series => series.points.map(point => point.date).join() === selectedDates.join())).toBe(true);
  expect(actual.data.sourceApiIds).toEqual(expected.data.sourceApiIds);
}

describe("经营快照按最终投影保留渠道依赖", () => {
  for (const status of ["READY", "PROCESSING", "FAILED", "NOT_MATURE"] as const) test(`${status}现代结果不等待无用途渠道，93列三期保持`, async () => {
    const options = { status: () => status };
    const held = fixture({ ...options, holdChannel: true }), baseline = fixture(options);
    const result = await held.service.execute(query);
    assertProjection(result, await baseline.service.execute(query));
    expect(held.channels).toHaveLength(3);
    expect(held.channels.every(read => read.signal?.aborted)).toBe(true);
    const source = held.logs[0].sources.find(source => source.sourceId === "channel")!;
    expect(source).toMatchObject({ readCallCount: 3, successfulReadCallCount: 0, failedReadCallCount: 0, cancelledReadCallCount: 3, budgetExpired: false, errorCodeCounts: {} });
    const before = JSON.stringify(result);
    held.channels.forEach(read => read.resolve()); await flush();
    expect(JSON.stringify(result)).toBe(before);
  });

  for (const status of ["SOURCE_INCOMPLETE", "empty", "invalid"] as const) test(`${status}现代结果保留可用旧渠道`, async () => {
    const held = fixture({ status: () => status, holdChannel: true });
    const pending = held.service.execute(query);
    await flush();
    expect(held.channels).toHaveLength(3);
    expect(held.channels.every(read => !read.signal?.aborted)).toBe(true);
    held.channels.forEach(read => read.resolve());
    const result = await pending;
    expect(point(result, "M003")).toMatchObject({ state: "available", value: 6 });
    expect(point(result, "M005")).toMatchObject({ state: "available", value: 0.75 });
    expect(held.logs[0].sources.find(source => source.sourceId === "channel")!.cancelledReadCallCount).toBeUndefined();
  });

  test("现代传输失败仍等待合法旧源，不把失败当成无回退需求", async () => {
    const held = fixture({ metricsFailure: true, holdChannel: true });
    const pending = held.service.execute(query); await flush();
    expect(held.channels.every(read => !read.signal?.aborted)).toBe(true);
    held.channels.forEach(read => read.resolve());
    const result = await pending;
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
    expect(held.channels.every(read => read.signal?.aborted)).toBe(true);
    held.channels.forEach(read => read.resolve());
  });

  test("有效READY比率优先于READY基础输入派生", async () => {
    const held = fixture({ holdChannel: true });
    const result = await held.service.execute(query);
    expect(point(result, "M006")).toMatchObject({ state: "available", value: 0.5, sourceStatus: "READY" });
    expect(point(result, "M006").inputs.map(input => input.value)).toEqual([1, 2]);
    held.channels.forEach(read => read.resolve());
  });

  test("只取消无用途日期，需要旧源的日期保持原请求并等待", async () => {
    const status = (_code: string, date: string): ModernStatus => date === selectedDates[1] ? "SOURCE_INCOMPLETE" : "READY";
    const held = fixture({ holdChannel: true, status }), baseline = fixture({ status });
    const pending = held.service.execute(query); let completed = false;
    void pending.then(() => { completed = true; });
    await flush();
    expect(held.channels.map(read => read.signal?.aborted)).toEqual([true, false, true]);
    expect(completed).toBe(false);
    held.channels[1].resolve();
    const result = await pending;
    assertProjection(result, await baseline.service.execute(query));
    expect(point(result, "M005", selectedDates[1])).toMatchObject({ value: 0.75, state: "available" });
    expect(held.logs[0].sources.find(source => source.sourceId === "channel")).toMatchObject({ readCallCount: 3, successfulReadCallCount: 1, failedReadCallCount: 0, cancelledReadCallCount: 2, budgetExpired: false });
    held.channels.forEach(read => read.resolve());
  });

  test("晚到现代不完整时保留已先成功的旧渠道，渠道仍在原时点启动", async () => {
    const modern = deferred();
    const held = fixture({ modernGate: modern.promise, status: () => "SOURCE_INCOMPLETE" });
    const pending = held.service.execute(query); await flush();
    expect(held.channels).toHaveLength(3);
    expect(held.channels.map(read => read.date)).toEqual(selectedDates);
    expect(held.channels.every(read => read.params.page === "1" && read.params.count === "1")).toBe(true);
    modern.resolve();
    const result = await pending;
    expect(point(result, "M005")).toMatchObject({ value: 0.75, state: "available" });
    expect(point(result, "M006")).toMatchObject({ value: 1.5, state: "available" });
  });

  for (const gate of ["dailyGate", "modernGate"] as const) test(`${gate}完成前保留渠道，使用完整输入判定回退`, async () => {
    const dependency = deferred(), held = fixture({ [gate]: dependency.promise, holdChannel: true });
    const pending = held.service.execute(query); await flush();
    expect(held.channels.every(read => !read.signal?.aborted)).toBe(true);
    dependency.resolve(); await pending;
    expect(held.channels.every(read => read.signal?.aborted)).toBe(true);
    held.channels.forEach(read => read.resolve());
  });

  for (const gate of ["playbackGate", "monthlyGate", "cohortGate", "paymentGate"] as const) test(`${gate}未完成时已无用途渠道立即释放，完整投影保持`, async () => {
    const unrelated = deferred(), held = fixture({ [gate]: unrelated.promise, holdChannel: true });
    const pending = held.service.execute(query); let completed = false;
    void pending.then(() => { completed = true; });
    await flush();
    const cancelled = held.channels.map(read => read.signal?.aborted);
    const completedBeforeRelease = completed;
    unrelated.resolve();
    const result = await pending;
    expect(cancelled).toEqual([true, true, true]);
    expect(completedBeforeRelease).toBe(false);
    assertProjection(result, await fixture().service.execute(query));
    held.channels.forEach(read => read.resolve());
  });

  test("无关慢来源保持读取时按日期释放渠道，保留仍需旧源的日期", async () => {
    const playback = deferred();
    const status = (_code: string, date: string): ModernStatus => date === selectedDates[1] ? "SOURCE_INCOMPLETE" : "READY";
    const held = fixture({ status, playbackGate: playback.promise, holdChannel: true });
    const pending = held.service.execute(query);
    await flush();
    const cancelled = held.channels.map(read => read.signal?.aborted);
    held.channels[1].resolve();
    playback.resolve();
    const result = await pending;
    expect(cancelled).toEqual([true, false, true]);
    assertProjection(result, await fixture({ status }).service.execute(query));
    held.channels.forEach(read => read.resolve());
  });

  test("无关慢播放仍在途时释放三个物理槽供后续读取使用，默认40容量保持", async () => {
    const base = fixture();
    const playback = deferred(), background = deferred();
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
        if (url.pathname === BI_V1_PLAYBACK_API) await playback.promise;
        return Response.json(await base.client.get(url.pathname, params));
      } finally { active--; }
    });
    const pending = new DailyDashboardService(upstream, now, undefined, { sourceReadTimeoutMs: 1000 }).execute(query);
    await flush();
    const blockers = Array.from({ length: 36 }, (_, index) => upstream.get("/api/fixture/background", { pid: "PH", index: String(index) }));
    const later = Array.from({ length: 3 }, (_, index) => upstream.get("/api/fixture/later", { pid: "PH", index: String(index) }));
    await flush();
    const dispatchedBeforePlayback = dispatched.filter(path => path === "/api/fixture/later").length;
    const cancelledBeforePlayback = physicalChannels.map(signal => signal.aborted);
    playback.resolve(); background.resolve();
    const [result] = await Promise.all([pending, ...blockers, ...later]);
    expect(dispatchedBeforePlayback).toBe(3);
    expect(cancelledBeforePlayback).toEqual([true, true, true]);
    expect(peak).toBe(40);
    expect(active).toBe(0);
    assertProjection(result, await fixture().service.execute(query));
  });

  test("默认121整板保留全部渠道日期与独立旧源指标", async () => {
    const held = fixture({ holdChannel: true });
    const { projection: _projection, ...fullQuery } = query;
    const pending = held.service.execute(fullQuery); await flush();
    expect(held.channels).toHaveLength(3);
    expect(held.channels.every(read => !read.signal?.aborted)).toBe(true);
    for (let index = 0; index < allDates.length; index++) {
      held.channels[index].resolve(); await flush();
    }
    const result = await pending;
    expect(result.data.series).toHaveLength(121);
    expect(held.channels.map(read => read.date)).toEqual(allDates);
    expect(point(result, "M065")).toMatchObject({ state: "available", value: 12.34 });
    expect(held.logs[0].sources.find(source => source.sourceId === "channel")!.cancelledReadCallCount).toBeUndefined();
  });

  test("局部逻辑取消保留同一渠道请求的健康共享消费者", async () => {
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
    expect(physical).toHaveLength(3);
    expect(physical.map(read => read.signal?.aborted)).toEqual([false, true, true]);
    expect(cancelledBeforePlayback).toEqual([false, true, true]);
    physical[0].resolve();
    expect(await healthy).toEqual(channelPayload(selectedDates[0]));
    expect(healthyController.signal.aborted).toBe(false);
  });
});
