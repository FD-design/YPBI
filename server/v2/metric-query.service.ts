import { randomUUID } from "node:crypto";
import {
  type V2MetricQuery,
  type V2MetricQuerySuccess,
  type V2UnavailableDate
} from "../../contracts/bi-v2";
import { getPlatformByPid } from "../platforms/registry";
import { P_DAY_SUM_API } from "../upstream/overview.adapter";
import { getV2Metric } from "./catalog";
import { M016SourceDataError, type M016Source, type M016SourceRow } from "./m016-source";

export class V2MetricQueryError extends Error {
  constructor(
    public readonly code: "UNSUPPORTED_V2_METRIC_QUERY" | "V2_METRIC_SOURCE_CONFLICT",
    message: string,
    public readonly statusCode: 422 | 502,
    public readonly details?: unknown
  ) {
    super(message);
  }
}

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

export class V2MetricQueryService {
  constructor(private readonly m016Source: M016Source) {}

  async execute(query: V2MetricQuery): Promise<V2MetricQuerySuccess> {
    const metric = getV2Metric(query.metricId);
    const platform = getPlatformByPid(query.pid);
    if (!metric || query.grain !== "day" || !platform?.enabled) {
      throw new V2MetricQueryError(
        "UNSUPPORTED_V2_METRIC_QUERY",
        "所选指标或业务 PID 尚未进入首批只读查询范围",
        422
      );
    }

    let rows: M016SourceRow[];
    try {
      rows = await this.m016Source.queryDailyActiveUsers({ pid: query.pid, dateRange: query.dateRange });
    } catch (error) {
      if (error instanceof M016SourceDataError) {
        throw new V2MetricQueryError(
          "V2_METRIC_SOURCE_CONFLICT",
          "M016 数据源返回内容不满足已确认契约，查询已停止",
          502,
          { reason: error.reason }
        );
      }
      throw error;
    }
    const warnings = ["M016 当前为“技术称已实现（待验数）”，结果不能标记为已验数。", "上游尚未提供正式数据水位，当前响应不推断成熟日期。"];
    const expectedDates = enumerateBusinessDates(query.dateRange);
    const indexed = new Map<string, M016SourceRow>();
    const expectedDateSet = new Set(expectedDates);

    for (const row of rows) {
      if (row.pid !== query.pid) {
        throw new V2MetricQueryError(
          "V2_METRIC_SOURCE_CONFLICT",
          "上游返回了所选业务范围之外的 PID，查询已停止",
          502
        );
      }
      if (!expectedDateSet.has(row.businessDate)) {
        throw new V2MetricQueryError(
          "V2_METRIC_SOURCE_CONFLICT",
          "上游返回了所选业务日期范围之外的记录，查询已停止",
          502
        );
      }
      if (row.value !== null && (!Number.isSafeInteger(row.value) || row.value < 0)) {
        throw new V2MetricQueryError(
          "V2_METRIC_SOURCE_CONFLICT",
          `上游 ${row.businessDate} 的日活值不是有效的非负整数，首批查询不会修正或取整`,
          502,
          { businessDate: row.businessDate, pid: query.pid }
        );
      }
      if (indexed.has(row.businessDate)) {
        throw new V2MetricQueryError(
          "V2_METRIC_SOURCE_CONFLICT",
          `上游返回多个 ${row.businessDate} 的 ${query.pid} 日活结果，首批查询不会擅自合并`,
          502,
          { businessDate: row.businessDate, pid: query.pid }
        );
      }
      indexed.set(row.businessDate, row);
    }

    const points = expectedDates.flatMap((businessDate) => {
      const row = indexed.get(businessDate);
      return row?.value === null || row?.value === undefined
        ? []
        : [{ businessDate, value: row.value, state: "available" as const }];
    });
    const unavailableDates: V2UnavailableDate[] = [];
    for (const businessDate of expectedDates) {
      const row = indexed.get(businessDate);
      if (!row) unavailableDates.push({ businessDate, state: "no_record" });
      else if (row.value === null) unavailableDates.push({ businessDate, state: "no_value" });
    }
    if (unavailableDates.length > 0) {
      warnings.push(`${unavailableDates.length} 个业务日没有可用值；未使用 0 补齐。`);
    }

    const seriesStatus = points.length === 0
      ? indexed.size > 0 ? "no_values" : "no_records"
      : unavailableDates.length > 0
        ? "partial"
        : "available";

    return {
      success: true,
      data: {
        metric,
        scope: { pid: query.pid, platformName: platform.name },
        grain: "day",
        dateRange: query.dateRange,
        seriesStatus,
        points,
        unavailableDates
      },
      meta: {
        queryId: randomUUID(),
        sourceApiIds: [P_DAY_SUM_API],
        fetchedAt: new Date().toISOString(),
        validationStatus: "pending_validation",
        watermark: null,
        warnings
      }
    };
  }
}
