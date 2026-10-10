import { z } from "zod";
import { DAILY_PLAYBACK_MAX_GROUPS, DAILY_PLAYBACK_MAX_POINTS, DAILY_PLAYBACK_METRIC_IDS, type DailyPlaybackGroupResult, type DailyPlaybackGroups, type DailyPlaybackPoint, type DailyPlaybackSummary, type DailyReadingMetric } from "../../contracts/daily-dashboard";
import { UpstreamError, type UpstreamClient } from "./client";

export const BI_V1_PLAYBACK_API = "/api/admin/bi/v1/playback";
export const BI_V1_EFFECTIVE_PLAY_RULE_VERSION = "effective_play_v3";
const playbackMetricCodeSchema = z.enum(["M034", "M036", "M097"]);
export type BiV1PlaybackMetricCode = z.infer<typeof playbackMetricCodeSchema>;

export type BiV1DataStatus = "READY" | "PROCESSING" | "NOT_MATURE" | "SOURCE_INCOMPLETE" | "FAILED";

const dataStatusSchema = z.enum(["READY", "PROCESSING", "NOT_MATURE", "SOURCE_INCOMPLETE", "FAILED"]);
const rowSchema = z.object({
  metricCode: playbackMetricCodeSchema,
  businessDate: z.iso.date().optional(),
  dimensions: z.object({
    pid: z.string().min(1).max(32),
    videoType: z.string().min(1).max(64).optional()
  }).loose(),
  value: z.number().finite().nonnegative().nullable(),
  numerator: z.number().finite().nonnegative(),
  denominator: z.number().finite().nonnegative(),
  unit: z.enum(["count", "ratio"]),
  dataStatus: dataStatusSchema,
  metricVersion: z.literal("bi-v1"),
  ruleVersion: z.string().max(128).optional()
}).loose();

const successSchema = z.object({
  code: z.literal(200),
  msg: z.object({
    metricVersion: z.literal("bi-v1"),
    generatedAt: z.iso.datetime({ offset: true }),
    watermark: z.string().max(128).nullable(),
    rows: z.array(rowSchema).max(100_000)
  }).loose()
}).loose();

const errorSchema = z.object({
  code: z.number().int().refine((value) => value !== 200),
  err: z.string().min(1).max(1_000)
}).loose();

export type BiV1MetricRow = z.infer<typeof rowSchema>;
export type BiV1MetricMessage = z.infer<typeof successSchema>["msg"];

export interface BiV1MetricQuery {
  pid: string;
  startDate: string;
  endDate: string;
  includeIncomplete?: boolean;
}

export interface BiV1PlaybackMetricPoint {
  dataStatus: BiV1DataStatus | null;
  state: "available" | "no_record" | "no_value" | "invalid_value" | "immature" | "source_failure" | "zero_denominator";
  value: number | null;
  numerator: number | null;
  denominator: number | null;
}

export interface BiV1PlaybackDay {
  date: string;
  metrics: Record<"M034" | "M036" | "M097", BiV1PlaybackMetricPoint>;
}

function nextDate(date: string) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

function parseEnvelope(payload: unknown) {
  const success = successSchema.safeParse(payload);
  if (success.success) return success.data.msg;
  const problem = errorSchema.safeParse(payload);
  if (problem.success) {
    throw new UpstreamError("BI_V1_REQUEST_REJECTED", problem.data.err, 502);
  }
  throw new UpstreamError("BI_V1_RESPONSE_INVALID", "bi-v1 数据结构无法识别", 502);
}

function assertPlaybackDimensions(row: BiV1MetricRow) {
  if (Object.keys(row.dimensions).some(key => key !== "pid" && key !== "videoType")) {
    throw new UpstreamError("BI_V1_SCOPE_CONFLICT", "播放数据包含未请求的分组维度", 502);
  }
}

