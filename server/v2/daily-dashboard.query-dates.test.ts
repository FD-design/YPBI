import { describe, expect, test } from "bun:test";
import type { DailyDashboardQuery } from "../../contracts/daily-dashboard";
import { dailyDashboardSuccessSchema } from "../../contracts/daily-dashboard";
import { UpstreamError } from "../upstream/client";
import { CHANNEL_V2_API, DailyDashboardService, dailyDashboardMatchesMapping, PAYMENT_RATE_API } from "./daily-dashboard.service";

const now = () => new Date("2026-10-14T00:00:00Z");
const shift = (date: string, days: number) => new Date(Date.parse(date) + days * 86_400_000).toISOString().slice(0, 10);
const emptyMetrics = { code: 200, msg: { metricVersion: "bi-v1", generatedAt: now().toISOString(), watermark: null, rows: [] } };
type Read = { path: string; params: Record<string, string> };

function fixtures(query: DailyDashboardQuery, fail = false) {
  const dates: string[] = [];
  for (let date = query.dateRange[0]; date <= query.dateRange[1]; date = shift(date, 1)) dates.push(date);
  const reads: Read[] = [];
  const client = { get: async (path: string, params: Record<string, string>) => {
    reads.push({ path, params });
    if (fail) throw new UpstreamError("UPSTREAM_NETWORK_ERROR", "fixture source failure", 502);
    if (path === "/api/admin/bi/v1/metrics" || path === "/api/admin/bi/v1/playback") return emptyMetrics;
    if (path.endsWith("pDaySum")) return { msg: { pageData: dates.map(sumDate => ({ pid: query.pid, sumDate,
      loginUserCount: 4, registerUserCount: 2, watchUserCount: 3, navCount: 0, totalClickedCount: 6,
      navClickedPerson: 0, totalClickedPerson: 2 })), totalCount: dates.length } };
    if (path.includes("reletionsStatPlus")) return { data: [] };
    if (path === PAYMENT_RATE_API) return { msg: { pid: query.pid, sumDate: params.startTime.slice(0, 10), pageData: [], totalAllCount: 4, totalSurCount: 2 } };
    if (path === CHANNEL_V2_API) return { msg: { pageData: [], totalData: [{ pid: query.pid, sumDate: params.sumDateBegin.slice(0, 10),
      vipChargeAmt: params.sumDateBegin.startsWith(query.dateRange[0]) ? 0 : 12.34, goldChargeAmt: 0, newUserVipChargeAmt: 0, newUserGoldChargeAmt: 0 }] } };
    if (path.endsWith("pRealDayLine")) return { msg: [] };
    throw new Error("Unexpected fixture source");
  } };
  return { dates, reads, client };
}

describe("daily dashboard query date reuse", () => {
  for (const [name, start, end, dayCount] of [
    ["8 business days", "2026-10-05", "2026-10-12", 8],
    ["42 days across leap day and month boundaries", "2024-02-22", "2024-04-03", 42],
    ["366 days in a leap year", "2024-01-01", "2024-12-31", 366],
    ["future business days", "2026-10-10", "2026-10-17", 8]
  ] as const) {
    test(`${name} preserve every series, source order, and inclusive query range`, async () => {
      const query: DailyDashboardQuery = { boardId: "5.2", pid: "PH", dateRange: [start, end] };
      const { dates, reads, client } = fixtures(query);
      const result = await new DailyDashboardService(client, now, undefined, { sourceReadTimeoutMs: 60_000 }).execute(query);
      expect(dates).toHaveLength(dayCount);
      expect(result.data.query).toEqual(query);
      expect(result.data.series).toHaveLength(121);
      for (const series of result.data.series) {
        expect(series.points.map(point => point.date)).toEqual(dates);
        expect(series.periodStatistics?.dayCount).toBe(dayCount);
      }
      expect(reads.filter(read => read.path === PAYMENT_RATE_API).map(read => read.params.startTime.slice(0, 10))).toEqual(dates);
      expect(reads.filter(read => read.path === CHANNEL_V2_API).map(read => read.params.sumDateBegin.slice(0, 10))).toEqual(dates);
      expect(reads.filter(read => read.path.endsWith("pRealDayLine")).map(read => read.params.startDate.slice(0, 10))).toEqual(dates.filter(date => date < "2026-10-14"));
      const grouped = reads.filter(read => read.path === "/api/admin/bi/v1/metrics" && read.params.granularity === "day");
      expect(grouped).toHaveLength(16);
      expect(grouped.every(read => read.params.startDate === start && read.params.endDate === shift(end, 1))).toBe(true);
      const amounts = result.data.series.find(series => series.metric.id === "M065")!;
      expect(amounts.points.map(point => point.value)).toEqual(dates.map((_, index) => index ? 12.34 : 0));
      if (end >= "2026-10-14") expect(result.data.series.find(series => series.metric.id === "M101")!.points.filter(point => point.date >= "2026-10-14").every(point => point.state === "no_value" && point.value === null)).toBe(true);
      expect(dailyDashboardSuccessSchema.safeParse(result).success).toBe(true);
      expect(dailyDashboardMatchesMapping(result)).toBe(true);
    });
  }

  test("failed source groups retain all dates, null inputs, and original read counts across leap day", async () => {
    const query: DailyDashboardQuery = { boardId: "5.2", pid: "PH", dateRange: ["2024-02-26", "2024-03-04"] };
    const { dates, reads, client } = fixtures(query, true);
    const result = await new DailyDashboardService(client, now, undefined, { sourceReadTimeoutMs: 60_000 }).execute(query);
    expect(dates).toContain("2024-02-29");
    expect(reads).toHaveLength(45); // The range intersects two independently queried natural months.
    for (const series of result.data.series) expect(series.points.map(point => point.date)).toEqual(dates);
    expect(result.data.series.find(series => series.metric.id === "M065")!.points.every(point => point.state === "source_failure"
      && point.value === null && point.inputs.every(input => input.value === null) && !point.sourceStatus)).toBe(true);
    expect(reads.filter(read => read.path === CHANNEL_V2_API).map(read => read.params.sumDateBegin.slice(0, 10))).toEqual(dates);
    expect(dailyDashboardSuccessSchema.safeParse(result).success).toBe(true);
    expect(dailyDashboardMatchesMapping(result)).toBe(true);
  });
});
