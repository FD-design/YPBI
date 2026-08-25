import { useEffect, useMemo, useState } from "react";
import type { DashboardCardConfig, MetricId } from "../types";
import { formatMetric, METRIC_META, resolveComparisonDateRange, resolveDashboardDateRange, type CardQueryResult, type DashboardFilters } from "./mockEngine";

interface BiResponse {
  success: boolean;
  data?: {
    data: { rows: Array<Record<string, string | number | null>>; summary?: Record<string, number | null> };
    meta: { fetchedAt: string; partial: boolean; failedPlatforms: Array<{ platformId: string; errorCode: string }>; warnings: string[] };
  };
  error?: { code: string; message: string; details?: string[] };
}

const platformIds: Record<string, string> = { NewAV: "newav" };
const overviewMetrics = new Set<MetricId>(["dau", "newUsers", "payerCount", "revenue", "viewRate", "payRate", "arpu", "arppu", "androidDau", "iosDau", "androidNewUsers", "iosNewUsers", "organicNewUsers", "internalNewUsers", "adClickCount", "adClickUsers", "adClickRate", "adClickUserRate", "newAdClickCount", "newAdClickUsers", "newAdClickRate", "newAdClickUserRate", "newRevenue", "newPayerCount", "newPayRate", "newArpu", "newArppu", "channelNewRevenue", "internalNewRevenue"]);
const acquisitionMetrics = new Set<MetricId>(["visits", "downloads", "newUsers", "visitDownloadRate", "downloadRegisterRate", "visitRegisterRate"]);
const supportedMetrics = new Set<MetricId>([...overviewMetrics, "searchCount", "videoWatchCount", "videoViewerCount", "videoLikeCount", "videoCollectCount", "avgWatchMinutes"]);

function resolvePlatforms(filters: DashboardFilters): string[] | null {
  const names = filters.mode === "all" ? Object.keys(platformIds) : filters.platforms;
  const ids = names.map((name) => platformIds[name]).filter(Boolean);
  return ids.length === names.length && ids.length > 0 ? ids : null;
}

function canUseRealData(card: DashboardCardConfig, filters: DashboardFilters) {
  return resolvePlatforms(filters) !== null;
}

function toDisplayValue(metric: MetricId, value: number | null | undefined) {
  if (value === null || value === undefined) return 0;
  return METRIC_META[metric].unit === "percent" ? value * 100 : value;
}

function expectedPlatformNames(filters: DashboardFilters) {
  return filters.mode === "all" ? Object.keys(platformIds) : filters.platforms;
}

function zeroPlatformInsight(platformNames: string[], availableNames: Set<string>) {
  const missing = platformNames.filter((name) => !availableNames.has(name));
  return missing.length
    ? `数据覆盖：${availableNames.size}/${platformNames.length} 个平台返回记录，${missing.length} 个平台暂无记录；图中的占位 0 不代表真实业务值为 0。`
    : `数据覆盖：${platformNames.length}/${platformNames.length} 个平台均返回记录；接口明确返回的 0 才视为真实 0。`;
}

const dimensionLabels: Record<string, string> = {
  platform: "平台",
  date: "日期",
  content: "视频名称",
  category: "内容分类",
  keyword: "搜索词",
  page: "页面",
  position: "位置",
  positionRank: "坑位排名",
  paymentChannel: "支付通道",
  memberPlan: "会员档位",
  memberStatus: "会员状态",
  result: "结果",
  appVersion: "应用版本"
};

function displayColumnName(key: string) {
  return dimensionLabels[key] ?? METRIC_META[key as MetricId]?.name ?? key;
}

export function translateTableRow(row: Record<string, string | number | null>) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [displayColumnName(key), value ?? "--"])) as Record<string, string | number>;
}

