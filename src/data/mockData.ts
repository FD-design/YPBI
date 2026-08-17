import type { AnalysisModel, DashboardTemplate, EventDefinition, MetricDefinition } from "../types";

export const dates = ["07-04", "07-05", "07-06", "07-07", "07-08", "07-09", "07-10"];

export const platforms = [
  { platform: "Pornhub", dau: 820, newUsers: 183, revenue: 144, viewRate: 93.9, payRate: 3.8, retentionD1: 32.4, arppu: 61 },
  { platform: "TikTok", dau: 277, newUsers: 80, revenue: 46, viewRate: 90.8, payRate: 2.9, retentionD1: 29.8, arppu: 65 },
  { platform: "小红书", dau: 97, newUsers: 24, revenue: 35, viewRate: 88.3, payRate: 5.1, retentionD1: 34.1, arppu: 71 },
  { platform: "色虎", dau: 106, newUsers: 29, revenue: 21, viewRate: 88.8, payRate: 4.2, retentionD1: 35.2, arppu: 60 },
  { platform: "PH·Prem", dau: 91, newUsers: 22, revenue: 29, viewRate: 89.1, payRate: 4.6, retentionD1: 33.2, arppu: 69 },
  { platform: "调教师", dau: 71, newUsers: 34, revenue: 15, viewRate: 84.6, payRate: 1.9, retentionD1: 24.6, arppu: 60 },
  { platform: "快播", dau: 69, newUsers: 20, revenue: 14, viewRate: 86.2, payRate: 2.8, retentionD1: 29.1, arppu: 62 },
  { platform: "黄片网盘", dau: 66, newUsers: 19, revenue: 13, viewRate: 85.8, payRate: 2.7, retentionD1: 28.4, arppu: 61 },
  { platform: "性欲社", dau: 64, newUsers: 18, revenue: 12, viewRate: 85.1, payRate: 2.6, retentionD1: 27.9, arppu: 60 },
  { platform: "抖阴Pro", dau: 61, newUsers: 18, revenue: 12, viewRate: 84.9, payRate: 2.5, retentionD1: 27.6, arppu: 62 },
  { platform: "抖阴Plus", dau: 58, newUsers: 17, revenue: 11, viewRate: 84.5, payRate: 2.5, retentionD1: 27.2, arppu: 61 },
  { platform: "X-chat", dau: 48, newUsers: 17, revenue: 8, viewRate: 82.4, payRate: 2.2, retentionD1: 26.1, arppu: 58 },
  { platform: "白嫖社", dau: 45, newUsers: 15, revenue: 7, viewRate: 82.1, payRate: 2.1, retentionD1: 25.8, arppu: 57 },
  { platform: "好妻网", dau: 42, newUsers: 14, revenue: 7, viewRate: 81.8, payRate: 2.1, retentionD1: 25.5, arppu: 57 },
  { platform: "台姬店", dau: 78, newUsers: 26, revenue: 10, viewRate: 85.4, payRate: 3.4, retentionD1: 38.5, arppu: 74 },
  { platform: "魅魔vlog", dau: 39, newUsers: 13, revenue: 6, viewRate: 81.5, payRate: 2.0, retentionD1: 25.1, arppu: 56 },
  { platform: "稚嫩学园", dau: 36, newUsers: 12, revenue: 6, viewRate: 81.2, payRate: 2.0, retentionD1: 24.9, arppu: 56 },
  { platform: "铁粉空间", dau: 62, newUsers: 28, revenue: 10, viewRate: 86.9, payRate: 2.6, retentionD1: 28.7, arppu: 63 },
  { platform: "精日头条", dau: 32, newUsers: 11, revenue: 5, viewRate: 80.8, payRate: 1.9, retentionD1: 24.5, arppu: 55 },
  { platform: "91淫妻", dau: 29, newUsers: 10, revenue: 5, viewRate: 80.4, payRate: 1.8, retentionD1: 24.1, arppu: 55 }
];

