import { z } from "zod";

export const M016_METRIC_ID = "M016" as const;
export const MAX_M016_QUERY_DAYS = 366;

const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const nullableBoundedText = (maximum: number) => boundedText(maximum).nullable();
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
    version: boundedText(64),
    validationStatus: z.enum(["pending_validation", "passed"]),
    statusLabel: z.enum(["技术称已实现（待验数）", "真实验数已通过"])
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

export const metricDefinitionSourceBuildStatusSchema = z.discriminatedUnion("code", [
  z.object({
    code: z.literal("tech_claimed_pending_validation"),
    label: z.enum([
      "技术称已实现（待验数）",
      "基础指标技术称已实现（待验数），派生结果待验数"
    ])
  }).strict(),
  z.object({
    code: z.literal("definition_pending_confirmation"),
    label: z.literal("现有口径待确认")
  }).strict(),
  z.object({
    code: z.literal("tracking_draft"),
    label: z.literal("埋点草稿支持")
  }).strict(),
  z.object({
    code: z.literal("platform_processing_required"),
    label: z.literal("需平台加工")
  }).strict(),
  z.object({
    code: z.literal("capability_missing"),
    label: z.literal("待补能力")
  }).strict(),
]);

export const metricDefinitionMappingStatusSchema = z.enum([
  "not_configured",
  "configured",
  "stale",
  "disabled"
]);

export const metricDefinitionValidationStatusSchema = z.enum([
  "not_started",
  "running",
  "passed",
  "failed",
  "expired"
]);

export const metricDefinitionAnalysisReasonCodeSchema = z.enum([
  "mapping_not_configured",
  "mapping_stale",
  "mapping_disabled",
  "validation_not_passed",
  "validation_mapping_mismatch"
]);

export const metricDefinitionClassificationSchema = z.object({
  primary: boundedText(128),
  secondary: boundedText(128),
  primaryOrder: nonNegativeSafeIntegerSchema,
  secondaryOrder: nonNegativeSafeIntegerSchema
}).strict();

export const metricDefinitionAuthoritySchema = z.object({
  document: z.literal("全站指标体系.md"),
  version: boundedText(64),
  sourceBuildStatus: metricDefinitionSourceBuildStatusSchema,
  businessDomain: nullableBoundedText(256),
  metricType: z.enum(["业务结果", "用户行为", "技术质量", "经营结算", "数据质量"]).nullable(),
  metricLevel: z.enum(["核心", "过程", "诊断", "护栏"]).nullable(),
  definition: boundedText(4_000),
  developmentFormula: nullableBoundedText(4_000),
  registeredFormula: boundedText(4_000),
  deduplication: boundedText(4_000),
  windowAndGrain: boundedText(4_000),
  dataSource: nullableBoundedText(4_000),
  exclusions: nullableBoundedText(4_000),
  knownIssues: nullableBoundedText(4_000),
  recommendedDefinition: nullableBoundedText(4_000),
  boundary: nullableBoundedText(4_000),
  baseMetricIds: z.array(z.string().regex(/^M\d{3}$/)).max(32),
  unit: nullableBoundedText(64)
}).strict();

export const metricDefinitionCapabilitiesSchema = z.object({
  grains: z.array(boundedText(32)).max(32),
  platformModes: z.array(z.enum(["single_pid", "multi_pid", "official_overall"])).max(3),
  dimensions: z.array(boundedText(128)).max(128),
  filters: z.array(boundedText(128)).max(128),
  comparisons: z.array(boundedText(128)).max(32)
}).strict();

export const metricDefinitionMappingSchema = z.object({
  status: metricDefinitionMappingStatusSchema,
  mappingVersion: nullableBoundedText(128),
  authorityVersion: nullableBoundedText(64),
  sourceApiIds: z.array(boundedText(256)).max(64),
  capabilities: metricDefinitionCapabilitiesSchema
}).strict();

export const metricDefinitionValidationSchema = z.object({
  status: metricDefinitionValidationStatusSchema,
  mappingVersion: nullableBoundedText(128),
  authorityVersion: nullableBoundedText(64),
  validatedAt: z.iso.datetime({ offset: true }).nullable(),
  evidenceId: nullableBoundedText(256)
}).strict();

export type MetricDefinitionMapping = z.infer<typeof metricDefinitionMappingSchema>;
export type MetricDefinitionValidation = z.infer<typeof metricDefinitionValidationSchema>;
export type MetricDefinitionAnalysisReasonCode = z.infer<typeof metricDefinitionAnalysisReasonCodeSchema>;

export interface DerivedMetricAnalysisState {
  status: "available" | "unavailable";
  reasonCodes: MetricDefinitionAnalysisReasonCode[];
}

