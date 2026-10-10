import type { DailyDashboardSuccess } from "../../../contracts/daily-dashboard";
import { liveDailyReferenceRows, livePeriodStatus, livePointStateLabel, type LiveDashboardReading as LiveDashboardValue, type LiveSeries } from "../features/dashboards/LiveDashboardContext";
import { availablePeriodStatistics, periodStatisticLabel } from "../features/dashboards/live-period-statistics";
import { REGISTRATION_RETENTION_WINDOWS, registrationCohortMetricId, registrationCohortScopeLabel, type RegistrationCohortScope } from "../features/dashboards/registration-cohort";
import { connectedCohortExportRows } from "./ConnectedCohorts";
import type { WorkbookSheet as ExportSheet } from "./preview-workbook";
import { diagnosticRatioInputs } from "../features/dashboards/diagnostic-inputs";

const isCohortSeries = (id: string) => /^M(?:02[0-3]|115)(?:\.|$)/.test(id);
const nonCohortSeries = (result: DailyDashboardSuccess) => result.data.series.filter(series => !isCohortSeries(series.metric.id));
const hasUsableInputs = (point: LiveSeries["points"][number]) => (!point.sourceStatus || point.sourceStatus === "READY")
  && (point.state === "available" || point.state === "zero_denominator");

export function connectedTopicExportSheets(live: LiveDashboardValue, cohortLive: LiveDashboardValue, scope: RegistrationCohortScope): ExportSheet[] {
  const current = live.state.status === "success" ? live.state.data : null;
  const periods = [
    ...(current ? [{ name: "当前期", result: current, stale: live.state.status === "success" && Boolean(live.state.refreshError) }] : []),
    ...(live.comparison?.state.status === "success" && live.comparison.state.data
      ? [{ name: "对比期", result: live.comparison.state.data, stale: Boolean(live.comparison.state.refreshError) }] : [])
  ];
  const scopeLabel = registrationCohortScopeLabel(scope);
  const selectedIds = REGISTRATION_RETENTION_WINDOWS.map(([id]) => registrationCohortMetricId(id, scope));
  const selectedSeries = cohortLive.state.status === "success"
    ? cohortLive.state.data.data.series.filter(series => selectedIds.includes(series.metric.id)) : [];
  const dayReferences = liveDailyReferenceRows(live, live.metricIds.filter(id => !isCohortSeries(id)));
  const cohortPeriods = [{ name: "当前注册留存", query: cohortLive.query, state: cohortLive.state },
    ...(cohortLive.comparison ? [{ name: "对比注册留存", query: cohortLive.comparison.query, state: cohortLive.comparison.state }] : [])];
  return [
    { name: "读取说明", rows: [
      ["数据性质", "真实后台候选结果，待验数"], ["平台", live.query.pid], ["范围", live.query.dateRange.join(" 至 ")],
      ["主值", "普通日指标为所选结束日；注册留存卡按成熟已返回批次加权；本文件逐日列出原始值"], ["完整性", "未知"], ["数据水位", "未返回"],
      ["对比状态", !live.comparison ? "不对比" : live.comparison.state.status !== "success" || !live.comparison.state.data ? "对比查询未成功，不以演示结果补齐" : "独立读取上一等长周期"],
      ["注册日分组", scopeLabel], ["注册日期", cohortLive.query.dateRange.join(" 至 ")], ["注册留存当前状态", livePeriodStatus(cohortLive)],
      ["注册留存对比日期", cohortLive.comparison?.query.dateRange.join(" 至 ") ?? "未启用对比"], ["注册留存对比状态", livePeriodStatus(cohortLive, true)]
    ] },
    { name: "指标口径", rows: [["指标", "单位", "计算口径", "来源口径"],
      ...[...(current ? nonCohortSeries(current) : []), ...selectedSeries].map(series => [series.metric.name, series.metric.unit, series.metric.formula, series.metric.sourceNote])] },
    { name: "周期统计", rows: [["周期", "平台", "指标", "开始日期", "结束日期", "统计类型", "值", "单位", "验数", "完整性", "查询时间", "刷新状态", "计算版本"],
      ...periods.flatMap(period => nonCohortSeries(period.result).flatMap(series => {
        const statistics = availablePeriodStatistics(series, period.result);
        return (statistics?.values ?? []).map(item => [period.name, period.result.data.query.pid, series.metric.name,
          ...period.result.data.query.dateRange, periodStatisticLabel(item.kind), item.value, series.metric.unit, "待验数", "未知", period.result.data.fetchedAt,
          period.stale ? "上次查询结果" : "本次查询结果", statistics!.aggregationVersion]);
      }))] },
    ...(live.comparison ? [{ name: "日值比较基准", rows: [["指标", "参考", "平台", "日期", "结果（原始值）", "单位", "计算输入", "状态", "查询时间", "刷新状态"],
      ...dayReferences.map(point => [current?.data.series.find(series => series.metric.id === point.metricId)?.metric.name ?? point.metricId,
        point.label, live.query.pid, point.date, point.value, point.unit === "%" ? "原始比值" : point.unit,
        point.calculation ? `${point.calculation.numerator.name}：${point.calculation.numerator.value ?? "—"} ${point.calculation.numerator.unit}；${point.calculation.denominator.name}：${point.calculation.denominator.value ?? "—"} ${point.calculation.denominator.unit}` : "",
        point.reason ?? "该日未返回", point.fetchedAt, point.freshness ?? "本次查询结果"])] }] : []),
    ...periods.flatMap(period => nonCohortSeries(period.result).map(series => ({ name: period.name + "-" + series.metric.name, rows: [
      ["日期", "结果（" + (series.metric.unit === "%" ? "原始比值" : series.metric.unit) + "）", ...series.metric.inputs.map(input => input.name + "（" + input.unit + "）"), "状态", "查询时间", "刷新状态"],
      ...series.points.map(point => [point.date, hasUsableInputs(point) ? point.value : null,
        ...point.inputs.map(input => hasUsableInputs(point) || diagnosticRatioInputs(series.metric, point) ? input.value : null), livePointStateLabel(point, series.metric), period.result.data.fetchedAt,
        period.stale ? "上次查询结果" : "本次查询结果"])
    ] }))),
    ...cohortPeriods.map(period => ({ name: period.name, rows: connectedCohortExportRows(period.query, period.state, scope) }))
  ];
}
