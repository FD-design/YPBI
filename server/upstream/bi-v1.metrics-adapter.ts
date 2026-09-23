import { z } from "zod";
import { UpstreamError, type UpstreamClient } from "./client";

export const BI_V1_METRICS_API = "/api/admin/bi/v1/metrics";

export const biV1MetricCodeSchema = z.enum([
  "M001", "M002", "M003", "M005", "M006", "M007", "M016", "M020", "M021", "M022", "M023", "M026",
  "M034", "M036", "M060", "M081", "M084", "M086", "M090", "M095", "M097", "M099", "M112", "M113", "M114", "M115"
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
  metrics: Partial<Record<BiV1MetricCode, BiV1MetricPoint>>;
}

function nextDate(date: string) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

function parseEnvelope(payload: unknown) {
  const success = successSchema.safeParse(payload);
  if (success.success) return success.data.msg;
  const problem = errorSchema.safeParse(payload);
  if (problem.success) throw new UpstreamError("BI_V1_REQUEST_REJECTED", problem.data.err, 502);
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

function stableDimensions(dimensions: Record<string, unknown>) {
  return JSON.stringify(Object.fromEntries(Object.entries(dimensions).sort(([left], [right]) => left.localeCompare(right))));
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
  const message = parseEnvelope(payload);
  const requested = new Set(metricCodes);
  for (const row of message.rows) {
    if (!requested.has(row.metricCode) || row.dimensions.pid !== query.pid) {
      throw new UpstreamError("BI_V1_SCOPE_CONFLICT", "bi-v1 返回了请求范围外的数据", 502);
    }
    if (row.businessDate && (row.businessDate < query.startDate || row.businessDate > query.endDate)) {
      throw new UpstreamError("BI_V1_SCOPE_CONFLICT", "bi-v1 返回了请求日期外的数据", 502);
    }
  }
  return message;
}

export function aggregateBiV1MetricDays(
  message: z.infer<typeof successSchema>["msg"],
  query: BiV1MetricQuery
): BiV1MetricDay[] {
  const requested = [...new Set(query.metricCodes)];
  const globalStatuses = new Map<BiV1MetricCode, BiV1MetricDataStatus>();
  const rowsByDay = new Map<string, z.infer<typeof metricRowSchema>[]>();
  const unique = new Set<string>();
  const invalidGlobalMetrics = new Set<BiV1MetricCode>();
  const invalidMetricDays = new Set<string>();
  for (const row of message.rows) {
    if (!requested.includes(row.metricCode)) continue;
    if (row.dimensions.pid !== query.pid) throw new UpstreamError("BI_V1_SCOPE_CONFLICT", "bi-v1 指标 PID 与请求不一致", 502);
    const uniqueKey = `${row.businessDate ?? ""}\u0000${row.metricCode}\u0000${stableDimensions(row.dimensions)}`;
    if (unique.has(uniqueKey)) {
      if (row.businessDate) invalidMetricDays.add(`${row.businessDate}\u0000${row.metricCode}`);
      else invalidGlobalMetrics.add(row.metricCode);
      continue;
    }
    unique.add(uniqueKey);
    if (!row.businessDate) {
      const previous = globalStatuses.get(row.metricCode);
      if (previous && previous !== row.dataStatus) invalidGlobalMetrics.add(row.metricCode);
      globalStatuses.set(row.metricCode, row.dataStatus);
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
    for (const code of requested) {
      if (invalidGlobalMetrics.has(code) || invalidMetricDays.has(`${date}\u0000${code}`)) {
        metrics[code] = invalidMetric();
        continue;
      }
      const rows = dayRows.filter((row) => row.metricCode === code);
      if (!rows.length) {
        metrics[code] = unavailable(globalStatuses.get(code) ?? null);
        continue;
      }
      if (rows.length !== 1 || Object.keys(rows[0].dimensions).some((key) => key !== "pid")) {
        metrics[code] = invalidMetric();
        continue;
      }
      const statuses = new Set(rows.map((row) => row.dataStatus));
      const units = new Set(rows.map((row) => row.unit));
      if (statuses.size !== 1 || units.size !== 1) {
        metrics[code] = invalidMetric();
        continue;
      }
      const status = rows[0].dataStatus;
      if (status !== "READY") {
        // Never consume a business value from a non-ready row. Some upstream
        // versions currently violate that contract; the status remains the
        // authority while valid sibling metrics continue to work.
        metrics[code] = unavailable(status);
        continue;
      }
      try {
        const unit = rows[0].unit;
        if (unit === "count") {
          const value = safeInteger(rows[0].value!, `${code} 数值`);
          if (rows[0].numerator !== value || rows[0].denominator !== 0) throw new UpstreamError("BI_V1_VALUE_CONFLICT", `${code} 计数分子分母不一致`, 502);
          metrics[code] = { dataStatus: "READY", state: "available", value, numerator: value, denominator: 0, unit };
          continue;
        }
        const numerator = safeInteger(rows[0].numerator, `${code} 分子`);
        const denominator = safeInteger(rows[0].denominator, `${code} 分母`);
        if (denominator === 0 ? rows[0].value !== null : rows[0].value === null || Math.abs(rows[0].value - numerator / denominator) > 1e-12) {
          throw new UpstreamError("BI_V1_VALUE_CONFLICT", `${code} 比率与分子分母不一致`, 502);
        }
        metrics[code] = denominator === 0
          ? { dataStatus: "READY", state: "zero_denominator", value: null, numerator, denominator, unit }
          : { dataStatus: "READY", state: "available", value: numerator / denominator, numerator, denominator, unit };
      } catch (error) {
        if (!(error instanceof UpstreamError)) throw error;
        metrics[code] = invalidMetric();
      }
    }
    days.push({ date, metrics });
  }
  return days;
}

export async function readBiV1MetricDays(client: Pick<UpstreamClient, "get">, query: BiV1MetricQuery) {
  const message = await queryBiV1Metrics(client, query);
  return { message, days: aggregateBiV1MetricDays(message, query) };
}