export function deriveMetricAnalysisState(input: {
  authorityVersion: string;
  ypbiMapping: MetricDefinitionMapping;
  validation: MetricDefinitionValidation;
}): DerivedMetricAnalysisState {
  const { authorityVersion, ypbiMapping, validation } = input;
  let reasonCode: MetricDefinitionAnalysisReasonCode | null = null;
  if (ypbiMapping.status === "not_configured") reasonCode = "mapping_not_configured";
  else if (ypbiMapping.status === "disabled") reasonCode = "mapping_disabled";
  else if (ypbiMapping.status === "stale" || ypbiMapping.authorityVersion !== authorityVersion) reasonCode = "mapping_stale";
  else if (validation.status !== "passed") reasonCode = "validation_not_passed";
  else if (
    validation.mappingVersion !== ypbiMapping.mappingVersion
    || validation.authorityVersion !== authorityVersion
  ) reasonCode = "validation_mapping_mismatch";
  return reasonCode
    ? { status: "unavailable", reasonCodes: [reasonCode] }
    : { status: "available", reasonCodes: [] };
}

export const metricDefinitionAnalysisSchema = z.object({
  status: z.enum(["available", "unavailable"]),
  reasonCodes: z.array(metricDefinitionAnalysisReasonCodeSchema).max(5)
}).strict();

export const metricDefinitionItemSchema = z.object({
  id: z.string().regex(/^(?:M|DM)\d{3}$/),
  kind: z.enum(["standard", "period_derived"]),
  code: boundedText(128),
  name: boundedText(256),
  order: nonNegativeSafeIntegerSchema,
  classification: metricDefinitionClassificationSchema.nullable(),
  authority: metricDefinitionAuthoritySchema,
  ypbiMapping: metricDefinitionMappingSchema,
  validation: metricDefinitionValidationSchema,
  analysis: metricDefinitionAnalysisSchema
}).strict().superRefine((item, context) => {
  const expectedAnalysis = deriveMetricAnalysisState({
    authorityVersion: item.authority.version,
    ypbiMapping: item.ypbiMapping,
    validation: item.validation
  });
  if (
    item.analysis.status !== expectedAnalysis.status
    || item.analysis.reasonCodes.length !== expectedAnalysis.reasonCodes.length
    || item.analysis.reasonCodes.some((reasonCode, index) => reasonCode !== expectedAnalysis.reasonCodes[index])
  ) {
    context.addIssue({
      code: "custom",
      path: ["analysis"],
      message: "analysis 必须由当前映射与验数状态派生"
    });
  }

  if (item.kind === "standard" && (!/^M\d{3}$/.test(item.id) || !item.classification)) {
    context.addIssue({ code: "custom", path: ["classification"], message: "标准指标必须具有唯一分类归属" });
  }
  if (item.kind === "period_derived" && (!/^DM\d{3}$/.test(item.id) || item.classification !== null)) {
    context.addIssue({ code: "custom", path: ["classification"], message: "周期派生指标不得伪造标准指标分类" });
  }

  if (item.ypbiMapping.status === "not_configured") {
    const mappingHasConfiguration = item.ypbiMapping.mappingVersion !== null
      || item.ypbiMapping.authorityVersion !== null
      || item.ypbiMapping.sourceApiIds.length > 0
      || Object.values(item.ypbiMapping.capabilities).some((values) => values.length > 0);
    if (mappingHasConfiguration) {
      context.addIssue({ code: "custom", path: ["ypbiMapping"], message: "未配置映射不得携带伪能力声明" });
    }
  } else if (!item.ypbiMapping.mappingVersion || !item.ypbiMapping.authorityVersion) {
    context.addIssue({ code: "custom", path: ["ypbiMapping"], message: "已建立的映射必须声明映射版本与权威版本" });
  }

  if (item.validation.status === "not_started") {
    if (
      item.validation.mappingVersion
      || item.validation.authorityVersion
      || item.validation.validatedAt
      || item.validation.evidenceId
    ) {
      context.addIssue({ code: "custom", path: ["validation"], message: "未开始验数不得携带验数结果" });
    }
  } else if (!item.validation.mappingVersion || !item.validation.authorityVersion) {
    context.addIssue({
      code: "custom",
      path: ["validation"],
      message: "验数状态必须同时绑定映射版本与权威指标版本"
    });
  }
  if (["passed", "failed", "expired"].includes(item.validation.status)) {
    if (!item.validation.validatedAt || !item.validation.evidenceId) {
      context.addIssue({ code: "custom", path: ["validation"], message: "验数结果必须可追溯到时间和证据" });
    }
  } else if (item.validation.validatedAt || item.validation.evidenceId) {
    context.addIssue({ code: "custom", path: ["validation"], message: "尚无结果的验数不得携带历史证据" });
  }
});

