import { expect, test } from "bun:test";
// Keep the chart runtime in its server environment before the router-only window fixture.
import "echarts/core";
import type { DailyDashboardSuccess } from "../../../contracts/daily-dashboard";

async function metricSheet(result: DailyDashboardSuccess, id = "M018", stale = false) {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: new URL("http://localhost/dashboards/public?board=5.8") } });
  try {
    const { connectedBoardMetricSheet } = await import("./ConnectedBoard");
    return connectedBoardMetricSheet(result.data.series.find(series => series.metric.id === id)!, result, "当前期", stale);
  } finally { if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window"); }
}

function result(dateRange: [string, string], anchors: string[], fetchedAt = "2026-10-12T00:00:00Z"): DailyDashboardSuccess {
  const dates = Array.from({ length: (Date.parse(dateRange[1]) - Date.parse(dateRange[0])) / 86400000 + 1 }, (_, index) => new Date(Date.parse(dateRange[0]) + index * 86400000).toISOString().slice(0, 10));
  return { success: true, data: { schemaVersion: "day-dashboard/v1", query: { boardId: "5.8", pid: "PH", dateRange }, queryId: "monthly-export", fetchedAt,
    timezone: "Asia/Shanghai", validationStatus: "pending_validation", completeness: "unknown", watermark: null, sourceApiIds: ["bi-v1.metrics"],
    series: ["M018", "M016"].map(id => ({ metric: { id, name: id, unit: "人", definition: "直接读取", referenceMetricId: id, authorityVersion: "fixture/v1", formula: null, sourceNote: "fixture", inputs: [{ key: "count", name: "人数", unit: "人" }] },
      points: dates.map(date => anchors.includes(date) || id === "M016" ? { date, state: "available", sourceStatus: "READY", value: 42, inputs: [{ key: "count", value: 42 }] }
        : { date, state: "no_record", value: null, inputs: [{ key: "count", value: null }] }) })) } };
}

test("月中历史查询整板M018导出按整自然月一行，不将锚点当查询范围", async () => {
  const payload = result(["2020-01-12", "2020-01-17"], ["2020-01-17"]), sheet = await metricSheet(payload);
  expect(sheet.rows).toHaveLength(2);
  expect(sheet.rows[0][0]).toBe("自然月与实际查询范围");
  expect(sheet.rows[1]).toEqual(["2020-01 自然月 · 2020-01-01 至 2020-01-31", 42, 42, "已返回", "2026-10-12T00:00:00Z", "本次查询结果", "实际查询截止不是来源数据水位"]);
  expect(payload.data.series[0].points).toHaveLength(6);
});

test("当前月实际查询截止按执行快照前一北京时间业务日，不按所选锚点", async () => {
  const payload = result(["2026-10-03", "2026-10-06"], ["2026-10-06"], "2026-10-11T16:30:00Z"), sheet = await metricSheet(payload, "M018", true);
  expect(sheet.rows).toHaveLength(2);
  expect(sheet.rows[1][0]).toBe("2026-10 自然月 · 2026-10-01 至 2026-10-11");
  expect(sheet.rows[1][5]).toBe("上次查询结果");
  expect(sheet.rows[1][6]).toBe("实际查询截止不是来源数据水位");
});

test("跨月整板导出每自然月唯一结果，保留闰月和尾月完整范围", async () => {
  const sheet = await metricSheet(result(["2019-12-20", "2020-03-04"], ["2019-12-31", "2020-01-31", "2020-02-29", "2020-03-04"]));
  expect(sheet.rows.slice(1).map(row => row[0])).toEqual([
    "2019-12 自然月 · 2019-12-01 至 2019-12-31", "2020-01 自然月 · 2020-01-01 至 2020-01-31",
    "2020-02 自然月 · 2020-02-01 至 2020-02-29", "2020-03 自然月 · 2020-03-01 至 2020-03-31"
  ]);
  expect(sheet.rows.slice(1).every(row => row[1] === 42)).toBe(true);
});

test("未发月活请求时保留月空态行与范围说明，不生成查询截止或数值", async () => {
  const payload = result(["2026-10-01", "2026-10-01"], [], "2026-09-30T17:00:00Z"), sheet = await metricSheet(payload);
  expect(sheet.rows).toHaveLength(2);
  expect(sheet.rows[1].slice(0, 4)).toEqual(["2026-10 自然月 · 尚无已结束业务日", null, null, "本月未返回记录"]);
});

test("M018非READY保留状态，其他指标逐日导出结构与日期保持", async () => {
  const payload = result(["2020-01-12", "2020-01-17"], ["2020-01-17"]), point = payload.data.series[0].points.at(-1)!;
  point.sourceStatus = "SOURCE_INCOMPLETE"; point.state = "no_value"; point.value = null;
  expect((await metricSheet(payload)).rows[1].slice(1, 4)).toEqual([null, null, "来源不完整"]);
  const daily = await metricSheet(payload, "M016");
  expect(daily.rows[0]).toEqual(["日期", "结果（人）", "人数（人）", "状态", "查询时间", "刷新状态"]);
  expect(daily.rows.slice(1).map(row => row[0])).toEqual(["2020-01-12", "2020-01-13", "2020-01-14", "2020-01-15", "2020-01-16", "2020-01-17"]);
  expect(daily.rows.slice(1).every(row => row[1] === 42 && row[2] === 42)).toBe(true);
});
