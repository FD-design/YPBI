import { z } from "zod";
import { UpstreamError, type UpstreamClient } from "./client";
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
}

function shiftedDate(date: string, days: number) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function nextMonth(monthStart: string) {
  const date = new Date(`${monthStart}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date.toISOString().slice(0, 10);
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

  const yesterday = shiftedDate(today, -1);
  for (let queryStart = `${query.startDate.slice(0, 7)}-01`; queryStart <= query.endDate; queryStart = nextMonth(queryStart)) {
    const monthEnd = shiftedDate(nextMonth(queryStart), -1);
    const anchor = daysByDate.get(query.endDate < monthEnd ? query.endDate : monthEnd)!;
    const queryEnd = monthEnd < yesterday ? monthEnd : yesterday;
    const selectedStart = query.startDate > queryStart ? query.startDate : queryStart;
    if (queryEnd < selectedStart) {
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
      anchor.metrics.M018 = monthlyPoint(message);
    } catch (error) {
      if (!(error instanceof UpstreamError)) throw error;
      anchor.metrics.M018 = emptyPoint("source_failure");
    }
  }
  return { days };
}