export async function queryBiV1Playback(client: Pick<UpstreamClient, "get">, query: BiV1MetricQuery) {
  const codes: readonly BiV1PlaybackMetricCode[] = ["M034", "M036", "M097"];
  const payload = await client.get(BI_V1_PLAYBACK_API, {
    pid: query.pid,
    startDate: query.startDate,
    endDate: nextDate(query.endDate),
    granularity: "day",
    metricCodes: codes.join(","),
    dimensions: "videoType",
    includeIncomplete: query.includeIncomplete === false ? "false" : "true"
  });
  const message = parseEnvelope(payload);
  const requested = new Set(codes);
  for (const row of message.rows) {
    assertPlaybackDimensions(row);
    if (!requested.has(row.metricCode) || row.dimensions.pid !== query.pid) {
      throw new UpstreamError("BI_V1_SCOPE_CONFLICT", "bi-v1 返回了请求范围外的数据", 502);
    }
    if (row.businessDate && (row.businessDate < query.startDate || row.businessDate > query.endDate)) {
      throw new UpstreamError("BI_V1_SCOPE_CONFLICT", "bi-v1 返回了请求日期外的数据", 502);
    }
    if (row.dataStatus === "READY" && row.value === null && !(row.unit === "ratio" && row.denominator === 0)) {
      throw new UpstreamError("BI_V1_VALUE_CONFLICT", "bi-v1 已就绪记录缺少业务值", 502);
    }
    if (row.dataStatus !== "READY" && row.value !== null) {
      throw new UpstreamError("BI_V1_VALUE_CONFLICT", "bi-v1 未就绪记录不应返回业务值", 502);
    }
  }
  return message;
}

function stateForStatus(status: BiV1DataStatus): BiV1PlaybackMetricPoint["state"] {
  if (status === "NOT_MATURE") return "immature";
  if (status === "FAILED") return "source_failure";
  return "no_value";
}

function unavailablePoint(status: BiV1DataStatus | null, state: BiV1PlaybackMetricPoint["state"] = "no_record"): BiV1PlaybackMetricPoint {
  return { dataStatus: status, state: status ? stateForStatus(status) : state, value: null, numerator: null, denominator: null };
}

function safeCount(value: number, label: string) {
  if (!Number.isSafeInteger(value)) throw new UpstreamError("BI_V1_VALUE_CONFLICT", `${label} 不是安全整数`, 502);
  return value;
}

