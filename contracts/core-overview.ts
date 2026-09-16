import { CARTESIAN_DEFAULTS } from "./chart-presentation.ts";
import { z } from "zod";

export const CORE_OVERVIEW_DASHBOARD_ID = "core-overview" as const;
export const CORE_OVERVIEW_CONTRACT_VERSION = "core-overview/v1" as const;
export const CORE_OVERVIEW_TIME_ZONE = "Asia/Shanghai" as const;
export const MAX_CORE_OVERVIEW_QUERY_DAYS = 366;
export const MAX_CORE_OVERVIEW_QUERY_PIDS = 256;

export const CORE_OVERVIEW_METRIC_IDS = [
  "M016",
  "M008",
  "M026",
  "M102",
  "M059",
  "M058",
  "M081",
  "M036",
  "M020"
] as const;

export type CoreOverviewMetricId = (typeof CORE_OVERVIEW_METRIC_IDS)[number];

export const CORE_OVERVIEW_CARD_SPECS = [
  { metricId: "M016", section: "primary", order: 0, aggregation: "mature_day_average", trendKind: CARTESIAN_DEFAULTS.time_trend, valueKind: "count" },
  { metricId: "M008", section: "primary", order: 1, aggregation: "period_sum", trendKind: CARTESIAN_DEFAULTS.time_trend, valueKind: "count" },
  { metricId: "M026", section: "primary", order: 2, aggregation: "mature_day_average", trendKind: CARTESIAN_DEFAULTS.time_trend, valueKind: "count" },
  { metricId: "M102", section: "primary", order: 3, aggregation: "period_sum", trendKind: CARTESIAN_DEFAULTS.time_trend, valueKind: "duration_hours" },
  { metricId: "M059", section: "primary", order: 4, aggregation: "period_distinct", trendKind: CARTESIAN_DEFAULTS.time_trend, valueKind: "count" },
  { metricId: "M058", section: "primary", order: 5, aggregation: "period_sum", trendKind: CARTESIAN_DEFAULTS.time_trend, valueKind: "currency" },
  { metricId: "M081", section: "efficiency_retention", order: 6, aggregation: "authoritative_period_result", trendKind: CARTESIAN_DEFAULTS.time_trend, valueKind: "ratio" },
  { metricId: "M036", section: "efficiency_retention", order: 7, aggregation: "authoritative_period_result", trendKind: CARTESIAN_DEFAULTS.time_trend, valueKind: "ratio" },
  { metricId: "M020", section: "efficiency_retention", order: 8, aggregation: "mature_cohort_result", trendKind: CARTESIAN_DEFAULTS.time_trend, valueKind: "ratio" }
] as const;

const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const finiteNumberSchema = z.number().refine(Number.isFinite, "必须是有限数值");
const nonNegativeFiniteNumberSchema = finiteNumberSchema.refine((value) => value >= 0, "业务值不能为负数");
const nonNegativeSafeIntegerSchema = z.number().refine(
  (value) => Number.isSafeInteger(value) && value >= 0,
  "必须是非负安全整数"
);
const dateRangeSchema = z.tuple([z.iso.date(), z.iso.date()]);

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

function shiftBusinessDate(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function validateDateRange(
  dateRange: readonly [string, string],
  context: z.RefinementCtx,
  path: PropertyKey[]
) {
  if (dateRange[0] > dateRange[1]) {
    context.addIssue({ code: "custom", path, message: "开始日期不能晚于结束日期" });
    return;
  }
  if (enumerateBusinessDates(dateRange).length > MAX_CORE_OVERVIEW_QUERY_DAYS) {
    context.addIssue({
      code: "custom",
      path,
      message: `单个周期最多查询 ${MAX_CORE_OVERVIEW_QUERY_DAYS} 个业务日`
    });
  }
}

export const coreOverviewMetricIdSchema = z.enum(CORE_OVERVIEW_METRIC_IDS);

export const coreOverviewRequestedScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("official_overall") }).strict(),
  z.object({
    kind: z.literal("pids"),
    pids: z.array(boundedText(32)).min(1).max(MAX_CORE_OVERVIEW_QUERY_PIDS)
  }).strict()
]).superRefine((scope, context) => {
  if (scope.kind !== "pids") return;
  const seen = new Set<string>();
  scope.pids.forEach((pid, index) => {
    if (seen.has(pid)) {
      context.addIssue({ code: "custom", path: ["pids", index], message: "PID 不得重复" });
    }
    seen.add(pid);
  });
});

export const coreOverviewScopeMemberSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("official_overall") }).strict(),
  z.object({ kind: z.literal("pid"), pid: boundedText(32) }).strict()
]);

const latestCompletePeriodSchema = z.object({
  mode: z.literal("latest_complete"),
  days: z.number().int().min(1).max(MAX_CORE_OVERVIEW_QUERY_DAYS).default(7),
  comparison: z.enum(["previous_equal", "none"]).default("previous_equal")
}).strict();

const explicitPeriodSchema = z.object({
  mode: z.literal("explicit"),
  currentRange: dateRangeSchema,
  comparisonRange: dateRangeSchema.nullable().default(null)
}).strict().superRefine((period, context) => {
  validateDateRange(period.currentRange, context, ["currentRange"]);
  if (period.comparisonRange) validateDateRange(period.comparisonRange, context, ["comparisonRange"]);
});

export const coreOverviewQuerySchema = z.object({
  scope: coreOverviewRequestedScopeSchema,
  period: z.discriminatedUnion("mode", [latestCompletePeriodSchema, explicitPeriodSchema]).default({
    mode: "latest_complete",
    days: 7,
    comparison: "previous_equal"
  }),
  metricIds: z.array(coreOverviewMetricIdSchema).min(1).max(CORE_OVERVIEW_METRIC_IDS.length).optional()
}).strict().superRefine((query, context) => {
  if (!query.metricIds) return;
  const seen = new Set<CoreOverviewMetricId>();
  query.metricIds.forEach((metricId, index) => {
    if (seen.has(metricId)) {
      context.addIssue({ code: "custom", path: ["metricIds", index], message: "指标 ID 不得重复" });
    }
    seen.add(metricId);
  });
}).transform((query) => {
  const requestedMetricIds = new Set(query.metricIds ?? CORE_OVERVIEW_METRIC_IDS);
  return {
    ...query,
    metricIds: CORE_OVERVIEW_METRIC_IDS.filter((metricId) => requestedMetricIds.has(metricId))
  };
});

export type CoreOverviewQueryInput = z.input<typeof coreOverviewQuerySchema>;
export type CoreOverviewQuery = z.output<typeof coreOverviewQuerySchema>;

export const coreOverviewResolvedPeriodSchema = z.object({
  mode: z.enum(["latest_complete", "explicit"]),
  grain: z.literal("day"),
  timeZone: z.literal(CORE_OVERVIEW_TIME_ZONE),
  currentRange: dateRangeSchema,
  comparisonRange: dateRangeSchema.nullable(),
  commonCompleteThrough: z.iso.date()
}).strict().superRefine((period, context) => {
  validateDateRange(period.currentRange, context, ["currentRange"]);
  if (period.comparisonRange) validateDateRange(period.comparisonRange, context, ["comparisonRange"]);
  if (period.currentRange[1] > period.commonCompleteThrough) {
    context.addIssue({ code: "custom", path: ["currentRange", 1], message: "当前周期不能晚于共同可信水位" });
  }
  if (period.comparisonRange?.[1] && period.comparisonRange[1] > period.commonCompleteThrough) {
    context.addIssue({ code: "custom", path: ["comparisonRange", 1], message: "对比周期不能晚于共同可信水位" });
  }
});

const coreOverviewValueSchema = z.object({
  raw: nonNegativeFiniteNumberSchema,
  unit: boundedText(32),
  currencyCode: z.string().trim().regex(/^[A-Z]{3}$/).nullable()
}).strict();