export type MetricDefinitionItem = z.infer<typeof metricDefinitionItemSchema>;

export const metricDefinitionCategorySchema = z.object({
  name: boundedText(128),
  order: nonNegativeSafeIntegerSchema,
  children: z.array(z.object({
    name: boundedText(128),
    order: nonNegativeSafeIntegerSchema
  }).strict()).max(256)
}).strict();

export const metricDefinitionsSnapshotMetadataSchema = z.object({
  schemaVersion: z.literal("metric-catalog/v1"),
  authorityDocument: z.literal("全站指标体系.md"),
  authorityVersion: boundedText(64),
  mappingRegistryVersion: boundedText(64),
  authorityStatus: boundedText(1_000),
  sourceUpdatedOn: z.iso.date(),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  counts: z.object({
    standard: nonNegativeSafeIntegerSchema,
    periodDerived: nonNegativeSafeIntegerSchema,
    total: nonNegativeSafeIntegerSchema
  }).strict()
}).strict();

export const v2MetricDefinitionsDataSchema = z.object({
  snapshot: metricDefinitionsSnapshotMetadataSchema,
  categories: z.array(metricDefinitionCategorySchema).max(256),
  items: z.array(metricDefinitionItemSchema).max(2_000)
}).strict().superRefine((data, context) => {
  const standardItems = data.items.filter((item) => item.kind === "standard");
  const derivedItems = data.items.filter((item) => item.kind === "period_derived");
  const actualCounts = {
    standard: standardItems.length,
    periodDerived: derivedItems.length,
    total: data.items.length
  };
  for (const key of ["standard", "periodDerived", "total"] as const) {
    if (data.snapshot.counts[key] !== actualCounts[key]) {
      context.addIssue({ code: "custom", path: ["snapshot", "counts", key], message: "指标数量与目录不一致" });
    }
  }

  const categoryKeys = new Set<string>();
  const primaryOrders = new Set<number>();
  data.categories.forEach((category, primaryIndex) => {
    if (category.order !== primaryIndex || primaryOrders.has(category.order)) {
      context.addIssue({ code: "custom", path: ["categories", primaryIndex, "order"], message: "一级分类顺序必须稳定且连续" });
    }
    primaryOrders.add(category.order);
    const secondaryOrders = new Set<number>();
    category.children.forEach((secondary, secondaryIndex) => {
      const categoryKey = `${category.name}\u0000${secondary.name}`;
      if (categoryKeys.has(categoryKey)) {
        context.addIssue({ code: "custom", path: ["categories", primaryIndex, "children", secondaryIndex], message: "二级分类不得重复" });
      }
      categoryKeys.add(categoryKey);
      if (secondary.order !== secondaryIndex || secondaryOrders.has(secondary.order)) {
        context.addIssue({ code: "custom", path: ["categories", primaryIndex, "children", secondaryIndex, "order"], message: "二级分类顺序必须稳定且连续" });
      }
      secondaryOrders.add(secondary.order);
    });
  });

  const ids = new Set<string>();
  const codes = new Set<string>();
  const standardIds = new Set(standardItems.map((item) => item.id));
  data.items.forEach((item, itemIndex) => {
    if (item.order !== itemIndex) {
      context.addIssue({ code: "custom", path: ["items", itemIndex, "order"], message: "指标顺序必须稳定且连续" });
    }
    if (ids.has(item.id)) context.addIssue({ code: "custom", path: ["items", itemIndex, "id"], message: "指标 ID 不得重复" });
    if (codes.has(item.code)) context.addIssue({ code: "custom", path: ["items", itemIndex, "code"], message: "指标英文名不得重复" });
    ids.add(item.id);
    codes.add(item.code);
    if (item.authority.version !== data.snapshot.authorityVersion) {
      context.addIssue({ code: "custom", path: ["items", itemIndex, "authority", "version"], message: "指标权威版本与快照不一致" });
    }
    if (item.classification) {
      const categoryKey = `${item.classification.primary}\u0000${item.classification.secondary}`;
      if (!categoryKeys.has(categoryKey)) {
        context.addIssue({ code: "custom", path: ["items", itemIndex, "classification"], message: "指标引用了不存在的分类" });
      }
    }
    item.authority.baseMetricIds.forEach((baseMetricId, baseIndex) => {
      if (!standardIds.has(baseMetricId)) {
        context.addIssue({ code: "custom", path: ["items", itemIndex, "authority", "baseMetricIds", baseIndex], message: "派生指标引用了不存在的基础指标" });
      }
    });
  });
});

export type V2MetricDefinitionsData = z.infer<typeof v2MetricDefinitionsDataSchema>;

export const v2MetricDefinitionsSuccessSchema = z.object({
  success: z.literal(true),
  data: v2MetricDefinitionsDataSchema
}).strict();

