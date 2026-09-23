import { createContext, useContext, type ReactNode } from "react";
import type { DailyDashboardQuery, DailyDashboardSuccess } from "../../../../contracts/daily-dashboard";
import type { V2ResourceState } from "../../api/useV2Resource";
import type { DashboardMetricCardModel } from "./dashboard-metric-card-model";
import type { CalculationBasis } from "./CalculationEvidence";
import type { DateRangeValue } from "../../../components/ui/date-range-model";
import { dailyMetricReading, dailyReferenceDates, periodMetricReading, type DailyReadingPoint } from "./daily-reading-model";
import { livePeriodReadingStatistics } from "./live-period-statistics";

export type LiveSeries = DailyDashboardSuccess["data"]["series"][number];
export interface LiveDashboardReading {
  query: DailyDashboardQuery;
  metricIds: readonly string[];
  state: V2ResourceState<DailyDashboardSuccess>;
  platformName: string;
  platforms?: readonly { pid: string; name: string }[];
  controls: { date: ReactNode; scope: ReactNode; comparison: ReactNode; dirty: boolean; acceptsSharedRange: (range: DateRangeValue) => boolean; apply: () => void; export: () => void };
  comparison?: { label: string; query: DailyDashboardQuery; state: V2ResourceState<DailyDashboardSuccess | null> };
  dayReference?: { query: DailyDashboardQuery; state: V2ResourceState<DailyDashboardSuccess | null> };
  retry: () => void;
  canExport: boolean;
}
export const LiveDashboardContext = createContext<LiveDashboardReading | null>(null);
export const LiveHeaderExportContext = createContext(false);
export const useLiveDashboard = () => useContext(LiveDashboardContext);
export function liveMetricUnit(live: LiveDashboardReading, metricId: string): string | null {
  const data = live.state.status === "success" && live.state.data.data.query.pid === live.query.pid ? live.state.data.data : null;
  return data?.series.find(series => series.metric.id === metricId)?.metric.unit ?? null;
}
export function livePeriodStatus(live: LiveDashboardReading, before = false) {
  if (before && !live.comparison) return "未启用对比";
  const state = before ? live.comparison?.state : live.state;
  return !state || state.status === "loading" ? "读取中" : state.status === "failure" ? "读取失败" : state.refreshError ? "刷新失败，保留上次查询结果" : state.refreshing ? "刷新中，保留上次查询结果" : "本次查询结果";
}
export function liveExportMetadata(live: LiveDashboardReading) {
  return [["平台", live.query.pid], ["当前日期", live.query.dateRange.join(" 至 ")], ["当前状态", livePeriodStatus(live)],
    ["对比日期", live.comparison?.query.dateRange.join(" 至 ") ?? "未启用对比"], ["对比状态", livePeriodStatus(live, true)],
    ["数据性质", "真实接口候选结果，待验数；完整性未知，数据水位未返回"]];
}
export const liveStateLabel = { available: "已返回", no_record: "当日无记录", no_value: "字段未返回", invalid_value: "数据异常", zero_denominator: "分母为0", immature: "未成熟", source_failure: "来源读取失败" };
export const livePointStateLabel = (point: LiveSeries["points"][number]) => point.sourceStatus === "PROCESSING" ? "计算中"
  : point.sourceStatus === "NOT_MATURE" ? "待成熟"
    : point.sourceStatus === "SOURCE_INCOMPLETE" ? "数据接入中"
      : point.sourceStatus === "FAILED" ? "数据异常"
        : liveStateLabel[point.state];