export function aggregateBiV1Playback(message: BiV1MetricMessage, query: Pick<BiV1MetricQuery, "pid" | "startDate" | "endDate">): BiV1PlaybackDay[] {
  const playbackCodes = new Set<BiV1PlaybackMetricCode>(["M034", "M036", "M097"]);
  const globalStatuses = new Map<BiV1PlaybackMetricCode, BiV1DataStatus>();
  const rowsByDate = new Map<string, BiV1MetricRow[]>();
  const unique = new Set<string>();
  for (const row of message.rows) {
    if (!playbackCodes.has(row.metricCode)) continue;
    if (row.dimensions.pid !== query.pid) throw new UpstreamError("BI_V1_SCOPE_CONFLICT", "播放数据 PID 与请求不一致", 502);
    assertPlaybackDimensions(row);
    if (!row.businessDate) {
      const previous = globalStatuses.get(row.metricCode);
      if (previous && previous !== row.dataStatus) throw new UpstreamError("BI_V1_VALUE_CONFLICT", "播放指标范围状态不一致", 502);
      globalStatuses.set(row.metricCode, row.dataStatus);
      continue;
    }
    if (row.businessDate < query.startDate || row.businessDate > query.endDate) throw new UpstreamError("BI_V1_SCOPE_CONFLICT", "播放数据日期与请求不一致", 502);
    const key = `${row.businessDate}\u0000${row.metricCode}\u0000${row.dimensions.videoType ?? ""}`;
    if (unique.has(key)) throw new UpstreamError("BI_V1_VALUE_CONFLICT", "播放数据存在重复维度记录", 502);
    unique.add(key);
    const dateRows = rowsByDate.get(row.businessDate) ?? [];
    dateRows.push(row);
    rowsByDate.set(row.businessDate, dateRows);
  }

  const days: BiV1PlaybackDay[] = [];
  for (let date = query.startDate; date <= query.endDate; date = nextDate(date)) {
    const rows = rowsByDate.get(date) ?? [];
    if (!rows.length) {
      days.push({ date, metrics: {
        M034: unavailablePoint(globalStatuses.get("M034") ?? null),
        M036: unavailablePoint(globalStatuses.get("M036") ?? null),
        M097: unavailablePoint(globalStatuses.get("M097") ?? null)
      } });
      continue;
    }
    const videoTypes = [...new Set(rows.map((row) => row.dimensions.videoType ?? ""))];
    if (videoTypes.includes("") && videoTypes.length > 1) throw new UpstreamError("BI_V1_SCOPE_CONFLICT", "播放总体与视频类型分组不能混合汇总", 502);
    let effective = 0;
    let starts = 0;
    let invalidEffectiveRule = false;
    let unavailable: BiV1DataStatus | null = null;
    for (const videoType of videoTypes) {
      const find = (code: "M034" | "M036" | "M097") => rows.find((row) => row.metricCode === code && (row.dimensions.videoType ?? "") === videoType);
      const effectiveRow = find("M034"), ratioRow = find("M036"), startsRow = find("M097");
      if (!effectiveRow || !ratioRow || !startsRow) throw new UpstreamError("BI_V1_VALUE_CONFLICT", "播放指标分组记录不完整", 502);
      const statuses = new Set([effectiveRow.dataStatus, ratioRow.dataStatus, startsRow.dataStatus]);
      if (statuses.size !== 1) throw new UpstreamError("BI_V1_VALUE_CONFLICT", "播放指标分组状态不一致", 502);
      const status = effectiveRow.dataStatus;
      if (status !== "READY") {
        const priority: Record<BiV1DataStatus, number> = { FAILED: 4, PROCESSING: 3, NOT_MATURE: 2, SOURCE_INCOMPLETE: 1, READY: 0 };
        if (!unavailable || priority[status] > priority[unavailable]) unavailable = status;
        continue;
      }
      const startsValue = safeCount(startsRow.value!, "成功起播次数");
      if (startsRow.unit !== "count" || startsRow.numerator !== startsValue || startsRow.denominator !== 0) {
        throw new UpstreamError("BI_V1_VALUE_CONFLICT", "成功起播次数分子分母不一致", 502);
      }
      starts = safeCount(starts + startsValue, "成功起播次数合计");
      if (effectiveRow.ruleVersion !== BI_V1_EFFECTIVE_PLAY_RULE_VERSION || ratioRow.ruleVersion !== BI_V1_EFFECTIVE_PLAY_RULE_VERSION) {
        invalidEffectiveRule = true;
        continue;
      }
      const effectiveValue = safeCount(effectiveRow.value!, "有效观看次数");
      if (effectiveRow.unit !== "count" || ratioRow.unit !== "ratio"
        || effectiveRow.numerator !== effectiveValue || effectiveRow.denominator !== 0
        || effectiveValue > startsValue
        || ratioRow.numerator !== effectiveValue || ratioRow.denominator !== startsValue
        || (startsValue === 0 ? ratioRow.value !== null : Math.abs(ratioRow.value! - effectiveValue / startsValue) > 1e-12)) {
        throw new UpstreamError("BI_V1_VALUE_CONFLICT", "播放指标分子分母不一致", 502);
      }
      effective = safeCount(effective + effectiveValue, "有效观看次数合计");
    }
    if (unavailable) {
      days.push({ date, metrics: {
        M034: unavailablePoint(unavailable), M036: unavailablePoint(unavailable), M097: unavailablePoint(unavailable)
      } });
      continue;
    }
    days.push({ date, metrics: {
      M034: invalidEffectiveRule ? { ...unavailablePoint(null, "invalid_value"), dataStatus: "READY" }
        : { dataStatus: "READY", state: "available", value: effective, numerator: effective, denominator: 0 },
      M097: { dataStatus: "READY", state: "available", value: starts, numerator: starts, denominator: 0 },
      M036: invalidEffectiveRule ? { ...unavailablePoint(null, "invalid_value"), dataStatus: "READY" }
        : starts === 0
        ? { dataStatus: "READY", state: "zero_denominator", value: null, numerator: effective, denominator: starts }
        : { dataStatus: "READY", state: "available", value: effective / starts, numerator: effective, denominator: starts }
    } });
  }
  return days;
}

