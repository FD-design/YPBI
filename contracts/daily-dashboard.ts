import { z } from "zod";

export const DAILY_DASHBOARD_VERSION = "day-dashboard/v2" as const;
export const DAILY_STATISTICS_VERSION = "daily-statistics/v1" as const;
// A board includes metric slices and calculation inputs as well as visible columns.
export const DAILY_DASHBOARD_MAX_SERIES = 256;
export const dailyDashboardQuerySchema = z.object({
  boardId: z.string().min(1).max(32),
  pid: z.string().min(1).max(32),
  dateRange: z.tuple([z.iso.date(), z.iso.date()])
}).strict().superRefine((query, ctx) => {
  const days = (Date.parse(query.dateRange[1]) - Date.parse(query.dateRange[0])) / 86400000 + 1;
  if (days < 1 || days > 366) ctx.addIssue({ code: "custom", path: ["dateRange"], message: "单次支持1至366个业务日" });
});
export type DailyDashboardQuery = z.infer<typeof dailyDashboardQuerySchema>;

const shortText = z.string().min(1).max(200);
export const dailyReadingMetricSchema = z.object({
  id: shortText, name: shortText, unit: shortText, definition: z.string().max(5000),
  authorityVersion: shortText, formula: z.string().max(5000).nullable(),
  referenceMetricId: shortText, sourceNote: z.string().max(2000).nullable(),
  inputs: z.array(z.object({ key: shortText, name: shortText, unit: shortText }).strict()).min(1).max(2)
}).strict().refine(metric => new Set(metric.inputs.map(input => input.key)).size === metric.inputs.length, "输入字段不能重复");
export type DailyReadingMetric = z.infer<typeof dailyReadingMetricSchema>;
const boardSchema = z.object({
  id: z.string(), title: z.string(), category: z.string().nullable(),
  metricIds: z.array(z.string()), pendingMetricNames: z.array(z.string())
}).strict();
export const dailyDashboardCatalogSchema = z.object({ success: z.literal(true), data: z.object({
  enabled: z.boolean(), categories: z.array(z.string()), items: z.array(boardSchema)
}).strict() }).strict();
export type DailyDashboardCatalog = z.infer<typeof dailyDashboardCatalogSchema>["data"];
export const dailyPointSchema = z.object({
  date: z.iso.date(), state: z.enum(["available", "no_record", "no_value", "invalid_value", "zero_denominator", "immature", "source_failure"]),
  sourceStatus: z.enum(["READY", "PROCESSING", "NOT_MATURE", "SOURCE_INCOMPLETE", "FAILED"]).optional(),
  value: z.number().finite().nonnegative().nullable(),
  inputs: z.array(z.object({ key: shortText, value: z.number().finite().nonnegative().nullable() }).strict()).min(1).max(2)
}).strict().superRefine((point, ctx) => {
  if ((point.state === "available") !== (point.value !== null)) ctx.addIssue({ code: "custom", message: "数值与状态不一致" });
});
export type DailyPoint = z.infer<typeof dailyPointSchema>;

