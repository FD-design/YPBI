import { isDate, shiftDate } from "../../../components/ui/date-range-model";
import { changeDirection } from "../../../components/ui/change-presentation";
import type { CalculationBasis } from "./CalculationEvidence";
import type { DashboardMetricCardModel, DashboardMetricComparison, DashboardMetricReading, DashboardMetricTrendPoint } from "./dashboard-metric-card-model";

export interface DailyReadingPoint {
  date: string;
  value: number | null;
  display: string;
  reason?: string;
  freshness?: string;
  calculation?: CalculationBasis;
}
type Statistic = DashboardMetricReading["statistics"][number];

export const dailyReferenceDates = (date: string) => [shiftDate(date, -1), shiftDate(date, -7)] as const;

export function dailyDateLabel(date: string) {
  if (!isDate(date)) return date;
  const weekday = "日一二三四五六"[new Date(`${date}T00:00:00Z`).getUTCDay()];
  return `${Number(date.slice(5, 7))}-${Number(date.slice(8, 10))}（${weekday}）`;
}

export function dailyComparison(current: DailyReadingPoint, reference: DailyReadingPoint, unit: string, label: string): DashboardMetricComparison {
  if (current.value === null || reference.value === null) return {
    status: "unavailable", label,
    detail: `${current.date} 与 ${reference.date}：${current.value === null ? current.reason ?? "所选结束日没有可用值" : reference.reason ?? "对比日没有可用值"}。`
  };
  if (unit !== "%" && reference.value === 0) return { status: "unavailable", label, detail: `${reference.date} 基准为0，无法计算相对变化；${current.date} 为 ${current.display} ${unit}。` };
  const delta = current.value - reference.value, ratio = unit === "%", change = ratio ? delta * 100 : delta / reference.value * 100;
  const format = (value: number) => {
    const magnitude = Math.abs(value), sign = value > 0 ? "+" : value < 0 ? "-" : "";
    if (magnitude > 0 && magnitude < .0001) return `${sign}<0.0001`;
    const digits = magnitude > 0 && magnitude < .01 ? 4 : 2;
    return `${sign}${magnitude.toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
  };
  return {
    status: "available", label, kind: ratio ? "percentage_point" : "relative_change", direction: changeDirection(delta),
    display: `${format(change)}${ratio ? " 个百分点" : "%"}`,
    detail: `${current.date} 与 ${reference.date} 的同口径日值比较。${[current.freshness, reference.freshness].filter(Boolean).join("；")}`,
    notice: [current.freshness, reference.freshness].filter(Boolean).join("；") || undefined,
    rows: [{ label: "所选日", date: current.date, value: `${current.display} ${unit}` }, { label: "对比日", date: reference.date, value: `${reference.display} ${unit}` }],
    difference: { display: `${format(ratio ? delta * 100 : delta)} ${ratio ? "个百分点" : unit}`, direction: changeDirection(delta) }
  };
}

function fromTrend(point: DashboardMetricTrendPoint | undefined, date: string): DailyReadingPoint {
  return { date, value: point?.value?.raw ?? null, display: point?.value?.display ?? "—", reason: point?.stateLabel ?? "该日未返回", calculation: point?.calculation };
}
export function trendComparisonLabel(model: DashboardMetricCardModel) {
  const result = model.result.status === "available" ? model.result : model.result.history;
  const before = result?.trend.comparison;
  return before?.length ? `趋势对比：${before[0].actualDate} 至 ${before.at(-1)!.actualDate}` : undefined;
}

/** Presentation adapter only. Period statistics must be supplied by a legal source. */
export function dailyMetricReading(model: DashboardMetricCardModel, options: {
  date: string;
  compared: boolean;
  read?: (date: string) => DailyReadingPoint;
  statistics?: Statistic[];
}): DashboardMetricCardModel {
  const result = model.result.status === "available" ? model.result : model.result.history;
  const read = options.read ?? ((date: string) => fromTrend(result?.trend.current.find(point => point.actualDate === date) ?? result?.trend.comparison?.find(point => point.actualDate === date), date));
  const current = model.result.status === "available" ? read(options.date) : fromTrend(model.result.history?.trend.current.find(point => point.actualDate === options.date), options.date);
  if (model.result.status !== "available" && current.value === null) current.reason = model.result.label;
  const unit = result?.value.unit ?? "";
  const reading: DashboardMetricReading = {
    primaryLabel: `所选日 ${options.date}`,
    primaryDate: options.date,
    comparisons: options.compared ? dailyReferenceDates(options.date).map((date, i) => dailyComparison(current, read(date), unit, i === 0 ? "较前一天" : "较上周同日")) : [],
    statistics: options.statistics ?? [],
    trendComparisonLabel: options.compared ? trendComparisonLabel(model) : undefined
  };
  if (model.result.status !== "available") return { ...model, result: { ...model.result, reading, ...(model.result.history ? { history: { ...model.result.history, reading } } : {}) } };
  const value = { raw: current.value ?? model.result.value.raw, display: current.value === null ? "—" : current.display.replace(new RegExp(`\\s*${unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), ""), unit };
  const next = { ...model.result, reading, value, calculation: current.calculation };
  if (current.value === null) return { ...model, result: {
    status: current.reason?.includes("失败") ? "failed" : current.reason?.includes("无记录") ? "no_records" : "no_values",
    contextLabel: options.date, label: current.reason ?? "所选结束日没有可用值", message: `主值 — · ${options.date}；其他日期仍可查看。`, retryable: Boolean(current.reason?.includes("失败")),
    validationLabel: model.result.validationLabel, watermarkLabel: model.result.watermarkLabel, reading, history: next
  } };
  return { ...model, result: next };
}

/** Natural-month and fixed-cohort metrics retain their documented time semantics. */
export function periodMetricReading(model: DashboardMetricCardModel, primaryLabel: string): DashboardMetricCardModel {
  const result = model.result.status === "available" ? model.result : model.result.history;
  const reading: DashboardMetricReading = { primaryLabel, comparisons: result?.comparison ? [result.comparison] : [], statistics: [], trendComparisonLabel: trendComparisonLabel(model) };
  return { ...model, result: { ...model.result, reading, ...(model.result.status !== "available" && model.result.history ? { history: { ...model.result.history, reading } } : {}) } };
}
