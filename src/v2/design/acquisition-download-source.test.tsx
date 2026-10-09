import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DailyDashboardSuccess } from "../../../contracts/daily-dashboard";
import { LiveDashboardContext, type LiveDashboardReading } from "../features/dashboards/LiveDashboardContext";
import { DataOriginProvider } from "../components/DataOrigin";
import { acquisitionDownloadPeriod, acquisitionDownloadPoints, acquisitionDownloadWorkbook, DOWNLOAD_TARGET_UNAVAILABLE } from "./acquisition-download-source";
import { DEFAULT_ACQUISITION_FILTERS } from "./acquisition-preview-model";
import { buildPreviewWorkbook } from "./preview-workbook";

function reading(): LiveDashboardReading {
  const query = { boardId: "5.7", pid: "PH", dateRange: ["2020-01-01", "2020-01-02"] as [string, string] };
  const data: DailyDashboardSuccess = { success: true, data: { schemaVersion: "day-dashboard/v1", query, queryId: "download-test", fetchedAt: "2026-10-09T00:00:00Z", timezone: "Asia/Shanghai", validationStatus: "pending_validation", completeness: "unknown", watermark: null, sourceApiIds: ["bi-v1.metrics"],
    series: ["M003", "M008.nature", "M008.internal"].map(id => ({ metric: { id, name: id, unit: id === "M003" ? "次" : "人", referenceMetricId: id.split(".")[0], authorityVersion: "test", definition: "测试口径", formula: null, sourceNote: null, inputs: [{ key: "count", name: "点击次数", unit: "次" }] },
      points: query.dateRange.map((date, index) => ({ date, value: index === 0 ? 0 : 3, state: "available", sourceStatus: "READY", inputs: [{ key: "count", value: index === 0 ? 0 : 3 }] })) })) } };
  return { query, metricIds: data.data.series.map(series => series.metric.id), state: { status: "success", data, refreshing: false, refreshError: null }, platformName: "PH", canExport: true, retry() {},
    controls: { date: null, scope: null, comparison: null, dirty: false, acceptsSharedRange: () => true, apply() {}, export() {} } };
}
function payload(live: LiveDashboardReading) {
  if (live.state.status !== "success") throw Error("Expected success");
  return live.state.data;
}

test("真实下载只读取总体M003，零值、日期及导出同源，目标与占比保持待接入", () => {
  const live = reading(), points = acquisitionDownloadPoints(live, "count");
  expect(points.map(point => [point.date, point.overall])).toEqual([["2020-01-01", 0], ["2020-01-02", 3]]);
  expect(points.every(point => !Object.keys(point.values).length && !point.shares && !point.basis && !point.overallBasis)).toBe(true);
  const share = acquisitionDownloadPoints(live, "share");
  expect(share.every(point => point.overall === null && point.states?.__overall.includes("占比待接入"))).toBe(true);
  const sheets = acquisitionDownloadWorkbook(live);
  expect(sheets[1].rows.slice(1).map(row => [row[1], row[4]])).toEqual(points.map(point => [point.date, point.overall]));
  expect(sheets[0].rows).toContainEqual(["下载目标", DOWNLOAD_TARGET_UNAVAILABLE]);
  const xlsx = new TextDecoder().decode(buildPreviewWorkbook(sheets));
  expect(xlsx).toContain("xl/worksheets/sheet2.xml");
  expect(xlsx).toContain("下载点击次数");
  expect(xlsx).not.toContain("M003");
  expect(xlsx).not.toContain("Android");
  expect(xlsx).not.toContain("演示数据");
});

test("缺日与乱序按业务日期读取，不把返回位置当成日期", () => {
  const live = reading(), series = payload(live).data.series[0];
  series.points.reverse();
  expect(acquisitionDownloadPeriod(live).map(point => point.value)).toEqual([0, 3]);
  series.points = series.points.filter(point => point.date === "2020-01-02");
  expect(acquisitionDownloadPoints(live, "count").map(point => point.overall)).toEqual([null, 3]);
  expect(acquisitionDownloadWorkbook(live)[1].rows[1].slice(4, 7)).toEqual([null, "", "当日未返回"]);
});

test("非READY、缺值、无记录不泄漏随附数值及计算输入", () => {
  for (const sourceStatus of ["PROCESSING", "NOT_MATURE", "SOURCE_INCOMPLETE", "FAILED"] as const) {
    const live = reading(), point = payload(live).data.series[0].points[1];
    point.sourceStatus = sourceStatus;
    const result = acquisitionDownloadPeriod(live)[1];
    expect(result.value).toBeNull();
    expect(result.inputs.every(input => input.value === null)).toBe(true);
    expect(result.state).not.toBe("已返回");
    expect(acquisitionDownloadWorkbook(live)[1].rows[2][4]).toBeNull();
  }
  for (const state of ["no_value", "no_record", "invalid_value", "source_failure"] as const) {
    const live = reading(); payload(live).data.series[0].points[1].state = state;
    expect(acquisitionDownloadPeriod(live)[1].value).toBeNull();
  }
});