export const liveValue = (value: number | null, unit: string) => value === null ? "—" : (unit === "%" ? value * 100 : value).toLocaleString("zh-CN", { maximumFractionDigits: ["人", "次"].includes(unit) ? 0 : unit.includes("/人") && Math.abs(value) > 0 && Math.abs(value) < .1 ? 4 : 2, minimumFractionDigits: unit === "%" ? 2 : 0 });
export function liveCalculation(series: LiveSeries, point: LiveSeries["points"][number]): CalculationBasis | undefined {
  if (series.metric.inputs.length !== 2) return undefined;
  const inputs = series.metric.inputs.map((input, index) => ({ name: input.name, unit: input.unit, value: point.inputs[index].value }));
  return { numerator: inputs[0], denominator: inputs[1], formula: series.metric.formula ?? "", scope: `${point.date} · 业务日 · 待验数`, percentage: series.metric.unit === "%", result: liveValue(point.value, series.metric.unit) + " " + series.metric.unit };
}
function trendValue(point: LiveSeries["points"][number] | undefined, unit: string) {
  return point?.value != null ? { raw: point.value, display: liveValue(point.value, unit), actualDate: point.date } : null;
}
function difference(current: number, baseline: number, unit: string) {
  const delta = current - baseline;
  return (delta > 0 ? "+" : "") + liveValue(delta, unit) + (unit === "%" ? " 个百分点" : " " + unit);
}
function cohortSummary(series: LiveSeries, dates?: readonly string[]) {
  const points = series.points.filter(point => point.state === "available" && (!dates || dates.includes(point.date)));
  if (!points.length) return null;
  const inputs = series.metric.inputs.map((input, index) => ({ key: input.key, value: points.reduce((sum, point) => sum + (point.inputs[index].value ?? 0), 0) }));
  return { ...points.at(-1)!, inputs, value: inputs[1].value > 0 ? inputs[0].value / inputs[1].value : null };
}
type DailySources = Pick<LiveDashboardReading, "query" | "state" | "comparison" | "dayReference">;
export function liveDailyPoint(live: DailySources, metricId: string, date: string): DailyReadingPoint & { inputs: LiveSeries["points"][number]["inputs"]; fetchedAt: string; unit: string } {
    const periods = [{ query: live.query, state: live.state }, ...(live.comparison ? [live.comparison] : []), ...(live.dayReference ? [live.dayReference] : [])];
    const period = periods.find(period => date >= period.query.dateRange[0] && date <= period.query.dateRange[1]);
    const data = period?.state.status === "success" ? period.state.data : null;
    const valid = data && data.data.query.pid === live.query.pid && data.data.query.boardId === live.query.boardId
      && data.data.query.dateRange[0] <= period!.query.dateRange[0] && data.data.query.dateRange[1] >= period!.query.dateRange[1];
    const series = valid ? data.data.series.find(item => item.metric.id === metricId) : undefined;
    const point = series?.points.find(item => item.date === date);
    const reason = period?.state.status === "failure" ? "该日查询失败" : period?.state.status === "loading" ? "该日读取中" : point ? livePointStateLabel(point) : "该日未返回";
    const freshness = period?.state.status === "success" && period.state.refreshError ? `${date} 刷新失败，保留上次查询结果` : period?.state.status === "success" && period.state.refreshing ? `${date} 刷新中，保留上次查询结果` : undefined;
    return { date, value: point?.value ?? null, display: series ? liveValue(point?.value ?? null, series.metric.unit) : "—", reason, freshness,
      inputs: point?.inputs ?? [], fetchedAt: valid ? data.data.fetchedAt : "", unit: series?.metric.unit ?? "",
      calculation: series && point ? liveCalculation(series, point) : undefined };
}
export function liveDailyReferenceRows(live: DailySources, metricIds: readonly string[]) {
  if (!live.comparison) return [];
  return metricIds.filter(id => !["M020", "M021", "M022", "M023"].includes(id)).flatMap(id => dailyReferenceDates(live.query.dateRange[1]).map((date, i) => {
    const point = liveDailyPoint(live, id, date);
    return { metricId: id, label: i === 0 ? "较前一天" : "较上周同日", ...point };
  }));
}
export function liveMetricModel(original: DashboardMetricCardModel, live: LiveDashboardReading): DashboardMetricCardModel {
  const model = liveIntervalMetricModel(original, live);
  if (["M020", "M021", "M022", "M023"].includes(original.metric.id)) return periodMetricReading(model, `${live.query.dateRange.join(" 至 ")} · 已成熟注册批次`);
  const data = live.state.status === "success" ? live.state.data : null;
  const series = data?.data.series.find(item => item.metric.id === original.metric.id);
  const statistics = data && series ? livePeriodReadingStatistics(series, data, live.query, live.state.status === "success" && (live.state.refreshError || live.state.refreshing) ? livePeriodStatus(live) : "") : [];
  return dailyMetricReading(model, { date: live.query.dateRange[1], compared: Boolean(live.comparison), read: date => liveDailyPoint(live, original.metric.id, date), statistics });
}

