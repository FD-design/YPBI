import { z } from "zod";

export const M016_METRIC_ID = "M016" as const;
export const M016_AUTHORITY_VERSION = "v0.23-draft" as const;
export const MAX_M016_QUERY_DAYS = 366;

const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const nonNegativeSafeIntegerSchema = z.number().refine(
  (value) => Number.isSafeInteger(value) && value >= 0,
  "必须是非负安全整数"
);

export const v2MetricQuerySchema = z.object({
  metricId: z.string().trim().min(1).max(32),
  pid: z.string().trim().min(1).max(32),
  dateRange: z.tuple([z.iso.date(), z.iso.date()]),
  grain: z.string().trim().min(1).max(16).default("day")
}).strict().superRefine((query, context) => {
  if (query.dateRange[0] > query.dateRange[1]) {
    context.addIssue({ code: "custom", path: ["dateRange"], message: "开始日期不能晚于结束日期" });
    return;
  }
  const start = Date.parse(`${query.dateRange[0]}T00:00:00Z`);
  const end = Date.parse(`${query.dateRange[1]}T00:00:00Z`);
  const days = Math.floor((end - start) / 86_400_000) + 1;
  if (days > MAX_M016_QUERY_DAYS) {
    context.addIssue({
      code: "custom",
      path: ["dateRange"],
      message: `首批日趋势单次最多查询 ${MAX_M016_QUERY_DAYS} 个业务日`
    });
  }
});

export type V2MetricQuery = z.infer<typeof v2MetricQuerySchema>;

export const metricCatalogItemSchema = z.object({
  id: z.literal(M016_METRIC_ID),
  code: z.literal("daily_active_user_count"),
  name: z.literal("日活跃用户数"),
  definition: boundedText(1_000),
  unit: z.literal("人"),
  valueType: z.literal("integer"),
  authority: z.object({
    document: z.literal("全站指标体系.md"),
    version: z.literal(M016_AUTHORITY_VERSION),
    validationStatus: z.literal("pending_validation"),
    statusLabel: z.literal("技术称已实现（待验数）")
  }).strict(),
  capabilities: z.object({
    grains: z.tuple([z.literal("day")]),
    platformMode: z.literal("single_pid"),
    dimensions: z.tuple([]),
    filters: z.tuple([]),
    comparisons: z.tuple([])
  }).strict()
}).strict();

export type MetricCatalogItem = z.infer<typeof metricCatalogItemSchema>;

export const platformCatalogItemSchema = z.object({
  id: boundedText(64),
  pid: boundedText(32),
  name: boundedText(256),
  order: nonNegativeSafeIntegerSchema
}).strict();

export type PlatformCatalogItem = z.infer<typeof platformCatalogItemSchema>;

export const v2MetricPointSchema = z.object({
  businessDate: z.iso.date(),
  value: nonNegativeSafeIntegerSchema,
  state: z.literal("available")
}).strict();

export type V2MetricPoint = z.infer<typeof v2MetricPointSchema>;

export const v2UnavailableDateSchema = z.object({
  businessDate: z.iso.date(),
  state: z.enum(["no_record", "no_value"])
}).strict();

export type V2UnavailableDate = z.infer<typeof v2UnavailableDateSchema>;