export function transformRealResult(card: DashboardCardConfig, response: NonNullable<BiResponse["data"]>, filters: DashboardFilters): CardQueryResult {
  const rows = [...response.data.rows].sort((left, right) => {
    if (!left.date || !right.date) return 0;
    return String(left.date).localeCompare(String(right.date));
  });
  const scopeLabel = "真实数据 · NewAV 独立产品";
  if (card.type === "funnel" || card.type === "sankey") {
    const rawFunnel = rows.map((row) => ({
      eventId: String(row.eventId),
      name: String(row.name),
      value: Number(row.value ?? 0),
      conversion: Number((Number(row.conversion ?? 0) * 100).toFixed(2)),
      stepConversion: Number((Number(row.stepConversion ?? 0) * 100).toFixed(2)),
      dropoff: Number(row.dropoff ?? 0)
    }));
    const funnelComparable = rawFunnel.every((row, index) => index === 0 || row.value <= rawFunnel[index - 1].value);
    const funnel = funnelComparable ? rawFunnel : rawFunnel.map((row) => ({ ...row, conversion: 0, stepConversion: 0, dropoff: 0 }));
    if (card.type === "sankey") {
      return {
        scopeLabel,
        categories: funnel.map((row) => row.name),
        series: [],
        summary: [],
        sankey: {
          nodes: funnel.map((row) => ({ name: row.name })),
          links: funnel.slice(1).map((row, index) => ({ source: funnel[index].name, target: row.name, value: row.value }))
        },
        table: funnel.map((row) => ({ 步骤: row.name, 汇总次数: row.value })),
        insights: ["该图由各事件阶段汇总量连接生成，仅用于观察阶段损耗，非用户级路径。", funnel.length > 1 ? `最终阶段占首阶段 ${funnel.at(-1)?.conversion ?? 0}%。` : "当前阶段数据不足，暂不计算转化。"]
      };
    }
    return {
      scopeLabel, categories: funnel.map((row) => row.name), series: [], summary: [], funnel,
      table: funnel.map((row) => ({ 步骤: row.name, 事件量: row.value, 总转化率: funnelComparable ? `${row.conversion}%` : "—", 步骤转化率: funnelComparable ? `${row.stepConversion}%` : "—" })),
      insights: !funnelComparable ? ["事件汇总不满足漏斗单调关系，当前不计算转化率。", "各步骤来自独立事件计数，不能证明是同一批用户依次完成。"] : funnel.length > 1 ? [`最终阶段总转化率为 ${funnel.at(-1)?.conversion ?? 0}%。`, `主要损耗发生在人数下降最多的相邻阶段。`] : ["当前阶段数据不足，暂不计算转化。"]
    };
  }
  if (card.type === "cohort") {
    const retentionMetrics = ["retentionD1", "retentionD3", "retentionD7", "retentionD30"] as const;
    const retentionLabels = ["D1", "D3", "D7", "D30"];
    const dates = [...new Set(rows.map((row) => String(row.date)))];
    const cohortPlatforms = card.dimensions.includes("platform") ? expectedPlatformNames(filters) : [...new Set(rows.map((row) => String(row.platform ?? filters.platforms[0] ?? "平台")))];
    const cohortRows = cohortPlatforms.flatMap((platform) => dates.map((date) => ({ row: rows.find((item) => String(item.platform ?? platform) === platform && String(item.date) === date) ?? { platform, date }, label: `${platform} · ${date}` })));
    const values = cohortRows.flatMap(({ row }, y) => retentionMetrics.flatMap((metric, x) => typeof row[metric] === "number" ? [[x, y, Number((Number(row[metric]) * 100).toFixed(2))] as [number, number, number]] : []));
    const summary = retentionMetrics.map((metric) => {
      const rawValue = response.data.summary?.[metric];
      const available = typeof rawValue === "number";
      const value = toDisplayValue(metric, rawValue);
      return { metric, value, formatted: available ? formatMetric(metric, value) : "—", change: 0, changeLabel: available ? "当前区间" : "当前区间无数据", available };
    });
    return {
      scopeLabel, categories: retentionLabels, series: [], cohort: values, cohortX: retentionLabels, cohortY: cohortRows.map((item) => item.label), summary,
      table: rows.map((row) => ({ 产品: String(row.platform ?? filters.platforms[0] ?? "NewAV"), 统计日期: String(row.date), 新增注册: Number(row.newUsers ?? 0), D1留存: typeof row.retentionD1 === "number" ? `${(row.retentionD1 * 100).toFixed(2)}%` : "—", D3留存: typeof row.retentionD3 === "number" ? `${(row.retentionD3 * 100).toFixed(2)}%` : "—", D7留存: typeof row.retentionD7 === "number" ? `${(row.retentionD7 * 100).toFixed(2)}%` : "—", D30留存: "—" })), insights: cohortRows.length ? [`当前展示 ${cohortRows.length} 个日期留存记录。`, `D3/D7 未成熟日期保持空值，不按 0 参与。`, `区间 D7 为非空日期简单平均 ${formatMetric("retentionD7", summary[2].value)}；接口缺少 cohort 分母，不能计算加权留存。`] : ["当前范围没有可分析的留存记录。"]
    };
  }
  const primaryMetric = card.metrics[0];
  const rowValue = (row: Record<string, string | number | null>) => primaryMetric ? toDisplayValue(primaryMetric, typeof row[primaryMetric] === "number" ? row[primaryMetric] : 0) : 0;
  if (card.type === "heatmap" && primaryMetric) {
    const dates = [...new Set(rows.map((row) => String(row.date ?? "汇总")))];
    const yDimension = card.dimensions.find((dimension) => dimension !== "date") ?? "platform";
    const returnedGroups = new Set(rows.map((row) => String(row[yDimension] ?? "全部")));
    const groups = yDimension === "platform" ? expectedPlatformNames(filters) : [...returnedGroups];
    const values = groups.flatMap((group, y) => dates.map((date, x) => {
      const value = rows
        .filter((row) => String(row[yDimension] ?? "全部") === group && String(row.date ?? "汇总") === date)
        .reduce((sum, row) => sum + rowValue(row), 0);
      return [x, y, Number(value.toFixed(2))] as [number, number, number];
    }));
    return {
      scopeLabel, categories: dates, series: [], summary: [], heatmapX: dates, heatmapY: groups, heatmap: values,
      table: rows.map(translateTableRow),
      insights: [`按${displayColumnName(yDimension)}和日期聚合真实接口返回值。`, `当前展示 ${groups.length} 个${displayColumnName(yDimension)}。`]
    };
  }
  if (card.type === "waterfall" && primaryMetric) {
    const dimension = card.dimensions.find((item) => item !== "date") ?? "platform";
    const groups = new Map<string, number>();
    rows.forEach((row) => {
      const name = String(row[dimension] ?? row.platform ?? row.content ?? row.category ?? "其他");
      groups.set(name, (groups.get(name) ?? 0) + rowValue(row));
    });
    if (dimension === "platform") expectedPlatformNames(filters).forEach((name) => { if (!groups.has(name)) groups.set(name, 0); });
    const waterfall = [...groups].map(([name, value]) => ({ name, value: Number(value.toFixed(2)) })).sort((a, b) => b.value - a.value);
    return {
      scopeLabel, categories: waterfall.map((item) => item.name), series: [], summary: [], waterfall,
      table: waterfall.map((item) => ({ [displayColumnName(dimension)]: item.name, [displayColumnName(primaryMetric)]: item.value })),
      insights: [`按${dimension === "platform" ? "平台" : "当前维度"}累加${METRIC_META[primaryMetric].name}，末列为总计。`, dimension === "platform" ? zeroPlatformInsight(expectedPlatformNames(filters), new Set(rows.map((row) => String(row.platform)))) : `当前展示 ${waterfall.length} 个贡献项。`]
    };
  }
  if (card.type === "treemap" && primaryMetric) {
    const parentDimension = card.dimensions.find((item) => item === "category" || item === "platform") ?? card.dimensions[0];
    const childDimension = card.dimensions.find((item) => item !== parentDimension && item !== "date");
    const parents = new Map<string, Map<string, number>>();
    rows.forEach((row) => {
      const parent = String(row[parentDimension] ?? "其他");
      const child = String(childDimension ? row[childDimension] ?? parent : parent);
      const children = parents.get(parent) ?? new Map<string, number>();
      children.set(child, (children.get(child) ?? 0) + rowValue(row));
      parents.set(parent, children);
    });
    if (parentDimension === "platform") expectedPlatformNames(filters).forEach((name) => { if (!parents.has(name)) parents.set(name, new Map([[name, 0]])); });
    const treemap = [...parents].map(([name, children]) => {
      const childRows = [...children].map(([childName, value]) => ({ name: childName, value: Number(value.toFixed(2)) })).sort((a, b) => b.value - a.value);
      return { name, value: Number(childRows.reduce((sum, item) => sum + item.value, 0).toFixed(2)), children: childRows };
    }).sort((a, b) => b.value - a.value);
    return {
      scopeLabel, categories: treemap.map((item) => item.name), series: [], summary: [], treemap,
      table: rows.map(translateTableRow),
      insights: [`面积表示${METRIC_META[primaryMetric].name}的真实汇总贡献。`, parentDimension === "platform" ? zeroPlatformInsight(expectedPlatformNames(filters), new Set(rows.map((row) => String(row.platform)))) : `当前展示 ${treemap.length} 个一级贡献项。`]
    };
  }
  const isPlatformAxis = card.dimensions.length === 1 && card.dimensions[0] === "platform";
  const categoryOf = (row: Record<string, string | number | null>) => {
    if (isPlatformAxis) return String(row.platform ?? "汇总");
    if (card.model === "usage_depth" && row.date) return String(row.date).split(" ").at(-1) ?? String(row.date);
    return String(row.content ?? row.keyword ?? row.channel ?? row.position ?? row.date ?? row.platform ?? "汇总");
  };
  let categories = [...new Set(rows.map(categoryOf))];
  if (isPlatformAxis) categories = expectedPlatformNames(filters);
  const hasCrossPlatformAxis = rows.some((row) => row.platform && (row.content || row.keyword || row.date));
  const splitDateTrendByPlatform = card.dimensions.includes("date") && card.dimensions.includes("platform") && rows.some((row) => row.platform && row.date);
  const valueFor = (metric: MetricId, category: string, platform?: string) => {
    const matching = rows.filter((row) => categoryOf(row) === category && (!platform || row.platform === platform));
    const values = matching.map((row) => row[metric]).filter((value): value is number => typeof value === "number");
    if (!values.length) return isPlatformAxis ? 0 : Number.NaN;
    const value = METRIC_META[metric].unit === "number" || METRIC_META[metric].unit === "currency"
      ? values.reduce((sum, item) => sum + item, 0)
      : values.reduce((sum, item) => sum + item, 0) / values.length;
    return toDisplayValue(metric, value);
  };
  let series = (!isPlatformAxis && filters.mode === "compare" && hasCrossPlatformAxis) || splitDateTrendByPlatform
    ? card.metrics.flatMap((metric) => expectedPlatformNames(filters).map((platform) => ({
      name: `${platform} · ${METRIC_META[metric].name}`,
      metric,
      data: categories.map((category) => valueFor(metric, category, platform))
    })))
    : card.metrics.map((metric) => ({
      name: METRIC_META[metric].name,
      metric,
      data: categories.map((category) => valueFor(metric, category))
    }));
  if (card.type === "bar" && series[0]) {
    const order = categories.map((_, index) => index).sort((left, right) => series[0].data[right] - series[0].data[left]);
    categories = order.map((index) => categories[index]);
    series = series.map((item) => ({ ...item, data: order.map((index) => item.data[index]) }));
  }
  const summary = card.metrics.map((metric) => {
    const rawValue = response.data.summary?.[metric];
    const available = typeof rawValue === "number";
    const value = toDisplayValue(metric, rawValue);
    return { metric, value, formatted: available ? formatMetric(metric, value) : "—", change: 0, changeLabel: available ? "当前区间" : "当前区间无数据", available };
  });
  const scatter = card.type === "scatter" && card.metrics.length >= 2
    ? categories.map((category, index) => {
      const x = series.find((item) => item.metric === card.metrics[0])?.data[index] ?? 0;
      const y = series.find((item) => item.metric === card.metrics[1])?.data[index] ?? 0;
      return {
        name: category,
        value: [x, y, Math.max(1, x)] as [number, number, number],
        extra: `${METRIC_META[card.metrics[0]].name} ${formatMetric(card.metrics[0], x)} · ${METRIC_META[card.metrics[1]].name} ${formatMetric(card.metrics[1], y)}`
      };
    })
    : undefined;
  const datedRows = rows.filter((row) => typeof row.date === "string").sort((left, right) => String(left.date).localeCompare(String(right.date)));
  const diagnosis = card.type === "diagnosis" && datedRows.length
    ? (() => {
      return card.metrics.flatMap((metric) => {
        const available = datedRows.filter((row) => typeof row[metric] === "number");
        if (!available.length) return [`${METRIC_META[metric].name}在当前周期没有可用值。`];
        const first = available[0];
        const latest = available.at(-1) ?? first;
        const firstValue = Number(first[metric]);
        const latestValue = Number(latest[metric]);
        const change = firstValue ? (latestValue - firstValue) / Math.abs(firstValue) * 100 : null;
        const ranked = [...available].sort((left, right) => Number(right[metric]) - Number(left[metric]));
        const peak = ranked[0];
        const completeness = available.length === datedRows.length ? "数据完整" : `仅 ${available.length}/${datedRows.length} 天有值`;
        return [`${METRIC_META[metric].name}最新值 ${formatMetric(metric, toDisplayValue(metric, latestValue))}，较周期首个可用值${change == null ? "暂不可比" : `${change >= 0 ? "上升" : "下降"} ${Math.abs(change).toFixed(1)}%`}；峰值出现在 ${String(peak.date)}，${completeness}。`];
      }).slice(0, 4);
    })()
    : undefined;
  const businessInsights = (() => {
    const firstSeries = series[0];
    if (!firstSeries?.data.length) return ["当前范围没有可分析的数据。"];
    const values = firstSeries.data.map((value, index) => ({ name: categories[index], value })).filter((item) => Number.isFinite(item.value));
    if (!values.length) return ["当前范围没有可分析的数据。"];
    const ranked = [...values].sort((left, right) => right.value - left.value);
    const total = values.reduce((sum, item) => sum + item.value, 0);
    const top = ranked[0];
    const insights = top ? [`${top.name} 的${METRIC_META[firstSeries.metric].name}最高，为 ${formatMetric(firstSeries.metric, top.value)}。`] : [];
    if (isPlatformAxis) insights.push(zeroPlatformInsight(expectedPlatformNames(filters), new Set(rows.map((row) => String(row.platform)))));
    else if (categories.length > 1) {
      const first = firstSeries.data[0];
      const last = firstSeries.data.at(-1) ?? first;
      const change = first ? (last - first) / Math.abs(first) * 100 : null;
      insights.push(change === null ? "起始值为 0，暂不计算区间变化。" : `区间末值较起始值${change >= 0 ? "上升" : "下降"} ${Math.abs(change).toFixed(1)}%。`);
    }
    if (top && total > 0 && isPlatformAxis) insights.push(`${top.name}占当前平台合计的 ${(top.value / total * 100).toFixed(1)}%。`);
    return insights;
  })();
  return {
    scopeLabel,
    categories,
    series,
    summary,
    scatter,
    table: rows.map(translateTableRow),
    insights: diagnosis ?? businessInsights
  };
}