const includedBusinessDatesSchema = z.array(z.iso.date()).min(1).max(MAX_CORE_OVERVIEW_QUERY_DAYS)
  .superRefine((dates, context) => {
    const seen = new Set<string>();
    dates.forEach((date, index) => {
      if (seen.has(date)) context.addIssue({ code: "custom", path: [index], message: "业务日期不得重复" });
      if (index > 0 && dates[index - 1] >= date) {
        context.addIssue({ code: "custom", path: [index], message: "业务日期必须严格递增" });
      }
      seen.add(date);
    });
  });

const coreOverviewPeriodValueSchema = z.object({
  actualRange: dateRangeSchema,
  includedBusinessDates: includedBusinessDatesSchema,
  value: coreOverviewValueSchema
}).strict().superRefine((result, context) => {
  validateDateRange(result.actualRange, context, ["actualRange"]);
  if (
    result.actualRange[0] !== result.includedBusinessDates[0]
    || result.actualRange[1] !== result.includedBusinessDates.at(-1)
  ) {
    context.addIssue({
      code: "custom",
      path: ["actualRange"],
      message: "实际统计范围必须与纳入计算的首末业务日一致"
    });
  }
  result.includedBusinessDates.forEach((date, index) => {
    if (date < result.actualRange[0] || date > result.actualRange[1]) {
      context.addIssue({ code: "custom", path: ["includedBusinessDates", index], message: "业务日期超出实际统计范围" });
    }
  });
});

const coreOverviewComparisonSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("available"),
    kind: z.enum(["relative_change", "percentage_point"]),
    actualRange: dateRangeSchema,
    includedBusinessDates: includedBusinessDatesSchema,
    baselineValue: coreOverviewValueSchema,
    absoluteDifference: finiteNumberSchema,
    changeValue: finiteNumberSchema.nullable(),
    direction: z.enum(["up", "down", "flat"])
  }).strict(),
  z.object({
    status: z.literal("unavailable"),
    reason: z.enum(["no_records", "no_values", "not_produced", "immature", "not_applicable"]),
    message: boundedText(500)
  }).strict()
]);

const coreOverviewTrendPointSchema = z.discriminatedUnion("state", [
  z.object({
    offset: nonNegativeSafeIntegerSchema.refine((value) => value < MAX_CORE_OVERVIEW_QUERY_DAYS),
    state: z.literal("available"),
    businessDate: z.iso.date(),
    value: nonNegativeFiniteNumberSchema
  }).strict(),
  z.object({
    offset: nonNegativeSafeIntegerSchema.refine((value) => value < MAX_CORE_OVERVIEW_QUERY_DAYS),
    state: z.literal("no_record"),
    businessDate: z.iso.date()
  }).strict(),
  z.object({
    offset: nonNegativeSafeIntegerSchema.refine((value) => value < MAX_CORE_OVERVIEW_QUERY_DAYS),
    state: z.literal("no_value"),
    businessDate: z.iso.date()
  }).strict(),
  z.object({
    offset: nonNegativeSafeIntegerSchema.refine((value) => value < MAX_CORE_OVERVIEW_QUERY_DAYS),
    state: z.literal("not_produced"),
    businessDate: z.iso.date()
  }).strict(),
  z.object({
    offset: nonNegativeSafeIntegerSchema.refine((value) => value < MAX_CORE_OVERVIEW_QUERY_DAYS),
    state: z.literal("immature"),
    businessDate: z.iso.date()
  }).strict()
]);

const coreOverviewTrendSeriesSchema = z.array(coreOverviewTrendPointSchema)
  .min(1)
  .max(MAX_CORE_OVERVIEW_QUERY_DAYS)
  .superRefine((points, context) => {
    points.forEach((point, index) => {
      if (point.offset !== index) {
        context.addIssue({ code: "custom", path: [index, "offset"], message: "趋势点偏移必须从 0 连续递增" });
      }
      if (index > 0 && points[index - 1].businessDate >= point.businessDate) {
        context.addIssue({ code: "custom", path: [index, "businessDate"], message: "趋势日期必须严格递增" });
      }
    });
  });