export const contentRows = [
  { platform: "Pornhub", page: "首页", position: "P1", positionRank: 1, category: "推荐", videoCtr: 18.6, playRate: 82.4, completeRate: 37.2, payRate: 4.1, revenue: 18.6 },
  { platform: "Pornhub", page: "详情", position: "P2", positionRank: 2, category: "女优", videoCtr: 14.2, playRate: 76.1, completeRate: 34.8, payRate: 3.8, revenue: 12.4 },
  { platform: "TikTok", page: "短视频", position: "P3", positionRank: 3, category: "剧情", videoCtr: 13.4, playRate: 71.6, completeRate: 29.1, payRate: 2.7, revenue: 7.3 },
  { platform: "色虎", page: "详情", position: "P2", positionRank: 2, category: "国产", videoCtr: 16.8, playRate: 78.2, completeRate: 36.9, payRate: 4.7, revenue: 8.9 },
  { platform: "小红书", page: "搜索", position: "P1", positionRank: 1, category: "角色", videoCtr: 17.9, playRate: 81.4, completeRate: 39.5, payRate: 5.4, revenue: 9.8 },
  { platform: "台姬店", page: "分类", position: "P2", positionRank: 2, category: "日韩", videoCtr: 11.7, playRate: 69.8, completeRate: 27.6, payRate: 3.5, revenue: 4.2 },
  { platform: "调教师", page: "首页", position: "P4", positionRank: 4, category: "调教", videoCtr: 9.6, playRate: 64.1, completeRate: 24.8, payRate: 1.8, revenue: 3.1 },
  { platform: "铁粉空间", page: "搜索", position: "P2", positionRank: 2, category: "制服", videoCtr: 12.1, playRate: 72.5, completeRate: 31.3, payRate: 2.9, revenue: 4.7 },
  { platform: "x-chat", page: "详情", position: "P3", positionRank: 3, category: "直播", videoCtr: 8.8, playRate: 61.2, completeRate: 21.7, payRate: 2.1, revenue: 1.8 }
];

export const searchRows = [
  { keyword: "空姐", platform: "Pornhub", searches: 1650, searchNoResultRate: 26.4, playRate: 64.8, payRate: 3.2, action: "补充供给" },
  { keyword: "N号房", platform: "TikTok", searches: 1218, searchNoResultRate: 31.7, playRate: 57.9, payRate: 2.4, action: "配置替代词" },
  { keyword: "女教师", platform: "色虎", searches: 986, searchNoResultRate: 8.4, playRate: 78.1, payRate: 4.9, action: "增加推荐位" },
  { keyword: "制服", platform: "小红书", searches: 875, searchNoResultRate: 11.2, playRate: 75.3, payRate: 5.6, action: "扩大内容池" },
  { keyword: "调教", platform: "调教师", searches: 760, searchNoResultRate: 5.7, playRate: 82.6, payRate: 3.8, action: "保持供给" },
  { keyword: "直播", platform: "x-chat", searches: 526, searchNoResultRate: 18.9, playRate: 68.7, payRate: 2.7, action: "优化承接页" }
];

export const eventDictionary: EventDefinition[] = [
  { id: "app_start", name: "应用启动", domain: "埋点汇总字段", requiredProperties: ["platform", "date"], description: "getEventStats.appStart，平台日期范围内的启动汇总数。", status: "ready" },
  { id: "active_user", name: "活跃用户", domain: "埋点汇总字段", requiredProperties: ["platform", "date"], description: "getEventStats.activeUser，平台日期范围内的活跃用户汇总。", status: "ready" },
  { id: "registry_user", name: "注册用户", domain: "埋点汇总字段", requiredProperties: ["platform", "date"], description: "getEventStats.registryUser，平台日期范围内的注册用户汇总。", status: "ready" },
  { id: "video_click", name: "视频点击", domain: "内容汇总字段", requiredProperties: ["platform", "date"], description: "getEventStats.videoClick，不含页面、坑位和内容属性。", status: "ready" },
  { id: "video_play", name: "视频播放", domain: "内容汇总字段", requiredProperties: ["platform", "date"], description: "getEventStats.videoPlay，平台级播放汇总。", status: "ready" },
  { id: "video_play_end", name: "播放完成", domain: "内容汇总字段", requiredProperties: ["platform", "date"], description: "getEventStats.videoPlayEnd，平台级播放完成汇总。", status: "ready" },
  { id: "like", name: "点赞", domain: "互动汇总字段", requiredProperties: ["platform", "date"], description: "getEventStats.like。", status: "ready" },
  { id: "collect", name: "收藏", domain: "互动汇总字段", requiredProperties: ["platform", "date"], description: "getEventStats.collect。", status: "ready" },
  { id: "share", name: "分享", domain: "互动汇总字段", requiredProperties: ["platform", "date"], description: "getEventStats.share。", status: "ready" },
  { id: "comments", name: "评论", domain: "互动汇总字段", requiredProperties: ["platform", "date"], description: "getEventStats.comments。", status: "ready" },
  { id: "vip_click", name: "VIP 点击", domain: "支付汇总字段", requiredProperties: ["platform", "date"], description: "getEventStats.vipClick，支付漏斗可用起点。", status: "ready" },
  { id: "pre_pay", name: "拉起支付", domain: "支付汇总字段", requiredProperties: ["platform", "date"], description: "getEventStats.prePay，表示用户已拉起支付流程。", status: "ready" },
  { id: "success_pay", name: "支付成功", domain: "支付汇总字段", requiredProperties: ["platform", "date"], description: "getEventStats.successPay。", status: "ready" },
  { id: "play_error", name: "播放错误", domain: "质量汇总字段", requiredProperties: ["platform", "date"], description: "getEventStats.playError。", status: "ready" },
  { id: "broken", name: "异常中断", domain: "质量汇总字段", requiredProperties: ["platform", "date"], description: "getEventStats.broken。", status: "ready" }
];