export function buildDrillInsights(card: DashboardCardConfig, result: CardQueryResult, clickedName: string): string[] {
  const primaryMetric = card.metrics[0];
  if (!primaryMetric) return result.insights;
  const selectedRow = result.table.find((row) => Object.values(row).some((value) => String(value) === clickedName));
  const metricColumn = displayColumnName(primaryMetric);
  const selectedValue = Number(selectedRow?.[primaryMetric] ?? selectedRow?.[metricColumn]);
  const values = result.table
    .map((row) => Number(row[primaryMetric] ?? row[metricColumn]))
    .filter((value) => Number.isFinite(value));
  if (!selectedRow || !Number.isFinite(selectedValue) || !values.length) return result.insights;
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const displayValue = toDisplayValue(primaryMetric, selectedValue);
  const difference = average === 0 ? null : (selectedValue - average) / Math.abs(average) * 100;
  const comparison = difference === null
    ? "当前图表节点均值为 0，暂不计算相对差异。"
    : Math.abs(difference) < 0.05
      ? `与当前图表节点均值基本持平。`
      : `${difference > 0 ? "高于" : "低于"}当前图表节点均值 ${Math.abs(difference).toFixed(1)}%。`;
  return [
    `${clickedName} 当前${METRIC_META[primaryMetric].name}为 ${formatMetric(primaryMetric, displayValue)}。`,
    comparison,
    `该判断基于当前 ${values.length} 个图表节点，可继续查看右侧真实业务明细定位贡献来源。`
  ];
}