export const DAILY_ACQUISITION_MAX_GROUPS = 1000;
export const DAILY_ACQUISITION_MAX_POINTS = 100_000;
export const DAILY_ACQUISITION_METRIC_IDS = {
  channel: ["M001", "M003", "M005", "M006", "M007", "M099"], downloadPlatform: ["M003"]
} as const;
const acquisitionDimensionSchema = z.enum(["channel", "downloadPlatform"]);
const acquisitionRuleVersionSchema = z.string().max(128).nullable();
const acquisitionPointSchema = z.object({ ...dailyPointSchema.shape, ruleVersion: acquisitionRuleVersionSchema }).strict().superRefine((point, ctx) => {
  if ((point.state === "available") !== (point.value !== null)) ctx.addIssue({ code: "custom", message: "分组数值与状态不一致" });
  if (point.sourceStatus && point.sourceStatus !== "READY" && (point.value !== null || point.inputs.some(input => input.value !== null))) ctx.addIssue({ code: "custom", message: "未就绪分组不得携带数值" });
  if (point.sourceStatus ? point.ruleVersion === null : point.ruleVersion !== null || point.state === "available" || point.state === "zero_denominator") ctx.addIssue({ code: "custom", message: "来源结果必须保留规则版本与来源状态" });
});
export const dailyAcquisitionSummarySchema = z.object({
  state: z.enum([...dailyPointSchema.shape.state.options, "unsupported"]),
  sourceStatus: dailyPointSchema.shape.sourceStatus,
  value: dailyPointSchema.shape.value,
  inputs: dailyPointSchema.shape.inputs,
  ruleVersion: acquisitionRuleVersionSchema
}).strict().superRefine((summary, ctx) => {
  if ((summary.state === "available") !== (summary.value !== null)) ctx.addIssue({ code: "custom", message: "分组汇总数值与状态不一致" });
  if (summary.sourceStatus && summary.sourceStatus !== "READY" && (summary.value !== null || summary.inputs.some(input => input.value !== null))) ctx.addIssue({ code: "custom", message: "未就绪汇总不得携带数值" });
  if (summary.state === "unsupported" && (summary.inputs.some(input => input.value !== null) || summary.sourceStatus || summary.ruleVersion !== null)) ctx.addIssue({ code: "custom", message: "未支持汇总不携带来源结果" });
  if (summary.sourceStatus ? summary.ruleVersion === null : summary.ruleVersion !== null || summary.state === "available" || summary.state === "zero_denominator") ctx.addIssue({ code: "custom", message: "汇总结果必须保留规则版本与来源状态" });
});
export type DailyAcquisitionSummary = z.infer<typeof dailyAcquisitionSummarySchema>;
const dailyAcquisitionRequestStatusSchema = z.object({
  state: z.enum(["returned", "empty", "source_failure", "invalid_response"]),
  scopeStatuses: z.array(z.object({
    metricId: shortText,
    sourceStatus: z.enum(["PROCESSING", "NOT_MATURE", "SOURCE_INCOMPLETE", "FAILED"]),
    businessDate: z.iso.date().optional()
  }).strict()).max(DAILY_ACQUISITION_MAX_POINTS),
  generatedAt: z.iso.datetime({ offset: true }).nullable(),
  watermark: z.string().max(128).nullable()
}).strict().superRefine((request, ctx) => {
  if (request.state !== "returned" && request.scopeStatuses.length) ctx.addIssue({ code: "custom", message: "无返回记录的请求不能携带范围状态" });
  if (["source_failure", "invalid_response"].includes(request.state) && (request.generatedAt !== null || request.watermark !== null)) ctx.addIssue({ code: "custom", message: "失败请求不得携带成功来源元数据" });
  const seen = new Set<string>();
  const ranges = new Map(request.scopeStatuses.filter(status => !status.businessDate).map(status => [status.metricId, status.sourceStatus]));
  for (const status of request.scopeStatuses) {
    const key = JSON.stringify([status.metricId, status.businessDate ?? null]);
    if (seen.has(key)) ctx.addIssue({ code: "custom", message: "范围状态不能重复或矛盾" });
    seen.add(key);
    if (status.businessDate && ranges.has(status.metricId) && ranges.get(status.metricId) !== status.sourceStatus) ctx.addIssue({ code: "custom", message: "范围状态与单日状态不能矛盾" });
  }
});
export type DailyAcquisitionRequestStatus = z.infer<typeof dailyAcquisitionRequestStatusSchema>;
const dailyAcquisitionGroupSeriesSchema = z.object({
  metric: dailyReadingMetricSchema,
  points: z.array(acquisitionPointSchema).min(1).max(366),
  summary: dailyAcquisitionSummarySchema
}).strict();
export type DailyAcquisitionGroupSeries = z.infer<typeof dailyAcquisitionGroupSeriesSchema>;
const dailyAcquisitionGroupResultSchema = z.object({
  dimension: acquisitionDimensionSchema,
  completeness: z.literal("unknown"),
  day: dailyAcquisitionRequestStatusSchema,
  summary: dailyAcquisitionRequestStatusSchema,
  groups: z.array(z.object({
    key: shortText.refine(value => value.trim().length > 0, "分组键不能为空白"), label: shortText,
    series: z.array(dailyAcquisitionGroupSeriesSchema).min(1).max(6)
  }).strict()).max(DAILY_ACQUISITION_MAX_GROUPS)
}).strict().superRefine((result, ctx) => {
  if (new Set(result.groups.map(group => group.key)).size !== result.groups.length) ctx.addIssue({ code: "custom", message: "动态分组键不能重复" });
  let pointCount = 0;
  const metricIds: readonly string[] = DAILY_ACQUISITION_METRIC_IDS[result.dimension];
  if ([...result.day.scopeStatuses, ...result.summary.scopeStatuses].some(scope => !metricIds.includes(scope.metricId)) || result.summary.scopeStatuses.some(scope => scope.businessDate)) ctx.addIssue({ code: "custom", message: "范围状态指标或时间粒度不匹配" });
  const requestMatches = (request: DailyAcquisitionRequestStatus, point: DailyAcquisitionSummary | z.infer<typeof acquisitionPointSchema>) => point.state === "unsupported" || request.state === "returned" ||
    (point.state === (request.state === "empty" ? "no_record" : request.state === "source_failure" ? "source_failure" : "invalid_value") && !point.sourceStatus && point.value === null && point.inputs.every(input => input.value === null) && point.ruleVersion === null);
  for (const group of result.groups) {
    if (new Set(group.series.map(series => series.metric.id)).size !== group.series.length) ctx.addIssue({ code: "custom", message: "分组指标不能重复" });
    if (group.series.length !== metricIds.length || group.series.some((series, index) => series.metric.id !== metricIds[index])) ctx.addIssue({ code: "custom", message: "分组指标必须符合对应维度支持集合" });
    if (group.series.some(series => series.points.some(point => !requestMatches(result.day, point)) || !requestMatches(result.summary, series.summary))) ctx.addIssue({ code: "custom", message: "分组值与请求状态不一致" });
    pointCount += group.series.reduce((total, series) => total + series.points.length + 1, 0);
  }
  if (pointCount > DAILY_ACQUISITION_MAX_POINTS) ctx.addIssue({ code: "custom", message: "分组结果超出安全上限" });
});
export type DailyAcquisitionGroupResult = z.infer<typeof dailyAcquisitionGroupResultSchema>;
export const dailyAcquisitionGroupsSchema = z.object({
  channel: dailyAcquisitionGroupResultSchema,
  downloadPlatform: dailyAcquisitionGroupResultSchema
}).strict().superRefine((groups, ctx) => {
  if (groups.channel.dimension !== "channel" || groups.downloadPlatform.dimension !== "downloadPlatform") ctx.addIssue({ code: "custom", message: "获客分组维度不匹配" });
  if (Object.values(groups).reduce((total, dimension) => total + dimension.groups.reduce((sum, group) => sum + group.series.reduce((count, series) => count + series.points.length + 1, 0), 0), 0) > DAILY_ACQUISITION_MAX_POINTS) ctx.addIssue({ code: "custom", message: "获客分组总结果超出安全上限" });
});
export type DailyAcquisitionGroups = z.infer<typeof dailyAcquisitionGroupsSchema>;
export const dailyPeriodStatisticsSchema = z.object({
  aggregationVersion: z.literal(DAILY_STATISTICS_VERSION),
  dateRange: z.tuple([z.iso.date(), z.iso.date()]), dayCount: z.number().int().min(1).max(366),
  state: z.enum(["available", "incomplete", "unsupported"]),
  values: z.array(z.object({ kind: z.enum(["period_sum", "daily_average"]), value: z.number().finite().nonnegative() }).strict()).max(2),
  reason: shortText.nullable()
}).strict().superRefine((statistics, ctx) => {
  const days = (Date.parse(statistics.dateRange[1]) - Date.parse(statistics.dateRange[0])) / 86400000 + 1;
  if (days !== statistics.dayCount) ctx.addIssue({ code: "custom", path: ["dayCount"], message: "周期统计天数与日期范围不一致" });
  if (new Set(statistics.values.map(value => value.kind)).size !== statistics.values.length) ctx.addIssue({ code: "custom", path: ["values"], message: "周期统计类型不能重复" });
  if (statistics.state === "available" ? !statistics.values.length || statistics.reason !== null : statistics.values.length > 0 || statistics.reason === null) {
    ctx.addIssue({ code: "custom", message: "周期统计数值、原因与状态不一致" });
  }
});
export type DailyPeriodStatistics = z.infer<typeof dailyPeriodStatisticsSchema>;
const dailySeriesSchema = z.object({ metric: dailyReadingMetricSchema, points: z.array(dailyPointSchema).min(1).max(366) }).strict();
const dailyDashboardDataFields = {
  query: dailyDashboardQuerySchema,
  queryId: z.string(), fetchedAt: z.iso.datetime(), timezone: z.literal("Asia/Shanghai"),
  validationStatus: z.literal("pending_validation"), completeness: z.literal("unknown"), watermark: z.null(),
  sourceApiIds: z.array(shortText).min(1).max(8)
};
const dailyDashboardV1DataSchema = z.object({ ...dailyDashboardDataFields,
  schemaVersion: z.literal("day-dashboard/v1"), series: z.array(dailySeriesSchema).min(1).max(DAILY_DASHBOARD_MAX_SERIES)
}).strict();
const dailyDashboardV2DataSchema = z.object({ ...dailyDashboardDataFields,
  schemaVersion: z.literal(DAILY_DASHBOARD_VERSION),
  acquisitionGroups: dailyAcquisitionGroupsSchema.optional(),
  series: z.array(dailySeriesSchema.extend({ periodStatistics: dailyPeriodStatisticsSchema })).min(1).max(DAILY_DASHBOARD_MAX_SERIES)
}).strict().superRefine((data, ctx) => {
  if (data.acquisitionGroups && data.query.boardId !== "5.7") ctx.addIssue({ code: "custom", path: ["acquisitionGroups"], message: "动态获客分组仅适用于获客看板" });
  if (data.acquisitionGroups && data.query.dateRange[0] !== data.query.dateRange[1]
    && (data.acquisitionGroups.channel.summary.scopeStatuses.some(scope => scope.metricId === "M099") || data.acquisitionGroups.channel.groups.some(group => group.series.some(series => series.metric.id === "M099" && series.summary.state !== "unsupported")))) ctx.addIssue({ code: "custom", path: ["acquisitionGroups"], message: "多日M099汇总不适用" });
});
export const dailyDashboardV2SuccessSchema = z.object({ success: z.literal(true), data: dailyDashboardV2DataSchema }).strict();
export type DailyDashboardV2Success = z.infer<typeof dailyDashboardV2SuccessSchema>;
export const dailyDashboardSuccessSchema = z.object({ success: z.literal(true),
  data: z.discriminatedUnion("schemaVersion", [dailyDashboardV1DataSchema, dailyDashboardV2DataSchema])
}).strict();
export type DailyDashboardSuccess = z.infer<typeof dailyDashboardSuccessSchema>;

