import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { dailyDashboardSuccessSchema, type DailyDashboardQuery } from "../../contracts/daily-dashboard";
import { OPERATING_METRIC_IDS, operatingSnapshotDates } from "../../contracts/operating-detail-projection";
import { loadEnv } from "../config/env";
import { UpstreamClient } from "../upstream/client";
import { BI_V1_EFFECTIVE_PLAY_RULE_VERSION, BI_V1_PLAYBACK_API } from "../upstream/bi-v1.adapter";
import { BI_V1_METRICS_API } from "../upstream/bi-v1.metrics-adapter";
import { CHANNEL_V2_API, DailyDashboardService, PAYMENT_RATE_API } from "./daily-dashboard.service";

const query: DailyDashboardQuery = { boardId: "5.2", pid: "PH", dateRange: ["2026-10-05", "2026-10-12"] };
const snapshotQuery: DailyDashboardQuery = { ...query, projection: "operating_snapshot" };
const now = () => new Date("2026-10-14T00:00:00Z");
const ratios = new Set(["M005", "M006", "M007", "M020", "M021", "M022", "M023", "M036", "M061", "M064", "M081", "M090", "M099", "M103", "M111", "M114"]);

function fixture(invalidRetention = false) {
  const reads: { path: string; params: Record<string, string> }[] = [];
  const client = new UpstreamClient(loadEnv({ NODE_ENV: "test", UPSTREAM_API_BASE_URL: "https://in-memory.invalid",
    UPSTREAM_USER_NAME: "in-memory-user", UPSTREAM_X_TOKEN: "in-memory-token",
    UPSTREAM_CREDENTIALS_FILE: `/private/tmp/ypbi-read-reuse-absent-${randomUUID()}.json` }), async input => {
    const url = new URL(String(input)), params = Object.fromEntries(url.searchParams);
    reads.push({ path: url.pathname, params });
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
          dataStatus: "READY", metricVersion: "bi-v1", ruleVersion: metricCode === "M058" ? "paid-order-value-v1"
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
  });
  return { reads, service: new DailyDashboardService(client, now) };
}

describe("经营快照与整板同源查询复用", () => {
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
