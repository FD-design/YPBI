import { expect, spyOn, test } from "bun:test";
import type { DailyDashboardSuccess } from "../../../contracts/daily-dashboard";
import { OPERATING_METRIC_IDS } from "../../../contracts/operating-detail-projection";
import { recordDailyDashboardEnvironment } from "../api/daily-dashboard-environment";
import type { LiveDashboardReading } from "../features/dashboards/LiveDashboardContext";
import { DETAIL_COLUMNS, detailColumnKey } from "./operating-detail-columns";
import { OPERATING_LIVE_IDS, operatingLiveRows, type OperatingResources } from "./operating-live-model";

const date = "2026-10-16";
const days = ["2026-10-09", "2026-10-15", date];

function fixture(platformCount = 20) {
  const platforms = Array.from({ length: platformCount }, (_, index) => ({ pid: `P${index}`, name: `平台${index}` }));
  const metricIds = [...OPERATING_METRIC_IDS];
  const resources: OperatingResources = Object.fromEntries(platforms.map(({ pid }, platformIndex) => {
    const data: DailyDashboardSuccess = { success: true, data: {
      schemaVersion: "day-dashboard/v2", query: { boardId: "5.2", pid, dateRange: [days[0], date] },
      queryId: `qa-${pid}`, fetchedAt: "2026-10-17T00:00:00Z", timezone: "Asia/Shanghai",
      validationStatus: "pending_validation", completeness: "unknown", watermark: null, sourceApiIds: ["qa"],
      series: metricIds.map((id, index) => ({
        metric: { id, referenceMetricId: id.split(".")[0], name: id, unit: "人", definition: "独立投影验收样例",
          authorityVersion: "qa-v1", formula: null, sourceNote: null, inputs: [{ key: "value", name: "原始值", unit: "人" }] },
        points: days.map((day, dayIndex) => ({ date: day, state: "available" as const, sourceStatus: "READY" as const,
          value: platformIndex * 1000 + index * 10 + dayIndex, inputs: [{ key: "value", value: index * 10 + dayIndex }] }))
      }))
    } };
    recordDailyDashboardEnvironment(data, "production");
    return [pid, { status: "success" as const, data, refreshing: false, refreshError: null }];
  }));
  const live: LiveDashboardReading = {
    query: { boardId: "5.2", pid: platforms[0].pid, dateRange: [date, date] }, metricIds, state: resources[platforms[0].pid],
    dataEnvironment: "production", platforms, platformName: platforms[0].name, retry() {}, canExport: true,
    controls: { date: null, scope: null, comparison: null, dirty: false, acceptsSharedRange: () => true, apply() {}, export() {} }
  };
  return { live, resources };
}

test("20平台93列三期投影的日期构造及指标扫描保持线性成本", () => {
  const { live, resources } = fixture();
  let metricReads = 0;
  for (const resource of Object.values(resources)) if (resource.status === "success") {
    for (const series of resource.data.data.series) {
      const id = series.metric.id;
      Object.defineProperty(series.metric, "id", { get() { metricReads++; return id; }, configurable: true });
    }
  }
  const calendarReads = spyOn(Date.prototype, "getUTCDate");
  try {
    const rows = operatingLiveRows(live, resources);
    expect(rows).toHaveLength(20);
    expect(rows.every(row => row.values.length === 93)).toBe(true);
    expect(metricReads).toBeLessThanOrEqual(20 * 93 * 7);
    expect(calendarReads.mock.calls.length).toBeLessThanOrEqual(20 * 4 + 2);
  } finally {
    calendarReads.mockRestore();
  }
});

test("同指标与同日期重复来源保留首次匹配，后续来源更新立即生效", () => {
  const { live, resources } = fixture(1), resource = resources.P0;
  if (resource.status !== "success") throw Error("fixture");
  const series = resource.data.data.series.find(series => series.metric.id === "M016")!;
  const current = series.points.find(point => point.date === date)!;
  series.points.push({ ...current, value: 999999 });
  resource.data.data.series.push({ ...series, points: series.points.map(point => ({ ...point, value: 888888 })) });
  const index = DETAIL_COLUMNS.findIndex(column => OPERATING_LIVE_IDS[detailColumnKey(column)] === "M016");
  expect(operatingLiveRows(live, resources)[0].values[index].current).toBe(current.value);
  current.value = 0;
  expect(operatingLiveRows(live, resources)[0].values[index].current).toBe(0);
  resource.refreshError = { code: "UPSTREAM_TIMEOUT", requestId: "qa-refresh", message: "刷新失败" };
  expect(operatingLiveRows(live, resources)[0].values[index].evidence?.current).toMatchObject({
    stale: true, requestFailure: { code: "UPSTREAM_TIMEOUT", requestId: "qa-refresh" }
  });
});

test("重复指标的后续单位仍参与冲突校验，局部平台改变后重新判断", () => {
  const { live, resources } = fixture(2), resource = resources.P1;
  if (resource.status !== "success") throw Error("fixture");
  const series = resource.data.data.series.find(series => series.metric.id === "M016")!;
  resource.data.data.series.push({ ...series, metric: { ...series.metric, unit: "次" } });
  const index = DETAIL_COLUMNS.findIndex(column => OPERATING_LIVE_IDS[detailColumnKey(column)] === "M016");
  expect(operatingLiveRows(live, resources).map(row => row.values[index].evidence?.current.label)).toEqual(["单位不一致", "单位不一致"]);
  expect(operatingLiveRows(live, resources, "P0")[0].values[index].current).not.toBeNull();
});