function enumerateBusinessDates(dateRange: readonly [string, string]) {
  const dates: string[] = [];
  const cursor = new Date(`${dateRange[0]}T00:00:00Z`);
  const end = new Date(`${dateRange[1]}T00:00:00Z`);
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

export const v2MetricQueryDataSchema = z.object({
  metric: metricCatalogItemSchema,
  scope: z.object({
    pid: boundedText(32),
    platformName: boundedText(256)
  }).strict(),
  grain: z.literal("day"),
  dateRange: z.tuple([z.iso.date(), z.iso.date()]),
  seriesStatus: z.enum(["available", "partial", "no_values", "no_records"]),
  points: z.array(v2MetricPointSchema).max(MAX_M016_QUERY_DAYS),
  unavailableDates: z.array(v2UnavailableDateSchema).max(MAX_M016_QUERY_DAYS)
}).strict().superRefine((data, context) => {
  if (data.dateRange[0] > data.dateRange[1]) {
    context.addIssue({ code: "custom", path: ["dateRange"], message: "响应开始日期不能晚于结束日期" });
    return;
  }

  const expectedDates = enumerateBusinessDates(data.dateRange);
  if (expectedDates.length > MAX_M016_QUERY_DAYS) {
    context.addIssue({ code: "custom", path: ["dateRange"], message: "响应日期范围超过首批查询上限" });
    return;
  }

  const seenDates = new Set<string>();
  for (const [collection, entries] of [
    ["points", data.points],
    ["unavailableDates", data.unavailableDates]
  ] as const) {
    entries.forEach((entry, index) => {
      if (seenDates.has(entry.businessDate)) {
        context.addIssue({ code: "custom", path: [collection, index, "businessDate"], message: "同一业务日期不得重复" });
      }
      seenDates.add(entry.businessDate);
    });
  }

  const expectedDateSet = new Set(expectedDates);
  for (const businessDate of seenDates) {
    if (!expectedDateSet.has(businessDate)) {
      context.addIssue({ code: "custom", path: ["dateRange"], message: `响应包含范围外日期 ${businessDate}` });
    }
  }
  for (const businessDate of expectedDates) {
    if (!seenDates.has(businessDate)) {
      context.addIssue({ code: "custom", path: ["dateRange"], message: `响应缺少业务日期 ${businessDate}` });
    }
  }

  const pointCount = data.points.length;
  const unavailableCount = data.unavailableDates.length;
  const noValueCount = data.unavailableDates.filter((entry) => entry.state === "no_value").length;
  const noRecordCount = unavailableCount - noValueCount;
  const statusIsConsistent = (
    (data.seriesStatus === "available" && pointCount === expectedDates.length && unavailableCount === 0)
    || (data.seriesStatus === "partial" && pointCount > 0 && unavailableCount > 0)
    || (data.seriesStatus === "no_values" && pointCount === 0 && noValueCount > 0)
    || (data.seriesStatus === "no_records" && pointCount === 0 && noRecordCount === expectedDates.length)
  );
  if (!statusIsConsistent) {
    context.addIssue({ code: "custom", path: ["seriesStatus"], message: "seriesStatus 与日期数据状态不一致" });
  }
});

export type V2MetricQueryData = z.infer<typeof v2MetricQueryDataSchema>;

export const v2MetricQueryMetaSchema = z.object({
  queryId: boundedText(128),
  sourceApiIds: z.array(boundedText(128)).max(64),
  fetchedAt: z.iso.datetime({ offset: true }),
  validationStatus: z.literal("pending_validation"),
  watermark: z.null(),
  warnings: z.array(boundedText(1_000)).max(100)
}).strict();

export type V2MetricQueryMeta = z.infer<typeof v2MetricQueryMetaSchema>;

export const v2MetricQuerySuccessSchema = z.object({
  success: z.literal(true),
  data: v2MetricQueryDataSchema,
  meta: v2MetricQueryMetaSchema
}).strict();

export type V2MetricQuerySuccess = z.infer<typeof v2MetricQuerySuccessSchema>;

export const v2MetricCatalogSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({ items: z.array(metricCatalogItemSchema).max(1_000) }).strict()
}).strict();

export const v2PlatformCatalogSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({ items: z.array(platformCatalogItemSchema).max(1_000) }).strict()
}).strict();

export type V2MetricCatalogSuccess = z.infer<typeof v2MetricCatalogSuccessSchema>;
export type V2PlatformCatalogSuccess = z.infer<typeof v2PlatformCatalogSuccessSchema>;

export const v2ApiErrorCodeSchema = z.enum([
  "IDENTITY_PROVIDER_UNAVAILABLE",
  "AUTHENTICATION_REQUIRED",
  "BI_READ_ACCESS_DENIED",
  "PID_ACCESS_DENIED",
  "INVALID_V2_REQUEST",
  "INVALID_V2_METRIC_QUERY",
  "V2_REQUEST_TOO_LARGE",
  "V2_UNSUPPORTED_MEDIA_TYPE",
  "V2_REQUEST_REJECTED",
  "UNSUPPORTED_V2_METRIC_QUERY",
  "V2_METRIC_SOURCE_CONFLICT",
  "V2_UPSTREAM_UNAVAILABLE",
  "V2_UPSTREAM_RATE_LIMITED",
  "V2_UPSTREAM_TIMEOUT",
  "V2_UPSTREAM_FAILED",
  "INTERNAL_ERROR"
]);

export type V2ApiErrorCode = z.infer<typeof v2ApiErrorCodeSchema>;

export const v2ApiErrorSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: v2ApiErrorCodeSchema,
    message: boundedText(1_000),
    requestId: boundedText(256)
  }).strict()
}).strict();

export type V2ApiError = z.infer<typeof v2ApiErrorSchema>;
