import type { DailyDashboardSuccess, DailyReadingMetric } from "../../../contracts/daily-dashboard";
import { OPERATING_LIVE_IDS } from "../../../contracts/operating-detail-projection";
export { OPERATING_LIVE_IDS } from "../../../contracts/operating-detail-projection";
import type { V2ResourceState } from "../api/useV2Resource";
import { liveMetricModel, livePointStateLabel, liveDataEnvironment, type LiveDashboardReading } from "../features/dashboards/LiveDashboardContext";
import { dailyDashboardEnvironment } from "../api/daily-dashboard-environment";
import type { DataEnvironmentMode } from "../api/dataEnvironmentPreference";
import { shiftDate } from "../../components/ui/date-range-model";
import { DETAIL_COLUMNS, OPERATING_SUMMARY_IDS, summaryColumn, detailColumnKey, type DetailColumn } from "./operating-detail-columns";
import { dashboardNoRecordLabels, type DashboardMetricCardModel } from "../features/dashboards/dashboard-metric-card-model";
import type { DetailRow, DetailValue } from "./operating-detail-snapshot";
import { formatMetricNumber, metricNumberFormatOptions } from "../../components/metric-number-format";
import { calculationInputValues, diagnosticRatioInputs, DIAGNOSTIC_INPUTS_LABEL, retentionReferenceRatio } from "../features/dashboards/diagnostic-inputs";
import { isMonthlyMetric, liveMonthlySeriesRows } from "../features/dashboards/live-monthly-reading";
import { operatingPlatformSummary, type AggregateSummaryEntry } from "./operating-platform-summary";

export type OperatingResources = Record<string, V2ResourceState<DailyDashboardSuccess>>;
export function operatingResource(resource: OperatingResources[string] | undefined, pid: string, date: string, environment?: DataEnvironmentMode) {
  return resource?.status === "success" && (resource.data.data.query.pid !== pid || resource.data.data.query.dateRange[1] !== date || resource.data.data.query.dateRange[0] > shiftDate(date, -7)
    || environment !== undefined && dailyDashboardEnvironment(resource.data) !== environment) ? undefined : resource;
}
export interface DetailEvidence {
  state: string; label: string; date: string; fetchedAt: string | null; stale: boolean; unit?: string; sourceNote?: string | null;
  inputs: { name: string; unit: string; value: number | null }[]; formula: string | null;
  referenceRatio?: NonNullable<ReturnType<typeof retentionReferenceRatio>>;
}
interface OperatingColumnMetadata { source: DailyReadingMetric; units: Set<string> }
/** The requested operating environment remains authoritative while the primary source is unavailable. */
export function operatingDataEnvironment(live: LiveDashboardReading) {
  return live.dataEnvironment ?? liveDataEnvironment(live);
}
function operatingColumnMetadata(live: LiveDashboardReading | null, resources?: OperatingResources, platform = "all") {
  const metadata = new Map<string, OperatingColumnMetadata>();
  if (!live) return metadata;
  const date = live.query.dateRange[1], environment = operatingDataEnvironment(live);
  const metricIds = new Set(live.metricIds);
  for (const item of live.platforms ?? [{ pid: live.query.pid, name: live.platformName }]) {
    if (platform !== "all" && item.pid !== platform) continue;
    const hasResource = resources && Object.hasOwn(resources, item.pid);
    const resource = hasResource ? operatingResource(resources[item.pid], item.pid, date, environment) : undefined;
    const fallback = !hasResource && item.pid === live.query.pid && live.state.status === "success"
      && live.state.data.data.query.pid === item.pid && live.state.data.data.query.boardId === live.query.boardId
      && live.state.data.data.query.dateRange[0] <= date && live.state.data.data.query.dateRange[1] >= date
      && (environment === undefined || dailyDashboardEnvironment(live.state.data) === environment) ? live.state.data : null;
    const result = resource?.status === "success" ? resource.data : fallback;
    for (const { metric } of result?.data.series ?? []) {
      if (!metricIds.has(metric.id)) continue;
      const current = metadata.get(metric.id);
      if (current) current.units.add(metric.unit);
      else metadata.set(metric.id, { source: metric, units: new Set([metric.unit]) });
    }
  }
  return metadata;
}

/** Only metadata affects columns; refresh flags and values do not invalidate their projection. */
export function operatingLiveColumnMetadataKey(live: LiveDashboardReading | null, resources: OperatingResources, platform = "all") {
  return JSON.stringify([...operatingColumnMetadata(live, resources, platform)].map(([id, { source, units }]) => [id, source, [...units]]));
}