export async function readBiV1PlaybackDays(client: Pick<UpstreamClient, "get">, query: Pick<BiV1MetricQuery, "pid" | "startDate" | "endDate">) {
  const message = await queryBiV1Playback(client, {
    ...query,
    includeIncomplete: true
  });
  return { message, days: aggregateBiV1Playback(message, query) };
}

export function unavailableBiV1PlaybackGroups(state: "source_failure" | "invalid_response"): DailyPlaybackGroups {
  return { videoType: { dimension: "videoType", completeness: "unknown", day: { state, scopeStatuses: [], generatedAt: null, watermark: null }, groups: [] } };
}

const emptyGroupReading = (metric: DailyReadingMetric, state: DailyPlaybackSummary["state"], ruleVersion: string | null = null): DailyPlaybackSummary => ({
  state, value: null, inputs: metric.inputs.map(input => ({ key: input.key, value: null })), ruleVersion
});

function playbackGroupSummary(metric: DailyReadingMetric, points: DailyPlaybackPoint[], endDate: string, today: string): DailyPlaybackSummary {
  const versions = new Set(points.map(point => point.ruleVersion));
  const ruleVersion = versions.size === 1 ? points[0].ruleVersion : null;
  if (endDate >= today) return emptyGroupReading(metric, "immature", ruleVersion);
  if (points.some(point => !["available", "zero_denominator"].includes(point.state))
    || versions.size !== 1 || points.length > 1 && !ruleVersion) return emptyGroupReading(metric, "incomplete", ruleVersion);
  const sums = metric.inputs.map((_, index) => points.reduce((sum, point) => sum + (point.inputs[index].value ?? Number.NaN), 0));
  if (sums.some(value => !Number.isSafeInteger(value) || value < 0)) return emptyGroupReading(metric, "invalid_value", ruleVersion);
  const ratio = metric.id === "M036";
  const value = ratio ? sums[1] === 0 ? null : sums[0] / sums[1] : sums[0];
  return { state: ratio && sums[1] === 0 ? "zero_denominator" : "available", value,
    inputs: metric.inputs.map((input, index) => ({ key: input.key, value: sums[index] })), sourceStatus: "READY", ruleVersion };
}

