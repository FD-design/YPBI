import { describe, expect, test } from "bun:test";
import type { DailyDashboardV2Success } from "../../../contracts/daily-dashboard";
import type { LiveDashboardReading, LiveSeries } from "../features/dashboards/LiveDashboardContext";
import { REGISTRATION_COHORT_SCOPES, REGISTRATION_RETENTION_WINDOWS, registrationCohortMetricId, registrationCohortScopeLabel, type RegistrationCohortScope } from "../features/dashboards/registration-cohort";
import { connectedTopicExportSheets } from "./connected-topic-export";

type Series = DailyDashboardV2Success["data"]["series"][number];
function series(id: string, date: string, count: number, base?: number, overrides: Partial<LiveSeries["points"][number]> = {}): Series {
  const inputs = base === undefined ? [{ key: "count", name: "人数", unit: "人" }] : [{ key: "retained", name: "留存人数", unit: "人" }, { key: "registered", name: "注册人数", unit: "人" }];
  return { metric: { id, name: id, unit: base === undefined ? "人" : "%", definition: id + "定义", formula: base === undefined ? null : "留存人数 ÷ 注册人数", sourceNote: id + "来源",
    authorityVersion: "v-test", referenceMetricId: id.split(".")[0], inputs },
    points: [{ date, state: base === 0 ? "zero_denominator" : "available", sourceStatus: "READY", value: base === undefined ? count : base === 0 ? null : count / base,
      inputs: inputs.map((input, i) => ({ key: input.key, value: i === 0 ? count : base! })), ...overrides }],
    periodStatistics: { aggregationVersion: "daily-statistics/v1", dateRange: [date, date], dayCount: 1,
      state: base === undefined ? "available" : "unsupported", values: base === undefined ? [{ kind: "daily_average", value: count }] : [], reason: base === undefined ? null : "固定注册批次" }
  };
}
function reading(date: string, series: Series[]): LiveDashboardReading {
  const query = { boardId: "5.8", pid: "PH", dateRange: [date, date] as [string, string] };
  const result: DailyDashboardV2Success = { success: true, data: { query, queryId: date, fetchedAt: "2026-10-09T00:00:00Z", timezone: "Asia/Shanghai",
    validationStatus: "pending_validation", completeness: "unknown", watermark: null, sourceApiIds: ["/api/admin/bi/v1/metrics"], schemaVersion: "day-dashboard/v2", series } };
  return { query, metricIds: series.map(item => item.metric.id), state: { status: "success", data: result, refreshing: false, refreshError: null }, platformName: "测试平台",
    controls: { date: null, scope: null, comparison: null, dirty: false, acceptsSharedRange: () => true, apply() {}, export() {} }, retry() {}, canExport: true };
}
function attachComparison(current: LiveDashboardReading, previous: LiveDashboardReading) {
  return { ...current, comparison: { label: "上一等长周期", query: previous.query, state: previous.state } };
}
function cohortSeries(date: string, previous = false) {
  return REGISTRATION_COHORT_SCOPES.flatMap((scope, scopeIndex) => REGISTRATION_RETENTION_WINDOWS.map(([code], windowIndex) =>
    series(registrationCohortMetricId(code, scope.value), date, scopeIndex + windowIndex + 1 + (previous ? 1 : 0), 20 + scopeIndex * 10 + windowIndex)))
    .concat([series("M115.d1", date, 987654), series("M115.d3", date, 987654), series("M115.d7", date, 987654), series("M115.d30", date, 987654)]);
}
const activeDate = "2026-09-20", cohortDate = "2026-09-01", previousCohortDate = "2026-08-31";
function fixture() {
  const live = attachComparison(reading(activeDate, [series("M016", activeDate, 100), series("M024", activeDate, 5, 10), ...cohortSeries(activeDate)]),
    reading("2026-09-19", [series("M016", "2026-09-19", 90), series("M024", "2026-09-19", 4, 10), ...cohortSeries("2026-09-19")]));
  const cohortLive = attachComparison(reading(cohortDate, cohortSeries(cohortDate)), reading(previousCohortDate, cohortSeries(previousCohortDate, true)));
  return { live, cohortLive };
}