export function operatingLiveColumns(live: LiveDashboardReading | null, resources?: OperatingResources, platform = "all"): DetailColumn[] {
  const metadata = operatingColumnMetadata(live, resources, platform);
  return DETAIL_COLUMNS.map(column => {
    const id = OPERATING_LIVE_IDS[detailColumnKey(column)];
    if (!live?.metricIds.includes(id)) return column;
    const entry = metadata.get(id), source = entry?.source;
    return { ...column, pendingReason: undefined,
      metric: source ? { ...column.metric, definition: [source.definition, source.sourceNote].filter(Boolean).join(" ") } : column.metric,
      unit: entry ? entry.units.size === 1 ? source!.unit : "" : (column.unit.startsWith("USD") ? "" : column.metric.id === "M060" ? "次" : column.unit) };
  });
}
export function operatingLiveRows(live: LiveDashboardReading, resources: OperatingResources, selectedPlatform = "all"): DetailRow[] {
  const date = live.query.dateRange[1];
  const metadata = operatingColumnMetadata(live, resources, selectedPlatform);
  return (live.platforms ?? [{ pid: live.query.pid, name: live.platformName }]).map(platform => {
    const resource = operatingResource(resources[platform.pid], platform.pid, date, operatingDataEnvironment(live));
    const values = DETAIL_COLUMNS.map((column): DetailValue => {
      const id = OPERATING_LIVE_IDS[detailColumnKey(column)];
      if (!id || !live.metricIds.includes(id)) return { current: null, previousDay: null, previousWeek: null, state: "unsupported" };
      const series = resource?.status === "success" ? resource.data.data.series.find(series => series.metric.id === id) : undefined;
      const unitConflict = (metadata.get(id)?.units.size ?? 0) > 1;
      const point = (day: string) => series?.points.find(point => point.date === day);
      const readable = (value: ReturnType<typeof point>) => value && (!value.sourceStatus || value.sourceStatus === "READY") && (value.state === "available" || value.state === "zero_denominator");
      const resultValue = (day: string) => { const value = point(day); return !unitConflict && readable(value) && value?.state === "available" ? value.value : null; };
      const evidence = (day: string): DetailEvidence => {
        const value = point(day);
        const diagnostic = series && diagnosticRatioInputs(series.metric, value);
        const reference = !unitConflict && series && retentionReferenceRatio(series.metric, value);
        const inputValues = series ? calculationInputValues(series.metric, value) : [];
        return { date: day, state: resource?.status === "failure" ? "failed" : !resource || resource.status === "loading" ? "loading" : unitConflict && readable(value) ? "invalid_value" : value?.state === "available" && !readable(value) ? "no_value" : value?.state ?? "no_value",
          label: resource?.status === "failure" ? "读取失败" : !resource || resource.status === "loading" ? "读取中" : unitConflict && readable(value) ? "单位不一致" : diagnostic ? DIAGNOSTIC_INPUTS_LABEL : value ? livePointStateLabel(value) : "字段未返回",
          fetchedAt: resource?.status === "success" ? resource.data.data.fetchedAt : null, stale: resource?.status === "success" && Boolean(resource.refreshError),
          inputs: series?.metric.inputs.map((input, index) => ({ ...input, value: inputValues[index] ?? null })) ?? [], formula: series?.metric.formula ?? null, unit: series?.metric.unit, sourceNote: series?.metric.sourceNote,
          ...(reference ? { referenceRatio: reference } : {}) };
      };
      if (isMonthlyMetric(id)) {
        const month = series && resource?.status === "success" ? liveMonthlySeriesRows(series, resource.data).find(row => row.scope.month === date.slice(0, 7)) : undefined;
        const current = evidence(month?.scope.anchor ?? date);
        const inapplicable = (day: string): DetailEvidence => ({ date: day, state: "not_applicable", label: "不适用日比较", fetchedAt: null, stale: false,
          inputs: [], formula: null, unit: series?.metric.unit, sourceNote: "月活为自然月独立去重人数；日比较不使用月值，月度比较需要独立合法基准。" });
        return { current: month ? resultValue(month.scope.anchor) : null, previousDay: null, previousWeek: null,
          evidence: { current: { ...current, date: month?.label ?? `${date.slice(0, 7)} 自然月 · 查询范围尚未返回`,
            label: current.state === "no_record" ? "本月未返回记录" : current.label,
            sourceNote: [current.sourceNote, month?.point.monthlyMetadata ? "统计截止日包含当天，不是来源数据水位或最近成功加工日；月份状态表示自然月是否结束，加工就绪以指标数据状态为准。" : "实际查询截止不是来源数据水位；来源数据水位未返回。"].filter(Boolean).join(" ") },
          previousDay: inapplicable(shiftDate(date, -1)), previousWeek: inapplicable(shiftDate(date, -7)) } };
      }
      return { current: resultValue(date), previousDay: resultValue(shiftDate(date, -1)), previousWeek: resultValue(shiftDate(date, -7)),
        evidence: { current: evidence(date), previousDay: evidence(shiftDate(date, -1)), previousWeek: evidence(shiftDate(date, -7)) } };
    });
    return { pid: platform.pid, name: platform.name, state: "部分", productMode: null, promotionStatus: null, values };
  });
}
export function operatingLiveSummary(live: LiveDashboardReading, resources: OperatingResources, rows: DetailRow[], platform: string) {
  const date = live.query.dateRange[1], resource = operatingResource(resources[platform], platform, date, operatingDataEnvironment(live));
  if (platform === "all") return operatingPlatformSummary(date, Object.fromEntries(OPERATING_SUMMARY_IDS.map(id =>
    [id, operatingSummaryEntries(live, resources, rows, summaryColumn(id))])));
  return OPERATING_SUMMARY_IDS.map(metricId => {
    const column = summaryColumn(metricId), value = rows.find(row => row.pid === platform)?.values[DETAIL_COLUMNS.indexOf(column)];
    const original: DashboardMetricCardModel = { metric: { id:metricId, name:column.metric.name, definitionLabel:column.metric.definition, aggregationLabel:date }, result: value?.current != null ? { status:"available",completeness:"unknown",refresh:{status:"idle"},value:{raw:value.current,display:formatMetricNumber(value.current*(column.kind==="ratio"?100:1),"zh-CN",column.kind==="currency"||column.kind==="average"?metricNumberFormatOptions(value.current,column.unit):{maximumFractionDigits:2}),unit:column.unit},comparison:null,trendKind:"line",trend:{current:[],comparison:null},validationLabel:"演示数据",watermarkLabel:"" } : {status:"unsupported",label:"待接口支持",contextLabel:date,retryable:false} };
    const id = OPERATING_LIVE_IDS[original.metric.id + ":overall"];
    if (!live.metricIds.includes(id)) return original;
    const result = liveMetricModel({ ...original, metric: { ...original.metric, id } }, { ...live, query: { ...live.query, pid: platform, dateRange: [date, date] }, comparison: undefined,
      platformName: rows.find(row => row.pid === platform)?.name ?? platform, state: resource ?? { status: "loading" } });
    return { ...result, metric: { ...result.metric, id: original.metric.id } };
  });
}

