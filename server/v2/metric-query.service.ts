import { randomUUID } from "node:crypto";
import {
  v2MetricWatermarkSchema,
  type MetricCatalogItem,
  type V2MetricQuery,
  type V2MetricQuerySuccess,
  type V2MetricWatermark,
  type V2UnavailableDate
} from "../../contracts/bi-v2";
import { getPlatformByPid } from "../platforms/registry";
import { P_DAY_SUM_API } from "../upstream/overview.adapter";
import { getV2Metric } from "./catalog";
import {
  M016_MAPPING_VERSION,
  M016_QUERY_MAPPING_EXECUTABLE,
  M016_QUERY_VALIDATION_STATUS
} from "./metric-definitions";
import { M016SourceDataError, type M016Source, type M016SourceRow } from "./m016-source";
import {
  metricWatermarkSourceRegistry,
  type MetricWatermarkSourceRegistry
} from "./metric-watermark-source-registry";

export class V2MetricQueryError extends Error {
  constructor(
    public readonly code: "METRIC_NOT_READY" | "UNSUPPORTED_V2_METRIC_QUERY" | "V2_METRIC_SOURCE_CONFLICT",
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
  constructor(
    private readonly m016Source: M016Source,
    private readonly validationStatus: "pending_validation" | "passed" | null = M016_QUERY_VALIDATION_STATUS,
    private readonly metricResolver: (metricId: string) => MetricCatalogItem | undefined = getV2Metric,
    private readonly watermarkSources: MetricWatermarkSourceRegistry = metricWatermarkSourceRegistry,
    private readonly queryMapping: Readonly<{ executable: boolean; version: string | null }> = {
      executable: M016_QUERY_MAPPING_EXECUTABLE,
      version: M016_MAPPING_VERSION
    }
  ) {}

  async execute(query: V2MetricQuery): Promise<V2MetricQuerySuccess> {
    const metric = this.metricResolver(query.metricId);
    const platform = getPlatformByPid(query.pid);
    if (
      !metric
      || !this.queryMapping.executable
      || !this.queryMapping.version
      || !this.validationStatus
      || query.grain !== "day"
      || !platform?.enabled
    ) {
      throw new V2MetricQueryError(
        "UNSUPPORTED_V2_METRIC_QUERY",
        "所选指标或业务 PID 尚未进入首批只读查询范围",
        422
      );
    }
    if (metric.authority.validationStatus !== this.validationStatus) {
      throw new V2MetricQueryError(
        "V2_METRIC_SOURCE_CONFLICT",
        "指标目录与查询服务的验数状态不一致，查询已停止",
        502,
        { reason: "validation_status_conflict" }
      );
    }

    let rows: M016SourceRow[];
    let watermark: V2MetricWatermark | null;
    try {
      ({ rows, watermark } = await this.m016Source.queryDailyActiveUsers({ pid: query.pid, dateRange: query.dateRange }));
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
    const fetchedAt = new Date().toISOString();
    if (watermark !== null) {
      const parsedWatermark = v2MetricWatermarkSchema.safeParse(watermark);
      if (!parsedWatermark.success) {
        throw new V2MetricQueryError(
          "V2_METRIC_SOURCE_CONFLICT",
          "M016 数据源返回了不可信的数据水位，查询已停止",
          502,
          { reason: "invalid_watermark" }
        );
      }
      watermark = parsedWatermark.data;
      if (watermark.pid !== query.pid) {
        throw new V2MetricQueryError(
          "V2_METRIC_SOURCE_CONFLICT",
          "M016 数据水位与本次接口查询范围不一致，查询已停止",
          502,
          { reason: "watermark_scope_conflict" }
        );
      }
      if (!this.watermarkSources.has({
        metricId: query.metricId,
        sourceKind: watermark.sourceKind,
        sourceApiId: watermark.sourceApiId
      })) {
        throw new V2MetricQueryError(
          "V2_METRIC_SOURCE_CONFLICT",
          "M016 数据水位来源尚未登记，查询已停止",
          502,
          { reason: "unregistered_watermark_source" }
        );
      }
      if (Date.parse(watermark.observedAt) > Date.parse(fetchedAt) + 300_000) {
        throw new V2MetricQueryError(
          "V2_METRIC_SOURCE_CONFLICT",
          "M016 数据水位的取证时间明显晚于本次查询，查询已停止",
          502,
          { reason: "watermark_observed_in_future" }
        );
      }
      if (query.dateRange[1] > watermark.completeThrough) {
        throw new V2MetricQueryError(
          "METRIC_NOT_READY",
          `M016 数据仅完整至 ${watermark.completeThrough}，所选结束日尚未就绪`,
          422
        );
      }
    }
    if (this.validationStatus === "passed" && watermark === null) {
      throw new V2MetricQueryError(
        "METRIC_NOT_READY",
        "M016 尚无可信数据水位，正式指标分析暂未开放",
        422
      );
    }
    const warnings: string[] = [];
    if (watermark === null) warnings.push("上游尚未提供正式数据水位，当前响应不推断成熟日期。");
    if (this.validationStatus !== "passed") {
      warnings.unshift("M016 当前为“技术称已实现（待验数）”，结果不能标记为已验数。");
    }
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
        sourceApiIds: [...new Set([
          P_DAY_SUM_API,
          ...(watermark ? [watermark.sourceApiId] : [])
        ])],
        fetchedAt,
        mappingVersion: this.queryMapping.version,
        validationStatus: this.validationStatus,
        watermark,
        warnings
      }
    };
  }
}