/** Project the same day response independently; malformed groups do not supply or repair the overall result. */
export function projectBiV1PlaybackGroups(message: BiV1MetricMessage, query: Pick<BiV1MetricQuery, "pid" | "startDate" | "endDate">,
  today: string, metricFor: (id: BiV1PlaybackMetricCode) => DailyReadingMetric): DailyPlaybackGroups {
  const dates: string[] = [];
  for (let date = query.startDate; date <= query.endDate; date = nextDate(date)) dates.push(date);
  const grouped = new Map<string, Map<string, BiV1MetricRow[]>>();
  const scopes = new Map<string, BiV1MetricRow[]>();
  const identity = (code: BiV1PlaybackMetricCode, date?: string) => JSON.stringify([code, date ?? null]);
  for (const row of message.rows) {
    if (row.dimensions.pid !== query.pid || row.businessDate && (row.businessDate < query.startDate || row.businessDate > query.endDate)) return unavailableBiV1PlaybackGroups("invalid_response");
    try { assertPlaybackDimensions(row); } catch { return unavailableBiV1PlaybackGroups("invalid_response"); }
    const key = row.dimensions.videoType;
    if (key === undefined) {
      if (row.dataStatus === "READY") continue;
      const id = identity(row.metricCode, row.businessDate);
      scopes.set(id, [...(scopes.get(id) ?? []), row]);
      continue;
    }
    if (!key.trim() || row.dataStatus === "READY" && !row.businessDate) return unavailableBiV1PlaybackGroups("invalid_response");
    const rows = grouped.get(key) ?? new Map<string, BiV1MetricRow[]>();
    const id = identity(row.metricCode, row.businessDate);
    rows.set(id, [...(rows.get(id) ?? []), row]);
    grouped.set(key, rows);
  }
  if (grouped.size > DAILY_PLAYBACK_MAX_GROUPS || grouped.size * DAILY_PLAYBACK_METRIC_IDS.length * (dates.length + 1) > DAILY_PLAYBACK_MAX_POINTS
    || [...scopes.values()].some(rows => rows.length !== 1)) return unavailableBiV1PlaybackGroups("invalid_response");
  const scopeRows = [...scopes.values()].flat();
  if (scopeRows.some(row => row.businessDate && scopes.has(identity(row.metricCode)) && scopes.get(identity(row.metricCode))![0].dataStatus !== row.dataStatus)) return unavailableBiV1PlaybackGroups("invalid_response");
  const day: DailyPlaybackGroupResult["day"] = { state: message.rows.length ? "returned" : "empty", generatedAt: message.generatedAt, watermark: message.watermark,
    scopeStatuses: scopeRows.map(row => ({ metricId: row.metricCode, sourceStatus: row.dataStatus as "PROCESSING" | "NOT_MATURE" | "SOURCE_INCOMPLETE" | "FAILED", ...(row.businessDate ? { businessDate: row.businessDate } : {}) })) };
  return { videoType: { dimension: "videoType", completeness: "unknown", day, groups: [...grouped].map(([key, rows]) => {
    const points = new Map<BiV1PlaybackMetricCode, DailyPlaybackPoint[]>(DAILY_PLAYBACK_METRIC_IDS.map(id => [id, []]));
    for (const date of dates) {
      const selected = DAILY_PLAYBACK_METRIC_IDS.flatMap(id => rows.get(identity(id, date)) ?? rows.get(identity(id)) ?? scopes.get(identity(id, date)) ?? scopes.get(identity(id)) ?? [])
        .map(row => ({ ...row, businessDate: date, dimensions: { pid: query.pid, videoType: key } }));
      let values: BiV1PlaybackDay["metrics"];
      try { values = aggregateBiV1Playback({ ...message, rows: selected }, { ...query, startDate: date, endDate: date })[0].metrics; }
      catch { values = { M034: unavailablePoint(null, "invalid_value"), M036: unavailablePoint(null, "invalid_value"), M097: unavailablePoint(null, "invalid_value") }; }
      for (const id of DAILY_PLAYBACK_METRIC_IDS) {
        const metric = metricFor(id), point = values[id];
        const sourceRows = selected.filter(row => row.metricCode === id);
        const sourceRule = sourceRows.length === 1 ? sourceRows[0].ruleVersion : undefined;
        const ruleVersion = sourceRule?.trim() ? sourceRule : null;
        const missingRule = ["available", "zero_denominator"].includes(point.state) && !ruleVersion;
        const inputs = missingRule ? metric.inputs.map(() => null) : id === "M036" ? [point.numerator, point.denominator] : [point.value];
        const sourceStatus = sourceRows.length === 1 ? sourceRows[0].dataStatus : point.dataStatus;
        points.get(id)!.push({ date, state: missingRule ? "invalid_value" : point.state, value: missingRule ? null : point.value, ruleVersion,
          inputs: metric.inputs.map((input, index) => ({ key: input.key, value: inputs[index] })), ...(sourceStatus ? { sourceStatus } : {}) });
      }
    }
    return { key, label: key, series: DAILY_PLAYBACK_METRIC_IDS.map(id => {
      const metric = metricFor(id), daily = points.get(id)!;
      return { metric, points: daily, summary: playbackGroupSummary(metric, daily, query.endDate, today) };
    }) };
  }) } };
}
