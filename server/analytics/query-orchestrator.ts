import { randomUUID } from "node:crypto";
import type { AnalyticsQuery, AnalyticsResponse } from "../../contracts/analytics";
import { UpstreamError } from "../upstream/client";
import { OverviewAdapter, P_DAY_SUM_API, type OverviewRow } from "../upstream/overview.adapter";
import { EventAdapter, EVENT_STATS_API } from "../upstream/event.adapter";
import { HOT_SEARCH_API, SearchAdapter } from "../upstream/search.adapter";
import { VideoAdapter, VIDEO_RANKING_API } from "../upstream/video.adapter";
import { RealtimeAdapter, REALTIME_API } from "../upstream/realtime.adapter";
import { RetentionAdapter, RETENTION_PLUS_API } from "../upstream/retention.adapter";
import { AcquisitionAdapter } from "../upstream/acquisition.adapter";
import { aggregateMetric } from "./aggregate";
import { validateAnalyticsQuery } from "./capability-validator";
import { getPlatformByPid } from "../platforms/registry";
import { metrics } from "./registry";

const supportedOverviewMetrics = new Set([
  "dau", "dauUserDays", "newUsers", "viewerCount", "viewerUserDays", "payerCount", "payerUserDays", "revenue", "androidDau", "androidDauUserDays", "iosDau", "iosDauUserDays",
  "androidNewUsers", "iosNewUsers", "organicNewUsers", "internalNewUsers", "adClickCount",
  "adClickUsers", "adClickUserDays", "newAdClickCount", "newAdClickUsers", "newRevenue", "newPayerCount",
  "oldUsers", "oldAdClickCount", "oldAdClickUsers", "oldAdClickUserDays", "oldRevenue", "oldPayerCount", "oldPayerUserDays",
  "channelNewRevenue", "internalNewRevenue"
]);

function sourceMetricIds(metricIds: string[]): string[] {
  const result = new Set<string>();
  const add = (metricId: string) => {
    const metric = metrics[metricId];
    if (metric?.aggregation === "weightedRatio") {
      if (metric.numeratorMetricId) add(metric.numeratorMetricId);
      if (metric.denominatorMetricId) add(metric.denominatorMetricId);
      return;
    }
    result.add(metricId);
  };
  metricIds.forEach(add);
  return [...result];
}

export class QueryOrchestrator {
  constructor(
    private readonly overview: OverviewAdapter,
    private readonly events: EventAdapter,
    private readonly search: SearchAdapter,
    private readonly video: VideoAdapter,
    private readonly realtime: RealtimeAdapter,
    private readonly retention: RetentionAdapter,
    private readonly acquisition: AcquisitionAdapter,
    private readonly maxConcurrency: number
  ) {}

  private async queryPlatforms<T>(platformIds: string[], query: (platformId: string) => Promise<T[]>): Promise<{ rows: T[]; failedPlatforms: Array<{ platformId: string; errorCode: string }> }> {
    const rows: T[] = [];
    const failedPlatforms: Array<{ platformId: string; errorCode: string }> = [];
    for (let index = 0; index < platformIds.length; index += this.maxConcurrency) {
      const batch = platformIds.slice(index, index + this.maxConcurrency);
      const settled = await Promise.allSettled(batch.map(query));
      settled.forEach((result, resultIndex) => {
        if (result.status === "fulfilled") rows.push(...result.value);
        else failedPlatforms.push({ platformId: batch[resultIndex], errorCode: result.reason instanceof UpstreamError ? result.reason.code : "ADAPTER_FAILED" });
      });
    }
    if (!rows.length && failedPlatforms.length) throw new UpstreamError("ALL_PLATFORMS_FAILED", "所选平台查询全部失败");
    return { rows, failedPlatforms };
  }

