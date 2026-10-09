import { z } from "zod";
import { UpstreamError, type UpstreamClient } from "./client";
import { canIsolateBiV1Request } from "./bi-v1.request-isolation";

export const BI_V1_METRICS_API = "/api/admin/bi/v1/metrics";

export const biV1MetricCodeSchema = z.enum([
  "M001", "M002", "M003", "M005", "M006", "M007", "M008", "M016", "M018", "M020", "M021", "M022", "M023", "M026",
  "M034", "M036", "M058", "M059", "M060", "M061", "M064", "M081", "M084", "M086", "M090", "M094", "M095", "M097", "M099", "M101", "M102", "M103", "M110", "M111", "M112", "M113", "M114", "M115"
]);
export type BiV1MetricCode = z.infer<typeof biV1MetricCodeSchema>;
export type BiV1MetricDataStatus = "READY" | "PROCESSING" | "NOT_MATURE" | "SOURCE_INCOMPLETE" | "FAILED";
const expectedRuleVersionsSchema = z.partialRecord(biV1MetricCodeSchema, z.string().min(1).max(128));

const dataStatusSchema = z.enum(["READY", "PROCESSING", "NOT_MATURE", "SOURCE_INCOMPLETE", "FAILED"]);
const metricUnitSchema = z.enum(["count", "ratio", "count_per_user", "seconds", "currency"]);
export type BiV1MetricUnit = z.infer<typeof metricUnitSchema>;
const requiredMetricUnits: Partial<Record<BiV1MetricCode, BiV1MetricUnit>> = {
  M058: "currency", M061: "ratio", M064: "ratio", M102: "seconds"
};
const metricRowSchema = z.object({
  metricCode: biV1MetricCodeSchema,
  businessDate: z.iso.date().optional(),
  dimensions: z.object({ pid: z.string().min(1).max(32) }).loose(),
  value: z.number().finite().nonnegative().nullable(),
  numerator: z.number().finite().nonnegative(),
  denominator: z.number().finite().nonnegative(),
  unit: metricUnitSchema,
  dataStatus: dataStatusSchema,
  metricVersion: z.literal("bi-v1"),
  ruleVersion: z.string().max(128)
}).loose();

const successSchema = z.object({
  code: z.literal(200),
  msg: z.object({
    metricVersion: z.literal("bi-v1"),
    generatedAt: z.iso.datetime({ offset: true }),
    watermark: z.string().max(128).nullable(),
    rows: z.array(metricRowSchema).max(100_000)
  }).loose()
}).loose();

const rawSuccessSchema = successSchema.extend({
  msg: successSchema.shape.msg.extend({ rows: z.array(z.unknown()).max(100_000) })
});
const rowDimensionScopeSchema = metricRowSchema.pick({ metricCode: true, businessDate: true, dimensions: true });

const errorSchema = z.object({
  code: z.number().int().refine((value) => value !== 200),
  err: z.string().min(1).max(1_000)
}).loose();

const scopeEnvelopeSchema = z.object({
  code: z.literal(200),
  msg: z.object({ rows: z.array(z.unknown()).max(100_000) })
});
const rowScopeSchema = z.object({
  metricCode: z.string().optional().catch(undefined),
  businessDate: z.iso.date().optional().catch(undefined),
  dimensions: z.object({ pid: z.string().optional().catch(undefined) }).loose().optional().catch(undefined)
});

const dimensionFilterSchema = z.object({
  clientPlatform: z.enum(["android", "ios", "web"]).optional(),
  userCohort: z.enum(["new", "old"]).optional(),
  sourceType: z.enum(["natural", "internal_channel"]).optional(),
  paymentMethod: z.enum(["ali_pay", "wx_pay", "usdt_pay", "unknown"]).optional()
}).strict();
const dimensionNameSchema = z.enum(["clientPlatform", "userCohort", "sourceType", "paymentMethod"]);
export type BiV1MetricDimensionFilters = z.infer<typeof dimensionFilterSchema>;
export type BiV1MetricDimension = z.infer<typeof dimensionNameSchema>;

