import type {
  AnalysisModelId,
  ApiAnalysisCapability,
  ChartType,
  DashboardCardConfig,
  DashboardTemplate,
  DimensionId
} from "../types";

const capabilities: Record<AnalysisModelId, ApiAnalysisCapability> = {
  business_overview: {
    modelId: "business_overview",
    apiPaths: [
      "/api/admin/statistics/pDaySum",
      "/api/admin/home/pRealDayLine",
      "/api/admin/home/getAllByRole"
    ],
    dataGrain: "平台 × 日期 / 实时时点",
    status: "ready",
    statusLabel: "接口已验证",
    allowedCharts: ["kpi", "line", "bar", "scatter", "heatmap", "waterfall", "treemap", "table", "diagnosis"],
    allowedDimensions: ["date", "platform"],
    allowedMetrics: ["dau", "newUsers", "payerCount", "viewRate", "payRate", "arpu", "arppu", "androidDau", "iosDau", "androidNewUsers", "iosNewUsers", "organicNewUsers", "internalNewUsers", "adClickCount", "adClickUsers", "adClickRate", "adClickUserRate", "newAdClickCount", "newAdClickUsers", "newAdClickRate", "newAdClickUserRate", "oldAdClickCount", "oldAdClickUsers", "oldAdClickRate", "oldAdClickUserRate", "newRevenue", "newPayerCount", "newPayRate", "newArpu", "newArppu", "oldRevenue", "oldPayerCount", "oldPayRate", "oldArpu", "oldArppu", "channelNewRevenue", "internalNewRevenue", "dauUserDays", "payerUserDays", "androidDauUserDays", "iosDauUserDays", "adClickUserDays", "oldAdClickUserDays", "oldPayerUserDays"],
    funnelEvents: [],
    filters: ["日期区间", "平台"],
    limitations: ["不支持任意用户属性分群", "跨接口指标仅在平台和日期口径一致时计算"]
  },
  platform_compare: {
    modelId: "platform_compare",
    apiPaths: ["/api/admin/statistics/pDaySum", "/api/admin/home/getAllByRole"],
    dataGrain: "平台 × 日期",
    status: "ready",
    statusLabel: "接口已验证",
    allowedCharts: ["bar", "scatter", "line", "heatmap", "waterfall", "treemap", "table"],
    allowedDimensions: ["platform", "date"],
    allowedMetrics: ["dau", "newUsers", "payerCount", "viewRate", "payRate", "arpu", "arppu", "androidDau", "iosDau", "androidNewUsers", "iosNewUsers", "organicNewUsers", "internalNewUsers", "adClickCount", "adClickUsers", "adClickRate", "adClickUserRate", "newAdClickCount", "newAdClickUsers", "newAdClickRate", "newAdClickUserRate", "oldAdClickCount", "oldAdClickUsers", "oldAdClickRate", "oldAdClickUserRate", "newRevenue", "newPayerCount", "newPayRate", "newArpu", "newArppu", "oldRevenue", "oldPayerCount", "oldPayRate", "oldArpu", "oldArppu", "channelNewRevenue", "internalNewRevenue", "dauUserDays", "payerUserDays", "androidDauUserDays", "iosDauUserDays", "adClickUserDays", "oldAdClickUserDays", "oldPayerUserDays"],
    funnelEvents: [],
    filters: ["日期区间", "平台（最多 8 个）"],
    limitations: ["多平台对比由前端按 pid 分别请求后汇总"]
  },
  content_position: {
    modelId: "content_position",
    apiPaths: [
      "/api/admin/statistics/todayVideos/getMany",
      "/api/admin/statistics/todayVideos/getVideoStatsByCategories",
      "/api/admin/statistics/videoWatchRanking",
      "/api/admin/statistics/trackEventsReport/getEventStats"
    ],
    dataGrain: "视频 / 分类 × 日期；漏斗为平台汇总",
    status: "partial",
    statusLabel: "受限可用",
    allowedCharts: ["kpi", "bar", "treemap", "waterfall", "table", "funnel", "sankey"],
    allowedDimensions: ["platform", "category", "content"],
    allowedMetrics: ["videoWatchCount", "videoLikeCount", "videoCollectCount", "revenue"],
    funnelEvents: ["active_user", "video_click", "video_play", "video_play_end"],
    filters: ["日期区间", "平台", "一级分类"],
    limitations: ["视频排行接口不提供观看人数和平均观看时长", "现有接口不能按 page、position、positionRank 拆分", "漏斗是汇总计数，不是用户级有序转化"]
  },
  search_demand: {
    modelId: "search_demand",
    apiPaths: ["/api/admin/statistics/hotSearchWords/getMany"],
    dataGrain: "平台 × 搜索词",
    status: "limited",
    statusLabel: "仅排行能力",
    allowedCharts: ["bar", "treemap", "waterfall", "table"],
    allowedDimensions: ["platform", "keyword"],
    allowedMetrics: ["searchCount"],
    funnelEvents: [],
    filters: ["平台", "分页"],
    limitations: ["接口未提供日期筛选", "不支持无结果率、结果点击和搜索转化漏斗"]
  },
  payment_conversion: {
    modelId: "payment_conversion",
    apiPaths: [
      "/api/admin/statistics/trackEventsReport/getEventStats",
      "/api/admin/statistics/pDaySum"
    ],
    dataGrain: "平台 × 日期汇总",
    status: "partial",
    statusLabel: "汇总漏斗",
    allowedCharts: ["funnel", "sankey", "line", "kpi", "bar", "waterfall", "table"],
    allowedDimensions: ["platform", "date"],
    allowedMetrics: ["payerCount", "payerUserDays", "payRate", "arpu", "arppu", "newRevenue", "newPayerCount", "newPayRate", "newArpu", "newArppu", "oldRevenue", "oldPayerCount", "oldPayerUserDays", "oldPayRate", "oldArpu", "oldArppu", "channelNewRevenue", "internalNewRevenue"],
    funnelEvents: ["vip_click", "pre_pay", "success_pay"],
    filters: ["日期区间", "平台", "统计模式"],
    limitations: ["不支持支付通道、会员档位和失败原因拆分", "不支持转化窗口和用户级路径去重"]
  },
  member_operation: {
    modelId: "member_operation",
    apiPaths: ["/api/admin/statistics/pDaySum"],
    dataGrain: "平台 × 日期汇总",
    status: "limited",
    statusLabel: "字段待核对",
    allowedCharts: ["kpi", "line", "table"],
    allowedDimensions: ["platform", "date"],
    allowedMetrics: ["payerCount", "payerUserDays", "payRate", "arpu", "arppu", "newRevenue", "newPayerCount", "newPayRate", "newArpu", "newArppu", "oldRevenue", "oldPayerCount", "oldPayerUserDays", "oldPayRate", "oldArpu", "oldArppu", "channelNewRevenue", "internalNewRevenue"],
    funnelEvents: [],
    filters: ["日期区间", "平台"],
    limitations: ["当前付费会员、历史付费会员和续费率尚无已确认接口字段", "不能按会员档位拆分"]
  },
  retention_quality: {
    modelId: "retention_quality",
    apiPaths: [
      "/api/admin/statistics/reletionsStatPlus/getDays",
      "/api/admin/statistics/averageReletionsStat/getAverageReletions"
    ],
    dataGrain: "平台 × 注册日期 cohort",
    status: "partial",
    statusLabel: "样例待补齐",
    allowedCharts: ["cohort", "heatmap", "line", "bar", "table", "kpi"],
    allowedDimensions: ["date", "platform"],
    allowedMetrics: ["newUsers", "retentionD1", "retentionD3", "retentionD7", "retentionD30"],
    funnelEvents: [],
    filters: ["注册日期区间", "平台"],
    limitations: ["未到对应观察日的 cohort 返回空值，不按 0 计算", "留存率按各档回登人数 / 注册人数加权"]
  },
  usage_depth: {
    modelId: "usage_depth",
    apiPaths: ["/api/admin/home/pRealDayLine", "/api/admin/statistics/todayUsers/getMany"],
    dataGrain: "平台 × 5分钟时点",
    status: "partial",
    statusLabel: "可派生计算",
    allowedCharts: ["kpi", "line", "bar", "heatmap", "waterfall", "table"],
    allowedDimensions: ["date", "platform"],
    allowedMetrics: ["dau", "dauUserDays", "newUsers", "viewerCount", "viewerUserDays", "viewRate", "avgWatchMinutes"],
    funnelEvents: [],
    filters: ["日期区间", "平台"],
    limitations: ["24小时曲线按当前周期结束日与对比周期结束日查询", "人均观影时长可由总观看时长/观看人数计算", "人均使用时长缺少已确认的前台总时长字段"]
  },
  acquisition_conversion: {
    modelId: "acquisition_conversion",
    apiPaths: ["/api/admin/statistics/cpGuardStat/cnzzstatQuery", "/api/admin/statistics/pDaySum"],
    dataGrain: "平台 × 日期",
    status: "ready",
    statusLabel: "跨接口可计算",
    allowedCharts: ["kpi", "line", "bar", "scatter", "waterfall", "table", "diagnosis"],
    allowedDimensions: ["date", "platform"],
    allowedMetrics: ["visits", "downloads", "newUsers", "visitDownloadRate", "downloadRegisterRate", "visitRegisterRate"],
    funnelEvents: [],
    filters: ["日期区间", "平台"],
    limitations: ["注册数只能关联到平台和日期，不能拆到渠道", "下载与注册统计对象不同，转化率可能超过 100%，此时标记口径不可比"]
  },
  custom_table: {
    modelId: "custom_table",
    apiPaths: ["/api/admin/statistics/pDaySum"],
    dataGrain: "平台 × 日期",
    status: "ready",
    statusLabel: "同接口组合",
    allowedCharts: ["table", "bar", "line", "scatter", "heatmap", "waterfall", "treemap"],
    allowedDimensions: ["date", "platform"],
    allowedMetrics: ["dau", "newUsers", "payerCount", "viewRate", "payRate", "arpu", "arppu", "androidDau", "iosDau", "androidNewUsers", "iosNewUsers", "organicNewUsers", "internalNewUsers", "adClickCount", "adClickUsers", "adClickRate", "adClickUserRate", "newAdClickCount", "newAdClickUsers", "newAdClickRate", "newAdClickUserRate", "oldAdClickCount", "oldAdClickUsers", "oldAdClickRate", "oldAdClickUserRate", "newRevenue", "newPayerCount", "newPayRate", "newArpu", "newArppu", "oldRevenue", "oldPayerCount", "oldPayRate", "oldArpu", "oldArppu", "channelNewRevenue", "internalNewRevenue", "dauUserDays", "payerUserDays", "androidDauUserDays", "iosDauUserDays", "adClickUserDays", "oldAdClickUserDays", "oldPayerUserDays"],
    funnelEvents: [],
    filters: ["日期区间", "平台", "分页"],
    limitations: ["只允许组合同一接口返回的字段", "暂不支持跨接口 Join 和任意计算字段"]
  }
};