const sourceIdSchema = z.string().trim().min(1).max(256).refine(
  (value) => value.startsWith("/api/") || value.startsWith("service:"),
  "来源必须是已登记 API 或服务端加工服务"
);

export const coreOverviewWatermarkSchema = z.object({
  type: z.literal("complete_through_business_date"),
  completeThrough: z.iso.date(),
  timeZone: z.literal(CORE_OVERVIEW_TIME_ZONE),
  scope: coreOverviewScopeMemberSchema,
  evidence: z.array(z.object({
    sourceId: sourceIdSchema,
    sourceKind: z.enum(["upstream_explicit", "upstream_completion_api"]),
    observedAt: z.iso.datetime({ offset: true })
  }).strict()).min(1).max(512)
}).strict().superRefine((watermark, context) => {
  const earliestValidObservation = Date.parse(`${watermark.completeThrough}T16:00:00Z`);
  const seen = new Set<string>();
  watermark.evidence.forEach((evidence, index) => {
    const key = `${evidence.sourceId}\u0000${evidence.sourceKind}`;
    if (seen.has(key)) {
      context.addIssue({ code: "custom", path: ["evidence", index], message: "水位证据不得重复" });
    }
    if (Date.parse(evidence.observedAt) < earliestValidObservation) {
      context.addIssue({ code: "custom", path: ["evidence", index, "observedAt"], message: "水位取证不能早于完整业务日结束" });
    }
    seen.add(key);
  });
});

const coreOverviewProvenanceSchema = z.object({
  authorityVersion: boundedText(64),
  mappingVersion: boundedText(128),
  validationStatus: z.literal("passed"),
  sourceIds: z.array(sourceIdSchema).min(1).max(512),
  fetchedAt: z.iso.datetime({ offset: true }),
  watermark: coreOverviewWatermarkSchema
}).strict().superRefine((provenance, context) => {
  const sourceIds = new Set(provenance.sourceIds);
  if (sourceIds.size !== provenance.sourceIds.length) {
    context.addIssue({ code: "custom", path: ["sourceIds"], message: "来源 ID 不得重复" });
  }
  provenance.watermark.evidence.forEach((evidence, index) => {
    if (!sourceIds.has(evidence.sourceId)) {
      context.addIssue({ code: "custom", path: ["watermark", "evidence", index, "sourceId"], message: "水位证据必须属于当前查询来源" });
    }
    if (Date.parse(evidence.observedAt) > Date.parse(provenance.fetchedAt) + 300_000) {
      context.addIssue({ code: "custom", path: ["watermark", "evidence", index, "observedAt"], message: "水位取证时间不能明显晚于查询完成时间" });
    }
  });
});

const coreOverviewAvailableResultSchema = z.object({
  status: z.literal("available"),
  completeness: z.enum(["complete", "partial"]),
  current: coreOverviewPeriodValueSchema,
  comparison: coreOverviewComparisonSchema.nullable(),
  trend: z.object({
    current: coreOverviewTrendSeriesSchema,
    comparison: coreOverviewTrendSeriesSchema.nullable()
  }).strict(),
  provenance: coreOverviewProvenanceSchema
}).strict();

const coreOverviewDataUnavailableResultSchema = z.object({
  status: z.enum(["no_records", "no_values", "not_produced", "immature"]),
  message: boundedText(500),
  retryable: z.boolean(),
  provenance: coreOverviewProvenanceSchema
}).strict();

const coreOverviewAdmissionUnavailableResultSchema = z.object({
  status: z.enum(["not_ready", "unsupported"]),
  reasonCode: boundedText(128),
  message: boundedText(500),
  retryable: z.boolean()
}).strict();

const coreOverviewFailedResultSchema = z.object({
  status: z.literal("failed"),
  errorCode: boundedText(128),
  message: boundedText(500),
  retryable: z.boolean()
}).strict();

