import type { CalculationBasis } from "../features/dashboards/CalculationEvidence";
import { liveCalculation, livePointStateLabel, type LiveDashboardReading, type LiveSeries } from "../features/dashboards/LiveDashboardContext";
import type { WorkbookSheet } from "./preview-workbook";
import type { DailyDashboardSuccess } from "../../../contracts/daily-dashboard";

export function connectedDimensionSeries(live: LiveDashboardReading, id: string, before = false) {
  const period = before ? live.comparison : live;
  if (!live.metricIds.includes(id) || period?.state.status !== "success" || !period.state.data) return undefined;
  const data = period.state.data.data;
  if (data.query.pid !== live.query.pid || data.query.boardId !== live.query.boardId
    || data.query.dateRange[0] > period.query.dateRange[0] || data.query.dateRange[1] < period.query.dateRange[1]) return undefined;
  const matches = data.series.filter(series => series.metric.id === id);
  const source = matches.length === 1 ? matches[0] : undefined;
  return source && { ...source, points: source.points.filter(point => point.date >= period.query.dateRange[0] && point.date <= period.query.dateRange[1]).map(point => {
    const usable = (!point.sourceStatus || point.sourceStatus === "READY") && (point.state === "available" || point.state === "zero_denominator");
    return usable ? point : { ...point, value: null, inputs: point.inputs.map(input => ({ ...input, value: null })) };
  }) };
}

export function connectedDimensionReading(live: LiveDashboardReading, id: string): LiveDashboardReading {
  const project = (period: Pick<LiveDashboardReading, "query" | "state">) => {
    if (period.state.status !== "success") return period.state;
    const series = connectedDimensionSeries({ ...live, query: period.query, state: period.state }, id);
    return { ...period.state, data: { ...period.state.data, data: { ...period.state.data.data, series: series ? [series] : [] } } as DailyDashboardSuccess };
  };
  return { ...live, metricIds: [id], state: project(live),
    comparison: live.comparison && { ...live.comparison, state: live.comparison.state.status === "success" && live.comparison.state.data
      ? project({ ...live.comparison, state: { ...live.comparison.state, data: live.comparison.state.data } }) : live.comparison.state },
    dayReference: live.dayReference && { ...live.dayReference, state: live.dayReference.state.status === "success" && live.dayReference.state.data
      ? project({ ...live.dayReference, state: { ...live.dayReference.state, data: live.dayReference.state.data } }) : live.dayReference.state }
  };
}

function reading(live: LiveDashboardReading, id: string, before = false) {
  const period = before ? live.comparison : live;
  const series = connectedDimensionSeries(live, id, before);
  const point = series?.points.find(point => point.date === period?.query.dateRange[1]);
  return {
    value: point?.value ?? null,
    calculation: series && point ? liveCalculation(series, point) : undefined,
    state: !period ? "未启用对比" : period.state.status === "loading" ? "读取中" : period.state.status === "failure" ? "读取失败"
      : point ? livePointStateLabel(point) : series ? "当日未返回" : "待接入",
    series,
    freshness: period?.state.status === "success" && period.state.refreshError ? "刷新失败，保留上次查询结果" : ""
  };
}

export interface ConnectedDimensionRow {
  key: string;
  name: string;
  position: number;
  value: number | null;
  baseline: number | null;
  calculation?: CalculationBasis;
  baselineCalculation?: CalculationBasis;
  state: string;
  baselineState: string;
  freshness: string;
  seriesId: string;
  series?: LiveSeries;
  baselineSeries?: LiveSeries;
}

export function connectedDimensionRows(live: LiveDashboardReading, groups: readonly { key: string; name: string; seriesId: string }[]): ConnectedDimensionRow[] {
  return groups.map((group, index) => {
    const { seriesId } = group, current = reading(live, seriesId), previous = reading(live, seriesId, true);
    return { ...group, position: index + 1, value: current.value, baseline: previous.value,
      calculation: current.calculation, baselineCalculation: previous.calculation,
      state: current.state, baselineState: previous.state, freshness: current.freshness,
      seriesId, series: current.series, baselineSeries: previous.series };
  });
}

export function connectedDimensionSheet(live: LiveDashboardReading, id: string, group: string, title: string, rows: ConnectedDimensionRow[], supported: boolean): WorkbookSheet {
  return { name: title, rows: [["比较维度", group], ["状态", supported ? "真实后台结果，待验数" : "当前指标与维度待接入"],
    ["周期", "平台", "指标", group, "日期", "结果（原始值）", "单位", "计算输入", "状态", "刷新状态"],
    ...rows.flatMap(row => [
      { label: "当前期", series: row.series, state: row.state, period: live },
      ...(live.comparison ? [{ label: "对比期", series: row.baselineSeries, state: row.baselineState, period: live.comparison }] : [])
    ].flatMap(({ label, series, state, period }) => series ? series.points.map(point => [label, live.query.pid, series.metric.name, row.name, point.date,
      point.value, series.metric.unit === "%" ? "原始比值" : series.metric.unit, point.inputs.map(input => `${series.metric.inputs.find(item => item.key === input.key)?.name ?? input.key}：${input.value ?? "—"}`).join("；"), livePointStateLabel(point),
      period.state.status === "success" && period.state.refreshError ? "上次查询结果" : "本次查询结果"])
      : [[label, live.query.pid, id, row.name, period.query.dateRange.join(" 至 "), null, "", "", state, ""]]))] };
}
