import { describe, expect, test } from "bun:test";
import { dailyDashboardMatchesQuery, dailyDashboardSuccessSchema, type DailyDashboardQuery } from "../../contracts/daily-dashboard";
import { DailyDashboardService, dailyDashboardCatalog, dailyDashboardMatchesMapping, CHANNEL_V2_API } from "./daily-dashboard.service";

const dates = Array.from({ length: 8 }, (_, i) => `2020-01-${String(i + 1).padStart(2, "0")}`);
const query: DailyDashboardQuery = { boardId: "5.2", pid: "PH", dateRange: [dates[0], dates.at(-1)!] };
type Row = { metricCode: string; businessDate: string; dimensions: Record<string, string>; value: number | null; numerator: number; denominator: number; unit: string; dataStatus: string; metricVersion: string; ruleVersion: string };
const metricRow = (metricCode: string, date: string, value: number | null, extra: Partial<Row> = {}): Row => ({
  metricCode, businessDate: date, dimensions: { pid: "PH" }, value, numerator: value ?? 0, denominator: 0,
  unit: "count", dataStatus: "READY", metricVersion: "bi-v1", ruleVersion: "source-budget-fixture-v1", ...extra
});
const formalRows = dates.flatMap(date => [
  metricRow("M016", date, 6), metricRow("M026", date, null, { dataStatus: "PROCESSING" }),
  metricRow("M008", date, 3), metricRow("M095", date, 3), metricRow("M002", date, 4),
  metricRow("M006", date, null, { unit: "ratio", dataStatus: "PROCESSING" }),
  metricRow("M007", date, null, { unit: "ratio", dataStatus: "FAILED" }),
  metricRow("M081", date, null, { unit: "ratio", dimensions: { pid: "PH", userCohort: "new" }, numerator: 1, denominator: 2, dataStatus: "SOURCE_INCOMPLETE" })
]);
const now = () => new Date("2026-10-14T00:00:00Z");

function fixtures(channel: (date: string, signal?: AbortSignal) => Promise<unknown>) {
  return { get: async (path: string, params: Record<string, string>, _token?: string, signal?: AbortSignal) => {
    if (path === CHANNEL_V2_API) return channel(params.sumDateBegin.slice(0, 10), signal);
    if (path === "/api/admin/bi/v1/metrics") {
      const filters: Record<string, string> = JSON.parse(params.dimensionFilters ?? "{}");
      const codes = new Set(params.metricCodes.split(","));
      return { code: 200, msg: { metricVersion: "bi-v1", generatedAt: now().toISOString(), watermark: null,
        rows: formalRows.filter(row => codes.has(row.metricCode)
          && JSON.stringify(Object.fromEntries(Object.entries(row.dimensions).filter(([key]) => key !== "pid"))) === JSON.stringify(filters)) } };
    }
    if (path.endsWith("pDaySum")) return { msg: { pageData: dates.map(sumDate => ({ pid: "PH", sumDate, loginUserCount: 99, registerUserCount: 99, watchUserCount: 99 })), totalCount: dates.length } };
    return { msg: { pageData: [], totalData: [], totalCount: 0 }, data: [] };
  } };
}
const series = (result: Awaited<ReturnType<DailyDashboardService["execute"]>>, id: string) => result.data.series.find(row => row.metric.id === id)!;

