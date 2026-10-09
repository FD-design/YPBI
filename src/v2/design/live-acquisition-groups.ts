import { DAILY_ACQUISITION_METRIC_IDS, type DailyAcquisitionGroupSeries, type DailyAcquisitionRequestStatus, type DailyAcquisitionSummary, type DailyReadingMetric } from "../../../contracts/daily-dashboard";
import { liveExportMetadata, livePeriodStatus, livePointStateLabel, type LiveDashboardReading } from "../features/dashboards/LiveDashboardContext";
import { acquisitionDates, acquisitionMetric } from "./acquisition-preview-model";
import type { WorkbookSheet } from "./preview-workbook";

export type AcquisitionGroupDimension = "channel" | "downloadPlatform";
export const ACQUISITION_GROUP_IDS = DAILY_ACQUISITION_METRIC_IDS;
export const ACQUISITION_GROUP_LABELS = { channel: "来源渠道", downloadPlatform: "下载目标" };
export const ACQUISITION_GROUP_LIMIT = "分组全量性待确认，仅展示已返回分组的独立数值，不计算占比或补齐其他分组。";
export type AcquisitionGroupValue = {
  value: number | null; state: string; inputs: { key: string; name: string; unit: string; value: number | null }[];
  ruleVersion: string | null; date: string; fetchedAt: string; watermark: string | null; freshness: string;
};
export type AcquisitionGroupMetric = { metric: DailyReadingMetric; summary: AcquisitionGroupValue; points: AcquisitionGroupValue[] };
export type AcquisitionLiveGroupRow = { key: string; name: string; current: Record<string, AcquisitionGroupMetric>; previous?: Record<string, AcquisitionGroupMetric> };

function requestState(request: DailyAcquisitionRequestStatus | undefined) {
  return !request ? "分组待接入" : request.state === "source_failure" ? "读取失败" : request.state === "invalid_response" ? "数据异常" : request.state === "empty" ? "本期未返回分组记录" : undefined;
}
function requestScopeStates(request: DailyAcquisitionRequestStatus | undefined, label: string) {
  return request?.scopeStatuses.map(status => `${label}${status.businessDate ? ` ${status.businessDate}` : ""} · ${acquisitionMetric(status.metricId).name}：${livePointStateLabel({ date: status.businessDate ?? "", state: "no_value", sourceStatus: status.sourceStatus, value: null, inputs: [] })}`) ?? [];
}
function fallbackMetric(id: string): DailyReadingMetric {
  const metric = acquisitionMetric(id);
  return { id, name: metric.name, unit: ["M001", "M003"].includes(id) ? "次" : "%", definition: metric.definition,
    referenceMetricId: id, authorityVersion: "", formula: null, sourceNote: null, inputs: [] };
}
function groupPeriod(live: LiveDashboardReading, dimension: AcquisitionGroupDimension, before: boolean) {
  const period = before ? live.comparison : live, query = period?.query, resource = period?.state;
  const result = resource?.status === "success" ? resource.data : undefined;
  // Group summaries belong to the exact request interval, including cached placeholder responses.
  const matches = query && result && query.boardId === "5.7" && query.boardId === live.query.boardId && query.pid === live.query.pid
    && result.data.query.boardId === query.boardId && result.data.query.pid === query.pid
    && result.data.query.dateRange.every((date, i) => date === query.dateRange[i]);
  const extension = matches && result.data.schemaVersion === "day-dashboard/v2" ? result.data.acquisitionGroups?.[dimension] : undefined;
  const invalidDimension = extension && extension.dimension !== dimension;
  const groups = invalidDimension ? [] : extension?.groups ?? [];
  const groupIndex = new Map<string, typeof groups>();
  for (const group of groups) groupIndex.set(group.key, [...(groupIndex.get(group.key) ?? []), group]);
  const dates = query ? acquisitionDates({ start: query.dateRange[0], end: query.dateRange[1] }) : [];
  const blocked = !period ? "未启用对比" : resource?.status === "loading" ? "读取中" : resource?.status === "failure" ? "读取失败"
    : !matches ? "查询范围不匹配" : invalidDimension ? "数据异常" : !extension ? `${ACQUISITION_GROUP_LABELS[dimension]}维度待接入：BI 尚未接入该维度的真实分组结果。` : undefined;
  const status = blocked ?? ([...new Set([requestState(extension?.day), requestState(extension?.summary), ...requestScopeStates(extension?.day, "逐日"), ...requestScopeStates(extension?.summary, "汇总")].filter(Boolean))].join("；") || "已返回");
  return { query, dates, groups, groupIndex, extension, blocked, status, fetchedAt: matches ? result.data.fetchedAt : "", freshness: livePeriodStatus(live, before) };
}
type GroupPeriod = ReturnType<typeof groupPeriod>;
function groupMetric(period: GroupPeriod, key: string, id: string): AcquisitionGroupMetric {
  const groups = period.groupIndex.get(key) ?? [], group = groups.length === 1 ? groups[0] : undefined;
  const series = group?.series.filter(series => series.metric.id === id) ?? [], selected = series.length === 1 ? series[0] : undefined;
  const metric = selected?.metric ?? fallbackMetric(id);
  const pointIndex = new Map<string, DailyAcquisitionGroupSeries["points"]>();
  for (const point of selected?.points ?? []) pointIndex.set(point.date, [...(pointIndex.get(point.date) ?? []), point]);
  const read = (point: DailyAcquisitionSummary | DailyAcquisitionGroupSeries["points"][number] | undefined, request: DailyAcquisitionRequestStatus | undefined, date: string, duplicate = false): AcquisitionGroupValue => {
    const scopeStatus = request?.scopeStatuses.find(status => status.metricId === id && (!status.businessDate || status.businessDate === date));
    const status = scopeStatus?.sourceStatus ?? point?.sourceStatus;
    const invalidInputs = point && (point.inputs.length !== metric.inputs.length || metric.inputs.some(input => point.inputs.filter(value => value.key === input.key).length !== 1)
      || point.inputs.some(input => input.value !== null && (!Number.isFinite(input.value) || input.value < 0)));
    const failure = period.blocked ?? (groups.length > 1 || series.length > 1 || duplicate ? "数据异常" : undefined)
      ?? requestState(request) ?? (!group ? "本期未返回该分组" : !selected ? "指标未返回" : undefined);
    const valid = !failure && point?.state === "available" && (!status || status === "READY") && point.value !== null && Number.isFinite(point.value) && point.value >= 0 && !invalidInputs;
    const readableInputs = !failure && (!status || status === "READY") && !invalidInputs && (valid || point?.state === "zero_denominator");
    const state = failure ?? (status && status !== "READY" ? livePointStateLabel({ date, value: null, inputs: [], state: "no_value", sourceStatus: status })
      : !point ? date.includes(" 至 ") ? "区间汇总未返回" : "当日未返回"
        : point.state === "unsupported" ? "区间汇总待支持"
          : point.state === "available" && !valid ? "数据异常" : livePointStateLabel({ ...point, date, state: point.state }));
    return { date, value: valid ? point!.value : null, state, ruleVersion: point?.ruleVersion ?? null,
      inputs: metric.inputs.map(input => ({ ...input, value: readableInputs ? point!.inputs.find(value => value.key === input.key)?.value ?? null : null })),
      fetchedAt: request?.generatedAt ?? period.fetchedAt, watermark: request?.watermark ?? null, freshness: period.freshness };
  };
  return { metric, summary: read(selected?.summary, period.extension?.summary, period.query?.dateRange.join(" 至 ") ?? ""),
    points: period.dates.map(date => { const points = pointIndex.get(date) ?? []; return read(points.length === 1 ? points[0] : undefined, period.extension?.day, date, points.length > 1); }) };
}