function operatingSummaryEntries(live: LiveDashboardReading, resources: OperatingResources, rows: DetailRow[], column: DetailColumn): AggregateSummaryEntry[] {
  const date = live.query.dateRange[1], id = OPERATING_LIVE_IDS[detailColumnKey(column)];
  return (live.platforms ?? rows.map(({ pid, name }) => ({ pid, name }))).map(platform => {
    const resource = operatingResource(resources[platform.pid], platform.pid, date, operatingDataEnvironment(live));
    const series = resource?.status === "success" && live.metricIds.includes(id) ? resource.data.data.series.find(series => series.metric.id === id) : undefined;
    const point = series?.points.find(point => point.date === date) ?? null;
    return { ...platform, metric: series ? { ...series.metric, id: column.metric.id } : null, point,
      completeness: resource?.status === "success" ? resource.data.data.completeness : "unknown",
      refresh: resource?.status === "success" ? resource.refreshError
        ? { status: "failed" as const, source: "page" as const, retryable: true, ...resource.refreshError }
        : resource.refreshing ? { status: "refreshing" as const, source: "page" as const } : { status: "idle" as const } : undefined,
      unavailable: resource?.status === "failure" ? { status: "failed" as const, contextLabel: date, label: "读取失败", retryable: true, message: resource.message, code: resource.code, requestId: resource.requestId }
        : !resource || resource.status === "loading" ? { status: "loading" as const, contextLabel: date, label: "读取中", retryable: false }
          : !live.metricIds.includes(id) ? { status: "unsupported" as const, contextLabel: date, label: "待接口支持", retryable: false } : undefined };
  });
}