export interface BiV1MetricQuery {
  pid: string;
  startDate: string;
  endDate: string;
  metricCodes: readonly BiV1MetricCode[];
  dimensionFilters?: BiV1MetricDimensionFilters;
  dimensions?: readonly BiV1MetricDimension[];
  granularity?: "day" | "summary";
  // Local admission rules are never forwarded to the upstream API.
  expectedRuleVersions?: Partial<Record<BiV1MetricCode, string>>;
}

type DimensionConflict = { metricCode: BiV1MetricCode; businessDate?: string };
export type BiV1MetricMessage = z.infer<typeof successSchema>["msg"] & { dimensionConflicts?: DimensionConflict[] };

export interface BiV1MetricPoint {
  dataStatus: BiV1MetricDataStatus | null;
  state: "available" | "no_record" | "no_value" | "invalid_value" | "immature" | "source_failure" | "zero_denominator";
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  unit: BiV1MetricUnit | null;
}

export interface BiV1MetricDay {
  date: string;
  metrics: Record<string, BiV1MetricPoint>;
}

const dimensionAliases: Readonly<Record<string, string>> = {
  android: "android", ios: "ios", web: "web",
  new: "new", new_user: "new", newuser: "new", "新用户": "new",
  old: "old", old_user: "old", olduser: "old", "老用户": "old",
  natural: "natural", nature: "natural", organic: "natural", "自然新增": "natural",
  internal: "internal", internal_channel: "internal", internal_traffic: "internal", "内部导量": "internal",
  alipay: "alipay", ali_pay: "alipay", "支付宝": "alipay",
  wechat: "wechat", wechat_pay: "wechat", wx_pay: "wechat", wx: "wechat", "微信": "wechat",
  usdt: "usdt", usdt_pay: "usdt",
  "android老用户": "android+old", android_old_user: "android+old",
  "ios老用户": "ios+old", ios_old_user: "ios+old"
};

function normalizedDimensionValue(value: unknown) {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return dimensionAliases[normalized] ?? normalized;
}

const platformValues = ["android", "ios", "web"] as const;
const userValues = ["new", "old", "android+old", "ios+old"] as const;
const acquisitionValues = ["natural", "internal"] as const;
const paymentValues = ["alipay", "wechat", "usdt", "unknown"] as const;
const dimensionFieldValues: Readonly<Record<string, readonly string[]>> = {
  clientPlatform: platformValues,
  platform: platformValues,
  registerPlatform: platformValues,
  d0Platform: platformValues,
  userType: userValues,
  audience: userValues,
  userCohort: userValues,
  acquisitionType: acquisitionValues,
  sourceType: acquisitionValues,
  payment_method: paymentValues,
  paymentMethod: paymentValues
};

const dimensionFieldNames: Readonly<Record<string, BiV1MetricDimension>> = {
  clientPlatform: "clientPlatform", platform: "clientPlatform", registerPlatform: "clientPlatform", d0Platform: "clientPlatform",
  userType: "userCohort", audience: "userCohort", userCohort: "userCohort",
  acquisitionType: "sourceType", sourceType: "sourceType",
  payment_method: "paymentMethod", paymentMethod: "paymentMethod"
};

function recognizedDimensions(dimensions: Record<string, unknown>) {
  const result: Partial<Record<BiV1MetricDimension, string>> = {};
  const assign = (field: BiV1MetricDimension, value: string) => {
    if (result[field] !== undefined && result[field] !== value) return false;
    result[field] = value;
    return true;
  };
  for (const [field, value] of Object.entries(dimensions)) {
    if (field === "pid") continue;
    const token = typeof value === "string" ? normalizedDimensionValue(value) : "";
    if (!Object.hasOwn(dimensionFieldValues, field) || !dimensionFieldValues[field].includes(token)) return null;
    const canonicalField = dimensionFieldNames[field];
    if (canonicalField === "userCohort" && token.includes("+")) {
      const [platform, cohort] = token.split("+");
      if (!assign("clientPlatform", platform) || !assign("userCohort", cohort)) return null;
    } else if (!assign(canonicalField, token)) return null;
  }
  return result;
}

/**
 * Only recognized field/value pairs match the slices used by dashboard mappings.
 * Other dimensions retain their field names and values in an isolated key. PID
 * supplies request scope and does not participate in the grouping key.
 */
