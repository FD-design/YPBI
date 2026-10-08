import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import plan from "../../contracts/official-dashboards.json";
import { DAILY_DASHBOARD_VERSION, DAILY_STATISTICS_VERSION, dailyDashboardV2SuccessSchema, type DailyDashboardQuery, type DailyDashboardSuccess, type DailyDashboardV2Success, type DailyPeriodStatistics, type DailyReadingMetric } from "../../contracts/daily-dashboard";
import { getV2MetricDefinition } from "./metric-definitions";
import { P_DAY_SUM_API } from "../upstream/overview.adapter";
import { RETENTION_PLUS_API } from "../upstream/retention.adapter";
import { REALTIME_API } from "../upstream/realtime.adapter";
import { readWatchAttemptDay, type WatchAttemptDay } from "../upstream/watch-daily.adapter";
import { BI_V1_PLAYBACK_API, readBiV1PlaybackDays, type BiV1PlaybackDay } from "../upstream/bi-v1.adapter";
import { BI_V1_METRICS_API, biV1MetricKey, readBiV1MetricDays, type BiV1MetricCode, type BiV1MetricDay, type BiV1MetricUnit, type BiV1MetricDimensionFilters, type BiV1MetricDimension } from "../upstream/bi-v1.metrics-adapter";
import { readBiV1MonthlyMetricDays } from "../upstream/bi-v1.monthly-adapter";
export const CHANNEL_V2_API = "/api/admin/statistics/channel/channelStatByTypeV2";
export const PAYMENT_RATE_API = "/api/admin/consumptionMgr/payChannel/getRechargeSucRate";
export const CHECKIN_OVERVIEW_API = "/api/admin/dataDashboard/overview";
import { UpstreamError, type UpstreamClient } from "../upstream/client";
import { toBeijingDate } from "../upstream/date";

