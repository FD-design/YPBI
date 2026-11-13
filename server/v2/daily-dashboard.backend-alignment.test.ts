import { expect, test } from "bun:test";
import { dailyDashboardV2SuccessSchema } from "../../contracts/daily-dashboard";
import { OPERATING_METRIC_IDS } from "../../contracts/operating-detail-projection";
import { DailyDashboardService } from "./daily-dashboard.service";
import { UpstreamError } from "../upstream/client";

const date = "2026-10-12";
const query = { boardId: "5.2", pid: "PH", dateRange: ["2026-10-05", date] as [string, string], projection: "operating_snapshot" as const };
const generatedAt = "2026-10-16T00:00:00Z";
const envelope = (rows: Record<string, unknown>[]) => ({ code: 200, msg: { metricVersion: "bi-v1", generatedAt, watermark: null, rows } });
type Change = (row: Record<string, unknown>, params: Record<string, string>) => Record<string, unknown>;

async function run(change: Change = row => row, pid = "PH", respond?: (params: Record<string, string>) => unknown) {
  const calls: Array<{ path: string; params: Record<string, string> }> = [];
  const result = await new DailyDashboardService({ get: async (path, params) => {
    calls.push({ path, params: { ...params } });
    if (path === "/api/admin/bi/v1/metrics") {
      if (params.metricCodes === "M018") return envelope([]);
      const override = respond?.(params);
      if (override !== undefined) return override;
      const filters = params.dimensionFilters ? JSON.parse(params.dimensionFilters) : {};
      const amount = filters.userCohort === "new" ? 141.02 : filters.sourceType === "natural" ? 138.02 : filters.sourceType === "internal_channel" ? 24 : 162.02;
      const payers = filters.userCohort === "new" ? 3 : 5;
      const specifications: Record<string, [number, string]> = {
        M058: [amount, "currency"], M059: [payers, "count"], M067: [amount / payers, "currency_per_user"], M016: [6, "count"], M008: [3, "count"],
        M061: [5 / 6, "ratio"], M064: [1, "ratio"]
      };
      return envelope(params.metricCodes.split(",").filter(code => specifications[code]).map(code => {
        const [value, unit] = specifications[code];
        return change({ metricCode: code, businessDate: date, dimensions: { pid, ...filters }, value,
          numerator: code === "M061" ? 5 : code === "M064" ? 3 : code === "M067" ? amount : value,
          denominator: code === "M061" ? 6 : code === "M064" ? 3 : code === "M067" ? payers : 0,
          unit, dataStatus: "READY", metricVersion: "bi-v1",
          ruleVersion: code === "M058" || code === "M067" ? "paid-order-value-rmb-v2" : "paid-order-value-v1" }, params);
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
    const { result, point, calls } = await run(undefined, pid);
    expect(result.data.query.pid).toBe(pid);
    expect(result.data.series.map(s => s.metric.id)).toEqual([...OPERATING_METRIC_IDS]);
    expect(OPERATING_METRIC_IDS).toHaveLength(93);
    expect(new Set(OPERATING_METRIC_IDS).size).toBe(93);
    const paymentBatches = calls.filter(({ params }) => params.metricCodes?.split(",").includes("M067"));
    expect(paymentBatches.some(({ params }) => !params.dimensionFilters)).toBe(true);
    expect(paymentBatches.some(({ params }) => params.dimensionFilters === '{"userCohort":"new"}')).toBe(true);
    for (const { params } of paymentBatches) expect(params.metricCodes.split(",")).toEqual(expect.arrayContaining(["M058", "M059", "M067"]));
    for (const [id, value] of Object.entries({ M058: 162.02, "M058.new": 141.02, "M058.nature": 138.02, "M058.internal": 24,
      M087: 162.02 / 6, M088: 141.02 / 3, M067: 162.02 / 5, "M067.new": 141.02 / 3,
      M059: 5, "M059.new": 3, M061: 5 / 6, M064: 1 })) {
      expect(point(id)).toMatchObject({ state: "available", sourceStatus: "READY", value });
    }
    dailyDashboardV2SuccessSchema.parse(result);
  }
});

test("获客两组拆单后的金额读取失败只影响金额，93列三期新增和D1结果保留", async () => {
  const groupedCalls: Array<{ codes: string; sourceType: string; start: string; end: string }> = [];
  const result = await new DailyDashboardService({ get: async (path, params) => {
    if (path !== "/api/admin/bi/v1/metrics") return { code: 200, msg: { pageData: [], totalData: [], totalCount: 0 }, data: [] };
    const filters = JSON.parse(params.dimensionFilters ?? "{}");
    if (!["natural", "internal_channel"].includes(filters.sourceType)) return envelope([]);
    const codes = params.metricCodes;
    groupedCalls.push({ codes, sourceType: filters.sourceType, start: params.startDate, end: params.endDate });
    if (codes.includes(",")) throw new UpstreamError("BI_V1_REQUEST_REJECTED", "unsupported metrics M058", 400);
    if (codes === "M058") throw new UpstreamError("UPSTREAM_NETWORK_ERROR", "fixture transport failure", 502);
    const rows: Record<string, unknown>[] = [];
    for (let day = params.startDate; day < params.endDate; day = new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10)) {
      rows.push({ metricCode: codes, businessDate: day, dimensions: { pid: "PH", ...filters },
        value: codes === "M020" ? 2 / 3 : 3, numerator: codes === "M020" ? 2 : 3,
        denominator: codes === "M020" ? 3 : 0, unit: codes === "M020" ? "ratio" : "count",
        dataStatus: "READY", metricVersion: "bi-v1", ruleVersion: "retention-d0-D1-v1" });
    }
    return envelope(rows);
  } }, () => new Date(generatedAt)).execute(query);
  expect(result.data.series.map(series => series.metric.id)).toEqual([...OPERATING_METRIC_IDS]);
  for (const suffix of ["nature", "internal"]) {
    const count = result.data.series.find(series => series.metric.id === `M008.${suffix}`)!;
    const retention = result.data.series.find(series => series.metric.id === `M020.${suffix === "nature" ? "natural" : suffix}`)!;
    const amount = result.data.series.find(series => series.metric.id === `M058.${suffix}`)!;
    expect(count.points).toHaveLength(3);
    expect(retention.points).toHaveLength(3);
    expect(amount.points).toHaveLength(3);
    for (const point of count.points) expect(point).toMatchObject({ state: "available", sourceStatus: "READY", value: 3 });
    for (const point of retention.points) expect(point).toMatchObject({ state: "available", sourceStatus: "READY", value: 2 / 3 });
    for (const point of amount.points) expect(point).toMatchObject({ state: "source_failure", value: null });
  }
  expect(groupedCalls).toHaveLength(8);
  for (const sourceType of ["natural", "internal_channel"]) {
    const scoped = groupedCalls.filter(call => call.sourceType === sourceType);
    expect(scoped.map(call => call.codes)).toEqual(["M008,M020,M058", "M008", "M020", "M058"]);
    expect(scoped.every(call => call.start === "2026-10-05" && call.end === "2026-10-13")).toBe(true);
  }
  dailyDashboardV2SuccessSchema.parse(result);
});

test("旧版、未知版本和原币单位不能进入人民币及派生金额", async () => {
  for (const invalid of [{ ruleVersion: "paid-order-value-v1" }, { ruleVersion: "paid-order-value-rmb-v3" }, { unit: "USDT" }]) {
    const { point } = await run(row => row.metricCode === "M058" ? { ...row, ...invalid } : row);
    for (const id of ["M058", "M058.new", "M058.nature", "M058.internal", "M087", "M088"]) expect(point(id).value).toBeNull();
    expect(point("M067").value).toBe(162.02 / 5);
    expect(point("M067.new").value).toBe(141.02 / 3);
    expect(point("M059").value).toBe(5);
    expect(point("M061").value).toBe(5 / 6);
  }
});

test("金额真实0保留，人均金额只在分母大于0时产生值", async () => {
  const zeroAmount = await run(row => row.metricCode === "M058" || row.metricCode === "M067" ? { ...row, value: 0, numerator: 0 } : row);
  for (const id of ["M058", "M058.new", "M087", "M088", "M067", "M067.new"]) expect(zeroAmount.point(id)).toMatchObject({ state: "available", value: 0 });
  const zeroPeople = await run(row => ["M016", "M008", "M059"].includes(String(row.metricCode)) ? { ...row, value: 0, numerator: 0 }
    : row.metricCode === "M067" ? { ...row, value: null, denominator: 0 } : row);
  for (const id of ["M087", "M088", "M067", "M067.new"]) expect(zeroPeople.point(id)).toMatchObject({ state: "zero_denominator", value: null });
});

test("派生金额不消费未完成输入、缺日、其他PID或其他人群", async () => {
  const invalids = [
    ...["PROCESSING", "SOURCE_INCOMPLETE", "NOT_MATURE", "FAILED"].map(dataStatus => ({ dataStatus, value: null })),
    { businessDate: "2026-10-11" }, { dimensions: { pid: "TT" } }, { dimensions: { pid: "PH", userCohort: "old" } }
  ];
  for (const invalid of invalids) {
    const { point } = await run((row, params) => row.metricCode === "M058" && params.dimensionFilters?.includes('"new"') ? { ...row, ...invalid } : row);
    expect(point("M088").value).toBeNull();
    expect(point("M067.new").value).toBe("dimensions" in invalid && invalid.dimensions?.pid === "TT" ? null : 141.02 / 3);
    expect(point("M067").value).toBe(162.02 / 5);
  }
});

test("只有同范围独立 M067 请求确认指标不支持才按合格金额与人数计算", async () => {
  const rejection = { code: 400, err: "包含不支持的 metricCodes" };
  const rejectsArppu = (params: Record<string, string>) => params.metricCodes.split(",").includes("M067") ? rejection : undefined;
  const compatible = await run(undefined, "FBI", rejectsArppu);
  expect(compatible.point("M067")).toMatchObject({ state: "available", value: 162.02 / 5, inputs: [{ value: 162.02 }, { value: 5 }] });
  expect(compatible.point("M067.new")).toMatchObject({ state: "available", value: 141.02 / 3, inputs: [{ value: 141.02 }, { value: 3 }] });
  for (const initial of compatible.calls.filter(({ params }) => params.metricCodes?.includes("M067") && params.metricCodes !== "M067"
    && params.startDate <= date && params.endDate > date)) {
    const siblingCodes = initial.params.metricCodes.split(",").filter(code => code !== "M067").join(",");
    const sameScope = compatible.calls.filter(({ params }) => ["pid", "startDate", "endDate", "dimensionFilters", "granularity"]
      .every(field => params[field] === initial.params[field]));
    expect(sameScope.map(({ params }) => params.metricCodes)).toEqual(expect.arrayContaining([siblingCodes, "M067"]));
  }

  const incomplete = await run(row => row.metricCode === "M067" ? { ...row, dataStatus: "SOURCE_INCOMPLETE", value: null } : row, "FBI");
  expect(incomplete.point("M067")).toMatchObject({ state: "no_value", sourceStatus: "SOURCE_INCOMPLETE", value: null });
  expect(incomplete.point("M059").value).toBe(5);
  const missing = await run(undefined, "FBI", params => params.metricCodes.includes("M067")
    ? params.metricCodes === "M067" ? envelope([]) : rejection : undefined);
  expect(missing.point("M067")).toMatchObject({ state: "no_record", value: null });
  expect(missing.point("M059").value).toBe(5);
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