export function biV1MetricKey(code: BiV1MetricCode, dimensions: Record<string, unknown> | readonly string[] = []) {
  if (Array.isArray(dimensions)) {
    const tokens = dimensions.map(normalizedDimensionValue).filter(Boolean).sort();
    return tokens.length ? `${code}|${tokens.join("+")}` : code;
  }
  const entries = Object.entries(dimensions).filter(([key]) => key !== "pid").sort(([left], [right]) => left.localeCompare(right));
  const recognized = recognizedDimensions(dimensions as Record<string, unknown>);
  if (!recognized) return `${code}|unmapped:${JSON.stringify(entries)}`;
  const tokens = Object.values(recognized).sort();
  return tokens.length ? `${code}|${tokens.join("+")}` : code;
}

function queryDimensions(query: BiV1MetricQuery) {
  const filters = dimensionFilterSchema.safeParse(query.dimensionFilters === undefined ? {} : query.dimensionFilters);
  const dimensions = z.array(dimensionNameSchema).max(4).safeParse(query.dimensions === undefined ? [] : query.dimensions);
  if (!filters.success || !dimensions.success || !z.enum(["day", "summary"]).safeParse(query.granularity === undefined ? "day" : query.granularity).success) {
    throw new UpstreamError("BI_V1_REQUEST_REJECTED", "bi-v1 维度筛选或分组参数无效", 422);
  }
  return {
    filters: Object.fromEntries(Object.entries(filters.data).filter(([, value]) => value !== undefined)) as BiV1MetricDimensionFilters,
    dimensions: [...new Set(dimensions.data)]
  };
}

function queryRuleVersions(query: BiV1MetricQuery) {
  const rules = expectedRuleVersionsSchema.safeParse(query.expectedRuleVersions ?? {});
  if (!rules.success) throw new UpstreamError("BI_V1_REQUEST_REJECTED", "bi-v1 本地规则版本约束无效", 422);
  return rules.data;
}

function matchesDimensionScope(dimensions: Record<string, unknown>, scope: ReturnType<typeof queryDimensions>) {
  const recognized = recognizedDimensions(dimensions);
  const expectedFields = new Set([...Object.keys(scope.filters), ...scope.dimensions]);
  return recognized !== null && Object.keys(recognized).length === expectedFields.size
    && [...expectedFields].every(field => recognized[field as BiV1MetricDimension] !== undefined)
    && Object.entries(scope.filters).every(([field, value]) => recognized[field as BiV1MetricDimension] === normalizedDimensionValue(value));
}

function requestedMetricKey(code: BiV1MetricCode, query: BiV1MetricQuery) {
  const scope = queryDimensions(query);
  const key = biV1MetricKey(code, scope.filters);
  const groupedFields = scope.dimensions.filter(field => scope.filters[field] === undefined).sort();
  return groupedFields.length ? `${key}|group:${groupedFields.join(",")}` : key;
}

function selectDimensionScope(message: BiV1MetricMessage, query: BiV1MetricQuery): BiV1MetricMessage {
  const scope = queryDimensions(query);
  const dimensionConflicts = [...(message.dimensionConflicts ?? [])];
  const rows = message.rows.filter(row => {
    if (matchesDimensionScope(row.dimensions, scope)) return true;
    dimensionConflicts.push({ metricCode: row.metricCode, ...(row.businessDate ? { businessDate: row.businessDate } : {}) });
    return false;
  });
  return dimensionConflicts.length ? { ...message, rows, dimensionConflicts } : message;
}

function nextDate(date: string) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