export const coreOverviewCardSchema = z.object({
  metricId: coreOverviewMetricIdSchema,
  section: z.enum(["primary", "efficiency_retention"]),
  order: nonNegativeSafeIntegerSchema,
  aggregation: z.enum([
    "mature_day_average",
    "period_sum",
    "period_distinct",
    "authoritative_period_result",
    "mature_cohort_result"
  ]),
  trendKind: z.enum(["line", "bar"]),
  valueKind: z.enum(["count", "duration_hours", "currency", "ratio"]),
  result: z.union([
    coreOverviewAvailableResultSchema,
    coreOverviewDataUnavailableResultSchema,
    coreOverviewAdmissionUnavailableResultSchema,
    coreOverviewFailedResultSchema
  ])
}).strict().superRefine((card, context) => {
  const spec = CORE_OVERVIEW_CARD_SPECS.find((candidate) => candidate.metricId === card.metricId);
  if (!spec) return;
  for (const key of ["section", "order", "aggregation", "trendKind", "valueKind"] as const) {
    if (card[key] !== spec[key]) {
      context.addIssue({ code: "custom", path: [key], message: `${card.metricId} 的展示与聚合规则不匹配` });
    }
  }
  if (card.result.status !== "available") return;

  const values = [card.result.current.value];
  if (card.result.comparison?.status === "available") values.push(card.result.comparison.baselineValue);
  values.forEach((value, index) => {
    if (card.valueKind === "ratio" && value.raw > 1) {
      context.addIssue({ code: "custom", path: ["result", index === 0 ? "current" : "comparison"], message: "比例指标原始值必须使用 0～1 标准比例" });
    }
    if ((card.valueKind === "currency") !== (value.currencyCode !== null)) {
      context.addIssue({ code: "custom", path: ["result", index === 0 ? "current" : "comparison"], message: "只有金额指标必须携带币种" });
    }
  });

  const comparison = card.result.comparison;
  if (comparison?.status === "available") {
    validateDateRange(comparison.actualRange, context, ["result", "comparison", "actualRange"]);
    comparison.includedBusinessDates.forEach((date, index) => {
      if (date < comparison.actualRange[0] || date > comparison.actualRange[1]) {
        context.addIssue({
          code: "custom",
          path: ["result", "comparison", "includedBusinessDates", index],
          message: "对比业务日期超出实际统计范围"
        });
      }
    });
    if (
      comparison.baselineValue.unit !== card.result.current.value.unit
      || comparison.baselineValue.currencyCode !== card.result.current.value.currencyCode
    ) {
      context.addIssue({ code: "custom", path: ["result", "comparison", "baselineValue"], message: "当前值与对比值的单位或币种不一致" });
    }
    const expectedKind = card.valueKind === "ratio" ? "percentage_point" : "relative_change";
    if (comparison.kind !== expectedKind) {
      context.addIssue({ code: "custom", path: ["result", "comparison", "kind"], message: "对比算法与指标值类型不匹配" });
    }
    const difference = card.result.current.value.raw - comparison.baselineValue.raw;
    const tolerance = Math.max(1, Math.abs(difference)) * 1e-9;
    if (Math.abs(comparison.absoluteDifference - difference) > tolerance) {
      context.addIssue({ code: "custom", path: ["result", "comparison", "absoluteDifference"], message: "绝对差值与当前值、基准值不一致" });
    }
    const expectedDirection = difference > tolerance ? "up" : difference < -tolerance ? "down" : "flat";
    if (comparison.direction !== expectedDirection) {
      context.addIssue({ code: "custom", path: ["result", "comparison", "direction"], message: "变化方向与数值不一致" });
    }
    if (comparison.kind === "relative_change") {
      const expectedChange = comparison.baselineValue.raw === 0 ? null : difference / comparison.baselineValue.raw;
      if (
        (expectedChange === null) !== (comparison.changeValue === null)
        || (expectedChange !== null && comparison.changeValue !== null && Math.abs(expectedChange - comparison.changeValue) > 1e-9)
      ) {
        context.addIssue({ code: "custom", path: ["result", "comparison", "changeValue"], message: "相对变化与当前值、基准值不一致" });
      }
    } else if (comparison.changeValue === null || Math.abs(comparison.changeValue - difference * 100) > 1e-9) {
      context.addIssue({ code: "custom", path: ["result", "comparison", "changeValue"], message: "百分点变化与当前值、基准值不一致" });
    }
  }

});