export type V2MetricDefinitionsSuccess = z.infer<typeof v2MetricDefinitionsSuccessSchema>;

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

export const v2MetricWatermarkSchema = z.object({
  type: z.literal("complete_through_business_date"),
  completeThrough: z.iso.date(),
  timeZone: z.literal("Asia/Shanghai"),
  pid: boundedText(32),
  sourceApiId: z.string().trim().min(1).max(128).startsWith("/api/"),
  sourceKind: z.enum(["upstream_explicit", "upstream_completion_api"]),
  observedAt: z.iso.datetime({ offset: true })
}).strict().superRefine((watermark, context) => {
  const firstInstantAfterBusinessDate = Date.parse(`${watermark.completeThrough}T16:00:00Z`);
  if (Date.parse(watermark.observedAt) < firstInstantAfterBusinessDate) {
    context.addIssue({
      code: "custom",
      path: ["observedAt"],
      message: "数据水位的取证时间不能早于完整业务日结束"
    });
  }
});

export type V2MetricWatermark = z.infer<typeof v2MetricWatermarkSchema>;

export const v2MetricQueryMetaSchema = z.object({
  queryId: boundedText(128),
  sourceApiIds: z.array(boundedText(128)).max(64),
  fetchedAt: z.iso.datetime({ offset: true }),
  mappingVersion: boundedText(128),
  validationStatus: z.enum(["pending_validation", "passed"]),
  watermark: v2MetricWatermarkSchema.nullable(),
  warnings: z.array(boundedText(1_000)).max(100)
}).strict();

export type V2MetricQueryMeta = z.infer<typeof v2MetricQueryMetaSchema>;

export const v2MetricQuerySuccessSchema = z.object({
  success: z.literal(true),
  data: v2MetricQueryDataSchema,
  meta: v2MetricQueryMetaSchema
}).strict().superRefine((response, context) => {
  const { data, meta } = response;
  if (data.metric.authority.validationStatus !== meta.validationStatus) {
    context.addIssue({
      code: "custom",
      path: ["meta", "validationStatus"],
      message: "查询元数据与指标目录的验数状态必须一致"
    });
  }
  const expectedStatusLabel = meta.validationStatus === "passed"
    ? "真实验数已通过"
    : "技术称已实现（待验数）";
  if (data.metric.authority.statusLabel !== expectedStatusLabel) {
    context.addIssue({
      code: "custom",
      path: ["data", "metric", "authority", "statusLabel"],
      message: "指标验数状态文案与机器状态不一致"
    });
  }
  if (meta.validationStatus === "passed" && meta.watermark === null) {
    context.addIssue({
      code: "custom",
      path: ["meta", "watermark"],
      message: "已验数的正式查询结果必须携带可信数据水位"
    });
    return;
  }
  if (!meta.watermark) return;
  if (meta.watermark.pid !== data.scope.pid) {
    context.addIssue({
      code: "custom",
      path: ["meta", "watermark", "pid"],
      message: "数据水位 PID 必须与查询范围一致"
    });
  }
  if (!meta.sourceApiIds.includes(meta.watermark.sourceApiId)) {
    context.addIssue({
      code: "custom",
      path: ["meta", "watermark", "sourceApiId"],
      message: "数据水位来源必须包含在本次查询来源接口中"
    });
  }
  if (data.dateRange[1] > meta.watermark.completeThrough) {
    context.addIssue({
      code: "custom",
      path: ["data", "dateRange", 1],
      message: "查询结束日不得晚于可信数据水位"
    });
  }
  if (Date.parse(meta.watermark.observedAt) > Date.parse(meta.fetchedAt) + 300_000) {
    context.addIssue({
      code: "custom",
      path: ["meta", "watermark", "observedAt"],
      message: "数据水位取证时间不能明显晚于本次查询完成时间"
    });
  }
});

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
  "INVALID_DAILY_READING_QUERY",
  "DAILY_READING_DISABLED",
  "DAILY_BOARD_NOT_READY",
  "DAILY_SOURCE_CONFLICT",
  "INVALID_V2_METRIC_QUERY",
  "INVALID_CORE_OVERVIEW_QUERY",
  "V2_REQUEST_TOO_LARGE",
  "V2_UNSUPPORTED_MEDIA_TYPE",
  "V2_REQUEST_REJECTED",
  "HTTPS_REQUIRED",
  "AUTH_PROXY_MISCONFIGURED",
  "METRIC_NOT_READY",
  "CORE_OVERVIEW_QUERY_DISABLED",
  "CORE_OVERVIEW_QUERY_UNAVAILABLE",
  "CORE_OVERVIEW_SOURCE_CONFLICT",
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