function parseEnvelope(payload: unknown, query: BiV1MetricQuery): BiV1MetricMessage {
  const rawSuccess = rawSuccessSchema.safeParse(payload);
  const dimensionConflicts: DimensionConflict[] = [];
  const scope = queryDimensions(query);
  const scopedPayload = rawSuccess.success ? {
    ...rawSuccess.data,
    msg: {
      ...rawSuccess.data.msg,
      rows: rawSuccess.data.msg.rows.filter(rawRow => {
        const selected = rowDimensionScopeSchema.safeParse(rawRow);
        // Malformed identity/date fields stay subject to full validation. Valid
        // out-of-scope dimensions are excluded before business-value parsing.
        if (!selected.success || matchesDimensionScope(selected.data.dimensions, scope)) return true;
        dimensionConflicts.push({ metricCode: selected.data.metricCode, ...(selected.data.businessDate ? { businessDate: selected.data.businessDate } : {}) });
        return false;
      })
    }
  } : payload;
  const success = successSchema.safeParse(scopedPayload);
  if (success.success) {
    // This metadata is local validation output and cannot be supplied upstream.
    const { dimensionConflicts: _upstreamConflicts, ...message } = success.data.msg;
    return dimensionConflicts.length ? { ...message, dimensionConflicts } : message;
  }
  const problem = errorSchema.safeParse(payload);
  if (problem.success) throw new UpstreamError("BI_V1_REQUEST_REJECTED", problem.data.err, [400, 422].includes(problem.data.code) ? problem.data.code : 502);
  throw new UpstreamError("BI_V1_RESPONSE_INVALID", "bi-v1 数据结构无法识别", 502);
}

function unavailable(status: BiV1MetricDataStatus | null): BiV1MetricPoint {
  const state = status === "NOT_MATURE" ? "immature" : status === "FAILED" ? "source_failure" : status ? "no_value" : "no_record";
  return { dataStatus: status, state, value: null, numerator: null, denominator: null, unit: null };
}

function invalidMetric(): BiV1MetricPoint {
  // A malformed metric must not invalidate valid sibling metrics in the same
  // batch. dataStatus stays null so the daily-dashboard upgrade path can keep
  // an independently validated legacy value for this metric only.
  return { dataStatus: null, state: "invalid_value", value: null, numerator: null, denominator: null, unit: null };
}

function safeInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value)) throw new UpstreamError("BI_V1_VALUE_CONFLICT", `${label} 不是安全整数`, 502);
  return value;
}

function safeScalar(value: number | null, label: string) {
  if (value === null || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new UpstreamError("BI_V1_VALUE_CONFLICT", `${label} 不是安全的非负数值`, 502);
  }
  return value;
}

export async function queryBiV1Metrics(client: Pick<UpstreamClient, "get">, query: BiV1MetricQuery) {
  const metricCodes = [...new Set(query.metricCodes)];
  if (!metricCodes.length) throw new UpstreamError("BI_V1_REQUEST_REJECTED", "bi-v1 指标列表不能为空", 422);
  const scopeDimensions = queryDimensions(query);
  queryRuleVersions(query);
  const payload = await client.get(BI_V1_METRICS_API, {
    pid: query.pid,
    startDate: query.startDate,
    endDate: nextDate(query.endDate),
    granularity: query.granularity ?? "day",
    metricCodes: metricCodes.join(","),
    includeIncomplete: "true",
    ...(query.dimensionFilters !== undefined ? { dimensionFilters: JSON.stringify(scopeDimensions.filters) } : {}),
    ...(scopeDimensions.dimensions.length ? { dimensions: scopeDimensions.dimensions.join(",") } : {})
  });
  const requested = new Set(metricCodes);
  // Scope checks precede value validation so a malformed value cannot turn a
  // cross-PID, date or metric conflict into a recoverable schema error.
  const scope = scopeEnvelopeSchema.safeParse(payload);
  for (const rawRow of scope.success ? scope.data.msg.rows : []) {
    const parsed = rowScopeSchema.safeParse(rawRow);
    if (!parsed.success) continue;
    const row = parsed.data;
    if (row.metricCode !== undefined && !requested.has(row.metricCode as BiV1MetricCode)
      || row.dimensions?.pid !== undefined && row.dimensions.pid !== query.pid) {
      throw new UpstreamError("BI_V1_SCOPE_CONFLICT", "bi-v1 返回了请求范围外的数据", 502);
    }
    if (row.businessDate && (row.businessDate < query.startDate || row.businessDate > query.endDate)) {
      throw new UpstreamError("BI_V1_SCOPE_CONFLICT", "bi-v1 返回了请求日期外的数据", 502);
    }
  }
  return parseEnvelope(payload, query);
}

