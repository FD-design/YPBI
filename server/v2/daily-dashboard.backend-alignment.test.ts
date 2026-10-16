import { expect, test } from "bun:test";
import { dailyDashboardV2SuccessSchema } from "../../contracts/daily-dashboard";
import { OPERATING_METRIC_IDS } from "../../contracts/operating-detail-projection";
import { DailyDashboardService } from "./daily-dashboard.service";

const date = "2026-10-12";
const query = { boardId: "5.2", pid: "PH", dateRange: ["2026-10-05", date] as [string, string], projection: "operating_snapshot" as const };
const generatedAt = "2026-10-16T00:00:00Z";
const envelope = (rows: Record<string, unknown>[]) => ({ code: 200, msg: { metricVersion: "bi-v1", generatedAt, watermark: null, rows } });
type Change = (row: Record<string, unknown>, params: Record<string, string>) => Record<string, unknown>;

async function run(change: Change = row => row, pid = "PH") {
  const calls: Array<{ path: string; params: Record<string, string> }> = [];
  const result = await new DailyDashboardService({ get: async (path, params) => {
    calls.push({ path, params: { ...params } });
    if (path === "/api/admin/bi/v1/metrics") {
      if (params.metricCodes === "M018") return envelope([]);
      const filters = params.dimensionFilters ? JSON.parse(params.dimensionFilters) : {};
      const specifications: Record<string, [number, string]> = {
        M058: [filters.userCohort === "new" ? 141.02 : filters.sourceType === "natural" ? 138.02 : filters.sourceType === "internal_channel" ? 24 : 162.02, "currency"],
        M059: [filters.userCohort === "new" ? 3 : 5, "count"], M016: [6, "count"], M008: [3, "count"],
        M061: [5 / 6, "ratio"], M064: [1, "ratio"]
      };
      return envelope(params.metricCodes.split(",").filter(code => specifications[code]).map(code => {
        const [value, unit] = specifications[code];
        return change({ metricCode: code, businessDate: date, dimensions: { pid, ...filters }, value,
          numerator: code === "M061" ? 5 : code === "M064" ? 3 : value,
          denominator: code === "M061" ? 6 : code === "M064" ? 3 : 0,
          unit, dataStatus: "READY", metricVersion: "bi-v1",
          ruleVersion: code === "M058" ? "paid-order-value-rmb-v2" : "paid-order-value-v1" }, params);
      }));
    }
    if (path === "/api/admin/bi/v1/playback") return envelope([]);
    return { code: 200, msg: { pageData: [], totalData: [], totalCount: 0 }, data: [] };
  } }, () => new Date(generatedAt)).execute({ ...query, pid });
  const series = (id: string) => result.data.series.find(s => s.metric.id === id)!;
  const point = (id: string, day = date) => series(id).points.find(p => p.date === day)!;
  return { result, point, series, calls };
}

test("新版金额四列和四个人均金额使用现有同群输入，93列键及兄弟v1保持", async () => {
  for (const pid of ["PH", "FBI"]) {
    const { result, point } = await run(undefined, pid);
    expect(result.data.query.pid).toBe(pid);
    expect(result.data.series.map(s => s.metric.id)).toEqual([...OPERATING_METRIC_IDS]);
    expect(OPERATING_METRIC_IDS).toHaveLength(93);
    expect(new Set(OPERATING_METRIC_IDS).size).toBe(93);
    for (const [id, value] of Object.entries({ M058: 162.02, "M058.new": 141.02, "M058.nature": 138.02, "M058.internal": 24,
      M087: 162.02 / 6, M088: 141.02 / 3, M067: 162.02 / 5, "M067.new": 141.02 / 3,
      M059: 5, "M059.new": 3, M061: 5 / 6, M064: 1 })) {
      expect(point(id)).toMatchObject({ state: "available", sourceStatus: "READY", value });
    }
    dailyDashboardV2SuccessSchema.parse(result);
  }
});

test("旧版、未知版本和原币单位不能进入人民币及派生金额", async () => {
  for (const invalid of [{ ruleVersion: "paid-order-value-v1" }, { ruleVersion: "paid-order-value-rmb-v3" }, { unit: "USDT" }]) {
    const { point } = await run(row => row.metricCode === "M058" ? { ...row, ...invalid } : row);
    for (const id of ["M058", "M058.new", "M058.nature", "M058.internal", "M087", "M088", "M067", "M067.new"]) expect(point(id).value).toBeNull();
    expect(point("M059").value).toBe(5);
    expect(point("M061").value).toBe(5 / 6);
  }
});

test("金额真实0保留，人均金额只在分母大于0时产生值", async () => {
  const zeroAmount = await run(row => row.metricCode === "M058" ? { ...row, value: 0, numerator: 0 } : row);
  for (const id of ["M058", "M058.new", "M087", "M088", "M067", "M067.new"]) expect(zeroAmount.point(id)).toMatchObject({ state: "available", value: 0 });
  const zeroPeople = await run(row => ["M016", "M008", "M059"].includes(String(row.metricCode)) ? { ...row, value: 0, numerator: 0 } : row);
  for (const id of ["M087", "M088", "M067", "M067.new"]) expect(zeroPeople.point(id)).toMatchObject({ state: "zero_denominator", value: null });
});

test("派生金额不消费未完成输入、缺日、其他PID或其他人群", async () => {
  const invalids = [
    ...["PROCESSING", "SOURCE_INCOMPLETE", "NOT_MATURE", "FAILED"].map(dataStatus => ({ dataStatus, value: null })),
    { businessDate: "2026-10-11" }, { dimensions: { pid: "TT" } }, { dimensions: { pid: "PH", userCohort: "old" } }
  ];
  for (const invalid of invalids) {
    const { point } = await run((row, params) => row.metricCode === "M058" && params.dimensionFilters?.includes('"new"') ? { ...row, ...invalid } : row);
    expect(point("M088").value).toBeNull(); expect(point("M067.new").value).toBeNull();
    expect(point("M067").value).toBe(162.02 / 5);
  }
});

test("另一日未完成状态不能覆盖当日合法READY，渠道与现代接口保持结束排他", async () => {
  const { point, calls } = await run();
  expect(point("M058")).toMatchObject({ state: "available", value: 162.02 });
  expect(point("M058", "2026-10-11").value).toBeNull();
  const channels = calls.filter(c => c.path.endsWith("channelStatByTypeV2"));
  expect(channels.length).toBeGreaterThan(0);
  for (const { params } of channels) {
    const start = params.sumDateBegin.slice(0, 10);
    expect(params.sumDateEnd).toBe(new Date(Date.parse(`${start}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10) + " 00:00:00");
  }
  const modern = calls.find(c => c.path === "/api/admin/bi/v1/metrics" && !c.params.dimensionFilters && c.params.metricCodes !== "M018")!;
  expect(modern.params).toMatchObject({ startDate: "2026-10-05", endDate: "2026-10-13", includeIncomplete: "true" });
  expect(calls.find(c => c.path.endsWith("pDaySum"))!.params.sumDateEnd).toBe("2026-10-12 23:59:59");
});
