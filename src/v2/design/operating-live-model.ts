import type { DailyDashboardSuccess } from "../../../contracts/daily-dashboard";
import type { V2ResourceState } from "../api/useV2Resource";
import { liveMetricModel, liveMetricUnit, livePointStateLabel, type LiveDashboardReading } from "../features/dashboards/LiveDashboardContext";
import { shiftDate } from "../../components/ui/date-range-model";
import { DETAIL_COLUMNS, OPERATING_SUMMARY_IDS, summaryColumn, detailColumnKey, type DetailColumn } from "./operating-detail-columns";
import type { DashboardMetricCardModel } from "../features/dashboards/dashboard-metric-card-model";
import type { DetailRow, DetailValue } from "./operating-detail-snapshot";

export const OPERATING_LIVE_IDS: Readonly<Record<string, string>> = {
  "M102:overall":"M102",
  "M036:overall":"M036",
  "M026:老用户":"M026.old", "M081:老用户":"M081.old",
  "M112:overall":"M112", "M060:overall":"M060", "M114:overall":"M114",
  "M112:支付宝":"M112.alipay", "M060:支付宝":"M060.alipay", "M114:支付宝":"M114.alipay",
  "M112:微信":"M112.wechat", "M060:微信":"M060.wechat", "M114:微信":"M114.wechat",
  "M003:overall":"M003", "M005:overall":"M005", "M006:overall":"M006", "M007:overall":"M007",
  "M008:自然新增":"M008.nature", "M008:内部导量":"M008.internal", "M058:自然新增":"M058.nature", "M058:内部导量":"M058.internal",
  "M020:overall":"M020", "M021:overall":"M021", "M022:overall":"M022", "M115:overall:D1":"M115.d1", "M115:overall:D3":"M115.d3", "M115:overall:D7":"M115.d7",
  "M016:overall":"M016", "M016:Android":"M016.android", "M016:iOS":"M016.ios", "M016:老用户":"M016.old",
  "display:M016:overall":"display:M016", "M008:overall":"M008", "M008:Android":"M008.android", "M008:iOS":"M008.ios", "display:M008:overall":"display:M008",
  "M026:overall":"M026", "M026:Android":"M026.android", "M026:iOS":"M026.ios", "M026:新用户":"M026.new",
  "M081:overall":"M081", "M081:Android":"M081.android", "M081:iOS":"M081.ios",
  "M055:overall":"M055.ads", "M055:新用户":"M055.new", "M094:overall":"M094.ads", "M094:新用户":"M094.new",
  "M110:overall":"M110", "M111:overall":"M111", "M058:overall":"M058", "M058:新用户":"M058.new",
  "M059:overall":"M059", "M059:新用户":"M059.new", "M061:overall":"M061", "M064:overall":"M064",
  "M087:overall":"M087", "M088:overall":"M088", "M067:overall":"M067", "M067:新用户":"M067.new", "M001:overall":"M001"
};
export type OperatingResources = Record<string, V2ResourceState<DailyDashboardSuccess>>;
export function operatingResource(resource: OperatingResources[string] | undefined, pid: string, date: string) {
  return resource?.status === "success" && (resource.data.data.query.pid !== pid || resource.data.data.query.dateRange[1] !== date || resource.data.data.query.dateRange[0] > shiftDate(date, -7)) ? undefined : resource;
}
export interface DetailEvidence {
  state: string; label: string; date: string; fetchedAt: string | null; stale: boolean; unit?: string; sourceNote?: string | null;
  inputs: { name: string; unit: string; value: number | null }[]; formula: string | null;
}
export function operatingLiveColumns(live: LiveDashboardReading | null): DetailColumn[] {
  return DETAIL_COLUMNS.map(column => {
    const id = OPERATING_LIVE_IDS[detailColumnKey(column)];
    if (!live?.metricIds.includes(id)) return column;
    const source = live.state.status === "success" && live.state.data.data.query.pid === live.query.pid ? live.state.data.data.series.find(series => series.metric.id === id)?.metric : undefined;
    return { ...column, pendingReason: undefined,
      metric: source ? { ...column.metric, definition: [source.definition, source.sourceNote].filter(Boolean).join(" ") } : column.metric,
      unit: liveMetricUnit(live, id) ?? (column.unit.startsWith("USD") ? "" : column.metric.id === "M060" ? "次" : column.unit) };
  });
}
export function operatingLiveRows(live: LiveDashboardReading, resources: OperatingResources): DetailRow[] {
  const date = live.query.dateRange[1];
  return (live.platforms ?? [{ pid: live.query.pid, name: live.platformName }]).map(platform => {
    const resource = operatingResource(resources[platform.pid], platform.pid, date);
    const values = DETAIL_COLUMNS.map((column): DetailValue => {
      const id = OPERATING_LIVE_IDS[detailColumnKey(column)];
      if (!id || !live.metricIds.includes(id)) return { current: null, previousDay: null, previousWeek: null, state: "unsupported" };
      const series = resource?.status === "success" ? resource.data.data.series.find(series => series.metric.id === id) : undefined;
      const point = (day: string) => series?.points.find(point => point.date === day);
      const evidence = (day: string): DetailEvidence => {
        const value = point(day);
        return { date: day, state: resource?.status === "failure" ? "failed" : !resource || resource.status === "loading" ? "loading" : value?.state ?? "no_value",
          label: resource?.status === "failure" ? "读取失败" : !resource || resource.status === "loading" ? "读取中" : value ? livePointStateLabel(value) : "字段未返回",
          fetchedAt: resource?.status === "success" ? resource.data.data.fetchedAt : null, stale: resource?.status === "success" && Boolean(resource.refreshError),
          inputs: series?.metric.inputs.map((input, i) => ({ ...input, value: value?.inputs[i]?.value ?? null })) ?? [], formula: series?.metric.formula ?? null, unit: series?.metric.unit, sourceNote: series?.metric.sourceNote };
      };
      return { current: point(date)?.value ?? null, previousDay: point(shiftDate(date, -1))?.value ?? null, previousWeek: point(shiftDate(date, -7))?.value ?? null,
        evidence: { current: evidence(date), previousDay: evidence(shiftDate(date, -1)), previousWeek: evidence(shiftDate(date, -7)) } };
    });
    return { pid: platform.pid, name: platform.name, state: "部分", productMode: null, promotionStatus: null, values };
  });
}
export function operatingLiveSummary(live: LiveDashboardReading, resources: OperatingResources, rows: DetailRow[], platform: string) {
  const date = live.query.dateRange[1], resource = operatingResource(resources[platform], platform, date);
  // Cross-PID people and ratios cannot be derived by summing platform rows. In a
  // live session the all-platform choice must stay unavailable until upstream
  // supplies an independent de-duplicated result; it must never fall back to a
  // dated demonstration snapshot.
  if (platform === "all") return OPERATING_SUMMARY_IDS.map(metricId => {
    const column = summaryColumn(metricId);
    return {
      metric: { id: metricId, name: column.metric.name, definitionLabel: column.metric.definition, aggregationLabel: `${date} · 全部平台` },
      result: { status: "unsupported" as const, label: "暂不支持全部平台汇总", contextLabel: date, retryable: false,
        message: "真实数据模式下不合并多个 PID；请选择单个平台查看，或等待上游提供独立去重的大盘结果。" }
    };
  });
  return OPERATING_SUMMARY_IDS.map(metricId => {
    const column = summaryColumn(metricId), value = rows.find(row => row.pid === platform)?.values[DETAIL_COLUMNS.indexOf(column)];
    const original: DashboardMetricCardModel = { metric: { id:metricId, name:column.metric.name, definitionLabel:column.metric.definition, aggregationLabel:date }, result: value?.current != null ? { status:"available",completeness:"unknown",refresh:{status:"idle"},value:{raw:value.current,display:(value.current*(column.kind==="ratio"?100:1)).toLocaleString("zh-CN",{maximumFractionDigits:2}),unit:column.unit},comparison:null,trendKind:"line",trend:{current:[],comparison:null},validationLabel:"演示数据",watermarkLabel:"" } : {status:"unsupported",label:"待接口支持",contextLabel:date,retryable:false} };
    const id = OPERATING_LIVE_IDS[original.metric.id + ":overall"];
    if (platform === "all" || !live.metricIds.includes(id)) return original;
    const result = liveMetricModel({ ...original, metric: { ...original.metric, id } }, { ...live, query: { ...live.query, pid: platform, dateRange: [date, date] }, comparison: undefined,
      platformName: rows.find(row => row.pid === platform)?.name ?? platform, state: resource ?? { status: "loading" } });
    return { ...result, metric: { ...result.metric, id: original.metric.id } };
  });
}
export function operatingLiveExportRows(rows: DetailRow[], columns: DetailColumn[], date: string) {
  const periods = ["current", "previousDay", "previousWeek"] as const;
  const labels = ["当日", "昨日", "上周同日"];
  return [["数据日", "业务平台", "PID", ...columns.flatMap(column => periods.flatMap((_, i) => [column.metric.name + "｜" + labels[i] + "（" + column.unit + "）", column.metric.name + "｜" + labels[i] + "状态", column.metric.name + "｜" + labels[i] + "查询时间"]))],
    ...rows.map(row => [date, row.name, row.pid, ...row.values.flatMap((value, i) => periods.flatMap(period => {
      const evidence = value.evidence?.[period];
      const status = evidence ? "待验数 · " + evidence.label + (evidence.stale ? " · 上次查询结果" : "")
        : value.state === "unsupported" ? "待接口支持"
        : value.state === "immature" ? "未成熟"
        : value.state === "no_record" ? "无记录"
        : "无可用结果";
      return [value[period] === null ? null : value[period]! * (columns[i].kind === "ratio" ? 100 : 1), status, evidence?.fetchedAt ?? null];
    }))])];
}

export function operatingLiveCalculationRows(rows: DetailRow[], columns: DetailColumn[]) {
  const periods = [["current", "当日"], ["previousDay", "昨日"], ["previousWeek", "上周同日"]] as const;
  return [["PID", "业务平台", "指标", "列键", "周期", "实际日期", "计算公式", "输入指标", "输入值", "输入单位", "状态", "查询时间", "刷新状态", "来源口径"],
    ...rows.flatMap(row => row.values.flatMap((value, index) => periods.flatMap(([period, label]) => {
      const evidence = value.evidence?.[period];
      if (!evidence) return [];
      const inputs = evidence.inputs.length ? evidence.inputs : [{name:"来源未返回计算输入", value:null, unit:""}];
      return inputs.map(input => [row.pid, row.name, columns[index].metric.name, detailColumnKey(columns[index]), label, evidence.date, evidence.formula,
        input.name, input.value, input.unit, "待验数 · " + evidence.label, evidence.fetchedAt, evidence.stale ? "上次查询结果" : "本次查询结果", evidence.sourceNote ?? ""]);
    })))];
}