export function aggregateBiV1MetricDays(
  message: BiV1MetricMessage,
  query: BiV1MetricQuery
): BiV1MetricDay[] {
  const requested = [...new Set(query.metricCodes)];
  const globalStatuses = new Map<string, BiV1MetricDataStatus>();
  const rowsByDay = new Map<string, z.infer<typeof metricRowSchema>[]>();
  const unique = new Set<string>();
  const invalidGlobalMetrics = new Set<string>();
  const invalidMetricDays = new Set<string>();
  queryDimensions(query);
  const expectedRuleVersions = queryRuleVersions(query);
  if (query.granularity === "summary") throw new UpstreamError("BI_V1_REQUEST_REJECTED", "bi-v1 汇总结果不能按日聚合", 422);
  // Validate access scope before excluding rows with unrelated dimensions.
  for (const row of message.rows) {
    if (!requested.includes(row.metricCode) || row.dimensions.pid !== query.pid
      || row.businessDate && (row.businessDate < query.startDate || row.businessDate > query.endDate)) {
      throw new UpstreamError("BI_V1_SCOPE_CONFLICT", "bi-v1 指标与请求范围不一致", 502);
    }
  }
  const scopedMessage = selectDimensionScope(message, query);
  const dimensionConflicts = scopedMessage.dimensionConflicts ?? [];
  const globalDimensionConflicts = new Set(dimensionConflicts.filter(conflict => !conflict.businessDate).map(conflict => conflict.metricCode));
  const dimensionConflictDays = new Set(dimensionConflicts.filter(conflict => conflict.businessDate).map(conflict => `${conflict.businessDate}\u0000${conflict.metricCode}`));
  const requestedKeys = new Map(requested.map(code => [code, requestedMetricKey(code, query)]));
  for (const row of scopedMessage.rows) {
    const metricKey = biV1MetricKey(row.metricCode, row.dimensions);
    const uniqueKey = `${row.businessDate ?? ""}\u0000${metricKey}`;
    if (unique.has(uniqueKey)) {
      if (row.businessDate) invalidMetricDays.add(`${row.businessDate}\u0000${metricKey}`);
      else invalidGlobalMetrics.add(metricKey);
      continue;
    }
    unique.add(uniqueKey);
    if (!row.businessDate) {
      const previous = globalStatuses.get(metricKey);
      if (previous && previous !== row.dataStatus) invalidGlobalMetrics.add(metricKey);
      globalStatuses.set(metricKey, row.dataStatus);
      continue;
    }
    const rows = rowsByDay.get(row.businessDate) ?? [];
    rows.push(row);
    rowsByDay.set(row.businessDate, rows);
  }

  const days: BiV1MetricDay[] = [];
  for (let date = query.startDate; date <= query.endDate; date = nextDate(date)) {
    const dayRows = rowsByDay.get(date) ?? [];
    const metrics: BiV1MetricDay["metrics"] = {};
    const grouped = new Map<string, z.infer<typeof metricRowSchema>[]>();
    for (const row of dayRows) {
      const key = biV1MetricKey(row.metricCode, row.dimensions);
      grouped.set(key, [...(grouped.get(key) ?? []), row]);
    }
    for (const code of requested) {
      const relatedKeys = new Set([
        requestedKeys.get(code)!,
        ...[...globalStatuses.keys(), ...grouped.keys()].filter((key) => key.startsWith(`${code}|`))
      ]);
      for (const key of relatedKeys) {
        if (invalidGlobalMetrics.has(key) || invalidMetricDays.has(`${date}\u0000${key}`)) {
          metrics[key] = invalidMetric();
          continue;
        }
        const rows = grouped.get(key) ?? [];
        if (!rows.length) {
          const scopeConflict = key === requestedKeys.get(code)
            && (globalDimensionConflicts.has(code) || dimensionConflictDays.has(`${date}\u0000${code}`));
          metrics[key] = globalStatuses.has(key) ? unavailable(globalStatuses.get(key)!)
            : scopeConflict ? { ...unavailable(null), state: "source_failure" } : unavailable(null);
          continue;
        }
        if (rows.length !== 1) {
          metrics[key] = invalidMetric();
          continue;
        }
        const row = rows[0];
        if (row.dataStatus !== "READY") {
          // Never consume a business value from a non-ready row. Some upstream
          // versions currently violate that contract; the status remains the
          // authority while valid sibling metrics continue to work.
          metrics[key] = unavailable(row.dataStatus);
          continue;
        }
        try {
          const expectedRuleVersion = expectedRuleVersions[row.metricCode];
          if (expectedRuleVersion !== undefined && row.ruleVersion !== expectedRuleVersion) {
            throw new UpstreamError("BI_V1_VALUE_CONFLICT", `${key} 规则版本不符合本地准入条件`, 502);
          }
          const requiredUnit = requiredMetricUnits[row.metricCode];
          if (requiredUnit && row.unit !== requiredUnit) {
            throw new UpstreamError("BI_V1_VALUE_CONFLICT", `${key} 单位与指标契约不一致`, 502);
          }
          if (row.unit === "seconds" || row.unit === "currency") {
            if (row.unit !== requiredUnit) throw new UpstreamError("BI_V1_VALUE_CONFLICT", `${key} 未登记该标量单位`, 502);
            const value = safeScalar(row.value, `${key} 数值`);
            if (row.numerator !== value || row.denominator !== 0) throw new UpstreamError("BI_V1_VALUE_CONFLICT", `${key} 标量分子分母不一致`, 502);
            metrics[key] = { dataStatus: "READY", state: "available", value, numerator: value, denominator: 0, unit: row.unit };
            continue;
          }
          if (row.unit === "count") {
            const value = safeInteger(row.value!, `${key} 数值`);
            if (row.numerator !== value || row.denominator !== 0) throw new UpstreamError("BI_V1_VALUE_CONFLICT", `${key} 计数分子分母不一致`, 502);
            metrics[key] = { dataStatus: "READY", state: "available", value, numerator: value, denominator: 0, unit: row.unit };
            continue;
          }
          const numerator = safeInteger(row.numerator, `${key} 分子`);
          const denominator = safeInteger(row.denominator, `${key} 分母`);
          if (denominator === 0 ? row.value !== null : row.value === null || Math.abs(row.value - numerator / denominator) > 1e-12) {
            throw new UpstreamError("BI_V1_VALUE_CONFLICT", `${key} 数值与分子分母不一致`, 502);
          }
          metrics[key] = denominator === 0
            ? { dataStatus: "READY", state: "zero_denominator", value: null, numerator, denominator, unit: row.unit }
            : { dataStatus: "READY", state: "available", value: numerator / denominator, numerator, denominator, unit: row.unit };
        } catch (error) {
          if (!(error instanceof UpstreamError)) throw error;
          metrics[key] = invalidMetric();
        }
      }
    }
    days.push({ date, metrics });
  }
  return days;
}