export type CoreOverviewCard = z.infer<typeof coreOverviewCardSchema>;

export const coreOverviewScopeResultSchema = z.object({
  scope: coreOverviewScopeMemberSchema,
  cards: z.array(coreOverviewCardSchema).min(1).max(CORE_OVERVIEW_METRIC_IDS.length)
}).strict();

export const coreOverviewQuerySuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    dashboard: z.object({
      id: z.literal(CORE_OVERVIEW_DASHBOARD_ID),
      contractVersion: z.literal(CORE_OVERVIEW_CONTRACT_VERSION)
    }).strict(),
    requestedScope: coreOverviewRequestedScopeSchema,
    requestedMetricIds: z.array(coreOverviewMetricIdSchema).min(1).max(CORE_OVERVIEW_METRIC_IDS.length),
    period: coreOverviewResolvedPeriodSchema,
    scopeResults: z.array(coreOverviewScopeResultSchema).min(1).max(MAX_CORE_OVERVIEW_QUERY_PIDS)
  }).strict(),
  meta: z.object({
    queryId: boundedText(128),
    fetchedAt: z.iso.datetime({ offset: true }),
    partial: z.boolean(),
    warnings: z.array(boundedText(1_000)).max(500)
  }).strict()
}).strict().superRefine((response, context) => {
  const requestedMetricIds = response.data.requestedMetricIds;
  const canonicalIds = CORE_OVERVIEW_METRIC_IDS.filter((metricId) => requestedMetricIds.includes(metricId));
  if (
    canonicalIds.length !== requestedMetricIds.length
    || canonicalIds.some((metricId, index) => metricId !== requestedMetricIds[index])
  ) {
    context.addIssue({ code: "custom", path: ["data", "requestedMetricIds"], message: "指标必须按核心经营总览固定顺序返回且不得重复" });
  }

  const expectedScopes = response.data.requestedScope.kind === "official_overall"
    ? [{ kind: "official_overall" as const }]
    : response.data.requestedScope.pids.map((pid) => ({ kind: "pid" as const, pid }));
  if (expectedScopes.length !== response.data.scopeResults.length) {
    context.addIssue({ code: "custom", path: ["data", "scopeResults"], message: "范围结果数量与请求不一致" });
  }

  const expectedCurrentDates = enumerateBusinessDates(response.data.period.currentRange);
  const expectedComparisonDates = response.data.period.comparisonRange
    ? enumerateBusinessDates(response.data.period.comparisonRange)
    : null;
  let hasPartialResult = false;
  const watermarkDates: string[] = [];
  response.data.scopeResults.forEach((scopeResult, scopeIndex) => {
    const expectedScope = expectedScopes[scopeIndex];
    if (!expectedScope || JSON.stringify(scopeResult.scope) !== JSON.stringify(expectedScope)) {
      context.addIssue({ code: "custom", path: ["data", "scopeResults", scopeIndex, "scope"], message: "范围结果与请求不一致" });
    }
    if (scopeResult.cards.length !== requestedMetricIds.length) {
      context.addIssue({ code: "custom", path: ["data", "scopeResults", scopeIndex, "cards"], message: "每个范围必须返回全部请求指标状态" });
    }
    scopeResult.cards.forEach((card, cardIndex) => {
      if (card.metricId !== requestedMetricIds[cardIndex]) {
        context.addIssue({ code: "custom", path: ["data", "scopeResults", scopeIndex, "cards", cardIndex, "metricId"], message: "卡片指标或顺序与请求不一致" });
      }
      if (card.result.status !== "available") hasPartialResult = true;
      const comparisonWasRequested = expectedComparisonDates !== null;
      if (card.result.status === "available") {
        const resultPath = ["data", "scopeResults", scopeIndex, "cards", cardIndex, "result"];
        const currentDates = new Set(expectedCurrentDates);
        const currentIncludedDatesAreInRange = card.result.current.includedBusinessDates.every((date) => currentDates.has(date));
        if (!currentIncludedDatesAreInRange) {
          context.addIssue({ code: "custom", path: [...resultPath, "current", "includedBusinessDates"], message: "当前结果包含请求周期外的业务日" });
        }
        if (card.result.trend.current.length !== expectedCurrentDates.length) {
          context.addIssue({ code: "custom", path: [...resultPath, "trend", "current"], message: "当前趋势必须逐日回显请求周期" });
        }
        card.result.trend.current.forEach((point, pointIndex) => {
          if (point.businessDate !== expectedCurrentDates[pointIndex]) {
            context.addIssue({ code: "custom", path: [...resultPath, "trend", "current", pointIndex, "businessDate"], message: "当前趋势日期与请求周期不一致" });
          }
        });

        if (!comparisonWasRequested && (card.result.comparison !== null || card.result.trend.comparison !== null)) {
          context.addIssue({ code: "custom", path: ["data", "scopeResults", scopeIndex, "cards", cardIndex, "result", "comparison"], message: "未请求对比周期时不得返回对比结果" });
        }
        if (comparisonWasRequested && card.result.comparison === null) {
          context.addIssue({ code: "custom", path: ["data", "scopeResults", scopeIndex, "cards", cardIndex, "result", "comparison"], message: "已请求对比周期时必须返回结果或明确不可用状态" });
        }
        if (card.result.comparison?.status === "available") {
          if (!expectedComparisonDates || !card.result.trend.comparison) {
            context.addIssue({ code: "custom", path: [...resultPath, "trend", "comparison"], message: "可用对比结果必须返回完整的独立对比趋势序列" });
          } else {
            const comparisonDates = new Set(expectedComparisonDates);
            if (!card.result.comparison.includedBusinessDates.every((date) => comparisonDates.has(date))) {
              context.addIssue({ code: "custom", path: [...resultPath, "comparison", "includedBusinessDates"], message: "对比结果包含请求对比周期外的业务日" });
            }
            if (card.result.trend.comparison.length !== expectedComparisonDates.length) {
              context.addIssue({ code: "custom", path: [...resultPath, "trend", "comparison"], message: "对比趋势必须逐日回显请求周期" });
            }
            card.result.trend.comparison.forEach((point, pointIndex) => {
              if (point.businessDate !== expectedComparisonDates[pointIndex]) {
                context.addIssue({ code: "custom", path: [...resultPath, "trend", "comparison", pointIndex, "businessDate"], message: "对比趋势日期与请求周期不一致" });
              }
            });
          }
        } else if (card.result.comparison?.status === "unavailable" && card.result.trend.comparison !== null) {
          context.addIssue({ code: "custom", path: [...resultPath, "trend", "comparison"], message: "对比结果不可用时不得返回伪对比趋势" });
        }

        const currentTrendIsComplete = card.result.trend.current.length === expectedCurrentDates.length
          && card.result.trend.current.every((point) => point.state === "available")
          && card.result.current.includedBusinessDates.length === expectedCurrentDates.length;
        const comparisonIsComplete = !comparisonWasRequested || (
          card.result.comparison?.status === "available"
          && card.result.trend.comparison !== null
          && card.result.trend.comparison.length === expectedComparisonDates.length
          && card.result.trend.comparison.every((point) => point.state === "available")
          && card.result.comparison.includedBusinessDates.length === expectedComparisonDates.length
        );
        const cardIsPartial = !currentTrendIsComplete || !comparisonIsComplete;
        if (card.result.completeness === "partial" || cardIsPartial) hasPartialResult = true;
        if (card.result.completeness === "complete" && cardIsPartial) {
          context.addIssue({ code: "custom", path: [...resultPath, "completeness"], message: "存在缺失日期、缺失趋势点或不可用对比时不能声明完整" });
        }
        if (card.result.completeness === "partial" && !cardIsPartial) {
          context.addIssue({ code: "custom", path: [...resultPath, "completeness"], message: "当前与对比结果均完整时不得声明部分数据" });
        }
      }
      if (!("provenance" in card.result)) return;
      const provenance = card.result.provenance;
      if (JSON.stringify(provenance.watermark.scope) !== JSON.stringify(scopeResult.scope)) {
        context.addIssue({ code: "custom", path: ["data", "scopeResults", scopeIndex, "cards", cardIndex, "result", "provenance", "watermark", "scope"], message: "卡片水位范围与卡片结果范围不一致" });
      }
      if (provenance.watermark.completeThrough < response.data.period.commonCompleteThrough) {
        context.addIssue({ code: "custom", path: ["data", "scopeResults", scopeIndex, "cards", cardIndex, "result", "provenance", "watermark", "completeThrough"], message: "卡片可信水位不得早于共同可信水位" });
      }
      if (Date.parse(provenance.fetchedAt) > Date.parse(response.meta.fetchedAt) + 300_000) {
        context.addIssue({ code: "custom", path: ["data", "scopeResults", scopeIndex, "cards", cardIndex, "result", "provenance", "fetchedAt"], message: "卡片完成时间不能明显晚于批量查询完成时间" });
      }
      watermarkDates.push(provenance.watermark.completeThrough);
    });
  });

  if (watermarkDates.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["data", "scopeResults"],
      message: "成功响应必须至少包含一张具有可信水位的卡片"
    });
  } else {
    const earliestWatermarkDate = watermarkDates.reduce(
      (earliest, date) => date < earliest ? date : earliest,
      watermarkDates[0]
    );
    if (response.data.period.commonCompleteThrough !== earliestWatermarkDate) {
      context.addIssue({
        code: "custom",
        path: ["data", "period", "commonCompleteThrough"],
        message: "共同可信水位必须等于全部卡片可信水位的最小值"
      });
    }
  }
  if (response.meta.partial !== hasPartialResult) {
    context.addIssue({ code: "custom", path: ["meta", "partial"], message: "partial 与逐范围、逐卡状态不一致" });
  }
});

