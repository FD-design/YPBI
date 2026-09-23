import { z } from "zod";

export const DAILY_DASHBOARD_VERSION = "day-dashboard/v2" as const;
export const DAILY_STATISTICS_VERSION = "daily-statistics/v1" as const;
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
  schemaVersion: z.literal("day-dashboard/v1"), series: z.array(dailySeriesSchema).min(1).max(100)
}).strict();
const dailyDashboardV2DataSchema = z.object({ ...dailyDashboardDataFields,
  schemaVersion: z.literal(DAILY_DASHBOARD_VERSION),
  series: z.array(dailySeriesSchema.extend({ periodStatistics: dailyPeriodStatisticsSchema })).min(1).max(100)
}).strict();
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
  if (data.schemaVersion === DAILY_DASHBOARD_VERSION && data.series.some(series =>
    series.periodStatistics.dayCount !== days || series.periodStatistics.dateRange.some((date, index) => date !== query.dateRange[index])
  )) return false;
  return data.series.every(series => series.points.length === days && series.points.every((point, i) =>
    point.date === new Date(Date.parse(query.dateRange[0]) + i * 86400000).toISOString().slice(0, 10)
    && point.inputs.length === series.metric.inputs.length
    && point.inputs.every((input, index) => input.key === series.metric.inputs[index].key)
  ));
}
