import { contentRows, eventDictionary, platforms, searchRows } from "../data/newavData";
import type { AnalysisModelId, DashboardCardConfig, MetricId } from "../types";

export type PlatformMode = "all" | "single" | "compare";
export type DateRange = "今日" | "近7日" | "近30日" | "自定义";
export type ComparisonMode = "calendarMonth" | "equalLength" | "sameProgress";

export interface DashboardFilters {
  dateRange: DateRange;
  mode: PlatformMode;
  platforms: string[];
  customStart?: string;
  customEnd?: string;
  compareStart?: string;
  compareEnd?: string;
  comparisonMode?: ComparisonMode;
}

export interface MetricAggregate {
  metric: MetricId;
  value: number;
  formatted: string;
  change: number;
  changeLabel: string;
}

export interface QuerySeries {
  name: string;
  metric: MetricId;
  data: number[];
}

export interface FunnelStepResult {
  eventId: string;
  name: string;
  value: number;
  conversion: number;
  stepConversion: number;
  dropoff: number;
}

export interface CardQueryResult {
  scopeLabel: string;
  categories: string[];
  series: QuerySeries[];
  summary: MetricAggregate[];
  table: Record<string, string | number>[];
  funnel?: FunnelStepResult[];
  heatmap?: Array<[number, number, number]>;
  heatmapX?: string[];
  heatmapY?: string[];
  scatter?: Array<{ name: string; value: [number, number, number]; extra?: string }>;
  treemap?: Array<Record<string, unknown>>;
  cohort?: Array<[number, number, number]>;
  cohortX?: string[];
  cohortY?: string[];
  waterfall?: Array<{ name: string; value: number }>;
  sankey?: { nodes: Array<{ name: string }>; links: Array<{ source: string; target: string; value: number }> };
  insights: string[];
}

interface DailyRow {
  date: string;
  platform: string;
  dau: number;
  newUsers: number;
  revenue: number;
  viewers: number;
  payers: number;
  retainedD1: number;
  videoExposures: number;
  videoClicks: number;
  playStarts: number;
  completes: number;
  searches: number;
  noResultSearches: number;
  foregroundMinutes: number;
  watchMinutes: number;
  pageViews: number;
  pageClicks: number;
  currentPaidMembers: number;
  historicalPaidMembers: number;
  renewedMembers: number;
  expiringMembers: number;
}

interface MetricMeta {
  name: string;
  unit: "number" | "percent" | "currency" | "minutes";
  aggregation: "sum" | "average" | "latest" | "weighted";
  positive: boolean;
}

export const DEFAULT_FILTERS: DashboardFilters = {
  dateRange: "近7日",
  mode: "single",
  platforms: ["NewAV"],
  comparisonMode: "equalLength"
};