const dimensionLabels: Record<DimensionId, string> = {
  date: "日期",
  platform: "平台",
  page: "页面",
  position: "位置",
  positionRank: "位置排名",
  category: "分类",
  content: "内容",
  keyword: "搜索词",
  paymentChannel: "支付通道",
  memberPlan: "会员档位",
  memberStatus: "会员状态",
  result: "结果",
  appVersion: "应用版本",
  channel: "渠道"
};

export function getApiCapability(modelId: AnalysisModelId) {
  return capabilities[modelId] ?? capabilities.business_overview;
}

export function getSupportedFunnelEvents(modelId: AnalysisModelId) {
  return [...capabilities[modelId].funnelEvents];
}

export function validateCardCapability(card: DashboardCardConfig) {
  const capability = capabilities[card.model];
  const issues: string[] = [];
  if (!capability.allowedCharts.includes(card.type)) issues.push(`不支持图表：${card.type}`);
  card.metrics.filter((item) => !capability.allowedMetrics.includes(item)).forEach((item) => issues.push(`不支持指标：${item}`));
  card.dimensions.filter((item) => !capability.allowedDimensions.includes(item)).forEach((item) => issues.push(`不支持维度：${dimensionLabels[item]}`));
  if (card.type === "funnel" || card.type === "sankey") {
    (card.funnelSteps ?? []).filter((item) => !capability.funnelEvents.includes(item)).forEach((item) => issues.push(`不支持漏斗字段：${item}`));
  }
  return { valid: issues.length === 0, issues };
}