test("重复日期与非法计数不产生任意结果", () => {
  for (const value of [null, -1, NaN, Infinity]) {
    const live = reading(); payload(live).data.series[0].points[1].value = value;
    expect(acquisitionDownloadPeriod(live)[1]).toMatchObject({ value: null, state: "数据异常" });
  }
  const live = reading(), series = payload(live).data.series[0];
  series.points.push({ ...series.points[1], value: 100 });
  expect(acquisitionDownloadPeriod(live)[1]).toMatchObject({ value: null, state: "数据异常" });
  expect(acquisitionDownloadWorkbook(live)[1].rows[2][4]).toBeNull();
});

test("范围不匹配与读取失败保留为空；刷新失败保留对应旧结果及标记", () => {
  for (const wrong of [{ pid: "other" }, { boardId: "5.8" }, { dateRange: ["2020-01-02", "2020-01-02"] as [string, string] }]) {
    const live = reading(); payload(live).data.query = { ...live.query, ...wrong };
    expect(acquisitionDownloadPeriod(live).every(point => point.value === null)).toBe(true);
  }
  const live = reading(), data = payload(live);
  live.state = { status: "loading" };
  expect(acquisitionDownloadPeriod(live).every(point => point.value === null && point.state === "读取中")).toBe(true);
  live.state = { status: "failure", kind: "error", code: "FAILED", message: "读取失败" };
  expect(acquisitionDownloadPeriod(live).every(point => point.value === null && point.state === "读取失败")).toBe(true);
  live.state = { status: "success", data, refreshing: false, refreshError: { code: "FAILED", message: "读取失败" } };
  expect(acquisitionDownloadPeriod(live)[1]).toMatchObject({ value: 3, freshness: "刷新失败，保留上次查询结果" });
  expect(acquisitionDownloadWorkbook(live)[1].rows[2][8]).toBe("刷新失败，保留上次查询结果");
});

test("对比查询独立保留实际日期、零值、缺日及失败状态", () => {
  const live = reading(), before = reading(), beforeData = payload(before);
  before.query = { ...before.query, dateRange: ["2019-12-30", "2019-12-31"] }; beforeData.data.query = before.query;
  beforeData.data.series[0].points = [{ ...beforeData.data.series[0].points[0], date: "2019-12-31" }];
  live.comparison = { label: "上一等长周期", query: before.query, state: before.state };
  expect(acquisitionDownloadPoints(live, "count").map(point => [point.comparison?.date, point.comparison?.overall])).toEqual([["2019-12-30", null], ["2019-12-31", 0]]);
  expect(acquisitionDownloadWorkbook(live)[1].rows.slice(3).map(row => row[4])).toEqual([null, 0]);
  live.comparison.state = { status: "failure", kind: "error", code: "FAILED", message: "读取失败" };
  expect(acquisitionDownloadPoints(live, "count").every(point => point.comparison?.overall === null && point.states?.__overall.includes("读取失败"))).toBe(true);
  expect(acquisitionDownloadPeriod(live).map(point => point.value)).toEqual([0, 3]);
  live.comparison = { ...live.comparison, query: { ...before.query, pid: "other" }, state: before.state };
  expect(acquisitionDownloadPeriod(live, true).every(point => point.value === null)).toBe(true);
});

test("真实下载图保留原结构与控件，真实计数不再被演示目标覆盖；DEV仍有演示图", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: new URL("http://localhost/dashboards/public?board=5.7") } });
  try {
    const { AcquisitionVisuals } = await import("./AcquisitionVisuals");
    const render = (live: LiveDashboardReading | null) => renderToStaticMarkup(<LiveDashboardContext.Provider value={live}><DataOriginProvider value="demo"><AcquisitionVisuals filters={DEFAULT_ACQUISITION_FILTERS} mixed={false} pending={false} onOpen={() => {}} onLocate={() => {}} /></DataOriginProvider></LiveDashboardContext.Provider>);
    const real = render(reading());
    const download = real.slice(0, real.indexOf('aria-label="落地页转化诊断"'));
    for (const name of ["下载表现", "下载目标构成", "每日下载点击", "下载趋势数值", "分目标下载展示范围", "查看下载明细", "查看同口径数据表", "总体", "分组对比"]) expect(download).toContain(name);
    expect(download).toContain(DOWNLOAD_TARGET_UNAVAILABLE);
    expect(download).toContain("2020-01-01");
    expect(download).not.toContain("Android");
    expect(download).not.toContain("App Store");
    expect(download).not.toContain("合成演示数据");
    const demo = render(null);
    expect(demo).toContain("Android");
    expect(demo).toContain("合成演示数据");
    expect(demo).not.toContain(DOWNLOAD_TARGET_UNAVAILABLE);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
