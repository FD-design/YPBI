import type { AnalysisType } from "../../contracts/analytics";

export interface MetricDefinition {
  id: string;
  name: string;
  unit: "count" | "person" | "currency" | "duration" | "percent";
  aggregation: "sum" | "dailyAverage" | "latest" | "weightedRatio";
  numeratorMetricId?: string;
  denominatorMetricId?: string;
  sourceApiIds: string[];
  dimensions: string[];
  analysisTypes: AnalysisType[];
}

const overview = "/api/admin/statistics/pDaySum";
const realtime = "/api/admin/home/pRealDayLine";
const events = "/api/admin/statistics/trackEventsReport/getEventStats";
const cnzz = "/api/admin/statistics/cpGuardStat/cnzzstatQuery";

export const metrics: Record<string, MetricDefinition> = {
  dau: { id: "dau", name: "日均DAU", unit: "person", aggregation: "dailyAverage", sourceApiIds: [overview, realtime], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] },
  dauUserDays: { id: "dauUserDays", name: "累计活跃人天", unit: "person", aggregation: "sum", sourceApiIds: [overview], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] },
  newUsers: { id: "newUsers", name: "新增用户", unit: "person", aggregation: "sum", sourceApiIds: [overview, realtime, "/api/admin/statistics/reletionsStatPlus/getDays"], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "retention", "table"] },
  viewerCount: { id: "viewerCount", name: "日均观影人数", unit: "person", aggregation: "dailyAverage", sourceApiIds: [overview, realtime], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] },
  viewerUserDays: { id: "viewerUserDays", name: "累计观影人天", unit: "person", aggregation: "sum", sourceApiIds: [overview], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] },
  watchDuration: { id: "watchDuration", name: "总观影时长", unit: "duration", aggregation: "sum", sourceApiIds: [overview, realtime], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "table"] },
  revenue: { id: "revenue", name: "收入", unit: "currency", aggregation: "sum", sourceApiIds: [overview, "/api/admin/statistics/todayVideos/getMany"], dimensions: ["date", "platform", "content", "category"], analysisTypes: ["metric", "trend", "ranking", "table"] },
  payerCount: { id: "payerCount", name: "日均付费人数", unit: "person", aggregation: "dailyAverage", sourceApiIds: [overview], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] },
  payerUserDays: { id: "payerUserDays", name: "累计付费人天", unit: "person", aggregation: "sum", sourceApiIds: [overview], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] },
  visits: { id: "visits", name: "访问", unit: "count", aggregation: "sum", sourceApiIds: [cnzz], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] },
  downloads: { id: "downloads", name: "下载", unit: "count", aggregation: "sum", sourceApiIds: [cnzz], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] },
  visitDownloadRate: { id: "visitDownloadRate", name: "访问→下载转化", unit: "percent", aggregation: "weightedRatio", numeratorMetricId: "downloads", denominatorMetricId: "visits", sourceApiIds: [cnzz], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] },
  downloadRegisterRate: { id: "downloadRegisterRate", name: "下载→注册转化", unit: "percent", aggregation: "weightedRatio", numeratorMetricId: "newUsers", denominatorMetricId: "downloads", sourceApiIds: [cnzz, overview], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] },
  visitRegisterRate: { id: "visitRegisterRate", name: "访问→注册转化", unit: "percent", aggregation: "weightedRatio", numeratorMetricId: "newUsers", denominatorMetricId: "visits", sourceApiIds: [cnzz, overview], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] },
  viewRate: { id: "viewRate", name: "观影率", unit: "percent", aggregation: "weightedRatio", numeratorMetricId: "viewerCount", denominatorMetricId: "dau", sourceApiIds: [overview, realtime], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] },
  avgWatchDuration: { id: "avgWatchDuration", name: "人均观影时长", unit: "duration", aggregation: "weightedRatio", numeratorMetricId: "watchDuration", denominatorMetricId: "viewerCount", sourceApiIds: [overview, realtime], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] },
  payRate: { id: "payRate", name: "付费率", unit: "percent", aggregation: "weightedRatio", numeratorMetricId: "payerCount", denominatorMetricId: "dau", sourceApiIds: [overview], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] },
  arppu: { id: "arppu", name: "ARPPU", unit: "currency", aggregation: "weightedRatio", numeratorMetricId: "revenue", denominatorMetricId: "payerCount", sourceApiIds: [overview], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] }
  ,arpu: { id: "arpu", name: "ARPU", unit: "currency", aggregation: "weightedRatio", numeratorMetricId: "revenue", denominatorMetricId: "dau", sourceApiIds: [overview], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] }
  ,androidDau: { id: "androidDau", name: "Android日均活跃", unit: "person", aggregation: "dailyAverage", sourceApiIds: [overview], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] }
  ,androidDauUserDays: { id: "androidDauUserDays", name: "Android累计活跃人天", unit: "person", aggregation: "sum", sourceApiIds: [overview], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] }
  ,iosDau: { id: "iosDau", name: "IOS日均活跃", unit: "person", aggregation: "dailyAverage", sourceApiIds: [overview], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] }
  ,iosDauUserDays: { id: "iosDauUserDays", name: "IOS累计活跃人天", unit: "person", aggregation: "sum", sourceApiIds: [overview], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] }
  ,androidNewUsers: { id: "androidNewUsers", name: "Android新增", unit: "person", aggregation: "sum", sourceApiIds: [overview], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] }
  ,iosNewUsers: { id: "iosNewUsers", name: "IOS新增", unit: "person", aggregation: "sum", sourceApiIds: [overview], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] }
  ,organicNewUsers: { id: "organicNewUsers", name: "自然新增", unit: "person", aggregation: "sum", sourceApiIds: [overview], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] }
  ,internalNewUsers: { id: "internalNewUsers", name: "内部导量新增", unit: "person", aggregation: "sum", sourceApiIds: [overview], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] }
  ,adClickCount: { id: "adClickCount", name: "广告点击人次", unit: "count", aggregation: "sum", sourceApiIds: [overview], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] }
  ,adClickUsers: { id: "adClickUsers", name: "日均广告点击人数", unit: "person", aggregation: "dailyAverage", sourceApiIds: [overview], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] }
  ,adClickUserDays: { id: "adClickUserDays", name: "累计广告点击人天", unit: "person", aggregation: "sum", sourceApiIds: [overview], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] }
  ,adClickRate: { id: "adClickRate", name: "广告点击人次率", unit: "percent", aggregation: "weightedRatio", numeratorMetricId: "adClickCount", denominatorMetricId: "dau", sourceApiIds: [overview], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] }
  ,adClickUserRate: { id: "adClickUserRate", name: "广告点击人数率", unit: "percent", aggregation: "weightedRatio", numeratorMetricId: "adClickUsers", denominatorMetricId: "dau", sourceApiIds: [overview], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] }
  ,newAdClickCount: { id: "newAdClickCount", name: "新增广告点击人次", unit: "count", aggregation: "sum", sourceApiIds: [overview], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] }
  ,newAdClickUsers: { id: "newAdClickUsers", name: "新增广告点击人数", unit: "person", aggregation: "sum", sourceApiIds: [overview], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] }
  ,newAdClickRate: { id: "newAdClickRate", name: "新增广告点击人次率", unit: "percent", aggregation: "weightedRatio", numeratorMetricId: "newAdClickCount", denominatorMetricId: "newUsers", sourceApiIds: [overview], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] }
  ,newAdClickUserRate: { id: "newAdClickUserRate", name: "新增广告点击人数率", unit: "percent", aggregation: "weightedRatio", numeratorMetricId: "newAdClickUsers", denominatorMetricId: "newUsers", sourceApiIds: [overview], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] }
  ,oldAdClickCount: { id: "oldAdClickCount", name: "老用户广告点击人次", unit: "count", aggregation: "sum", sourceApiIds: [overview], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] }
  ,oldAdClickUsers: { id: "oldAdClickUsers", name: "日均老用户广告点击人数", unit: "person", aggregation: "dailyAverage", sourceApiIds: [overview], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] }
  ,oldAdClickUserDays: { id: "oldAdClickUserDays", name: "累计老用户广告点击人天", unit: "person", aggregation: "sum", sourceApiIds: [overview], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] }
  ,oldAdClickRate: { id: "oldAdClickRate", name: "老用户广告点击人次率", unit: "percent", aggregation: "weightedRatio", numeratorMetricId: "oldAdClickCount", denominatorMetricId: "oldUsers", sourceApiIds: [overview], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] }
  ,oldAdClickUserRate: { id: "oldAdClickUserRate", name: "老用户广告点击人数率", unit: "percent", aggregation: "weightedRatio", numeratorMetricId: "oldAdClickUsers", denominatorMetricId: "oldUsers", sourceApiIds: [overview], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] }
  ,newRevenue: { id: "newRevenue", name: "新增充值金额", unit: "currency", aggregation: "sum", sourceApiIds: [overview], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] }
  ,newPayerCount: { id: "newPayerCount", name: "新增充值人数", unit: "person", aggregation: "sum", sourceApiIds: [overview], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] }
  ,newPayRate: { id: "newPayRate", name: "新增充值付费率", unit: "percent", aggregation: "weightedRatio", numeratorMetricId: "newPayerCount", denominatorMetricId: "newUsers", sourceApiIds: [overview], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] }
  ,newArpu: { id: "newArpu", name: "新增充值ARPU", unit: "currency", aggregation: "weightedRatio", numeratorMetricId: "newRevenue", denominatorMetricId: "newUsers", sourceApiIds: [overview], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] }
  ,newArppu: { id: "newArppu", name: "新增充值ARPPU", unit: "currency", aggregation: "weightedRatio", numeratorMetricId: "newRevenue", denominatorMetricId: "newPayerCount", sourceApiIds: [overview], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] }
  ,oldRevenue: { id: "oldRevenue", name: "老用户充值金额", unit: "currency", aggregation: "sum", sourceApiIds: [overview], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] }
  ,oldPayerCount: { id: "oldPayerCount", name: "日均老用户充值人数", unit: "person", aggregation: "dailyAverage", sourceApiIds: [overview], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] }
  ,oldPayerUserDays: { id: "oldPayerUserDays", name: "累计老用户付费人天", unit: "person", aggregation: "sum", sourceApiIds: [overview], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] }
  ,oldPayRate: { id: "oldPayRate", name: "老用户充值付费率", unit: "percent", aggregation: "weightedRatio", numeratorMetricId: "oldPayerCount", denominatorMetricId: "oldUsers", sourceApiIds: [overview], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] }
  ,oldArpu: { id: "oldArpu", name: "老用户充值ARPU", unit: "currency", aggregation: "weightedRatio", numeratorMetricId: "oldRevenue", denominatorMetricId: "oldUsers", sourceApiIds: [overview], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] }
  ,oldArppu: { id: "oldArppu", name: "老用户充值ARPPU", unit: "currency", aggregation: "weightedRatio", numeratorMetricId: "oldRevenue", denominatorMetricId: "oldPayerCount", sourceApiIds: [overview], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] }
  ,channelNewRevenue: { id: "channelNewRevenue", name: "渠道新增充值", unit: "currency", aggregation: "sum", sourceApiIds: [overview], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] }
  ,internalNewRevenue: { id: "internalNewRevenue", name: "内部导量充值", unit: "currency", aggregation: "sum", sourceApiIds: [overview], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] }
  ,searchCount: { id: "searchCount", name: "搜索次数", unit: "count", aggregation: "sum", sourceApiIds: ["/api/admin/statistics/hotSearchWords/getMany"], dimensions: ["keyword", "platform"], analysisTypes: ["ranking", "table"] }
  ,videoWatchCount: { id: "videoWatchCount", name: "视频播放次数", unit: "count", aggregation: "sum", sourceApiIds: ["/api/admin/statistics/todayVideos/getMany"], dimensions: ["content", "category", "platform"], analysisTypes: ["metric", "ranking", "table"] }
  ,videoViewerCount: { id: "videoViewerCount", name: "视频观看人数", unit: "person", aggregation: "sum", sourceApiIds: ["/api/admin/statistics/todayVideos/getMany"], dimensions: ["content", "category", "platform"], analysisTypes: ["metric", "ranking", "table"] }
  ,videoLikeCount: { id: "videoLikeCount", name: "视频点赞数", unit: "count", aggregation: "sum", sourceApiIds: ["/api/admin/statistics/todayVideos/getMany"], dimensions: ["content", "category", "platform"], analysisTypes: ["metric", "ranking", "table"] }
  ,videoCollectCount: { id: "videoCollectCount", name: "视频收藏数", unit: "count", aggregation: "sum", sourceApiIds: ["/api/admin/statistics/todayVideos/getMany"], dimensions: ["content", "category", "platform"], analysisTypes: ["metric", "ranking", "table"] }
  ,avgWatchMinutes: { id: "avgWatchMinutes", name: "人均观影时长", unit: "duration", aggregation: "weightedRatio", numeratorMetricId: "watchDuration", denominatorMetricId: "viewerCount", sourceApiIds: ["/api/admin/statistics/todayVideos/getMany", "/api/admin/home/pRealDayLine"], dimensions: ["date", "content", "category", "platform"], analysisTypes: ["metric", "trend", "ranking", "table"] }
  ,retentionD1: { id: "retentionD1", name: "次日留存", unit: "percent", aggregation: "weightedRatio", numeratorMetricId: "retainedUsers", denominatorMetricId: "newUsers", sourceApiIds: ["/api/admin/statistics/reletionsStatPlus/getDays"], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "retention", "table"] }
  ,retentionD3: { id: "retentionD3", name: "D3留存", unit: "percent", aggregation: "weightedRatio", numeratorMetricId: "retainedUsersD3", denominatorMetricId: "newUsers", sourceApiIds: ["/api/admin/statistics/reletionsStatPlus/getDays"], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "retention", "table"] }
  ,retentionD7: { id: "retentionD7", name: "D7留存", unit: "percent", aggregation: "weightedRatio", numeratorMetricId: "retainedUsersD7", denominatorMetricId: "newUsers", sourceApiIds: ["/api/admin/statistics/reletionsStatPlus/getDays"], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "retention", "table"] }
  ,retentionD30: { id: "retentionD30", name: "D30留存", unit: "percent", aggregation: "weightedRatio", numeratorMetricId: "retainedUsersD30", denominatorMetricId: "newUsers", sourceApiIds: ["/api/admin/statistics/reletionsStatPlus/getDays"], dimensions: ["date", "platform"], analysisTypes: ["metric", "trend", "retention", "table"] }
};