describe("daily dashboard bounded independent sources", () => {
  test("each stalled legacy day expires independently without overwriting healthy formal values", async () => {
    const attempted: string[] = [];
    const signals: Array<AbortSignal | undefined> = [];
    const result = await new DailyDashboardService(fixtures(async (date, signal) => {
      attempted.push(date);
      signals.push(signal);
      return new Promise(() => {});
    }), now, undefined, { sourceReadTimeoutMs: 100 }).execute(query);
    expect(attempted).toEqual(dates);
    expect(signals).toHaveLength(dates.length);
    expect(signals.every(signal => signal?.aborted)).toBe(true);
    expect(series(result, "M016").points.every(point => point.value === 6 && point.sourceStatus === "READY")).toBe(true);
    expect(series(result, "M026").points.every(point => point.state === "no_value" && point.value === null && point.sourceStatus === "PROCESSING")).toBe(true);
    expect(series(result, "M081.new").points.every(point => point.value === null && point.sourceStatus === "SOURCE_INCOMPLETE")).toBe(true);
    expect(series(result, "M065").points.every(point => point.state === "source_failure" && point.value === null && !point.sourceStatus)).toBe(true);
    expect(dailyDashboardSuccessSchema.safeParse(result).success).toBe(true);
    expect(dailyDashboardMatchesMapping(result)).toBe(true);
    expect(dailyDashboardMatchesQuery(result, query, dailyDashboardCatalog(true).data.items.find(board => board.id === "5.2")!.metricIds)).toBe(true);
  });

  test("existing READY fact derivation remains valid when the legacy channel times out", async () => {
    const result = await new DailyDashboardService(fixtures(async () => new Promise(() => {})), now, undefined, { sourceReadTimeoutMs: 100 }).execute(query);
    for (const [id, value] of [["M006", 1], ["M007", 0.75]] as const) {
      expect(series(result, id).points.every(point => point.state === "available" && point.value === value && point.sourceStatus === "READY")).toBe(true);
      expect(series(result, id).points[0].inputs.map(input => input.value)).toEqual(id === "M006" ? [3, 3] : [3, 4]);
    }
  });

  test("completed dates preserve real zero and amounts; pending dates remain failures", async () => {
    const attempted: string[] = [];
    const result = await new DailyDashboardService(fixtures(async date => {
      attempted.push(date);
      if (date === dates[0] || date === dates[1]) return { msg: { pageData: [], totalData: [{ pid: "PH", sumDate: date,
        vipChargeAmt: date === dates[0] ? 0 : 12.34, goldChargeAmt: 0, newUserVipChargeAmt: 0, newUserGoldChargeAmt: 0 }] } };
      return new Promise(() => {});
    }), now, undefined, { sourceReadTimeoutMs: 100 }).execute(query);
    expect(attempted).toEqual(dates);
    expect(series(result, "M065").points[0]).toMatchObject({ state: "available", value: 0, inputs: [{ value: 0 }] });
    expect(series(result, "M065").points[1]).toMatchObject({ state: "available", value: 12.34, inputs: [{ value: 12.34 }] });
    expect(series(result, "M065").points.slice(2).every(point => point.state === "source_failure" && point.value === null && point.inputs.every(input => input.value === null))).toBe(true);
    expect(series(result, "M065").metric.unit).toBe("元");
  });

  test("late raw responses do not mutate values or restart completed sequential date units", async () => {
    const completions: (() => void)[] = [];
    const attempted: string[] = [];
    const result = await new DailyDashboardService(fixtures(async date => {
      attempted.push(date);
      return new Promise(resolve => completions.push(() => resolve({ msg: { pageData: [], totalData: [{ pid: "PH", sumDate: date, vipChargeAmt: 999 }] } })));
    }), now, undefined, { sourceReadTimeoutMs: 100 }).execute(query);
    const before = JSON.stringify(result);
    completions.forEach(resolve => resolve());
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(JSON.stringify(result)).toBe(before);
    expect(attempted).toEqual(dates);
  });

  test("all completed source results are identical with and without diagnostic logging", async () => {
    const complete = async (date: string) => ({ msg: { pageData: [], totalData: [{ pid: "PH", sumDate: date, vipChargeAmt: 4, goldChargeAmt: 2, newUserVipChargeAmt: 0, newUserGoldChargeAmt: 0 }] } });
    const client = fixtures(complete);
    const withLogs = await new DailyDashboardService(client, now, { info: () => {} }, { sourceReadTimeoutMs: 1000 }).execute(query);
    const withoutLogs = await new DailyDashboardService(client, now, undefined, { sourceReadTimeoutMs: 1000 }).execute(query);
    const normalize = (value: typeof withLogs) => ({ ...value, data: { ...value.data, queryId: "fixed-query" } });
    expect(normalize(withLogs)).toEqual(normalize(withoutLogs));
    expect(series(withoutLogs, "M065").points.every(point => point.value === 4)).toBe(true);
  });
});