  async execute(query: AnalyticsQuery): Promise<AnalyticsResponse> {
    const validation = validateAnalyticsQuery(query);
    if (!validation.valid) throw new QueryValidationError(validation.issues);
    if (query.analysisType === "funnel") return this.executeFunnel(query);
    if (query.modelId === "search_demand") return this.executeSearch(query);
    if (query.modelId === "content_position") return this.executeVideo(query);
    if (query.modelId === "usage_depth") return this.executeRealtime(query);
    if (query.modelId === "retention_quality") return this.executeRetention(query);
    if (query.modelId === "acquisition_conversion") return this.executeAcquisition(query);
    const unsupported = sourceMetricIds(query.metricIds).filter((id) => !supportedOverviewMetrics.has(id));
    if (unsupported.length) throw new QueryValidationError(unsupported.map((id) => `真实查询 Adapter 尚未接入指标：${id}`));

    const rows: OverviewRow[] = [];
    const failedPlatforms: Array<{ platformId: string; errorCode: string }> = [];
    for (let index = 0; index < query.platformIds.length; index += this.maxConcurrency) {
      const batch = query.platformIds.slice(index, index + this.maxConcurrency);
      const settled = await Promise.allSettled(batch.map((platformId) => this.overview.queryDaySum(query, platformId)));
      settled.forEach((result, resultIndex) => {
        if (result.status === "fulfilled") rows.push(...result.value);
        else failedPlatforms.push({
          platformId: batch[resultIndex],
          errorCode: result.reason instanceof UpstreamError ? result.reason.code : "ADAPTER_FAILED"
        });
      });
    }

    if (!rows.length && failedPlatforms.length) throw new UpstreamError("ALL_PLATFORMS_FAILED", "所选平台查询全部失败");
    const returnedPlatforms = new Set(rows.map((row) => row.platform));
    const noDataPlatforms = query.platformIds
      .map((pid) => getPlatformByPid(pid)?.name ?? pid)
      .filter((name) => !returnedPlatforms.has(name));
    const outputRows = this.buildRows(query, rows);
    const summary = Object.fromEntries(query.metricIds.map((metricId) => [metricId, aggregateMetric(metricId, rows)]));
    return {
      data: {
        columns: [
          ...query.dimensionIds.map((id) => ({ id, name: id === "date" ? "日期" : "平台", type: id === "date" ? "date" as const : "string" as const })),
          ...query.metricIds.map((id) => ({ id, name: id, type: "number" as const }))
        ],
        rows: outputRows,
        summary
      },
      meta: {
        queryId: randomUUID(),
        grain: query.dimensionIds.length ? query.dimensionIds.join(" × ") : "汇总",
        sourceApiIds: [P_DAY_SUM_API],
        fetchedAt: new Date().toISOString(),
        cacheHit: false,
        partial: failedPlatforms.length > 0,
        failedPlatforms,
        warnings: noDataPlatforms.length ? [`当前日期范围无数据平台：${noDataPlatforms.join("、")}`] : []
      }
    };
  }

  private async executeFunnel(query: AnalyticsQuery): Promise<AnalyticsResponse> {
    const queried = await this.queryPlatforms(query.platformIds, (platformId) => this.events.queryFunnel(query, platformId));
    const totals = query.eventIds.map((eventId) => {
      const matching = queried.rows.filter((row) => row.eventId === eventId);
      return { eventId, name: matching[0]?.name ?? eventId, value: matching.reduce((sum, row) => sum + row.value, 0) };
    });
    const first = totals[0]?.value ?? 0;
    const rows = totals.map((item, index) => {
      const previous = totals[index - 1]?.value ?? item.value;
      return { ...item, conversion: first ? item.value / first : 0, stepConversion: previous ? item.value / previous : 0, dropoff: Math.max(0, previous - item.value) };
    });
    return {
      data: {
        columns: [
          { id: "name", name: "步骤", type: "string" },
          { id: "value", name: "人数", type: "number" },
          { id: "conversion", name: "总转化率", type: "number" },
          { id: "stepConversion", name: "步骤转化率", type: "number" }
        ],
        rows: rows.map((row) => ({ eventId: row.eventId, name: row.name, value: row.value, conversion: row.conversion, stepConversion: row.stepConversion, dropoff: row.dropoff })),
        summary: { firstStep: rows[0]?.value ?? 0, finalStep: rows.at(-1)?.value ?? 0, totalConversion: rows.at(-1)?.conversion ?? 0 }
      },
      meta: { queryId: randomUUID(), grain: `${query.platformIds.length}个平台 × 日期区间汇总`, sourceApiIds: [EVENT_STATS_API], fetchedAt: new Date().toISOString(), cacheHit: false, partial: queried.failedPlatforms.length > 0, failedPlatforms: queried.failedPlatforms, warnings: ["当前为事件汇总漏斗，不代表用户级有序转化", ...(queried.failedPlatforms.length ? [`${queried.failedPlatforms.length} 个平台查询失败`] : [])] }
    };
  }

