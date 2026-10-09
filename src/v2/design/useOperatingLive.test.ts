import { expect, test } from "bun:test";
import { createElement, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DailyDashboardSuccess } from "../../../contracts/daily-dashboard";
import type { LiveDashboardReading } from "../features/dashboards/LiveDashboardContext";
import { useOperatingLive } from "./useOperatingLive";

test("经营列在同一查询的读取完成和刷新后采用最新单位与定义", () => {
  const query = { boardId: "5.2", pid: "PH", dateRange: ["2020-01-01", "2020-01-01"] as [string, string] };
  const loading: LiveDashboardReading = { query, metricIds: ["M058", "M067"], state: { status: "loading" }, platformName: "PH", canExport: true,
    retry() {}, controls: { date: null, scope: null, comparison: null, dirty: false, acceptsSharedRange: () => true, apply() {}, export() {} } };
  const success = (revision: string, currency: string): LiveDashboardReading => {
    const data: DailyDashboardSuccess = { success: true, data: { schemaVersion: "day-dashboard/v2", query, queryId: revision,
      fetchedAt: "2026-10-09T12:00:00Z", timezone: "Asia/Shanghai", validationStatus: "pending_validation", completeness: "unknown", watermark: null,
      sourceApiIds: ["bi-v1.metrics"], series: ["M058", "M067"].map(id => ({
        metric: { id, name: id, unit: id === "M058" ? currency : currency + "/人", definition: revision + "定义", sourceNote: revision + "来源",
          referenceMetricId: id, authorityVersion: "v1", formula: null, inputs: [] }, points: [],
        periodStatistics: { aggregationVersion: "daily-statistics/v1", dateRange: query.dateRange, dayCount: 1, state: "unsupported", values: [], reason: null }
      })) } };
    return { ...loading, state: { status: "success", data, refreshing: false, refreshError: null } };
  };
  const stages = [loading, success("初次", "元"), success("刷新", "人民币元")];
  const captured: { unit: string; definition: string }[][] = [];
  function Reading() {
    const [stage, setStage] = useState(0);
    const { columns } = useOperatingLive(stages[stage]);
    captured.push(["M058", "M067"].map(id => {
      const column = columns.find(column => column.metric.id === id && !column.slice)!;
      return { unit: column.unit, definition: column.metric.definition };
    }));
    if (stage < stages.length - 1) setStage(stage + 1);
    return createElement("span", null, columns.find(column => column.metric.id === "M058")!.unit);
  }
  renderToStaticMarkup(createElement(Reading));
  expect(captured).toHaveLength(3);
  expect(captured[0].map(column => column.unit)).toEqual(["", ""]);
  expect(captured[1]).toEqual([{ unit: "元", definition: "初次定义 初次来源" }, { unit: "元/人", definition: "初次定义 初次来源" }]);
  expect(captured[2]).toEqual([{ unit: "人民币元", definition: "刷新定义 刷新来源" }, { unit: "人民币元/人", definition: "刷新定义 刷新来源" }]);
});