export const metricDictionary: MetricDefinition[] = [
  { id: "dau", name: "日均DAU", formula: "sum(日DAU) / 有数据自然日数", source: "pDaySum.loginUserCount", owner: "数据产品", status: "ready", unit: "number", aggregation: "average" },
  { id: "dauUserDays", name: "累计活跃人天", formula: "sum(日DAU)", source: "pDaySum.loginUserCount", owner: "数据产品", status: "ready", unit: "number", aggregation: "sum" },
  { id: "viewerUserDays", name: "累计观影人天", formula: "sum(日观影人数)", source: "pDaySum.watchUserCount", owner: "内容产品", status: "ready", unit: "number", aggregation: "sum" },
  { id: "payerUserDays", name: "累计付费人天", formula: "sum(日付费人数)", source: "pDaySum.totalChargeUserCount", owner: "商业化", status: "ready", unit: "number", aggregation: "sum" },
  { id: "androidDauUserDays", name: "Android累计活跃人天", formula: "sum(Android日活)", source: "pDaySum.androidLoginUserCount", owner: "数据产品", status: "ready", unit: "number", aggregation: "sum" },
  { id: "iosDauUserDays", name: "IOS累计活跃人天", formula: "sum(IOS日活)", source: "pDaySum.iosLoginUserCount", owner: "数据产品", status: "ready", unit: "number", aggregation: "sum" },
  { id: "adClickUserDays", name: "累计广告点击人天", formula: "sum(日广告点击人数)", source: "pDaySum.totalClickedPerson", owner: "商业化", status: "ready", unit: "number", aggregation: "sum" },
  { id: "oldAdClickUserDays", name: "累计老用户广告点击人天", formula: "sum(日老用户广告点击人数)", source: "pDaySum 派生", owner: "商业化", status: "ready", unit: "number", aggregation: "sum" },
  { id: "oldPayerUserDays", name: "累计老用户付费人天", formula: "sum(日老用户付费人数)", source: "pDaySum 派生", owner: "商业化", status: "ready", unit: "number", aggregation: "sum" },
  { id: "newUsers", name: "新增用户", formula: "count_distinct(first_active_user_id)", source: "用户首活", owner: "增长产品", status: "ready", unit: "number", aggregation: "sum" },
  { id: "searchCount", name: "搜索次数", formula: "hotSearchWords.searchCnt", source: "热搜词统计接口", owner: "搜索产品", status: "ready", unit: "number", aggregation: "sum" },
  { id: "revenue", name: "收入", formula: "sum(payment_success.amount)", source: "支付订单", owner: "商业化", status: "ready", unit: "currency", aggregation: "sum" },
  { id: "viewRate", name: "观影率", formula: "play_user_uv / dau", source: "播放 + 活跃", owner: "内容产品", status: "ready", unit: "percent", aggregation: "weighted" },
  { id: "payRate", name: "付费率", formula: "payment_success_uv / dau", source: "支付 + 活跃", owner: "商业化", status: "ready", unit: "percent", aggregation: "weighted" },
  { id: "retentionD1", name: "次留", formula: "D1_return_users / D0_new_users", source: "留存汇总", owner: "增长产品", status: "ready", unit: "percent", aggregation: "weighted" },
  { id: "videoCtr", name: "视频 CTR", formula: "video_click_uv / video_exposure_uv", source: "缺少视频曝光字段", owner: "内容产品", status: "missing", unit: "percent", aggregation: "weighted" },
  { id: "playRate", name: "播放率", formula: "video_play_start_uv / video_click_uv", source: "内容事件", owner: "内容产品", status: "ready", unit: "percent", aggregation: "weighted" },
  { id: "completeRate", name: "完播率", formula: "video_play_complete_uv / video_play_start_uv", source: "播放事件", owner: "内容产品", status: "ready", unit: "percent", aggregation: "weighted" },
  { id: "searchNoResultRate", name: "搜索无结果率", formula: "no_result_search_count / search_submit_count", source: "现有接口未返回结果状态", owner: "搜索产品", status: "missing", unit: "percent", aggregation: "weighted" },
  { id: "arppu", name: "ARPPU", formula: "revenue / paid_users", source: "支付订单", owner: "商业化", status: "ready", unit: "currency", aggregation: "weighted" },
  { id: "avgUsageMinutes", name: "人均使用时长", formula: "foreground_minutes / dau", source: "缺少前台总时长字段", owner: "数据产品", status: "missing", unit: "minutes", aggregation: "weighted" },
  { id: "avgWatchMinutes", name: "人均观影时长", formula: "watch_minutes / viewers", source: "播放进度", owner: "内容产品", status: "partial", unit: "minutes", aggregation: "weighted" },
  { id: "pageViews", name: "页面曝光", formula: "count(page_view)", source: "现有接口未返回页面曝光", owner: "数据产品", status: "missing", unit: "number", aggregation: "sum" },
  { id: "pageClicks", name: "页面点击", formula: "count(element_click)", source: "仅有导航/广告点击，非通用页面点击", owner: "数据产品", status: "missing", unit: "number", aggregation: "sum" },
  { id: "currentPaidMembers", name: "当前付费会员", formula: "count_distinct(active_member_id)", source: "接口字段待确认", owner: "商业化", status: "missing", unit: "number", aggregation: "latest" },
  { id: "historicalPaidMembers", name: "历史付费会员", formula: "count_distinct(ever_paid_user_id)", source: "接口字段待确认", owner: "商业化", status: "missing", unit: "number", aggregation: "latest" },
  { id: "renewalRate", name: "续费率", formula: "renewed_members / expiring_members", source: "现有接口未返回续费分子分母", owner: "商业化", status: "missing", unit: "percent", aggregation: "weighted" }
  ,{ id: "videoWatchCount", name: "视频播放次数", formula: "todayVideos.watchedCount", source: "视频统计接口", owner: "内容产品", status: "ready", unit: "number", aggregation: "sum" }
  ,{ id: "videoViewerCount", name: "视频观看人数", formula: "todayVideos.watchedUserCount", source: "视频统计接口", owner: "内容产品", status: "ready", unit: "number", aggregation: "sum" }
  ,{ id: "videoLikeCount", name: "视频点赞数", formula: "todayVideos.likedCount", source: "视频统计接口", owner: "内容产品", status: "ready", unit: "number", aggregation: "sum" }
  ,{ id: "videoCollectCount", name: "视频收藏数", formula: "todayVideos.collectedCount", source: "视频统计接口", owner: "内容产品", status: "ready", unit: "number", aggregation: "sum" }
  ,{ id: "payerCount", name: "付费人数", formula: "sum(totalChargeUserCount)", source: "pDaySum.totalChargeUserCount", owner: "商业化", status: "ready", unit: "number", aggregation: "sum", description: "日期范围内各日充值人数之和，不代表区间去重付费用户。" }
  ,{ id: "visits", name: "访问", formula: "sum(totalVistCount)", source: "cnzzstatQuery", owner: "增长产品", status: "ready", unit: "number", aggregation: "sum" }
  ,{ id: "downloads", name: "下载", formula: "sum(totalDownCount)", source: "cnzzstatQuery", owner: "增长产品", status: "ready", unit: "number", aggregation: "sum" }
  ,{ id: "visitDownloadRate", name: "访问→下载转化", formula: "sum(downloads) / sum(visits)", source: "cnzzstatQuery", owner: "增长产品", status: "ready", unit: "percent", aggregation: "weighted" }
  ,{ id: "downloadRegisterRate", name: "下载→注册转化", formula: "sum(newUsers) / sum(downloads)", source: "cnzzstatQuery + pDaySum", owner: "增长产品", status: "ready", unit: "percent", aggregation: "weighted", description: "下载与注册统计对象可能不同，超过100%时保留原值并标记口径不可比。" }
  ,{ id: "visitRegisterRate", name: "访问→注册转化", formula: "sum(newUsers) / sum(visits)", source: "cnzzstatQuery + pDaySum", owner: "增长产品", status: "ready", unit: "percent", aggregation: "weighted" }
];