describe("真实留存专题整页导出", () => {
  for (const [scopeIndex, { value: scope }] of REGISTRATION_COHORT_SCOPES.entries()) {
    test(`${scope}只导出同范围四周期及独立注册日期对比`, () => {
      const { live, cohortLive } = fixture();
      const before = JSON.stringify({ live, cohortLive });
      const sheets = connectedTopicExportSheets(live, cohortLive, scope);
      const rows = (name: string) => sheets.find(sheet => sheet.name === name)!.rows;
      expect(rows("读取说明")).toEqual(expect.arrayContaining([
        ["范围", `${activeDate} 至 ${activeDate}`], ["注册日分组", registrationCohortScopeLabel(scope)],
        ["注册日期", `${cohortDate} 至 ${cohortDate}`], ["注册留存对比日期", `${previousCohortDate} 至 ${previousCohortDate}`]
      ]));
      for (const [sheetName, date, delta] of [["当前注册留存", cohortDate, 0], ["对比注册留存", previousCohortDate, 1]] as const) {
        const values = rows(sheetName).slice(1);
        expect(values).toHaveLength(4);
        values.forEach((row, windowIndex) => {
          const count = scopeIndex + windowIndex + 1 + delta, base = 20 + scopeIndex * 10 + windowIndex;
          expect(row.slice(0, 3)).toEqual([date, registrationCohortScopeLabel(scope), base]);
          expect(row.slice(4, 6)).toEqual([count, count / base * 100]);
          expect(row[8]).toBe("PH");
        });
      }
      expect(rows("指标口径").slice(1).map(row => row[0])).toEqual(["M016", "M024", ...REGISTRATION_RETENTION_WINDOWS.map(([id]) => registrationCohortMetricId(id, scope))]);
      expect(sheets.filter(sheet => /^(当前期|对比期)-M(?:02[0-3]|115)/.test(sheet.name))).toEqual([]);
      expect(rows("当前期-M016")[1].slice(0, 3)).toEqual([activeDate, 100, 100]);
      expect(rows("对比期-M016")[1].slice(0, 3)).toEqual(["2026-09-19", 90, 90]);
      expect(rows("当前期-M024")[1].slice(0, 4)).toEqual([activeDate, .5, 5, 10]);
      expect(rows("周期统计").slice(1).map(row => [row[0], row[2], row[6]])).toEqual([["当前期", "M016", 100], ["对比期", "M016", 90]]);
      expect(rows("日值比较基准").slice(1).map(row => row[0])).toEqual(["M016", "M016", "M024", "M024"]);
      expect(rows("日值比较基准").slice(1).map(row => [row[4], row[5]])).toEqual([[90, "人"], [null, ""], [.4, "原始比值"], [null, ""]]);
      expect(JSON.stringify(sheets)).not.toContain("987654");
      expect(JSON.stringify({ live, cohortLive })).toBe(before);
    });
  }

  test("D1缺失时保持自身基数空值，D3和D7使用各自直接分母", () => {
    const { live } = fixture(), scope: RegistrationCohortScope = "android";
    const cohortLive = reading(cohortDate, [series("M020", cohortDate, 99, 100), series("M115.d1", cohortDate, 999),
      series("M021.android", cohortDate, 2, 9), series("M022.android", cohortDate, 3, 11), series("M023.android", cohortDate, 0, 0)]);
    const rows = connectedTopicExportSheets(live, cohortLive, scope).find(sheet => sheet.name === "当前注册留存")!.rows.slice(1);
    expect(rows.map(row => [row[2], row[4], row[5]])).toEqual([[null, null, null], [9, 2, 2 / 9 * 100], [11, 3, 3 / 11 * 100], [0, 0, null]]);
    expect(String(rows[0][7])).toContain("字段未返回");
    expect(String(rows[3][7])).toContain("分母为0");
  });

  for (const [sourceStatus, state] of [["PROCESSING", "no_value"], ["SOURCE_INCOMPLETE", "no_value"], ["NOT_MATURE", "immature"], ["FAILED", "source_failure"]] as const) {
    test(`${sourceStatus}不导出残留数值或计算输入`, () => {
      const { live } = fixture();
      for (const pointState of [state, "available"] as const) {
        const cohortLive = reading(cohortDate, REGISTRATION_RETENTION_WINDOWS.map(([code]) => series(`${code}.natural`, cohortDate, 456789, 987654, { state: pointState, sourceStatus })));
        const rows = connectedTopicExportSheets(live, cohortLive, "natural").find(sheet => sheet.name === "当前注册留存")!.rows.slice(1);
        expect(rows.every(row => row[2] === null && row[4] === null && row[5] === null)).toBe(true);
      }
    });
  }

  test("对比查询失败仍导出对应注册日期和状态，不借当前值", () => {
    const { live, cohortLive } = fixture();
    cohortLive.comparison!.state = { status: "failure", kind: "error", code: "UPSTREAM_TIMEOUT", message: "超时" };
    const sheets = connectedTopicExportSheets(live, cohortLive, "internal");
    const rows = sheets.find(sheet => sheet.name === "对比注册留存")!.rows.slice(1);
    expect(rows).toHaveLength(4);
    expect(rows.every(row => row[0] === previousCohortDate && row[2] === null && row[4] === null && row[5] === null && row[7] === "读取失败")).toBe(true);
    expect(sheets.find(sheet => sheet.name === "读取说明")!.rows).toContainEqual(["注册留存对比状态", "读取失败"]);
  });
});