function formatLocalDate(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function resolveDashboardDateRange(filters: DashboardFilters): [string, string] {
  if (filters.dateRange === "自定义" && filters.customStart && filters.customEnd && filters.customStart <= filters.customEnd) {
    return [filters.customStart, filters.customEnd];
  }
  const end = new Date();
  const start = new Date(end);
  start.setDate(end.getDate() - (filters.dateRange === "今日" ? 0 : filters.dateRange === "近30日" ? 29 : 6));
  return [formatLocalDate(start), formatLocalDate(end)];
}

export function resolveComparisonDateRange(filters: DashboardFilters): [string, string] {
  const [start, end] = resolveDashboardDateRange(filters);
  if (!filters.comparisonMode && filters.compareStart && filters.compareEnd && filters.compareStart <= filters.compareEnd) return [filters.compareStart, filters.compareEnd];
  const mode = filters.comparisonMode ?? "equalLength";
  const endDate = new Date(`${end}T00:00:00`);
  if (mode === "calendarMonth") {
    const compareStart = new Date(endDate.getFullYear(), endDate.getMonth() - 1, 1);
    const compareEnd = new Date(endDate.getFullYear(), endDate.getMonth(), 0);
    return [formatLocalDate(compareStart), formatLocalDate(compareEnd)];
  }
  if (mode === "sameProgress") {
    const compareStart = new Date(endDate.getFullYear(), endDate.getMonth() - 1, 1);
    const previousMonthEnd = new Date(endDate.getFullYear(), endDate.getMonth(), 0);
    const compareEnd = new Date(compareStart.getFullYear(), compareStart.getMonth(), Math.min(endDate.getDate(), previousMonthEnd.getDate()));
    return [formatLocalDate(compareStart), formatLocalDate(compareEnd)];
  }
  const startDate = new Date(`${start}T00:00:00`);
  const days = Math.round((endDate.getTime() - startDate.getTime()) / 86400000) + 1;
  const compareEnd = new Date(startDate);
  compareEnd.setDate(compareEnd.getDate() - 1);
  const compareStart = new Date(compareEnd);
  compareStart.setDate(compareStart.getDate() - days + 1);
  return [formatLocalDate(compareStart), formatLocalDate(compareEnd)];
}

export const PLATFORM_COLORS: Record<string, string> = {
  NewAV: "#2563eb",
  小红书: "#ef4444",
  色虎: "#f59e0b",
  "PH·Prem": "#7c3aed",
  快播: "#db2777",
  黄片网盘: "#4f46e5",
  性欲社: "#059669",
  "X-chat": "#64748b",
  白嫖社: "#0284c7",
  好妻网: "#9333ea",
  台姬店: "#8b5cf6",
  魅魔vlog: "#0d9488",
  稚嫩学园: "#ca8a04",
  铁粉空间: "#db2777",
  精日头条: "#c2410c",
  "91淫妻": "#be123c"
};

export const METRIC_META: Record<MetricId, MetricMeta> = {
  dau: { name: "日均DAU", unit: "number", aggregation: "average", positive: true },
  dauUserDays: { name: "累计活跃人天", unit: "number", aggregation: "sum", positive: true },
  newUsers: { name: "新增用户", unit: "number", aggregation: "sum", positive: true },
  viewerCount: { name: "日均观影人数", unit: "number", aggregation: "average", positive: true },
  viewerUserDays: { name: "累计观影人天", unit: "number", aggregation: "sum", positive: true },
  searchCount: { name: "搜索次数", unit: "number", aggregation: "sum", positive: true },
  revenue: { name: "收入", unit: "currency", aggregation: "sum", positive: true },
  viewRate: { name: "观影率", unit: "percent", aggregation: "weighted", positive: true },
  payRate: { name: "付费率", unit: "percent", aggregation: "weighted", positive: true },
  payerCount: { name: "日均付费人数", unit: "number", aggregation: "average", positive: true },
  payerUserDays: { name: "累计付费人天", unit: "number", aggregation: "sum", positive: true },
  visits: { name: "访问", unit: "number", aggregation: "sum", positive: true },
  downloads: { name: "下载", unit: "number", aggregation: "sum", positive: true },
  visitDownloadRate: { name: "访问→下载转化", unit: "percent", aggregation: "weighted", positive: true },
  downloadRegisterRate: { name: "下载→注册转化", unit: "percent", aggregation: "weighted", positive: true },
  visitRegisterRate: { name: "访问→注册转化", unit: "percent", aggregation: "weighted", positive: true },
  retentionD1: { name: "次留", unit: "percent", aggregation: "weighted", positive: true },
  retentionD3: { name: "D3留存", unit: "percent", aggregation: "weighted", positive: true },
  retentionD7: { name: "D7留存", unit: "percent", aggregation: "weighted", positive: true },
  retentionD30: { name: "D30留存", unit: "percent", aggregation: "weighted", positive: true },
  videoCtr: { name: "视频 CTR", unit: "percent", aggregation: "weighted", positive: true },
  playRate: { name: "播放率", unit: "percent", aggregation: "weighted", positive: true },
  completeRate: { name: "完播率", unit: "percent", aggregation: "weighted", positive: true },
  searchNoResultRate: { name: "搜索无结果率", unit: "percent", aggregation: "weighted", positive: false },
  arppu: { name: "ARPPU", unit: "currency", aggregation: "weighted", positive: true },
  arpu: { name: "ARPU", unit: "currency", aggregation: "weighted", positive: true },
  androidDau: { name: "Android日均活跃", unit: "number", aggregation: "average", positive: true },
  androidDauUserDays: { name: "Android累计活跃人天", unit: "number", aggregation: "sum", positive: true },
  iosDau: { name: "IOS日均活跃", unit: "number", aggregation: "average", positive: true },
  iosDauUserDays: { name: "IOS累计活跃人天", unit: "number", aggregation: "sum", positive: true },
  androidNewUsers: { name: "Android新增", unit: "number", aggregation: "sum", positive: true },
  iosNewUsers: { name: "IOS新增", unit: "number", aggregation: "sum", positive: true },
  organicNewUsers: { name: "自然新增", unit: "number", aggregation: "sum", positive: true },
  internalNewUsers: { name: "内部导量新增", unit: "number", aggregation: "sum", positive: true },
  adClickCount: { name: "广告点击人次", unit: "number", aggregation: "sum", positive: true },
  adClickUsers: { name: "日均广告点击人数", unit: "number", aggregation: "average", positive: true },
  adClickUserDays: { name: "累计广告点击人天", unit: "number", aggregation: "sum", positive: true },
  adClickRate: { name: "广告点击人次率", unit: "percent", aggregation: "weighted", positive: true },
  adClickUserRate: { name: "广告点击人数率", unit: "percent", aggregation: "weighted", positive: true },
  newAdClickCount: { name: "新增广告点击人次", unit: "number", aggregation: "sum", positive: true },
  newAdClickUsers: { name: "新增广告点击人数", unit: "number", aggregation: "sum", positive: true },
  newAdClickRate: { name: "新增广告点击人次率", unit: "percent", aggregation: "weighted", positive: true },
  newAdClickUserRate: { name: "新增广告点击人数率", unit: "percent", aggregation: "weighted", positive: true },
  oldAdClickCount: { name: "老用户广告点击人次", unit: "number", aggregation: "sum", positive: true },
  oldAdClickUsers: { name: "日均老用户广告点击人数", unit: "number", aggregation: "average", positive: true },
  oldAdClickUserDays: { name: "累计老用户广告点击人天", unit: "number", aggregation: "sum", positive: true },
  oldAdClickRate: { name: "老用户广告点击人次率", unit: "percent", aggregation: "weighted", positive: true },
  oldAdClickUserRate: { name: "老用户广告点击人数率", unit: "percent", aggregation: "weighted", positive: true },
  newRevenue: { name: "新增充值金额", unit: "currency", aggregation: "sum", positive: true },
  newPayerCount: { name: "新增充值人数", unit: "number", aggregation: "sum", positive: true },
  newPayRate: { name: "新增充值付费率", unit: "percent", aggregation: "weighted", positive: true },
  newArpu: { name: "新增充值ARPU", unit: "currency", aggregation: "weighted", positive: true },
  newArppu: { name: "新增充值ARPPU", unit: "currency", aggregation: "weighted", positive: true },
  oldRevenue: { name: "老用户充值金额", unit: "currency", aggregation: "sum", positive: true },
  oldPayerCount: { name: "日均老用户充值人数", unit: "number", aggregation: "average", positive: true },
  oldPayerUserDays: { name: "累计老用户付费人天", unit: "number", aggregation: "sum", positive: true },
  oldPayRate: { name: "老用户充值付费率", unit: "percent", aggregation: "weighted", positive: true },
  oldArpu: { name: "老用户充值ARPU", unit: "currency", aggregation: "weighted", positive: true },
  oldArppu: { name: "老用户充值ARPPU", unit: "currency", aggregation: "weighted", positive: true },
  channelNewRevenue: { name: "渠道新增充值", unit: "currency", aggregation: "sum", positive: true },
  internalNewRevenue: { name: "内部导量充值", unit: "currency", aggregation: "sum", positive: true },
  avgUsageMinutes: { name: "人均使用时长", unit: "minutes", aggregation: "weighted", positive: true },
  avgWatchMinutes: { name: "人均观影时长", unit: "minutes", aggregation: "weighted", positive: true },
  pageViews: { name: "广告展示次数", unit: "number", aggregation: "sum", positive: true },
  pageClicks: { name: "播放错误次数", unit: "number", aggregation: "sum", positive: false },
  currentPaidMembers: { name: "当前活跃 VIP", unit: "number", aggregation: "latest", positive: true },
  historicalPaidMembers: { name: "订单总数", unit: "number", aggregation: "latest", positive: true },
  renewalRate: { name: "续费率", unit: "percent", aggregation: "weighted", positive: true }
  ,videoWatchCount: { name: "播放成功次数", unit: "number", aggregation: "sum", positive: true }
  ,videoViewerCount: { name: "视频观看人数", unit: "number", aggregation: "sum", positive: true }
  ,videoLikeCount: { name: "视频点赞数", unit: "number", aggregation: "sum", positive: true }
  ,videoCollectCount: { name: "视频收藏数", unit: "number", aggregation: "sum", positive: true }
};

const round = (value: number, digits = 2) => Number(value.toFixed(digits));

const dateLabels = Array.from({ length: 30 }, (_, index) => {
  const date = new Date(Date.UTC(2026, 5, 11 + index));
  return `${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
});

const dailyRows: DailyRow[] = dateLabels.flatMap((date, dayIndex) => platforms.map((platform, platformIndex) => {
  const wave = 1 + Math.sin((dayIndex + platformIndex * 1.7) * 0.72) * 0.055;
  const growth = 0.87 + dayIndex * 0.0055;
  const scale = growth * wave;
  const dau = Math.round(platform.dau * 1000 * scale);
  const newUsers = Math.round(platform.newUsers * 1000 * (0.82 + dayIndex * 0.006 + Math.cos(dayIndex + platformIndex) * 0.04));
  const payRate = platform.payRate * (0.92 + Math.sin(dayIndex * 0.43 + platformIndex) * 0.07);
  const payers = Math.max(1, Math.round(dau * payRate / 100));
  const arppu = platform.arppu * (0.96 + Math.cos(dayIndex * 0.37 + platformIndex) * 0.05);
  const viewRate = platform.viewRate * (0.98 + Math.sin(dayIndex * 0.31 + platformIndex) * 0.018);
  const viewers = Math.round(dau * Math.min(0.98, viewRate / 100));
  const videoExposures = Math.round(dau * (8.1 + platformIndex * 0.18));
  const ctr = 0.108 + (7 - platformIndex) * 0.006 + Math.sin(dayIndex * 0.6 + platformIndex) * 0.009;
  const videoClicks = Math.round(videoExposures * ctr);
  const playStarts = Math.min(videoClicks, Math.round(videoClicks * (0.78 - platformIndex * 0.018 + Math.sin(dayIndex * 0.4) * 0.025)));
  const completes = Math.round(playStarts * (0.38 - platformIndex * 0.012 + Math.cos(dayIndex * 0.3) * 0.025));
  const searches = Math.round(dau * (0.72 + platformIndex * 0.035));
  const noResultSearches = Math.round(searches * (0.08 + platformIndex * 0.012 + Math.sin(dayIndex * 0.41) * 0.015));
  const currentPaidMembers = Math.round(dau * (0.118 + platform.payRate / 100));

  return {
    date,
    platform: platform.platform,
    dau,
    newUsers,
    revenue: Math.round(payers * arppu),
    viewers,
    payers,
    retainedD1: Math.round(newUsers * platform.retentionD1 / 100 * (0.96 + Math.sin(dayIndex * 0.28) * 0.04)),
    videoExposures,
    videoClicks,
    playStarts,
    completes,
    searches,
    noResultSearches,
    foregroundMinutes: Math.round(dau * (12.4 + platformIndex * 0.55 + Math.sin(dayIndex * 0.25) * 0.8)),
    watchMinutes: Math.round(viewers * (8.7 + platformIndex * 0.31 + Math.cos(dayIndex * 0.22) * 0.7)),
    pageViews: Math.round(dau * (5.2 + platformIndex * 0.15)),
    pageClicks: Math.round(dau * (1.72 + platformIndex * 0.08)),
    currentPaidMembers,
    historicalPaidMembers: Math.round(currentPaidMembers * (4.2 + dayIndex * 0.018)),
    renewedMembers: Math.round(currentPaidMembers * (0.42 + platformIndex * 0.012)),
    expiringMembers: Math.round(currentPaidMembers * (0.55 + platformIndex * 0.01))
  };
}));

function getRangeSize(filters: DashboardFilters) {
  const [start, end] = resolveDashboardDateRange(filters);
  const days = Math.floor((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1;
  return Math.max(1, Math.min(dateLabels.length, Number.isFinite(days) ? days : 7));
}

function getSelectedPlatforms(filters: DashboardFilters) {
  if (filters.mode === "all" || filters.platforms.length === 0) return platforms.map((item) => item.platform);
  return filters.platforms.slice(0, filters.mode === "compare" ? 8 : 1);
}

function getRows(filters: DashboardFilters, offset = 0) {
  const size = getRangeSize(filters);
  const end = Math.max(0, dateLabels.length - offset);
  const selectedDates = dateLabels.slice(Math.max(0, end - size), end);
  const selectedPlatforms = new Set(getSelectedPlatforms(filters));
  return dailyRows.filter((row) => selectedDates.includes(row.date) && selectedPlatforms.has(row.platform));
}

function ratio(rows: DailyRow[], numerator: (row: DailyRow) => number, denominator: (row: DailyRow) => number, multiplier = 100) {
  const num = rows.reduce((total, row) => total + numerator(row), 0);
  const den = rows.reduce((total, row) => total + denominator(row), 0);
  return den ? num / den * multiplier : 0;
}

function metricValue(metric: MetricId, rows: DailyRow[]) {
  if (!rows.length) return 0;
  const latestDate = rows.reduce((latest, row) => row.date > latest ? row.date : latest, rows[0].date);
  const latest = rows.filter((row) => row.date === latestDate);
  const sum = (field: keyof DailyRow) => rows.reduce((total, row) => total + Number(row[field]), 0);
  const latestSum = (field: keyof DailyRow) => latest.reduce((total, row) => total + Number(row[field]), 0);
  const dayCount = new Set(rows.map((row) => row.date)).size || 1;
  const dailyAverage = (field: keyof DailyRow) => sum(field) / dayCount;

  switch (metric) {
    case "dau": return dailyAverage("dau");
    case "dauUserDays": return sum("dau");
    case "newUsers": return sum("newUsers");
    case "viewerCount": return dailyAverage("viewers");
    case "viewerUserDays": return sum("viewers");
    case "searchCount": return sum("searches");
    case "revenue": return sum("revenue");
    case "viewRate": return ratio(rows, (row) => row.viewers, (row) => row.dau);
    case "payRate": return ratio(rows, (row) => row.payers, (row) => row.dau);
    case "payerCount": return dailyAverage("payers");
    case "payerUserDays": return sum("payers");
    case "visits": return Math.round(sum("newUsers") * 1.45);
    case "downloads": return Math.round(sum("newUsers") * 0.96);
    case "visitDownloadRate": return ratio(rows, (row) => row.newUsers * 0.96, (row) => row.newUsers * 1.45);
    case "downloadRegisterRate": return ratio(rows, (row) => row.newUsers, (row) => row.newUsers * 0.96);
    case "visitRegisterRate": return ratio(rows, (row) => row.newUsers, (row) => row.newUsers * 1.45);
    case "retentionD1": return ratio(rows, (row) => row.retainedD1, (row) => row.newUsers);
    case "retentionD3": return ratio(rows, (row) => row.retainedD1 * 0.68, (row) => row.newUsers);
    case "retentionD7": return ratio(rows, (row) => row.retainedD1 * 0.46, (row) => row.newUsers);
    case "retentionD30": return ratio(rows, (row) => row.retainedD1 * 0.22, (row) => row.newUsers);
    case "videoCtr": return ratio(rows, (row) => row.videoClicks, (row) => row.videoExposures);
    case "playRate": return ratio(rows, (row) => row.playStarts, (row) => row.videoClicks);
    case "completeRate": return ratio(rows, (row) => row.completes, (row) => row.playStarts);
    case "searchNoResultRate": return ratio(rows, (row) => row.noResultSearches, (row) => row.searches);
    case "arppu": return ratio(rows, (row) => row.revenue, (row) => row.payers, 1);
    case "arpu": return ratio(rows, (row) => row.revenue, (row) => row.dau, 1);
    case "androidDau": return Math.round(dailyAverage("dau") * 0.82);
    case "androidDauUserDays": return Math.round(sum("dau") * 0.82);
    case "iosDau": return Math.round(dailyAverage("dau") * 0.18);
    case "iosDauUserDays": return Math.round(sum("dau") * 0.18);
    case "androidNewUsers": return Math.round(sum("newUsers") * 0.74);
    case "iosNewUsers": return Math.round(sum("newUsers") * 0.26);
    case "organicNewUsers": return Math.round(sum("newUsers") * 0.11);
    case "internalNewUsers": return Math.round(sum("newUsers") * 0.02);
    case "adClickCount": return Math.round(sum("pageClicks") * 0.72);
    case "adClickUsers": return Math.round(dailyAverage("pageClicks") * 0.39);
    case "adClickUserDays": return Math.round(sum("pageClicks") * 0.39);
    case "adClickRate": return ratio(rows, (row) => row.pageClicks * 0.72, (row) => row.dau);
    case "adClickUserRate": return ratio(rows, (row) => row.pageClicks * 0.39, (row) => row.dau);
    case "newAdClickCount": return Math.round(sum("pageClicks") * 0.18);
    case "newAdClickUsers": return Math.round(sum("pageClicks") * 0.09);
    case "newAdClickRate": return ratio(rows, (row) => row.pageClicks * 0.18, (row) => row.newUsers);
    case "newAdClickUserRate": return ratio(rows, (row) => row.pageClicks * 0.09, (row) => row.newUsers);
    case "oldAdClickCount": return Math.round(sum("pageClicks") * 0.54);
    case "oldAdClickUsers": return Math.round(dailyAverage("pageClicks") * 0.30);
    case "oldAdClickUserDays": return Math.round(sum("pageClicks") * 0.30);
    case "oldAdClickRate": return ratio(rows, (row) => row.pageClicks * 0.54, (row) => Math.max(0, row.dau - row.newUsers));
    case "oldAdClickUserRate": return ratio(rows, (row) => row.pageClicks * 0.30, (row) => Math.max(0, row.dau - row.newUsers));
    case "newRevenue": return sum("revenue") * 0.23;
    case "newPayerCount": return Math.round(sum("payers") * 0.21);
    case "newPayRate": return ratio(rows, (row) => row.payers * 0.21, (row) => row.newUsers);
    case "newArpu": return ratio(rows, (row) => row.revenue * 0.23, (row) => row.newUsers, 1);
    case "newArppu": return ratio(rows, (row) => row.revenue * 0.23, (row) => row.payers * 0.21, 1);
    case "oldRevenue": return sum("revenue") * 0.77;
    case "oldPayerCount": return Math.round(dailyAverage("payers") * 0.79);
    case "oldPayerUserDays": return Math.round(sum("payers") * 0.79);
    case "oldPayRate": return ratio(rows, (row) => row.payers * 0.79, (row) => Math.max(0, row.dau - row.newUsers));
    case "oldArpu": return ratio(rows, (row) => row.revenue * 0.77, (row) => Math.max(0, row.dau - row.newUsers), 1);
    case "oldArppu": return ratio(rows, (row) => row.revenue * 0.77, (row) => row.payers * 0.79, 1);
    case "channelNewRevenue": return sum("revenue") * 0.07;
    case "internalNewRevenue": return sum("revenue") * 0.015;
    case "avgUsageMinutes": return ratio(rows, (row) => row.foregroundMinutes, (row) => row.dau, 1);
    case "avgWatchMinutes": return ratio(rows, (row) => row.watchMinutes, (row) => row.viewers, 1);
    case "pageViews": return sum("pageViews");
    case "pageClicks": return sum("pageClicks");
    case "currentPaidMembers": return latestSum("currentPaidMembers");
    case "historicalPaidMembers": return latestSum("historicalPaidMembers");
    case "renewalRate": return ratio(rows, (row) => row.renewedMembers, (row) => row.expiringMembers);
    case "videoWatchCount": return sum("playStarts");
    case "videoViewerCount": return sum("viewers");
    case "videoLikeCount": return sum("completes");
    case "videoCollectCount": return Math.round(sum("completes") * 0.42);
  }
}

export function formatMetric(metric: MetricId, value: number) {
  const meta = METRIC_META[metric];
  if (meta.unit === "percent") {
    const digits = Math.abs(value) < 1 ? 3 : Math.abs(value) < 10 ? 2 : 1;
    return `${round(value, digits)}%`;
  }
  if (meta.unit === "minutes") return `${round(value, 1)} 分钟`;
  if (meta.unit === "currency") {
    if (metric === "arppu") return `¥${round(value, 1)}`;
    return value >= 10000 ? `¥${round(value / 10000, 1)}万` : `¥${Math.round(value).toLocaleString()}`;
  }
  if (value >= 10000) return `${round(value / 10000, 1)}万`;
  return Math.round(value).toLocaleString();
}

export function getMetricAggregate(metric: MetricId, filters: DashboardFilters): MetricAggregate {
  const rows = getRows(filters);
  const previousRows = getRows(filters, Math.min(getRangeSize(filters), 14));
  const value = metricValue(metric, rows);
  const previous = metricValue(metric, previousRows) || value;
  const rawChange = previous ? (value - previous) / Math.abs(previous) * 100 : 0;
  const change = round(rawChange, 1);
  return {
    metric,
    value: round(value, METRIC_META[metric].unit === "number" ? 0 : 2),
    formatted: formatMetric(metric, value),
    change,
    changeLabel: `${change >= 0 ? "+" : ""}${change}%`
  };
}

function getTrendSeries(card: DashboardCardConfig, filters: DashboardFilters) {
  const rows = getRows(filters);
  const categories = [...new Set(rows.map((row) => row.date))];
  const selectedPlatforms = getSelectedPlatforms(filters);
  if (filters.mode === "compare" && card.metrics.length === 1) {
    const metric = card.metrics[0];
    return {
      categories,
      series: selectedPlatforms.map((platform) => ({
        name: platform,
        metric,
        data: categories.map((date) => round(metricValue(metric, rows.filter((row) => row.date === date && row.platform === platform)), 2))
      }))
    };
  }
  return {
    categories,
    series: card.metrics.slice(0, 4).map((metric) => ({
      name: METRIC_META[metric].name,
      metric,
      data: categories.map((date) => round(metricValue(metric, rows.filter((row) => row.date === date)), 2))
    }))
  };
}

function buildBarData(card: DashboardCardConfig, filters: DashboardFilters) {
  const metric = card.metrics[0] ?? "dau";
  const dimension = card.dimensions[0] ?? "platform";
  if (dimension === "keyword") {
    const rows = searchRows
      .filter((row) => getSelectedPlatforms(filters).includes(row.platform))
      .sort((a, b) => a.searches - b.searches);
    return { categories: rows.map((row) => row.keyword), series: [{ name: METRIC_META[metric].name, metric, data: rows.map((row) => row.searches) }] };
  }
  if (dimension === "category") {
    const rows = contentRows
      .filter((row) => getSelectedPlatforms(filters).includes(row.platform))
      .sort((a, b) => a.playRate - b.playRate);
    return { categories: rows.map((row) => row.category), series: [{ name: METRIC_META[metric].name, metric, data: rows.map((row) => metric === "revenue" ? row.revenue * 10000 : row.playRate) }] };
  }
  const entries = getSelectedPlatforms(filters).map((platform) => ({
    platform,
    value: metricValue(metric, getRows({ ...filters, mode: "single", platforms: [platform] }))
  })).sort((a, b) => a.value - b.value);
  return { categories: entries.map((item) => item.platform), series: [{ name: METRIC_META[metric].name, metric, data: entries.map((item) => round(item.value, 2)) }] };
}

function eventValue(eventId: string, rows: DailyRow[]) {
  const sum = (field: keyof DailyRow) => rows.reduce((total, row) => total + Number(row[field]), 0);
  switch (eventId) {
    case "app_start": return sum("dau") * 1.6;
    case "active_user": return sum("dau");
    case "registry_user": return sum("newUsers");
    case "video_click": return sum("videoClicks");
    case "video_play": return sum("playStarts");
    case "video_play_end": return sum("completes");
    case "vip_click": return sum("dau") * 0.087;
    case "pre_pay": return sum("dau") * 0.052;
    case "success_pay": return sum("payers");
    case "like": return sum("playStarts") * 0.19;
    case "collect": return sum("playStarts") * 0.12;
    case "share": return sum("playStarts") * 0.035;
    case "comments": return sum("playStarts") * 0.016;
    case "play_error": return sum("playStarts") * 0.028;
    case "broken": return sum("playStarts") * 0.004;
    default: return 0;
  }
}

function buildFunnel(card: DashboardCardConfig, filters: DashboardFilters) {
  const rows = getRows(filters);
  const steps = card.funnelSteps?.length ? card.funnelSteps : ["active_user", "video_click", "video_play", "video_play_end"];
  const raw = steps.map((eventId) => Math.round(eventValue(eventId, rows)));
  const monotonic = raw.reduce<number[]>((values, value, index) => [...values, index === 0 ? value : Math.min(value, values[index - 1])], []);
  const first = monotonic[0] || 1;
  return steps.map((eventId, index) => {
    const previous = monotonic[index - 1] ?? first;
    const value = monotonic[index];
    return {
      eventId,
      name: eventDictionary.find((event) => event.id === eventId)?.name ?? eventId,
      value,
      conversion: round(value / first * 100, 2),
      stepConversion: round(value / previous * 100, 2),
      dropoff: Math.max(0, previous - value)
    };
  });
}

function buildTable(model: AnalysisModelId, filters: DashboardFilters) {
  const selected = new Set(getSelectedPlatforms(filters));
  if (model === "content_position") {
    return contentRows.filter((row) => selected.has(row.platform)).map((row, index) => ({
      视频: `视频 ${String(index + 1).padStart(3, "0")}`, 分类: row.category,
      观看次数: Math.round(286000 * (1 - index * 0.065)), 观看人数: Math.round(153000 * (1 - index * 0.058)),
      播放率: `${row.playRate}%`, 完播率: `${row.completeRate}%`, 总观看时长: `${Math.round(920000 * (1 - index * 0.052))} 分钟`, 收入: `¥${row.revenue}万`
    }));
  }
  if (model === "search_demand") {
    return searchRows.filter((row) => selected.has(row.platform)).map((row) => ({
      搜索词: row.keyword, 平台: row.platform, 搜索次数: row.searches
    }));
  }
  if (model === "payment_conversion") {
    return getSelectedPlatforms(filters).map((platform) => {
      const scoped = { ...filters, mode: "single" as const, platforms: [platform] };
      return { 平台: platform, 付费率: getMetricAggregate("payRate", scoped).formatted, 收入: getMetricAggregate("revenue", scoped).formatted, ARPPU: getMetricAggregate("arppu", scoped).formatted };
    });
  }
  if (model === "member_operation") {
    return getSelectedPlatforms(filters).map((platform) => {
      const scoped = { ...filters, mode: "single" as const, platforms: [platform] };
      return { 平台: platform, 收入: getMetricAggregate("revenue", scoped).formatted, 付费率: getMetricAggregate("payRate", scoped).formatted, ARPPU: getMetricAggregate("arppu", scoped).formatted };
    });
  }
  if (model === "retention_quality") {
    return getSelectedPlatforms(filters).map((platform, index) => ({
      平台: platform, 新增用户: Math.round(183000 * (1 - index * 0.11)), 次留: `${round(35.2 - index * 1.4, 1)}%`, D7留存: `${round(18.6 - index * 0.9, 1)}%`, D30留存: `${round(8.4 - index * 0.45, 1)}%`
    }));
  }
  if (model === "usage_depth") {
    return getSelectedPlatforms(filters).map((platform, index) => ({
      平台: platform, 人均使用时长: `${round(13.8 + index * 0.7, 1)} 分钟`, 人均观影时长: `${round(9.2 + index * 0.45, 1)} 分钟`, 观影率: `${round(92.1 - index * 1.2, 1)}%`, 页面曝光: Math.round(4280000 * (1 - index * 0.09))
    }));
  }
  if (model === "custom_table") {
    return getSelectedPlatforms(filters).map((platform) => {
      const scoped = { ...filters, mode: "single" as const, platforms: [platform] };
      return { 平台: platform, DAU: getMetricAggregate("dau", scoped).formatted, 新增用户: getMetricAggregate("newUsers", scoped).formatted, 收入: getMetricAggregate("revenue", scoped).formatted, 观影率: getMetricAggregate("viewRate", scoped).formatted, 付费率: getMetricAggregate("payRate", scoped).formatted };
    });
  }
  return getSelectedPlatforms(filters).map((platform) => {
    const scoped = { ...filters, mode: "single" as const, platforms: [platform] };
    return { 平台: platform, DAU: getMetricAggregate("dau", scoped).formatted, 收入: getMetricAggregate("revenue", scoped).formatted, 付费率: getMetricAggregate("payRate", scoped).formatted, 次留: getMetricAggregate("retentionD1", scoped).formatted };
  });
}

function buildInsights(model: AnalysisModelId, filters: DashboardFilters) {
  const performances = getSelectedPlatforms(filters).map((platform) => {
    const scoped = { ...filters, mode: "single" as const, platforms: [platform] };
    return { platform, revenue: getMetricAggregate("revenue", scoped).value, payRate: getMetricAggregate("payRate", scoped).value, retention: getMetricAggregate("retentionD1", scoped).value };
  });
  const bestRevenue = [...performances].sort((a, b) => b.revenue - a.revenue)[0];
  const lowestPay = [...performances].sort((a, b) => a.payRate - b.payRate)[0];
  if (model === "content_position") {
    const best = contentRows.filter((row) => getSelectedPlatforms(filters).includes(row.platform)).sort((a, b) => b.revenue - a.revenue)[0];
    return [`${best?.category ?? "推荐"}分类当前收入贡献最高。`, "观看次数高但完播率偏低的内容应进一步检查时长和质量。", "现有接口不能判断页面和坑位效率，相关结论暂不输出。"];
  }
  if (model === "search_demand") return ["当前只能确认热搜词及搜索次数排行。", "接口未提供日期、无结果和点击字段，暂不输出供给缺口与转化结论。", "建议后续补充搜索提交明细和结果状态字段。"];
  if (model === "payment_conversion" || model === "member_operation") return [`${lowestPay?.platform ?? "NewAV"} 是当前汇总付费率最低的产品。`, "VIP 点击到拉起支付是当前汇总漏斗的主要损耗段。", "接口未提供支付通道和会员档位，暂不输出对应结论。"];
  if (model === "retention_quality") return [`${performances.sort((a, b) => b.retention - a.retention)[0]?.platform ?? "台姬店"} 次留表现最好。`, "近 3 个 cohort 的 D7 留存连续改善，但 D30 仍需观察。", "新增规模增长的平台未同步带来留存提升，应拆分渠道版本。"];
  return [`${bestRevenue?.platform ?? "NewAV"} 贡献当前范围最多收入。`, `${lowestPay?.platform ?? "NewAV"} 付费率低于总体，建议拆解支付通道与会员档位。`, "整体活跃保持增长，但留存改善慢于收入增长。"];
}

function buildScatter(card: DashboardCardConfig, filters: DashboardFilters) {
  return getSelectedPlatforms(filters).map((platform) => {
    const scoped = { ...filters, mode: "single" as const, platforms: [platform] };
    return {
      name: platform,
      value: [getMetricAggregate("dau", scoped).value, getMetricAggregate("payRate", scoped).value, getMetricAggregate("revenue", scoped).value] as [number, number, number],
      extra: `收入 ${getMetricAggregate("revenue", scoped).formatted}`
    };
  });
}

export function executeCardQuery(card: DashboardCardConfig, filters: DashboardFilters): CardQueryResult {
  const trend = card.type === "bar" ? buildBarData(card, filters) : getTrendSeries(card, filters);
  const selectedPlatforms = getSelectedPlatforms(filters);
  const scopeLabel = filters.mode === "all" ? `全部 ${platforms.length} 个平台` : filters.mode === "single" ? selectedPlatforms[0] : `${selectedPlatforms.length} 个平台对比`;
  const pages = ["首页", "短视频", "搜索", "详情", "分类"];
  const positions = ["P1", "P2", "P3", "P4", "P5"];
  const platformFactor = selectedPlatforms.reduce((total, name) => total + Math.max(0, platforms.findIndex((item) => item.platform === name)), 0) / Math.max(1, selectedPlatforms.length);
  const cohortX = ["D1", "D3", "D7", "D14", "D30"];
  const cohortY = dateLabels.slice(-8);
  const revenue = getMetricAggregate("revenue", filters).value;

  return {
    scopeLabel,
    categories: trend.categories,
    series: trend.series,
    summary: card.metrics.slice(0, 4).map((metric) => getMetricAggregate(metric, filters)),
    table: buildTable(card.model, filters).slice(0, card.limit ?? 12),
    funnel: card.type === "funnel" ? buildFunnel(card, filters) : undefined,
    heatmapX: positions,
    heatmapY: pages,
    heatmap: pages.flatMap((_, y) => positions.map((__, x) => [x, y, round(Math.max(3.2, 18.4 - x * 2.05 - y * 0.82 - platformFactor * 0.22 + Math.sin(x + y) * 0.8), 1)] as [number, number, number])),
    scatter: buildScatter(card, filters),
    treemap: [
      { name: "高收入分类", value: round(revenue * 0.46), children: contentRows.slice(0, 3).map((row, index) => ({ name: `${row.category} · 视频${index + 1}`, value: row.revenue })) },
      { name: "高播放分类", value: round(revenue * 0.31), children: contentRows.slice(3, 6).map((row, index) => ({ name: `${row.category} · 视频${index + 4}`, value: row.revenue })) },
      { name: "潜力分类", value: round(revenue * 0.23), children: contentRows.slice(6).map((row, index) => ({ name: `${row.category} · 视频${index + 7}`, value: row.revenue })) }
    ],
    cohortX,
    cohortY,
    cohort: cohortY.flatMap((_, y) => cohortX.map((__, x) => [x, y, round(Math.max(3.5, 36 - x * 7.1 + y * 0.55 - platformFactor * 0.38 + Math.sin(x + y) * 1.4), 1)] as [number, number, number])),
    waterfall: [],
    sankey: { nodes: [], links: [] },
    insights: buildInsights(card.model, filters)
  };
}

export function getAvailableDates() {
  return [...dateLabels];
}
