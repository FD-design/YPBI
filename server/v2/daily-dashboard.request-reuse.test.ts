import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { dailyDashboardSuccessSchema, type DailyDashboardQuery } from "../../contracts/daily-dashboard";
import { OPERATING_METRIC_IDS, operatingSnapshotDates } from "../../contracts/operating-detail-projection";
import { loadEnv } from "../config/env";
import { platformRegistry } from "../platforms/registry";
import { UpstreamClient } from "../upstream/client";
import { getEventListeners } from "node:events";
import { BI_V1_EFFECTIVE_PLAY_RULE_VERSION, BI_V1_PLAYBACK_API } from "../upstream/bi-v1.adapter";
import { BI_V1_METRICS_API } from "../upstream/bi-v1.metrics-adapter";
import { legacyChannelDateParams } from "../upstream/channel-date";
import { CHANNEL_V2_API, DailyDashboardService, PAYMENT_RATE_API } from "./daily-dashboard.service";

const query: DailyDashboardQuery = { boardId: "5.2", pid: "PH", dateRange: ["2026-10-05", "2026-10-12"] };
const snapshotQuery: DailyDashboardQuery = { ...query, projection: "operating_snapshot" };
const now = () => new Date("2026-10-14T00:00:00Z");
const ratios = new Set(["M005", "M006", "M007", "M020", "M021", "M022", "M023", "M036", "M061", "M064", "M081", "M090", "M099", "M103", "M111", "M114"]);

function fixture(invalidRetention = false, holdReads = false, options: {
  beforeRead?: (read: { path: string; params: Record<string, string> }, signal?: AbortSignal | null) => Promise<void>;
} = {}) {
  const reads: { path: string; params: Record<string, string> }[] = [];
  const heldReads: (() => void)[] = [];
  let activeReads = 0, peakReads = 0;
  const client = new UpstreamClient(loadEnv({ NODE_ENV: "test", UPSTREAM_API_BASE_URL: "https://in-memory.invalid",
    UPSTREAM_USER_NAME: "in-memory-user", UPSTREAM_X_TOKEN: "in-memory-token",
    UPSTREAM_SECONDARY_API_BASE_URL: "https://in-memory.invalid", UPSTREAM_SECONDARY_USER_NAME: "in-memory-secondary-user", UPSTREAM_SECONDARY_X_TOKEN: "in-memory-secondary-token",
    UPSTREAM_CREDENTIALS_FILE: `/private/tmp/ypbi-read-reuse-absent-${randomUUID()}.json` }), async (input, init) => {
    const url = new URL(String(input)), params = Object.fromEntries(url.searchParams);
    reads.push({ path: url.pathname, params });
    peakReads = Math.max(peakReads, ++activeReads);
    try {
      if (holdReads) await new Promise<void>(resolve => heldReads.push(resolve));
      await options.beforeRead?.({ path: url.pathname, params }, init?.signal);
      let payload: unknown;
      if ([BI_V1_METRICS_API, BI_V1_PLAYBACK_API].includes(url.pathname)) {
        const filters = JSON.parse(params.dimensionFilters ?? "{}");
        const dates: string[] = [];
        if (params.granularity === "summary") dates.push("");
        else for (let day = Date.parse(params.startDate); day < Date.parse(params.endDate); day += 86_400_000)
          dates.push(new Date(day).toISOString().slice(0, 10));
        const rows = dates.flatMap(date => params.metricCodes.split(",").map(metricCode => {
          const ratio = ratios.has(metricCode) || metricCode === "M110";
          const numerator = ratio ? invalidRetention && ["M020", "M021", "M022", "M023"].includes(metricCode) ? 3 : 1
            : metricCode === "M058" ? 12.34 : metricCode === "M102" ? 64 : 2;
          const denominator = ratio ? 2 : 0;
          return { metricCode, ...(date ? { businessDate: date } : {}), dimensions: { pid: params.pid, ...filters,
            ...(url.pathname === BI_V1_PLAYBACK_API ? { videoType: "short_video" } : {}) },
            numerator, denominator, value: ratio ? numerator / denominator : numerator,
            unit: metricCode === "M058" ? "currency" : metricCode === "M102" ? "seconds" : metricCode === "M110" ? "count_per_user" : ratio ? "ratio" : "count",
            dataStatus: "READY", metricVersion: "bi-v1", ruleVersion: metricCode === "M058" ? "paid-order-value-rmb-v2"
              : metricCode === "M102" ? "foreground-watch-duration-v1" : ["M034", "M036"].includes(metricCode) ? BI_V1_EFFECTIVE_PLAY_RULE_VERSION : "in-memory-v1" };
        }));
        // The playback numerator has its independent count projection.
        if (url.pathname === BI_V1_PLAYBACK_API) rows.filter(row => row.metricCode === "M034").forEach(row => {
          row.numerator = 1; row.value = 1;
        });
        payload = { code: 200, msg: { metricVersion: "bi-v1", generatedAt: now().toISOString(), watermark: null, rows } };
      } else if (url.pathname.endsWith("pDaySum")) payload = { code: 200, msg: { totalCount: 0, pageData: [] } };
      else if (url.pathname.includes("reletionsStatPlus")) payload = { code: 200, data: [] };
      else if (url.pathname === CHANNEL_V2_API) payload = { code: 200, msg: { pageData: [], totalData: [] } };
      else if (url.pathname === PAYMENT_RATE_API) payload = { code: 200, msg: { pageData: [] } };
      else payload = { code: 200, msg: [] };
      return new Response(JSON.stringify(payload), { status: 200 });
    } finally { activeReads--; }
  });
  return { client, reads, service: new DailyDashboardService(client, now), releaseHeld() { heldReads.splice(0).forEach(resolve => resolve()); },
    peakReads: () => peakReads, activeReads: () => activeReads };
}