export interface RealCardQueryState {
  eligible: boolean;
  loading: boolean;
  result: CardQueryResult | null;
  error: string | null;
  warnings: string[];
}

type QueryPayload = NonNullable<BiResponse["data"]>;
const QUERY_CACHE_TTL_MS = 45_000;
const QUERY_CACHE_MAX_ENTRIES = 200;
const queryPromiseCache = new Map<string, { expiresAt: number; promise: Promise<QueryPayload> }>();

function pruneQueryCache(now = Date.now()) {
  for (const [key, entry] of queryPromiseCache) {
    if (entry.expiresAt <= now) queryPromiseCache.delete(key);
  }
  while (queryPromiseCache.size >= QUERY_CACHE_MAX_ENTRIES) {
    const oldestKey = queryPromiseCache.keys().next().value;
    if (typeof oldestKey !== "string") break;
    queryPromiseCache.delete(oldestKey);
  }
}

function fetchSharedQuery(request: ReturnType<typeof buildAnalyticsRequest>, bypassCache = false) {
  const key = JSON.stringify(request);
  const cached = queryPromiseCache.get(key);
  if (!bypassCache && cached && cached.expiresAt > Date.now()) return cached.promise;
  pruneQueryCache();
  const promise = fetch("/api/bi/analytics/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: key
  }).then(async (response) => {
    const payload = await response.json() as BiResponse;
    if (!response.ok || !payload.success || !payload.data) throw new Error(payload.error?.message ?? "真实数据查询失败");
    return payload.data;
  }).catch((error) => {
    queryPromiseCache.delete(key);
    throw error;
  });
  queryPromiseCache.set(key, { expiresAt: Date.now() + QUERY_CACHE_TTL_MS, promise });
  return promise;
}

