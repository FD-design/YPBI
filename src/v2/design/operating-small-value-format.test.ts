import { expect, test } from "bun:test";
import type { DailyDashboardSuccess } from "../../../contracts/daily-dashboard";
import { liveValue, type LiveDashboardReading } from "../features/dashboards/LiveDashboardContext";
import { DETAIL_COLUMNS, operatingDetailBreakdown, operatingSummaryModels, operatingValueLabel, type DetailRow } from "./operating-detail-snapshot";
import { operatingLiveColumns, operatingLiveExportRows, operatingLiveRows, operatingLiveSummary } from "./operating-live-model";

const date = "2020-01-01";
function reading(value: number | null): LiveDashboardReading {
  const query = { boardId: "5.2", pid: "PH", dateRange: [date, date] as [string, string] };
  const data: DailyDashboardSuccess = { success: true, data: { schemaVersion: "day-dashboard/v1", query: { ...query, dateRange: ["2019-12-25", date] },
    queryId: "small-value", fetchedAt: "2026-10-10T00:00:00Z", timezone: "Asia/Shanghai", validationStatus: "pending_validation", completeness: "unknown", watermark: null, sourceApiIds: ["bi-v1.metrics"],
    series: ["M067", "M067.new"].map(id => ({ metric: { id, name: id, unit: "元/人", definition: "正式同范围定义", authorityVersion: "test-v1", referenceMetricId: "M067", sourceNote: null, formula: null, inputs: [] },
      points: [{ date, value, state: value === null ? "no_value" : "available", sourceStatus: value === null ? "SOURCE_INCOMPLETE" : "READY", inputs: [] }] })) } };
  return { query, metricIds: ["M067", "M067.new"], platformName: "PH", platforms: [{ pid: "PH", name: "PH" }],
    state: { status: "success", data, refreshing: false, refreshError: null }, canExport: true, retry() {},
    controls: { date: null, scope: null, comparison: null, dirty: false, acceptsSharedRange: () => true, apply() {}, export() {} } };
}

for (const value of [.004, -.004, 0, 12345.6789, null]) {
  test(`经营两列ARPPU、摘要、拆解共享精度 ${value}，原值/状态/导出不变`, () => {
    const live = reading(value), columns = operatingLiveColumns(live), resources = { PH: live.state }, rows = operatingLiveRows(live, resources);
    const expected = value === null ? "—" : value === 12345.6789 ? "12,345.68" : String(value);
    expect(columns).toHaveLength(93);
    const summary = operatingLiveSummary(live, resources, rows, "PH").find(model => model.metric.id === "M067")!;
    if (value === null) expect(summary.result.status).toBe("no_values");
    else expect(summary.result).toMatchObject({ status: "available", value: { raw: value, display: expected, unit: "元/人" } });
    const detail = operatingDetailBreakdown(summary, rows, "PH", date);
    const newUsers = detail.groups.flatMap(group => group.rows).find(row => row.key === "新用户")!;
    if (value === null) expect(newUsers.value).toMatchObject({ status: "no_record", label: "数据接入中" });
    else expect(newUsers.value).toMatchObject({ status: "available", raw: value, display: expected });
    expect(detail.unit).toBe("元/人");
    const exported = operatingLiveExportRows(rows, columns, date);
    for (const [index, column] of columns.entries()) {
      if (column.metric.id !== "M067") continue;
      expect(operatingValueLabel(rows[0].values[index], column)).toBe(value === null ? "数据接入中" : expected);
      expect(exported[1][3 + index * 9]).toBe(value);
      expect(exported[0][3 + index * 9]).toContain("元/人");
      expect(rows[0].values[index].current).toBe(value);
    }
    expect(liveValue(value, "元/人")).toBe(expected);
  });
}

test("演示摘要及未映射原模型沿用同一人均精度，普通金额仍保留两位", () => {
  const row: DetailRow = { pid: "PH", name: "PH", state: "部分", productMode: null, promotionStatus: null,
    values: DETAIL_COLUMNS.map(column => ({ current: column.metric.id === "M067" ? .004 : column.metric.id === "M058" ? 12345.6789 : null, previousDay: null, previousWeek: null })) };
  const summaries = operatingSummaryModels([row], "PH", date);
  expect(summaries.find(model => model.metric.id === "M067")!.result).toMatchObject({ status: "available", value: { raw: .004, display: "0.004", unit: "USD/人" } });
  expect(summaries.find(model => model.metric.id === "M058")!.result).toMatchObject({ status: "available", value: { raw: 12345.6789, display: "12,345.68", unit: "USD" } });
  const originals = operatingLiveSummary({ ...reading(.004), metricIds: [] }, {}, [row], "PH");
  expect(originals.find(model => model.metric.id === "M067")!.result).toMatchObject({ status: "available", value: { raw: .004, display: "0.004", unit: "USD/人" } });
});