describe("经营快照与整板同源查询复用", () => {
  test("已取消经营查询不读取HTTP，中途取消不投影迟到结果且共享健康查询继续", async () => {
    const delayed = fixture(false, true), first = new AbortController(), second = new AbortController();
    first.abort();
    await expect(delayed.service.execute(snapshotQuery, first.signal)).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT" });
    expect(delayed.reads).toHaveLength(0);
    const cancelling = new AbortController();
    const cancelledResult = delayed.service.execute(snapshotQuery, cancelling.signal).catch(error => error);
    const healthy = delayed.service.execute(snapshotQuery, second.signal);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(delayed.reads).toHaveLength(22);
    cancelling.abort();
    expect(await cancelledResult).toMatchObject({ code: "UPSTREAM_TIMEOUT" });
    expect(getEventListeners(cancelling.signal, "abort")).toHaveLength(0);
    delayed.releaseHeld();
    const healthyResult = await healthy;
    expect(healthyResult.data.series.map(series => series.metric.id)).toEqual([...OPERATING_METRIC_IDS]);
    expect(healthyResult.data.series.find(series => series.metric.id === "M016")!.points.at(-1)).toMatchObject({ state: "available", value: 2, sourceStatus: "READY" });
    expect(getEventListeners(second.signal, "abort")).toHaveLength(0);
    expect(delayed.reads).toHaveLength(22);
  });

  test("单平台经营12个独立指标组可及时使用空闲物理槽，93组三期结果不变", async () => {
    const delayed = fixture(false, true), baseline = fixture();
    const result = delayed.service.execute(snapshotQuery);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(delayed.reads).toHaveLength(22);
    expect(delayed.reads.filter(read => read.path === BI_V1_METRICS_API && read.params.granularity === "day")).toHaveLength(12);
    delayed.releaseHeld();
    const [actual, expected] = await Promise.all([result, baseline.service.execute(snapshotQuery)]);
    expect(actual.data.series).toEqual(expected.data.series);
    expect(actual.data.series.map(series => series.metric.id)).toEqual([...OPERATING_METRIC_IDS]);
  });

  test("20平台经营冷读共享40个物理槽，全部440次来源读取与93组三期结果完整", async () => {
    const delayed = fixture(false, true);
    const platforms = platformRegistry.filter(platform => platform.enabled);
    expect(platforms).toHaveLength(20);
    let finished = false;
    const results = Promise.all(platforms.map(platform => delayed.service.execute({ ...snapshotQuery, pid: platform.pid })));
    void results.then(() => { finished = true; });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(delayed.reads).toHaveLength(40);
    for (let batch = 0; batch < 30 && !finished; batch++) {
      delayed.releaseHeld();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(delayed.peakReads()).toBeLessThanOrEqual(40);
    }
    expect(finished).toBe(true);
    const actual = await results;
    expect(delayed.reads).toHaveLength(440);
    for (const [index, result] of actual.entries()) {
      expect(result.data.query.pid).toBe(platforms[index].pid);
      expect(result.data.series.map(series => series.metric.id)).toEqual([...OPERATING_METRIC_IDS]);
      expect(result.data.series.every(series => series.points.map(point => point.date).join() === operatingSnapshotDates(query.dateRange).join())).toBe(true);
      expect(result.data.series.find(series => series.metric.id === "M016")!.points.every(point => point.state === "available" && point.sourceStatus === "READY" && point.value === 2)).toBe(true);
      expect(dailyDashboardSuccessSchema.safeParse(result).success).toBe(true);
    }
  });

  test("20平台无关分组挂起时释放无用途渠道并恢复队尾，健康共享消费者和93列三期保持", async () => {
    const platforms = platformRegistry.filter(platform => platform.enabled);
    expect(platforms).toHaveLength(20);
    const selectedDates = operatingSnapshotDates(query.dateRange);
    const channelSignals: Array<{ pid: string; date: string; signal?: AbortSignal | null }> = [];
    const releaseChannels: Array<() => void> = [];
    let releaseUnrelated!: () => void;
    const unrelated = new Promise<void>(resolve => { releaseUnrelated = resolve; });
    let laterStarted = false;
    const delayed = fixture(false, false, { beforeRead: async ({ path, params }, signal) => {
      if (path === CHANNEL_V2_API) {
        channelSignals.push({ pid: params.pid, date: params.sumDateBegin.slice(0, 10), signal });
        await new Promise<void>((resolve, reject) => {
          const abort = () => { signal?.removeEventListener("abort", abort); reject(new DOMException("fixture cancelled", "AbortError")); };
          if (signal?.aborted) { abort(); return; }
          signal?.addEventListener("abort", abort, { once: true });
          releaseChannels.push(() => { signal?.removeEventListener("abort", abort); resolve(); });
        });
      } else if (path === BI_V1_METRICS_API && params.dimensionFilters === '{"paymentMethod":"ali_pay"}') {
        await unrelated;
      } else if (path === "/api/fixture/healthy-later") laterStarted = true;
    } });
    const sharedController = new AbortController();
    let sharedCompleted = false, snapshotsCompleted = false;
    const shared = delayed.client.get(CHANNEL_V2_API, { pid: "PH", page: "1", count: "1",
      ...legacyChannelDateParams([selectedDates[0], selectedDates[0]]) }, undefined, sharedController.signal)
      .then(result => { sharedCompleted = true; return result; });
    const snapshots = Promise.all(platforms.map(platform => delayed.service.execute({ ...snapshotQuery, pid: platform.pid })));
    void snapshots.then(() => { snapshotsCompleted = true; });
    const later = delayed.client.get("/api/fixture/healthy-later", { pid: "PH" });
    for (let turn = 0; turn < 30 && !laterStarted; turn++) await new Promise<void>(resolve => setImmediate(resolve));
    const checkpoint = {
      laterStarted, sharedCompleted, snapshotsCompleted,
      unrelatedCount: delayed.reads.filter(read => read.path === BI_V1_METRICS_API && read.params.dimensionFilters === '{"paymentMethod":"ali_pay"}').length,
      sharedChannels: channelSignals.filter(read => read.pid === "PH" && read.date === selectedDates[0]).map(read => read.signal?.aborted),
      otherChannels: channelSignals.filter(read => read.pid !== "PH" || read.date !== selectedDates[0]).map(read => read.signal?.aborted)
    };
    releaseUnrelated(); releaseChannels.forEach(release => release());
    const [actual, sharedResult] = await Promise.all([snapshots, shared, later]);
    const baseline = fixture();
    const expected = await Promise.all(platforms.map(platform => baseline.service.execute({ ...snapshotQuery, pid: platform.pid })));
    expect(checkpoint.laterStarted).toBe(true);
    expect(checkpoint.sharedCompleted).toBe(false);
    expect(checkpoint.snapshotsCompleted).toBe(false);
    expect(checkpoint.unrelatedCount).toBe(20);
    expect(checkpoint.sharedChannels).toEqual([false]);
    expect(checkpoint.otherChannels).toHaveLength(59);
    expect(checkpoint.otherChannels.every(aborted => aborted)).toBe(true);
    expect(sharedResult).toEqual({ code: 200, msg: { pageData: [], totalData: [] } });
    expect(sharedController.signal.aborted).toBe(false);
    expect(delayed.peakReads()).toBe(40);
    expect(delayed.activeReads()).toBe(0);
    for (const [index, result] of actual.entries()) {
      expect(result.data.query.pid).toBe(platforms[index].pid);
      expect(result.data.series).toEqual(expected[index].data.series);
      expect(result.data.sourceApiIds).toEqual(expected[index].data.sourceApiIds);
      expect(result.data.series.map(series => series.metric.id)).toEqual([...OPERATING_METRIC_IDS]);
      expect(result.data.series.every(series => series.points.map(point => point.date).join() === selectedDates.join())).toBe(true);
      expect(dailyDashboardSuccessSchema.safeParse(result).success).toBe(true);
    }
  });

  test("同新用户指标集合使用一致请求顺序，复用一次上游HTTP而不混用93/121响应", async () => {
    const { reads, service } = fixture();
    const [full, snapshot] = await Promise.all([service.execute(query), service.execute(snapshotQuery)]);
    const newCohortReads = reads.filter(read => read.path === BI_V1_METRICS_API
      && read.params.dimensionFilters === '{"userCohort":"new"}');
    expect(newCohortReads).toHaveLength(1);
    expect(reads).toHaveLength(45);
    expect(full.data.series).toHaveLength(121);
    expect(snapshot.data.series.map(series => series.metric.id)).toEqual([...OPERATING_METRIC_IDS]);
    for (const series of snapshot.data.series) {
      const original = full.data.series.find(item => item.metric.id === series.metric.id)!;
      expect(series.metric).toEqual(original.metric);
      expect(series.points).toEqual(original.points.filter(point => operatingSnapshotDates(query.dateRange).includes(point.date)));
    }
    for (const result of [full, snapshot]) expect(dailyDashboardSuccessSchema.safeParse(result).success).toBe(true);
  });

  test("注册留存率异常人数不能进入四个周期的留存人数M115投影", async () => {
    const { service } = fixture(true);
    const result = await service.execute(snapshotQuery);
    for (const id of ["M020", "M020.android", "M020.ios", "M020.natural", "M020.internal", "M021", "M022", "M023", "M115.d1", "M115.d3", "M115.d7", "M115.d30"]) {
      const series = result.data.series.find(item => item.metric.id === id)!;
      for (const point of series.points) {
        expect(point.value).toBeNull();
        expect(point.state).toBe("invalid_value");
        expect(point.inputs.every(input => input.value === null)).toBe(true);
      }
    }
    expect(result.data.series.find(item => item.metric.id === "M016")!.points.at(-1)).toMatchObject({ value: 2, state: "available" });
  });
});
