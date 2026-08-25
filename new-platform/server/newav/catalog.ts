export type NewavDatasetId =
  | "overview"
  | "operations"
  | "intraday"
  | "period"
  | "daily"
  | "pvTrend"
  | "aggregate"
  | "registrationSources"
  | "renewal"
  | "adStats"
  | "channelDaily"
  | "channelQuality";

export interface NewavDatasetDefinition {
  id: NewavDatasetId;
  name: string;
  method: "GET" | "POST";
  path: string;
  grain: string;
  description: string;
  parameters: string[];
}

export const newavDatasets: NewavDatasetDefinition[] = [
  { id: "overview", name: "经营总览", method: "GET", path: "/admin/analytics/overview", grain: "当前汇总", description: "产品经营核心指标总览", parameters: [] },
  { id: "operations", name: "单日运营", method: "GET", path: "/admin/analytics/operations", grain: "自然日", description: "指定日期的运营表现", parameters: ["date"] },
  { id: "intraday", name: "日内趋势", method: "GET", path: "/admin/analytics/intraday", grain: "自然日 × 时段", description: "指定日期的小时或时段趋势", parameters: ["date"] },
  { id: "period", name: "周期数据", method: "GET", path: "/admin/analytics/period", grain: "自然日", description: "日期区间趋势与累计", parameters: ["from", "to"] },
  { id: "daily", name: "每日汇总", method: "GET", path: "/admin/analytics/daily", grain: "自然日", description: "指定日期汇总", parameters: ["date"] },
  { id: "pvTrend", name: "访问趋势", method: "GET", path: "/admin/analytics/pv-trend", grain: "自然日", description: "最近若干日 PV 趋势", parameters: ["days"] },
  { id: "aggregate", name: "聚合统计", method: "POST", path: "/admin/analytics/aggregate", grain: "指定日期汇总", description: "后台聚合指标", parameters: ["date"] },
  { id: "registrationSources", name: "注册来源", method: "GET", path: "/admin/analytics/reg-sources", grain: "来源 × 日期区间", description: "注册用户来源构成", parameters: ["from", "to"] },
  { id: "renewal", name: "续费分析", method: "GET", path: "/admin/analytics/renewal", grain: "续费周期", description: "到期与续费表现", parameters: ["days", "grace"] },
  { id: "adStats", name: "广告表现", method: "GET", path: "/admin/analytics/ad-stats", grain: "广告位 × 日期区间", description: "广告曝光和点击表现", parameters: ["from", "to"] },
  { id: "channelDaily", name: "渠道每日数据", method: "GET", path: "/admin/analytics/channels-daily", grain: "渠道 × 自然日", description: "渠道获客、活跃、观影、广告和付费", parameters: ["from", "to", "code"] },
  { id: "channelQuality", name: "渠道质量", method: "GET", path: "/admin/analytics/channels-metrics", grain: "渠道 × 日期区间", description: "渠道转化、设备、播放、留存和付费质量", parameters: ["from", "to"] }
];

export function getNewavDataset(id: string) {
  return newavDatasets.find((item) => item.id === id);
}