export function buildAnalyticsRequest(card: DashboardCardConfig, filters: DashboardFilters) {
  const isFunnelQuery = card.type === "funnel" || card.type === "sankey";
  return {
    modelId: card.model,
    platformMode: filters.mode,
    analysisType: isFunnelQuery ? "funnel" : card.type === "kpi" ? "metric" : ["bar", "scatter", "treemap", "waterfall"].includes(card.type) ? "ranking" : card.type === "table" ? "table" : card.type === "cohort" ? "retention" : "trend",
    metricIds: isFunnelQuery ? [] : card.metrics,
    dimensionIds: card.dimensions,
    eventIds: card.funnelSteps ?? [],
    platformIds: resolvePlatforms(filters) ?? [],
    dateRange: resolveDashboardDateRange(filters),
    filters: {},
    limit: card.limit ?? 50
  };
}

function withComparison(current: CardQueryResult, previous: CardQueryResult, card: DashboardCardConfig, filters: DashboardFilters): CardQueryResult {
  const [currentStart, currentEnd] = resolveDashboardDateRange(filters);
  const [compareStart, compareEnd] = resolveComparisonDateRange(filters);
  const previousByMetric = new Map(previous.summary.map((item) => [item.metric, item]));
  const currentHasRecords = current.table.length > 0;
  const previousHasRecords = previous.table.length > 0;
  const summary = current.summary.map((item) => {
    const benchmark = previousByMetric.get(item.metric)?.value;
    const snapshotOnly = item.metric === "currentPaidMembers" || item.metric === "historicalPaidMembers";
    const previousMetric = previousByMetric.get(item.metric);
    const comparable = !snapshotOnly && item.available !== false && previousMetric?.available !== false && currentHasRecords && previousHasRecords && typeof benchmark === "number" && benchmark !== 0;
    const change = comparable ? (item.value - benchmark) / Math.abs(benchmark) * 100 : 0;
    const changeLabel = snapshotOnly ? "当前快照，不支持历史对比" : item.available === false ? "当前期无数据" : previousMetric?.available === false ? "对比期无数据" : !currentHasRecords ? "当前期暂无记录" : !previousHasRecords ? "对比期暂无记录" : typeof benchmark === "number" ? `对比期 ${formatMetric(item.metric, benchmark)}` : "对比期无数据";
    return { ...item, change: Number(change.toFixed(2)), changeLabel };
  });
  const comparisonSeries = card.type === "line" ? previous.series.map((series) => ({ ...series, name: `对比期·${series.name}` })) : [];
  return {
    ...current,
    scopeLabel: `${current.scopeLabel} · ${currentStart}~${currentEnd} 对比 ${compareStart}~${compareEnd}`,
    summary,
    series: [...current.series, ...comparisonSeries],
    insights: [`当前周期 ${currentStart} 至 ${currentEnd}，对比周期 ${compareStart} 至 ${compareEnd}。`, ...current.insights]
  };
}