export const analysisModels: AnalysisModel[] = [
  { id: "business_overview", name: "经营总览", description: "基于日汇总与实时趋势接口，查看多平台规模、端别、来源、广告和付费健康度。", eventChain: ["active_user", "video_play", "success_pay"], allowedDimensions: ["date", "platform"], allowedMetrics: ["dau", "dauUserDays", "newUsers", "revenue", "payerCount", "payerUserDays", "viewRate", "payRate", "arpu", "arppu", "androidDau", "androidDauUserDays", "iosDau", "iosDauUserDays", "androidNewUsers", "iosNewUsers", "organicNewUsers", "internalNewUsers", "adClickCount", "adClickUsers", "adClickUserDays", "adClickRate", "adClickUserRate", "newAdClickCount", "newAdClickUsers", "newAdClickRate", "newAdClickUserRate", "oldAdClickCount", "oldAdClickUsers", "oldAdClickUserDays", "oldAdClickRate", "oldAdClickUserRate", "newRevenue", "newPayerCount", "newPayRate", "newArpu", "newArppu", "oldRevenue", "oldPayerCount", "oldPayerUserDays", "oldPayRate", "oldArpu", "oldArppu", "channelNewRevenue", "internalNewRevenue"], defaultDrillPath: ["platform", "date"], recommendedCharts: ["kpi", "line", "bar", "table", "diagnosis"] },
  { id: "platform_compare", name: "平台对比", description: "按 pid 分别请求日汇总数据，最多同时比较 8 个平台。", eventChain: ["active_user", "video_play", "success_pay"], allowedDimensions: ["platform", "date"], allowedMetrics: ["dau", "dauUserDays", "newUsers", "revenue", "payerCount", "payerUserDays", "viewRate", "payRate", "arpu", "arppu", "androidDau", "androidDauUserDays", "iosDau", "iosDauUserDays", "organicNewUsers", "internalNewUsers", "adClickUserDays", "oldAdClickUserDays", "oldPayerUserDays", "adClickRate", "newPayRate"], defaultDrillPath: ["platform", "date"], recommendedCharts: ["bar", "scatter", "line", "table"] },
  { id: "content_position", name: "视频内容表现", description: "基于视频观看排行接口分析播放、点赞、收藏和收入；当前不支持页面和坑位拆分。", eventChain: ["active_user", "video_click", "video_play", "video_play_end"], allowedDimensions: ["date", "platform", "category", "content"], allowedMetrics: ["videoWatchCount", "videoLikeCount", "videoCollectCount", "revenue"], defaultDrillPath: ["category", "content"], recommendedCharts: ["kpi", "bar", "treemap", "table", "funnel", "line"] },
  { id: "search_demand", name: "热搜词排行", description: "现有接口仅支持按平台读取搜索词和搜索次数，不展示虚构的搜索转化。", eventChain: [], allowedDimensions: ["platform", "keyword"], allowedMetrics: ["searchCount"], defaultDrillPath: ["keyword", "platform"], recommendedCharts: ["bar", "table"] },
  { id: "payment_conversion", name: "支付汇总漏斗", description: "基于埋点汇总字段查看 VIP 点击、拉起支付和支付成功，并分析新老用户付费质量。", eventChain: ["vip_click", "pre_pay", "success_pay"], allowedDimensions: ["platform", "date"], allowedMetrics: ["payerCount", "payerUserDays", "payRate", "revenue", "arpu", "arppu", "newRevenue", "newPayerCount", "newPayRate", "newArpu", "newArppu", "oldRevenue", "oldPayerCount", "oldPayerUserDays", "oldPayRate", "oldArpu", "oldArppu", "channelNewRevenue", "internalNewRevenue"], defaultDrillPath: ["platform", "date"], recommendedCharts: ["funnel", "line", "kpi", "table"] },
  { id: "member_operation", name: "会员收入概览", description: "展示已确认的收入、ARPU、ARPPU 和新增付费指标；会员存量、档位和续费字段等待接口口径确认。", eventChain: [], allowedDimensions: ["platform", "date"], allowedMetrics: ["revenue", "payerCount", "payerUserDays", "payRate", "arpu", "arppu", "newRevenue", "newPayerCount", "newPayRate", "newArpu", "newArppu", "oldPayerCount", "oldPayerUserDays"], defaultDrillPath: ["platform", "date"], recommendedCharts: ["kpi", "line", "table"] },
  { id: "retention_quality", name: "留存质量", description: "基于关系留存接口查看平台 D1、D3、D7 和 D30 cohort。", eventChain: ["registry_user", "active_user"], allowedDimensions: ["date", "platform"], allowedMetrics: ["newUsers", "retentionD1", "retentionD3", "retentionD7", "retentionD30"], defaultDrillPath: ["date", "platform"], recommendedCharts: ["cohort", "line", "table", "kpi"] },
  { id: "usage_depth", name: "24小时使用深度", description: "基于五分钟时点数据对比两个周期结束日的登录、新增、观影及观看深度。", eventChain: ["active_user", "video_play", "video_play_end"], allowedDimensions: ["date", "platform"], allowedMetrics: ["dau", "dauUserDays", "newUsers", "viewerCount", "viewerUserDays", "viewRate", "avgWatchMinutes"], defaultDrillPath: ["platform", "date"], recommendedCharts: ["kpi", "line", "bar", "table"] },
  { id: "acquisition_conversion", name: "获客转化", description: "联合访问下载与日新增接口，按平台和日期分析访问、下载、注册及加权转化。", eventChain: [], allowedDimensions: ["date", "platform"], allowedMetrics: ["visits", "downloads", "newUsers", "visitDownloadRate", "downloadRegisterRate", "visitRegisterRate"], defaultDrillPath: ["platform", "date"], recommendedCharts: ["kpi", "line", "bar", "table"] },
  { id: "custom_table", name: "接口字段统计表", description: "在同一个 API 返回范围内组合维度和指标，覆盖端别、来源、广告和新老用户付费。", eventChain: [], allowedDimensions: ["date", "platform"], allowedMetrics: ["dau", "dauUserDays", "newUsers", "payerCount", "payerUserDays", "revenue", "viewRate", "payRate", "arpu", "arppu", "androidDau", "androidDauUserDays", "iosDau", "iosDauUserDays", "androidNewUsers", "iosNewUsers", "organicNewUsers", "internalNewUsers", "adClickCount", "adClickUsers", "adClickUserDays", "adClickRate", "adClickUserRate", "newAdClickCount", "newAdClickUsers", "newAdClickRate", "newAdClickUserRate", "oldAdClickCount", "oldAdClickUsers", "oldAdClickUserDays", "oldAdClickRate", "oldAdClickUserRate", "newRevenue", "newPayerCount", "newPayRate", "newArpu", "newArppu", "oldRevenue", "oldPayerCount", "oldPayerUserDays", "oldPayRate", "oldArpu", "oldArppu", "channelNewRevenue", "internalNewRevenue"], defaultDrillPath: ["platform", "date"], recommendedCharts: ["table", "bar", "line"] }
];