export function acquisitionGroupModel(live: LiveDashboardReading, dimension: AcquisitionGroupDimension) {
  const current = groupPeriod(live, dimension, false), previous = groupPeriod(live, dimension, true), ids = ACQUISITION_GROUP_IDS[dimension];
  const keys = [...new Set([...current.groups, ...(live.comparison ? previous.groups : [])].map(group => group.key))];
  const rows: AcquisitionLiveGroupRow[] = keys.map(key => ({ key, name: key,
    current: Object.fromEntries(ids.map(id => [id, groupMetric(current, key, id)])),
    ...(live.comparison ? { previous: Object.fromEntries(ids.map(id => [id, groupMetric(previous, key, id)])) } : {}) }));
  return { dimension, ids, rows, current, previous: live.comparison ? previous : undefined,
    unavailableReason: current.blocked, emptyReason: current.status === "已返回" ? "本期未返回分组结果" : current.status };
}
export type AcquisitionGroupModel = ReturnType<typeof acquisitionGroupModel>;
export function acquisitionGroupValue(metric: DailyReadingMetric, value: number | null) {
  return value === null ? "—" : metric.unit === "%" ? `${(value * 100).toFixed(2)}%` : `${value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })} ${metric.unit}`;
}
export function acquisitionGroupInputs(value: AcquisitionGroupValue) {
  return value.inputs.map(input => `${input.name}：${input.value ?? "—"} ${input.unit}`).join("；");
}
export function acquisitionGroupWorkbook(live: LiveDashboardReading, dimension: AcquisitionGroupDimension): WorkbookSheet[] {
  const model = acquisitionGroupModel(live, dimension), label = ACQUISITION_GROUP_LABELS[dimension];
  const records = model.rows.flatMap(row => model.ids.flatMap(id => [{ period: "当前期", key: row.key, reading: row.current[id] }, ...(row.previous ? [{ period: "对比期", key: row.key, reading: row.previous[id] }] : [])]));
  const row = (period: string, key: string, metric: DailyReadingMetric, point: AcquisitionGroupValue) => [period, point.date, live.query.pid, key, metric.name, point.value, metric.unit === "%" ? "原始比值" : metric.unit, acquisitionGroupInputs(point), point.state, point.ruleVersion, point.fetchedAt, point.watermark, point.freshness];
  const head = ["周期", "日期区间", "平台", label, "指标", "数值", "单位", "实际输入", "状态", "规则版本", "查询时间", "数据至", "刷新状态"];
  return [{ name: "数据说明", rows: [...liveExportMetadata(live), ["分组范围", ACQUISITION_GROUP_LIMIT], ["当前状态", model.current.status], ...(model.previous ? [["对比状态", model.previous.status]] : [])] },
    { name: `${label}汇总`, rows: [head, ...records.map(record => row(record.period, record.key, record.reading.metric, record.reading.summary))] },
    { name: `${label}逐日`, rows: [head, ...records.flatMap(record => record.reading.points.map(point => row(record.period, record.key, record.reading.metric, point)))] }];
}
