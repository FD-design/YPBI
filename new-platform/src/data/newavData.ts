import type { AnalysisModel, AnalysisModelId, DashboardTemplate, DimensionId, EventDefinition, MetricDefinition, MetricId } from "../types";

export const dates = ["08-19", "08-20", "08-21", "08-22", "08-23", "08-24", "08-25"];
export const platforms = [{ platform: "NewAV", dau: 510, newUsers: 266, revenue: 157, viewRate: 68.4, payRate: 1.3, retentionD1: 24.6, arppu: 45.8 }];
export const contentRows: any[] = [];
export const searchRows: any[] = [];

const metric = (definition: Omit<MetricDefinition, "owner" | "status">): MetricDefinition => ({
  owner: "NewAV 数据产品",
  status: "ready",
  ...definition
});

export const metricDictionary: MetricDefinition[] = [
  metric({ id: "dau", name: "日均活跃用户", formula: "sum(activeNew + activeOld) / 有数据自然日", source: "period / channels-daily", unit: "number", aggregation: "average" }),
  metric({ id: "dauUserDays", name: "累计活跃人天", formula: "sum(activeNew + activeOld)", source: "period / channels-daily", unit: "number", aggregation: "sum" }),
  metric({ id: "newUsers", name: "新增注册", formula: "sum(registNew)", source: "period / channels-daily", unit: "number", aggregation: "sum" }),
  metric({ id: "viewerCount", name: "日均观影人数", formula: "sum(viewers) / 有数据自然日", source: "period", unit: "number", aggregation: "average" }),
  metric({ id: "viewerUserDays", name: "累计观影人天", formula: "sum(viewers)", source: "period / channels-daily", unit: "number", aggregation: "sum" }),
  metric({ id: "visits", name: "访问次数", formula: "sum(ipTotal)", source: "period / channels-metrics", unit: "number", aggregation: "sum" }),
  metric({ id: "visitRegisterRate", name: "访问注册转化", formula: "sum(registNew) / sum(ipUniq)", source: "period / channels-daily", unit: "percent", aggregation: "weighted" }),
  metric({ id: "newRevenue", name: "周期新增充值", formula: "sum(rechargeNew)", source: "period / channels-daily", unit: "currency", aggregation: "sum" }),
  metric({ id: "payerCount", name: "会员购买", formula: "sum(cardBuy)", source: "period / channels-daily", unit: "number", aggregation: "sum" }),
  metric({ id: "payRate", name: "新增购买率", formula: "sum(cardBuy) / sum(registNew)", source: "period", unit: "percent", aggregation: "weighted" }),
  metric({ id: "adClickCount", name: "广告点击次数", formula: "sum(adClicks)", source: "period / ad-stats", unit: "number", aggregation: "sum" }),
  metric({ id: "adClickUsers", name: "广告点击人数", formula: "sum(adClickUsers)", source: "period", unit: "number", aggregation: "sum" }),
  metric({ id: "adClickRate", name: "广告 CTR", formula: "sum(clicks) / sum(shows)", source: "ad-stats", unit: "percent", aggregation: "weighted" }),
  metric({ id: "pageViews", name: "广告展示次数", formula: "sum(shows)", source: "ad-stats", unit: "number", aggregation: "sum" }),
  metric({ id: "pageClicks", name: "播放错误次数", formula: "sum(playErr)", source: "period", unit: "number", aggregation: "sum" }),
  metric({ id: "videoWatchCount", name: "播放成功次数", formula: "sum(playOk)", source: "period", unit: "number", aggregation: "sum" }),
  metric({ id: "playRate", name: "播放成功率", formula: "sum(playOk) / sum(playOk + playErr)", source: "period", unit: "percent", aggregation: "weighted" }),
  metric({ id: "androidDau", name: "Android 活跃", formula: "sum(androidActive)", source: "period", unit: "number", aggregation: "sum" }),
  metric({ id: "iosDau", name: "iOS 活跃", formula: "sum(iosActive)", source: "period", unit: "number", aggregation: "sum" }),
  metric({ id: "retentionD1", name: "次日留存", formula: "D1 retained / cohort users", source: "retention", unit: "percent", aggregation: "weighted" }),
  metric({ id: "retentionD3", name: "3日留存", formula: "D3 retained / cohort users", source: "retention", unit: "percent", aggregation: "weighted" }),
  metric({ id: "retentionD7", name: "7日留存", formula: "D7 retained / cohort users", source: "retention", unit: "percent", aggregation: "weighted" }),
  metric({ id: "currentPaidMembers", name: "当前活跃 VIP", formula: "activeVips", source: "overview", unit: "number", aggregation: "latest" }),
  metric({ id: "historicalPaidMembers", name: "订单总数", formula: "orders", source: "overview", unit: "number", aggregation: "latest" })
];

