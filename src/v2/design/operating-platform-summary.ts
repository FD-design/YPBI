import type { DailyPoint, DailyReadingMetric } from "../../../contracts/daily-dashboard";
import { formatMetricNumber, metricNumberFormatOptions } from "../../components/metric-number-format";
import type { CalculationBasis } from "../features/dashboards/CalculationEvidence";
import type { DashboardMetricAvailableResult, DashboardMetricCardModel, DashboardMetricRefresh, DashboardMetricUnavailableResult } from "../features/dashboards/dashboard-metric-card-model";
import { OPERATING_SUMMARY_IDS, summaryColumn } from "./operating-detail-columns";

export interface AggregateSummaryEntry {
  pid: string;
  name: string;
  metric: DailyReadingMetric | null;
  point: DailyPoint | null;
  unavailable?: DashboardMetricUnavailableResult;
  completeness?: DashboardMetricAvailableResult["completeness"];
  refresh?: DashboardMetricRefresh;
}

export type AggregateSummaryEntries = Readonly<Record<string, readonly AggregateSummaryEntry[]>>;
type EligibleEntry = AggregateSummaryEntry & { metric: DailyReadingMetric; point: DailyPoint };
type Unavailable = Pick<DashboardMetricUnavailableResult, "status" | "label" | "message" | "retryable" | "code" | "requestId">;
const finiteValue = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const aggregationNotice = "未跨PID去重；人数不是全站唯一人数";

function pointUnavailable(entry: AggregateSummaryEntry, date: string, divide: boolean): Unavailable | null {
  const point = entry.point;
  if (entry.unavailable && !(point?.state === "zero_denominator" && entry.unavailable.status === "no_values")) return entry.unavailable;
  if (!entry.metric || !point) return { status: "unsupported", label: "字段未返回", retryable: false };
  if (point.date !== date) return { status: "no_values", label: "数据日不一致", retryable: false };
  switch (point.sourceStatus) {
    case "FAILED": return { status: "failed", label: "来源读取失败", retryable: true };
    case "NOT_MATURE": return { status: "immature", label: "未成熟", retryable: false };
    case "PROCESSING": return { status: "not_produced", label: "来源处理中", retryable: false };
    case "SOURCE_INCOMPLETE": return { status: "no_values", label: "来源不完整，仅供核对", retryable: false };
  }
  switch (point.state) {
    case "no_record": return { status: "no_records", label: "当日未返回记录", retryable: false };
    case "immature": return { status: "immature", label: "未成熟", retryable: false };
    case "source_failure": return { status: "failed", label: "来源读取失败", retryable: true };
    case "no_value": return { status: "no_values", label: "字段未返回", retryable: false };
    case "invalid_value": return { status: "no_values", label: "数据异常", retryable: false };
  }
  if (point.state === "available" ? !finiteValue(point.value) : point.state !== "zero_denominator" || !divide || point.value !== null) {
    return { status: "no_values", label: "数据异常", retryable: false };
  }
  if (divide) {
    const definitions = entry.metric.inputs;
    const [numerator, denominator] = definitions.map(input => point.inputs.find(value => value.key === input.key)?.value);
    const exactKeys = definitions.length === 2 && point.inputs.length === 2 && new Set(point.inputs.map(input => input.key)).size === 2;
    if (!exactKeys || !finiteValue(numerator) || !finiteValue(denominator)
      || (point.state === "zero_denominator" ? numerator !== 0 || denominator !== 0 : denominator === 0)
      || entry.metric.referenceMetricId === "M020" && (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || numerator > denominator)) {
      return { status: "no_values", label: "计算输入异常或缺失", retryable: false };
    }
  }
  return null;
}

function metadataSignature(metric: DailyReadingMetric) {
  return JSON.stringify([metric.id, metric.referenceMetricId, metric.authorityVersion, metric.unit, metric.formula, metric.inputs]);
}

function inputSum(entries: EligibleEntry[], key: string) {
  let sum = 0;
  for (const entry of entries) {
    const value = entry.point.inputs.find(input => input.key === key)?.value;
    if (!finiteValue(value)) return null;
    sum += value;
    if (!Number.isFinite(sum)) return null;
  }
  return sum;
}

function summaryRefresh(entries: EligibleEntry[]): DashboardMetricRefresh {
  return entries.map(entry => entry.refresh).find(refresh => refresh?.status === "failed")
    ?? entries.map(entry => entry.refresh).find(refresh => refresh?.status === "refreshing")
    ?? { status: "idle" };
}