export const funnelEvents = {
  payment: ["vip_click", "pre_pay", "success_pay"],
  content: ["active_user", "video_click", "video_play", "video_play_end"]
} as const;

export const modelCapabilities: Record<string, { metrics: string[]; dimensions: string[]; funnelEvents?: readonly string[] }> = {
  business_overview: { metrics: ["dau", "dauUserDays", "newUsers", "payerCount", "payerUserDays", "revenue", "viewRate", "payRate", "arpu", "arppu", "androidDau", "androidDauUserDays", "iosDau", "iosDauUserDays", "androidNewUsers", "iosNewUsers", "organicNewUsers", "internalNewUsers", "adClickCount", "adClickUsers", "adClickUserDays", "adClickRate", "adClickUserRate", "newAdClickCount", "newAdClickUsers", "newAdClickRate", "newAdClickUserRate", "oldAdClickCount", "oldAdClickUsers", "oldAdClickUserDays", "oldAdClickRate", "oldAdClickUserRate", "newRevenue", "newPayerCount", "newPayRate", "newArpu", "newArppu", "oldRevenue", "oldPayerCount", "oldPayerUserDays", "oldPayRate", "oldArpu", "oldArppu", "channelNewRevenue", "internalNewRevenue"], dimensions: ["date", "platform"] },
  platform_compare: { metrics: ["dau", "dauUserDays", "newUsers", "payerCount", "payerUserDays", "revenue", "viewRate", "payRate", "arpu", "arppu", "androidDau", "androidDauUserDays", "iosDau", "iosDauUserDays", "androidNewUsers", "iosNewUsers", "organicNewUsers", "internalNewUsers", "adClickCount", "adClickUsers", "adClickUserDays", "adClickRate", "adClickUserRate", "newAdClickCount", "newAdClickUsers", "newAdClickRate", "newAdClickUserRate", "oldAdClickCount", "oldAdClickUsers", "oldAdClickUserDays", "oldAdClickRate", "oldAdClickUserRate", "newRevenue", "newPayerCount", "newPayRate", "newArpu", "newArppu", "oldRevenue", "oldPayerCount", "oldPayerUserDays", "oldPayRate", "oldArpu", "oldArppu", "channelNewRevenue", "internalNewRevenue"], dimensions: ["date", "platform"] },
  content_position: { metrics: ["videoWatchCount", "videoLikeCount", "videoCollectCount", "revenue"], dimensions: ["platform", "category", "content"], funnelEvents: funnelEvents.content },
  search_demand: { metrics: ["searchCount"], dimensions: ["platform", "keyword"] },
  payment_conversion: { metrics: ["payerCount", "payerUserDays", "payRate", "arpu", "arppu", "newRevenue", "newPayerCount", "newPayRate", "newArpu", "newArppu", "oldRevenue", "oldPayerCount", "oldPayerUserDays", "oldPayRate", "oldArpu", "oldArppu", "channelNewRevenue", "internalNewRevenue"], dimensions: ["date", "platform"], funnelEvents: funnelEvents.payment },
  member_operation: { metrics: ["payerCount", "payerUserDays", "payRate", "arpu", "arppu", "newRevenue", "newPayerCount", "newPayRate", "newArpu", "newArppu", "oldRevenue", "oldPayerCount", "oldPayerUserDays", "oldPayRate", "oldArpu", "oldArppu", "channelNewRevenue", "internalNewRevenue"], dimensions: ["date", "platform"] },
  retention_quality: { metrics: ["newUsers", "retentionD1", "retentionD3", "retentionD7", "retentionD30"], dimensions: ["date", "platform"] },
  usage_depth: { metrics: ["dau", "dauUserDays", "newUsers", "viewerCount", "viewerUserDays", "viewRate", "avgWatchMinutes"], dimensions: ["date", "platform"] },
  acquisition_conversion: { metrics: ["visits", "downloads", "newUsers", "visitDownloadRate", "downloadRegisterRate", "visitRegisterRate"], dimensions: ["date", "platform"] },
  custom_table: { metrics: Object.keys(metrics), dimensions: ["date", "platform"] }
};

export const eventSourceApi = events;