export const eventDictionary: EventDefinition[] = [
  { id: "active_user", name: "活跃用户", domain: "用户", requiredProperties: ["date"], description: "周期活跃新老用户。", status: "ready", coverage: ["NewAV"] },
  { id: "registry_user", name: "注册用户", domain: "增长", requiredProperties: ["date", "channel"], description: "渠道新增注册用户。", status: "ready", coverage: ["NewAV"] },
  { id: "video_play", name: "播放成功", domain: "内容", requiredProperties: ["date"], description: "播放成功次数。", status: "ready", coverage: ["NewAV"] },
  { id: "play_error", name: "播放错误", domain: "内容", requiredProperties: ["date"], description: "播放错误次数。", status: "ready", coverage: ["NewAV"] },
  { id: "ad_show", name: "广告展示", domain: "广告", requiredProperties: ["date", "position"], description: "广告素材展示。", status: "ready", coverage: ["NewAV"] },
  { id: "ad_click", name: "广告点击", domain: "广告", requiredProperties: ["date", "position"], description: "广告素材点击。", status: "ready", coverage: ["NewAV"] },
  { id: "vip_click", name: "会员入口点击", domain: "会员", requiredProperties: ["date"], description: "会员转化起点。", status: "ready", coverage: ["NewAV"] },
  { id: "success_pay", name: "会员购买", domain: "会员", requiredProperties: ["date"], description: "会员购买成功。", status: "ready", coverage: ["NewAV"] }
];

const model = (id: AnalysisModelId, name: string, metrics: MetricId[], charts: AnalysisModel["recommendedCharts"], dimensions: DimensionId[] = ["date", "channel"]): AnalysisModel => ({
  id,
  name,
  description: `${name}使用 NewAV 独立统计接口，支持日期与渠道下钻。`,
  eventChain: [],
  allowedDimensions: dimensions,
  allowedMetrics: metrics,
  defaultDrillPath: dimensions,
  recommendedCharts: charts
});

const allMetricIds = metricDictionary.map((item) => item.id);
export const analysisModels: AnalysisModel[] = [
  model("business_overview", "经营总览", allMetricIds, ["kpi", "line", "bar", "table", "diagnosis"]),
  model("acquisition_conversion", "渠道增长", allMetricIds, ["kpi", "line", "bar", "scatter", "waterfall", "heatmap", "table"]),
  model("content_position", "内容与播放", allMetricIds, ["kpi", "line", "bar", "funnel", "treemap", "table"], ["date", "content", "position"]),
  model("custom_table", "自定义分析", allMetricIds, ["kpi", "line", "bar", "scatter", "heatmap", "treemap", "table"], ["date", "channel", "content", "position"]),
  model("retention_quality", "留存质量", allMetricIds, ["cohort", "line", "table", "kpi"]),
  model("member_operation", "会员经营", allMetricIds, ["kpi", "line", "bar", "table", "sankey"]),
  model("payment_conversion", "会员转化", allMetricIds, ["funnel", "line", "kpi", "table"]),
  model("usage_depth", "使用深度", allMetricIds, ["kpi", "line", "bar", "table"])
];

