import type { AnalyticsQuery, AnalyticsResponse } from "../../contracts/analytics";
import type { NewavAdapter } from "./adapter";

type Row = Record<string, string | number | null>;
const number = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
const nullableNumber = (value: unknown) => value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
const ratio = (numerator: unknown, denominator: unknown) => number(denominator) ? number(numerator) / number(denominator) : null;
const sumInternal = (rows: Row[], key: string) => rows.reduce((sum, row) => sum + (typeof row[key] === "number" ? row[key] : 0), 0);
const weightedRatio = (rows: Row[], numerator: string, denominator: string) => {
  const denominatorTotal = sumInternal(rows, denominator);
  return denominatorTotal ? sumInternal(rows, numerator) / denominatorTotal : null;
};
const stripInternal = (row: Row): Row => Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith("__")));

export function periodRow(row: Record<string, unknown>): Row {
  const active = number(row.activeNew) + number(row.activeOld);
  const plays = number(row.playOk) + number(row.playErr);
  return {
    platform: "NewAV", date: String(row.date ?? ""), dau: active, dauUserDays: active,
    newUsers: number(row.registNew), viewerCount: number(row.viewers), viewerUserDays: number(row.viewers),
    visits: number(row.ipTotal), visitRegisterRate: ratio(row.registNew, row.ipUniq),
    revenue: number(row.rechargeTotal), newRevenue: number(row.rechargeNew), payerCount: number(row.cardBuy),
    payRate: null, adClickCount: number(row.adClicks), adClickUsers: nullableNumber(row.adClickUsers),
    pageClicks: number(row.playErr), videoWatchCount: number(row.playOk), playRate: ratio(row.playOk, plays),
    androidDau: number(row.androidUv), iosDau: number(row.iosUv), pageViews: number(row.pcUv),
    retentionD1: row.retentionD1 == null ? null : number(row.retentionD1) / 100,
    retentionD3: row.retentionD3 == null ? null : number(row.retentionD3) / 100,
    retentionD7: row.retentionD7 == null ? null : number(row.retentionD7) / 100,
    retentionD30: null,
    __registNew: number(row.registNew), __ipUniq: number(row.ipUniq), __playOk: number(row.playOk), __plays: plays
  };
}

export function channelRow(row: Record<string, unknown>): Row {
  return {
    platform: "NewAV", date: String(row.date ?? ""), channel: String(row.channelName ?? row.channelCode ?? "未知渠道"),
    dau: number(row.activeUsers), dauUserDays: number(row.activeUsers), newUsers: number(row.newUsers),
    viewerCount: number(row.viewers), viewerUserDays: number(row.viewers), visits: number(row.visitors),
    visitRegisterRate: ratio(row.newUsers, row.visitors), newRevenue: number(row.newRevenue),
    payerCount: number(row.vipBuyers), payRate: ratio(row.vipBuyers, row.newUsers),
    adClickCount: number(row.adClicks), adClickUsers: nullableNumber(row.adClickUsers),
    __registNew: number(row.newUsers), __visitors: number(row.visitors), __vipBuyers: number(row.vipBuyers)
  };
}

export function adRow(row: Record<string, unknown>): Row {
  return {
    platform: "NewAV", position: String(row.slot ?? "未知广告位"), content: String(row.title ?? `广告 ${row.adId ?? ""}`),
    pageViews: number(row.shows), adClickCount: number(row.clicks), adClickUsers: number(row.clickUsers),
    adClickRate: row.ctr == null ? ratio(row.clicks, row.shows) : number(row.ctr) / 100,
    __clicks: number(row.clicks), __shows: number(row.shows)
  };
}

function aggregate(rows: Row[], metric: string): number | null {
  const values = rows.map((row) => row[metric]).filter((value): value is number => typeof value === "number");
  if (!values.length) return null;
  if (["dau", "viewerCount", "androidDau", "iosDau"].includes(metric)) {
    const dates = new Set(rows.map((row) => row.date).filter(Boolean));
    return values.reduce((sum, value) => sum + value, 0) / Math.max(1, dates.size);
  }
  if (metric === "visitRegisterRate") return weightedRatio(rows, "__registNew", rows.some((row) => "__visitors" in row) ? "__visitors" : "__ipUniq");
  if (metric === "playRate") return weightedRatio(rows, "__playOk", "__plays");
  if (metric === "adClickRate") return weightedRatio(rows, "__clicks", "__shows");
  if (metric === "payRate") return rows.some((row) => "__vipBuyers" in row) ? weightedRatio(rows, "__vipBuyers", "__registNew") : null;
  if (["retentionD1", "retentionD3", "retentionD7", "retentionD30"].includes(metric)) {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }
  if (metric === "revenue") {
    const latest = rows
      .filter((row) => typeof row.revenue === "number")
      .sort((left, right) => String(right.date ?? "").localeCompare(String(left.date ?? "")))[0];
    return typeof latest?.revenue === "number" ? latest.revenue : null;
  }
  return values.reduce((sum, value) => sum + value, 0);
}

