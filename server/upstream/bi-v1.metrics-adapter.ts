import { z } from "zod";
import { UpstreamError, type UpstreamClient } from "./client";

export const BI_V1_METRICS_API = "/api/admin/bi/v1/metrics";

export const biV1MetricCodeSchema = z.enum([
  "M001", "M002", "M003", "M005", "M006", "M007", "M008", "M016", "M018", "M020", "M021", "M022", "M023", "M026",
  "M034", "M036", "M060", "M081", "M084", "M086", "M090", "M095", "M097", "M099", "M103", "M110", "M111", "M112", "M113", "M114", "M115"
]);
export type BiV1MetricCode = z.infer<typeof biV1MetricCodeSchema>;
export type BiV1MetricDataStatus = "READY" | "PROCESSING" | "NOT_MATURE" | "SOURCE_INCOMPLETE" | "FAILED";

const dataStatusSchema = z.enum(["READY", "PROCESSING", "NOT_MATURE", "SOURCE_INCOMPLETE", "FAILED"]);
const metricRowSchema = z.object({
  metricCode: biV1MetricCodeSchema,
  businessDate: z.iso.date().optional(),
  dimensions: z.object({ pid: z.string().min(1).max(32) }).loose(),
  value: z.number().finite().nonnegative().nullable(),
  numerator: z.number().finite().nonnegative(),
  denominator: z.number().finite().nonnegative(),
  unit: z.enum(["count", "ratio"]),
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
  dimensions: z.object({ pid: z.string().optional().catch(undefined) }).optional().catch(undefined)
});

export interface BiV1MetricQuery {
  pid: string;
  startDate: string;
  endDate: string;
  metricCodes: readonly BiV1MetricCode[];
}

export interface BiV1MetricPoint {
  dataStatus: BiV1MetricDataStatus | null;
  state: "available" | "no_record" | "no_value" | "invalid_value" | "immature" | "source_failure" | "zero_denominator";
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  unit: "count" | "ratio" | null;
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
  wechat: "wechat", wechat_pay: "wechat", wx: "wechat", "微信": "wechat",
  usdt: "usdt",
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
  payment_method: ["alipay", "wechat", "usdt"]
};

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
  const tokens: string[] = [];
  for (const [field, value] of entries) {
    const token = typeof value === "string" ? normalizedDimensionValue(value) : "";
    if (!Object.hasOwn(dimensionFieldValues, field) || !dimensionFieldValues[field].includes(token)) {
      return `${code}|unmapped:${JSON.stringify(entries)}`;
    }
    tokens.push(token);
  }
  tokens.sort();
  return tokens.length ? `${code}|${tokens.join("+")}` : code;
}

function nextDate(date: string) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