  private async executeSearch(query: AnalyticsQuery): Promise<AnalyticsResponse> {
    const queried = await this.queryPlatforms(query.platformIds, (platformId) => this.search.queryRanking(platformId, query.limit));
    const rows = [...queried.rows].sort((a, b) => b.searchCount - a.searchCount).slice(0, query.limit);
    return {
      data: {
        columns: [
          { id: "keyword", name: "搜索词", type: "string" },
          { id: "platform", name: "平台", type: "string" },
          { id: "searchCount", name: "搜索次数", type: "number" }
        ],
        rows: rows.map((row) => ({ platform: row.platform, keyword: row.keyword, searchCount: row.searchCount })),
        summary: { searchCount: rows.reduce((sum, row) => sum + row.searchCount, 0) }
      },
      meta: { queryId: randomUUID(), grain: "平台 × 搜索词", sourceApiIds: [HOT_SEARCH_API], fetchedAt: new Date().toISOString(), cacheHit: false, partial: queried.failedPlatforms.length > 0, failedPlatforms: queried.failedPlatforms, warnings: ["热搜词接口不支持日期筛选，顶部日期不会改变此卡片", ...(queried.failedPlatforms.length ? [`${queried.failedPlatforms.length} 个平台查询失败`] : [])] }
    };
  }

  private async executeVideo(query: AnalyticsQuery): Promise<AnalyticsResponse> {
    const rows = await this.video.queryMany(query, query.platformIds);
    const failedPlatforms: Array<{ platformId: string; errorCode: string }> = [];
    const metricIds = query.metricIds;
    const summary: Record<string, number | null> = Object.fromEntries(metricIds.map((id) => [id, rows.reduce((sum, row) => sum + Number(Reflect.get(row, id) ?? 0), 0)]));
    const sorted = [...rows].sort((a, b) => Number(Reflect.get(b, metricIds[0] ?? "videoWatchCount")) - Number(Reflect.get(a, metricIds[0] ?? "videoWatchCount"))).slice(0, query.limit);
    const outputRows = sorted.map((row) => Object.fromEntries([
      ...query.dimensionIds.map((id) => [id, Reflect.get(row, id)]),
      ...metricIds.map((id) => [id, Reflect.get(row, id)])
    ]));
    return {
      data: {
        columns: [
          { id: "content", name: "视频", type: "string" }, { id: "category", name: "分类", type: "string" },
          ...metricIds.map((id) => ({ id, name: metrics[id]?.name ?? id, type: "number" as const }))
        ],
        rows: outputRows, summary
      },
      meta: { queryId: randomUUID(), grain: "平台 × 视频 × 日期区间", sourceApiIds: [VIDEO_RANKING_API], fetchedAt: new Date().toISOString(), cacheHit: false, partial: false, failedPlatforms, warnings: rows.length ? [] : ["当前平台和日期范围无视频统计数据"] }
    };
  }

  private async executeRealtime(query: AnalyticsQuery): Promise<AnalyticsResponse> {
    const queried = await this.queryPlatforms(query.platformIds, (platformId) => this.realtime.query(query, platformId));
    const rows = queried.rows;
    const summary: Record<string, number | null> = {};
    for (const id of query.metricIds) {
      const values = rows.map((row) => Reflect.get(row, id)).filter((value): value is number => typeof value === "number");
      summary[id] = values.length ? values.at(-1)! : null;
    }
    return {
      data: {
        columns: [{ id: "date", name: "时间", type: "date" }, ...query.metricIds.map((id) => ({ id, name: metrics[id]?.name ?? id, type: "number" as const }))],
        rows: rows.map((row) => ({ ...row })), summary
      },
      meta: { queryId: randomUUID(), grain: "平台 × 实时时点", sourceApiIds: [REALTIME_API], fetchedAt: new Date().toISOString(), cacheHit: false, partial: queried.failedPlatforms.length > 0, failedPlatforms: queried.failedPlatforms, warnings: ["人均观影时长按 totalUserWatchTime / watchUserCount / 60 计算", ...(queried.failedPlatforms.length ? [`${queried.failedPlatforms.length} 个平台查询失败`] : [])] }
    };
  }