export function useRealCardQuery(card: DashboardCardConfig, filters: DashboardFilters, retryKey = 0): RealCardQueryState {
  const eligible = useMemo(() => canUseRealData(card, filters), [card, filters]);
  const [state, setState] = useState<Omit<RealCardQueryState, "eligible">>({ loading: false, result: null, error: null, warnings: [] });

  useEffect(() => {
    if (!eligible) { setState({ loading: false, result: null, error: null, warnings: [] }); return; }
    let cancelled = false;
    const platformIdsValue = resolvePlatforms(filters)!;
    const startedAt = performance.now();
    window.dispatchEvent(new CustomEvent("bi-query-status", { detail: { phase: "start", cardId: card.id, title: card.title } }));
    setState((current) => ({ ...current, loading: true, error: null }));
    const timer = window.setTimeout(async () => {
      try {
        const query = async (dateRange: [string, string]) => {
          return fetchSharedQuery({ ...buildAnalyticsRequest(card, filters), platformIds: platformIdsValue, dateRange }, retryKey > 0);
        };
        const currentRange = resolveDashboardDateRange(filters);
        const comparisonRange = resolveComparisonDateRange(filters);
        const currentQueryRange: [string, string] = card.model === "usage_depth" ? [currentRange[1], currentRange[1]] : currentRange;
        const comparisonQueryRange: [string, string] = card.model === "usage_depth" ? [comparisonRange[1], comparisonRange[1]] : comparisonRange;
        const [currentPayload, comparisonPayload] = await Promise.all([query(currentQueryRange), query(comparisonQueryRange)]);
        const currentResult = transformRealResult(card, currentPayload, filters);
        const comparisonResult = transformRealResult(card, comparisonPayload, filters);
        if (cancelled) return;
        setState({ loading: false, result: withComparison(currentResult, comparisonResult, card, filters), error: null, warnings: [...currentPayload.meta.warnings, ...comparisonPayload.meta.warnings] });
        window.dispatchEvent(new CustomEvent("bi-query-status", { detail: { phase: "success", cardId: card.id, title: card.title, duration: Math.round(performance.now() - startedAt), at: new Date().toISOString() } }));
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : "真实数据查询失败";
        setState((current) => ({ ...current, loading: false, error: message, warnings: [] }));
        window.dispatchEvent(new CustomEvent("bi-query-status", { detail: { phase: "error", cardId: card.id, title: card.title, duration: Math.round(performance.now() - startedAt), message, at: new Date().toISOString() } }));
      }
    }, 250);
    return () => {
      window.clearTimeout(timer);
      cancelled = true;
      window.dispatchEvent(new CustomEvent("bi-query-status", { detail: { phase: "cancel", cardId: card.id, title: card.title } }));
    };
  }, [card, eligible, filters, retryKey]);
  return { eligible, ...state };
}