function parseEnvelope(payload: unknown) {
  const success = successSchema.safeParse(payload);
  if (success.success) return success.data.msg;
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

export async function queryBiV1Metrics(client: Pick<UpstreamClient, "get">, query: BiV1MetricQuery) {
  const metricCodes = [...new Set(query.metricCodes)];
  if (!metricCodes.length) throw new UpstreamError("BI_V1_REQUEST_REJECTED", "bi-v1 指标列表不能为空", 422);
  const payload = await client.get(BI_V1_METRICS_API, {
    pid: query.pid,
    startDate: query.startDate,
    endDate: nextDate(query.endDate),
    granularity: "day",
    metricCodes: metricCodes.join(","),
    includeIncomplete: "true"
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
  return parseEnvelope(payload);
}

export function aggregateBiV1MetricDays(
  message: z.infer<typeof successSchema>["msg"],
  query: BiV1MetricQuery
): BiV1MetricDay[] {
  const requested = [...new Set(query.metricCodes)];
  const globalStatuses = new Map<string, BiV1MetricDataStatus>();
  const rowsByDay = new Map<string, z.infer<typeof metricRowSchema>[]>();
  const unique = new Set<string>();
  const invalidGlobalMetrics = new Set<string>();
  const invalidMetricDays = new Set<string>();
  for (const row of message.rows) {
    if (!requested.includes(row.metricCode)) continue;
    if (row.dimensions.pid !== query.pid) throw new UpstreamError("BI_V1_SCOPE_CONFLICT", "bi-v1 指标 PID 与请求不一致", 502);
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
    if (row.businessDate < query.startDate || row.businessDate > query.endDate) throw new UpstreamError("BI_V1_SCOPE_CONFLICT", "bi-v1 指标日期与请求不一致", 502);
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
        code,
        ...[...globalStatuses.keys(), ...grouped.keys()].filter((key) => key.startsWith(`${code}|`))
      ]);
      for (const key of relatedKeys) {
        if (invalidGlobalMetrics.has(key) || invalidMetricDays.has(`${date}\u0000${key}`)) {
          metrics[key] = invalidMetric();
          continue;
        }
        const rows = grouped.get(key) ?? [];
        if (!rows.length) {
          metrics[key] = unavailable(globalStatuses.get(key) ?? null);
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
          if (row.unit === "count") {
            const value = safeInteger(row.value!, `${key} 数值`);
            if (row.numerator !== value || row.denominator !== 0) throw new UpstreamError("BI_V1_VALUE_CONFLICT", `${key} 计数分子分母不一致`, 502);
            metrics[key] = { dataStatus: "READY", state: "available", value, numerator: value, denominator: 0, unit: row.unit };
            continue;
          }
          const numerator = safeInteger(row.numerator, `${key} 分子`);
          const denominator = safeInteger(row.denominator, `${key} 分母`);
          if (denominator === 0 ? row.value !== null : row.value === null || Math.abs(row.value - numerator / denominator) > 1e-12) {
            throw new UpstreamError("BI_V1_VALUE_CONFLICT", `${key} 比率与分子分母不一致`, 502);
          }
          metrics[key] = denominator === 0
            ? { dataStatus: "READY", state: "zero_denominator", value: null, numerator, denominator, unit: row.unit }
            : { dataStatus: "READY", state: "available", value: numerator / denominator, numerator, denominator, unit: row.unit };
        } catch (error) {
          if (!(error instanceof UpstreamError)) throw error;
          metrics[key] = invalidMetric();
        }
      }
      if (!grouped.has(code) && [...grouped.keys()].some((key) => key.startsWith(`${code}|`)) && !globalStatuses.has(code)) {
        // Dimension rows never imply an overall result; keep the old fail-closed
        // behavior instead of summing slices or choosing an arbitrary row.
        metrics[code] = invalidMetric();
      }
    }
    days.push({ date, metrics });
  }
  return days;
}

function canIsolateRequest(error: unknown) {
  if (!(error instanceof UpstreamError)) return false;
  if (error.code === "BI_V1_RESPONSE_INVALID") return true;
  const rejected = error.code === "BI_V1_REQUEST_REJECTED" && [400, 422].includes(error.statusCode)
    || error.code === "UPSTREAM_INVALID_REQUEST" && error.statusCode === 422;
  // UpstreamClient normalizes business rejections to 422. Only an explicit
  // metric-selection error is isolatable; access and other parameter errors stop.
  return rejected && !/权限|鉴权|认证|登录|token|unauthorized|forbidden|permission|credential|authentication/i.test(error.message)
    && /指标|metric/i.test(error.message)
    && /未知|不支持|无效|非法|不存在|未开放|仅支持|只支持|unknown|unsupported|invalid|unrecognized|not supported|not found|not allowed|not available/i.test(error.message);
}

export async function readBiV1MetricDays(client: Pick<UpstreamClient, "get">, query: BiV1MetricQuery) {
  const metricCodes = [...new Set(query.metricCodes)];
  try {
    const message = await queryBiV1Metrics(client, { ...query, metricCodes });
    return { message, days: aggregateBiV1MetricDays(message, query) };
  } catch (error) {
    if (!metricCodes.length || !canIsolateRequest(error)) throw error;
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
        if (!canIsolateRequest(error)) throw error;
      }
    }
    for (const day of days) day.metrics[metricCode] = { ...unavailable(null), state: "source_failure" };
  }
  // Split requests have no single upstream envelope, watermark or rule version.
  return { message: null, days };
}
