import { z } from "zod";
import { DAILY_ACQUISITION_MAX_GROUPS, DAILY_ACQUISITION_MAX_POINTS, DAILY_ACQUISITION_METRIC_IDS, type DailyAcquisitionGroupResult, type DailyAcquisitionGroups, type DailyAcquisitionRequestStatus, type DailyAcquisitionSummary, type DailyDashboardQuery, type DailyReadingMetric } from "../../contracts/daily-dashboard";
import { BI_V1_METRICS_API } from "./bi-v1.metrics-adapter";
import { isBiV1MetricSelectionRejection } from "./bi-v1.request-isolation";
import { UpstreamError, type UpstreamClient } from "./client";

export const ACQUISITION_GROUP_METRICS = DAILY_ACQUISITION_METRIC_IDS;
export type AcquisitionGroupDimension = keyof typeof ACQUISITION_GROUP_METRICS;
export type AcquisitionGroupMetric = typeof ACQUISITION_GROUP_METRICS[AcquisitionGroupDimension][number];
type Granularity = "day" | "summary";
type Query = Pick<DailyDashboardQuery, "pid" | "dateRange">;
type Reading = DailyAcquisitionSummary;
type GroupRows = Map<string, Map<string, Reading>>;
type ScopeRow = DailyAcquisitionRequestStatus["scopeStatuses"][number] & { ruleVersion: string };
type RequestResult = { status: DailyAcquisitionRequestStatus; groups: GroupRows; scopes: Map<string, ScopeRow>; failedMetrics: Set<AcquisitionGroupMetric>; rowCount: number };
const rowSchema = z.object({
  metricCode: z.enum(["M001", "M003", "M005", "M006", "M007", "M099"]),
  businessDate: z.iso.date().optional(),
  dimensions: z.record(z.string(), z.unknown()),
  dataStatus: z.enum(["READY", "PROCESSING", "NOT_MATURE", "SOURCE_INCOMPLETE", "FAILED"]),
  metricVersion: z.literal("bi-v1"), ruleVersion: z.string().max(128),
  value: z.unknown(), numerator: z.unknown(), denominator: z.unknown(), unit: z.unknown()
}).loose();
const envelopeSchema = z.object({ code: z.literal(200), msg: z.object({
  metricVersion: z.literal("bi-v1"), generatedAt: z.iso.datetime({ offset: true }),
  watermark: z.string().max(128).nullable(), rows: z.array(rowSchema).max(DAILY_ACQUISITION_MAX_POINTS)
}).loose() }).loose();
const readyNumbersSchema = z.object({ value: z.number().finite().nonnegative().nullable(),
  numerator: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), denominator: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  unit: z.enum(["count", "ratio"])
});
const unavailable = (metric: DailyReadingMetric, state: Reading["state"], sourceStatus?: Reading["sourceStatus"], ruleVersion: string | null = null): Reading => ({
  state, value: null, inputs: metric.inputs.map(input => ({ key: input.key, value: null })), ruleVersion,
  ...(sourceStatus ? { sourceStatus } : {})
});
const statusState = (status: Exclude<Reading["sourceStatus"], "READY" | undefined>): Reading["state"] =>
  status === "NOT_MATURE" ? "immature" : status === "FAILED" ? "source_failure" : "no_value";
const failure = (state: "source_failure" | "invalid_response"): RequestResult => ({
  status: { state, scopeStatuses: [], generatedAt: null, watermark: null }, groups: new Map(), scopes: new Map(), failedMetrics: new Set(), rowCount: 0
});
const rowKey = (metric: string, date?: string) => JSON.stringify([metric, date ?? null]);

function reading(row: z.infer<typeof rowSchema>, metric: DailyReadingMetric): Reading {
  if (row.dataStatus !== "READY") return unavailable(metric, statusState(row.dataStatus), row.dataStatus, row.ruleVersion);
  const parsed = readyNumbersSchema.safeParse(row);
  if (!parsed.success) return unavailable(metric, "invalid_value", "READY", row.ruleVersion);
  const { value, numerator, denominator, unit } = parsed.data;
  const ratio = metric.inputs.length === 2;
  if (unit !== (ratio ? "ratio" : "count")
    || (!ratio && (denominator !== 0 || value !== numerator))
    || (ratio && denominator === 0 && value !== null)
    || (ratio && denominator > 0 && (value === null || Math.abs(value - numerator / denominator) > 1e-12))) return unavailable(metric, "invalid_value", "READY", row.ruleVersion);
  return { state: ratio && denominator === 0 ? "zero_denominator" : "available", sourceStatus: "READY", value,
    inputs: metric.inputs.map((input, index) => ({ key: input.key, value: ratio ? index === 0 ? numerator : denominator : value })), ruleVersion: row.ruleVersion };
}