export function dailyDashboardMatchesQuery(result: DailyDashboardSuccess, query: DailyDashboardQuery, metricIds: readonly string[]) {
  const data = result.data;
  if (data.query.boardId !== query.boardId || data.query.pid !== query.pid || data.query.dateRange.some((date, index) => date !== query.dateRange[index])) return false;
  if (data.series.length !== metricIds.length || data.series.some((s, index) => s.metric.id !== metricIds[index])) return false;
  const days = (Date.parse(query.dateRange[1]) - Date.parse(query.dateRange[0])) / 86400000 + 1;
  if (data.schemaVersion === DAILY_DASHBOARD_VERSION && data.acquisitionGroups) {
    if (query.boardId !== "5.7") return false;
    for (const dimension of Object.values(data.acquisitionGroups)) {
      if ([dimension.day, dimension.summary].some(request => request.scopeStatuses.some(status => status.businessDate && (status.businessDate < query.dateRange[0] || status.businessDate > query.dateRange[1])))) return false;
      if (dimension.summary.scopeStatuses.some(status => status.businessDate)) return false;
      for (const group of dimension.groups) for (const series of group.series) {
        if (series.points.length !== days || series.points.some((point, index) => point.date !== new Date(Date.parse(query.dateRange[0]) + index * 86400000).toISOString().slice(0, 10))) return false;
        if ([...series.points, series.summary].some(point => point.inputs.length !== series.metric.inputs.length || point.inputs.some((input, index) => input.key !== series.metric.inputs[index].key))) return false;
      }
    }
  }
  if (data.schemaVersion === DAILY_DASHBOARD_VERSION && data.series.some(series =>
    series.periodStatistics.dayCount !== days || series.periodStatistics.dateRange.some((date, index) => date !== query.dateRange[index])
  )) return false;
  return data.series.every(series => series.points.length === days && series.points.every((point, i) =>
    point.date === new Date(Date.parse(query.dateRange[0]) + i * 86400000).toISOString().slice(0, 10)
    && point.inputs.length === series.metric.inputs.length
    && point.inputs.every((input, index) => input.key === series.metric.inputs[index].key)
  ));
}