// Candidate projections are isolated from formal release-admission registries.
const AMOUNT_UNIT = "元";
const AMOUNT_PER_USER_UNIT = `${AMOUNT_UNIT}/人`;
const WATCH_TIME_NOTE = "接口记录时长，暂按秒换算，未额外剔除暂停、缓冲及后台时间；字段单位、完整性和区间去重分母待验数。";
const baseMappings = {
  M034: { fields: ["effectivePlayCount"], inputIds: ["M034"], inputNames: ["有效观看次数"], inputUnits: ["次"], unit: "次", biV1Playback: true, formula: "各视频类型有效观看次数之和", sourceNote: "来自 bi-v1 播放域；仅展示 READY 结果，其他状态保留为数据状态，不补 0。" },
  M036: { fields: ["effectivePlayCount", "successfulStartCount"], inputIds: ["M034", "M097"], inputNames: ["有效观看次数", "成功起播次数"], inputUnits: ["次", "次"], unit: "%", biV1Playback: true, formula: "有效观看次数 ÷ 成功起播次数 × 100%", sourceNote: "来自 bi-v1 播放域；先汇总各视频类型的分子、分母再计算，不平均分类比率或日比率。" },
  M097: { fields: ["successfulStartCount"], inputIds: ["M097"], inputNames: ["成功起播次数"], inputUnits: ["次"], unit: "次", biV1Playback: true, formula: "各视频类型成功起播次数之和", sourceNote: "来自 bi-v1 播放域；仅展示 READY 结果，其他状态保留为数据状态，不补 0。" },
  M101: { fields: ["watchCount"], inputIds: ["M101"], inputNames: ["播放发起次数"], inputUnits: ["次"], unit: "次", realtime: true, biV1Metric: "M101", formula: "同一业务日完整 288 个五分钟统计点的播放发起次数之和", definition: "所选平台单日后台记录的视频播放发起次数。", sourceNote: "优先读取 bi-v1 的同口径观影次数；旧接口仅在新来源不可用时读取完整、无重复的 288 个五分钟统计点。非 READY 结果保留来源状态，不补0。" },
  M102: { fields: ["totalUserWatchTime"], inputIds: ["M102"], inputNames: ["接口记录观影时长"], inputUnits: ["秒（暂定）"], unit: "小时", channel: true, resultDivisor: 3600, formula: "接口记录观影时长（暂按秒） ÷ 3600", definition: "所选平台单日接口记录的观影时长总和，暂按秒换算为小时；未额外剔除暂停、缓冲及后台时间。", sourceNote: WATCH_TIME_NOTE },
  M098: { fields: ["totalUserWatchTime", "watchUserCount"], inputIds: ["M102", "M026"], inputNames: ["接口记录观影时长", "同范围观影用户数"], inputUnits: ["秒（暂定）", "人"], unit: "分钟/人", channel: true, resultDivisor: 60, formula: "接口记录观影时长（暂按秒） ÷ 同范围观影用户数 ÷ 60", definition: "所选平台单日接口记录观影时长除以同源观影用户数，换算为分钟/人；未额外剔除暂停、缓冲及后台时间。", sourceNote: WATCH_TIME_NOTE },
  M075: { fields: ["signInRate.raw.signed"], inputIds: ["M075"], inputNames: ["当日签到人数"], unit: "人", checkin: true },
  M018: { fields: ["monthlyActiveUserCount"], inputIds: ["M018"], inputNames: ["自然月内成功登录去重用户数"], unit: "人", biV1Metric: "M018", biV1Only: true, sourceNote: "来自 bi-v1 自然月汇总；历史月份查询完整自然月，当前月查询至已结束业务日。每月仅保留一个月值，不累加日活，不生成每日月活趋势。" },
  "M016.new": { referenceMetricId: "M016", name: "日活跃用户数（新用户）", fields: ["newUserLoginUserCount"], inputIds: ["M016"], inputNames: ["新用户日活跃用户数"], unit: "人", biV1Metric: "M016", biV1Dimensions: ["new"], biV1Only: true },
  "M016.androidNew": { referenceMetricId: "M016", name: "日活跃用户数（Android新用户）", fields: ["androidNewUserLoginUserCount"], inputIds: ["M016"], inputNames: ["Android新用户日活跃用户数"], unit: "人", biV1Metric: "M016", biV1Dimensions: ["android", "new"], biV1Only: true },
  "M016.iosNew": { referenceMetricId: "M016", name: "日活跃用户数（iOS新用户）", fields: ["iosNewUserLoginUserCount"], inputIds: ["M016"], inputNames: ["iOS新用户日活跃用户数"], unit: "人", biV1Metric: "M016", biV1Dimensions: ["ios", "new"], biV1Only: true },
  "M016.androidOld": { referenceMetricId: "M016", name: "日活跃用户数（Android老用户）", fields: ["androidOldUserLoginUserCount"], inputIds: ["M016"], inputNames: ["Android老用户日活跃用户数"], unit: "人", biV1Metric: "M016", biV1Dimensions: ["android", "old"], biV1Only: true },
  "M016.iosOld": { referenceMetricId: "M016", name: "日活跃用户数（iOS老用户）", fields: ["iosOldUserLoginUserCount"], inputIds: ["M016"], inputNames: ["iOS老用户日活跃用户数"], unit: "人", biV1Metric: "M016", biV1Dimensions: ["ios", "old"], biV1Only: true },
  "M026.old": { referenceMetricId: "M026", name: "观影用户数（老用户）", fields: ["oldUserWatchUserCount"], inputIds: ["M026"], inputNames: ["老用户观影人数"], unit: "人", channel: true, biV1Metric: "M026", biV1Dimensions: ["old"] },
  "M026.androidNew": { referenceMetricId: "M026", name: "观影用户数（Android新用户）", fields: ["androidNewUserWatchUserCount"], inputIds: ["M026"], inputNames: ["Android新用户观影人数"], unit: "人", biV1Metric: "M026", biV1Dimensions: ["android", "new"], biV1Only: true },
  "M026.iosNew": { referenceMetricId: "M026", name: "观影用户数（iOS新用户）", fields: ["iosNewUserWatchUserCount"], inputIds: ["M026"], inputNames: ["iOS新用户观影人数"], unit: "人", biV1Metric: "M026", biV1Dimensions: ["ios", "new"], biV1Only: true },
  "M026.androidOld": { referenceMetricId: "M026", name: "观影用户数（Android老用户）", fields: ["androidOldUserWatchUserCount"], inputIds: ["M026"], inputNames: ["Android老用户观影人数"], unit: "人", biV1Metric: "M026", biV1Dimensions: ["android", "old"], biV1Only: true },
  "M026.iosOld": { referenceMetricId: "M026", name: "观影用户数（iOS老用户）", fields: ["iosOldUserWatchUserCount"], inputIds: ["M026"], inputNames: ["iOS老用户观影人数"], unit: "人", biV1Metric: "M026", biV1Dimensions: ["ios", "old"], biV1Only: true },
  "M081.old": { referenceMetricId: "M081", name: "活跃用户观影率（老用户）", fields: ["oldUserWatchUserCount", "oldUserLoginUserCount"], inputIds: ["M026", "M016"], inputNames: ["老用户观影人数", "老用户活跃人数"], unit: "%", channel: true, biV1Metric: "M081", biV1Dimensions: ["old"] },
  "M081.new": { referenceMetricId: "M081", name: "活跃用户观影率（新用户）", fields: ["newUserWatchUserCount", "newUserLoginUserCount"], inputIds: ["M026", "M016"], inputNames: ["新用户观影人数", "新用户活跃人数"], unit: "%", biV1Metric: "M081", biV1Dimensions: ["new"], biV1Only: true },
  "M081.androidNew": { referenceMetricId: "M081", name: "活跃用户观影率（Android新用户）", fields: ["androidNewUserWatchUserCount", "androidNewUserLoginUserCount"], inputIds: ["M026", "M016"], inputNames: ["Android新用户观影人数", "Android新用户活跃人数"], unit: "%", biV1Metric: "M081", biV1Dimensions: ["android", "new"], biV1Only: true },
  "M081.iosNew": { referenceMetricId: "M081", name: "活跃用户观影率（iOS新用户）", fields: ["iosNewUserWatchUserCount", "iosNewUserLoginUserCount"], inputIds: ["M026", "M016"], inputNames: ["iOS新用户观影人数", "iOS新用户活跃人数"], unit: "%", biV1Metric: "M081", biV1Dimensions: ["ios", "new"], biV1Only: true },
  "M081.androidOld": { referenceMetricId: "M081", name: "活跃用户观影率（Android老用户）", fields: ["androidOldUserWatchUserCount", "androidOldUserLoginUserCount"], inputIds: ["M026", "M016"], inputNames: ["Android老用户观影人数", "Android老用户活跃人数"], unit: "%", biV1Metric: "M081", biV1Dimensions: ["android", "old"], biV1Only: true },
  "M081.iosOld": { referenceMetricId: "M081", name: "活跃用户观影率（iOS老用户）", fields: ["iosOldUserWatchUserCount", "iosOldUserLoginUserCount"], inputIds: ["M026", "M016"], inputNames: ["iOS老用户观影人数", "iOS老用户活跃人数"], unit: "%", biV1Metric: "M081", biV1Dimensions: ["ios", "old"], biV1Only: true },
  "M112": {"referenceMetricId":"M112","name":"支付订单获取次数","fields":["totalAllCount"],"inputIds":["M112"],"inputNames":["支付订单获取次数"],"unit":"次","payment":true,"biV1Metric":"M112"},
  "M113": {"referenceMetricId":"M113","name":"支付订单获取用户数","fields":["orderFetchUserCount"],"inputIds":["M113"],"inputNames":["支付订单获取用户数"],"inputUnits":["人"],"unit":"人","biV1Metric":"M113","biV1Only":true,"sourceNote":"来自 bi-v1 支付域；按登录账号去重。仅展示接口返回的真实状态和 READY 结果，不用支付订单获取次数或旧支付汇总推算。"},
  "M060": {"referenceMetricId":"M060","name":"支付成功订单数","fields":["totalSurCount"],"inputIds":["M060"],"inputNames":["支付成功订单数"],"unit":"次","payment":true,"biV1Metric":"M060"},
  "M114": {"referenceMetricId":"M114","name":"订单获取-支付成功转化率","fields":["totalSurCount","totalAllCount"],"inputIds":["M114","M114"],"inputNames":["同日支付成功订单数","同日支付订单获取次数"],"unit":"%","payment":true,"biV1Metric":"M114"},
  "M084": {"referenceMetricId":"M084","name":"支付提交次数","fields":["paymentSubmitCount"],"inputIds":["M084"],"inputNames":["支付提交次数"],"inputUnits":["次"],"unit":"次","biV1Metric":"M084","biV1Only":true,"sourceNote":"来自 bi-v1 支付域；按有效支付提交请求计数。仅展示接口返回的真实状态和 READY 结果，不用拉单次数替代。"},
  "M086": {"referenceMetricId":"M086","name":"充值到账订单数","fields":["creditedOrderCount"],"inputIds":["M086"],"inputNames":["充值到账订单数"],"inputUnits":["单"],"unit":"单","biV1Metric":"M086","biV1Only":true,"sourceNote":"来自 bi-v1 支付域；以正式到账成功终态为准。仅展示接口返回的真实状态和 READY 结果，不用第三方支付成功订单数替代。"},
  "M090": {"referenceMetricId":"M090","name":"支付提交-充值到账转化率","fields":["creditedSubmitCount","matureSubmitCount"],"inputIds":["M086","M084"],"inputNames":["最终到账的支付提交请求数","已结束观察窗口的支付提交请求数"],"inputUnits":["次","次"],"unit":"%","biV1Metric":"M090","biV1Only":true,"sourceNote":"来自 bi-v1 支付域；按支付提交请求追踪最终到账，并保留观察中、超时和迟到到账状态。BI 不用同期阶段量自行相除。"},
  "M112.alipay": { referenceMetricId: "M112", name: "支付订单获取次数（支付宝）", fields: ["alipayOrderFetchCount"], inputIds: ["M112"], inputNames: ["支付订单获取次数（支付宝）"], unit: "次", biV1Metric: "M112", biV1Dimensions: ["alipay"], biV1Only: true },
  "M113.alipay": { referenceMetricId: "M113", name: "支付订单获取用户数（支付宝）", fields: ["alipayOrderFetchUserCount"], inputIds: ["M113"], inputNames: ["支付订单获取用户数（支付宝）"], unit: "人", biV1Metric: "M113", biV1Dimensions: ["alipay"], biV1Only: true },
  "M060.alipay": { referenceMetricId: "M060", name: "支付成功订单数（支付宝）", fields: ["alipayPaidOrderCount"], inputIds: ["M060"], inputNames: ["支付成功订单数（支付宝）"], unit: "次", biV1Metric: "M060", biV1Dimensions: ["alipay"], biV1Only: true },
  "M114.alipay": { referenceMetricId: "M114", name: "订单获取-支付成功转化率（支付宝）", fields: ["alipayPaidOrderCount", "alipayOrderFetchCount"], inputIds: ["M060", "M112"], inputNames: ["支付成功订单数（支付宝）", "支付订单获取次数（支付宝）"], inputUnits: ["次", "次"], unit: "%", biV1Metric: "M114", biV1Dimensions: ["alipay"], biV1Only: true },
  "M112.wechat": { referenceMetricId: "M112", name: "支付订单获取次数（微信）", fields: ["wechatOrderFetchCount"], inputIds: ["M112"], inputNames: ["支付订单获取次数（微信）"], unit: "次", biV1Metric: "M112", biV1Dimensions: ["wechat"], biV1Only: true },
  "M113.wechat": { referenceMetricId: "M113", name: "支付订单获取用户数（微信）", fields: ["wechatOrderFetchUserCount"], inputIds: ["M113"], inputNames: ["支付订单获取用户数（微信）"], unit: "人", biV1Metric: "M113", biV1Dimensions: ["wechat"], biV1Only: true },
  "M060.wechat": { referenceMetricId: "M060", name: "支付成功订单数（微信）", fields: ["wechatPaidOrderCount"], inputIds: ["M060"], inputNames: ["支付成功订单数（微信）"], unit: "次", biV1Metric: "M060", biV1Dimensions: ["wechat"], biV1Only: true },
  "M114.wechat": { referenceMetricId: "M114", name: "订单获取-支付成功转化率（微信）", fields: ["wechatPaidOrderCount", "wechatOrderFetchCount"], inputIds: ["M060", "M112"], inputNames: ["支付成功订单数（微信）", "支付订单获取次数（微信）"], inputUnits: ["次", "次"], unit: "%", biV1Metric: "M114", biV1Dimensions: ["wechat"], biV1Only: true },
  "M112.usdt": { referenceMetricId: "M112", name: "支付订单获取次数（USDT）", fields: ["usdtOrderFetchCount"], inputIds: ["M112"], inputNames: ["支付订单获取次数（USDT）"], unit: "次", biV1Metric: "M112", biV1Dimensions: ["usdt"], biV1Only: true },
  "M113.usdt": { referenceMetricId: "M113", name: "支付订单获取用户数（USDT）", fields: ["usdtOrderFetchUserCount"], inputIds: ["M113"], inputNames: ["支付订单获取用户数（USDT）"], unit: "人", biV1Metric: "M113", biV1Dimensions: ["usdt"], biV1Only: true },
  "M060.usdt": { referenceMetricId: "M060", name: "支付成功订单数（USDT）", fields: ["usdtPaidOrderCount"], inputIds: ["M060"], inputNames: ["支付成功订单数（USDT）"], unit: "次", biV1Metric: "M060", biV1Dimensions: ["usdt"], biV1Only: true },
  "M114.usdt": { referenceMetricId: "M114", name: "订单获取-支付成功转化率（USDT）", fields: ["usdtPaidOrderCount", "usdtOrderFetchCount"], inputIds: ["M060", "M112"], inputNames: ["支付成功订单数（USDT）", "支付订单获取次数（USDT）"], inputUnits: ["次", "次"], unit: "%", biV1Metric: "M114", biV1Dimensions: ["usdt"], biV1Only: true },
  "M008.nature": { "referenceMetricId": "M008", "name": "新增用户数（自然新增）", "fields": ["natureRegisterCount"], "inputIds": ["M008"], "inputNames": ["自然新增用户数"], "unit": "人", "channel": true, "allowAboveOne": false, "biV1Metric": "M008", "biV1Dimensions": ["natural"], "biV1Only": true },
  "M008.internal": { "referenceMetricId": "M008", "name": "新增用户数（内部导量）", "fields": ["channelInternalRegisterCount"], "inputIds": ["M008"], "inputNames": ["内部标识注册用户数"], "unit": "人", "channel": true, "allowAboveOne": false, "biV1Metric": "M008", "biV1Dimensions": ["internal"], "biV1Only": true },
  "M058.nature": {"referenceMetricId":"M058","name":"充值金额（自然新增）","fields":["natureChargeAmt"],"inputIds":["M058"],"inputNames":["自然新增充值金额"],"unit":AMOUNT_UNIT,"channel":true,"allowAboveOne":false},
  "M058.internal": {"referenceMetricId":"M058","name":"充值金额（内部导量）","fields":["channelInternalChargeAmt"],"inputIds":["M058"],"inputNames":["内部标识新增充值金额"],"unit":AMOUNT_UNIT,"channel":true,"allowAboveOne":false},
  "M065": {"referenceMetricId":"M065","name":"VIP充值金额","fields":["vipChargeAmt"],"inputIds":["M065"],"inputNames":["VIP充值金额"],"unit":AMOUNT_UNIT,"channel":true,"allowAboveOne":false},
  "M066": {"referenceMetricId":"M066","name":"金币充值金额","fields":["goldChargeAmt"],"inputIds":["M066"],"inputNames":["金币充值金额"],"unit":AMOUNT_UNIT,"channel":true,"allowAboveOne":false},
  "M065.new": {"referenceMetricId":"M065","name":"VIP充值金额（新用户）","fields":["newUserVipChargeAmt"],"inputIds":["M065"],"inputNames":["新用户VIP充值金额"],"unit":AMOUNT_UNIT,"channel":true,"allowAboveOne":false},
  "M066.new": {"referenceMetricId":"M066","name":"金币充值金额（新用户）","fields":["newUserGoldChargeAmt"],"inputIds":["M066"],"inputNames":["新用户金币充值金额"],"unit":AMOUNT_UNIT,"channel":true,"allowAboveOne":false},
  "M003": {"referenceMetricId":"M003","name":"下载点击次数","fields":["totalDownCountNoDedup"],"inputIds":["M003"],"inputNames":["下载点击次数"],"unit":"次","channel":true,"allowAboveOne":false,"biV1Metric":"M003"},
  "M002": {"referenceMetricId":"M002","name":"落地页访问IP数（去重）","fields":["landingVisitIpCount"],"inputIds":["M002"],"inputNames":["落地页访问IP数（去重）"],"inputUnits":["IP"],"unit":"IP","biV1Metric":"M002","biV1Only":true,"sourceNote":"来自 bi-v1 获客域；使用接口返回的去重 IP 结果和完整性状态，不用访问次数或每日 IP 数推算跨日去重结果。"},
  "M095": {"referenceMetricId":"M095","name":"落地页下载IP数（去重）","fields":["landingDownloadIpCount"],"inputIds":["M095"],"inputNames":["落地页下载IP数（去重）"],"inputUnits":["IP"],"unit":"IP","biV1Metric":"M095","biV1Only":true,"sourceNote":"来自 bi-v1 获客域；按接口登记的业务日和下载目标去重规则读取，不由下载点击次数估算。"},
  "M005": {"referenceMetricId":"M005","name":"落地页访问-下载点击转化率","fields":["totalDownCountNoDedup","visiCountNoDedup"],"inputIds":["M005","M005"],"inputNames":["下载点击次数","落地页访问次数"],"unit":"%","channel":true,"allowAboveOne":true,"biV1Metric":"M005"},
  "M099": {"referenceMetricId":"M099","name":"落地页访问-下载点击转化率（去重）","fields":["landingDownloadIpCount","landingVisitIpCount"],"inputIds":["M095","M002"],"inputNames":["落地页下载IP数（去重）","落地页访问IP数（去重）"],"inputUnits":["IP","IP"],"unit":"%","biV1Metric":"M099","biV1Only":true,"sourceNote":"来自 bi-v1 获客域；仅采用同一业务日、同一查询范围的分子、分母和比率。多日统一 IP 去重未提供前，不把每日去重 IP 相加或平均每日比率。"},
  "M006": {"referenceMetricId":"M006","name":"落地页下载点击-注册转化率","fields":["registerUserCount","totalDownCountByIp"],"inputIds":["M006","M006"],"inputNames":["注册用户数","下载 IP·天"],"unit":"%","channel":true,"allowAboveOne":true,"biV1Metric":"M006","biV1Only":true,"sourceNote":"来自 bi-v1 获客域；缺少落地页到注册的稳定归因键时原样展示 SOURCE_INCOMPLETE，不回退旧字段、不补0。"},
  "M007": {"referenceMetricId":"M007","name":"落地页访问-注册转化率","fields":["registerUserCount","ipStatTotalCount"],"inputIds":["M007","M007"],"inputNames":["注册用户数","访问 IP·天"],"unit":"%","channel":true,"allowAboveOne":true,"biV1Metric":"M007","biV1Only":true,"sourceNote":"来自 bi-v1 获客域；缺少落地页到注册的稳定归因键时原样展示 SOURCE_INCOMPLETE，不回退旧字段、不补0。"},
  "M016.web": { "referenceMetricId": "M016", "name": "日活跃用户数（Web）", "fields": ["webLoginUserCount"], "inputIds": ["M016"], "inputNames": ["Web 日活跃用户数"], "unit": "人", "biV1Metric": "M016", "biV1Dimensions": ["web"] },
  "M008.web": { "referenceMetricId": "M008", "name": "新增用户数（Web）", "fields": ["webNewUserCount"], "inputIds": ["M008"], "inputNames": ["Web 新增用户数"], "unit": "人", "biV1Metric": "M008", "biV1Dimensions": ["web"] },
  "M026.web": { "referenceMetricId": "M026", "name": "观影用户数（Web）", "fields": ["webWatchUserCount"], "inputIds": ["M026"], "inputNames": ["Web 观影用户数"], "unit": "人", "biV1Metric": "M026", "biV1Dimensions": ["web"] },
  "M081.web": { "referenceMetricId": "M081", "name": "活跃用户观影率（Web）", "fields": ["webWatchUserCount", "webLoginUserCount"], "inputIds": ["M081", "M081"], "inputNames": ["Web 观影用户数", "Web 日活跃用户数"], "unit": "%", "biV1Metric": "M081", "biV1Dimensions": ["web"] },
  "M055.navigation.new": {"referenceMetricId":"M055","name":"导航广告点击次数（新用户）","fields":["navClickedNewCount"],"inputIds":["M055"],"inputNames":["新增导航广告点击次数"],"unit":"次"},
  "M094.navigation.new": {"referenceMetricId":"M094","name":"导航广告点击人数（新用户）","fields":["navClickedNewPerson"],"inputIds":["M094"],"inputNames":["新增导航广告点击人数"],"unit":"人"},
  "M055.total.new": {"referenceMetricId":"M055","name":"总点击次数（新用户）","fields":["newUserTotalClickedCount"],"inputIds":["M055"],"inputNames":["新增总点击次数"],"unit":"次"},
  "M094.total.new": {"referenceMetricId":"M094","name":"总点击人数（新用户）","fields":["newUserTotalClickedPerson"],"inputIds":["M094"],"inputNames":["新增总点击人数"],"unit":"人"},
  "M020": { fields: ["afterFirstData1.loginCnt", "registerCount"], inputIds: ["M115", "M008"], inputNames: ["第1日留存人数", "该注册日用户数"], unit: "%", cohortDays: 1, biV1Metric: "M020" },
  "M020.android": { referenceMetricId: "M020", name: "注册用户D1留存率（Android）", fields: ["retainedUserCount", "registeredUserCount"], inputIds: ["M115", "M008"], inputNames: ["Android注册批次D1回访人数", "Android注册批次人数"], unit: "%", cohortDays: 1, biV1Metric: "M020", biV1Dimensions: ["android"], biV1Only: true },
  "M020.ios": { referenceMetricId: "M020", name: "注册用户D1留存率（iOS）", fields: ["retainedUserCount", "registeredUserCount"], inputIds: ["M115", "M008"], inputNames: ["iOS注册批次D1回访人数", "iOS注册批次人数"], unit: "%", cohortDays: 1, biV1Metric: "M020", biV1Dimensions: ["ios"], biV1Only: true },
  "M020.natural": { referenceMetricId: "M020", name: "注册用户D1留存率（自然新增）", fields: ["retainedUserCount", "registeredUserCount"], inputIds: ["M115", "M008"], inputNames: ["自然新增注册批次D1回访人数", "自然新增注册批次人数"], unit: "%", cohortDays: 1, biV1Metric: "M020", biV1Dimensions: ["natural"], biV1Only: true },
  "M020.internal": { referenceMetricId: "M020", name: "注册用户D1留存率（内部导量）", fields: ["retainedUserCount", "registeredUserCount"], inputIds: ["M115", "M008"], inputNames: ["内部导量注册批次D1回访人数", "内部导量注册批次人数"], unit: "%", cohortDays: 1, biV1Metric: "M020", biV1Dimensions: ["internal"], biV1Only: true },
  "M115.d1": { referenceMetricId: "M115", name: "注册用户第1日留存人数", fields: ["afterFirstData1.loginCnt"], inputIds: ["M115"], inputNames: ["第1日留存人数"], unit: "人", cohortDays: 1, biV1Metric: "M020", biV1Value: "numerator" },
  "M021": { fields: ["afterFirstData3.loginCnt", "registerCount"], inputIds: ["M115", "M008"], inputNames: ["第3日留存人数", "该注册日用户数"], unit: "%", cohortDays: 3, biV1Metric: "M021" },
  "M115.d3": { referenceMetricId: "M115", name: "注册用户第3日留存人数", fields: ["afterFirstData3.loginCnt"], inputIds: ["M115"], inputNames: ["第3日留存人数"], unit: "人", cohortDays: 3, biV1Metric: "M021", biV1Value: "numerator" },
  "M022": { fields: ["afterFirstData7.loginCnt", "registerCount"], inputIds: ["M115", "M008"], inputNames: ["第7日留存人数", "该注册日用户数"], unit: "%", cohortDays: 7, biV1Metric: "M022" },
  "M115.d7": { referenceMetricId: "M115", name: "注册用户第7日留存人数", fields: ["afterFirstData7.loginCnt"], inputIds: ["M115"], inputNames: ["第7日留存人数"], unit: "人", cohortDays: 7, biV1Metric: "M022", biV1Value: "numerator" },
  "M023": { fields: ["afterFirstData30.loginCnt", "registerCount"], inputIds: ["M115", "M008"], inputNames: ["第30日留存人数", "该注册日用户数"], unit: "%", cohortDays: 30, biV1Metric: "M023" },
  "M115.d30": { referenceMetricId: "M115", name: "注册用户第30日留存人数", fields: ["afterFirstData30.loginCnt"], inputIds: ["M115"], inputNames: ["第30日留存人数"], unit: "人", cohortDays: 30, biV1Metric: "M023", biV1Value: "numerator" },
  "M016.android": { "referenceMetricId": "M016", "name": "日活跃用户数（Android）", "fields": ["androidLoginUserCount"], "inputIds": ["M016"], "inputNames": ["Android 日活跃用户数"], "unit": "人", "biV1Metric": "M016", "biV1Dimensions": ["android"] },
  "M016.ios": { "referenceMetricId": "M016", "name": "日活跃用户数（iOS）", "fields": ["iosLoginUserCount"], "inputIds": ["M016"], "inputNames": ["iOS 日活跃用户数"], "unit": "人", "biV1Metric": "M016", "biV1Dimensions": ["ios"] },
  "M016.old": { "referenceMetricId": "M016", "name": "日活跃用户数（老用户）", "fields": ["oldUserLoginUserCount"], "inputIds": ["M016"], "inputNames": ["老用户日活跃用户数"], "unit": "人", "biV1Metric": "M016", "biV1Dimensions": ["old"] },
  "M008.android": { "referenceMetricId": "M008", "name": "新增用户数（Android）", "fields": ["androidNewUserCount"], "inputIds": ["M008"], "inputNames": ["Android 新增用户数"], "unit": "人", "biV1Metric": "M008", "biV1Dimensions": ["android"] },
  "M008.ios": { "referenceMetricId": "M008", "name": "新增用户数（iOS）", "fields": ["iosNewUserCount"], "inputIds": ["M008"], "inputNames": ["iOS 新增用户数"], "unit": "人", "biV1Metric": "M008", "biV1Dimensions": ["ios"] },
  "M026.android": { "referenceMetricId": "M026", "name": "观影用户数（Android）", "fields": ["androidWatchUserCount"], "inputIds": ["M026"], "inputNames": ["Android 观影用户数"], "unit": "人", "biV1Metric": "M026", "biV1Dimensions": ["android"] },
  "M026.ios": { "referenceMetricId": "M026", "name": "观影用户数（iOS）", "fields": ["iosWatchUserCount"], "inputIds": ["M026"], "inputNames": ["iOS 观影用户数"], "unit": "人", "biV1Metric": "M026", "biV1Dimensions": ["ios"] },
  "M026.new": { "referenceMetricId": "M026", "name": "观影用户数（新用户）", "fields": ["newUserWatchUserCount"], "inputIds": ["M026"], "inputNames": ["新增观影用户数"], "unit": "人", "biV1Metric": "M026", "biV1Dimensions": ["new"] },
  "M081.android": { "referenceMetricId": "M081", "name": "活跃用户观影率（Android）", "fields": ["androidWatchUserCount", "androidLoginUserCount"], "inputIds": ["M081", "M081"], "inputNames": ["Android 观影用户数", "Android 日活跃用户数"], "unit": "%", "biV1Metric": "M081", "biV1Dimensions": ["android"] },
  "M081.ios": { "referenceMetricId": "M081", "name": "活跃用户观影率（iOS）", "fields": ["iosWatchUserCount", "iosLoginUserCount"], "inputIds": ["M081", "M081"], "inputNames": ["iOS 观影用户数", "iOS 日活跃用户数"], "unit": "%", "biV1Metric": "M081", "biV1Dimensions": ["ios"] },
  "M055.new": {"referenceMetricId":"M055","name":"广告点击次数（新用户）","fields":["adsClickedNewCount"],"inputIds":["M055"],"inputNames":["新增广告点击次数"],"unit":"次", biV1Metric: "M110", biV1Unit: "count_per_user", biV1Dimensions: ["new"], biV1Value: "numerator", sourceNote: "优先读取同日、同PID、新用户范围的 M110 广告点击次数分子；仅使用 READY 的直接计数，旧源完整有效时可回退。" },
  "M094.new": {"referenceMetricId":"M094","name":"广告点击人数（新用户）","fields":["adsClickedNewPerson"],"inputIds":["M094"],"inputNames":["新增广告点击人数"],"unit":"人"},
  "M058.new": {"referenceMetricId":"M058","name":"总充值金额（新用户）","fields":["newUserDiamondChargeAmt"],"inputIds":["M058"],"inputNames":["新增充值金额"],"unit":AMOUNT_UNIT},
  "M088": {"referenceMetricId":"M088","name":"新增用户 ARPU","fields":["newUserDiamondChargeAmt","registerUserCount"],"inputIds":["M088","M088"],"inputNames":["新增充值金额","新增用户数"],"unit":AMOUNT_PER_USER_UNIT},
  "M067.new": {"referenceMetricId":"M067","name":"ARPPU（新用户）","fields":["newUserDiamondChargeAmt","newUserChargeUserCount"],"inputIds":["M067","M067"],"inputNames":["新增充值金额","新增付费人数"],"unit":AMOUNT_PER_USER_UNIT},
  "display:M016": {"referenceMetricId":"M016","name":"日活 Android:iOS","fields":["androidLoginUserCount","iosLoginUserCount"],"inputIds":["M016","M016"],"inputNames":["Android 日活跃用户数","iOS 日活跃用户数"],"unit":"Android:iOS", derivedFrom: ["M016.android", "M016.ios"]},
  "display:M008": {"referenceMetricId":"M008","name":"新增 Android:iOS","fields":["androidNewUserCount","iosNewUserCount"],"inputIds":["M008","M008"],"inputNames":["Android 新增用户数","iOS 新增用户数"],"unit":"Android:iOS", derivedFrom: ["M008.android", "M008.ios"]},
  "M001": {"referenceMetricId":"M001","name":"落地页访问次数","fields":["totalVistCount"],"inputIds":["M001"],"inputNames":["落地页访问次数"],"unit":"次","biV1Metric":"M001"},
  M016: { fields: ["loginUserCount"], inputIds: ["M016"], unit: "人", biV1Metric: "M016" },
  M026: { fields: ["watchUserCount"], inputIds: ["M026"], unit: "人", biV1Metric: "M026" },
  M059: { fields: ["totalChargeUserCount"], inputIds: ["M059"], unit: "人" },
  M081: { fields: ["watchUserCount", "loginUserCount"], inputIds: ["M026", "M016"], unit: "%", biV1Metric: "M081" },
  M103: { fields: ["startUserCount", "activeUserCount"], inputIds: ["M030", "M016"], inputNames: ["起播用户数", "日活跃用户数"], inputUnits: ["人", "人"], unit: "%", biV1Metric: "M103", biV1Only: true, sourceNote: "来自 bi-v1 用户观看域；单日按起播用户数除以日活跃用户数。多日结果必须按用户人天总分子、总分母重算，不平均每日比率。" },
  M061: { fields: ["totalChargeUserCount", "loginUserCount"], inputIds: ["M059", "M016"], unit: "%" },
  M008: { fields: ["registerUserCount"], inputIds: ["M008"], unit: "人", biV1Metric: "M008" },
  M064: { fields: ["newUserChargeUserCount", "registerUserCount"], inputIds: ["M059", "M008"], inputNames: ["新增付费人数", "新增用户数"], unit: "%" },
  M058: { fields: ["diamondChargeAmt"], inputIds: ["M058"], unit: AMOUNT_UNIT },
  M067: { fields: ["diamondChargeAmt", "totalChargeUserCount"], inputIds: ["M058", "M059"], unit: AMOUNT_PER_USER_UNIT },
  M087: { fields: ["diamondChargeAmt", "loginUserCount"], inputIds: ["M058", "M016"], unit: AMOUNT_PER_USER_UNIT },
  M110: { fields: ["adsCount", "loginUserCount"], inputIds: ["M055", "M016"], inputNames: ["广告点击次数", "日活跃用户数"], unit: "次/人", biV1Metric: "M110", biV1Unit: "count_per_user" },
  "M110.new": { referenceMetricId: "M110", name: "活跃用户人均广告点击次数（新用户）", fields: ["newUserAdClickCount", "newUserActiveUserCount"], inputIds: ["M055", "M016"], inputNames: ["新用户广告点击次数", "新用户日活跃用户数"], inputUnits: ["次", "人"], unit: "次/人", biV1Metric: "M110", biV1Unit: "count_per_user", biV1Dimensions: ["new"], biV1Only: true },
  M111: { fields: ["adsClickedPerson", "loginUserCount"], inputIds: ["M094", "M016"], inputNames: ["广告点击人数", "日活跃用户数"], unit: "%", biV1Metric: "M111" },
  "M111.new": { referenceMetricId: "M111", name: "活跃用户广告点击渗透率（新用户）", fields: ["newUserAdClickUserCount", "newUserActiveUserCount"], inputIds: ["M094", "M016"], inputNames: ["新用户广告点击人数", "新用户日活跃用户数"], unit: "%", biV1Metric: "M111", biV1Dimensions: ["new"], biV1Only: true },
  "M059.new": { referenceMetricId: "M059", name: "新增付费人数", fields: ["newUserChargeUserCount"], inputIds: ["M059"], inputNames: ["新增付费人数"], unit: "人" },
  "M055.ads": { referenceMetricId: "M055", name: "广告点击次数", fields: ["adsCount"], inputIds: ["M055"], unit: "次", biV1Metric: "M110", biV1Unit: "count_per_user", biV1Value: "numerator", sourceNote: "优先读取同日、同PID总体的 M110 广告点击次数分子；仅使用 READY 的直接计数，旧源完整有效时可回退。" },
  "M055.navigation": { referenceMetricId: "M055", name: "导航广告点击次数", fields: ["navCount"], inputIds: ["M055"], unit: "次" },
  "M055.total": { referenceMetricId: "M055", name: "总点击次数", fields: ["totalClickedCount"], inputIds: ["M055"], unit: "次" },
  "M094.ads": { referenceMetricId: "M094", name: "广告点击人数", fields: ["adsClickedPerson"], inputIds: ["M094"], unit: "人" },
  "M094.navigation": { referenceMetricId: "M094", name: "导航广告点击人数", fields: ["navClickedPerson"], inputIds: ["M094"], unit: "人" },
  "M094.total": { referenceMetricId: "M094", name: "总点击人数", fields: ["totalClickedPerson"], inputIds: ["M094"], unit: "人" }
} as const;
type CandidateId = keyof typeof baseMappings;
type CandidateMapping = { fields: readonly string[]; inputIds: readonly string[]; unit: string; referenceMetricId?: string; name?: string; inputNames?: readonly string[]; inputUnits?: readonly string[]; cohortDays?: number; channel?: boolean; payment?: boolean; checkin?: boolean; realtime?: boolean; biV1Playback?: boolean; biV1Metric?: BiV1MetricCode; biV1Unit?: BiV1MetricUnit; biV1Dimensions?: readonly string[]; biV1Only?: boolean; biV1Value?: "numerator"; derivedFrom?: readonly [CandidateId, CandidateId]; allowAboveOne?: boolean; resultDivisor?: number; formula?: string; definition?: string; sourceNote?: string };
const mappings: Record<CandidateId, CandidateMapping> = baseMappings;
function dimensionFilters(tokens: readonly string[] = []): BiV1MetricDimensionFilters {
  const filters: BiV1MetricDimensionFilters = {};
  for (const token of tokens) {
    switch (token) {
      case "android": case "ios": case "web": filters.clientPlatform = token; break;
      case "new": case "old": filters.userCohort = token; break;
      case "natural": filters.sourceType = "natural"; break;
      case "internal": filters.sourceType = "internal_channel"; break;
      case "alipay": filters.paymentMethod = "ali_pay"; break;
      case "wechat": filters.paymentMethod = "wx_pay"; break;
      case "usdt": filters.paymentMethod = "usdt_pay"; break;
      case "unknown": filters.paymentMethod = "unknown"; break;
      default: throw new Error("日看板分维映射缺少正式筛选条件");
    }
  }
  return filters;
}
// Each capability applies to this exact candidate projection and its existing daily source.
const periodStatisticKinds: Partial<Record<CandidateId, readonly DailyPeriodStatistics["values"][number]["kind"][]>> = {
  M102: ["period_sum", "daily_average"], M058: ["period_sum", "daily_average"], M065: ["period_sum", "daily_average"], M066: ["period_sum", "daily_average"],
  "M058.new": ["period_sum", "daily_average"], "M058.nature": ["period_sum", "daily_average"], "M058.internal": ["period_sum", "daily_average"],
  "M065.new": ["period_sum", "daily_average"], "M066.new": ["period_sum", "daily_average"],
  M101: ["period_sum", "daily_average"], M001: ["period_sum", "daily_average"], M003: ["period_sum", "daily_average"], M008: ["period_sum", "daily_average"],
  M034: ["period_sum", "daily_average"], M097: ["period_sum", "daily_average"],
  "M055.ads": ["period_sum", "daily_average"], "M055.navigation": ["period_sum", "daily_average"], "M055.total": ["period_sum", "daily_average"],
  "M055.new": ["period_sum", "daily_average"], "M055.navigation.new": ["period_sum", "daily_average"], "M055.total.new": ["period_sum", "daily_average"],
  M060: ["period_sum", "daily_average"], "M060.alipay": ["period_sum", "daily_average"], "M060.wechat": ["period_sum", "daily_average"], "M060.usdt": ["period_sum", "daily_average"],
  M112: ["period_sum", "daily_average"], "M112.alipay": ["period_sum", "daily_average"], "M112.wechat": ["period_sum", "daily_average"], "M112.usdt": ["period_sum", "daily_average"],
  M084: ["period_sum", "daily_average"], M086: ["period_sum", "daily_average"], M095: ["daily_average"],
  M113: ["daily_average"], "M113.alipay": ["daily_average"], "M113.wechat": ["daily_average"], "M113.usdt": ["daily_average"],
  M016: ["daily_average"], "M016.android": ["daily_average"], "M016.ios": ["daily_average"], "M016.web": ["daily_average"], "M016.old": ["daily_average"],
  "M016.new": ["daily_average"], "M016.androidOld": ["daily_average"], "M016.iosOld": ["daily_average"],
  "M016.androidNew": ["daily_average"], "M016.iosNew": ["daily_average"],
  M026: ["daily_average"], "M026.android": ["daily_average"], "M026.ios": ["daily_average"], "M026.web": ["daily_average"], "M026.new": ["daily_average"], "M026.old": ["daily_average"],
  "M026.androidOld": ["daily_average"], "M026.iosOld": ["daily_average"],
  "M026.androidNew": ["daily_average"], "M026.iosNew": ["daily_average"],
  "M008.android": ["daily_average"], "M008.ios": ["daily_average"], "M008.web": ["daily_average"], "M008.nature": ["daily_average"], "M008.internal": ["daily_average"],
  M059: ["daily_average"], "M059.new": ["daily_average"], M075: ["daily_average"],
  "M094.ads": ["daily_average"], "M094.navigation": ["daily_average"], "M094.total": ["daily_average"],
  "M094.new": ["daily_average"], "M094.navigation.new": ["daily_average"], "M094.total.new": ["daily_average"]
};
type DailyPoint = DailyDashboardV2Success["data"]["series"][number]["points"][number];
function periodStatistics(id: CandidateId, points: readonly DailyPoint[], query: DailyDashboardQuery, today: string): DailyPeriodStatistics {
  const dayCount = (Date.parse(query.dateRange[1]) - Date.parse(query.dateRange[0])) / 86400000 + 1;
  const context = { aggregationVersion: DAILY_STATISTICS_VERSION, dateRange: query.dateRange, dayCount };
  const kinds = periodStatisticKinds[id];
  if (!kinds?.length) return { ...context, state: "unsupported", values: [], reason: "该指标暂不提供周期合计或日均" };
  if (query.dateRange[1] >= today) return { ...context, state: "incomplete", values: [], reason: "所选日期包含尚未结束的业务日" };
  if (points.length !== dayCount || points.some((point, index) =>
    point.date !== new Date(Date.parse(query.dateRange[0]) + index * 86400000).toISOString().slice(0, 10)
    || point.state !== "available" || point.value === null
  )) return { ...context, state: "incomplete", values: [], reason: "所选日期存在缺失或不可用日值" };
  const mapping = mappings[id];
  const sourceValues = points.map(point => mapping.resultDivisor ? point.inputs[0].value! : point.value!);
  let sourceSum = 0, correction = 0;
  for (const value of sourceValues) {
    const corrected = value - correction, next = sourceSum + corrected;
    correction = (next - sourceSum) - corrected; sourceSum = next;
  }
  if (!Number.isFinite(sourceSum) || sourceSum > Number.MAX_SAFE_INTEGER || !mapping.resultDivisor && mapping.unit !== AMOUNT_UNIT && !Number.isSafeInteger(sourceSum)) {
    return { ...context, state: "incomplete", values: [], reason: "日值合计超出可安全计算的范围" };
  }
  const sum = sourceSum / (mapping.resultDivisor ?? 1);
  return { ...context, state: "available", values: kinds.map(kind => ({ kind, value: kind === "period_sum" ? sum : sum / dayCount })), reason: null };
}
const boardMetrics: Record<string, readonly CandidateId[]> = {
  "5.2": (Object.keys(mappings) as CandidateId[]).filter(id => !mappings[id].checkin),
  "5.14": ["M075"],
  "5.12": ["M101", "M034", "M036", "M097"],
  "5.7": ["M001", "M002", "M003", "M095", "M005", "M099", "M006", "M007", "M008", "M008.android", "M008.ios", "M008.web", "M008.nature", "M008.internal", "M059.new", "M064"],
  "5.8": ["M016", "M016.android", "M016.ios", "M016.web", "M016.new", "M016.old", "M016.androidNew", "M016.iosNew", "M016.androidOld", "M016.iosOld", "M018", "M020", "M020.android", "M020.ios", "M020.natural", "M020.internal", "M021", "M022", "M023", "M115.d1", "M115.d3", "M115.d7", "M115.d30"],
  "5.9": ["M026", "M081", "M103", "M101", "M102", "M098", "M034", "M036", "M097", "M026.android", "M026.ios", "M026.web", "M026.new", "M026.old", "M026.androidNew", "M026.iosNew", "M026.androidOld", "M026.iosOld", "M081.android", "M081.ios", "M081.web", "M081.new", "M081.old", "M081.androidNew", "M081.iosNew", "M081.androidOld", "M081.iosOld"],
  "5.10": ["M059", "M058", "M061", "M067", "M087", "M059.new", "M064", "M058.new", "M088", "M067.new", "M065", "M066", "M065.new", "M066.new"],
  "5.11": ["M059", "M058", "M061", "M067", "M087", "M113", "M112", "M060", "M114",
    "M112.alipay", "M113.alipay", "M060.alipay", "M114.alipay",
    "M112.wechat", "M113.wechat", "M060.wechat", "M114.wechat",
    "M112.usdt", "M113.usdt", "M060.usdt", "M114.usdt", "M084", "M086", "M090"]
};
const pending: Record<string, string[]> = {
  "5.12": ["M083", "M031", "M030", "M032"],
  "5.2": [], "5.7": [],
  "5.8": [], "5.9": ["M040", "M041", "M042"],
  "5.10": [], "5.11": [],
  "5.13": [], "5.14": [], "5.15": [], "5.5": []
};
export function dailyDashboardCatalog(enabled: boolean) {
  return { success: true as const, data: { enabled, categories: plan.categories,
    items: plan.items.map(item => ({ id: item.section, title: item.title, category: item.category,
      metricIds: [...(boardMetrics[item.section] ?? [])],
      pendingMetricNames: (pending[item.section] ?? []).map(id => {
        const definition = getV2MetricDefinition(id);
        if (!definition) throw new Error("Daily pending metric definition missing");
        return definition.name;
      })
    }))
  } };
}
function sourceApis(ids: readonly CandidateId[]) {
  ids = ids.flatMap(id => mappings[id].derivedFrom ?? [id]);
  return [
    ...(ids.some(id => !mappings[id].cohortDays && !mappings[id].channel && !mappings[id].payment && !mappings[id].checkin && !mappings[id].realtime && !mappings[id].biV1Playback && !mappings[id].biV1Only) ? [P_DAY_SUM_API] : []),
    ...(ids.some(id => mappings[id].cohortDays) ? [RETENTION_PLUS_API] : []),
    ...(ids.some(id => mappings[id].channel) ? [CHANNEL_V2_API] : []),
    ...(ids.some(id => mappings[id].payment) ? [PAYMENT_RATE_API] : []),
    ...(ids.some(id => mappings[id].checkin) ? [CHECKIN_OVERVIEW_API] : []),
    ...(ids.some(id => mappings[id].realtime) ? [REALTIME_API] : []),
    ...(ids.some(id => mappings[id].biV1Playback) ? [BI_V1_PLAYBACK_API] : []),
    ...(ids.some(id => mappings[id].biV1Metric) ? [BI_V1_METRICS_API] : [])
  ];
}
/** Read-only documentation projection of the exact candidate mapping table. */
export function dailyDashboardProjectionDocumentation() {
  return (Object.keys(mappings) as CandidateId[]).map(id => ({ ...metric(id), sourceApi: sourceApis([id])[0],
    boardIds: Object.keys(boardMetrics).filter(board => boardMetrics[board].includes(id)) }));
}
export function dailyDashboardMatchesMapping(result: DailyDashboardSuccess) {
  const ids = boardMetrics[result.data.query.boardId] ?? [];
  const sources = sourceApis(ids);
  if (!isDeepStrictEqual(result.data.sourceApiIds, sources)) return false;
  return result.data.series.every(series => {
    if (!(series.metric.id in mappings)) return false;
    const id = series.metric.id as CandidateId;
    return isDeepStrictEqual(series.metric, metric(id)) && (!("periodStatistics" in series)
      || isDeepStrictEqual(series.periodStatistics, periodStatistics(id, series.points, result.data.query, toBeijingDate(result.data.fetchedAt))));
  });
}
function metric(id: CandidateId): DailyReadingMetric {
  const mapping = mappings[id];
  const referenceMetricId = mapping.referenceMetricId ?? id;
  const definition = getV2MetricDefinition(referenceMetricId);
  if (!definition) throw new Error("Daily reading metric definition missing");
  return { id, referenceMetricId, name: mapping.name ?? definition.name, unit: mapping.unit, authorityVersion: definition.authority.version,
    definition: mapping.definition ?? definition.authority.definition,
    formula: mapping.formula ?? (mapping.fields.length === 2 ? mapping.inputNames ? mapping.inputNames.join(" ÷ ") + (mapping.unit === "%" ? " × 100%" : "") : definition.authority.registeredFormula : null),
    sourceNote: mapping.sourceNote ?? (mapping.checkin ? "签到看板返回的当日签到人数；使用人数原值，不用签到页 UV、签到率或任务人数替代。成功终态、重复签到排除方式待验数。" : mapping.payment ? "支付通道统计的同日拉单及成功计数；日比率不等同于同批订单的有序漏斗。时间归属和成功阶段待验数；仅返回所选业务平台，排除全平台字段。" : mapping.cohortDays ? "按注册日期查询对应第N日登录人数；观察日结束且基数有效后计算。查询时间不是源数据水位。" : mapping.unit.startsWith(AMOUNT_UNIT) ? "金额为人民币元，保留接口数值；金额覆盖范围与业务时间归属待验数。纯金额按所选完整业务日提供合计及日均，人均金额不平均，不跨平台汇总。" : mapping.channel ? "渠道统计V2的所选平台单日独立合计，不累计渠道层级明细。身份去重方式待验数。" : mapping.name ? "采用后台日汇总对应切片的直接结果，不相加或推算总体；身份去重方式待验数。" : null),
    inputs: mapping.fields.map((key, index) => ({ key, name: mapping.inputNames?.[index] ?? mapping.name ?? getV2MetricDefinition(mapping.inputIds[index])!.name, unit: mapping.inputUnits?.[index] ?? (mapping.fields.length === 1 ? mapping.unit : mapping.payment ? "次" : key.endsWith("Amt") ? AMOUNT_UNIT : ["adsCount", "navCount", "totalClickedCount", "adsClickedNewCount", "totalVistCount", "navClickedNewCount", "newUserTotalClickedCount", "totalDownCountNoDedup", "visiCountNoDedup"].includes(key) ? "次" : ["totalDownCountByIp", "ipStatTotalCount"].includes(key) ? "IP·天" : "人") }))
  };
}
const badSource = () => new UpstreamError("DAILY_SOURCE_CONFLICT", "日汇总数据结构或范围异常", 502);
function assertScopeEcho(row: Record<string, unknown>, pid: string, date: string) {
  if (row.pid != null && row.pid !== pid) throw badSource();
  if (row.sumDate != null && toBeijingDate(row.sumDate) !== date) throw badSource();
}
function total(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "number" && typeof value !== "string") throw badSource();
  if (typeof value === "string" && !value.trim()) return null;
  if (typeof value === "string" && !/^\d+$/.test(value.trim())) throw badSource();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw badSource();
  return parsed;
}
function count(value: unknown, decimal = false) {
  if (value == null || (typeof value === "string" && !value.trim())) return { value: null, invalid: false };
  if (typeof value !== "number" && typeof value !== "string") return { value: null, invalid: true };
  if (typeof value === "string" && !(decimal ? /^\d+(?:\.\d+)?$/ : /^\d+$/).test(value.trim())) return { value: null, invalid: true };
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed <= Number.MAX_SAFE_INTEGER && (decimal || Number.isSafeInteger(parsed)) && parsed >= 0 ? { value: parsed, invalid: false } : { value: null, invalid: true };
}
const rowSchema = z.object({ pid: z.string(), sumDate: z.string() }).loose();
const envelopeSchema = z.object({ msg: z.object({ pageData: z.array(rowSchema) }).loose() }).loose();
export interface DailyDashboardExecutor { execute(query: DailyDashboardQuery): Promise<DailyDashboardSuccess> }
export class DailyDashboardService implements DailyDashboardExecutor {
  constructor(private readonly client: Pick<UpstreamClient, "get">, private readonly now = () => new Date()) {}
  async execute(query: DailyDashboardQuery): Promise<DailyDashboardV2Success> {
    const fetchedAt = this.now().toISOString();
    const ids = boardMetrics[query.boardId] ?? [];
    if (!ids.length) throw new UpstreamError("DAILY_BOARD_NOT_READY", "该看板尚无可读取的日数据", 422);
    const byDate = new Map<string, z.infer<typeof rowSchema>>();
    let dailyFailure = false;
    const dailyTask = (async () => { if (!sourceApis(ids).includes(P_DAY_SUM_API)) return; try {
    const payload = await this.client.get(P_DAY_SUM_API, { page: "1", count: "500", pid: query.pid,
      sumDateStart: query.dateRange[0] + " 00:00:00", sumDateEnd: query.dateRange[1] + " 23:59:59" });
    const parsed = envelopeSchema.safeParse(payload);
    if (!parsed.success) throw badSource();
    const envelope = parsed.data.msg;
    const modern = total(envelope.totalCount), legacy = total(envelope.total);
    if (modern !== null && legacy !== null && modern !== legacy) throw badSource();
    const expected = modern ?? legacy;
    if (expected === null || expected !== envelope.pageData.length) throw badSource();
    for (const row of envelope.pageData) {
      const local = /^\d{4}-\d{2}-\d{2}(?:[ T](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?)?$/.test(row.sumDate);
      const offset = z.iso.datetime({ offset: true }).safeParse(row.sumDate).success;
      if (!local && !offset) throw badSource();
      const date = local ? row.sumDate.slice(0, 10) : toBeijingDate(row.sumDate);
      if (!z.iso.date().safeParse(date).success || row.pid !== query.pid || date < query.dateRange[0] || date > query.dateRange[1] || byDate.has(date)) throw badSource();
      byDate.set(date, row);
    }
    } catch { dailyFailure = true; byDate.clear(); } })();
    const cohorts = new Map<string, z.infer<typeof rowSchema>>();
    const needsCohorts = ids.some(id => mappings[id].cohortDays);
    let cohortFailure = false;
    const cohortTask = (async () => { if (needsCohorts) {
      try {
        const payload = await this.client.get(RETENTION_PLUS_API, { pid: query.pid, registerDate: query.dateRange[0] + " 00:00:00", registerEdDate: query.dateRange[1] + " 23:59:59" });
        const result = z.object({ data: z.array(rowSchema) }).loose().parse(payload);
        for (const row of result.data) {
          const date = toBeijingDate(row.sumDate);
          if (!z.iso.date().safeParse(date).success || row.pid !== query.pid || date < query.dateRange[0] || date > query.dateRange[1] || cohorts.has(date)) throw badSource();
          cohorts.set(date, row);
        }
      } catch { cohortFailure = true; cohorts.clear(); }
    } })();
    const today = toBeijingDate(fetchedAt);
    const days = (Date.parse(query.dateRange[1]) - Date.parse(query.dateRange[0])) / 86400000 + 1;
    const channelDays = new Map<string, Record<string, unknown>>();
    const channelFailures = new Set<string>();
    const needsChannel = ids.some(id => mappings[id].channel);
    const needsPayment = ids.some(id => mappings[id].payment);
    const paymentDays = new Map<string, Record<string, unknown>>(), paymentFailures = new Set<string>();
    const paymentTask = (async () => { if (needsPayment) {
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(3, days) }, async () => {
        while (next < days) {
          const date = new Date(Date.parse(query.dateRange[0]) + next++ * 86400000).toISOString().slice(0,10);
          try {
            const result = z.object({ msg: z.object({ pageData:z.array(z.object({sumDate:z.string()}).loose()) }).loose() }).loose().parse(await this.client.get(PAYMENT_RATE_API,{pid:query.pid,startTime:date+" 00:00:00",endTime:date+" 23:59:59",page:"1",count:"100"}));
            assertScopeEcho(result.msg, query.pid, date);
            result.msg.pageData.forEach(row => assertScopeEcho(row, query.pid, date));
            if(result.msg.pageData.some(row=>toBeijingDate(row.sumDate)!==date))throw badSource();
            paymentDays.set(date,result.msg);
          } catch { paymentFailures.add(date); }
        }
      }));
    } })();
    const channelTask = (async () => { if (needsChannel) {
      let next = 0;
      const worker = async () => {
        while (next < days) {
          const date = new Date(Date.parse(query.dateRange[0]) + next++ * 86400000).toISOString().slice(0, 10);
          try {
            const result = z.object({ msg: z.object({ pageData: z.array(rowSchema), totalData: z.array(z.record(z.string(), z.unknown())).max(1) }).loose() }).loose().parse(await this.client.get(CHANNEL_V2_API, {
              pid: query.pid, page: "1", count: "1", sumDateBegin: date + " 00:00:00", sumDateEnd: date + " 23:59:59"
            }));
            if (result.msg.pageData.some(row => row.pid !== query.pid || toBeijingDate(row.sumDate) !== date)) throw badSource();
            assertScopeEcho(result.msg, query.pid, date);
            if (result.msg.totalData[0]) {
              assertScopeEcho(result.msg.totalData[0], query.pid, date);
              channelDays.set(date, result.msg.totalData[0]);
            }
          } catch { channelFailures.add(date); }
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, days) }, worker));
    } })();
    const checkinDays = new Map<string, Record<string, unknown>>(), checkinFailures = new Set<string>();
    const checkinTask = (async () => {
      if (!ids.some(id => mappings[id].checkin)) return;
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(3, days) }, async () => {
        while (next < days) {
          const date = new Date(Date.parse(query.dateRange[0]) + next++ * 86400000).toISOString().slice(0, 10);
          try {
            const payload = await this.client.get(CHECKIN_OVERVIEW_API, { pid: query.pid, date });
            const result = z.object({ msg: z.object({ date: z.string() }).loose() }).loose().parse(payload);
            if (result.msg.date !== date) throw badSource();
            assertScopeEcho(result.msg, query.pid, date);
            checkinDays.set(date, result.msg);
          } catch { checkinFailures.add(date); }
        }
      }));
    })();
    const watchDays = new Map<string, WatchAttemptDay>(), watchFailures = new Set<string>();
    const watchTask = (async () => {
      if (!ids.some(id => mappings[id].realtime)) return;
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(3, days) }, async () => {
        while (next < days) {
          const date = new Date(Date.parse(query.dateRange[0]) + next++ * 86400000).toISOString().slice(0, 10);
          if (date >= today) { watchDays.set(date, { state: "no_value", value: null }); continue; }
          try { watchDays.set(date, await readWatchAttemptDay(this.client, query.pid, date)); }
          catch { watchFailures.add(date); }
        }
      }));
    })();
    const playbackDays = new Map<string, BiV1PlaybackDay>();
    let playbackFailure = false;
    const playbackTask = (async () => {
      if (!ids.some(id => mappings[id].biV1Playback)) return;
      try {
        const result = await readBiV1PlaybackDays(this.client, { pid: query.pid, startDate: query.dateRange[0], endDate: query.dateRange[1] });
        result.days.forEach(day => playbackDays.set(day.date, day));
      } catch {
        playbackFailure = true;
        playbackDays.clear();
      }
    })();
    const biV1MetricDays = new Map<string, BiV1MetricDay>();
    const biV1MetricTask = (async () => {
      const groups = new Map<string, { filters: BiV1MetricDimensionFilters; codes: Set<BiV1MetricCode> }>();
      for (const id of ids) {
        const mapping = mappings[id];
        if (!mapping.biV1Metric || mapping.biV1Metric === "M018") continue;
        const filters = dimensionFilters(mapping.biV1Dimensions);
        const key = JSON.stringify(filters);
        const group = groups.get(key) ?? { filters, codes: new Set<BiV1MetricCode>() };
        group.codes.add(mapping.biV1Metric);
        groups.set(key, group);
      }
      const requests = [...groups.values()];
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(3, requests.length) }, async () => {
        while (next < requests.length) {
          const group = requests[next++];
          try {
            const result = await readBiV1MetricDays(this.client, {
              pid: query.pid, startDate: query.dateRange[0], endDate: query.dateRange[1],
              metricCodes: [...group.codes],
              dimensions: Object.keys(group.filters) as BiV1MetricDimension[],
              ...(Object.keys(group.filters).length ? { dimensionFilters: group.filters } : {})
            });
            for (const day of result.days) {
              const existing = biV1MetricDays.get(day.date) ?? { date: day.date, metrics: {} };
              Object.assign(existing.metrics, day.metrics);
              biV1MetricDays.set(day.date, existing);
            }
          } catch {
            // Each filter group is independent. Missing or failed slices cannot
            // borrow the overall value or overwrite another group's healthy result.
            for (let i = 0; i < days; i++) {
              const date = new Date(Date.parse(query.dateRange[0]) + i * 86400000).toISOString().slice(0, 10);
              const existing = biV1MetricDays.get(date) ?? { date, metrics: {} };
              for (const code of group.codes) existing.metrics[biV1MetricKey(code, group.filters)] = {
                state: "source_failure", dataStatus: null, value: null, numerator: null, denominator: null, unit: null
              };
              biV1MetricDays.set(date, existing);
            }
          }
        }
      }));
    })();
    const monthlyDays = new Map<string, BiV1MetricDay>();
    const monthlyTask = (async () => {
      if (!ids.includes("M018")) return;
      try {
        const result = await readBiV1MonthlyMetricDays(this.client, { pid: query.pid, startDate: query.dateRange[0], endDate: query.dateRange[1] }, today);
        result.days.forEach(day => monthlyDays.set(day.date, day));
      } catch {
        for (let i = 0; i < days; i++) {
          const date = new Date(Date.parse(query.dateRange[0]) + i * 86400000).toISOString().slice(0, 10);
          monthlyDays.set(date, { date, metrics: { M018: { state: "source_failure", dataStatus: null, value: null, numerator: null, denominator: null, unit: null } } });
        }
      }
    })();
    await Promise.all([dailyTask, cohortTask, paymentTask, channelTask, checkinTask, watchTask, playbackTask, biV1MetricTask, monthlyTask]);
    const pointCache = new Map<string, DailyPoint>();
    const pointFor = (id: CandidateId, date: string): DailyPoint => {
      const key = `${id}|${date}`;
      const cached = pointCache.get(key);
      if (cached) return cached;
      const point = projectPoint(id, date);
      pointCache.set(key, point);
      return point;
    };
    const projectPoint = (id: CandidateId, date: string): DailyPoint => {
        const mapping = mappings[id];
        if (mapping.derivedFrom) {
          const sources = mapping.derivedFrom.map(source => pointFor(source, date));
          const inputs = mapping.fields.map((key, index) => ({ key, value: sources[index].state === "available" ? sources[index].value : null }));
          const unavailable = sources.find(point => point.state !== "available" || point.value === null);
          if (unavailable) return { date, value: null, state: unavailable.state === "available" ? "no_value" : unavailable.state, inputs,
            ...(unavailable.sourceStatus ? { sourceStatus: unavailable.sourceStatus } : {}) };
          return { date, value: sources[1].value === 0 ? null : sources[0].value! / sources[1].value!,
            state: sources[1].value === 0 ? "zero_denominator" : "available", inputs,
            ...(sources.every(point => point.sourceStatus === "READY") ? { sourceStatus: "READY" as const } : {}) };
        }
        if (mapping.biV1Playback) {
          const code = id as "M034" | "M036" | "M097";
          const point = playbackDays.get(date)?.metrics[code];
          const values = code === "M036" ? [point?.numerator ?? null, point?.denominator ?? null] : [point?.value ?? null];
          return {
            date,
            state: playbackFailure ? "source_failure" : point?.state ?? "no_record",
            value: playbackFailure ? null : point?.value ?? null,
            inputs: mapping.fields.map((key, index) => ({ key, value: playbackFailure ? null : values[index] ?? null })),
            ...(point?.dataStatus ? { sourceStatus: point.dataStatus } : {})
          };
        }
        const biV1Day = (id === "M018" ? monthlyDays : biV1MetricDays).get(date);
        const biV1Point = mapping.biV1Metric ? biV1Day?.metrics[biV1MetricKey(mapping.biV1Metric, mapping.biV1Dimensions)] : undefined;
        if (biV1Point) {
          if (!mapping.biV1Only && (!biV1Point.dataStatus || biV1Point.dataStatus === "SOURCE_INCOMPLETE")) {
            const legacyPoint = projectLegacyPoint(id, date);
            if (legacyPoint.state === "available" || biV1Point.state === "no_record") return legacyPoint;
          }
          const usesReturnedNumerator = "biV1Value" in mapping && mapping.biV1Value === "numerator";
          const expectedSourceUnit = mapping.biV1Unit ?? (usesReturnedNumerator || mapping.fields.length === 2 ? "ratio" : "count");
          const unitMismatch = biV1Point.dataStatus === "READY" && biV1Point.unit !== expectedSourceUnit;
          const invalidPenetration = mapping.biV1Metric === "M111" && biV1Point.dataStatus === "READY"
            && biV1Point.numerator !== null && biV1Point.denominator !== null && biV1Point.numerator > biV1Point.denominator;
          const invalidSourceValue = unitMismatch || invalidPenetration;
          const selectedValue = usesReturnedNumerator ? biV1Point.numerator : biV1Point.value;
          const selectedState = usesReturnedNumerator && biV1Point.dataStatus === "READY" && selectedValue !== null
            ? "available"
            : biV1Point.state;
          const values = usesReturnedNumerator
            ? [biV1Point.numerator]
            : mapping.fields.length === 2
              ? [biV1Point.numerator, biV1Point.denominator]
              : [biV1Point.value];
          return {
            date,
            state: invalidSourceValue ? "invalid_value" : selectedState,
            value: invalidSourceValue ? null : selectedValue,
            inputs: mapping.fields.map((key, index) => ({ key, value: invalidSourceValue ? null : values[index] ?? null })),
            ...(biV1Point.dataStatus ? { sourceStatus: biV1Point.dataStatus } : {})
          };
        }
        if (mapping.biV1Only) return { date, value: null, state: biV1Day ? "no_record" : "source_failure", inputs: mapping.fields.map(key => ({ key, value: null })) };
        return projectLegacyPoint(id, date);
    };
    const projectLegacyPoint = (id: CandidateId, date: string): DailyPoint => {
        const mapping = mappings[id];
        if (mapping.realtime) {
          const result = watchDays.get(date);
          return { date, state: watchFailures.has(date) ? "source_failure" : result?.state ?? "no_record", value: result?.value ?? null,
            inputs: [{ key: mapping.fields[0], value: result?.value ?? null }] };
        }
        const row = mapping.checkin ? checkinDays.get(date) : mapping.cohortDays ? cohorts.get(date) : mapping.channel ? channelDays.get(date) : mapping.payment ? paymentDays.get(date) : byDate.get(date);
        const field = (key: string): unknown => key.split(".").reduce<unknown>((value, part) => value && typeof value === "object" ? Reflect.get(value, part) : undefined, row);
        const values = mapping.fields.map(key => count(field(key), key.endsWith("Amt") || key === "totalUserWatchTime"));
        const inputs = mapping.fields.map((key, index) => ({ key, value: values[index].value }));
        if (!mapping.cohortDays && !mapping.channel && !mapping.payment && !mapping.checkin && dailyFailure) return { date, value: null, state: "source_failure", inputs };
        if (mapping.cohortDays && cohortFailure) return { date, value: null, state: "source_failure", inputs };
        if (mapping.channel && channelFailures.has(date)) return { date, value: null, state: "source_failure", inputs };
        if (mapping.payment && paymentFailures.has(date)) return { date, value: null, state: "source_failure", inputs };
        if (mapping.checkin && checkinFailures.has(date)) return { date, value: null, state: "source_failure", inputs };
        if (!row) return { date, value: null, state: "no_record", inputs };
        if (mapping.cohortDays) {
          const target = new Date(Date.parse(date) + mapping.cohortDays * 86400000).toISOString().slice(0, 10);
          if (target >= today) return { date, value: null, state: "immature", inputs: inputs.map(input => ({ ...input, value: input.key.endsWith("loginCnt") ? null : input.value })) };
          const sourceTarget = field("afterFirstData" + mapping.cohortDays + ".date");
          if (sourceTarget != null && toBeijingDate(sourceTarget) !== target) return { date, value: null, state: "invalid_value", inputs };
          if (sourceTarget == null) return { date, value: null, state: "no_value", inputs };
          const base = count(row.registerCount);
          if (values[0].value !== null && (base.invalid || base.value === null || values[0].value > base.value)) return { date, value: null, state: "invalid_value", inputs };
        }
        if (values.some(value => value.invalid)) return { date, value: null, state: "invalid_value", inputs };
        if (values.some(value => value.value === null)) return { date, value: null, state: "no_value", inputs };
        const numerator = values[0].value!, denominator = values[1]?.value;
        if (denominator === 0) return { date, value: null, state: "zero_denominator", inputs };
        if (mapping.unit === "%" && !mapping.allowAboveOne && denominator !== undefined && denominator !== null && numerator > denominator) return { date, value: null, state: "invalid_value", inputs };
        return { date, value: (denominator == null ? numerator : numerator / denominator) / (mapping.resultDivisor ?? 1), state: "available", inputs };
    };
    return dailyDashboardV2SuccessSchema.parse({ success: true, data: {
      schemaVersion: DAILY_DASHBOARD_VERSION, query, queryId: randomUUID(), fetchedAt,
      timezone: "Asia/Shanghai", validationStatus: "pending_validation", completeness: "unknown", watermark: null, sourceApiIds: sourceApis(ids),
      series: ids.map(id => {
        const points = Array.from({ length: days }, (_, i) => pointFor(id, new Date(Date.parse(query.dateRange[0]) + i * 86400000).toISOString().slice(0, 10)));
        return { metric: metric(id), points, periodStatistics: periodStatistics(id, points, query, today) };
      })
    } });
  }
}