function funnelRows(modelId: string, summary: Record<string, number | null>, eventIds: string[]) {
  const content = [
    ["active_user", "访问用户", number(summary.ipUniq)], ["video_click", "观影用户", number(summary.viewers)],
    ["video_play", "有效登录", number(summary.validLogin)], ["video_play_end", "会员购买", number(summary.cardBuy)]
  ] as const;
  const payment = [
    ["vip_click", "新增注册", number(summary.registNew)], ["pre_pay", "有效登录", number(summary.validLogin)],
    ["success_pay", "会员购买", number(summary.cardBuy)]
  ] as const;
  const selected = (modelId === "payment_conversion" ? payment : content).filter(([id]) => !eventIds.length || eventIds.includes(id));
  const first = selected[0]?.[2] ?? 0;
  return selected.map(([eventId, name, value], index) => {
    const previous = selected[index - 1]?.[2] ?? value;
    return { eventId, name, value, conversion: first ? value / first : 0, stepConversion: previous ? value / previous : 0, dropoff: Math.max(0, previous - value) };
  });
}

export class NewavBiAdapter {
  private readonly pending = new Map<string, Promise<Awaited<ReturnType<NewavAdapter["query"]>>>>();

  constructor(private readonly adapter: NewavAdapter) {}

  private queryShared(datasetId: "period" | "channelDaily" | "adStats" | "overview", dateRange: [string, string]) {
    const key = `${datasetId}:${dateRange.join(":")}`;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const request = this.adapter.query({ datasetId, dateRange }).finally(() => this.pending.delete(key));
    this.pending.set(key, request);
    return request;
  }

  async query(query: AnalyticsQuery): Promise<AnalyticsResponse> {
    const useAds = query.dimensionIds.includes("position") || query.dimensionIds.includes("content") || query.metricIds.includes("adClickRate") || query.metricIds.includes("pageViews");
    const useChannels = query.dimensionIds.includes("channel");
    const useOverview = query.metricIds.some((metric) => ["currentPaidMembers", "historicalPaidMembers"].includes(metric));
    const needsPeriod = query.analysisType === "funnel" || (!useChannels && !useAds);
    const period = needsPeriod ? await this.queryShared("period", query.dateRange) : null;
    const periodRows = period?.rows.map((row) => periodRow(row as unknown as Record<string, unknown>)) ?? [];
    let rows = periodRows;
    const warnings = [...(period?.warnings ?? [])];

    if (useChannels) {
      const channel = await this.queryShared("channelDaily", query.dateRange);
      rows = channel.rows.map((row) => channelRow(row as unknown as Record<string, unknown>));
      warnings.push(...channel.warnings);
    } else if (useAds) {
      const ads = await this.queryShared("adStats", query.dateRange);
      rows = ads.rows.map((row) => adRow(row as unknown as Record<string, unknown>));
      warnings.push(...ads.warnings);
    }

    const summary = Object.fromEntries(query.metricIds.map((metric) => [metric, aggregate(rows, metric)]));
    if (useOverview) {
      const overview = await this.queryShared("overview", query.dateRange);
      const overviewSummary = overview.summary as Record<string, number | null>;
      summary.currentPaidMembers = number(overviewSummary.activeVips);
      summary.historicalPaidMembers = number(overviewSummary.orders);
    }
    if (query.analysisType === "funnel" && period) rows = funnelRows(query.modelId, period.summary, query.eventIds);

    const sourceApiIds = useChannels ? ["/api/v1/admin/analytics/channels-daily"] : useAds ? ["/api/v1/admin/analytics/ad-stats"] : ["/api/v1/admin/analytics/period"];
    return {
      data: { columns: [], rows: rows.map(stripInternal), summary },
      meta: { queryId: crypto.randomUUID(), grain: useChannels ? "渠道 × 自然日" : useAds ? "广告位 × 素材" : "NewAV × 自然日", sourceApiIds, fetchedAt: new Date().toISOString(), cacheHit: false, partial: false, failedPlatforms: [], warnings }
    };
  }
}