/** Entries contain the requested business date and every authorized PID, including unavailable sources. */
export function operatingPlatformSummary(
  date: string,
  entriesByMetric: AggregateSummaryEntries,
  options: { validationLabel?: string; metricIds?: readonly string[] } = {}
): DashboardMetricCardModel[] {
  return (options.metricIds ?? OPERATING_SUMMARY_IDS).map<DashboardMetricCardModel>(id => {
    const column = summaryColumn(id);
    const byPid = new Map<string, AggregateSummaryEntry>();
    let duplicateConflict = false;
    for (const entry of entriesByMetric[id] ?? []) {
      const previous = byPid.get(entry.pid);
      if (previous && JSON.stringify([previous.metric, previous.point, previous.unavailable]) !== JSON.stringify([entry.metric, entry.point, entry.unavailable])) duplicateConflict = true;
      if (!previous) byPid.set(entry.pid, entry);
    }
    const entries = [...byPid.values()], divide = column.kind === "ratio" || column.kind === "average" || id === "M067";
    const eligible: EligibleEntry[] = [];
    const unavailable: { entry: AggregateSummaryEntry; reason: Unavailable }[] = [];
    for (const entry of entries) {
      const reason = pointUnavailable(entry, date, divide);
      if (reason) unavailable.push({ entry, reason });
      else eligible.push(entry as EligibleEntry);
    }
    const partial = eligible.length < entries.length || eligible.some(entry => entry.completeness === "partial");
    const scope = `${date} · ${id === "M020" ? "注册日 · " : ""}${partial ? "部分平台合计" : "各平台合计"} · 覆盖${eligible.length}/${entries.length}平台`;
    const metric = {
      id, name: column.metric.name, aggregationLabel: scope,
      definitionLabel: `${eligible[0]?.metric.definition ?? column.metric.definition} 各平台同指标结果合计；比率和人均按同指标输入合计后计算。${aggregationNotice}。`
    };
    const unavailableModel = (reason: Unavailable, calculation?: CalculationBasis): DashboardMetricCardModel => ({ metric, result: {
      ...reason, contextLabel: scope, validationLabel: options.validationLabel ?? "待验数", watermarkLabel: "来源数据水位未返回",
      ...(calculation ? { calculation } : {})
    } });
    if (duplicateConflict) return unavailableModel({ status: "no_values", label: "重复PID结果不一致", retryable: false, message: "同一PID存在不同结果，无法确定唯一汇总输入。" });
    if (!eligible.length) {
      const priority: Unavailable["status"][] = ["failed", "loading", "immature", "not_produced", "not_ready", "no_values", "no_records", "unsupported"];
      const reason = unavailable.map(item => item.reason).sort((a, b) => priority.indexOf(a.status) - priority.indexOf(b.status))[0]
        ?? { status: "unsupported" as const, label: "无可查询平台", retryable: false };
      metric.definitionLabel += ` 未计入：${unavailable.map(({ entry, reason }) => `${entry.name}（${entry.pid}）：${reason.label ?? reason.status}`).join("；")}。`;
      return unavailableModel({ ...reason, message: reason.message || (entries.length ? `${entries.length}个平台均无可用结果；各平台状态保留在下方明细。` : "当前范围没有可查询平台。") });
    }
    const source = eligible[0].metric;
    if (eligible.some(entry => entry.metric.id !== id || entry.metric.referenceMetricId !== id || metadataSignature(entry.metric) !== metadataSignature(source))) {
      return unavailableModel({ status: "no_values", label: "汇总口径不一致", retryable: false, message: "平台间指标、单位、公式、输入定义或权威版本不一致，无法合计。" });
    }
    const unit = source.unit;
    let raw: number;
    let calculation: CalculationBasis | undefined;
    if (divide) {
      const [numeratorDefinition, denominatorDefinition] = source.inputs;
      const numerator = inputSum(eligible, numeratorDefinition.key), denominator = inputSum(eligible, denominatorDefinition.key);
      calculation = {
        formula: source.formula ?? `${numeratorDefinition.name} ÷ ${denominatorDefinition.name}`, scope: `${scope} · ${aggregationNotice}`,
        numerator: { name: `${numeratorDefinition.name}合计`, value: numerator, unit: numeratorDefinition.unit },
        denominator: { name: `${denominatorDefinition.name}合计`, value: denominator, unit: denominatorDefinition.unit },
        result: "", percentage: column.kind === "ratio"
      };
      if (numerator === null || denominator === null) return unavailableModel({ status: "no_values", label: "合计输入异常", retryable: false }, calculation);
      if (denominator === 0) {
        calculation.result = "分母为0";
        return unavailableModel({ status: "no_values", label: "分母为0", retryable: false, message: "可用平台的合计分母为0，无法计算比率或人均。" }, calculation);
      }
      raw = numerator / denominator;
    } else raw = eligible.reduce((sum, entry) => sum + entry.point.value!, 0);
    if (!Number.isFinite(raw)) return unavailableModel({ status: "no_values", label: "合计数值异常", retryable: false }, calculation);
    const display = column.kind === "ratio" ? (raw * 100).toFixed(2) : formatMetricNumber(raw, "zh-CN", metricNumberFormatOptions(raw, unit));
    if (calculation) calculation.result = `${display}${unit ? " " + unit : ""}`;
    const missing = unavailable.map(({ entry, reason }) => `${entry.name}（${entry.pid}）：${reason.label ?? reason.status}`).join("；");
    if (missing) metric.definitionLabel += ` 未计入：${missing}。`;
    return { metric, result: {
      status: "available", completeness: partial ? "partial" : eligible.every(entry => entry.completeness === "complete") ? "complete" : "unknown",
      refresh: summaryRefresh(eligible), value: { raw, display, unit }, comparison: null, trendKind: "line", trend: { current: [], comparison: null },
      validationLabel: options.validationLabel ?? "待验数", watermarkLabel: `${options.validationLabel === "演示数据" ? "合成平台快照" : "来源数据水位未返回"}${missing ? ` · ${unavailable.length}个平台未计入` : ""}`,
      ...(calculation ? { calculation } : {})
    } };
  });
}