async function queryGroups(client: Pick<UpstreamClient, "get">, query: Query, dimension: AcquisitionGroupDimension,
  granularity: Granularity, metricCodes: readonly AcquisitionGroupMetric[], metricFor: (id: AcquisitionGroupMetric) => DailyReadingMetric): Promise<RequestResult> {
  let payload: unknown;
  try {
    payload = await client.get(BI_V1_METRICS_API, {
      pid: query.pid, startDate: query.dateRange[0], endDate: new Date(Date.parse(query.dateRange[1]) + 86400000).toISOString().slice(0, 10),
      granularity, metricCodes: metricCodes.join(","), dimensions: dimension, includeIncomplete: "true"
    });
  } catch (error) {
    if (isBiV1MetricSelectionRejection(error)) throw error;
    return failure("source_failure");
  }
  if (payload && typeof payload === "object" && typeof Reflect.get(payload, "code") === "number" && Reflect.get(payload, "code") !== 200) {
    const error = new UpstreamError("BI_V1_REQUEST_REJECTED", String(Reflect.get(payload, "err") ?? "后台请求失败"), Reflect.get(payload, "code"));
    if (isBiV1MetricSelectionRejection(error)) throw error;
    return failure("source_failure");
  }
  const parsed = envelopeSchema.safeParse(payload);
  if (!parsed.success) return failure("invalid_response");
  const { rows, generatedAt, watermark } = parsed.data.msg;
  const groups: GroupRows = new Map(), scopes = new Map<string, ScopeRow>(), seen = new Set<string>();
  for (const row of rows) {
    if (!metricCodes.includes(row.metricCode) || row.dimensions.pid !== query.pid
      || Object.keys(row.dimensions).some(key => key !== "pid" && key !== dimension)
      || (granularity === "summary" && row.businessDate !== undefined)
      || (granularity === "day" && row.businessDate !== undefined && (row.businessDate < query.dateRange[0] || row.businessDate > query.dateRange[1]))
      || (granularity === "day" && row.dataStatus === "READY" && row.businessDate === undefined)) return failure("invalid_response");
    const hasGroup = Object.hasOwn(row.dimensions, dimension), group = row.dimensions[dimension];
    if (hasGroup ? typeof group !== "string" || group.trim().length === 0 || group.length > 200 : row.dataStatus === "READY") return failure("invalid_response");
    const identity = JSON.stringify([hasGroup ? group : null, row.metricCode, row.businessDate ?? null]);
    if (seen.has(identity)) return failure("invalid_response");
    seen.add(identity);
    if (!hasGroup) {
      // A pid-only non-READY row describes the request scope, not a synthetic group.
      scopes.set(rowKey(row.metricCode, row.businessDate), { metricId: row.metricCode, sourceStatus: row.dataStatus as ScopeRow["sourceStatus"], ruleVersion: row.ruleVersion,
        ...(row.businessDate ? { businessDate: row.businessDate } : {}) });
      continue;
    }
    const key = group as string, values = groups.get(key) ?? new Map<string, Reading>();
    values.set(rowKey(row.metricCode, row.businessDate), reading(row, metricFor(row.metricCode)));
    groups.set(key, values);
    if (groups.size > DAILY_ACQUISITION_MAX_GROUPS) return failure("invalid_response");
  }
  if ([...scopes.values()].some(scope => scope.businessDate && scopes.has(rowKey(scope.metricId)) && scopes.get(rowKey(scope.metricId))!.sourceStatus !== scope.sourceStatus)) return failure("invalid_response");
  return { groups, scopes, failedMetrics: new Set(), rowCount: rows.length, status: { state: rows.length ? "returned" : "empty", generatedAt, watermark,
    scopeStatuses: [...scopes.values()].map(({ ruleVersion: _ruleVersion, ...scope }) => scope) } };
}

async function requestGroups(client: Pick<UpstreamClient, "get">, query: Query, dimension: AcquisitionGroupDimension,
  granularity: Granularity, metricCodes: readonly AcquisitionGroupMetric[], metricFor: (id: AcquisitionGroupMetric) => DailyReadingMetric): Promise<RequestResult> {
  const codes = [...new Set(metricCodes)];
  try {
    return await queryGroups(client, query, dimension, granularity, codes, metricFor);
  } catch (error) {
    if (!isBiV1MetricSelectionRejection(error) || codes.length <= 1) return failure("source_failure");
  }
  const result = failure("source_failure");
  for (const code of codes) {
    let selected: RequestResult;
    try {
      selected = await queryGroups(client, query, dimension, granularity, [code], metricFor);
    } catch (error) {
      if (!isBiV1MetricSelectionRejection(error)) return failure("source_failure");
      result.failedMetrics.add(code);
      continue;
    }
    // A range, structure or transport failure rejects this entire request lane.
    if (selected.status.state === "source_failure" || selected.status.state === "invalid_response") return selected;
    result.rowCount += selected.rowCount;
    for (const [key, rows] of selected.groups) {
      const merged = result.groups.get(key) ?? new Map<string, Reading>();
      for (const [identity, value] of rows) merged.set(identity, value);
      result.groups.set(key, merged);
    }
    for (const [key, scope] of selected.scopes) result.scopes.set(key, scope);
    if (result.groups.size > DAILY_ACQUISITION_MAX_GROUPS || result.rowCount > DAILY_ACQUISITION_MAX_POINTS) return failure("invalid_response");
  }
  // The contract needs real groups to carry per-metric request failures.
  if (result.failedMetrics.size && !result.groups.size) return failure("source_failure");
  result.status = { state: result.rowCount ? "returned" : "empty", generatedAt: null, watermark: null,
    scopeStatuses: [...result.scopes.values()].map(({ ruleVersion: _ruleVersion, ...scope }) => scope) };
  return result;
}