export const dashboardTemplates: DashboardTemplate[] = [
  {
    id: "overview", name: "多平台经营总览", scenario: "每天快速判断整体经营健康、平台差异和异常来源。", model: "business_overview", filters: ["date", "platform"], status: "published", updatedAt: "2026-07-10 09:32",
    cards: [
      { id: "kpi-main", title: "核心经营指标", type: "kpi", model: "business_overview", metrics: ["dau", "newUsers", "viewRate", "payRate"], dimensions: ["platform"], size: "full" },
      { id: "period-cumulative", title: "周期累计规模", type: "kpi", model: "business_overview", metrics: ["dauUserDays", "newUsers", "payerUserDays", "adClickUserDays"], dimensions: ["platform"], size: "full", drillPath: ["platform", "date"] },
      { id: "payment-scale", title: "付费规模与效率", type: "kpi", model: "business_overview", metrics: ["payerCount", "revenue", "payRate", "arppu"], dimensions: ["platform"], size: "full", drillPath: ["platform", "date"] },
      { id: "trend", title: "活跃与新增趋势", type: "line", model: "business_overview", metrics: ["dau", "newUsers"], dimensions: ["date"], size: "lg", drillPath: ["date", "platform"] },
      { id: "device-structure", title: "终端活跃与新增结构", type: "bar", model: "business_overview", metrics: ["androidDau", "iosDau", "androidNewUsers", "iosNewUsers"], dimensions: ["platform"], size: "full", drillPath: ["platform", "date"] },
      { id: "growth-source", title: "新增来源规模与收入", type: "bar", model: "business_overview", metrics: ["organicNewUsers", "internalNewUsers", "channelNewRevenue", "internalNewRevenue"], dimensions: ["platform"], size: "full", drillPath: ["platform", "date"] },
      { id: "ad-engagement", title: "新老用户广告表现", type: "line", model: "business_overview", metrics: ["newAdClickRate", "newAdClickUserRate", "oldAdClickRate", "oldAdClickUserRate"], dimensions: ["date", "platform"], size: "full", drillPath: ["platform", "date"] },
      { id: "old-user-payment", title: "老用户充值质量", type: "kpi", model: "business_overview", metrics: ["oldRevenue", "oldPayerCount", "oldPayRate", "oldArpu", "oldArppu"], dimensions: ["platform"], size: "full", drillPath: ["platform", "date"] },
      { id: "new-payment-quality", title: "新增用户付费质量", type: "bar", model: "business_overview", metrics: ["newPayRate", "newArpu", "newArppu"], dimensions: ["platform"], size: "full", drillPath: ["platform", "date"] },
      { id: "platform-rank", title: "平台活跃用户排行", type: "bar", model: "platform_compare", metrics: ["dau"], dimensions: ["platform"], size: "md", drillPath: ["platform"] },
      { id: "platform-map", title: "平台规模 × 付费效率", type: "scatter", model: "platform_compare", metrics: ["dau", "payRate"], dimensions: ["platform"], size: "md", drillPath: ["platform"] },
      { id: "retention-mini", title: "平台次留趋势", type: "line", model: "retention_quality", metrics: ["retentionD1"], dimensions: ["date", "platform"], size: "lg", drillPath: ["platform", "date"] },
      { id: "alerts", title: "经营异常诊断", type: "diagnosis", model: "business_overview", metrics: ["dau", "payRate", "viewRate"], dimensions: ["platform"], size: "full" }
    ]
  },
  {
    id: "content", name: "视频内容表现", scenario: "基于已有视频、分类和埋点汇总接口判断内容消费与收入表现。", model: "content_position", filters: ["date", "platform", "category"], status: "published", updatedAt: "2026-07-10 09:28",
    cards: [
      { id: "content-kpi", title: "内容消费质量", type: "kpi", model: "content_position", metrics: ["videoWatchCount", "videoLikeCount", "videoCollectCount"], dimensions: ["platform"], size: "full" },
      { id: "category-rank", title: "视频播放表现排行", type: "bar", model: "content_position", metrics: ["videoWatchCount"], dimensions: ["content"], size: "lg" },
      { id: "content-funnel", title: "内容消费汇总漏斗", type: "funnel", model: "content_position", metrics: ["viewRate", "playRate", "completeRate"], dimensions: ["platform"], size: "full", funnelSteps: ["active_user", "video_click", "video_play", "video_play_end"], conversionWindow: "接口日期范围" },
      { id: "content-tree", title: "视频播放贡献", type: "treemap", model: "content_position", metrics: ["videoWatchCount"], dimensions: ["category", "content"], size: "md" },
      { id: "content-table", title: "视频内容统计表", type: "table", model: "content_position", metrics: ["videoWatchCount", "videoLikeCount", "videoCollectCount"], dimensions: ["category", "content"], size: "full", limit: 20 }
    ]
  },
  {
    id: "search", name: "热搜词分析", scenario: "基于热搜词接口查看各平台搜索量排行；当前不推断无结果和后续转化。", model: "search_demand", filters: ["platform", "keyword"], status: "published", updatedAt: "2026-07-10 09:16",
    cards: [
      { id: "search-rank", title: "搜索词 Top 20", type: "bar", model: "search_demand", metrics: ["searchCount"], dimensions: ["keyword"], size: "lg" },
      { id: "search-platform", title: "平台搜索量对比", type: "bar", model: "search_demand", metrics: ["searchCount"], dimensions: ["platform"], size: "md" },
      { id: "search-table", title: "热搜词统计表", type: "table", model: "search_demand", metrics: ["searchCount"], dimensions: ["keyword", "platform"], size: "full", limit: 12 }
    ]
  },
  {
    id: "payment", name: "支付汇总分析", scenario: "基于已有埋点汇总与日汇总接口查看支付转化；不展示接口未支持的通道和套餐拆分。", model: "payment_conversion", filters: ["date", "platform"], status: "published", updatedAt: "2026-07-10 09:04",
    cards: [
      { id: "member-kpi", title: "支付效率指标", type: "kpi", model: "member_operation", metrics: ["payRate"], dimensions: ["platform"], size: "full" },
      { id: "payment-funnel", title: "支付汇总漏斗", type: "funnel", model: "payment_conversion", metrics: ["payRate"], dimensions: ["platform"], size: "lg", funnelSteps: ["vip_click", "pre_pay", "success_pay"], conversionWindow: "接口日期范围" },
      { id: "payment-trend", title: "付费率趋势", type: "line", model: "payment_conversion", metrics: ["payRate"], dimensions: ["date"], size: "md" },
      { id: "payment-table", title: "平台付费率明细", type: "table", model: "payment_conversion", metrics: ["payRate"], dimensions: ["platform", "date"], size: "full", limit: 8 }
    ]
  },
  {
    id: "retention", name: "留存与使用深度", scenario: "用 cohort 和使用深度判断新增质量、回访和内容黏性。", model: "retention_quality", filters: ["date", "platform", "appVersion"], status: "published", updatedAt: "2026-07-10 08:55",
    cards: [
      { id: "usage-kpi", title: "观看深度指标", type: "kpi", model: "usage_depth", metrics: ["dau", "viewRate", "avgWatchMinutes"], dimensions: ["platform"], size: "full" },
      { id: "realtime-login-24h", title: "24小时登录用户曲线", type: "line", model: "usage_depth", metrics: ["dau"], dimensions: ["date", "platform"], size: "md", platformMode: "single", platforms: ["Pornhub"], drillPath: ["platform", "date"] },
      { id: "realtime-new-24h", title: "24小时新增用户曲线", type: "line", model: "usage_depth", metrics: ["newUsers"], dimensions: ["date", "platform"], size: "md", platformMode: "single", platforms: ["Pornhub"], drillPath: ["platform", "date"] },
      { id: "realtime-viewer-24h", title: "24小时观影用户曲线", type: "line", model: "usage_depth", metrics: ["viewerCount"], dimensions: ["date", "platform"], size: "md", platformMode: "single", platforms: ["Pornhub"], drillPath: ["platform", "date"] },
      { id: "cohort", title: "新增用户 Cohort 留存", type: "cohort", model: "retention_quality", metrics: ["retentionD1", "retentionD3", "retentionD7", "retentionD30"], dimensions: ["date", "platform"], size: "full" },
      { id: "usage-trend", title: "人均观影时长趋势", type: "line", model: "usage_depth", metrics: ["avgWatchMinutes"], dimensions: ["date"], size: "lg" },
      { id: "view-rate-rank", title: "平台观影率", type: "bar", model: "usage_depth", metrics: ["viewRate"], dimensions: ["platform"], size: "md" },
      { id: "retention-table", title: "留存平台明细", type: "table", model: "retention_quality", metrics: ["newUsers", "retentionD1", "retentionD3", "retentionD7", "retentionD30"], dimensions: ["platform", "date"], size: "full", limit: 30 }
    ]
  },
  {
    id: "acquisition", name: "获客转化分析", scenario: "从访问、下载到注册观察多平台获客规模、同期变化和口径异常。", model: "acquisition_conversion", filters: ["date", "platform"], status: "published", updatedAt: "2026-07-23 12:00",
    cards: [
      { id: "acquisition-kpi", title: "获客核心同期对比", type: "kpi", model: "acquisition_conversion", metrics: ["visits", "downloads", "newUsers", "visitDownloadRate"], dimensions: ["platform"], size: "full", drillPath: ["platform", "date"] },
      { id: "acquisition-trend", title: "访问、下载与注册趋势", type: "line", model: "acquisition_conversion", metrics: ["visits", "downloads", "newUsers"], dimensions: ["date", "platform"], size: "full", drillPath: ["date", "platform"] },
      { id: "acquisition-rate", title: "平台获客转化对比", type: "bar", model: "acquisition_conversion", metrics: ["visitDownloadRate", "downloadRegisterRate", "visitRegisterRate"], dimensions: ["platform"], size: "full", drillPath: ["platform", "date"] },
      { id: "acquisition-table", title: "获客转化明细", type: "table", model: "acquisition_conversion", metrics: ["visits", "downloads", "newUsers", "visitDownloadRate", "downloadRegisterRate", "visitRegisterRate"], dimensions: ["platform", "date"], size: "full", limit: 50 }
    ]
  }
];