export async function readBiV1MetricDays(client: Pick<UpstreamClient, "get">, query: BiV1MetricQuery) {
  const metricCodes = [...new Set(query.metricCodes)];
  try {
    const message = await queryBiV1Metrics(client, { ...query, metricCodes });
    return { message, days: aggregateBiV1MetricDays(message, query) };
  } catch (error) {
    if (!metricCodes.length || !canIsolateBiV1Request(error)) throw error;
  }

  const days: BiV1MetricDay[] = [];
  for (let date = query.startDate; date <= query.endDate; date = nextDate(date)) days.push({ date, metrics: {} });
  // The finite metric registry bounds this to one batch plus one sequential
  // request per metric. Every retry keeps the same client, PID and date range.
  for (const metricCode of metricCodes) {
    if (metricCodes.length > 1) {
      try {
        const singleQuery = { ...query, metricCodes: [metricCode] };
        const message = await queryBiV1Metrics(client, singleQuery);
        aggregateBiV1MetricDays(message, singleQuery).forEach((day, index) => Object.assign(days[index].metrics, day.metrics));
        continue;
      } catch (error) {
        if (!canIsolateBiV1Request(error)) throw error;
      }
    }
    for (const day of days) day.metrics[requestedMetricKey(metricCode, query)] = { ...unavailable(null), state: "source_failure" };
  }
  // Split requests have no single upstream envelope, watermark or rule version.
  return { message: null, days };
}