function liveIntervalMetricModel(original: DashboardMetricCardModel, live: LiveDashboardReading): DashboardMetricCardModel {
  const sameQuery = (data: DailyDashboardSuccess, query: DailyDashboardQuery) => data.data.query.pid === query.pid && data.data.query.boardId === query.boardId && data.data.query.dateRange[0] <= query.dateRange[0] && data.data.query.dateRange[1] >= query.dateRange[1];
  const source = live.state.status === "success" && sameQuery(live.state.data, live.query) ? live.state.data.data.series.find(series => series.metric.id === original.metric.id) : undefined;
  const series = source ? { ...source, points: source.points.filter(point => point.date >= live.query.dateRange[0] && point.date <= live.query.dateRange[1]) } : undefined;
  const metric = { ...original.metric, aggregationLabel: `${live.query.dateRange[0]} 至 ${live.query.dateRange[1]} · ${live.platformName} · 业务日`,
    definitionLabel: series?.metric.definition ?? original.metric.definitionLabel };
  if (live.state.status === "loading") return { metric, result: { status: "loading", contextLabel: "真实后台查询", label: "正在读取真实数据", message: "", retryable: false } };
  if (live.state.status === "failure") return { metric, result: { status: "failed", contextLabel: "真实后台查询", label: "暂时无法读取", message: live.state.message, retryable: true } };
  if (!series?.points.length) return { metric, result: { status: "no_values", label: "指标未返回", contextLabel: "真实后台查询", retryable: false } };
  const unit = series.metric.unit;
  const baselineSource = live.comparison?.state.status === "success" && live.comparison.state.data && sameQuery(live.comparison.state.data, live.comparison.query) ? live.comparison.state.data.data.series.find(item => item.metric.id === original.metric.id) : undefined;
  const baseline = baselineSource ? { ...baselineSource, points: baselineSource.points.filter(point => point.date >= live.comparison!.query.dateRange[0] && point.date <= live.comparison!.query.dateRange[1]) } : undefined;
  const cohort = ["M020", "M021", "M022", "M023"].includes(original.metric.id);
  const eligible = series.points.filter(point => point.date >= live.query.dateRange[0] && point.date <= live.query.dateRange[1] && point.state === "available");
  const last = cohort ? cohortSummary(series, eligible.map(point => point.date)) ?? series.points.at(-1)! : series.points.at(-1)!;
  const paired = eligible.map(point => baseline?.points[series.points.indexOf(point)]);
  const previous = cohort ? baseline && paired.length && paired.every(point => point?.state === "available") ? cohortSummary(baseline, paired.map(point => point!.date)) ?? undefined : undefined : baseline?.points.at(-1);
  if (cohort) metric.aggregationLabel = `${live.query.dateRange.join(" 至 ")} · 注册日 · ${live.platformName} · 已返回 ${eligible.length} 批`;
  const toPoints = (current: LiveSeries, counterpart: LiveSeries | undefined, previousPeriod = false) => current.points.map((point, index) => {
    const other = counterpart?.points[index];
    return {
      key: point.date, label: point.date.slice(5), actualDate: point.date,
      value: trendValue(point, unit), counterpart: trendValue(other, unit),
      differenceDisplay: point.value != null && other?.value != null ? difference(previousPeriod ? other.value : point.value, previousPeriod ? point.value : other.value, unit) : null,
      state: point.state === "available" || point.state === "no_record" ? point.state : "no_value" as const,
      stateLabel: livePointStateLabel(point), calculation: liveCalculation(current, point)
    };
  });
  const direction = last.value != null && previous?.value != null ? last.value > previous.value ? "up" as const : last.value < previous.value ? "down" as const : "flat" as const : null;
  const comparison: import("./dashboard-metric-card-model").DashboardMetricComparison | null = !live.comparison ? null :
    last.value == null || previous?.value == null || (unit !== "%" && previous.value === 0) ? {
      status: "unavailable", label: live.comparison.label, detail: live.comparison.state.status === "failure" ? "对比查询失败，未使用演示数据替代。" : previous?.value === 0 ? "对比基准为0，无法计算相对变化。" : cohort ? "对应注册批次未全部返回可比结果。" : "当前期或对比期结束日期无可比值。"
    } : {
      status: "available", label: live.comparison.label,
      display: unit === "%" ? difference(last.value, previous.value, unit) : ((last.value - previous.value) / previous.value > 0 ? "+" : "") + liveValue((last.value - previous.value) / previous.value, "%") + "%",
      detail: `${last.date} 与 ${previous.date} 的同口径日值比较${live.comparison.state.status === "success" && live.comparison.state.refreshError ? "；对比期刷新失败，使用上次查询基准" : ""}`,
      notice: live.comparison.state.status === "success" && live.comparison.state.refreshError ? "对比期刷新失败，使用上次查询基准" : undefined,
      direction, kind: unit === "%" ? "percentage_point" : "relative_change",
      rows: [{ label: "当前期", date: cohort ? live.query.dateRange.join(" 至 ") : last.date, value: liveValue(last.value, unit) + " " + unit }, { label: "对比期", date: cohort ? live.comparison.query.dateRange.join(" 至 ") : previous.date, value: liveValue(previous.value, unit) + " " + unit }]
    };
  const observed = [...series.points].reverse().find(point => point.value !== null);
  const priorObserved = baseline?.points.find(point => point.value !== null);
  const result: import("./dashboard-metric-card-model").DashboardMetricAvailableResult = {
    status: "available", completeness: "unknown",
    value: { raw: (last.value ?? observed?.value ?? priorObserved?.value)!, display: liveValue(last.value, unit), unit }, comparison,
    refresh: live.state.refreshing ? { status: "refreshing", source: "page" } : live.state.refreshError ? { status: "failed", source: "page", message: "当前期刷新失败，保留上次查询结果。", retryable: true } : live.comparison?.state.status === "success" && live.comparison.state.refreshError ? { status: "failed", source: "page", message: "对比期刷新失败，保留上次查询基准。", retryable: true } : { status: "idle" },
    validationLabel: "", watermarkLabel: "", calculation: liveCalculation(series, last),
    trendKind: original.result.status === "available" ? original.result.trendKind : "line",
    trend: { current: toPoints(series, baseline), comparison: baseline ? toPoints(baseline, series, true) : null }
  };
  if (cohort && result.calculation) result.calculation.scope = `${live.query.dateRange.join(" 至 ")} · 注册日 · 仅汇总已结束观察且已返回的批次 · 待验数`;
  if (cohort && comparison?.status === "available") comparison.detail = "当前注册批次与上一等长周期对应批次的加权留存结果；逐批次数据见明细。";
  if (last.value === null) return { metric, result: { status: last.state === "source_failure" ? "failed" : last.state === "no_record" ? "no_records" : "no_values", contextLabel: last.date, label: livePointStateLabel(last), message: `主值 — · ${last.date}。期间其他日期见趋势和明细。`, retryable: last.state === "source_failure",
    history: observed || priorObserved ? result : undefined } };
  return { metric, result };
}