const cardSizes = new Set<DashboardCardConfig["size"]>(["sm", "md", "lg", "full"]);
const cardPlatformModes = new Set<NonNullable<DashboardCardConfig["platformMode"]>>(["global", "all", "single", "compare"]);

function isModelId(value: unknown): value is AnalysisModelId {
  return typeof value === "string" && value in capabilities;
}

export function normalizeCardCapability(value: unknown): DashboardCardConfig | null {
  if (!value || typeof value !== "object") return null;
  const card = value as Partial<DashboardCardConfig>;
  if (!isModelId(card.model)) return null;
  const capability = capabilities[card.model];
  const type = capability.allowedCharts.includes(card.type as ChartType) ? card.type as ChartType : capability.allowedCharts[0];
  const metrics = Array.isArray(card.metrics) ? card.metrics.filter((item) => capability.allowedMetrics.includes(item)) : [];
  const dimensions = Array.isArray(card.dimensions) ? card.dimensions.filter((item) => capability.allowedDimensions.includes(item)) : [];
  const funnelSteps = type === "funnel" || type === "sankey"
    ? (Array.isArray(card.funnelSteps) ? card.funnelSteps.filter((item) => capability.funnelEvents.includes(item)) : capability.funnelEvents)
    : [];
  return {
    ...card,
    id: typeof card.id === "string" ? card.id : `normalized-${Date.now()}`,
    title: typeof card.title === "string" ? card.title : "未命名分析卡片",
    model: card.model,
    type,
    metrics: metrics.length ? metrics : [capability.allowedMetrics[0]],
    dimensions: dimensions.length ? dimensions : [capability.allowedDimensions[0]],
    size: cardSizes.has(card.size as DashboardCardConfig["size"]) ? card.size as DashboardCardConfig["size"] : "md",
    funnelSteps,
    conversionWindow: type === "funnel" || type === "sankey" ? "接口日期范围" : undefined,
    drillPath: Array.isArray(card.drillPath) ? card.drillPath.filter((item) => capability.allowedDimensions.includes(item)) : [],
    sourceApi: capability.apiPaths.includes(card.sourceApi ?? "") ? card.sourceApi : capability.apiPaths[0],
    platformMode: cardPlatformModes.has(card.platformMode as NonNullable<DashboardCardConfig["platformMode"]>) ? card.platformMode : "global",
    platforms: Array.isArray(card.platforms) ? card.platforms.filter((item): item is string => typeof item === "string").slice(0, 8) : []
  };
}

export function normalizeDashboardTemplate(value: unknown): DashboardTemplate | null {
  if (!value || typeof value !== "object") return null;
  const template = value as Partial<DashboardTemplate>;
  if (!isModelId(template.model)) return null;
  const capability = capabilities[template.model];
  const cards = Array.isArray(template.cards)
    ? template.cards.map(normalizeCardCapability).filter((card): card is DashboardCardConfig => card !== null)
    : [];
  const filters = Array.isArray(template.filters)
    ? template.filters.filter((item) => capability.allowedDimensions.includes(item))
    : [];
  return {
    ...template,
    id: typeof template.id === "string" ? template.id : `template-${Date.now()}`,
    name: typeof template.name === "string" ? template.name : "未命名模板",
    scenario: typeof template.scenario === "string" ? template.scenario : "",
    model: template.model,
    filters,
    cards
  };
}