  private async executeRetention(query: AnalyticsQuery): Promise<AnalyticsResponse> {
    const queried = await this.queryPlatforms(query.platformIds, (platformId) => this.retention.query(query, platformId));
    const rows = queried.rows;
    const newUsers = rows.reduce((sum, row) => sum + row.newUsers, 0);
    const retentionMetrics = [
      ["retentionD1", "retainedUsers"], ["retentionD3", "retainedUsersD3"], ["retentionD7", "retainedUsersD7"], ["retentionD30", "retainedUsersD30"]
    ] as const;
    const summary = Object.fromEntries(retentionMetrics.map(([metric, numerator]) => {
      const eligible = rows.filter((row) => row[numerator] !== null);
      const denominator = eligible.reduce((sum, row) => sum + row.newUsers, 0);
      const retained = eligible.reduce((sum, row) => sum + Number(row[numerator] ?? 0), 0);
      return [metric, denominator ? retained / denominator : null];
    }));
    return {
      data: { columns: [{ id: "date", name: "注册日期", type: "date" }, { id: "newUsers", name: "新增用户", type: "number" }, ...retentionMetrics.map(([id]) => ({ id, name: metrics[id]?.name ?? id, type: "number" as const }))], rows: rows.map((row) => ({ ...row })), summary: { newUsers, ...summary } },
      meta: { queryId: randomUUID(), grain: "平台 × 注册日期 cohort", sourceApiIds: [RETENTION_PLUS_API], fetchedAt: new Date().toISOString(), cacheHit: false, partial: queried.failedPlatforms.length > 0, failedPlatforms: queried.failedPlatforms, warnings: [...(rows.length ? ["D1/D3/D7/D30 均按可观察 cohort 的 sum(loginCnt) / sum(registerCount) 加权"] : ["当前注册日期范围无留存数据"]), ...(queried.failedPlatforms.length ? [`${queried.failedPlatforms.length} 个平台查询失败`] : [])] }
    };
  }

  private async executeAcquisition(query: AnalyticsQuery): Promise<AnalyticsResponse> {
    const queried = await this.queryPlatforms(query.platformIds, (platformId) => this.acquisition.query(query, platformId));
    const rows = queried.rows;
    const outputRows = this.buildRows(query, rows);
    const summary = Object.fromEntries(query.metricIds.map((metricId) => [metricId, aggregateMetric(metricId, rows)]));
    const incomparable = rows.some((row) => row.newUsers > row.downloads);
    return {
      data: {
        columns: [
          ...query.dimensionIds.map((id) => ({ id, name: id === "date" ? "日期" : "平台", type: id === "date" ? "date" as const : "string" as const })),
          ...query.metricIds.map((id) => ({ id, name: metrics[id]?.name ?? id, type: "number" as const }))
        ],
        rows: outputRows,
        summary
      },
      meta: {
        queryId: randomUUID(),
        grain: query.dimensionIds.length ? query.dimensionIds.join(" × ") : "汇总",
        sourceApiIds: ["/api/admin/statistics/cpGuardStat/cnzzstatQuery", P_DAY_SUM_API],
        fetchedAt: new Date().toISOString(),
        cacheHit: false,
        partial: queried.failedPlatforms.length > 0,
        failedPlatforms: queried.failedPlatforms,
        warnings: [
          "转化率按区间合计分子 / 区间合计分母计算，不平均每日百分比",
          ...(incomparable ? ["部分日期注册数高于下载数：下载与注册统计对象不同，结果标记为口径不可比，不作为严格用户漏斗"] : []),
          ...(!rows.length ? ["当前日期范围暂无访问下载记录，未用 0 代替"] : [])
        ]
      }
    };
  }

  private buildRows<T extends object & { date: string; platform: string }>(query: AnalyticsQuery, rows: T[]) {
    const dimensions = query.dimensionIds;
    if (!dimensions.length) return [{ ...Object.fromEntries(query.metricIds.map((id) => [id, aggregateMetric(id, rows)])) }];
    const groups = new Map<string, T[]>();
    rows.forEach((row) => {
      const key = dimensions.map((id) => row[id as "date" | "platform"]).join("\u0000");
      groups.set(key, [...(groups.get(key) ?? []), row]);
    });
    return [...groups.values()].map((group) => ({
      ...Object.fromEntries(dimensions.map((id) => [id, group[0][id as "date" | "platform"]])),
      ...Object.fromEntries(query.metricIds.map((id) => [id, aggregateMetric(id, group)]))
    }));
  }
}

export class QueryValidationError extends Error {
  constructor(public readonly issues: string[]) { super("查询配置不受支持"); }
}
