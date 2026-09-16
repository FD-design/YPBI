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
export const CHANNEL_V2_API = "/api/admin/statistics/channel/channelStatByTypeV2";
export const PAYMENT_RATE_API = "/api/admin/consumptionMgr/payChannel/getRechargeSucRate";
export const CHECKIN_OVERVIEW_API = "/api/admin/dataDashboard/overview";
import { UpstreamError, type UpstreamClient } from "../upstream/client";
import { toBeijingDate } from "../upstream/date";

// Candidate projections are isolated from formal release-admission registries.
const AMOUNT_UNIT = "元";
const AMOUNT_PER_USER_UNIT = `${AMOUNT_UNIT}/人`;
const WATCH_TIME_NOTE = "接口记录时长，暂按秒换算，未额外剔除暂停、缓冲及后台时间；待验数。与正式指标的实际前台观看时长口径仍待核对。";
const baseMappings = {
  M101: { fields: ["watchCount"], inputIds: ["M101"], inputNames: ["播放发起次数"], inputUnits: ["次"], unit: "次", realtime: true, formula: "同一业务日完整 288 个五分钟统计点的播放发起次数之和", definition: "所选平台单日后台记录的视频播放发起次数。", sourceNote: "仅累计所选平台同一业务日完整、无重复的 288 个五分钟统计点；缺点或尚未结束的业务日不生成日总值。开始记录去重及测试流量排除规则待验数。" },
  M102: { fields: ["totalUserWatchTime"], inputIds: ["M102"], inputNames: ["接口记录观影时长"], inputUnits: ["秒（暂定）"], unit: "小时", channel: true, resultDivisor: 3600, formula: "接口记录观影时长（暂按秒） ÷ 3600", definition: "所选平台单日接口记录的观影时长总和，暂按秒换算为小时；未额外剔除暂停、缓冲及后台时间。", sourceNote: WATCH_TIME_NOTE },
  M098: { fields: ["totalUserWatchTime", "watchUserCount"], inputIds: ["M102", "M026"], inputNames: ["接口记录观影时长", "同范围观影用户数"], inputUnits: ["秒（暂定）", "人"], unit: "分钟/人", channel: true, resultDivisor: 60, formula: "接口记录观影时长（暂按秒） ÷ 同范围观影用户数 ÷ 60", definition: "所选平台单日接口记录观影时长除以同源观影用户数，换算为分钟/人；未额外剔除暂停、缓冲及后台时间。", sourceNote: WATCH_TIME_NOTE },
  M075: { fields: ["signInRate.raw.signed"], inputIds: ["M075"], inputNames: ["当日签到人数"], unit: "人", checkin: true },
  "M026.old": {referenceMetricId:"M026",name:"观影用户数（老用户）",fields:["oldUserWatchUserCount"],inputIds:["M026"],inputNames:["老用户观影人数"],unit:"人",channel:true},
  "M081.old": {referenceMetricId:"M081",name:"活跃用户观影率（老用户）",fields:["oldUserWatchUserCount","oldUserLoginUserCount"],inputIds:["M026","M016"],inputNames:["老用户观影人数","老用户活跃人数"],unit:"%",channel:true},
  "M112": {"referenceMetricId":"M112","name":"拉单次数","fields":["totalAllCount"],"inputIds":["M112"],"inputNames":["拉单次数"],"unit":"次","payment":true},
  "M060": {"referenceMetricId":"M060","name":"充值成功次数","fields":["totalSurCount"],"inputIds":["M060"],"inputNames":["充值成功次数"],"unit":"次","payment":true},
  "M114": {"referenceMetricId":"M114","name":"充值成功率","fields":["totalSurCount","totalAllCount"],"inputIds":["M114","M114"],"inputNames":["同日充值成功次数","同日拉单次数"],"unit":"%","payment":true},
  "M112.alipay": {"referenceMetricId":"M112","name":"拉单次数（支付宝）","fields":["aliTotalCount"],"inputIds":["M112"],"inputNames":["拉单次数（支付宝）"],"unit":"次","payment":true},
  "M060.alipay": {"referenceMetricId":"M060","name":"充值成功次数（支付宝）","fields":["aliTotalSucCount"],"inputIds":["M060"],"inputNames":["充值成功次数（支付宝）"],"unit":"次","payment":true},
  "M114.alipay": {"referenceMetricId":"M114","name":"充值成功率（支付宝）","fields":["aliTotalSucCount","aliTotalCount"],"inputIds":["M114","M114"],"inputNames":["同日充值成功次数（支付宝）","同日拉单次数（支付宝）"],"unit":"%","payment":true},
  "M112.wechat": {"referenceMetricId":"M112","name":"拉单次数（微信）","fields":["wxTotalCount"],"inputIds":["M112"],"inputNames":["拉单次数（微信）"],"unit":"次","payment":true},
  "M060.wechat": {"referenceMetricId":"M060","name":"充值成功次数（微信）","fields":["wxTotalSucCount"],"inputIds":["M060"],"inputNames":["充值成功次数（微信）"],"unit":"次","payment":true},
  "M114.wechat": {"referenceMetricId":"M114","name":"充值成功率（微信）","fields":["wxTotalSucCount","wxTotalCount"],"inputIds":["M114","M114"],"inputNames":["同日充值成功次数（微信）","同日拉单次数（微信）"],"unit":"%","payment":true},
  "M008.nature": {"referenceMetricId":"M008","name":"新增用户数（自然新增）","fields":["natureRegisterCount"],"inputIds":["M008"],"inputNames":["自然新增用户数"],"unit":"人","channel":true,"allowAboveOne":false},
  "M008.internal": {"referenceMetricId":"M008","name":"新增用户数（内部导量）","fields":["channelInternalRegisterCount"],"inputIds":["M008"],"inputNames":["内部标识注册用户数"],"unit":"人","channel":true,"allowAboveOne":false},
  "M058.nature": {"referenceMetricId":"M058","name":"充值金额（自然新增）","fields":["natureChargeAmt"],"inputIds":["M058"],"inputNames":["自然新增充值金额"],"unit":AMOUNT_UNIT,"channel":true,"allowAboveOne":false},
  "M058.internal": {"referenceMetricId":"M058","name":"充值金额（内部导量）","fields":["channelInternalChargeAmt"],"inputIds":["M058"],"inputNames":["内部标识新增充值金额"],"unit":AMOUNT_UNIT,"channel":true,"allowAboveOne":false},
  "M065": {"referenceMetricId":"M065","name":"VIP充值金额","fields":["vipChargeAmt"],"inputIds":["M065"],"inputNames":["VIP充值金额"],"unit":AMOUNT_UNIT,"channel":true,"allowAboveOne":false},
  "M066": {"referenceMetricId":"M066","name":"金币充值金额","fields":["goldChargeAmt"],"inputIds":["M066"],"inputNames":["金币充值金额"],"unit":AMOUNT_UNIT,"channel":true,"allowAboveOne":false},
  "M065.new": {"referenceMetricId":"M065","name":"VIP充值金额（新用户）","fields":["newUserVipChargeAmt"],"inputIds":["M065"],"inputNames":["新用户VIP充值金额"],"unit":AMOUNT_UNIT,"channel":true,"allowAboveOne":false},
  "M066.new": {"referenceMetricId":"M066","name":"金币充值金额（新用户）","fields":["newUserGoldChargeAmt"],"inputIds":["M066"],"inputNames":["新用户金币充值金额"],"unit":AMOUNT_UNIT,"channel":true,"allowAboveOne":false},
  "M003": {"referenceMetricId":"M003","name":"下载点击次数","fields":["totalDownCountNoDedup"],"inputIds":["M003"],"inputNames":["下载点击次数"],"unit":"次","channel":true,"allowAboveOne":false},
  "M005": {"referenceMetricId":"M005","name":"访问-下载点击转化率","fields":["totalDownCountNoDedup","visiCountNoDedup"],"inputIds":["M005","M005"],"inputNames":["下载点击次数","落地页访问次数"],"unit":"%","channel":true,"allowAboveOne":true},
  "M006": {"referenceMetricId":"M006","name":"下载点击-注册转化率","fields":["registerUserCount","totalDownCountByIp"],"inputIds":["M006","M006"],"inputNames":["注册用户数","下载 IP·天"],"unit":"%","channel":true,"allowAboveOne":true},
  "M007": {"referenceMetricId":"M007","name":"访问-注册转化率","fields":["registerUserCount","ipStatTotalCount"],"inputIds":["M007","M007"],"inputNames":["注册用户数","访问 IP·天"],"unit":"%","channel":true,"allowAboveOne":true},
  "M016.web": {"referenceMetricId":"M016","name":"日活跃用户数（Web）","fields":["webLoginUserCount"],"inputIds":["M016"],"inputNames":["Web 日活跃用户数"],"unit":"人"},
  "M008.web": {"referenceMetricId":"M008","name":"新增用户数（Web）","fields":["webNewUserCount"],"inputIds":["M008"],"inputNames":["Web 新增用户数"],"unit":"人"},
  "M026.web": {"referenceMetricId":"M026","name":"观影用户数（Web）","fields":["webWatchUserCount"],"inputIds":["M026"],"inputNames":["Web 观影用户数"],"unit":"人"},
  "M081.web": {"referenceMetricId":"M081","name":"活跃用户观影率（Web）","fields":["webWatchUserCount","webLoginUserCount"],"inputIds":["M081","M081"],"inputNames":["Web 观影用户数","Web 日活跃用户数"],"unit":"%"},
  "M055.navigation.new": {"referenceMetricId":"M055","name":"导航广告点击次数（新用户）","fields":["navClickedNewCount"],"inputIds":["M055"],"inputNames":["新增导航广告点击次数"],"unit":"次"},
  "M094.navigation.new": {"referenceMetricId":"M094","name":"导航广告点击人数（新用户）","fields":["navClickedNewPerson"],"inputIds":["M094"],"inputNames":["新增导航广告点击人数"],"unit":"人"},
  "M055.total.new": {"referenceMetricId":"M055","name":"总点击次数（新用户）","fields":["newUserTotalClickedCount"],"inputIds":["M055"],"inputNames":["新增总点击次数"],"unit":"次"},
  "M094.total.new": {"referenceMetricId":"M094","name":"总点击人数（新用户）","fields":["newUserTotalClickedPerson"],"inputIds":["M094"],"inputNames":["新增总点击人数"],"unit":"人"},
  "M020": { fields: ["afterFirstData1.loginCnt", "registerCount"], inputIds: ["M115", "M008"], inputNames: ["第1日留存人数", "该注册日用户数"], unit: "%", cohortDays: 1 },
  "M115.d1": { referenceMetricId: "M115", name: "注册用户第1日留存人数", fields: ["afterFirstData1.loginCnt"], inputIds: ["M115"], inputNames: ["第1日留存人数"], unit: "人", cohortDays: 1 },
  "M021": { fields: ["afterFirstData3.loginCnt", "registerCount"], inputIds: ["M115", "M008"], inputNames: ["第3日留存人数", "该注册日用户数"], unit: "%", cohortDays: 3 },
  "M115.d3": { referenceMetricId: "M115", name: "注册用户第3日留存人数", fields: ["afterFirstData3.loginCnt"], inputIds: ["M115"], inputNames: ["第3日留存人数"], unit: "人", cohortDays: 3 },
  "M022": { fields: ["afterFirstData7.loginCnt", "registerCount"], inputIds: ["M115", "M008"], inputNames: ["第7日留存人数", "该注册日用户数"], unit: "%", cohortDays: 7 },
  "M115.d7": { referenceMetricId: "M115", name: "注册用户第7日留存人数", fields: ["afterFirstData7.loginCnt"], inputIds: ["M115"], inputNames: ["第7日留存人数"], unit: "人", cohortDays: 7 },
  "M023": { fields: ["afterFirstData30.loginCnt", "registerCount"], inputIds: ["M115", "M008"], inputNames: ["第30日留存人数", "该注册日用户数"], unit: "%", cohortDays: 30 },
  "M115.d30": { referenceMetricId: "M115", name: "注册用户第30日留存人数", fields: ["afterFirstData30.loginCnt"], inputIds: ["M115"], inputNames: ["第30日留存人数"], unit: "人", cohortDays: 30 },
  "M016.android": {"referenceMetricId":"M016","name":"日活跃用户数（Android）","fields":["androidLoginUserCount"],"inputIds":["M016"],"inputNames":["Android 日活跃用户数"],"unit":"人"},
  "M016.ios": {"referenceMetricId":"M016","name":"日活跃用户数（iOS）","fields":["iosLoginUserCount"],"inputIds":["M016"],"inputNames":["iOS 日活跃用户数"],"unit":"人"},
  "M016.old": {"referenceMetricId":"M016","name":"日活跃用户数（老用户）","fields":["oldUserLoginUserCount"],"inputIds":["M016"],"inputNames":["老用户日活跃用户数"],"unit":"人"},
  "M008.android": {"referenceMetricId":"M008","name":"新增用户数（Android）","fields":["androidNewUserCount"],"inputIds":["M008"],"inputNames":["Android 新增用户数"],"unit":"人"},
  "M008.ios": {"referenceMetricId":"M008","name":"新增用户数（iOS）","fields":["iosNewUserCount"],"inputIds":["M008"],"inputNames":["iOS 新增用户数"],"unit":"人"},
  "M026.android": {"referenceMetricId":"M026","name":"观影用户数（Android）","fields":["androidWatchUserCount"],"inputIds":["M026"],"inputNames":["Android 观影用户数"],"unit":"人"},
  "M026.ios": {"referenceMetricId":"M026","name":"观影用户数（iOS）","fields":["iosWatchUserCount"],"inputIds":["M026"],"inputNames":["iOS 观影用户数"],"unit":"人"},
  "M026.new": {"referenceMetricId":"M026","name":"观影用户数（新用户）","fields":["newUserWatchUserCount"],"inputIds":["M026"],"inputNames":["新增观影用户数"],"unit":"人"},
  "M081.android": {"referenceMetricId":"M081","name":"活跃用户观影率（Android）","fields":["androidWatchUserCount","androidLoginUserCount"],"inputIds":["M081","M081"],"inputNames":["Android 观影用户数","Android 日活跃用户数"],"unit":"%"},
  "M081.ios": {"referenceMetricId":"M081","name":"活跃用户观影率（iOS）","fields":["iosWatchUserCount","iosLoginUserCount"],"inputIds":["M081","M081"],"inputNames":["iOS 观影用户数","iOS 日活跃用户数"],"unit":"%"},
  "M055.new": {"referenceMetricId":"M055","name":"广告点击次数（新用户）","fields":["adsClickedNewCount"],"inputIds":["M055"],"inputNames":["新增广告点击次数"],"unit":"次"},
  "M094.new": {"referenceMetricId":"M094","name":"广告点击人数（新用户）","fields":["adsClickedNewPerson"],"inputIds":["M094"],"inputNames":["新增广告点击人数"],"unit":"人"},
  "M058.new": {"referenceMetricId":"M058","name":"总充值金额（新用户）","fields":["newUserDiamondChargeAmt"],"inputIds":["M058"],"inputNames":["新增充值金额"],"unit":AMOUNT_UNIT},
  "M088": {"referenceMetricId":"M088","name":"新增用户 ARPU","fields":["newUserDiamondChargeAmt","registerUserCount"],"inputIds":["M088","M088"],"inputNames":["新增充值金额","新增用户数"],"unit":AMOUNT_PER_USER_UNIT},
  "M067.new": {"referenceMetricId":"M067","name":"ARPPU（新用户）","fields":["newUserDiamondChargeAmt","newUserChargeUserCount"],"inputIds":["M067","M067"],"inputNames":["新增充值金额","新增付费人数"],"unit":AMOUNT_PER_USER_UNIT},
  "display:M016": {"referenceMetricId":"M016","name":"日活 Android:iOS","fields":["androidLoginUserCount","iosLoginUserCount"],"inputIds":["M016","M016"],"inputNames":["Android 日活跃用户数","iOS 日活跃用户数"],"unit":"Android:iOS"},
  "display:M008": {"referenceMetricId":"M008","name":"新增 Android:iOS","fields":["androidNewUserCount","iosNewUserCount"],"inputIds":["M008","M008"],"inputNames":["Android 新增用户数","iOS 新增用户数"],"unit":"Android:iOS"},
  "M001": {"referenceMetricId":"M001","name":"落地页访问次数","fields":["totalVistCount"],"inputIds":["M001"],"inputNames":["落地页访问次数"],"unit":"次"},
  M016: { fields: ["loginUserCount"], inputIds: ["M016"], unit: "人" },
  M026: { fields: ["watchUserCount"], inputIds: ["M026"], unit: "人" },
  M059: { fields: ["totalChargeUserCount"], inputIds: ["M059"], unit: "人" },
  M081: { fields: ["watchUserCount", "loginUserCount"], inputIds: ["M026", "M016"], unit: "%" },
  M061: { fields: ["totalChargeUserCount", "loginUserCount"], inputIds: ["M059", "M016"], unit: "%" },
  M008: { fields: ["registerUserCount"], inputIds: ["M008"], unit: "人" },
  M064: { fields: ["newUserChargeUserCount", "registerUserCount"], inputIds: ["M059", "M008"], inputNames: ["新增付费人数", "新增用户数"], unit: "%" },
  M058: { fields: ["diamondChargeAmt"], inputIds: ["M058"], unit: AMOUNT_UNIT },
  M067: { fields: ["diamondChargeAmt", "totalChargeUserCount"], inputIds: ["M058", "M059"], unit: AMOUNT_PER_USER_UNIT },
  M087: { fields: ["diamondChargeAmt", "loginUserCount"], inputIds: ["M058", "M016"], unit: AMOUNT_PER_USER_UNIT },
  M110: { fields: ["adsCount", "loginUserCount"], inputIds: ["M055", "M016"], inputNames: ["广告点击次数", "日活跃用户数"], unit: "次/人" },
  M111: { fields: ["adsClickedPerson", "loginUserCount"], inputIds: ["M094", "M016"], inputNames: ["广告点击人数", "日活跃用户数"], unit: "%" },
  "M059.new": { referenceMetricId: "M059", name: "新增付费人数", fields: ["newUserChargeUserCount"], inputIds: ["M059"], inputNames: ["新增付费人数"], unit: "人" },
  "M055.ads": { referenceMetricId: "M055", name: "广告点击次数", fields: ["adsCount"], inputIds: ["M055"], unit: "次" },
  "M055.navigation": { referenceMetricId: "M055", name: "导航广告点击次数", fields: ["navCount"], inputIds: ["M055"], unit: "次" },
  "M055.total": { referenceMetricId: "M055", name: "总点击次数", fields: ["totalClickedCount"], inputIds: ["M055"], unit: "次" },
  "M094.ads": { referenceMetricId: "M094", name: "广告点击人数", fields: ["adsClickedPerson"], inputIds: ["M094"], unit: "人" },
  "M094.navigation": { referenceMetricId: "M094", name: "导航广告点击人数", fields: ["navClickedPerson"], inputIds: ["M094"], unit: "人" },
  "M094.total": { referenceMetricId: "M094", name: "总点击人数", fields: ["totalClickedPerson"], inputIds: ["M094"], unit: "人" }
} as const;
type CandidateId = keyof typeof baseMappings;
type CandidateMapping = { fields: readonly string[]; inputIds: readonly string[]; unit: string; referenceMetricId?: string; name?: string; inputNames?: readonly string[]; inputUnits?: readonly string[]; cohortDays?: number; channel?: boolean; payment?: boolean; checkin?: boolean; realtime?: boolean; allowAboveOne?: boolean; resultDivisor?: number; formula?: string; definition?: string; sourceNote?: string };
const mappings: Record<CandidateId, CandidateMapping> = baseMappings;
// Each capability applies to this exact candidate projection and its existing daily source.
const periodStatisticKinds: Partial<Record<CandidateId, readonly DailyPeriodStatistics["values"][number]["kind"][]>> = {
  M102: ["period_sum", "daily_average"], M058: ["period_sum", "daily_average"], M065: ["period_sum", "daily_average"], M066: ["period_sum", "daily_average"],
  "M058.new": ["period_sum", "daily_average"], "M058.nature": ["period_sum", "daily_average"], "M058.internal": ["period_sum", "daily_average"],
  "M065.new": ["period_sum", "daily_average"], "M066.new": ["period_sum", "daily_average"],
  M101: ["period_sum", "daily_average"], M001: ["period_sum", "daily_average"], M003: ["period_sum", "daily_average"], M008: ["period_sum", "daily_average"],
  "M055.ads": ["period_sum", "daily_average"], "M055.navigation": ["period_sum", "daily_average"], "M055.total": ["period_sum", "daily_average"],
  "M055.new": ["period_sum", "daily_average"], "M055.navigation.new": ["period_sum", "daily_average"], "M055.total.new": ["period_sum", "daily_average"],
  M060: ["period_sum", "daily_average"], "M060.alipay": ["period_sum", "daily_average"], "M060.wechat": ["period_sum", "daily_average"],
  M112: ["period_sum", "daily_average"], "M112.alipay": ["period_sum", "daily_average"], "M112.wechat": ["period_sum", "daily_average"],
  M016: ["daily_average"], "M016.android": ["daily_average"], "M016.ios": ["daily_average"], "M016.web": ["daily_average"], "M016.old": ["daily_average"],
  M026: ["daily_average"], "M026.android": ["daily_average"], "M026.ios": ["daily_average"], "M026.web": ["daily_average"], "M026.new": ["daily_average"], "M026.old": ["daily_average"],
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
  "5.12": ["M101"],
  "5.7": ["M001", "M003", "M005", "M006", "M007", "M008", "M008.android", "M008.ios", "M008.web", "M008.nature", "M008.internal", "M059.new", "M064"],
  "5.8": ["M016", "M016.android", "M016.ios", "M016.web", "M016.old", "M020", "M021", "M022", "M023", "M115.d1", "M115.d3", "M115.d7", "M115.d30"], "5.9": ["M026", "M081", "M101", "M102", "M098", "M026.android", "M026.ios", "M026.web", "M026.new", "M026.old", "M081.android", "M081.ios", "M081.web", "M081.old"],
  "5.10": ["M059", "M058", "M061", "M067", "M087", "M059.new", "M064", "M058.new", "M088", "M067.new", "M065", "M066", "M065.new", "M066.new"],
  "5.11": ["M059", "M058", "M061", "M067", "M087", "M112", "M060", "M114", "M112.alipay", "M060.alipay", "M114.alipay", "M112.wechat", "M060.wechat", "M114.wechat"]
};
const pending: Record<string, string[]> = {
  "5.12": ["M083", "M031", "M036", "M097", "M030", "M032"],
  "5.2": ["M036"], "5.7": ["M002"],
  "5.8": ["M018"], "5.9": ["M036", "M040", "M041", "M042"],
  "5.10": [], "5.11": ["M113"],
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
  return [
    ...(ids.some(id => !mappings[id].cohortDays && !mappings[id].channel && !mappings[id].payment && !mappings[id].checkin && !mappings[id].realtime) ? [P_DAY_SUM_API] : []),
    ...(ids.some(id => mappings[id].cohortDays) ? [RETENTION_PLUS_API] : []),
    ...(ids.some(id => mappings[id].channel) ? [CHANNEL_V2_API] : []),
    ...(ids.some(id => mappings[id].payment) ? [PAYMENT_RATE_API] : []),
    ...(ids.some(id => mappings[id].checkin) ? [CHECKIN_OVERVIEW_API] : []),
    ...(ids.some(id => mappings[id].realtime) ? [REALTIME_API] : [])
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
    inputs: mapping.fields.map((key, index) => ({ key, name: mapping.inputNames?.[index] ?? mapping.name ?? getV2MetricDefinition(mapping.inputIds[index])!.name, unit: mapping.inputUnits?.[index] ?? (mapping.payment ? "次" : key.endsWith("Amt") ? AMOUNT_UNIT : ["adsCount", "navCount", "totalClickedCount", "adsClickedNewCount", "totalVistCount", "navClickedNewCount", "newUserTotalClickedCount", "totalDownCountNoDedup", "visiCountNoDedup"].includes(key) ? "次" : ["totalDownCountByIp", "ipStatTotalCount"].includes(key) ? "IP·天" : "人") }))
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
    await Promise.all([dailyTask, cohortTask, paymentTask, channelTask, checkinTask, watchTask]);
    return dailyDashboardV2SuccessSchema.parse({ success: true, data: {
      schemaVersion: DAILY_DASHBOARD_VERSION, query, queryId: randomUUID(), fetchedAt,
      timezone: "Asia/Shanghai", validationStatus: "pending_validation", completeness: "unknown", watermark: null, sourceApiIds: sourceApis(ids),
      series: ids.map(id => {
        const points: DailyPoint[] = Array.from({ length: days }, (_, i) => {
        const date = new Date(Date.parse(query.dateRange[0]) + i * 86400000).toISOString().slice(0, 10);
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
        });
        return { metric: metric(id), points, periodStatistics: periodStatistics(id, points, query, today) };
      })
    } });
  }
}