export function operatingLiveColumnSummary(live: LiveDashboardReading, resources: OperatingResources, rows: DetailRow[], column: DetailColumn) {
  return operatingPlatformSummary(live.query.dateRange[1], { [column.metric.id]: operatingSummaryEntries(live, resources, rows, column) }, { metricIds: [column.metric.id] })[0];
}
export function operatingLiveExportRows(rows: DetailRow[], columns: DetailColumn[], date: string) {
  const periods = ["current", "previousDay", "previousWeek"] as const;
  const labels = ["当日", "昨日", "上周同日"];
  const referenceColumns = columns.map((column, index) => ({ column, index })).filter(({ index }) => rows.some(row => periods.some(period => row.values[index]?.evidence?.[period].referenceRatio)));
  const periodLabel = (column: DetailColumn, index: number) => isMonthlyMetric(column.metric.id) ? index === 0 ? "所属自然月" : `${labels[index]}（不适用）` : labels[index];
  const monthlyColumns = columns.map((column, index) => ({ column, index })).filter(({ column }) => isMonthlyMetric(column.metric.id));
  return [["数据日", "业务平台", "PID", ...columns.flatMap(column => periods.flatMap((_, i) => [column.metric.name + "｜" + periodLabel(column, i) + "（" + column.unit + "）", column.metric.name + "｜" + periodLabel(column, i) + "状态", column.metric.name + "｜" + periodLabel(column, i) + "查询时间"])),
    ...monthlyColumns.map(({ column }) => `${column.metric.name}｜自然月实际查询范围（非数据水位）`),
    ...referenceColumns.flatMap(({ column }) => periods.flatMap((_, i) => [`${column.metric.name}｜${labels[i]}参考比率（%）`, `${column.metric.name}｜${labels[i]}参考说明`]))],
    ...rows.map(row => [date, row.name, row.pid, ...row.values.flatMap((value, i) => periods.flatMap(period => {
      const evidence = value.evidence?.[period];
      const status = evidence ? "待验数 · " + evidence.label + (evidence.stale ? " · 上次查询结果" : "")
        : value.state === "unsupported" ? "待接口支持"
        : value.state === "immature" ? "未成熟"
        : value.state === "no_record" && period === "current" ? dashboardNoRecordLabels.day
        : "无可用结果";
      return [value[period] === null ? null : value[period]! * (columns[i].kind === "ratio" ? 100 : 1), status, evidence?.fetchedAt ?? null];
    })), ...monthlyColumns.map(({ index }) => row.values[index]?.evidence?.current.date ?? "未返回"), ...referenceColumns.flatMap(({ index }) => periods.flatMap(period => {
      const reference = row.values[index]?.evidence?.[period].referenceRatio;
      return [reference ? reference.value * 100 : null, reference?.label ?? null];
    }))])];
}

export function operatingLiveCalculationRows(rows: DetailRow[], columns: DetailColumn[], summaries: DashboardMetricCardModel[] = []) {
  const periods = [["current", "当日"], ["previousDay", "昨日"], ["previousWeek", "上周同日"]] as const;
  const hasReferences = rows.some(row => row.values.some(value => periods.some(([period]) => value.evidence?.[period].referenceRatio)));
  const result = [["PID", "业务平台", "指标", "列键", "周期", "实际日期", "计算公式", "输入指标", "输入值", "输入单位", "状态", "查询时间", "刷新状态", "来源口径", ...(hasReferences ? ["参考比率（%）", "参考说明"] : [])],
    ...rows.flatMap(row => row.values.flatMap((value, index) => periods.flatMap(([period, label]) => {
      if (isMonthlyMetric(columns[index].metric.id) && period !== "current") return [];
      const evidence = value.evidence?.[period];
      if (!evidence) return [];
      const inputs = evidence.inputs.length ? evidence.inputs : [{name:"来源未返回计算输入", value:null, unit:""}];
      return inputs.map(input => [row.pid, row.name, columns[index].metric.name, detailColumnKey(columns[index]), isMonthlyMetric(columns[index].metric.id) ? "所属自然月" : label, evidence.date, evidence.formula,
        input.name, input.value, input.unit, "待验数 · " + evidence.label, evidence.fetchedAt, evidence.stale ? "上次查询结果" : "本次查询结果", evidence.sourceNote ?? "",
        ...(hasReferences ? [evidence.referenceRatio ? evidence.referenceRatio.value * 100 : null, evidence.referenceRatio?.label ?? null] : [])]);
    })))];
  for (const model of summaries) {
    const value = model.result, basis = value.calculation;
    const inputs = basis ? [basis.numerator, basis.denominator] : [{ name: "可用平台结果合计", value: value.status === "available" ? value.value.raw : null, unit: value.status === "available" ? value.value.unit : "" }];
    const status = value.status === "available" ? value.completeness === "partial" ? "待验数 · 部分平台合计" : "待验数 · 各平台合计" : value.label ?? value.status;
    result.push(...inputs.map(input => ["all", "各平台合计（未跨PID去重）", model.metric.name, `${model.metric.id}:platform-sum`, "当日平台合计", model.metric.aggregationLabel,
      basis?.formula ?? "可用平台同单位结果相加", input.name, input.value, input.unit, status, null,
      value.status === "available" && value.refresh.status !== "idle" ? "保留上次查询结果" : "本次查询投影", model.metric.definitionLabel, ...(hasReferences ? [null, null] : [])]));
  }
  return result;
}
