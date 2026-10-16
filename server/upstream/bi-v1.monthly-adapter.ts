import { z } from "zod";
import { UpstreamError, type UpstreamClient } from "./client";
import {
  monthlyMetricMetadataSchema,
  monthlyQueryScopes,
  type MonthlyMetricMetadata,
  type MonthlyQueryScope
} from "../../contracts/monthly-query-scope";
import {
  queryBiV1Metrics,
  type BiV1MetricDataStatus,
  type BiV1MetricDay,
  type BiV1MetricMessage,
  type BiV1MetricPoint,
  type BiV1MetricQuery
} from "./bi-v1.metrics-adapter";

type MonthlyQuery = Pick<BiV1MetricQuery, "pid" | "startDate" | "endDate">;

export interface BiV1MonthlyMetricDay extends BiV1MetricDay {
  /** Inclusive query bounds for internal verification, separate from upstream data watermarks. */
  queryStart?: string;
  queryEnd?: string;
  monthlyMetadata?: MonthlyMetricMetadata;
}

function shiftedDate(date: string, days: number) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function emptyPoint(state: BiV1MetricPoint["state"], dataStatus: BiV1MetricDataStatus | null = null): BiV1MetricPoint {
  return { state, dataStatus, value: null, numerator: null, denominator: null, unit: null };
}

function monthlyPoint(message: BiV1MetricMessage): BiV1MetricPoint {
  if (!message.rows.length) return emptyPoint(message.dimensionConflicts?.length ? "source_failure" : "no_record");
  if (message.rows.length !== 1) return emptyPoint("invalid_value");
  const row = message.rows[0];
  if (row.dataStatus !== "READY") {
    const state = row.dataStatus === "NOT_MATURE" ? "immature" : row.dataStatus === "FAILED" ? "source_failure" : "no_value";
    return emptyPoint(state, row.dataStatus);
  }
  if (row.unit !== "count" || row.value === null || !Number.isSafeInteger(row.value) || row.value < 0
    || row.numerator !== row.value || row.denominator !== 0) {
    return emptyPoint("invalid_value");
  }
  return { state: "available", dataStatus: "READY", value: row.value, numerator: row.value, denominator: 0, unit: "count" };
}

function monthlyMetadata(message: BiV1MetricMessage, scope: MonthlyQueryScope, today: string): MonthlyMetricMetadata | undefined {
  if (message.rows.length !== 1) return undefined;
  const row = message.rows[0];
  const fields = ["month", "cutoffDate", "isComplete"] as const;
  const supplied = fields.filter(field => row[field] !== undefined);
  if (!supplied.length) return undefined;
  const metadata = monthlyMetricMetadataSchema.safeParse(Object.fromEntries(supplied.map(field => [field, row[field]])));
  if (!metadata.success) throw new UpstreamError("BI_V1_RESPONSE_INVALID", "月活来源元数据无效", 502);
  if (metadata.data.month !== undefined && metadata.data.month !== scope.month
    || metadata.data.cutoffDate !== undefined && metadata.data.cutoffDate !== scope.queryEnd
    || metadata.data.isComplete !== undefined && metadata.data.isComplete !== (scope.month < today.slice(0, 7))) {
    throw new UpstreamError("BI_V1_SCOPE_CONFLICT", "月活统计截止日或月份状态与请求自然月不一致", 502);
  }
  return metadata.data;
}

/**
 * M018 is one independently deduplicated summary per natural month. A completed
 * month uses its full range; the current month includes only completed business
 * days. The last selected date in each month is a display anchor, not a daily
 * observation. Other dates carry no M018 point and must not form a daily series.
 */
export async function readBiV1MonthlyMetricDays(
  client: Pick<UpstreamClient, "get">,
  query: MonthlyQuery,
  today: string
): Promise<{ days: BiV1MonthlyMetricDay[] }> {
  if (![query.startDate, query.endDate, today].every(date => z.iso.date().safeParse(date).success)
    || query.startDate > query.endDate) {
    throw new UpstreamError("BI_V1_REQUEST_REJECTED", "月活查询日期无效", 422);
  }

  const days: BiV1MonthlyMetricDay[] = [];
  const daysByDate = new Map<string, BiV1MonthlyMetricDay>();
  for (let date = query.startDate; date <= query.endDate; date = shiftedDate(date, 1)) {
    const day = { date, metrics: {} };
    days.push(day);
    daysByDate.set(date, day);
  }

  for (const scope of monthlyQueryScopes(query.startDate, query.endDate, today)) {
    const { queryStart, queryEnd } = scope;
    const anchor = daysByDate.get(scope.anchor)!;
    if (!queryStart || !queryEnd) {
      anchor.metrics.M018 = emptyPoint("no_value");
      continue;
    }

    anchor.queryStart = queryStart;
    anchor.queryEnd = queryEnd;
    try {
      const message = await queryBiV1Metrics(client, {
        pid: query.pid,
        startDate: queryStart,
        endDate: queryEnd,
        metricCodes: ["M018"],
        granularity: "summary",
        dimensions: []
      });
      // Summary rows may omit businessDate. The shared request adapter validates
      // any supplied date, PID, metric and dimension against this month's scope.
      const metadata = monthlyMetadata(message, scope, today);
      anchor.metrics.M018 = monthlyPoint(message);
      if (metadata) anchor.monthlyMetadata = metadata;
    } catch (error) {
      if (!(error instanceof UpstreamError)) throw error;
      anchor.metrics.M018 = emptyPoint("source_failure");
    }
  }
  return { days };
}