export const dashboardTemplates: DashboardTemplate[] = [
  {
    id: "newav-overview", name: "NewAV 经营诊断", scenario: "从规模、增长、观看、播放质量与商业化判断整体经营健康。", model: "business_overview", filters: ["date", "platform"], status: "published", updatedAt: "2026-08-25 23:55",
    cards: [
      { id: "newav-kpi", title: "核心经营指标", type: "kpi", model: "business_overview", metrics: ["dau", "newUsers", "viewerUserDays", "newRevenue", "payerCount"], dimensions: ["date"], size: "full", drillPath: ["date"] },
      { id: "newav-trend", title: "增长、活跃与观影趋势", type: "line", model: "business_overview", metrics: ["newUsers", "dau", "viewerCount"], dimensions: ["date"], size: "full", drillPath: ["date"] },
      { id: "newav-quality", title: "播放成功与错误趋势", type: "line", model: "content_position", metrics: ["videoWatchCount", "pageClicks"], dimensions: ["date"], size: "lg", drillPath: ["date"] },
      { id: "newav-diagnosis", title: "经营异常诊断", type: "diagnosis", model: "business_overview", metrics: ["dau", "newUsers", "playRate"], dimensions: ["date"], size: "md", drillPath: ["date"] },
      { id: "newav-device", title: "终端访问结构", type: "bar", model: "usage_depth", metrics: ["androidDau", "iosDau"], dimensions: ["date"], size: "full", drillPath: ["date"] }
    ]
  },
  {
    id: "newav-channel", name: "渠道增长与效率", scenario: "同时比较渠道规模、注册效率、内容承接、广告与付费贡献。", model: "acquisition_conversion", filters: ["date", "channel"], status: "published", updatedAt: "2026-08-25 23:55",
    cards: [
      { id: "channel-kpi", title: "渠道归因核心指标", type: "kpi", model: "acquisition_conversion", metrics: ["visits", "newUsers", "visitRegisterRate", "newRevenue"], dimensions: ["channel"], size: "full", drillPath: ["channel", "date"] },
      { id: "channel-scatter", title: "渠道规模 × 注册效率四象限", type: "scatter", model: "acquisition_conversion", metrics: ["visits", "visitRegisterRate"], dimensions: ["channel"], size: "lg", drillPath: ["channel"] },
      { id: "channel-waterfall", title: "渠道新增贡献瀑布", type: "waterfall", model: "acquisition_conversion", metrics: ["newUsers"], dimensions: ["channel"], size: "md", drillPath: ["channel"] },
      { id: "channel-heatmap", title: "日期 × 渠道活跃热力", type: "heatmap", model: "business_overview", metrics: ["dau"], dimensions: ["date", "channel"], size: "full", drillPath: ["channel", "date"] },
      { id: "channel-tree", title: "渠道观影贡献矩形图", type: "treemap", model: "usage_depth", metrics: ["viewerUserDays"], dimensions: ["channel"], size: "md", drillPath: ["channel"] },
      { id: "channel-table", title: "渠道经营明细", type: "table", model: "custom_table", metrics: ["visits", "newUsers", "dauUserDays", "viewerUserDays", "adClickCount", "newRevenue", "payerCount", "visitRegisterRate"], dimensions: ["channel", "date"], size: "full", drillPath: ["channel", "date"], limit: 100 }
    ]
  },
  {
    id: "newav-content", name: "内容与播放质量", scenario: "观察观看规模、播放稳定性和设备结构，定位内容消费损耗。", model: "content_position", filters: ["date", "channel"], status: "published", updatedAt: "2026-08-25 23:55",
    cards: [
      { id: "content-kpi", title: "内容消费与播放质量", type: "kpi", model: "content_position", metrics: ["viewerUserDays", "videoWatchCount", "pageClicks", "playRate"], dimensions: ["date"], size: "full" },
      { id: "content-funnel", title: "访问到播放汇总漏斗", type: "funnel", model: "content_position", metrics: ["playRate"], dimensions: ["date"], size: "lg", funnelSteps: ["active_user", "video_click", "video_play", "video_play_end"], conversionWindow: "接口日期范围" },
      { id: "content-sankey", title: "内容消费阶段汇总流量", type: "sankey", model: "content_position", metrics: ["videoWatchCount"], dimensions: ["date"], size: "md", funnelSteps: ["active_user", "video_click", "video_play", "video_play_end"], conversionWindow: "接口日期范围" },
      { id: "content-trend", title: "观影与播放结果趋势", type: "line", model: "content_position", metrics: ["viewerCount", "videoWatchCount", "pageClicks"], dimensions: ["date"], size: "full", drillPath: ["date"] }
    ]
  },
  {
    id: "newav-ads", name: "广告素材表现", scenario: "按素材和广告位分析展示、点击、点击人数与 CTR。", model: "custom_table", filters: ["date", "position"], status: "published", updatedAt: "2026-08-25 23:55",
    cards: [
      { id: "ads-kpi", title: "广告规模与效率", type: "kpi", model: "custom_table", metrics: ["pageViews", "adClickCount", "adClickUsers", "adClickRate"], dimensions: ["position"], size: "full" },
      { id: "ads-scatter", title: "素材曝光 × CTR 气泡矩阵", type: "scatter", model: "custom_table", metrics: ["pageViews", "adClickRate"], dimensions: ["content"], size: "lg", drillPath: ["content"] },
      { id: "ads-treemap", title: "广告点击贡献矩形图", type: "treemap", model: "custom_table", metrics: ["adClickCount"], dimensions: ["position", "content"], size: "md", drillPath: ["position", "content"] },
      { id: "ads-table", title: "广告素材明细", type: "table", model: "custom_table", metrics: ["pageViews", "adClickCount", "adClickUsers", "adClickRate"], dimensions: ["position", "content"], size: "full", limit: 100 }
    ]
  },
  {
    id: "newav-retention", name: "留存与会员", scenario: "按注册 Cohort 观察留存，并跟踪会员购买、活跃 VIP 与充值。", model: "retention_quality", filters: ["date"], status: "published", updatedAt: "2026-08-25 23:55",
    cards: [
      { id: "retention-cohort", title: "新增用户 Cohort 留存", type: "cohort", model: "retention_quality", metrics: ["retentionD1", "retentionD3", "retentionD7"], dimensions: ["date", "platform"], size: "full" },
      { id: "retention-trend", title: "D1 / D3 / D7 留存趋势", type: "line", model: "retention_quality", metrics: ["retentionD1", "retentionD3", "retentionD7"], dimensions: ["date"], size: "lg" },
      { id: "member-kpi", title: "会员与充值概况", type: "kpi", model: "member_operation", metrics: ["currentPaidMembers", "historicalPaidMembers", "payerCount", "newRevenue", "payRate"], dimensions: ["date"], size: "full" }
    ]
  }
];