export type CoreOverviewQuerySuccess = z.infer<typeof coreOverviewQuerySuccessSchema>;

export function coreOverviewResponseMatchesQuery(
  response: CoreOverviewQuerySuccess,
  query: CoreOverviewQuery
) {
  if (response.data.requestedScope.kind !== query.scope.kind) return false;
  if (response.data.requestedScope.kind === "pids" && query.scope.kind === "pids") {
    const responsePids = new Set(response.data.requestedScope.pids);
    if (responsePids.size !== query.scope.pids.length || query.scope.pids.some((pid) => !responsePids.has(pid))) return false;
  }
  if (
    response.data.requestedMetricIds.length !== query.metricIds.length
    || response.data.requestedMetricIds.some((metricId, index) => metricId !== query.metricIds[index])
  ) return false;
  if (response.data.period.mode !== query.period.mode) return false;

  if (query.period.mode === "explicit") {
    return response.data.period.currentRange[0] === query.period.currentRange[0]
      && response.data.period.currentRange[1] === query.period.currentRange[1]
      && JSON.stringify(response.data.period.comparisonRange) === JSON.stringify(query.period.comparisonRange);
  }

  const currentRange = response.data.period.currentRange;
  if (
    enumerateBusinessDates(currentRange).length !== query.period.days
    || currentRange[1] !== response.data.period.commonCompleteThrough
  ) return false;
  if (query.period.comparison === "none") return response.data.period.comparisonRange === null;
  const expectedComparisonRange: [string, string] = [
    shiftBusinessDate(currentRange[0], -query.period.days),
    shiftBusinessDate(currentRange[0], -1)
  ];
  return JSON.stringify(response.data.period.comparisonRange) === JSON.stringify(expectedComparisonRange);
}