function selectReading(result: RequestResult, key: string, id: AcquisitionGroupMetric, metric: DailyReadingMetric, date?: string): Reading {
  if (result.status.state === "source_failure" || result.status.state === "invalid_response") return unavailable(metric, result.status.state === "source_failure" ? "source_failure" : "invalid_value");
  if (result.failedMetrics.has(id)) return unavailable(metric, "source_failure");
  // A scope-level status takes precedence over rows in that incomplete scope.
  const scope = result.scopes.get(rowKey(id)) ?? result.scopes.get(rowKey(id, date));
  if (scope) return unavailable(metric, statusState(scope.sourceStatus), scope.sourceStatus, scope.ruleVersion);
  const rows = result.groups.get(key), range = rows?.get(rowKey(id));
  if (date && range && range.sourceStatus !== "READY") return range;
  return rows?.get(rowKey(id, date)) ?? unavailable(metric, "no_record");
}

function dimensionResult(query: Query, dimension: AcquisitionGroupDimension, day: RequestResult, summary: RequestResult,
  metricFor: (id: AcquisitionGroupMetric) => DailyReadingMetric): DailyAcquisitionGroupResult {
  const days = (Date.parse(query.dateRange[1]) - Date.parse(query.dateRange[0])) / 86400000 + 1;
  const keys = [...new Set([...day.groups.keys(), ...summary.groups.keys()])];
  const metrics = ACQUISITION_GROUP_METRICS[dimension];
  if (keys.length > DAILY_ACQUISITION_MAX_GROUPS || keys.length * metrics.length * (days + 1) > DAILY_ACQUISITION_MAX_POINTS) {
    return { dimension, completeness: "unknown", day: failure("invalid_response").status, summary: failure("invalid_response").status, groups: [] };
  }
  return { dimension, completeness: "unknown", day: day.status, summary: summary.status, groups: keys.map(key => ({ key, label: key,
    series: metrics.map(id => {
      const metric = metricFor(id);
      return { metric, points: Array.from({ length: days }, (_, i) => {
        const date = new Date(Date.parse(query.dateRange[0]) + i * 86400000).toISOString().slice(0, 10);
        // Day requests never produce the summary-only unsupported state.
        const point = selectReading(day, key, id, metric, date);
        return { ...point, state: point.state as Exclude<Reading["state"], "unsupported">, date };
      }), summary: id === "M099" && days > 1 ? unavailable(metric, "unsupported") : selectReading(summary, key, id, metric) };
    })
  })) };
}

/** Independent queries preserve raw group keys and direct day/summary results. */
export async function readBiV1AcquisitionGroups(client: Pick<UpstreamClient, "get">, query: Query,
  metricFor: (id: AcquisitionGroupMetric) => DailyReadingMetric): Promise<DailyAcquisitionGroups> {
  const channelSummary = query.dateRange[0] === query.dateRange[1] ? ACQUISITION_GROUP_METRICS.channel : ACQUISITION_GROUP_METRICS.channel.filter(id => id !== "M099");
  const [channelDay, channelPeriod, downloadDay, downloadPeriod] = await Promise.all([
    requestGroups(client, query, "channel", "day", ACQUISITION_GROUP_METRICS.channel, metricFor),
    requestGroups(client, query, "channel", "summary", channelSummary, metricFor),
    requestGroups(client, query, "downloadPlatform", "day", ACQUISITION_GROUP_METRICS.downloadPlatform, metricFor),
    requestGroups(client, query, "downloadPlatform", "summary", ACQUISITION_GROUP_METRICS.downloadPlatform, metricFor)
  ]);
  const result = { channel: dimensionResult(query, "channel", channelDay, channelPeriod, metricFor),
    downloadPlatform: dimensionResult(query, "downloadPlatform", downloadDay, downloadPeriod, metricFor) };
  const outputCount = Object.values(result).reduce((total, dimension) => total + dimension.groups.reduce((sum, group) => sum + group.series.reduce((count, series) => count + series.points.length + 1, 0), 0), 0);
  if (outputCount > DAILY_ACQUISITION_MAX_POINTS) for (const dimension of Object.values(result)) {
    dimension.groups = []; dimension.day = failure("invalid_response").status; dimension.summary = failure("invalid_response").status;
  }
  return result;
}
