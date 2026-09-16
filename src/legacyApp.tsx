import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowDown, ArrowUp, CalendarRange, ChartNoAxesCombined, CheckCircle2, ChevronDown, ChevronLeft, CircleHelp, Cloud, Copy, Layers3, Maximize2, Pencil, Save, SlidersHorizontal, Trash2, X } from "lucide-react";
import { Chart, type ChartOption as EChartsOption } from "./components/Chart";
import { DataState } from "./components/DataState";
import { PlatformTopbar } from "./components/layout/PlatformTopbar";
import { PlatformSidebar } from "./components/layout/PlatformSidebar";
import { useBodyScrollLock } from "./components/layout/useBodyScrollLock";
import { MenuSelect, MultiMenuSelect, type MenuSelectGroup } from "./components/ui/MenuSelect";
import { DashboardReadFrame } from "./features/dashboard/DashboardReadFrame";
import { resolveUiVersion } from "./app/uiVersion";
import { CHART_PALETTE } from "./theme/tokens";
import { v13SeriesStyle } from "./theme/chartTheme";
import type { AnalysisModelId, ChartType, DashboardCardConfig, DashboardTemplate, DimensionId, DrilldownPayload, MetricId } from "./types";
import {
  analysisModels,
  contentRows,
  dashboardTemplates,
  dates,
  eventDictionary,
  metricDictionary,
  platforms,
  searchRows
} from "./data/mockData";
import {
  getApiCapability,
  getSupportedFunnelEvents,
  normalizeCardCapability,
  normalizeDashboardTemplate,
  validateCardCapability
} from "./data/apiCapabilities";
import { mergeTemplatesByRecency } from "./data/workspaceMerge";
import { MAX_METRICS_PER_QUERY } from "../contracts/analytics";
import {
  DEFAULT_FILTERS,
  METRIC_META,
  PLATFORM_COLORS,
  executeCardQuery,
  formatMetric,
  resolveComparisonDateRange,
  resolveDashboardDateRange,
  type CardQueryResult,
  type ComparisonMode,
  type DashboardFilters,
  type DateRange,
  type PlatformMode
} from "./analytics/mockEngine";
import { buildDrillInsights, useRealCardQuery } from "./analytics/realEngine";
import "./styles.css";
import "./theme/tokens.css";
import "./components/ui/primitives.css";
import "./components/layout/platform-shell.css";
import "./features/dashboard/dashboard-v13.css";
import "./features/filters/global-filter.css";
import "./features/workspaces/workspaces-v13.css";
import "./features/overlays/overlays-v13.css";

const color = ["#2563eb", "#16a34a", "#f59e0b", "#7c3aed", "#ef4444", "#0891b2"];
const uiVersion = resolveUiVersion(window.location.search, import.meta.env.VITE_UI_VERSION);
const platformPid: Record<string, string> = { Pornhub: "PH", TikTok: "TT", 小红书: "FBI", 色虎: "SH", "PH·Prem": "BZMH", 调教师: "TJS", 快播: "KB", 黄片网盘: "PD", 性欲社: "HJ", 抖阴Pro: "DYP", 抖阴Plus: "DYS", "X-chat": "YK", 白嫖社: "BPS", 好妻网: "HQW", 台姬店: "TJD", 魅魔vlog: "MMV", 稚嫩学园: "AF", 铁粉空间: "TFKJ", 精日头条: "JRTT", "91淫妻": "YQ" };

function selectedPlatformScope(filters: DashboardFilters) {
  const names = filters.mode === "all" ? Object.keys(platformPid) : filters.platforms;
  return names.map((name) => ({ name, pid: platformPid[name] })).filter((item): item is { name: string; pid: string } => Boolean(item.pid));
}

function cardScopedFilters(card: DashboardCardConfig, filters: DashboardFilters): DashboardFilters {
  const platformLimit = card.model === "usage_depth" ? 4 : 8;
  if (!card.platformMode || card.platformMode === "global") {
    return filters.mode === "compare" ? { ...filters, platforms: filters.platforms.slice(0, platformLimit) } : filters;
  }
  const available = new Set(Object.keys(platformPid));
  const selected = (card.platforms ?? []).filter((name) => available.has(name));
  if (card.platformMode === "all") return { ...filters, mode: "all" };
  if (card.platformMode === "single") return { ...filters, mode: "single", platforms: [selected[0] ?? filters.platforms[0] ?? "Pornhub"] };
  const fallback = filters.platforms.filter((name) => available.has(name)).slice(0, platformLimit);
  const compared = selected.length >= 2 ? selected.slice(0, platformLimit) : fallback.length >= 2 ? fallback : ["Pornhub", "TikTok"];
  return { ...filters, mode: "compare", platforms: compared };
}

function platformScopeLabel(filters: DashboardFilters) {
  if (filters.mode === "all") return `全部 ${Object.keys(platformPid).length} 个平台`;
  return filters.platforms.join("、");
}

const chartTypeName: Record<ChartType, string> = {
  kpi: "指标卡",
  line: "趋势图",
  bar: "排行图",
  heatmap: "热力图",
  funnel: "漏斗图",
  treemap: "贡献矩形图",
  table: "统计表",
  diagnosis: "诊断卡",
  scatter: "气泡矩阵",
  cohort: "留存矩阵",
  waterfall: "瀑布图",
  sankey: "桑基图"
};

function chartDataLevel(type: ChartType) {
  if (type === "sankey") return "汇总近似";
  if (["heatmap", "waterfall", "treemap", "scatter", "diagnosis"].includes(type)) return "真实聚合计算";
  return "真实直接统计";
}
const sizeName: Record<DashboardCardConfig["size"], string> = { sm: "小卡片", md: "半宽卡片", lg: "大卡片", full: "整行卡片" };
const dimensionName: Record<DimensionId, string> = {
  date: "日期",
  platform: "平台",
  page: "页面",
  position: "位置",
  positionRank: "坑位排名",
  category: "内容分类",
  content: "内容",
  keyword: "搜索词",
  paymentChannel: "支付通道",
  memberPlan: "会员档位",
  memberStatus: "会员状态",
  result: "结果",
  appVersion: "应用版本",
  channel: "渠道"
};
const metricName: Record<MetricId, string> = {
  dau: "日均DAU",
  dauUserDays: "累计活跃人天",
  newUsers: "新增用户",
  viewerCount: "日均观影人数",
  viewerUserDays: "累计观影人天",
  searchCount: "搜索次数",
  revenue: "收入",
  viewRate: "观影率",
  payRate: "付费率",
  payerCount: "日均付费人数",
  payerUserDays: "累计付费人天",
  visits: "访问",
  downloads: "下载",
  visitDownloadRate: "访问→下载转化",
  downloadRegisterRate: "下载→注册转化",
  visitRegisterRate: "访问→注册转化",
  retentionD1: "次留",
  retentionD3: "D3留存",
  retentionD7: "D7留存",
  retentionD30: "D30留存",
  videoCtr: "视频点击率",
  playRate: "播放率",
  completeRate: "完播率",
  searchNoResultRate: "搜索无结果率",
  arppu: "ARPPU",
  arpu: "ARPU",
  androidDau: "Android日均活跃",
  androidDauUserDays: "Android累计活跃人天",
  iosDau: "IOS日均活跃",
  iosDauUserDays: "IOS累计活跃人天",
  androidNewUsers: "Android新增",
  iosNewUsers: "IOS新增",
  organicNewUsers: "自然新增",
  internalNewUsers: "内部导量新增",
  adClickCount: "广告点击人次",
  adClickUsers: "日均广告点击人数",
  adClickUserDays: "累计广告点击人天",
  adClickRate: "广告点击人次率",
  adClickUserRate: "广告点击人数率",
  newAdClickCount: "新增广告点击人次",
  newAdClickUsers: "新增广告点击人数",
  newAdClickRate: "新增广告点击人次率",
  newAdClickUserRate: "新增广告点击人数率",
  oldAdClickCount: "老用户广告点击人次",
  oldAdClickUsers: "日均老用户广告点击人数",
  oldAdClickUserDays: "累计老用户广告点击人天",
  oldAdClickRate: "老用户广告点击人次率",
  oldAdClickUserRate: "老用户广告点击人数率",
  newRevenue: "新增充值金额",
  newPayerCount: "新增充值人数",
  newPayRate: "新增充值付费率",
  newArpu: "新增充值ARPU",
  newArppu: "新增充值ARPPU",
  oldRevenue: "老用户充值金额",
  oldPayerCount: "日均老用户充值人数",
  oldPayerUserDays: "累计老用户付费人天",
  oldPayRate: "老用户充值付费率",
  oldArpu: "老用户充值ARPU",
  oldArppu: "老用户充值ARPPU",
  channelNewRevenue: "渠道新增充值",
  internalNewRevenue: "内部导量充值",
  avgUsageMinutes: "人均使用时长",
  avgWatchMinutes: "人均观影时长",
  pageViews: "页面曝光",
  pageClicks: "页面点击",
  currentPaidMembers: "当前付费会员",
  historicalPaidMembers: "历史付费会员",
  renewalRate: "续费率"
  ,videoWatchCount: "视频播放次数"
  ,videoViewerCount: "视频观看人数"
  ,videoLikeCount: "视频点赞数"
  ,videoCollectCount: "视频收藏数"
};
const modelName: Record<AnalysisModelId, string> = {
  business_overview: "经营总览",
  platform_compare: "平台对比",
  content_position: "视频内容表现",
  search_demand: "热搜词排行",
  payment_conversion: "支付汇总漏斗",
  member_operation: "会员收入概览",
  retention_quality: "留存质量",
  usage_depth: "观看深度",
  acquisition_conversion: "获客转化",
  custom_table: "接口字段统计表"
};
const dashboardFocus: Record<string, Array<[string, string]>> = {
  overview: [["规模", "活跃与新增是否同步"], ["效率", "观影与付费是否改善"], ["风险", "平台差异是否扩大"]],
  content: [["消费", "播放与观看人数"], ["互动", "点赞收藏效率"], ["转化", "内容漏斗流失"]],
  search: [["需求", "高频搜索主题"], ["差异", "平台需求偏好"], ["供给", "重点内容机会"]],
  payment: [["入口", "VIP 点击规模"], ["转化", "拉起支付到成功"], ["效率", "平台付费率"]],
  retention: [["质量", "新增次日留存"], ["深度", "人均观影时长"], ["差异", "平台留存分层"]]
};
type Workspace = "templates" | "cards" | "cardFactory" | "templateFactory" | "dictionary" | "dataSources";
type SystemSurfaceId = "system-content-categories" | "system-channels" | "system-special";

function initialWorkspace(): Workspace {
  const requested = new URLSearchParams(window.location.search).get("workspace");
  const workspaces: Workspace[] = ["templates", "cards", "cardFactory", "templateFactory", "dictionary", "dataSources"];
  return workspaces.includes(requested as Workspace) ? requested as Workspace : "templates";
}

function secureMaintenanceUrl() {
  const host = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(window.location.hostname)
    ? `${window.location.hostname}.nip.io`
    : window.location.hostname;
  return `https://${host}/?workspace=dataSources`;
}

interface SystemSurfaceTemplate {
  id: SystemSurfaceId;
  name: string;
  scenario: string;
}

const systemSurfaceTemplates: SystemSurfaceTemplate[] = [
  { id: "system-content-categories", name: "分类内容分析", scenario: "分类观看、点击、点赞、收藏排行与明细。" },
  { id: "system-channels", name: "渠道经营分析", scenario: "渠道获客、转化、排行、明细与 A/B 落地页。" },
  { id: "system-special", name: "专项运营分析", scenario: "导航、CNZZ、快照、资讯和问卷专项数据。" }
];
const builtInTemplateIds = new Set(dashboardTemplates.map((template) => template.id));

interface CardAsset {
  id: string;
  name: string;
  description: string;
  config: DashboardCardConfig;
  updatedAt: string;
}

function notify(message: string) {
  window.dispatchEvent(new CustomEvent("bi-notify", { detail: message }));
}

async function readJsonResponse<T>(response: Response, serviceName: string): Promise<T> {
  try {
    return await response.json() as T;
  } catch {
    throw new Error(response.ok ? `${serviceName}返回格式异常，请稍后重试` : `${serviceName}暂时不可用，请稍后重试`);
  }
}

function downloadCsv(filename: string, rows: Record<string, string | number>[]) {
  if (!rows.length) {
    notify("当前条件下没有可导出的数据");
    return;
  }
  const headers = Object.keys(rows[0]);
  const escape = (value: string | number) => `"${String(value).replaceAll('"', '""')}"`;
  const csv = [headers.map(escape).join(","), ...rows.map((row) => headers.map((header) => escape(row[header] ?? "")).join(","))].join("\n");
  const blob = new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
  notify("导出文件已生成");
}

function loadPersisted<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) as T : fallback;
  } catch {
    return fallback;
  }
}

function ToastHost() {
  const [message, setMessage] = useState("");
  useEffect(() => {
    let timer = 0;
    const handler = (event: Event) => {
      setMessage((event as CustomEvent<string>).detail);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setMessage(""), 2400);
    };
    window.addEventListener("bi-notify", handler);
    return () => {
      window.removeEventListener("bi-notify", handler);
      window.clearTimeout(timer);
    };
  }, []);
  return <div role="status" aria-live="polite" className={message ? "app-toast show" : "app-toast"}>{message}</div>;
}

function initialCardAssets(): CardAsset[] {
  const templateAssets = dashboardTemplates.flatMap((template) => template.cards.map((card) => ({
    id: `asset-${template.id}-${card.id}`,
    name: card.title,
    description: `${template.name} · ${chartTypeName[card.type]}`,
    config: { ...card, id: `asset-card-${template.id}-${card.id}` },
    updatedAt: "2026-07-09"
  })));
  const calculatedAssets: CardAsset[] = [
    { id: "asset-calculated-platform-heatmap", name: "平台日期活跃热力图", description: "平台对比 · 真实聚合计算", config: { id: "calculated-platform-heatmap", title: "平台日期活跃热力图", type: "heatmap", model: "platform_compare", metrics: ["dau"], dimensions: ["date", "platform"], size: "full", drillPath: ["platform", "date"] }, updatedAt: "2026-07-22" },
    { id: "asset-calculated-platform-waterfall", name: "平台活跃贡献瀑布图", description: "平台对比 · 真实聚合计算", config: { id: "calculated-platform-waterfall", title: "平台活跃贡献瀑布图", type: "waterfall", model: "platform_compare", metrics: ["dau"], dimensions: ["platform"], size: "lg", drillPath: ["platform"] }, updatedAt: "2026-07-22" },
    { id: "asset-calculated-platform-treemap", name: "平台活跃贡献矩形图", description: "平台对比 · 真实聚合计算", config: { id: "calculated-platform-treemap", title: "平台活跃贡献矩形图", type: "treemap", model: "platform_compare", metrics: ["dau"], dimensions: ["platform"], size: "md", drillPath: ["platform"] }, updatedAt: "2026-07-22" },
    { id: "asset-calculated-content-sankey", name: "内容消费阶段汇总流量", description: "内容分析 · 汇总近似，非用户路径", config: { id: "calculated-content-sankey", title: "内容消费阶段汇总流量", type: "sankey", model: "content_position", metrics: ["videoWatchCount"], dimensions: ["platform"], size: "full", funnelSteps: ["active_user", "video_click", "video_play", "video_play_end"], conversionWindow: "接口日期范围" }, updatedAt: "2026-07-22" },
    { id: "asset-calculated-payment-sankey", name: "支付阶段汇总流量", description: "支付分析 · 汇总近似，非用户路径", config: { id: "calculated-payment-sankey", title: "支付阶段汇总流量", type: "sankey", model: "payment_conversion", metrics: ["payRate"], dimensions: ["platform"], size: "lg", funnelSteps: ["vip_click", "pre_pay", "success_pay"], conversionWindow: "接口日期范围" }, updatedAt: "2026-07-22" }
    ,{ id: "asset-old-user-ad", name: "老用户广告表现", description: "广告分析 · 总广告减新增广告派生", config: { id: "old-user-ad", title: "老用户广告表现", type: "line", model: "business_overview", metrics: ["oldAdClickCount", "oldAdClickUsers", "oldAdClickRate", "oldAdClickUserRate"], dimensions: ["date", "platform"], size: "full", drillPath: ["platform", "date"] }, updatedAt: "2026-07-24" }
    ,{ id: "asset-old-user-payment", name: "老用户充值质量", description: "付费分析 · 总充值减新增充值派生", config: { id: "old-user-payment", title: "老用户充值质量", type: "kpi", model: "business_overview", metrics: ["oldRevenue", "oldPayerCount", "oldPayRate", "oldArpu", "oldArppu"], dimensions: ["platform"], size: "full", drillPath: ["platform", "date"] }, updatedAt: "2026-07-24" }
  ];
  return [...calculatedAssets, ...templateAssets];
}

function normalizeTemplates(stored: unknown) {
  if (!Array.isArray(stored)) return dashboardTemplates;
  const normalized = stored.map(normalizeDashboardTemplate).filter((item): item is DashboardTemplate => item !== null).map((template) => template.id !== "retention" ? template : {
    ...template,
    cards: template.cards.map((card) => card.model !== "retention_quality" ? card : { ...card, metrics: card.id === "cohort" || card.id === "retention-table" ? ["newUsers", "retentionD1", "retentionD3", "retentionD7", "retentionD30"] as MetricId[] : card.metrics })
  });
  if (!normalized.length) return dashboardTemplates;
  const builtIns = new Map(dashboardTemplates.map((template) => [template.id, template]));
  const merged = normalized.map((template) => {
    const builtIn = builtIns.get(template.id);
    if (!builtIn) return template;
    const canonicalCards = new Map(builtIn.cards.map((card) => [card.id, card]));
    const upgradedCards = template.cards.map((card) => {
      const canonical = canonicalCards.get(card.id);
      if (!canonical) return card;
      return {
        ...canonical,
        size: card.size,
        platformMode: card.platformMode,
        platforms: card.platforms
      };
    });
    const cardIds = new Set(template.cards.map((card) => card.id));
    return { ...template, name: builtIn.name, scenario: builtIn.scenario, model: builtIn.model, filters: builtIn.filters, cards: [...upgradedCards, ...builtIn.cards.filter((card) => !cardIds.has(card.id))] };
  });
  const templateIds = new Set(merged.map((template) => template.id));
  return [...merged, ...dashboardTemplates.filter((template) => !templateIds.has(template.id))];
}

function loadTemplatesFromStorage() {
  return normalizeTemplates(loadPersisted<unknown>("bi-templates-v3-api", dashboardTemplates));
}

function normalizeCardAssets(stored: unknown) {
  const fallback = initialCardAssets();
  if (!Array.isArray(stored)) return fallback;
  const normalized = stored.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const asset = value as Partial<CardAsset>;
    const config = normalizeCardCapability(asset.config);
    if (!config) return [];
    return [{
      id: typeof asset.id === "string" ? asset.id : `asset-${Date.now()}`,
      name: typeof asset.name === "string" ? asset.name : config.title,
      description: typeof asset.description === "string" ? asset.description : "API 能力归一化卡片",
      config,
      updatedAt: typeof asset.updatedAt === "string" ? asset.updatedAt : "刚刚"
    } satisfies CardAsset];
  });
  if (!normalized.length) return fallback;
  const storedIds = new Set(normalized.map((asset) => asset.id));
  return [...normalized, ...fallback.filter((asset) => !storedIds.has(asset.id))];
}

function mergeCardAssets(primary: CardAsset[], secondary: CardAsset[]) {
  const primaryIds = new Set(primary.map((asset) => asset.id));
  return [...primary, ...secondary.filter((asset) => !primaryIds.has(asset.id))];
}

function loadCardAssetsFromStorage() {
  return normalizeCardAssets(loadPersisted<unknown>("bi-card-assets-v3-api", initialCardAssets()));
}
function eventName(eventId: string) {
  return eventDictionary.find((item) => item.id === eventId)?.name ?? eventId;
}

function makeLineOption(): EChartsOption {
  return {
    tooltip: { trigger: "axis" },
    legend: { right: 8, top: 0 },
    grid: { left: 42, right: 18, top: 34, bottom: 34 },
    xAxis: { type: "category", data: dates, boundaryGap: false },
    yAxis: { type: "value", splitLine: { lineStyle: { color: "#eef2f6" } } },
    series: [
      { name: "DAU", type: "line", smooth: true, data: [142, 151, 166, 158, 176, 139, 175, 181, 188], color: color[0], areaStyle: { opacity: 0.12 } },
      { name: "收入", type: "line", smooth: true, data: [18, 22, 24, 21, 29, 25, 35, 32, 38], color: color[1] },
      { name: "付费率", type: "line", smooth: true, data: [2.4, 2.7, 3.1, 2.9, 3.4, 3.2, 3.8, 3.6, 4.0], color: color[2] }
    ]
  };
}

function makeBarOption(): EChartsOption {
  const rows = [...platforms].sort((a, b) => a.revenue - b.revenue);
  return {
    tooltip: { trigger: "axis" },
    grid: { left: 82, right: 36, top: 20, bottom: 28 },
    xAxis: { type: "value", splitLine: { lineStyle: { color: "#eef2f6" } } },
    yAxis: { type: "category", data: rows.map((r) => r.platform) },
    series: [{ type: "bar", data: rows.map((r) => r.revenue), barWidth: 12, itemStyle: { borderRadius: [0, 8, 8, 0], color: color[0] }, label: { show: true, position: "right", formatter: "¥{c}万" } }]
  };
}

function makeHeatmapOption(): EChartsOption {
  const pages = ["首页", "分类", "搜索", "详情"];
  const positions = ["P1", "P2", "P3", "P4", "P5"];
  return {
    tooltip: {},
    grid: { left: 58, right: 12, top: 22, bottom: 36 },
    xAxis: { type: "category", data: positions },
    yAxis: { type: "category", data: pages },
    visualMap: { min: 4, max: 18, show: false, inRange: { color: ["#eff6ff", "#60a5fa", "#7c3aed"] } },
    series: [{ type: "heatmap", data: pages.flatMap((_, y) => positions.map((__, x) => [x, y, +(16 - x * 1.3 - y * 1.4).toFixed(1)])), label: { show: true, formatter: (p: any) => `${p.value[2]}%` } }]
  };
}

function makeFunnelOption(card: DashboardCardConfig): EChartsOption {
  const fallback = ["video_exposure", "video_click", "video_play_start", "video_play_complete", "payment_success"];
  const steps = card.funnelSteps?.length ? card.funnelSteps : fallback;
  const baseValues = [1860, 238, 196, 62, 4.8, 3.6, 2.4];
  const stages = steps.map((eventId, index) => {
    const event = eventDictionary.find((item) => item.id === eventId);
    return [event?.name ?? eventId, baseValues[index] ?? Math.max(1, baseValues[baseValues.length - 1] - index)] as const;
  });
  const max = stages[0][1];
  return {
    tooltip: { trigger: "axis" },
    grid: { left: 110, right: 80, top: 18, bottom: 18 },
    xAxis: { type: "value", max: 100, show: false },
    yAxis: { type: "category", inverse: true, data: stages.map((s) => s[0]) },
    series: [
      { type: "bar", data: stages.map(() => 100), barWidth: 24, barGap: "-100%", silent: true, itemStyle: { borderRadius: 8, color: "#eef2f7" } },
      { type: "bar", data: stages.map((s) => +(s[1] / max * 100).toFixed(2)), barWidth: 24, itemStyle: { borderRadius: 8, color: color[0] }, label: { show: true, position: "right", formatter: (p: any) => `${stages[p.dataIndex][1]}  ${p.value}%` } }
    ]
  };
}

function makeTreeOption(): EChartsOption {
  return {
    tooltip: { formatter: (p: any) => `${p.name}<br/>收入：¥${p.value}万` },
    series: [{
      type: "treemap",
      breadcrumb: { show: true },
      nodeClick: "zoomToNode",
      label: { show: true, fontWeight: 800 },
      itemStyle: { borderColor: "#fff", borderWidth: 3 },
      data: [
        { name: "推荐流", value: 37.8, children: [{ name: "Pornhub 首页P1", value: 18.6 }, { name: "TikTok 短视频P3", value: 7.3 }, { name: "调教师 首页P4", value: 3.1 }] },
        { name: "搜索承接", value: 24.2, children: [{ name: "小红书 搜索P1", value: 9.8 }, { name: "铁粉空间 搜索P2", value: 4.7 }] },
        { name: "详情推荐", value: 10.7, children: [{ name: "色虎 详情P2", value: 8.9 }, { name: "x-chat 详情P3", value: 1.8 }] }
      ]
    }]
  };
}

function makeQueryOption(card: DashboardCardConfig, result: CardQueryResult, modern = false): EChartsOption {
  const baseGrid = { left: 56, right: 28, top: 46, bottom: 38, containLabel: true };
  const activePalette = modern ? CHART_PALETTE : color;
  const platformColor = (name: string, index = 0) => {
    if (!modern) return PLATFORM_COLORS[name] ?? color[index % color.length];
    const platformIndex = Object.keys(platformPid).indexOf(name);
    return CHART_PALETTE[(platformIndex >= 0 ? platformIndex : index) % CHART_PALETTE.length];
  };
  if (card.type === "line") {
    const units = [...new Set(result.series.map((series) => METRIC_META[series.metric].unit))];
    const yAxis = units.slice(0, 2).map((unit, index) => ({
      type: "value" as const,
      position: index === 0 ? "left" as const : "right" as const,
      splitLine: { show: index === 0, lineStyle: { color: "#edf1f7" } },
      axisLabel: { formatter: (value: string | number) => { const numeric = Number(value); return unit === "percent" ? `${numeric}%` : unit === "currency" ? `¥${Math.round(numeric / 10000)}万` : numeric >= 10000 ? `${roundForChart(numeric / 10000)}万` : String(numeric); } }
    }));
    return {
      animationDuration: modern ? 180 : 420,
      tooltip: { trigger: "axis", valueFormatter: (value: unknown) => typeof value === "number" ? value.toLocaleString() : String(value) },
      legend: { type: "scroll", right: 8, left: 8, top: 4, itemWidth: 18, itemHeight: 8, pageButtonPosition: "end" },
      grid: { ...baseGrid, top: result.series.length > 8 ? 58 : 46, right: units.length > 1 ? 68 : 28 },
      xAxis: { type: "category", data: result.categories, boundaryGap: false, axisLine: { lineStyle: { color: "#dbe3ee" } } },
      yAxis,
      series: result.series.map((series, index) => {
        const visual = modern ? v13SeriesStyle(index) : { color: platformColor(series.name, index), lineStyle: { width: 2.5 }, symbolSize: 7, showSymbol: false };
        return {
          name: series.name,
          type: "line",
          yAxisIndex: Math.min(1, Math.max(0, units.indexOf(METRIC_META[series.metric].unit))),
          smooth: 0.32,
          data: series.data,
          ...visual,
          areaStyle: index === 0 ? { opacity: 0.08 } : undefined,
          emphasis: { focus: "series", disabled: false }
        };
      })
    };
  }
  if (card.type === "bar") {
    const metric = result.series[0]?.metric ?? card.metrics[0];
    const categories = [...result.categories].reverse();
    const values = [...(result.series[0]?.data ?? [])].reverse();
    return {
      animationDuration: modern ? 180 : 420,
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
      grid: { ...baseGrid, left: 118, right: 56, top: 20 },
      xAxis: { type: "value", splitNumber: card.size === "md" ? 2 : 4, splitLine: { lineStyle: { color: "#edf1f7" } }, axisLabel: { hideOverlap: true, fontSize: 10, formatter: (value: number) => METRIC_META[metric].unit === "currency" ? `¥${roundForChart(value / 10000)}万` : value >= 10000 ? `${roundForChart(value / 10000)}万` : String(value) } },
      yAxis: { type: "category", data: categories, axisTick: { show: false }, axisLine: { show: false }, axisLabel: { width: 108, overflow: "break", lineHeight: 14 } },
      series: [{ type: "bar", data: values, barWidth: 16, itemStyle: { borderRadius: [0, 5, 5, 0], color: activePalette[0] }, label: { show: true, position: "right", formatter: (params: any) => formatMetric(metric, Number(params.value)) } }]
    };
  }
  if (card.type === "heatmap") {
    const metric = card.metrics[0];
    const values = result.heatmap?.map((item) => item[2]) ?? [];
    const maxValue = Math.max(1, ...values);
    return {
      tooltip: { formatter: (params: any) => `${result.heatmapY?.[params.value[1]]} · ${result.heatmapX?.[params.value[0]]}<br/>${metricName[metric]} ${formatMetric(metric, Number(params.value[2]))}` },
      grid: { ...baseGrid, left: 72, top: 24 },
      xAxis: { type: "category", data: result.heatmapX, splitArea: { show: true } },
      yAxis: { type: "category", data: result.heatmapY, splitArea: { show: true } },
      visualMap: { min: 0, max: maxValue, orient: "horizontal", right: 8, top: 0, itemWidth: 90, itemHeight: 8, inRange: { color: modern ? ["#EDF3FF", "#8EAEF5", "#285FE8", "#1748B8"] : ["#eff6ff", "#93c5fd", "#2563eb", "#172554"] } },
      series: [{ type: "heatmap", data: result.heatmap, label: { show: true, formatter: (params: any) => formatMetric(metric, Number(params.value[2])) }, itemStyle: { borderColor: "#fff", borderWidth: 3, borderRadius: 5 } }]
    };
  }
  if (card.type === "funnel") {
    const rows = result.funnel ?? [];
    const axisMax = Math.max(100, ...rows.map((row) => row.conversion));
    return {
      tooltip: { formatter: (params: any) => { const row = rows[params.dataIndex]; return `${row.name}<br/>人数 ${row.value.toLocaleString()}<br/>较上一步 ${row.stepConversion}%<br/>总转化 ${row.conversion}%`; } },
      grid: { left: 112, right: 124, top: 18, bottom: 16 },
      xAxis: { type: "value", max: axisMax, show: false },
      yAxis: { type: "category", inverse: true, data: rows.map((row) => row.name), axisLine: { show: false }, axisTick: { show: false }, axisLabel: { fontWeight: 700, color: "#334155" } },
      series: [
        { type: "bar", silent: true, data: rows.map(() => axisMax), barWidth: 26, barGap: "-100%", itemStyle: { color: "#eef2f7", borderRadius: 5 } },
        { type: "bar", data: rows.map((row) => row.conversion), barWidth: 26, itemStyle: { color: (params: any) => modern ? activePalette[Math.min(params.dataIndex, activePalette.length - 1)] : ["#1d4ed8", "#2563eb", "#3b82f6", "#60a5fa", "#93c5fd"][Math.min(params.dataIndex, 4)], borderRadius: 5 }, label: { show: true, position: "right", formatter: (params: any) => { const row = rows[params.dataIndex]; return `${row.value.toLocaleString()}  ·  ${row.stepConversion}%`; }, color: "#334155", fontWeight: 700 } }
      ]
    };
  }
  if (card.type === "treemap") return { tooltip: { formatter: (params: any) => `${params.name}<br/>${metricName[card.metrics[0]]} ${formatMetric(card.metrics[0], Number(params.value))}` }, series: [{ type: "treemap", data: result.treemap, breadcrumb: { show: true }, nodeClick: "zoomToNode", roam: false, label: { show: true, fontWeight: 700 }, itemStyle: { borderColor: "#fff", borderWidth: 3, gapWidth: 2 } }] };
  if (card.type === "scatter") {
    const xMetric = card.metrics[0];
    const yMetric = card.metrics[1];
    const scatterRows = result.scatter ?? [];
    const labeledNames = new Set([...scatterRows]
      .sort((left, right) => right.value[0] - left.value[0])
      .slice(0, card.size === "md" ? 3 : 5)
      .map((item) => item.name));
    const maxBubbleValue = Math.max(1, ...scatterRows.map((item) => item.value[2]));
    const axisFormatter = (metric: MetricId, value: number) => {
      const unit = METRIC_META[metric].unit;
      if (unit === "percent") return `${Number(value.toFixed(Math.abs(value) < 1 ? 2 : 1))}%`;
      if (unit === "currency") return value >= 10000 ? `¥${roundForChart(value / 10000)}万` : `¥${value}`;
      return value >= 10000 ? `${roundForChart(value / 10000)}万` : String(value);
    };
    return {
      tooltip: { formatter: (params: any) => `${params.data.name}<br/>${metricName[xMetric]} ${formatMetric(xMetric, Number(params.value[0]))}<br/>${metricName[yMetric]} ${formatMetric(yMetric, Number(params.value[1]))}` },
      grid: { ...baseGrid, top: 24 },
      xAxis: { type: "value", name: metricName[xMetric], splitLine: { lineStyle: { color: "#edf1f7" } }, scale: true, axisLabel: { formatter: (value: number) => axisFormatter(xMetric, value) } },
      yAxis: { type: "value", name: metricName[yMetric], splitLine: { lineStyle: { color: "#edf1f7" } }, scale: true, axisLabel: { formatter: (value: number) => axisFormatter(yMetric, value) } },
      series: [{
        type: "scatter",
        data: result.scatter,
        symbolSize: (value: number[]) => Math.max(8, Math.min(34, 8 + 26 * Math.sqrt(value[2] / maxBubbleValue))),
        itemStyle: { color: (params: any) => platformColor(params.data.name), opacity: 0.82 },
        label: { show: true, position: "top", formatter: (params: any) => labeledNames.has(params.data.name) ? params.data.name : "", color: "#334155", fontWeight: 700 },
        labelLayout: { hideOverlap: true, moveOverlap: "shiftY" },
        emphasis: { label: { show: true, formatter: (params: any) => params.data.name } }
      }]
    };
  }
  if (card.type === "cohort") return {
    tooltip: { formatter: (params: any) => `${result.cohortY?.[params.value[1]]} cohort<br/>${result.cohortX?.[params.value[0]]} 留存 ${params.value[2]}%` },
    grid: { ...baseGrid, left: 72, top: 24 },
    xAxis: { type: "category", data: result.cohortX, splitArea: { show: true } },
    yAxis: { type: "category", data: result.cohortY, splitArea: { show: true } },
    visualMap: { min: 3, max: 38, show: false, inRange: { color: modern ? ["#F5F7FA", "#DCE8FF", "#8EAEF5", "#285FE8", "#1748B8"] : ["#f8fafc", "#bfdbfe", "#60a5fa", "#1d4ed8", "#172554"] } },
    series: [{ type: "heatmap", data: result.cohort, label: { show: true, formatter: (params: any) => `${params.value[2]}%`, color: "#0f172a" }, itemStyle: { borderColor: "#fff", borderWidth: 3, borderRadius: 4 } }]
  };
  if (card.type === "waterfall") {
    const values = result.waterfall ?? [];
    const totals = values.map((_, index) => values.slice(0, index).reduce((sum, item) => sum + item.value, 0));
    return { tooltip: { trigger: "axis" }, grid: { ...baseGrid, bottom: values.length > 10 ? 86 : 48 }, xAxis: { type: "category", data: [...values.map((item) => item.name), "合计"], axisLabel: { interval: 0, rotate: values.length > 10 ? 40 : 0, fontSize: 10 } }, yAxis: { type: "value", splitLine: { lineStyle: { color: "#edf1f7" } } }, series: [{ type: "bar", stack: "total", data: [...totals, 0], itemStyle: { color: "transparent" }, silent: true }, { type: "bar", stack: "total", data: [...values.map((item) => item.value), values.reduce((sum, item) => sum + item.value, 0)], itemStyle: { color: (params: any) => params.dataIndex === values.length ? (modern ? "#117A4F" : "#16a34a") : activePalette[params.dataIndex % activePalette.length], borderRadius: [4, 4, 0, 0] }, label: { show: values.length <= 10, position: "top", formatter: (params: any) => formatMetric(card.metrics[0], Number(params.value)) } }] };
  }
  if (card.type === "sankey") return { tooltip: { trigger: "item" }, series: [{ type: "sankey", data: result.sankey?.nodes, links: result.sankey?.links, emphasis: { focus: "adjacency" }, nodeWidth: 16, nodeGap: 14, lineStyle: { color: "gradient", curveness: 0.5, opacity: 0.36 }, label: { color: "#334155", fontWeight: 700 } }] };
  return {};
}

function roundForChart(value: number) {
  return Number(value.toFixed(1));
}

function buildDrill(card: DashboardCardConfig, result: CardQueryResult, filters: DashboardFilters, clickedName = "当前节点"): DrilldownPayload {
  const names = filters.mode === "all" ? platforms.map((item) => item.platform) : filters.platforms;
  return {
    title: `${card.title} · 下钻`,
    subtitle: `点击对象：${clickedName}`,
    model: card.model,
    dimensions: card.drillPath ?? card.dimensions,
    metrics: card.metrics,
    rows: result.table,
    diagnosis: buildDrillInsights(card, result, clickedName),
    actions: ["基于当前条件继续分析", "导出当前明细", "保存为默认下钻"],
    scope: result.scopeLabel,
    benchmark: result.summary[0]
      ? result.summary[0].changeLabel === "当前区间"
        ? `${metricName[result.summary[0].metric]} ${result.summary[0].formatted} · 当前筛选区间`
        : `${metricName[result.summary[0].metric]} ${result.summary[0].formatted} · ${result.summary[0].changeLabel}`
      : undefined,
    platformIds: names.map((name) => platformPid[name]).filter(Boolean),
    dateRange: resolveDashboardDateRange(filters),
    detailKind: card.model === "content_position" ? "circles" : "users"
  };
}

function KpiCard({ result }: { result: CardQueryResult }) {
  return <div className="kpi-grid">{result.summary.map((item) => {
    const positive = METRIC_META[item.metric].positive ? item.change >= 0 : item.change <= 0;
    const isCurrentRange = item.changeLabel === "当前区间";
    return <div className="kpi" key={item.metric}><span><FieldLabel label={metricName[item.metric]} metric={item.metric} /></span><b>{item.formatted}</b>{isCurrentRange ? <em className="neutral">当前区间</em> : <ComparisonBadge change={item.change} positive={positive} comparison={item.changeLabel} />}</div>;
  })}</div>;
}

function ComparisonBadge({ change, positive, comparison }: { change: number; positive: boolean; comparison?: string }) {
  const direction = change > 0 ? "↗" : change < 0 ? "↘" : "→";
  const percentage = `${Math.abs(change).toFixed(1)}%`;
  return <em className={`comparison-badge ${change === 0 ? "neutral" : positive ? "good" : "bad"}`} title={comparison ? `对比期：${comparison}` : "与对比周期相比"}><i>{direction}</i><b>{percentage}</b><small>较对比期{comparison ? ` · ${comparison.replace("对比期 ", "")}` : ""}</small></em>;
}

const fieldExplanations: Record<string, string> = {
  平台: "数据所属业务平台；全部平台模式会分别查询并聚合所选平台。", 日期: "按北京时间自然日统计。", 注册日期: "用户首次注册所属的北京时间自然日。", DAU: "当日去重活跃用户数。", 新增用户: "统计周期内新注册用户数。", 搜索次数: "用户提交搜索行为的累计次数，不代表去重人数。", 观影率: "观影人数 ÷ DAU，区间使用汇总分子除以汇总分母。", 人均观影时长: "总观影时长 ÷ 观影人数。", 付费率: "付费人数 ÷ DAU。", 收入: "统计周期内支付成功金额汇总。", 事件量: "接口返回的独立事件汇总次数，不保证来自同一批用户。", 总转化率: "当前步骤事件量 ÷ 首步骤事件量；步骤倒挂时不计算。", 步骤转化率: "当前步骤事件量 ÷ 上一步事件量；步骤倒挂时不计算。", D1留存: "注册 cohort 在第 1 日回登人数 ÷ 注册人数。", D3留存: "注册 cohort 在第 3 日回登人数 ÷ 注册人数。", D7留存: "注册 cohort 在第 7 日回登人数 ÷ 注册人数。", D30留存: "注册 cohort 在第 30 日回登人数 ÷ 注册人数；未到观察期显示为空。"
};

interface MetricFieldHelp { definition: string; formula: string; algorithm: string; apis: string[]; limitation?: string }
const metricFieldHelp: Record<MetricId, MetricFieldHelp> = {
  dau: { definition: "所选周期内每日活跃用户数的日均值。", formula: "Σ 每日 loginUserCount ÷ 有数据自然日数。", algorithm: "先汇总同一天所选平台，再对各自然日取平均；趋势图仍展示每天的 DAU。", apis: ["/api/admin/statistics/pDaySum", "/api/admin/home/pRealDayLine"], limitation: "不是周期去重活跃用户数；跨平台也未做账号级去重。" },
  dauUserDays: { definition: "所选周期内每日活跃用户数的累计人天。", formula: "Σ 每日 loginUserCount。", algorithm: "同一用户活跃多天会重复计数，适合衡量整体活跃规模，不代表周期 UV。", apis: ["/api/admin/statistics/pDaySum"] },
  newUsers: { definition: "统计周期内首次完成注册的新用户数。", formula: "汇总 registerUserCount；字段为空时兼容 newUserCount。", algorithm: "按日期和平台求和。", apis: ["/api/admin/statistics/pDaySum"] },
  viewerCount: { definition: "所选周期内每日观影用户数的日均值。", formula: "Σ 每日 watchUserCount ÷ 有数据自然日数。", algorithm: "日汇总场景先按日汇总平台再取平均；24小时曲线按五分钟时点展示。", apis: ["/api/admin/statistics/pDaySum", "/api/admin/home/pRealDayLine"], limitation: "不是周期去重观影用户数。" },
  viewerUserDays: { definition: "所选周期内每日观影人数累计形成的观影人天。", formula: "Σ 每日 watchUserCount。", algorithm: "同一用户多日观影会重复计数。", apis: ["/api/admin/statistics/pDaySum"] },
  searchCount: { definition: "用户提交搜索词的累计次数，同一用户多次搜索会重复计数。", formula: "按搜索词汇总 searchCnt。", algorithm: "次数求和；不是去重搜索人数。", apis: ["/api/admin/statistics/hotSearchWords/getMany"], limitation: "该接口当前不支持日期筛选，也不提供无结果和结果点击数据。" },
  revenue: { definition: "统计周期内后台确认的充值金额合计。", formula: "汇总 diamondChargeAmt。", algorithm: "金额按平台和日期求和。", apis: ["/api/admin/statistics/pDaySum"] },
  viewRate: { definition: "统计周期内观影用户人天占活跃用户人天的比例。", formula: "累计观影人天 ÷ 累计活跃人天 × 100%。", algorithm: "先汇总每日分子和分母再相除，不简单平均每日观影率。", apis: ["/api/admin/statistics/pDaySum", "/api/admin/home/pRealDayLine"], limitation: "现有接口无法计算周期去重观影用户 ÷ 周期去重活跃用户。" },
  payRate: { definition: "统计周期内付费用户人天占活跃用户人天的比例。", formula: "累计付费人天 ÷ 累计活跃人天 × 100%。", algorithm: "先汇总每日分子和分母再相除，不简单平均每日付费率。", apis: ["/api/admin/statistics/pDaySum"], limitation: "不是周期去重付费率；当前接口也不能继续拆分支付通道、会员档位和失败原因。" },
  payerCount: { definition: "所选周期内每日充值人数的日均值。", formula: "Σ 每日 totalChargeUserCount ÷ 有数据自然日数。", algorithm: "先汇总同一天所选平台，再对各自然日取平均。", apis: ["/api/admin/statistics/pDaySum"], limitation: "不是周期去重付费用户数。" },
  payerUserDays: { definition: "所选周期内每日充值人数的累计付费人天。", formula: "Σ 每日 totalChargeUserCount。", algorithm: "同一用户多日充值会重复计数。", apis: ["/api/admin/statistics/pDaySum"] },
  visits: { definition: "统计周期内落地访问累计次数。", formula: "汇总 totalVistCount。", algorithm: "先按平台、日期聚合各渠道访问，再跨日期求和。", apis: ["/api/admin/statistics/cpGuardStat/cnzzstatQuery"] },
  downloads: { definition: "统计周期内后台记录的累计下载次数。", formula: "汇总 totalDownCount。", algorithm: "先按平台、日期聚合各渠道下载，再跨日期求和。", apis: ["/api/admin/statistics/cpGuardStat/cnzzstatQuery"] },
  visitDownloadRate: { definition: "访问后产生下载的整体转化比例。", formula: "下载次数合计 ÷ 访问次数合计 × 100%。", algorithm: "使用区间合计分子除以区间合计分母，不平均每日转化率。", apis: ["/api/admin/statistics/cpGuardStat/cnzzstatQuery"] },
  downloadRegisterRate: { definition: "新增注册人数相对下载次数的比例。", formula: "新增用户合计 ÷ 下载次数合计 × 100%。", algorithm: "CNZZ 下载与 pDaySum 新增按平台和日期关联后加权计算。", apis: ["/api/admin/statistics/cpGuardStat/cnzzstatQuery", "/api/admin/statistics/pDaySum"], limitation: "下载与注册统计对象不同，结果可能超过100%；此时保留原值并标记口径不可比，不能视为严格同用户漏斗。" },
  visitRegisterRate: { definition: "新增注册人数相对访问次数的比例。", formula: "新增用户合计 ÷ 访问次数合计 × 100%。", algorithm: "CNZZ 访问与 pDaySum 新增按平台和日期关联后加权计算。", apis: ["/api/admin/statistics/cpGuardStat/cnzzstatQuery", "/api/admin/statistics/pDaySum"] },
  retentionD1: { definition: "某注册日新增用户在注册后第 1 天再次登录的比例。", formula: "D1 回登人数 ÷ 该注册日新增人数 × 100%。", algorithm: "按注册 cohort 计算；多 cohort 使用回登人数合计 ÷ 新增人数合计。", apis: ["/api/admin/statistics/reletionsStatPlus/getDays"] },
  retentionD3: { definition: "某注册日新增用户在注册后第 3 天再次登录的比例。", formula: "D3 回登人数 ÷ 该注册日新增人数 × 100%。", algorithm: "按注册 cohort 加权；未到第 3 天的 cohort 不参与。", apis: ["/api/admin/statistics/reletionsStatPlus/getDays"] },
  retentionD7: { definition: "某注册日新增用户在注册后第 7 天再次登录的比例。", formula: "D7 回登人数 ÷ 该注册日新增人数 × 100%。", algorithm: "按注册 cohort 加权；未到第 7 天的 cohort 不参与。", apis: ["/api/admin/statistics/reletionsStatPlus/getDays"] },
  retentionD30: { definition: "某注册日新增用户在注册后第 30 天再次登录的比例。", formula: "D30 回登人数 ÷ 该注册日新增人数 × 100%。", algorithm: "按注册 cohort 加权；未到第 30 天显示为空，不按 0 处理。", apis: ["/api/admin/statistics/reletionsStatPlus/getDays"] },
  videoCtr: { definition: "视频曝光用户中点击视频的用户占比。", formula: "视频点击去重人数 ÷ 视频曝光去重人数 × 100%。", algorithm: "需要同一位置口径的曝光和点击分子分母。", apis: ["暂无已确认接口"], limitation: "现有接口缺少视频曝光及页面/坑位字段，当前正式看板不开放该指标。" },
  playRate: { definition: "点击视频后实际开始播放的用户占比。", formula: "播放开始事件量 ÷ 视频点击事件量 × 100%。", algorithm: "当前仅能基于独立事件汇总量近似计算，不能证明用户级顺序。", apis: ["/api/admin/statistics/trackEventsReport/getEventStats"] },
  completeRate: { definition: "开始播放后到达播放结束事件的比例。", formula: "播放结束事件量 ÷ 播放开始事件量 × 100%。", algorithm: "基于事件汇总量；步骤倒挂时不计算转化率。", apis: ["/api/admin/statistics/trackEventsReport/getEventStats"] },
  searchNoResultRate: { definition: "提交搜索后没有返回结果的搜索次数占全部搜索次数的比例。", formula: "无结果搜索次数 ÷ 搜索提交次数 × 100%。", algorithm: "需要同周期的无结果次数和搜索次数。", apis: ["暂无已确认接口"], limitation: "热搜词接口未返回结果状态，当前正式看板不开放。" },
  arppu: { definition: "统计周期内每个付费用户人天平均贡献的收入。", formula: "充值金额合计 ÷ 累计付费人天。", algorithm: "按每日付费人数加权；不是基于周期去重付费用户的 ARPPU。", apis: ["/api/admin/statistics/pDaySum"] },
  arpu: { definition: "统计周期内每个活跃用户人天平均贡献的充值收入。", formula: "充值金额合计 ÷ 累计活跃人天。", algorithm: "按每日 DAU 加权；不是基于周期去重活跃用户的 ARPU。", apis: ["/api/admin/statistics/pDaySum"] },
  androidDau: { definition: "所选周期内 Android 每日活跃用户的日均值。", formula: "Σ 每日 androidLoginUserCount ÷ 有数据自然日数。", algorithm: "同日平台汇总后按自然日平均。", apis: ["/api/admin/statistics/pDaySum"] },
  androidDauUserDays: { definition: "Android 每日活跃用户的累计人天。", formula: "Σ 每日 androidLoginUserCount。", algorithm: "跨天可累加，同一用户多日活跃重复计数。", apis: ["/api/admin/statistics/pDaySum"] },
  iosDau: { definition: "所选周期内 IOS 每日活跃用户的日均值。", formula: "Σ 每日 iosLoginUserCount ÷ 有数据自然日数。", algorithm: "同日平台汇总后按自然日平均。", apis: ["/api/admin/statistics/pDaySum"] },
  iosDauUserDays: { definition: "IOS 每日活跃用户的累计人天。", formula: "Σ 每日 iosLoginUserCount。", algorithm: "跨天可累加，同一用户多日活跃重复计数。", apis: ["/api/admin/statistics/pDaySum"] },
  androidNewUsers: { definition: "统计周期内通过 Android 端完成注册的新用户数。", formula: "汇总 androidNewUserCount。", algorithm: "按平台和日期求和。", apis: ["/api/admin/statistics/pDaySum"] },
  iosNewUsers: { definition: "统计周期内通过 IOS 端完成注册的新用户数。", formula: "汇总 iosNewUserCount。", algorithm: "按平台和日期求和。", apis: ["/api/admin/statistics/pDaySum"] },
  organicNewUsers: { definition: "未归入渠道新增的注册用户数。", formula: "registerUserCount - channelRegisterCount。", algorithm: "逐平台、逐日相减后再汇总；结果不小于 0。", apis: ["/api/admin/statistics/pDaySum"] },
  internalNewUsers: { definition: "后台归入内部导量渠道的新增注册用户数。", formula: "汇总 channelInternalRegisterCount。", algorithm: "按后台来源口径求和。", apis: ["/api/admin/statistics/pDaySum"] },
  adClickCount: { definition: "广告相关入口产生的累计点击人次，同一用户重复点击会重复计数。", formula: "汇总 totalClickedCount。", algorithm: "次数按平台和日期求和。", apis: ["/api/admin/statistics/pDaySum"], limitation: "沿用运营日报总点击口径，包含后台归入该汇总字段的点击。" },
  adClickUsers: { definition: "所选周期内每日广告点击人数的日均值。", formula: "Σ 每日 totalClickedPerson ÷ 有数据自然日数。", algorithm: "后台仅提供日 UV，因此跨天默认显示日均。", apis: ["/api/admin/statistics/pDaySum"], limitation: "不是周期去重广告点击人数。" },
  adClickUserDays: { definition: "每日广告点击人数累计形成的人天。", formula: "Σ 每日 totalClickedPerson。", algorithm: "同一用户多日点击会重复计数。", apis: ["/api/admin/statistics/pDaySum"] },
  adClickRate: { definition: "广告点击人次相对同期活跃人数的比例。", formula: "totalClickedCount ÷ loginUserCount。", algorithm: "先汇总分子分母再相除。", apis: ["/api/admin/statistics/pDaySum"] },
  adClickUserRate: { definition: "广告点击人数相对同期活跃人数的比例。", formula: "totalClickedPerson ÷ loginUserCount。", algorithm: "先汇总分子分母再相除。", apis: ["/api/admin/statistics/pDaySum"] },
  newAdClickCount: { definition: "新增用户产生的广告相关入口累计点击人次。", formula: "汇总 newUserTotalClickedCount。", algorithm: "次数按平台和日期求和。", apis: ["/api/admin/statistics/pDaySum"] },
  newAdClickUsers: { definition: "新增用户中发生广告相关入口点击的用户数。", formula: "汇总 newUserTotalClickedPerson。", algorithm: "使用后台日汇总去重口径。", apis: ["/api/admin/statistics/pDaySum"] },
  newAdClickRate: { definition: "新增用户广告点击人次相对新增用户数的比例。", formula: "newUserTotalClickedCount ÷ registerUserCount。", algorithm: "先汇总分子分母再相除。", apis: ["/api/admin/statistics/pDaySum"] },
  newAdClickUserRate: { definition: "发生广告点击的新增用户占同期新增用户的比例。", formula: "newUserTotalClickedPerson ÷ registerUserCount。", algorithm: "先汇总分子分母再相除。", apis: ["/api/admin/statistics/pDaySum"] },
  oldAdClickCount: { definition: "非当日新增用户产生的广告累计点击人次。", formula: "totalClickedCount - newUserTotalClickedCount。", algorithm: "逐平台、逐日相减并取不小于 0，再汇总。", apis: ["/api/admin/statistics/pDaySum"] },
  oldAdClickUsers: { definition: "所选周期内每日老用户广告点击人数的日均值。", formula: "Σ 每日 (totalClickedPerson - newUserTotalClickedPerson) ÷ 有数据自然日数。", algorithm: "逐平台、逐日派生后，先汇总同日平台再按日平均。", apis: ["/api/admin/statistics/pDaySum"] },
  oldAdClickUserDays: { definition: "每日老用户广告点击人数累计形成的人天。", formula: "Σ 每日老用户广告点击人数。", algorithm: "跨天求和，同一用户多日点击重复计数。", apis: ["/api/admin/statistics/pDaySum"] },
  oldAdClickRate: { definition: "老用户广告点击人次相对老用户数的比例。", formula: "老用户广告点击人次 ÷ (DAU - 新增用户)。", algorithm: "先汇总派生分子和分母再相除。", apis: ["/api/admin/statistics/pDaySum"] },
  oldAdClickUserRate: { definition: "发生广告点击的老用户占同期老用户的比例。", formula: "老用户广告点击人数 ÷ (DAU - 新增用户)。", algorithm: "先汇总派生分子和分母再相除。", apis: ["/api/admin/statistics/pDaySum"] },
  newRevenue: { definition: "统计周期内新增用户贡献的充值金额。", formula: "汇总 newUserDiamondChargeAmt。", algorithm: "金额按平台和日期求和。", apis: ["/api/admin/statistics/pDaySum"] },
  newPayerCount: { definition: "统计周期内完成充值的新增用户数。", formula: "汇总 newUserChargeUserCount。", algorithm: "使用后台日汇总去重口径。", apis: ["/api/admin/statistics/pDaySum"] },
  newPayRate: { definition: "完成充值的新增用户占同期新增用户的比例。", formula: "newUserChargeUserCount ÷ registerUserCount。", algorithm: "先汇总分子分母再相除。", apis: ["/api/admin/statistics/pDaySum"] },
  newArpu: { definition: "每位新增用户平均贡献的充值收入。", formula: "newUserDiamondChargeAmt ÷ registerUserCount。", algorithm: "先汇总金额和新增人数再相除。", apis: ["/api/admin/statistics/pDaySum"] },
  newArppu: { definition: "每位新增付费用户平均贡献的充值收入。", formula: "newUserDiamondChargeAmt ÷ newUserChargeUserCount。", algorithm: "先汇总金额和新增付费人数再相除。", apis: ["/api/admin/statistics/pDaySum"] },
  oldRevenue: { definition: "非当日新增用户贡献的充值金额。", formula: "diamondChargeAmt - newUserDiamondChargeAmt。", algorithm: "逐平台、逐日相减并取不小于 0，再汇总。", apis: ["/api/admin/statistics/pDaySum"] },
  oldPayerCount: { definition: "所选周期内每日老用户充值人数的日均值。", formula: "Σ 每日 (totalChargeUserCount - newUserChargeUserCount) ÷ 有数据自然日数。", algorithm: "逐平台、逐日派生后，先汇总同日平台再按日平均。", apis: ["/api/admin/statistics/pDaySum"] },
  oldPayerUserDays: { definition: "每日老用户充值人数累计形成的付费人天。", formula: "Σ 每日老用户充值人数。", algorithm: "跨天求和，同一用户多日充值重复计数。", apis: ["/api/admin/statistics/pDaySum"] },
  oldPayRate: { definition: "完成充值的老用户占同期老用户的比例。", formula: "老用户充值人数 ÷ (DAU - 新增用户)。", algorithm: "先汇总派生分子和分母再相除。", apis: ["/api/admin/statistics/pDaySum"] },
  oldArpu: { definition: "每位老用户平均贡献的充值收入。", formula: "老用户充值金额 ÷ (DAU - 新增用户)。", algorithm: "先汇总派生金额和老用户数再相除。", apis: ["/api/admin/statistics/pDaySum"] },
  oldArppu: { definition: "每位老用户付费用户平均贡献的充值收入。", formula: "老用户充值金额 ÷ 老用户充值人数。", algorithm: "先汇总派生金额和人数再相除。", apis: ["/api/admin/statistics/pDaySum"] },
  channelNewRevenue: { definition: "后台归入渠道新增用户贡献的充值金额。", formula: "汇总 channelNewUserChargeAmt。", algorithm: "金额按平台和日期求和。", apis: ["/api/admin/statistics/pDaySum"], limitation: "该字段是渠道新增充值，不等同于运营表中的自然新增总充值。" },
  internalNewRevenue: { definition: "后台归入内部导量新增用户贡献的充值金额。", formula: "汇总 channelInternalNewUserChargeAmt。", algorithm: "金额按平台和日期求和。", apis: ["/api/admin/statistics/pDaySum"] },
  avgUsageMinutes: { definition: "统计周期内每位活跃用户平均使用产品的分钟数。", formula: "前台使用总时长 ÷ DAU。", algorithm: "需要总时长作为分子、DAU 作为分母加权计算。", apis: ["暂无已确认接口"], limitation: "当前缺少已确认的前台总使用时长字段。" },
  avgWatchMinutes: { definition: "统计周期内每位观影用户平均观看视频的分钟数。", formula: "总观看时长 ÷ 观影去重人数。", algorithm: "按总观看时长和观看人数加权，不平均各视频的人均值。", apis: ["/api/admin/statistics/todayVideos/getMany", "/api/admin/home/pRealDayLine"], limitation: "不同接口的观看时长原始单位需按 Adapter 已确认规则换算。" },
  pageViews: { definition: "页面被展示给用户的累计次数。", formula: "页面曝光事件累计次数。", algorithm: "次数求和，可按页面和平台分组。", apis: ["暂无已确认接口"], limitation: "当前接口未提供通用页面曝光。" },
  pageClicks: { definition: "用户点击页面元素的累计次数。", formula: "页面元素点击事件累计次数。", algorithm: "次数求和，可按页面和元素分组。", apis: ["/api/admin/statistics/navigationClicks/getMany"], limitation: "当前仅有导航等局部点击，不等同于全站页面点击。" },
  currentPaidMembers: { definition: "统计时点会员权益仍处于有效期内的付费用户数。", formula: "有效会员用户去重数。", algorithm: "存量指标应取周期末时点值。", apis: ["暂无已确认接口"], limitation: "当前没有已确认会员有效期接口字段。" },
  historicalPaidMembers: { definition: "历史上至少成功付费一次的累计去重用户数。", formula: "历史付费成功用户去重数。", algorithm: "累计存量指标，不能按日直接求和。", apis: ["暂无已确认接口"], limitation: "当前没有已确认历史付费用户字段。" },
  renewalRate: { definition: "到期会员中成功续费用户所占比例。", formula: "成功续费会员数 ÷ 到期会员数 × 100%。", algorithm: "按同一到期 cohort 汇总分子和分母后计算。", apis: ["暂无已确认接口"], limitation: "当前接口未提供续费分子和到期分母。" },
  videoWatchCount: { definition: "视频产生播放或观看行为的累计次数，同一用户重复观看会重复计数。", formula: "汇总 watchedCount。", algorithm: "按视频、分类、平台求和。", apis: ["/api/admin/statistics/todayVideos/getMany", "/api/admin/statistics/todayVideos/getVideoStatsByCategories"] },
  videoViewerCount: { definition: "观看视频的用户数；按接口当前口径可能为近似去重人数。", formula: "读取 watchedUserCount。", algorithm: "同平台分类汇总按接口返回口径处理，不跨分类强行去重。", apis: ["/api/admin/statistics/todayVideos/getMany", "/api/admin/statistics/todayVideos/getVideoStatsByCategories"], limitation: "接口标记为近似 UV 时仅用于趋势判断。" },
  videoLikeCount: { definition: "视频获得点赞的累计次数。", formula: "汇总 likedCount。", algorithm: "按视频、分类、平台求和。", apis: ["/api/admin/statistics/todayVideos/getMany", "/api/admin/statistics/todayVideos/getVideoStatsByCategories"] },
  videoCollectCount: { definition: "视频被收藏的累计次数。", formula: "汇总 collectedCount。", algorithm: "按视频、分类、平台求和。", apis: ["/api/admin/statistics/todayVideos/getMany", "/api/admin/statistics/todayVideos/getVideoStatsByCategories"] }
};

function getFieldExplanation(label: string, metric?: MetricId) {
  return metric ? metricFieldHelp[metric].definition : fieldExplanations[label] ?? `${label}是当前真实接口返回或经 Adapter 归一化后的业务字段。`;
}

const CardFieldContext = React.createContext<DashboardCardConfig | null>(null);
const fieldApiSources: Record<string, string[]> = {
  DAU: ["/api/admin/home/pRealDayLine", "/api/admin/home/getAllByRole"],
  新增用户: ["/api/admin/statistics/pDaySum", "/api/admin/home/getAllByRole"],
  观影率: ["/api/admin/home/pRealDayLine"],
  人均观影时长: ["/api/admin/statistics/todayUsers/getMany"],
  搜索次数: ["/api/admin/statistics/hotSearchWords/getMany"],
  收入: ["/api/admin/statistics/pDaySum"],
  付费率: ["/api/admin/statistics/pDaySum"],
  观看次数: ["/api/admin/statistics/todayVideos/getVideoStatsByCategories"],
  观看人数: ["/api/admin/statistics/todayVideos/getVideoStatsByCategories"],
  点击次数: ["/api/admin/statistics/trackEventsReport/getEventStats"],
  D1留存: ["/api/admin/statistics/reletionsStatPlus/getDays"],
  D3留存: ["/api/admin/statistics/reletionsStatPlus/getDays"],
  D7留存: ["/api/admin/statistics/reletionsStatPlus/getDays"],
  D30留存: ["/api/admin/statistics/reletionsStatPlus/getDays"]
};

function FieldExplanationDialog({ label, metric, card, onClose }: { label: string; metric?: MetricId; card: DashboardCardConfig | null; onClose: () => void }) {
  useBodyScrollLock(true);
  const capability = card ? getApiCapability(card.model) : null;
  const metricHelp = metric ? metricFieldHelp[metric] : null;
  const apiPaths = metricHelp?.apis ?? fieldApiSources[label] ?? ["当前分析模块对应的真实后台接口"];
  const algorithm = metricHelp?.algorithm ?? "作为分组或明细字段使用；数量指标按分组求和，比例指标按汇总分子 ÷ 汇总分母计算。";
  const limitation = metricHelp?.limitation ?? capability?.limitations.join("；") ?? "无额外限制";
  return createPortal(<div className="ui-v13 platform-portal-layer"><div className="field-explanation-modal" role="presentation" onMouseDown={onClose}><section role="dialog" aria-modal="true" aria-label={`${label}字段说明`} onMouseDown={(event) => event.stopPropagation()}><div className="field-explanation-head"><div><span>字段说明</span><h3>{label}</h3></div><button aria-label="关闭字段说明" onClick={onClose}><X aria-hidden="true" /></button></div><dl><div><dt>中文解释</dt><dd>{getFieldExplanation(label, metric)}</dd></div>{metricHelp && <div><dt>计算公式</dt><dd>{metricHelp.formula}</dd></div>}<div><dt>聚合算法</dt><dd>{algorithm}</dd></div><div><dt>使用接口</dt><dd className="field-api-paths">{apiPaths.map((path) => <code key={path}>{path}</code>)}</dd></div>{capability && <div><dt>数据粒度</dt><dd>{capability.dataGrain}</dd></div>}<div><dt>口径限制</dt><dd>{limitation}</dd></div></dl><div className="field-explanation-foot">统计时间统一按北京时间自然日；比例指标默认采用汇总分子 ÷ 汇总分母，不简单平均每日百分比。</div></section></div></div>, document.body);
}

function FieldHelpTrigger({ label, metric }: { label: string; metric?: MetricId }) {
  const card = React.useContext(CardFieldContext);
  const [open, setOpen] = useState(false);
  return <><button type="button" className="field-help" title={`查看${label}完整说明`} aria-label={`查看${label}字段解释`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); setOpen(true); }}><CircleHelp aria-hidden="true" /></button>{open && <FieldExplanationDialog label={label} metric={metric} card={card} onClose={() => setOpen(false)} />}</>;
}

function FieldLabel({ label, metric }: { label: string; metric?: MetricId }) {
  return <span className="field-label">{label}<FieldHelpTrigger label={label} metric={metric} /></span>;
}

function ConfigFieldChoice({ label, metric, selected, onClick }: { label: string; metric?: MetricId; selected: boolean; onClick: () => void }) {
  return <span className={`config-field-choice${selected ? " on" : ""}`}><button type="button" aria-pressed={selected} onClick={onClick}>{label}</button><FieldHelpTrigger label={label} metric={metric} /></span>;
}

const metricGroups: Array<{ name: string; metrics: MetricId[] }> = [
  { name: "规模", metrics: ["dau", "dauUserDays", "newUsers"] },
  { name: "终端", metrics: ["androidDau", "androidDauUserDays", "iosDau", "iosDauUserDays", "androidNewUsers", "iosNewUsers"] },
  { name: "来源", metrics: ["organicNewUsers", "internalNewUsers"] },
  { name: "广告", metrics: ["adClickCount", "adClickUsers", "adClickUserDays", "adClickRate", "adClickUserRate", "newAdClickCount", "newAdClickUsers", "newAdClickRate", "newAdClickUserRate", "oldAdClickCount", "oldAdClickUsers", "oldAdClickUserDays", "oldAdClickRate", "oldAdClickUserRate"] },
  { name: "内容与观看", metrics: ["viewerCount", "viewerUserDays", "viewRate", "avgWatchMinutes", "videoWatchCount", "videoViewerCount", "videoLikeCount", "videoCollectCount", "videoCtr", "playRate", "completeRate"] },
  { name: "付费", metrics: ["revenue", "payerCount", "payerUserDays", "payRate", "arpu", "arppu", "newRevenue", "newPayerCount", "newPayRate", "newArpu", "newArppu", "oldRevenue", "oldPayerCount", "oldPayerUserDays", "oldPayRate", "oldArpu", "oldArppu", "channelNewRevenue", "internalNewRevenue"] },
  { name: "留存", metrics: ["retentionD1", "retentionD3", "retentionD7", "retentionD30"] },
  { name: "获客", metrics: ["visits", "downloads", "visitDownloadRate", "downloadRegisterRate", "visitRegisterRate"] },
  { name: "其他", metrics: ["searchCount", "searchNoResultRate", "avgUsageMinutes", "pageViews", "pageClicks", "currentPaidMembers", "historicalPaidMembers", "renewalRate"] }
];

function MetricPicker({ metrics, selected, onToggle, dropTarget = false }: { metrics: MetricId[]; selected: MetricId[]; onToggle: (metric: MetricId) => void; dropTarget?: boolean }) {
  const [search, setSearch] = useState("");
  const keyword = search.trim().toLowerCase();
  const available = new Set(metrics);
  const groups = metricGroups.map((group) => ({ ...group, metrics: group.metrics.filter((metric) => available.has(metric) && (!keyword || metric.toLowerCase().includes(keyword) || metricName[metric].toLowerCase().includes(keyword))) })).filter((group) => group.metrics.length);
  return <div className={`metric-picker${dropTarget ? " metric-drop-zone" : ""}`}>
    <div className="metric-search"><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索指标名称或字段 ID" /><span>{selected.length}/{MAX_METRICS_PER_QUERY} 项已选</span></div>
    <div className="metric-groups">{groups.map((group) => <section className="metric-group" key={group.name}><div className="metric-group-title"><b>{group.name}</b><em>{group.metrics.length}</em></div><div className="chips editable">{group.metrics.map((metric) => <ConfigFieldChoice label={metricName[metric]} metric={metric} selected={selected.includes(metric)} key={metric} onClick={() => {
      if (!selected.includes(metric) && selected.length >= MAX_METRICS_PER_QUERY) {
        notify(`单张卡片最多选择 ${MAX_METRICS_PER_QUERY} 个指标`);
        return;
      }
      onToggle(metric);
    }} />)}</div></section>)}</div>
    {!groups.length && <div className="metric-empty">没有匹配的指标</div>}
  </div>;
}

const aggregationName = { sum: "区间求和", average: "按自然日取平均", latest: "取周期末值", weighted: "按分子分母加权" } as const;

function CardMethodology({ card }: { card: DashboardCardConfig }) {
  const capability = getApiCapability(card.model);
  return <section className="card-methodology">
    <div className="methodology-head"><div><b>口径与计算说明</b><span>本卡片的中文定义、真实接口和前端聚合规则</span></div><em>{capability.statusLabel}</em></div>
    <div className="methodology-grid">
      <div><strong>指标解释</strong>{card.metrics.map((metric) => <p key={metric}><b>{metricName[metric]}</b><span>{getFieldExplanation(metricName[metric], metric)}</span></p>)}</div>
      <div><strong>维度解释</strong>{card.dimensions.map((dimension) => <p key={dimension}><b>{dimensionName[dimension]}</b><span>{getFieldExplanation(dimensionName[dimension])}</span></p>)}</div>
      <div><strong>使用接口</strong>{capability.apiPaths.map((path) => <code key={path}>{path}</code>)}</div>
      <div><strong>计算算法</strong>{card.metrics.map((metric) => <p key={metric}><b>{metricName[metric]}</b><span>{aggregationName[METRIC_META[metric].aggregation]}{metricDictionary.find((item) => item.id === metric)?.formula ? `；${metricDictionary.find((item) => item.id === metric)?.formula}` : ""}</span></p>)}<small>数据粒度：{capability.dataGrain}</small></div>
    </div>
    {capability.limitations.length > 0 && <div className="methodology-limit"><b>能力边界</b><span>{capability.limitations.join("；")}</span></div>}
  </section>;
}

function DataTable({ rows, compact = false }: { rows: Record<string, string | number>[]; compact?: boolean }) {
  const [page, setPage] = useState(0);
  const pageSize = compact ? 4 : 6;
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const visibleRows = rows.slice(safePage * pageSize, safePage * pageSize + pageSize);
  const headers = Object.keys(rows[0] ?? {});
  if (!rows.length) return <div className="empty-preview">当前筛选条件下暂无数据</div>;
  return <div className="table-wrap"><div className="table-scroll"><table><thead><tr>{headers.map((header) => <th key={header}><FieldLabel label={header} /></th>)}</tr></thead><tbody>{visibleRows.map((row, index) => <tr key={`${safePage}-${index}`}>{headers.map((header) => <td key={header}>{row[header]}</td>)}</tr>)}</tbody></table></div>{!compact && pageCount > 1 && <div className="table-pagination"><span>共 {rows.length} 条</span><button disabled={safePage === 0} onClick={() => setPage((current) => Math.max(0, current - 1))}>上一页</button><b>{safePage + 1} / {pageCount}</b><button disabled={safePage >= pageCount - 1} onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}>下一页</button></div>}</div>;
}

function DiagnosisCard({ insights }: { insights: string[] }) {
  const labels = ["关键变化", "主要原因", "建议动作"];
  return <div className="diagnosis-list">{insights.map((insight, index) => <div key={insight}><span className={`insight-index insight-${index}`}>{index + 1}</span><div><b>{labels[index] ?? "分析结论"}</b><span>{insight}</span></div></div>)}</div>;
}

function hasChartData(card: DashboardCardConfig, result: CardQueryResult) {
  if (card.type === "funnel") return Boolean(result.funnel?.length);
  if (card.type === "heatmap") return Boolean(result.heatmap?.length);
  if (card.type === "scatter") return Boolean(result.scatter?.length);
  if (card.type === "treemap") return Boolean(result.treemap?.length);
  if (card.type === "cohort") return Boolean(result.cohort?.length);
  if (card.type === "waterfall") return Boolean(result.waterfall?.length);
  if (card.type === "sankey") return Boolean(result.sankey?.nodes.length && result.sankey.links.length);
  return result.categories.length > 0 && result.series.some((series) => series.data.length > 0);
}

const resizeSizes: DashboardCardConfig["size"][] = ["md", "lg", "full"];
const sizeSpan: Record<DashboardCardConfig["size"], number> = { sm: 3, md: 6, lg: 8, full: 12 };

function nearestCardSize(span: number) {
  return resizeSizes.reduce((nearest, size) => Math.abs(sizeSpan[size] - span) < Math.abs(sizeSpan[nearest] - span) ? size : nearest, resizeSizes[0]);
}

function CardResizeHandle({ size, onResize }: { size: DashboardCardConfig["size"]; onResize: (size: DashboardCardConfig["size"]) => void }) {
  const drag = useRef<{ startX: number; startSpan: number; gridWidth: number } | null>(null);
  const updateFromPointer = (clientX: number) => {
    if (!drag.current) return;
    const deltaSpan = Math.round((clientX - drag.current.startX) / (drag.current.gridWidth / 12));
    onResize(nearestCardSize(Math.max(6, Math.min(12, drag.current.startSpan + deltaSpan))));
  };
  const resizeByKeyboard = (direction: -1 | 1) => {
    const index = resizeSizes.indexOf(size);
    onResize(resizeSizes[Math.max(0, Math.min(resizeSizes.length - 1, index + direction))]);
  };
  return <button
    type="button"
    className="card-resize-handle"
    aria-label={`调整卡片宽度，当前${sizeName[size]}`}
    title="按住左右拖动调整宽度"
    onPointerDown={(event) => {
      event.preventDefault();
      event.stopPropagation();
      const cardElement = event.currentTarget.closest<HTMLElement>("[data-resize-card]");
      const gridWidth = cardElement?.parentElement?.getBoundingClientRect().width ?? 0;
      if (!gridWidth) return;
      drag.current = { startX: event.clientX, startSpan: sizeSpan[size], gridWidth };
      cardElement?.classList.add("is-resizing");
      const handlePointerMove = (moveEvent: PointerEvent) => updateFromPointer(moveEvent.clientX);
      const finishResize = (upEvent: PointerEvent) => {
        updateFromPointer(upEvent.clientX);
        drag.current = null;
        cardElement?.classList.remove("is-resizing");
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", finishResize);
        window.removeEventListener("pointercancel", finishResize);
      };
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", finishResize);
      window.addEventListener("pointercancel", finishResize);
    }}
    onDragStart={(event) => event.preventDefault()}
    onKeyDown={(event) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        resizeByKeyboard(-1);
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        resizeByKeyboard(1);
      }
    }}
  ><span /></button>;
}

function useLoadingProgress(loading: boolean) {
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    if (loading) {
      setProgress((current) => current > 0 ? current : 8);
      const timer = window.setInterval(() => {
        setProgress((current) => Math.min(92, current + Math.max(1, (92 - current) * 0.09)));
      }, 320);
      return () => window.clearInterval(timer);
    }
    if (progress <= 0) return undefined;
    setProgress(100);
    const timer = window.setTimeout(() => setProgress(0), 420);
    return () => window.clearTimeout(timer);
  }, [loading]);
  return progress;
}

function CardRenderer({ card, filters = DEFAULT_FILTERS, onDrill, resizable = false, onResize, onPlatformScopeChange, modern = false }: { card: DashboardCardConfig; filters?: DashboardFilters; onDrill: (payload: DrilldownPayload) => void; resizable?: boolean; onResize?: (size: DashboardCardConfig["size"]) => void; onPlatformScopeChange?: (patch: Pick<DashboardCardConfig, "platformMode" | "platforms">) => void; modern?: boolean }) {
  const [viewMode, setViewMode] = useState<"trend" | "change" | "table">("trend");
  const [retryKey, setRetryKey] = useState(0);
  const [completePreview, setCompletePreview] = useState(false);
  useBodyScrollLock(completePreview);
  const [previewFilters, setPreviewFilters] = useState<DashboardFilters | null>(null);
  const configuredFilters = useMemo(() => cardScopedFilters(card, filters), [card, filters]);
  const effectiveFilters = completePreview && previewFilters ? previewFilters : configuredFilters;
  const realQuery = useRealCardQuery(card, effectiveFilters, retryKey);
  const loadingProgress = useLoadingProgress(realQuery.loading);
  const result = useMemo<CardQueryResult>(() => realQuery.result ?? ({
    scopeLabel: realQuery.eligible ? "真实数据查询异常" : "当前 API 能力不支持",
    categories: [], series: [], summary: [], table: [],
    insights: [realQuery.error ?? "该卡片的指标、维度或平台组合无法由现有 API 真实计算，请在卡片工厂调整配置。"]
  }), [realQuery.eligible, realQuery.error, realQuery.result]);
  const chartOption = useMemo(() => makeQueryOption(card, result, modern), [card, modern, result]);
  const capability = getApiCapability(card.model);
  const chartHasData = hasChartData(card, result);
  const platformRowCount = card.dimensions.includes("platform") ? (card.type === "heatmap" ? result.heatmapY?.length ?? 0 : card.type === "cohort" ? result.cohortY?.length ?? 0 : card.type === "bar" ? result.categories.length : 0) : 0;
  const chartHeight = platformRowCount > 10 ? Math.max(310, platformRowCount * 25 + 76) : undefined;
  const coverageInsight = result.insights.find((insight) => insight.startsWith("数据覆盖："));
  const simpleCard = card.type === "kpi" || card.type === "table" || card.type === "diagnosis";
  const simpleCardHasData = card.type === "kpi" ? result.summary.length > 0 : card.type === "table" ? result.table.length > 0 : result.insights.length > 0;
  const simpleCardReady = simpleCard && !realQuery.loading && !realQuery.error && simpleCardHasData;

  const className = `card ${card.size}${completePreview ? " complete-preview-card" : ""}${modern ? " card--v13" : ""}`;
  const hasViewTabs = ["line", "bar", "heatmap", "funnel", "treemap", "scatter", "cohort", "waterfall", "sankey"].includes(card.type);
  return <CardFieldContext.Provider value={card}><>{completePreview && <div className="complete-preview-backdrop" onMouseDown={() => setCompletePreview(false)} />}
  <section className={className} data-card-type={card.type} data-resize-card={resizable ? "true" : undefined} data-mobile-visibility={card.mobileVisibility ?? "show"} style={{ "--mobile-order": card.mobileOrder ?? 0 } as React.CSSProperties}>
    {completePreview && <div className="complete-preview-toolbar"><div><b>完整预览</b><span>当前范围：{platformScopeLabel(effectiveFilters)}</span></div><div className="complete-preview-controls"><MenuSelect label="平台模式" ariaLabel="完整预览平台模式" align="end" value={effectiveFilters.mode} onChange={(value) => {
      const mode = value as PlatformMode;
      setPreviewFilters(cardScopedFilters({ ...card, platformMode: mode }, filters));
    }} groups={[{ label: "范围", options: [{ value: "all", label: "全部平台" }, { value: "single", label: "单个平台" }, { value: "compare", label: "多平台对比" }] }]} />{effectiveFilters.mode === "single" && <MenuSelect label="选择平台" ariaLabel="完整预览平台" align="end" value={effectiveFilters.platforms[0] ?? Object.keys(platformPid)[0]} onChange={(value) => setPreviewFilters({ ...effectiveFilters, platforms: [value] })} groups={[{ label: "平台", options: Object.keys(platformPid).map((name) => ({ value: name, label: name, meta: platformPid[name] })) }]} />}{effectiveFilters.mode === "compare" && <MultiMenuSelect label="对比平台" ariaLabel="完整预览对比平台" align="end" values={effectiveFilters.platforms} minSelected={2} maxSelected={card.model === "usage_depth" ? 4 : 8} onChange={(values) => setPreviewFilters({ ...effectiveFilters, platforms: values })} options={Object.keys(platformPid).map((name) => ({ value: name, label: name, meta: platformPid[name] }))} />}{onPlatformScopeChange && <button className="primary-btn" onClick={() => { onPlatformScopeChange({ platformMode: effectiveFilters.mode, platforms: effectiveFilters.mode === "all" ? [] : effectiveFilters.platforms }); notify("已应用到卡片，保存布局后生效"); }}>应用到卡片</button>}<button onClick={() => setCompletePreview(false)}>关闭</button></div></div>}
    <div className="chart-card-head">
      <div className="card-heading">
        <div className="card-title"><span>{card.title}</span><small>{modelName[card.model]}</small></div>
        <div className="card-meta-row">
          <button className="card-platform-scope" title="点击进入完整预览并切换平台范围" onClick={() => { setPreviewFilters(configuredFilters); setCompletePreview(true); }}>平台：{card.platformMode && card.platformMode !== "global" ? platformScopeLabel(configuredFilters) : `跟随看板 · ${platformScopeLabel(configuredFilters)}`}</button>
          {coverageInsight && <span className="coverage-status" title={coverageInsight}>{coverageInsight.split("；")[0]}</span>}
          <span
            className={realQuery.result ? "query-state ready" : realQuery.loading ? "query-state loading" : "query-state unavailable"}
            title={`${filters.dateRange} · ${result.scopeLabel} · ${capability.dataGrain}`}
          >{realQuery.loading ? `更新中 ${Math.round(loadingProgress)}%` : realQuery.result ? "已更新" : realQuery.eligible && realQuery.error ? "异常" : "不可用"}</span>
        </div>
      </div>
      <div className="chart-view-tabs">
      {hasViewTabs && <>
        <div className="card-view-mode" role="group" aria-label={`${card.title}视图`}>
          <button aria-pressed={viewMode === "trend"} className={viewMode === "trend" ? "on" : ""} onClick={() => setViewMode("trend")}>趋势</button>
          <button aria-pressed={viewMode === "change"} className={viewMode === "change" ? "on" : ""} onClick={() => setViewMode("change")}>变化</button>
          <button aria-pressed={viewMode === "table"} className={viewMode === "table" ? "on" : ""} onClick={() => setViewMode("table")}>表格</button>
        </div>
        <span className="card-action-divider" aria-hidden="true" />
        <button className="card-icon-action drill-entry" aria-label={`查看${card.title}明细`} title="查看明细" onClick={() => onDrill(buildDrill(card, result, effectiveFilters, card.title))}><ChartNoAxesCombined aria-hidden="true" /></button>
      </>}
        <button className="card-icon-action complete-preview-entry" aria-label={`完整预览${card.title}`} title="完整预览" onClick={() => { setPreviewFilters(configuredFilters); setCompletePreview(true); }}><Maximize2 aria-hidden="true" /></button>
      </div>
    </div>
    <div className={`card-query-progress${loadingProgress > 0 ? " visible" : ""}`} role={realQuery.loading ? "progressbar" : undefined} aria-label={realQuery.loading ? `${card.title}数据读取进度` : undefined} aria-valuemin={realQuery.loading ? 0 : undefined} aria-valuemax={realQuery.loading ? 100 : undefined} aria-valuenow={realQuery.loading ? Math.round(loadingProgress) : undefined}>
      <span style={{ width: `${loadingProgress}%` }} />
    </div>
    {realQuery.error && realQuery.result && <div className="card-data-warning compact-warning"><span>数据更新失败：{realQuery.error}，当前保留上次结果。</span><button onClick={() => setRetryKey((value) => value + 1)}>重试</button></div>}
    {hasViewTabs && <div className="card-summary-line"><b>{card.metrics.map((metric) => metricName[metric]).slice(0, 3).join(" / ")}</b><div className="summary-comparisons">{result.summary.slice(0, 3).map((item) => <span key={item.metric}><strong>{metricName[item.metric]} {item.formatted}</strong><ComparisonBadge change={item.change} positive={METRIC_META[item.metric].positive ? item.change >= 0 : item.change <= 0} comparison={item.changeLabel} /></span>)}</div></div>}
    {simpleCard && <DataState loading={realQuery.loading} error={realQuery.error} empty={!realQuery.loading && !realQuery.error && !simpleCardHasData} loadingLabel={`正在加载${card.title}...`} emptyLabel={realQuery.eligible ? "当前筛选条件没有真实数据" : "现有 API 不支持该卡片配置，请在分析中心调整字段组合"} onRetry={realQuery.eligible && realQuery.error ? () => setRetryKey((value) => value + 1) : undefined} />}
    {card.type === "kpi" && simpleCardReady && <KpiCard result={result} />}
    {hasViewTabs && viewMode === "trend" && chartHasData && <Chart option={chartOption} theme={modern ? "v13" : "classic"} style={chartHeight ? { height: chartHeight } : undefined} ariaLabel={`${card.title}图表`} onClick={(params: any) => onDrill(buildDrill(card, result, effectiveFilters, params?.name ?? "图表节点"))} />}
    {hasViewTabs && viewMode === "trend" && !chartHasData && <DataState loading={realQuery.loading} error={realQuery.error} empty={!realQuery.loading} loadingLabel={`正在加载${card.title}...`} emptyLabel={realQuery.eligible ? "当前筛选条件没有真实数据" : "现有 API 不支持该卡片配置，请在分析中心调整字段组合"} onRetry={realQuery.eligible && realQuery.error ? () => setRetryKey((value) => value + 1) : undefined} />}
    {hasViewTabs && viewMode === "change" && <DiagnosisCard insights={result.insights} />}
    {hasViewTabs && viewMode === "table" && <DataTable rows={result.table} />}
    {card.type === "table" && simpleCardReady && <DataTable rows={result.table} />}
    {card.type === "diagnosis" && simpleCardReady && <DiagnosisCard insights={result.insights} />}
    {completePreview && <CardMethodology card={card} />}
    {resizable && onResize && !completePreview && <CardResizeHandle size={card.size} onResize={onResize} />}
  </section></></CardFieldContext.Provider>;
}

function CardAssetPreview({ card }: { card: DashboardCardConfig }) {
  const result = useMemo(() => executeCardQuery(card, DEFAULT_FILTERS), [card]);
  const modern = uiVersion === "v13";
  const option = useMemo(() => makeQueryOption(card, result, modern), [card, modern, result]);

  if (card.type === "kpi") return <KpiCard result={result} />;
  if (card.type === "table") return <div className="mini-table"><DataTable rows={result.table} compact /></div>;
  if (card.type === "diagnosis") return <DiagnosisCard insights={result.insights} />;
  if (["line", "bar", "heatmap", "funnel", "treemap", "scatter", "cohort", "waterfall", "sankey"].includes(card.type)) {
    return <div className="asset-chart"><Chart option={option} theme={modern ? "v13" : "classic"} /></div>;
  }
  return <div className="empty-preview">暂无预览</div>;
}

function DashboardRenderer({ template, filters, onDrill, onSaveLayout, toolbar, modern = false }: { template: DashboardTemplate; filters: DashboardFilters; onDrill: (payload: DrilldownPayload) => void; onSaveLayout: (cards: DashboardCardConfig[]) => void; toolbar?: React.ReactNode; modern?: boolean }) {
  const model = analysisModels.find((item) => item.id === template.model);
  const [layoutCards, setLayoutCards] = useState(template.cards);
  const [layoutDirty, setLayoutDirty] = useState(false);
  useEffect(() => {
    setLayoutCards(template.cards);
    setLayoutDirty(false);
  }, [template.id, template.cards]);
  const resizeCard = (cardId: string, size: DashboardCardConfig["size"]) => {
    setLayoutCards((cards) => cards.map((card) => card.id === cardId ? { ...card, size } : card));
    setLayoutDirty(true);
  };
  const updateCardPlatformScope = (cardId: string, patch: Pick<DashboardCardConfig, "platformMode" | "platforms">) => {
    setLayoutCards((cards) => cards.map((card) => card.id === cardId ? { ...card, ...patch } : card));
    setLayoutDirty(true);
  };
  const exportRows = () => {
    const rows = layoutCards.flatMap((card) => executeCardQuery(card, cardScopedFilters(card, filters)).table.map((row) => ({ 卡片: card.title, ...row })));
    downloadCsv(`${template.name}-${filters.dateRange}.csv`, rows);
  };
  const saveLayout = () => {
    onSaveLayout(layoutCards);
    setLayoutDirty(false);
    notify("看板布局已保存");
  };
  const cards = <div className="cards-grid resizable-grid">{layoutCards.map((card) => <CardRenderer key={card.id} card={card} filters={filters} onDrill={onDrill} resizable onResize={(size) => resizeCard(card.id, size)} onPlatformScopeChange={(patch) => updateCardPlatformScope(card.id, patch)} modern={modern} />)}</div>;
  if (modern) return <DashboardReadFrame
    title={template.name}
    description={template.scenario}
    modelName={model?.name}
    focus={dashboardFocus[template.id] ?? []}
    layoutDirty={layoutDirty}
    onSaveLayout={saveLayout}
    onExport={exportRows}
    toolbar={toolbar}
    mobileHiddenCount={layoutCards.filter((card) => card.mobileVisibility === "hide").length}
  >{cards}</DashboardReadFrame>;
  return <div>
    <div className="dashboard-head">
      <div><h1>{template.name}</h1><p>{template.scenario}</p></div>
      <div className="dashboard-actions"><div className="model-pill">{model?.name}</div><button className={layoutDirty ? "blue-action" : ""} disabled={!layoutDirty} onClick={saveLayout}>保存布局</button><button onClick={exportRows}>导出</button></div>
    </div>
    <div className="decision-strip">{(dashboardFocus[template.id] ?? []).map(([label, value]) => <div key={label}><span>{label}</span><b>{value}</b></div>)}</div>
    {cards}
  </div>;
}

const chartTypes: ChartType[] = ["kpi", "line", "bar", "scatter", "heatmap", "funnel", "cohort", "waterfall", "sankey", "treemap", "table", "diagnosis"];
const cardSizes: DashboardCardConfig["size"][] = ["md", "lg", "full"];
const assetFilterTypes: Array<ChartType | "all"> = ["all", ...chartTypes];
const chartTypeRank = new Map(chartTypes.map((type, index) => [type, index]));

function sortAssetsByType(assets: CardAsset[]) {
  return [...assets].sort((a, b) => {
    const typeDiff = (chartTypeRank.get(a.config.type) ?? 99) - (chartTypeRank.get(b.config.type) ?? 99);
    return typeDiff || a.name.localeCompare(b.name, "zh-CN");
  });
}

function filterAssetsByType(assets: CardAsset[], activeType: ChartType | "all") {
  return sortAssetsByType(activeType === "all" ? assets : assets.filter((asset) => asset.config.type === activeType));
}

function AssetTypeFilters({ activeType, assets, onChange }: { activeType: ChartType | "all"; assets: CardAsset[]; onChange: (type: ChartType | "all") => void }) {
  return <div className="asset-type-filters" role="tablist" aria-label="卡片类型">
    {assetFilterTypes.map((type) => {
      const count = type === "all" ? assets.length : assets.filter((asset) => asset.config.type === type).length;
      return <button key={type} type="button" role="tab" aria-selected={activeType === type} className={activeType === type ? "on" : ""} onClick={() => onChange(type)}>{type === "all" ? "全部" : chartTypeName[type]}<span>{count}</span></button>;
    })}
  </div>;
}

function reorderItems<T>(items: T[], fromIndex: number, toIndex: number) {
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex || fromIndex >= items.length || toIndex >= items.length) return items;
  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

function insertItemAt<T>(items: T[], item: T, index = 0) {
  const next = [...items];
  const target = Math.max(0, Math.min(index, next.length));
  next.splice(target, 0, item);
  return next;
}

function moveItemToIndex<T>(items: T[], fromIndex: number, toIndex: number) {
  if (fromIndex < 0 || toIndex < 0 || fromIndex >= items.length) return items;
  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  const target = fromIndex < toIndex ? toIndex - 1 : toIndex;
  next.splice(Math.max(0, Math.min(target, next.length)), 0, moved);
  return next;
}

function TemplateCenter({ templates, surfaces, activeId, onChange }: { templates: DashboardTemplate[]; surfaces: SystemSurfaceTemplate[]; activeId: string; onChange: (id: string) => void }) {
  const systemTemplates = templates.filter((template) => builtInTemplateIds.has(template.id));
  const customTemplates = templates.filter((template) => !builtInTemplateIds.has(template.id));
  const activeTemplate = templates.find((template) => template.id === activeId);
  const activeSurface = surfaces.find((surface) => surface.id === activeId);
  const groups: MenuSelectGroup[] = [
    { label: "系统模板", options: [...systemTemplates.map((template) => ({ value: template.id, label: template.name, meta: `${template.cards.length} 张卡片` })), ...surfaces.map((surface) => ({ value: surface.id, label: surface.name, meta: "专用接口" }))] },
    { label: "我的模板", options: customTemplates.map((template) => ({ value: template.id, label: template.name, meta: `${template.cards.length} 张卡片` })) }
  ];
  return <div className="dashboard-switcher">
    <MenuSelect label="当前模板" value={activeId} groups={groups} onChange={onChange} />
    <span>{activeSurface ? "系统模板 · 专用接口" : `${builtInTemplateIds.has(activeTemplate?.id ?? "") ? "系统模板" : "我的模板"} · ${activeTemplate?.cards.length ?? 0} 张卡片`}</span>
  </div>;
}

function WorkspaceNav({ active }: { active: Workspace }) {
  const groups: Array<[string, Array<[Workspace, string, string]>]> = [
    ["工作空间", [["templates", "看板中心", "查看和下钻业务数据"], ["cardFactory", "分析中心", "创建和管理分析卡片"], ["templateFactory", "模板管理", "组装与发布看板"], ["dictionary", "数据字典", "查询指标与数据口径"], ["dataSources", "数据源维护", "维护站1与站2 Token"]]]
  ];
  return <aside className="workspace-nav">
    <div className="nav-brand"><b>多平台 BI</b><span>分析工作台</span></div>
    {groups.map(([groupName, items]) => <div className="nav-group" key={groupName}>
      <div className="nav-group-title">{groupName}<em>{items.length}</em></div>
      {items.map(([id, title, desc]) => <a key={id} href={`/?workspace=${id === "cardFactory" ? "cards" : id}`} target="_blank" rel="noopener noreferrer" className={active === id || (id === "cardFactory" && active === "cards") ? "active" : ""}>
        <b>{title}</b>
        <span>{desc}</span>
      </a>)}
    </div>)}
  </aside>;
}

function GlobalFilterBar({ filters, onChange }: { filters: DashboardFilters; onChange: (filters: DashboardFilters) => void }) {
  const [openPanel, setOpenPanel] = useState<"mobile" | "platform" | "date" | null>(null);
  const filterDialogRef = useRef<HTMLElement | null>(null);
  const activeFilterAnchor = useRef<HTMLElement | null>(null);
  const previousFilterFocus = useRef<HTMLElement | null>(null);
  const [filterPanelStyle, setFilterPanelStyle] = useState<React.CSSProperties>({});
  const [modeDraft, setModeDraft] = useState<PlatformMode>(filters.mode);
  const [platformDraft, setPlatformDraft] = useState(filters.platforms);
  const [platformSearch, setPlatformSearch] = useState("");
  const [dateRangeDraft, setDateRangeDraft] = useState<DateRange>(filters.dateRange);
  const [dateDraft, setDateDraft] = useState<[string, string]>(() => resolveDashboardDateRange(filters));
  const [comparisonDraft, setComparisonDraft] = useState<[string, string]>(() => resolveComparisonDateRange(filters));
  const [comparisonModeDraft, setComparisonModeDraft] = useState<ComparisonMode>(filters.comparisonMode ?? "equalLength");
  useBodyScrollLock(Boolean(openPanel));
  useEffect(() => {
    if (!openPanel || openPanel === "mobile") {
      setFilterPanelStyle({});
      return undefined;
    }
    const positionPanel = () => {
      if (window.innerWidth < 768) {
        setFilterPanelStyle({});
        return;
      }
      const anchor = activeFilterAnchor.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const panelWidth = Math.min(openPanel === "date" ? 720 : 560, window.innerWidth - 32);
      const left = Math.min(Math.max(16, rect.right - panelWidth), window.innerWidth - panelWidth - 16);
      const top = Math.min(rect.bottom + 8, window.innerHeight - 120);
      setFilterPanelStyle({ left, top, width: panelWidth, maxHeight: `calc(100dvh - ${top + 16}px)` });
    };
    positionPanel();
    window.addEventListener("resize", positionPanel);
    window.addEventListener("scroll", positionPanel, true);
    return () => {
      window.removeEventListener("resize", positionPanel);
      window.removeEventListener("scroll", positionPanel, true);
    };
  }, [openPanel]);
  useEffect(() => {
    if (!openPanel) return undefined;
    const dialog = filterDialogRef.current;
    const focusables = () => [...(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex="-1"])') ?? [])].filter((element) => element.getClientRects().length > 0);
    window.requestAnimationFrame(() => dialog?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpenPanel(null);
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (!items.length) return;
      const first = items[0];
      const last = items.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFilterFocus.current?.focus();
    };
  }, [openPanel]);
  const today = useMemo(() => {
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }, []);
  const scope = filters.mode === "all" ? `全部 ${platforms.length} 个平台` : filters.platforms.join("、");
  const comparisonScope = resolveComparisonDateRange(filters);
  const dateScope = `${filters.dateRange === "自定义" && filters.customStart && filters.customEnd ? `${filters.customStart} 至 ${filters.customEnd}` : filters.dateRange} · 对比 ${comparisonScope[0]} 至 ${comparisonScope[1]}`;
  const rememberFilterTrigger = () => {
    if (!openPanel && document.activeElement instanceof HTMLElement) previousFilterFocus.current = document.activeElement;
  };
  const openMobilePanel = (anchor?: HTMLElement) => {
    rememberFilterTrigger();
    activeFilterAnchor.current = anchor ?? null;
    setOpenPanel("mobile");
  };
  const openPlatformPanel = (anchor?: HTMLElement) => {
    rememberFilterTrigger();
    activeFilterAnchor.current = anchor ?? previousFilterFocus.current;
    setModeDraft(filters.mode);
    setPlatformDraft(filters.platforms.length ? filters.platforms : ["Pornhub"]);
    setPlatformSearch("");
    setOpenPanel("platform");
  };
  const changeModeDraft = (mode: PlatformMode) => {
    setModeDraft(mode);
    if (mode === "single") setPlatformDraft((current) => [current[0] ?? "Pornhub"]);
    if (mode === "compare") setPlatformDraft((current) => current.length >= 2 ? current.slice(0, 8) : [current[0] ?? "Pornhub", current[0] === "TikTok" ? "小红书" : "TikTok"]);
  };
  const togglePlatformDraft = (platform: string) => {
    if (modeDraft === "single") {
      setPlatformDraft([platform]);
      return;
    }
    setPlatformDraft((current) => current.includes(platform) ? current.filter((item) => item !== platform) : current.length < 8 ? [...current, platform] : current);
  };
  const platformSelectionValid = modeDraft === "all" || (modeDraft === "single" && platformDraft.length === 1) || (modeDraft === "compare" && platformDraft.length >= 2 && platformDraft.length <= 8);
  const applyPlatformSelection = () => {
    if (!platformSelectionValid) return;
    onChange({ ...filters, mode: modeDraft, platforms: modeDraft === "all" ? filters.platforms : platformDraft });
    setOpenPanel(null);
  };
  const openDatePanel = (anchor?: HTMLElement) => {
    rememberFilterTrigger();
    activeFilterAnchor.current = anchor ?? previousFilterFocus.current;
    setDateRangeDraft(filters.dateRange);
    setDateDraft(resolveDashboardDateRange(filters));
    setComparisonDraft(resolveComparisonDateRange(filters));
    setComparisonModeDraft(filters.comparisonMode ?? "equalLength");
    setOpenPanel("date");
  };
  const applyPresetDraft = (dateRange: Exclude<DateRange, "自定义">) => {
    const current = resolveDashboardDateRange({ ...filters, dateRange, customStart: undefined, customEnd: undefined });
    setDateRangeDraft(dateRange);
    setDateDraft(current);
    updateComparisonMode(comparisonModeDraft, current);
  };
  const customDateValid = Boolean(dateDraft[0] && dateDraft[1] && dateDraft[0] <= dateDraft[1]);
  const periodDays = ([start, end]: [string, string]) => start && end && start <= end ? Math.round((new Date(`${end}T00:00:00`).getTime() - new Date(`${start}T00:00:00`).getTime()) / 86400000) + 1 : 0;
  const comparisonDateValid = Boolean(comparisonDraft[0] && comparisonDraft[1] && comparisonDraft[0] <= comparisonDraft[1] && (comparisonModeDraft !== "equalLength" || periodDays(dateDraft) === periodDays(comparisonDraft)));
  const updateComparisonMode = (mode: ComparisonMode, current = dateDraft) => {
    setComparisonModeDraft(mode);
    setComparisonDraft(resolveComparisonDateRange({ ...filters, dateRange: "自定义", customStart: current[0], customEnd: current[1], compareStart: undefined, compareEnd: undefined, comparisonMode: mode }));
  };
  const updateDateDraft = (range: [string, string]) => {
    setDateRangeDraft("自定义");
    setDateDraft(range);
    if (range[0] && range[1] && range[0] <= range[1]) updateComparisonMode(comparisonModeDraft, range);
  };
  const applyDateSelection = () => {
    if (!customDateValid || !comparisonDateValid) return;
    onChange({
      ...filters,
      dateRange: dateRangeDraft,
      customStart: dateRangeDraft === "自定义" ? dateDraft[0] : undefined,
      customEnd: dateRangeDraft === "自定义" ? dateDraft[1] : undefined,
      compareStart: comparisonDraft[0],
      compareEnd: comparisonDraft[1],
      comparisonMode: comparisonModeDraft
    });
    setOpenPanel(null);
  };
  const visiblePlatforms = platforms.filter((item) => !platformSearch.trim() || item.platform.toLowerCase().includes(platformSearch.trim().toLowerCase()) || platformPid[item.platform]?.toLowerCase().includes(platformSearch.trim().toLowerCase()));
  return <>
    <div className="global-filter-bar">
      <div className="global-filter-inner">
        <div className="global-filter-context"><SlidersHorizontal aria-hidden="true" /><span><b>全局筛选</b><small>作用于当前看板</small></span></div>
        <button className="mobile-filter-trigger" onClick={(event) => openMobilePanel(event.currentTarget)}><SlidersHorizontal aria-hidden="true" /><span><b>筛选</b><small>{scope} · {filters.dateRange}</small></span><i>查看</i></button>
        <button className="filter-trigger platform-trigger" aria-expanded={openPanel === "platform"} onClick={(event) => openPlatformPanel(event.currentTarget)}><Layers3 aria-hidden="true" /><span><small>平台范围</small><b>{scope}</b></span><ChevronDown aria-hidden="true" /></button>
        <button className="filter-trigger date-trigger" aria-expanded={openPanel === "date"} onClick={(event) => openDatePanel(event.currentTarget)}><CalendarRange aria-hidden="true" /><span><small>分析周期</small><b>{dateScope}</b></span><ChevronDown aria-hidden="true" /></button>
        <button className="save-view-btn" onClick={() => { localStorage.setItem("bi-global-filters", JSON.stringify(filters)); notify("全局分析范围已保存"); }}><Save aria-hidden="true" />保存当前筛选</button>
      </div>
    </div>
    {openPanel && <div className="filter-modal" role="presentation" onMouseDown={() => setOpenPanel(null)}>
      <section ref={filterDialogRef} tabIndex={-1} style={filterPanelStyle} className={`filter-popover ${openPanel}`} role="dialog" aria-modal="true" aria-label={openPanel === "platform" ? "选择平台范围" : openPanel === "date" ? "选择时间范围" : "查看当前筛选"} onMouseDown={(event) => event.stopPropagation()}>
        <div className="filter-popover-head"><div><b>{openPanel === "platform" ? "选择平台范围" : openPanel === "date" ? "选择时间范围" : "当前筛选"}</b><span>{openPanel === "platform" ? "选择后统一应用，避免重复加载" : openPanel === "date" ? "设置当前周期和对比周期，两段时间分别查询" : "分别修改平台和分析周期"}</span></div><button aria-label="关闭" onClick={() => setOpenPanel(null)}><X aria-hidden="true" /></button></div>
        {openPanel === "mobile" && <><div className="mobile-filter-menu"><button onClick={() => openPlatformPanel()}><Layers3 aria-hidden="true" /><span><small>平台范围</small><b>{scope}</b></span><i>修改</i></button><button onClick={() => openDatePanel()}><CalendarRange aria-hidden="true" /><span><small>分析周期</small><b>{dateScope}</b></span><i>修改</i></button></div><div className="filter-popover-actions"><button onClick={() => setOpenPanel(null)}>完成</button></div></>}
        {openPanel === "platform" && <>
          <div className="platform-mode-tabs"><button className={modeDraft === "all" ? "on" : ""} onClick={() => changeModeDraft("all")}><b>全部平台</b><span>汇总 20 个平台</span></button><button className={modeDraft === "single" ? "on" : ""} onClick={() => changeModeDraft("single")}><b>单个平台</b><span>查看一个平台</span></button><button className={modeDraft === "compare" ? "on" : ""} onClick={() => changeModeDraft("compare")}><b>平台对比</b><span>同时选择 2-8 个</span></button></div>
          {modeDraft !== "all" && <><div className="platform-picker-toolbar"><input value={platformSearch} onChange={(event) => setPlatformSearch(event.target.value)} placeholder="搜索平台名称或 PID" /><span>已选 {platformDraft.length}{modeDraft === "compare" ? "/8" : ""}</span></div><div className="platform-option-grid">{visiblePlatforms.map((item) => <button aria-pressed={platformDraft.includes(item.platform)} className={platformDraft.includes(item.platform) ? "on" : ""} key={item.platform} onClick={() => togglePlatformDraft(item.platform)}><i style={{ background: PLATFORM_COLORS[item.platform] }} /><span><b>{item.platform}</b><small>{platformPid[item.platform]}</small></span><em>{platformDraft.includes(item.platform) ? "已选" : ""}</em></button>)}</div></>}
          {modeDraft === "all" && <div className="all-platform-summary"><b>全部 20 个平台</b><span>数据按平台汇总，图表仍可查看平台排行和差异。</span></div>}
          <div className="filter-popover-actions"><button onClick={() => setOpenPanel(null)}>取消</button><button className="primary-btn" disabled={!platformSelectionValid} onClick={applyPlatformSelection}>应用范围</button></div>
        </>}
        {openPanel === "date" && <>
          <div className="date-filter-body">
            <section className="date-filter-section" aria-labelledby="current-period-label">
              <header><span>分析周期</span><div><b id="current-period-label">选择看板统计时间</b><small>可使用快捷范围，也可以直接调整起止日期</small></div></header>
              <div className="date-preset-grid">{(["今日", "近7日", "近30日"] as const).map((range) => <button aria-pressed={dateRangeDraft === range} className={dateRangeDraft === range ? "on" : ""} key={range} onClick={() => applyPresetDraft(range)}><b>{range}</b><span>{range === "今日" ? "只看当天" : range === "近7日" ? "连续 7 天" : "连续 30 天"}</span></button>)}</div>
              <div className="custom-date-panel current"><div><b>当前周期</b><span>{dateRangeDraft === "自定义" ? "自定义日期" : dateRangeDraft} · 共 {periodDays(dateDraft)} 天</span></div><div className="custom-date-inputs"><label><span>开始日期</span><input aria-label="当前周期开始日期" type="date" max={today} value={dateDraft[0]} onChange={(event) => updateDateDraft([event.target.value, dateDraft[1]])} /></label><i>至</i><label><span>结束日期</span><input aria-label="当前周期结束日期" type="date" min={dateDraft[0]} max={today} value={dateDraft[1]} onChange={(event) => updateDateDraft([dateDraft[0], event.target.value])} /></label></div>{!customDateValid && <em>开始日期不能晚于结束日期</em>}</div>
            </section>
            <section className="date-filter-section comparison-section" aria-labelledby="comparison-period-label">
              <header><span>对比周期</span><div><b id="comparison-period-label">选择对比生成方式</b><small>系统自动生成日期，避免两个周期误配</small></div></header>
              <div className="comparison-mode-tabs"><button aria-pressed={comparisonModeDraft === "equalLength"} className={comparisonModeDraft === "equalLength" ? "on" : ""} onClick={() => updateComparisonMode("equalLength")}><b>等长周期</b><span>紧邻的相同天数</span></button><button aria-pressed={comparisonModeDraft === "sameProgress"} className={comparisonModeDraft === "sameProgress" ? "on" : ""} onClick={() => updateComparisonMode("sameProgress")}><b>同期进度</b><span>上月 1 日至相同日序</span></button><button aria-pressed={comparisonModeDraft === "calendarMonth"} className={comparisonModeDraft === "calendarMonth" ? "on" : ""} onClick={() => updateComparisonMode("calendarMonth")}><b>上月完整月</b><span>上一个完整自然月</span></button></div>
              <div className="custom-date-panel comparison"><div><b>对比周期</b><span>系统生成 · 共 {periodDays(comparisonDraft)} 天</span></div><div className="generated-comparison-range"><b>{comparisonDraft[0]}</b><i>至</i><b>{comparisonDraft[1]}</b></div><small>{comparisonModeDraft === "calendarMonth" ? "适合按完整自然月复盘；累计值按两个周期各自的实际天数展示。" : comparisonModeDraft === "sameProgress" ? "适合月中比较相同进度，避免完整月与未完整月混比。" : "适合收入、新增、次数等累计指标做严格等天数对比。"}</small>{!comparisonDateValid && <em>系统未能生成合法的对比周期</em>}</div>
            </section>
          </div>
          <div className="filter-popover-actions"><span>应用后，当前看板内所有卡片统一刷新</span><button onClick={() => setOpenPanel(null)}>取消</button><button className="primary-btn" disabled={!customDateValid || !comparisonDateValid} onClick={applyDateSelection}>应用筛选</button></div>
        </>}
      </section>
    </div>}
  </>;
}

interface QueryStatusEvent { phase: "start" | "success" | "error" | "cancel"; cardId: string; title: string; duration?: number; message?: string; at?: string }

function QueryHealth() {
  const [events, setEvents] = useState<QueryStatusEvent[]>([]);
  useEffect(() => {
    const handler = (event: Event) => setEvents((current) => [(event as CustomEvent<QueryStatusEvent>).detail, ...current].slice(0, 30));
    window.addEventListener("bi-query-status", handler);
    return () => window.removeEventListener("bi-query-status", handler);
  }, []);
  const currentByCard = events.reduce<QueryStatusEvent[]>((current, item) => current.some((entry) => entry.cardId === item.cardId) ? current : [...current, item], []);
  const active = currentByCard.filter((item) => item.phase === "start").length;
  const errors = currentByCard.filter((item) => item.phase === "error").length;
  const latestSuccess = events.find((item) => item.phase === "success");
  return <details className="query-health"><summary><span className={`status-dot ${errors ? "warning" : ""}`} />{active ? `${active} 项加载中` : errors ? `${errors} 项异常` : "数据连接正常"}</summary><div className="query-health-popover"><b>查询状态</b><span>{latestSuccess?.at ? `最近成功 ${new Date(latestSuccess.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}` : "等待首次查询"}</span>{currentByCard.filter((item) => item.phase !== "cancel").slice(0, 6).map((item, index) => <div key={`${item.cardId}-${index}`}><em>{item.phase === "start" ? "加载" : item.phase === "success" ? "成功" : "失败"}</em><span>{item.title}</span><small>{item.duration ? `${item.duration}ms` : item.message ?? ""}</small></div>)}</div></details>;
}

function CardLibrary({ assets, onCreate, onEdit, onDuplicate, onDelete }: { assets: CardAsset[]; onCreate: () => void; onEdit: (asset: CardAsset) => void; onDuplicate: (asset: CardAsset) => void; onDelete: (id: string) => void }) {
  const [activeType, setActiveType] = useState<ChartType | "all">("all");
  const [search, setSearch] = useState("");
  const [activeModel, setActiveModel] = useState<AnalysisModelId | "all">("all");
  const visibleAssets = filterAssetsByType(assets, activeType).filter((asset) => {
    const matchesModel = activeModel === "all" || asset.config.model === activeModel;
    const keyword = search.trim().toLowerCase();
    const matchesSearch = !keyword || `${asset.name} ${asset.description} ${modelName[asset.config.model]} ${asset.config.metrics.map((metric) => metricName[metric]).join(" ")}`.toLowerCase().includes(keyword);
    return matchesModel && matchesSearch;
  });
  const groupedAssets = chartTypes
    .map((type) => ({ type, assets: visibleAssets.filter((asset) => asset.config.type === type) }))
    .filter((group) => group.assets.length > 0);
  return <section className="asset-page">
    <div className="dashboard-head"><div><h1>分析中心</h1><p>管理已有分析卡片，或创建新的指标、趋势、排行和漏斗分析。</p></div><div className="dashboard-actions"><div className="model-pill">{assets.length} 张卡片</div><button className="blue-action" onClick={onCreate}>创建分析</button></div></div>
    <div className="asset-filter-toolbar"><div className="asset-search"><span>搜索</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索卡片、指标或模型" /></div><MenuSelect label="分析模型" ariaLabel="分析模型筛选" align="end" value={activeModel} onChange={(value) => setActiveModel(value as AnalysisModelId | "all")} groups={[{ label: "筛选范围", options: [{ value: "all", label: "全部模型", meta: `${assets.length} 张卡片` }, ...analysisModels.map((model) => ({ value: model.id, label: model.name, meta: model.description }))] }]} /></div>
    <AssetTypeFilters activeType={activeType} assets={assets} onChange={setActiveType} />
    {!visibleAssets.length && <div className="library-empty"><b>没有匹配的分析卡片</b><span>调整筛选条件，或新建一张卡片。</span><button onClick={onCreate}>新建卡片</button></div>}
    {groupedAssets.map((group, index) => <details className="asset-type-section" key={`${group.type}-${activeType}-${activeModel}-${search}`} open={activeType !== "all" || activeModel !== "all" || Boolean(search) || index === 0}>
      <summary className="asset-type-title"><b>{chartTypeName[group.type]}</b><span>{group.assets.length} 张</span></summary>
      <div className="asset-grid">{group.assets.map((asset) => <div className="asset-card" key={asset.id}>
        <div className="asset-card-head"><b>{asset.name}</b><span>{chartDataLevel(asset.config.type)} · {chartTypeName[asset.config.type]}</span></div>
        <p>{asset.description}</p>
        <CardAssetPreview card={asset.config} />
        <div className="chips"><span>{modelName[asset.config.model]}</span>{asset.config.metrics.slice(0, 3).map((metric) => <span key={metric}>{metricName[metric]}</span>)}</div>
        <div className="asset-meta"><span>配置更新于 {asset.updatedAt}</span><span>已用于 {1 + asset.name.length % 4} 个模板</span></div>
        <div className="asset-actions"><button className="asset-primary-action" onClick={() => onEdit(asset)}><Pencil aria-hidden="true" />编辑</button><button onClick={() => onDuplicate(asset)}><Copy aria-hidden="true" />复制</button><button className="danger-action" onClick={() => onDelete(asset.id)}><Trash2 aria-hidden="true" />删除</button></div>
      </div>)}</div>
    </details>)}
  </section>;
}

function TemplateFactory({ templates, assets, activeTemplateId, filters, onTemplateChange, onTemplatesChange, onCreateCard, onDrill, onExit }: { templates: DashboardTemplate[]; assets: CardAsset[]; activeTemplateId: string; filters: DashboardFilters; onTemplateChange: (id: string) => void; onTemplatesChange: (templates: DashboardTemplate[]) => void; onCreateCard: () => void; onDrill: (payload: DrilldownPayload) => void; onExit: () => void }) {
  const [draggingCardId, setDraggingCardId] = useState<string | null>(null);
  const [draggingAssetId, setDraggingAssetId] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [insertIndex, setInsertIndex] = useState<number | null>(null);
  const [editingCardId, setEditingCardId] = useState<string | null>(null);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [activeAssetType, setActiveAssetType] = useState<ChartType | "all">("all");
  const [previewAssetId, setPreviewAssetId] = useState<string | null>(null);
  const [assetDrawerOpen, setAssetDrawerOpen] = useState(false);
  const [templateDirty, setTemplateDirty] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [draftTemplate, setDraftTemplate] = useState<DashboardTemplate>(() => structuredClone(templates.find((item) => item.id === activeTemplateId) ?? templates[0]));
  useEffect(() => {
    const source = templates.find((item) => item.id === activeTemplateId) ?? templates[0];
    setDraftTemplate(structuredClone(source));
    setTemplateDirty(false);
    setIsPreviewing(false);
    setEditingCardId(null);
  }, [activeTemplateId]);
  const template = draftTemplate;
  const editingCard = template.cards.find((card) => card.id === editingCardId) ?? null;
  useBodyScrollLock(assetDrawerOpen || Boolean(editingCard));
  const visibleAssets = filterAssetsByType(assets, activeAssetType);
  const previewAsset = visibleAssets.find((asset) => asset.id === previewAssetId) ?? visibleAssets[0] ?? null;
  const filterDimensions = template.cards.length
    ? getApiCapability(template.cards[0].model).allowedDimensions.filter((dimension) => template.cards.every((card) => getApiCapability(card.model).allowedDimensions.includes(dimension)))
    : getApiCapability(template.model).allowedDimensions;
  const updateTemplate = (next: DashboardTemplate) => {
    setDraftTemplate(next);
    setTemplateDirty(true);
  };
  const commitTemplate = (next: DashboardTemplate = template, message = "模板已保存") => {
    const saved = { ...next, updatedAt: new Date().toISOString() };
    onTemplatesChange(templates.map((item) => item.id === saved.id ? saved : item));
    setDraftTemplate(saved);
    setTemplateDirty(false);
    notify(message);
  };
  const addAssetToTemplate = (asset: CardAsset, index = 0) => {
    updateTemplate({ ...template, cards: insertItemAt(template.cards, { ...asset.config, id: `template-card-${Date.now()}` }, index) });
  };
  const updateCard = (cardId: string, patch: Partial<DashboardCardConfig>) => {
    updateTemplate({ ...template, cards: template.cards.map((card) => card.id === cardId ? { ...card, ...patch } : card) });
  };
  const resizeTemplateCard = (cardId: string, size: DashboardCardConfig["size"]) => {
    updateCard(cardId, { size });
  };
  const createTemplate = () => {
    const baseModel = analysisModels[0];
    const next: DashboardTemplate = {
      id: `custom-template-${Date.now()}`,
      name: "新建分析模板",
      scenario: "从卡片库拖入分析卡片，配置成一个可复用的看板模板。",
      model: baseModel.id,
      filters: baseModel.allowedDimensions.slice(0, 3),
      cards: [],
      status: "draft",
      updatedAt: new Date().toISOString()
    };
    onTemplatesChange([next, ...templates]);
    onTemplateChange(next.id);
  };
  const deleteTemplate = () => {
    if (templates.length <= 1) return;
    if (!window.confirm(`确认删除模板“${template.name}”？`)) return;
    const nextTemplates = templates.filter((item) => item.id !== template.id);
    onTemplatesChange(nextTemplates);
    onTemplateChange(nextTemplates[0].id);
    notify("模板已删除");
  };
  const publishTemplate = () => {
    if (!template.cards.length) {
      notify("请先添加至少一张卡片再发布");
      return;
    }
    const issues = template.cards.flatMap((card) => validateCardCapability(card).issues);
    if (issues.length) {
      notify(`模板包含超出 API 能力的卡片：${issues[0]}`);
      return;
    }
    commitTemplate({ ...template, status: "published" }, "模板已保存并发布，可在看板中心直接使用");
  };
  const cancelTemplateChanges = () => {
    const source = templates.find((item) => item.id === activeTemplateId) ?? templates[0];
    setDraftTemplate(structuredClone(source));
    setTemplateDirty(false);
    setIsPreviewing(false);
    notify("未保存的模板修改已取消");
  };
  const removeCard = (cardId: string) => {
    updateTemplate({ ...template, cards: template.cards.filter((card) => card.id !== cardId) });
  };
  const moveCard = (cardId: string, direction: -1 | 1) => {
    const index = template.cards.findIndex((card) => card.id === cardId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= template.cards.length) return;
    const cards = [...template.cards];
    [cards[index], cards[target]] = [cards[target], cards[index]];
    updateTemplate({ ...template, cards });
  };
  const handleCardDrop = (targetIndex: number, assetId: string | null) => {
    if (assetId) {
      handleAssetDrop(assetId, targetIndex);
      return;
    }
    if (!draggingCardId) return;
    const fromIndex = template.cards.findIndex((card) => card.id === draggingCardId);
    updateTemplate({ ...template, cards: moveItemToIndex(template.cards, fromIndex, targetIndex) });
    setDraggingCardId(null);
    setInsertIndex(null);
  };
  const handleAssetDrop = (assetId: string | null, index = 0) => {
    const asset = assets.find((item) => item.id === assetId);
    if (asset) addAssetToTemplate(asset, index);
    setDraggingAssetId(null);
    setDropActive(false);
    setInsertIndex(null);
  };
  const handleDropZoneDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const assetId = event.dataTransfer.getData("asset-id") || draggingAssetId;
    if (assetId) handleAssetDrop(assetId, insertIndex ?? 0);
    if (!assetId && draggingCardId) handleCardDrop(insertIndex ?? template.cards.length, null);
  };
  const updateInsertIndex = (event: React.DragEvent<HTMLDivElement>, index: number) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setInsertIndex(event.clientY > rect.top + rect.height / 2 ? index + 1 : index);
  };
  if (isPreviewing) return <section className="template-preview-workspace">
    <div className="template-preview-toolbar"><div><span>模板预览</span><b>{template.name}</b><em>{templateDirty ? "有未保存修改" : "已保存"}</em></div><div><button onClick={() => setIsPreviewing(false)}>返回编辑</button><button onClick={cancelTemplateChanges}>取消修改</button><button disabled={!templateDirty} onClick={() => commitTemplate()}>保存模板</button><button className="primary-btn" onClick={publishTemplate}>保存并发布</button></div></div>
    <div className="template-preview-canvas"><DashboardRenderer template={template} filters={filters} onDrill={onDrill} onSaveLayout={(cards) => commitTemplate({ ...template, cards }, "模板布局已保存")} /></div>
  </section>;
  return <section className="template-factory">
    <div className="dashboard-head template-factory-header"><div className="template-editor-heading"><button className="back-action" onClick={onExit}>返回</button><div><h1>模板管理</h1><p>编辑画布中的卡片布局，完成后保存或发布模板。</p></div></div><div className="dashboard-actions"><button onClick={() => setIsPreviewing(true)}>预览</button><button disabled={!templateDirty} onClick={cancelTemplateChanges}>取消修改</button><button disabled={!templateDirty} onClick={() => commitTemplate()}>保存</button><button className="primary-btn" onClick={publishTemplate}>保存并发布</button></div></div>
    <div className="factory-layout">
      <div className="factory-column">
        <div className="panel-title">选择模板</div>
        <button className="primary-btn add-card-btn" onClick={createTemplate}>新建模板</button>
        {templates.map((item) => <button className={item.id === template.id ? "template active" : "template"} key={item.id} onClick={() => onTemplateChange(item.id)}><b>{item.id === template.id ? template.name : item.name}</b><span>{item.id === template.id ? template.cards.length : item.cards.length} 张卡片</span></button>)}
        <button className="template-delete-action" onClick={deleteTemplate} disabled={templates.length <= 1}>删除当前模板</button>
      </div>
      <div className="factory-column wide">
        <div className="template-edit-panel">
          <div className="template-edit-top">
            <div><div className="panel-title">编辑模板</div><div className="template-status"><span className={template.status === "published" ? "is-published" : "is-draft"}><CheckCircle2 aria-hidden="true" />{template.status === "published" ? "已发布" : "草稿"}</span><span className={templateDirty ? "is-dirty" : "is-saved"}><Cloud aria-hidden="true" />{templateDirty ? "有未保存修改" : "已保存"}</span><em>{template.cards.length} 张卡片</em></div></div>
            <label><span>模板名称</span><input value={template.name} onChange={(event) => updateTemplate({ ...template, name: event.target.value })} /></label>
          </div>
          <div className="template-edit-bottom">
            <label><span>使用场景</span><input value={template.scenario} onChange={(event) => updateTemplate({ ...template, scenario: event.target.value })} /></label>
            <MenuSelect className="form-menu-select" label="主分析模型" value={template.model} onChange={(value) => {
              const nextModel = analysisModels.find((item) => item.id === value as AnalysisModelId) ?? analysisModels[0];
              updateTemplate({ ...template, model: nextModel.id, filters: nextModel.allowedDimensions.slice(0, 3) });
            }} groups={[{ label: "分析模型", options: analysisModels.map((item) => ({ value: item.id, label: item.name, meta: item.description })) }]} />
            <MenuSelect className="form-menu-select" label="公共筛选器" value={filterDimensions.includes(template.filters[0]) ? template.filters[0] : filterDimensions[0] ?? ""} disabled={!filterDimensions.length} onChange={(value) => updateTemplate({ ...template, filters: [value as DimensionId] })} groups={[{ label: "可用维度", options: filterDimensions.map((id) => ({ value: id, label: dimensionName[id] })) }]} />
          </div>
        </div>
        <div
          className={dropActive ? "template-drop-zone active" : "template-drop-zone"}
          onDragOver={(event) => {
            event.preventDefault();
            setDropActive(true);
          }}
          onDragLeave={() => setDropActive(false)}
          onDrop={handleDropZoneDrop}
        >
          <div className="drop-zone-head"><div><b>当前模板卡片</b><span>打开卡片库添加内容，卡片可拖动排序和调整宽度</span></div><div className="drop-zone-actions"><button onClick={() => setAssetDrawerOpen(true)}>添加卡片</button><em>{template.cards.length} 张</em></div></div>
          {insertIndex === 0 && <div className="insert-line"><span>插入到这里</span></div>}
          {template.cards.length === 0 && <div className="empty-preview">把卡片拖到这里生成模板内容</div>}
          {template.cards.map((card, index) => <React.Fragment key={card.id}><div
            className={`${draggingCardId === card.id ? "selected-card visual dragging" : "selected-card visual draggable-card"} ${selectedCardId === card.id ? "is-selected" : ""} ${card.size}`}
            data-resize-card="true"
            draggable
            onClick={() => setSelectedCardId(card.id)}
            onDragStart={(event) => {
              setDraggingCardId(card.id);
              event.dataTransfer.setData("card-id", card.id);
              event.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(event) => {
              event.preventDefault();
              event.stopPropagation();
              updateInsertIndex(event, index);
            }}
            onDrop={(event) => {
              event.preventDefault();
              event.stopPropagation();
              handleCardDrop(insertIndex ?? index, event.dataTransfer.getData("asset-id") || draggingAssetId);
            }}
            onDragEnd={() => {
              setDraggingCardId(null);
              setInsertIndex(null);
            }}
          ><div className="selected-card-head"><div><b>{index + 1}. {card.title}</b><span>{chartTypeName[card.type]} · {modelName[card.model]} · 示例数据结构预览</span></div><div><button onClick={() => setEditingCardId(card.id)}>编辑</button><button onClick={() => moveCard(card.id, -1)}>上移</button><button onClick={() => moveCard(card.id, 1)}>下移</button><button onClick={() => removeCard(card.id)}>移除</button></div></div><CardAssetPreview card={card} /><CardResizeHandle size={card.size} onResize={(size) => resizeTemplateCard(card.id, size)} /></div>{insertIndex === index + 1 && <div className="insert-line"><span>插入到这里</span></div>}</React.Fragment>)}
        </div>
      </div>
      {assetDrawerOpen && <aside className="factory-column asset-drawer"><div className="asset-drawer-head"><div><b>添加分析卡片</b><span>拖到画布指定位置，或直接添加到顶部</span></div><button aria-label="关闭卡片库" onClick={() => setAssetDrawerOpen(false)}><X aria-hidden="true" /></button></div><div className="asset-drawer-toolbar"><div className="panel-title asset-drawer-title"><span>卡片库</span><button onClick={onCreateCard}>新建卡片</button></div><AssetTypeFilters activeType={activeAssetType} assets={assets} onChange={setActiveAssetType} /></div><div className="drag-hint">拖动卡片到左侧画布，蓝色插入线表示放置位置</div>
      {previewAsset && <div className="asset-drawer-preview"><div><b>{previewAsset.name}</b><span>{chartTypeName[previewAsset.config.type]} · 示例预览</span></div><CardAssetPreview card={previewAsset.config} /></div>}
      <div className="asset-source-list">{visibleAssets.map((asset) => <div
        className={draggingAssetId === asset.id ? "asset-source-card dragging" : "asset-source-card"}
        key={asset.id}
        draggable
        onMouseEnter={() => setPreviewAssetId(asset.id)}
        onFocus={() => setPreviewAssetId(asset.id)}
        onDragStart={(event) => {
          setDraggingAssetId(asset.id);
          setPreviewAssetId(asset.id);
          event.dataTransfer.setData("asset-id", asset.id);
          event.dataTransfer.effectAllowed = "copy";
        }}
        onDragEnd={() => {
          setDraggingAssetId(null);
          setDropActive(false);
        }}
      >
        <div className="asset-source-top"><b>{asset.name}</b><em>{chartTypeName[asset.config.type]}</em></div>
        <p>{modelName[asset.config.model]} · 拖入模板</p>
        <div className="asset-source-metrics">{asset.config.metrics.slice(0, 2).map((metric) => <span key={metric}>{metricName[metric]}</span>)}</div>
        <button onClick={() => addAssetToTemplate(asset, 0)}>添加到顶部</button>
      </div>)}</div></aside>}
    </div>
    {editingCard && <CardEditDrawer card={editingCard} onClose={() => setEditingCardId(null)} onChange={(patch) => updateCard(editingCard.id, patch)} />}
  </section>;
}

function CardEditDrawer({ card, onChange, onClose }: { card: DashboardCardConfig; onChange: (patch: Partial<DashboardCardConfig>) => void; onClose: () => void }) {
  const model = analysisModels.find((item) => item.id === card.model) ?? analysisModels[0];
  const capability = getApiCapability(model.id);
  const toggleMetric = (metric: MetricId) => {
    const metrics = card.metrics.includes(metric) ? card.metrics.filter((item) => item !== metric) : [...card.metrics, metric];
    onChange({ metrics: metrics.length ? metrics : [metric] });
  };
  const toggleDimension = (dimension: DimensionId) => {
    const dimensions = card.dimensions.includes(dimension) ? card.dimensions.filter((item) => item !== dimension) : [...card.dimensions, dimension];
    onChange({ dimensions: dimensions.length ? dimensions : [dimension] });
  };
  const updateStep = (eventId: string, index = 0) => {
    onChange({ funnelSteps: insertItemAt(card.funnelSteps ?? [], eventId, index) });
  };
  const removeStep = (index: number) => {
    onChange({ funnelSteps: (card.funnelSteps ?? []).filter((_, itemIndex) => itemIndex !== index) });
  };
  const platformMode = card.platformMode ?? "global";
  const selectedPlatforms = card.platforms ?? [];
  const platformLimit = card.model === "usage_depth" ? 4 : 8;
  const toggleCardPlatform = (name: string) => {
    if (platformMode === "single") return onChange({ platforms: [name] });
    const next = selectedPlatforms.includes(name) ? selectedPlatforms.filter((item) => item !== name) : selectedPlatforms.length < platformLimit ? [...selectedPlatforms, name] : selectedPlatforms;
    if (platformMode !== "compare" || next.length >= 2) onChange({ platforms: next });
  };
  return <aside className="card-edit-drawer">
    <div className="drawer-head"><div><b>编辑分析卡片</b><span>{card.title}</span></div><button aria-label="关闭卡片编辑" onClick={onClose}><X aria-hidden="true" /></button></div>
    <div className="drawer-body">
      <div className="config-block"><b>基础信息</b><input value={card.title} onChange={(event) => onChange({ title: event.target.value })} /></div>
      <div className="editor-grid">
        <MenuSelect className="form-menu-select" label="图表类型" value={card.type} onChange={(value) => onChange({ type: value as ChartType })} groups={[{ label: "可用图表", options: capability.allowedCharts.map((type) => ({ value: type, label: chartTypeName[type] })) }]} />
        <MenuSelect className="form-menu-select" label="卡片尺寸" value={card.size} onChange={(value) => onChange({ size: value as DashboardCardConfig["size"] })} groups={[{ label: "布局宽度", options: cardSizes.map((size) => ({ value: size, label: sizeName[size] })) }]} />
        <MenuSelect className="form-menu-select" label="分析模型" value={card.model} onChange={(value) => {
          const nextModel = analysisModels.find((item) => item.id === value as AnalysisModelId) ?? analysisModels[0];
          const nextCapability = getApiCapability(nextModel.id);
          onChange({ model: nextModel.id, type: nextCapability.allowedCharts[0], metrics: nextCapability.allowedMetrics.slice(0, 2), dimensions: nextCapability.allowedDimensions.slice(0, 2), drillPath: nextModel.defaultDrillPath, funnelSteps: nextCapability.funnelEvents, sourceApi: nextCapability.apiPaths[0] });
        }} groups={[{ label: "分析模型", options: analysisModels.map((item) => ({ value: item.id, label: item.name, meta: item.description })) }]} />
        <MenuSelect className="form-menu-select" label="数据粒度" value={capability.dataGrain} disabled onChange={() => undefined} groups={[{ label: "只读", options: [{ value: capability.dataGrain, label: capability.dataGrain }] }]} />
      </div>
      <div className="config-block card-platform-config"><b>平台范围</b><span>默认跟随顶部看板，也可为该卡片保存独立范围。{card.model === "usage_depth" ? "24小时曲线最多对比4个平台。" : ""}</span><div className="platform-mode-tabs compact"><button className={platformMode === "global" ? "on" : ""} onClick={() => onChange({ platformMode: "global" })}>跟随看板</button><button className={platformMode === "all" ? "on" : ""} onClick={() => onChange({ platformMode: "all" })}>全部平台</button><button className={platformMode === "single" ? "on" : ""} onClick={() => onChange({ platformMode: "single", platforms: [selectedPlatforms[0] ?? "Pornhub"] })}>单平台</button><button className={platformMode === "compare" ? "on" : ""} onClick={() => onChange({ platformMode: "compare", platforms: selectedPlatforms.length >= 2 ? selectedPlatforms : ["Pornhub", "TikTok"] })}>多平台对比</button></div>{(platformMode === "single" || platformMode === "compare") && <div className="chips editable platform-config-chips">{Object.keys(platformPid).map((name) => <button className={selectedPlatforms.includes(name) ? "on" : ""} key={name} onClick={() => toggleCardPlatform(name)}>{name}</button>)}</div>}</div>
      <div className="config-label">指标</div>
      <MetricPicker metrics={capability.allowedMetrics} selected={card.metrics} onToggle={toggleMetric} />
      <div className="config-label">维度</div>
      <div className="chips editable">{capability.allowedDimensions.map((dimension) => <ConfigFieldChoice label={dimensionName[dimension]} selected={card.dimensions.includes(dimension)} key={dimension} onClick={() => toggleDimension(dimension)} />)}</div>
      <div className="config-label">下钻路径</div>
      <div className="event-chain">{(card.drillPath ?? card.dimensions).map((dimension) => <span key={dimension}>{dimensionName[dimension]}</span>)}</div>
      {(card.type === "funnel" || card.type === "sankey") && <div className="funnel-config">
        <div className="config-label">漏斗步骤</div>
        <div className="funnel-steps">{(card.funnelSteps ?? []).map((eventId, index) => {
          const event = eventDictionary.find((item) => item.id === eventId);
          return <div className="funnel-step" key={`${eventId}-${index}`}><span>{index + 1}</span><b>{event?.name ?? eventId}</b><code>{event?.domain ?? "事件"}</code><button onClick={() => removeStep(index)}>删</button></div>;
        })}</div>
        <div className="config-label">添加接口字段</div>
        <div className="chips editable">{eventDictionary.filter((event) => capability.funnelEvents.includes(event.id)).map((event) => <button key={event.id} onClick={() => updateStep(event.id, 0)}>{event.name}</button>)}</div>
      </div>}
      <div className="config-block"><b>接口来源</b><div className="summary-api-list">{capability.apiPaths.map((path) => <code key={path}>{path}</code>)}</div></div>
      <div className="config-label">示例数据结构预览</div>
      <div className="edit-preview"><CardAssetPreview card={card} /></div>
    </div>
  </aside>;
}

function createCardDraft(modelId: AnalysisModelId): DashboardTemplate {
  const model = analysisModels.find((item) => item.id === modelId) ?? analysisModels[0];
  const capability = getApiCapability(model.id);
  const isFunnel = capability.funnelEvents.length > 0;
  const primaryType = isFunnel ? "funnel" : capability.allowedCharts[0];
  const primaryCard: DashboardCardConfig = {
    id: `draft-card-${Date.now()}`,
    title: isFunnel ? `${model.name}漏斗` : `${model.name}趋势`,
    type: primaryType,
    model: model.id,
    metrics: capability.allowedMetrics.slice(0, 3),
    dimensions: capability.allowedDimensions.slice(0, 2),
    size: "lg",
    funnelSteps: capability.funnelEvents,
    conversionWindow: "接口日期范围",
    drillPath: model.defaultDrillPath,
    sourceApi: capability.apiPaths[0]
  };
  return {
    id: `template-${Date.now()}`,
    name: `${model.name}分析卡片`,
    scenario: `基于${model.name}创建，保存后会加入当前看板。`,
    model: model.id,
    filters: capability.allowedDimensions.slice(0, 3),
    cards: [
      primaryCard,
      { id: `draft-table-${Date.now()}`, title: "接口字段统计表", type: "table", model: model.id, metrics: capability.allowedMetrics.slice(0, 4), dimensions: capability.allowedDimensions.slice(0, 3), size: "full", drillPath: model.defaultDrillPath, sourceApi: capability.apiPaths[0] }
    ]
  };
}

function AnalysisTypeCenter({ activeId, onChange }: { activeId: AnalysisModelId; onChange: (id: AnalysisModelId) => void }) {
  const activeModel = analysisModels.find((model) => model.id === activeId) ?? analysisModels[0];
  return <section className="analysis-model-strip">
    <div className="analysis-model-strip-head"><b>分析模型</b><span>{activeModel.description}</span></div>
    <div className="analysis-model-tabs" role="tablist" aria-label="分析模型">
      {analysisModels.map((model) => {
        const capability = getApiCapability(model.id);
        return <button role="tab" aria-selected={model.id === activeId} className={model.id === activeId ? "active" : ""} key={model.id} onClick={() => onChange(model.id)}>
          <b>{model.name}</b><span><i className={`model-status-dot ${capability.status}`} />{capability.statusLabel}</span>
        </button>;
      })}
    </div>
  </section>;
}

function ConfigPanel({ template, onTemplateChange, variant = "side" }: { template: DashboardTemplate; onTemplateChange: (template: DashboardTemplate) => void; variant?: "side" | "workspace" }) {
  const model = analysisModels.find((item) => item.id === template.model);
  const modelCapability = getApiCapability((model ?? analysisModels[0]).id);
  const updateCard = (cardId: string, patch: Partial<DashboardCardConfig>) => {
    onTemplateChange({ ...template, cards: template.cards.map((card) => card.id === cardId ? { ...card, ...patch } : card) });
  };
  const removeCard = (cardId: string) => {
    onTemplateChange({ ...template, cards: template.cards.filter((card) => card.id !== cardId) });
  };
  const moveCard = (cardId: string, direction: -1 | 1) => {
    const index = template.cards.findIndex((card) => card.id === cardId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= template.cards.length) return;
    const cards = [...template.cards];
    [cards[index], cards[target]] = [cards[target], cards[index]];
    onTemplateChange({ ...template, cards });
  };
  const addCard = () => {
    const nextModel = model ?? analysisModels[0];
    const card: DashboardCardConfig = {
      id: `card-${Date.now()}`,
      title: "新分析卡片",
      type: "bar",
      model: nextModel.id,
      metrics: [nextModel.allowedMetrics[0]],
      dimensions: [nextModel.allowedDimensions[0]],
      size: "md",
      funnelSteps: nextModel.eventChain,
      conversionWindow: "当日",
      drillPath: nextModel.defaultDrillPath
    };
    onTemplateChange({ ...template, cards: [card, ...template.cards] });
  };
  const toggleMetric = (card: DashboardCardConfig, metric: MetricId) => {
    const exists = card.metrics.includes(metric);
    const metrics = exists ? card.metrics.filter((item) => item !== metric) : [...card.metrics, metric];
    updateCard(card.id, { metrics: metrics.length ? metrics : [metric] });
  };
  const toggleDimension = (card: DashboardCardConfig, dimension: DimensionId) => {
    const exists = card.dimensions.includes(dimension);
    const dimensions = exists ? card.dimensions.filter((item) => item !== dimension) : [...card.dimensions, dimension];
    updateCard(card.id, { dimensions: dimensions.length ? dimensions : [dimension] });
  };
  const addFunnelStep = (card: DashboardCardConfig, eventId: string) => {
    updateCard(card.id, { funnelSteps: [eventId, ...(card.funnelSteps ?? [])] });
  };
  const removeFunnelStep = (card: DashboardCardConfig, index: number) => {
    updateCard(card.id, { funnelSteps: (card.funnelSteps ?? []).filter((_, itemIndex) => itemIndex !== index) });
  };
  const moveFunnelStep = (card: DashboardCardConfig, index: number, direction: -1 | 1) => {
    const steps = [...(card.funnelSteps ?? [])];
    const target = index + direction;
    if (target < 0 || target >= steps.length) return;
    [steps[index], steps[target]] = [steps[target], steps[index]];
    updateCard(card.id, { funnelSteps: steps });
  };
  return <aside className={variant === "workspace" ? "config-panel editor-workspace" : "config-panel"}>
    <div className="panel-title">{variant === "workspace" ? "分析卡片生成器" : "分析配置"}</div>
    <button className="primary-btn add-card-btn" onClick={addCard}>添加分析卡片</button>
    <div className="config-block"><b>分析模型</b><span>{model?.name}</span><p>{model?.description}</p></div>
    <div className="config-block"><b>事件链路</b><div className="event-chain">{model?.eventChain.map((event) => <span key={event}>{eventName(event)}</span>)}</div></div>
    <div className="config-block"><b>可用拆分维度</b><div className="chips">{modelCapability.allowedDimensions.map((item) => <span key={item}>{dimensionName[item]}</span>)}</div></div>
    <div className="config-block"><b>可用指标</b><div className="chips">{modelCapability.allowedMetrics.map((item) => <span key={item}>{metricName[item]}</span>)}</div></div>
    <div className="config-block">
      <b>分析卡片配置</b>
      {template.cards.map((card) => {
        const cardModel = analysisModels.find((item) => item.id === card.model) ?? model ?? analysisModels[0];
        const cardCapability = getApiCapability(cardModel.id);
        return <div className="card-editor" key={card.id}>
          <input value={card.title} onChange={(event) => updateCard(card.id, { title: event.target.value })} />
          <div className="select-row"><MenuSelect className="form-menu-select" label="展示" value={card.type} onChange={(value) => updateCard(card.id, { type: value as ChartType })} groups={[{ label: "可用图表", options: cardCapability.allowedCharts.map((type) => ({ value: type, label: chartTypeName[type] })) }]} /></div>
          <div className="select-row">
            <MenuSelect className="form-menu-select" label="模型" value={card.model} onChange={(value) => {
              const nextModel = analysisModels.find((item) => item.id === value as AnalysisModelId) ?? analysisModels[0];
              const nextCapability = getApiCapability(nextModel.id);
              updateCard(card.id, { model: nextModel.id, type: nextCapability.allowedCharts[0], metrics: [nextCapability.allowedMetrics[0]], dimensions: [nextCapability.allowedDimensions[0]], drillPath: nextModel.defaultDrillPath });
            }} groups={[{ label: "分析模型", options: analysisModels.map((item) => ({ value: item.id, label: item.name, meta: item.description })) }]} />
          </div>
          <div className="select-row"><MenuSelect className="form-menu-select" label="布局" value={card.size} onChange={(value) => updateCard(card.id, { size: value as DashboardCardConfig["size"] })} groups={[{ label: "卡片宽度", options: cardSizes.map((size) => ({ value: size, label: sizeName[size] })) }]} /></div>
          <div className="config-label">分析指标</div>
          <MetricPicker metrics={cardCapability.allowedMetrics} selected={card.metrics} onToggle={(metric) => toggleMetric(card, metric)} />
          <div className="config-label">按维度查看</div>
          <div className="chips editable">{cardCapability.allowedDimensions.map((dimension) => <ConfigFieldChoice label={dimensionName[dimension]} selected={card.dimensions.includes(dimension)} key={dimension} onClick={() => toggleDimension(card, dimension)} />)}</div>
          <div className="card-actions">
            <button onClick={() => moveCard(card.id, -1)}><ArrowUp aria-hidden="true" />上移</button>
            <button onClick={() => moveCard(card.id, 1)}><ArrowDown aria-hidden="true" />下移</button>
          </div>
          {(card.type === "funnel" || card.type === "sankey") && <div className="funnel-config">
            <div className="config-label">漏斗步骤</div>
            <div className="funnel-steps">
              {(card.funnelSteps ?? []).map((eventId, index) => {
                const event = eventDictionary.find((item) => item.id === eventId);
                return <div className="funnel-step" key={`${eventId}-${index}`}>
                  <span>{index + 1}</span>
                  <b>{event?.name ?? eventId}</b>
                  <code>{event?.domain ?? "事件"}</code>
                  <button className="step-icon-action" aria-label={`上移第 ${index + 1} 步`} title="上移" onClick={() => moveFunnelStep(card, index, -1)}><ArrowUp aria-hidden="true" /></button>
                  <button className="step-icon-action" aria-label={`下移第 ${index + 1} 步`} title="下移" onClick={() => moveFunnelStep(card, index, 1)}><ArrowDown aria-hidden="true" /></button>
                  <button className="step-icon-action danger-action" aria-label={`删除第 ${index + 1} 步`} title="删除" onClick={() => removeFunnelStep(card, index)}><Trash2 aria-hidden="true" /></button>
                </div>;
              })}
            </div>
            <div className="config-label">添加步骤事件</div>
            <div className="chips editable">{eventDictionary.map((event) => <button key={event.id} onClick={() => addFunnelStep(card, event.id)}>{event.name}</button>)}</div>
            <div className="select-row"><MenuSelect className="form-menu-select" label="窗口期" value={card.conversionWindow ?? "当日"} onChange={(value) => updateCard(card.id, { conversionWindow: value })} groups={[{ label: "转化窗口", options: ["当日", "24小时", "7天", "同会话"].map((value) => ({ value, label: value })) }]} /></div>
          </div>}
          <button className="ghost-btn" onClick={() => removeCard(card.id)}>删除卡片</button>
        </div>;
      })}
    </div>
  </aside>;
}

function AnalysisCreator({ modelId, draft, onDraftChange, onUndo, canUndo, onSave, onExit }: { modelId: AnalysisModelId; draft: DashboardTemplate; onDraftChange: (template: DashboardTemplate) => void; onUndo: () => void; canUndo: boolean; onSave: () => void; onExit: () => void }) {
  const [draggingStepIndex, setDraggingStepIndex] = useState<number | null>(null);
  const [draggingEventId, setDraggingEventId] = useState<string | null>(null);
  const [funnelDropActive, setFunnelDropActive] = useState(false);
  const [eventSearch, setEventSearch] = useState("");
  const model = analysisModels.find((item) => item.id === modelId) ?? analysisModels[0];
  const capability = getApiCapability(model.id);
  const funnelCard = draft.cards.find((card) => card.type === "funnel") ?? draft.cards[0];
  const configurableCard = capability.funnelEvents.length > 0 ? funnelCard : draft.cards[0];
  const updateCard = (cardId: string, patch: Partial<DashboardCardConfig>) => {
    onDraftChange({ ...draft, cards: draft.cards.map((card) => card.id === cardId ? { ...card, ...patch } : card) });
  };
  const updateFunnelSteps = (steps: string[]) => updateCard(funnelCard.id, { funnelSteps: steps });
  const addStep = (eventId: string, index = (funnelCard.funnelSteps ?? []).length) => updateFunnelSteps(insertItemAt(funnelCard.funnelSteps ?? [], eventId, index));
  const removeStep = (index: number) => updateFunnelSteps((funnelCard.funnelSteps ?? []).filter((_, itemIndex) => itemIndex !== index));
  const moveStep = (index: number, direction: -1 | 1) => {
    const steps = [...(funnelCard.funnelSteps ?? [])];
    const target = index + direction;
    if (target < 0 || target >= steps.length) return;
    [steps[index], steps[target]] = [steps[target], steps[index]];
    updateFunnelSteps(steps);
  };
  const dropStepAt = (targetIndex: number) => {
    if (draggingStepIndex === null || draggingStepIndex === targetIndex) return;
    updateFunnelSteps(reorderItems(funnelCard.funnelSteps ?? [], draggingStepIndex, targetIndex));
    setDraggingStepIndex(null);
  };
  const dropEventToFunnel = (eventId: string | null, index = (funnelCard.funnelSteps ?? []).length) => {
    if (eventId) addStep(eventId, index);
    setDraggingEventId(null);
    setFunnelDropActive(false);
  };
  const toggleMetric = (metric: MetricId) => {
    const exists = configurableCard.metrics.includes(metric);
    const metrics = exists ? configurableCard.metrics.filter((item) => item !== metric) : [...configurableCard.metrics, metric];
    const nextMetrics = metrics.length ? metrics : [metric];
    updateCard(configurableCard.id, { metrics: nextMetrics });
  };
  const toggleDimension = (dimension: DimensionId) => {
    const exists = configurableCard.dimensions.includes(dimension);
    const dimensions = exists ? configurableCard.dimensions.filter((item) => item !== dimension) : [...configurableCard.dimensions, dimension];
    const nextDimensions = dimensions.length ? dimensions : [dimension];
    updateCard(configurableCard.id, { dimensions: nextDimensions });
  };
  const toggleFilter = (dimension: DimensionId) => {
    const exists = draft.filters.includes(dimension);
    const filters = exists ? draft.filters.filter((item) => item !== dimension) : [...draft.filters, dimension];
    onDraftChange({ ...draft, filters });
  };

  const isFunnelModel = capability.funnelEvents.length > 0;
  const supportedEvents = getSupportedFunnelEvents(model.id);
  const groupedEvents = eventDictionary
    .filter((event) => supportedEvents.includes(event.id))
    .filter((event) => !eventSearch || event.name.includes(eventSearch) || event.domain.includes(eventSearch) || event.description.includes(eventSearch))
    .reduce<Record<string, typeof eventDictionary>>((groups, event) => ({ ...groups, [event.domain]: [...(groups[event.domain] ?? []), event] }), {});

  return <div className="analysis-workbench">
    <div className="analysis-main">
      <div className="creator-head">
        <div className="creator-heading">
          <button className="back-action" onClick={onExit}><ChevronLeft aria-hidden="true" />返回卡片库</button>
          <div>
            <h1>{isFunnelModel ? "生成漏斗分析卡片" : "生成分析卡片"}</h1>
            <p>先选择已有 API 对应的分析模型，再在接口允许的指标、维度和图表范围内生成卡片。</p>
          </div>
        </div>
        <div className="creator-actions"><button disabled={!canUndo} onClick={onUndo}>撤销</button><button className="primary-btn" onClick={onSave}>保存到卡片库</button></div>
      </div>

      <div className="analysis-section">
        <div className="section-title"><b>1. 当前分析模型</b><span className={`capability-badge ${capability.status}`}>{capability.statusLabel}</span></div>
        <div className="analysis-model-card">
          <div className="model-summary"><div><b>{model.name}</b><p>{model.description}</p></div><span>{capability.dataGrain}</span></div>
          <details className="capability-details">
            <summary>查看接口与能力限制</summary>
            <div className="api-path-list">{capability.apiPaths.map((path) => <code key={path}>{path}</code>)}</div>
            <div className="capability-limits">{capability.limitations.map((item) => <span key={item}>{item}</span>)}</div>
          </details>
        </div>
      </div>

      {isFunnelModel && <div className="analysis-section">
        <div className="section-title"><b>2. 配置汇总漏斗</b><span>仅可选择 getEventStats 已返回的字段</span></div>
        <div className="api-warning">当前漏斗比较同一日期范围内的汇总计数，不代表同一批用户按顺序完成，也不支持自定义转化窗口。</div>
        <div className="funnel-builder">
          <div
            className={funnelDropActive ? "funnel-step-list drop-zone active" : "funnel-step-list drop-zone"}
            onDragOver={(event) => {
              event.preventDefault();
              setFunnelDropActive(true);
            }}
            onDragLeave={() => setFunnelDropActive(false)}
            onDrop={(event) => {
              event.preventDefault();
              dropEventToFunnel(event.dataTransfer.getData("event-id") || draggingEventId);
            }}
          >
            {(funnelCard.funnelSteps ?? []).map((eventId, index) => {
              const event = eventDictionary.find((item) => item.id === eventId);
              return <div
                className={draggingStepIndex === index ? "funnel-step large dragging" : "funnel-step large draggable-card"}
                key={`${eventId}-${index}`}
                draggable
                onDragStart={(dragEvent) => {
                  setDraggingStepIndex(index);
                  dragEvent.dataTransfer.setData("funnel-step-index", String(index));
                  dragEvent.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(dragEvent) => dragEvent.preventDefault()}
                onDrop={(dragEvent) => {
                  dragEvent.preventDefault();
                  if (dragEvent.dataTransfer.getData("event-id")) {
                    dragEvent.stopPropagation();
                    dropEventToFunnel(dragEvent.dataTransfer.getData("event-id"), index);
                    return;
                  }
                  dragEvent.stopPropagation();
                  dropStepAt(index);
                }}
                onDragEnd={() => setDraggingStepIndex(null)}
              >
                <span>{index + 1}</span>
                <div><b>{event?.name ?? eventId}</b><em>{event?.description}</em></div>
                <button className="step-icon-action" aria-label={`上移第 ${index + 1} 步`} title="上移" onClick={() => moveStep(index, -1)}><ArrowUp aria-hidden="true" /></button>
                <button className="step-icon-action" aria-label={`下移第 ${index + 1} 步`} title="下移" onClick={() => moveStep(index, 1)}><ArrowDown aria-hidden="true" /></button>
                <button className="step-icon-action danger-action" aria-label={`删除第 ${index + 1} 步`} title="删除" onClick={() => removeStep(index)}><Trash2 aria-hidden="true" /></button>
              </div>;
            })}
          </div>
          <div className="event-picker">
            <div className="event-picker-head"><b>可用接口字段</b><small>可点击添加，也可拖入左侧漏斗</small></div>
            <input value={eventSearch} onChange={(event) => setEventSearch(event.target.value)} placeholder="请输入搜索内容" />
            <div className="event-picker-groups">
              {Object.entries(groupedEvents).map(([domain, events]) => <div className="event-domain" key={domain}>
                <div className="event-domain-title"><span>{domain}</span><em>{events.length}</em></div>
                {events.map((event) => <button
                  key={event.id}
                  draggable
                  onDragStart={(dragEvent) => {
                    setDraggingEventId(event.id);
                    dragEvent.dataTransfer.setData("event-id", event.id);
                    dragEvent.dataTransfer.effectAllowed = "copy";
                  }}
                  onDragEnd={() => setDraggingEventId(null)}
                  onClick={() => addStep(event.id)}
                >{event.name}<small>{event.description}</small></button>)}
              </div>)}
            </div>
          </div>
        </div>
      </div>}

      <div className="analysis-section">
        <div className="section-title"><b>{isFunnelModel ? "3" : "2"}. 设置分析条件</b><span>选项已按当前 API 自动收敛</span></div>
        <div className="condition-grid">
          <div className="condition-field">
            <span>查询筛选</span>
            <div className="chips editable compact">{capability.allowedDimensions.map((dimension) => <ConfigFieldChoice label={dimensionName[dimension]} selected={draft.filters.includes(dimension)} key={dimension} onClick={() => toggleFilter(dimension)} />)}</div>
          </div>
          <MenuSelect className="form-menu-select" label="默认图表" value={configurableCard.type} onChange={(value) => updateCard(configurableCard.id, { type: value as ChartType })} groups={[{ label: "可用图表", options: capability.allowedCharts.map((type) => ({ value: type, label: chartTypeName[type] })) }]} />
        </div>
        <div className="config-label">拆分维度 <small>至少选择 1 项</small></div>
        <div className="chips editable selectable">{capability.allowedDimensions.map((dimension) => <ConfigFieldChoice label={dimensionName[dimension]} selected={configurableCard.dimensions.includes(dimension)} key={dimension} onClick={() => toggleDimension(dimension)} />)}</div>
        <div className="config-label">统计指标 <small>至少选择 1 项</small></div>
        <div onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
          event.preventDefault();
          const metric = event.dataTransfer.getData("metric-id") as MetricId;
          if (capability.allowedMetrics.includes(metric) && !configurableCard.metrics.includes(metric)) {
            if (configurableCard.metrics.length >= MAX_METRICS_PER_QUERY) {
              notify(`单张卡片最多选择 ${MAX_METRICS_PER_QUERY} 个指标`);
              return;
            }
            updateCard(configurableCard.id, { metrics: [...configurableCard.metrics, metric] });
          }
        }}><MetricPicker metrics={capability.allowedMetrics} selected={configurableCard.metrics} onToggle={toggleMetric} dropTarget /></div>
      </div>

    </div>

    <aside className="analysis-summary">
      <div className="panel-title">卡片设置与预览</div>
      <div className="config-block"><b>卡片名称</b><input value={draft.name} onChange={(event) => onDraftChange({ ...draft, name: event.target.value })} /></div>
      <div className="config-block"><b>分析说明</b><textarea value={draft.scenario} onChange={(event) => onDraftChange({ ...draft, scenario: event.target.value })} /></div>
      {isFunnelModel && <div className="config-block"><b>当前汇总字段</b><div className="event-chain">{(funnelCard.funnelSteps ?? []).map((event) => <span key={event}>{eventName(event)}</span>)}</div></div>}
      <div className="live-preview">
        <div className="section-title"><b>实时预览</b><span>配置后自动更新</span></div>
        <div className="result-grid">
          <CardRenderer card={configurableCard} onDrill={() => undefined} modern={uiVersion === "v13"} />
        </div>
      </div>
    </aside>
  </div>;
}

function Drawer({ payload, onClose }: { payload: DrilldownPayload | null; onClose: () => void }) {
  const ref = useRef<HTMLElement | null>(null);
  const [detailKind, setDetailKind] = useState<"users" | "circles">("users");
  const [detailPlatform, setDetailPlatform] = useState("");
  const [detailPage, setDetailPage] = useState(1);
  const [detailRows, setDetailRows] = useState<Record<string, string | number>[]>([]);
  const [detailWarnings, setDetailWarnings] = useState<string[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  useEffect(() => {
    if (!payload) return undefined;
    ref.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [payload, onClose]);
  useEffect(() => {
    if (!payload) return;
    setDetailKind(payload.detailKind);
    setDetailPlatform(payload.platformIds[0] ?? "");
    setDetailPage(1);
  }, [payload]);
  useEffect(() => {
    if (!payload || !detailPlatform) return;
    const controller = new AbortController();
    setDetailLoading(true);
    setDetailError(null);
    fetch(`/api/bi/drilldown/${detailKind}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ platformId: detailPlatform, dateRange: payload.dateRange, page: detailPage, pageSize: 20 })
    }).then(async (response) => {
      const body = await readJsonResponse<{ success: boolean; data?: { rows: Record<string, string | number>[]; warnings?: string[] }; error?: { message?: string } }>(response, "明细查询服务");
      if (!response.ok || !body.success || !body.data) throw new Error(body.error?.message ?? "真实明细查询失败");
      setDetailRows(body.data.rows);
      setDetailWarnings(body.data.warnings ?? []);
    }).catch((error) => {
      if (controller.signal.aborted) return;
      setDetailRows([]);
      setDetailWarnings([]);
      setDetailError(error instanceof Error ? error.message : "真实明细查询失败");
    }).finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [payload, detailKind, detailPlatform, detailPage]);
  const trendOption = useMemo<EChartsOption>(() => ({
    tooltip: { trigger: "axis" },
    grid: { left: 34, right: 14, top: 16, bottom: 24 },
    xAxis: { type: "category", data: dates.slice(-6), boundaryGap: false },
    yAxis: { type: "value", splitLine: { lineStyle: { color: "#eef2f6" } } },
    series: [{ type: "line", smooth: true, data: [82, 86, 79, 92, 88, 103], areaStyle: { opacity: .14 }, color: "#2563eb" }]
  }), []);
  return <>
    <div className={payload ? "mask show" : "mask"} onClick={onClose} />
    <aside ref={ref} role="dialog" aria-modal="true" aria-label="下钻分析" tabIndex={-1} className={payload ? "drawer show" : "drawer"}>
      <div className="drawer-head"><div><b>{payload?.title ?? "下钻分析"}</b><span>{payload?.subtitle}</span></div><button aria-label="关闭下钻分析" onClick={onClose}><X aria-hidden="true" /></button></div>
      {payload && <div className="drawer-body">
        <div className="drill-context"><span>当前范围</span><b>{payload.scope}</b><em>{payload.benchmark}</em></div>
        <div className="drawer-kpis"><div><span>分析模型</span><b>{modelName[payload.model]}</b></div><div><span>明细行数</span><b>{payload.rows.length}</b></div><div><span>下钻维度</span><b>{payload.dimensions.map((item) => dimensionName[item]).join(" / ")}</b></div><div><span>核心指标</span><b>{payload.metrics.map((item) => metricName[item]).slice(0, 3).join(" / ")}</b></div></div>
        <div className="insight-panel">
          <b>自动分析结论</b>
          <p>{payload.diagnosis[0]}</p>
          <div className="drawer-mini-chart"><Chart option={trendOption} /></div>
        </div>
        <div className="detail-section-head"><div><h3>真实业务明细</h3><span>来自后台明细接口，不使用演示数据</span></div><div className="detail-controls"><MenuSelect label="平台" ariaLabel="下钻明细平台" align="end" value={detailPlatform} onChange={(value) => { setDetailPlatform(value); setDetailPage(1); }} groups={[{ label: "当前可用平台", options: payload.platformIds.map((pid) => ({ value: pid, label: pid })) }]} /><div className="segmented-control"><button className={detailKind === "users" ? "on" : ""} onClick={() => { setDetailKind("users"); setDetailPage(1); }}>用户</button><button className={detailKind === "circles" ? "on" : ""} onClick={() => { setDetailKind("circles"); setDetailPage(1); }}>圈子</button></div></div></div>
        {detailLoading && <div className="detail-state">正在加载真实明细...</div>}
        {detailError && <div className="card-data-warning">{detailError}</div>}
        {!detailLoading && !detailError && <DataTable rows={detailRows} />}
        {detailWarnings.length > 0 && <div className="detail-warnings">{detailWarnings.join("；")}</div>}
        <div className="detail-pager"><button disabled={detailPage === 1 || detailLoading} onClick={() => setDetailPage((page) => Math.max(1, page - 1))}>上一页</button><b>第 {detailPage} 页</b><button disabled={detailRows.length < 20 || detailLoading} onClick={() => setDetailPage((page) => page + 1)}>下一页</button></div>
        <h3>图表聚合数据</h3>
        <DataTable rows={payload.rows} />
        <h3>系统诊断</h3>
        <DiagnosisCard insights={payload.diagnosis} />
        <h3>下一步</h3>
        <div className="drawer-actions"><button onClick={() => notify("已带入当前平台、时间和节点条件")}>{payload.actions[0]}</button><button onClick={() => downloadCsv(`${payload.title}.csv`, detailRows.length ? detailRows : payload.rows)}>{payload.actions[1]}</button><button onClick={() => notify("已保存为该卡片的默认下钻路径")}>{payload.actions[2]}</button></div>
      </div>}
    </aside>
  </>;
}

function Dictionaries({ onUseModel }: { onUseModel: (modelId: AnalysisModelId) => void }) {
  const [tab, setTab] = useState<"events" | "metrics" | "dimensions" | "taxonomy">("events");
  const [search, setSearch] = useState("");
  const [taxonomyPlatform, setTaxonomyPlatform] = useState("PH");
  const [categoryRoots, setCategoryRoots] = useState<Array<{ platformCode: string; platformName: string; groups: Array<{ id: string; name: string; type: string; childCount: number }> }>>([]);
  const [realTags, setRealTags] = useState<Array<{ id: string; name: string; type: string; group: string }>>([]);
  useEffect(() => {
    if (tab !== "taxonomy") return;
    const controller = new AbortController();
    Promise.all([fetch("/api/bi/metadata/categories", { method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal, body: JSON.stringify({ platformId: taxonomyPlatform }) }).then((response) => response.json()), fetch("/api/bi/metadata/tags", { method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal, body: JSON.stringify({ platformId: taxonomyPlatform }) }).then((response) => response.json())]).then(([categories, tags]) => { if (categories.success) setCategoryRoots(categories.data); if (tags.success) setRealTags(tags.data.rows ?? []); }).catch(() => { if (!controller.signal.aborted) notify("真实分类和标签读取失败"); });
    return () => controller.abort();
  }, [tab, taxonomyPlatform]);
  const normalized = search.trim().toLowerCase();
  const modelForEvent = (eventId: string) => analysisModels.find((model) => model.eventChain.includes(eventId))?.id ?? null;
  const modelForMetric = (metricId: MetricId) => analysisModels.find((model) => model.allowedMetrics.includes(metricId))?.id ?? null;
  return <section className="dictionary-workspace">
    <div className="dashboard-head"><div><h1>数据字典</h1><p>统一查看已有 API 返回字段、可计算指标和受支持维度，并可直接带入分析工作台。</p></div><div className="dashboard-actions"><div className="model-pill">{eventDictionary.length} 埋点汇总字段 · {metricDictionary.length} 指标 · {Object.keys(dimensionName).length} 维度</div></div></div>
    <div className="dictionary-toolbar"><div className="dictionary-tabs"><button className={tab === "events" ? "on" : ""} onClick={() => setTab("events")}>API 字段</button><button className={tab === "metrics" ? "on" : ""} onClick={() => setTab("metrics")}>指标</button><button className={tab === "dimensions" ? "on" : ""} onClick={() => setTab("dimensions")}>维度</button><button className={tab === "taxonomy" ? "on" : ""} onClick={() => setTab("taxonomy")}>分类与标签</button></div><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索名称、字段、接口域或口径" /></div>
    {tab === "events" && <div className="dictionary-grid">{eventDictionary.filter((event) => !normalized || `${event.name} ${event.id} ${event.domain} ${event.description}`.toLowerCase().includes(normalized)).map((event) => { const targetModel = modelForEvent(event.id); return <article className="dictionary-item" key={event.id}><div className="dictionary-item-head"><div><b>{event.name}</b><code>{event.id}</code></div><span className={`data-status ${event.status ?? "ready"}`}>{event.status === "partial" ? "部分可用" : event.status === "missing" ? "待建设" : "接口可用"}</span></div><p>{event.description}</p><div className="dictionary-meta"><span>{event.domain}</span><span>{event.trigger ?? "接口聚合返回"}</span></div><div className="chips">{event.requiredProperties.map((dimension) => <span key={dimension}>{dimensionName[dimension]}</span>)}</div><button disabled={!targetModel} onClick={() => targetModel && onUseModel(targetModel)}>{targetModel ? "用于新建分析" : "仅供查看"}</button></article>;})}</div>}
    {tab === "metrics" && <div className="dictionary-grid">{metricDictionary.filter((metric) => !normalized || `${metric.name} ${metric.id} ${metric.formula} ${metric.source}`.toLowerCase().includes(normalized)).map((metric) => { const targetModel = modelForMetric(metric.id); return <article className="dictionary-item" key={metric.id}><div className="dictionary-item-head"><div><b>{metric.name}</b><code>{metric.id}</code></div><span className={`data-status ${metric.status}`}>{metric.status === "partial" ? "部分可用" : metric.status === "missing" ? "待建设" : "可用"}</span></div><p>{metric.description ?? metric.formula}</p><pre>{metric.formula}</pre><div className="dictionary-meta"><span>{metric.source}</span><span>负责人：{metric.owner}</span></div><button disabled={!targetModel} onClick={() => targetModel && onUseModel(targetModel)}>{targetModel ? "用于新建分析" : "当前不可配置"}</button></article>;})}</div>}
    {tab === "dimensions" && <div className="dictionary-grid">{Object.entries(dimensionName).filter(([id, name]) => !normalized || `${id} ${name}`.toLowerCase().includes(normalized)).map(([id, name]) => {
      const supportedModels = analysisModels.filter((model) => model.allowedDimensions.includes(id as DimensionId));
      return <article className="dictionary-item dimension-item" key={id}><div className="dictionary-item-head"><div><b>{name}</b><code>{id}</code></div><span className={`data-status ${supportedModels.length ? "ready" : "missing"}`}>{supportedModels.length ? `${supportedModels.length} 个模型可用` : "当前 API 不支持"}</span></div><p>{supportedModels.length ? `可用于：${supportedModels.map((model) => model.name).join("、")}` : "字段已保留在规划字典中，现阶段不能用于生成真实分析卡片。"}</p><div className="dictionary-meta"><span>API 能力约束</span><span>{supportedModels.length ? "支持筛选或分组" : "等待接口补充"}</span></div><button disabled={!supportedModels.length} onClick={() => supportedModels.length && onUseModel(supportedModels[0].id)}>{supportedModels.length ? "用于新建分析" : "暂不可用"}</button></article>;
    })}</div>}
    {tab === "taxonomy" && <><div className="taxonomy-toolbar"><MenuSelect label="标签平台" ariaLabel="标签平台筛选" value={taxonomyPlatform} onChange={setTaxonomyPlatform} groups={[{ label: "平台", options: Object.entries(platformPid).map(([name, pid]) => ({ value: pid, label: name, meta: pid })) }]} /><span>真实分类树 {categoryRoots.length} 个根节点 · 标签 {realTags.length} 个</span></div><div className="dictionary-grid">{categoryRoots.flatMap((root) => root.groups.map((group) => ({ ...group, platformName: root.platformName }))).filter((item) => !normalized || `${item.name} ${item.type} ${item.platformName}`.toLowerCase().includes(normalized)).slice(0, 60).map((item) => <article className="dictionary-item" key={`${item.platformName}-${item.id}`}><div className="dictionary-item-head"><div><b>{item.name}</b><code>{item.type}</code></div><span className="data-status ready">真实分类</span></div><p>{item.platformName} · 下级分类 {item.childCount} 个</p></article>)}{realTags.filter((item) => !normalized || `${item.name} ${item.type}`.toLowerCase().includes(normalized)).slice(0, 60).map((item) => <article className="dictionary-item" key={item.id}><div className="dictionary-item-head"><div><b>{item.name}</b><code>{item.type}</code></div><span className="data-status ready">真实标签</span></div><p>标签组：{item.group}</p></article>)}</div></>}
  </section>;
}

function TemplateInspector({ template }: { template: DashboardTemplate }) {
  const model = analysisModels.find((item) => item.id === template.model);
  return <aside className="config-panel">
    <div className="panel-title">模板说明</div>
    <div className="config-block"><b>当前模板</b><span>{template.name}</span><p>{template.scenario}</p></div>
    <div className="config-block"><b>分析模型</b><span>{model?.name}</span><p>{model?.description}</p></div>
    <div className="config-block"><b>事件链路</b><div className="event-chain">{model?.eventChain.map((event) => <span key={event}>{eventName(event)}</span>)}</div></div>
    <div className="config-block"><b>卡片清单</b>{template.cards.map((card, index) => <div className="mini-row" key={card.id}>{index + 1}. {card.title}<em>{chartTypeName[card.type]}</em></div>)}</div>
    <div className="config-block"><b>使用方式</b><p>日常使用时只需要选择模板、调整筛选条件、查看图表和统计表；点击图表节点可以打开下钻分析。</p></div>
  </aside>;
}

function ModeTabs({ createMode, onChange }: { createMode: boolean; onChange: (value: boolean) => void }) {
  return <div className="mode-tabs">
    <button className={!createMode ? "on" : ""} onClick={() => onChange(false)}>
      <b>使用模板</b>
      <span>日常看数据、筛选、下钻</span>
    </button>
    <button className={createMode ? "on" : ""} onClick={() => onChange(true)}>
      <b>生成卡片</b>
      <span>低频创建分析卡片并加入看板</span>
    </button>
  </div>;
}

interface ChannelRow {
  date: string; platformId: string; channel: string; parentChannel: string; cooperationType: string; owner: string;
  price: number; loginUsers: number; newUsers: number; registeredUsers: number; viewers: number; viewRate: number;
  clicks: number; clickUsers: number; paidUsers: number; revenue: number; androidUsers: number; iosUsers: number; running: boolean;
}

function ChannelDashboard({ filters }: { filters: DashboardFilters }) {
  const platformScope = selectedPlatformScope(filters);
  const platformKey = platformScope.map((item) => item.pid).join(",");
  const scopeLabel = filters.mode === "all" ? "全部 20 个平台" : platformScope.map((item) => item.name).join("、");
  const range = filters.dateRange;
  const [rows, setRows] = useState<ChannelRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [related, setRelated] = useState({ partners: 0, templates: 0, withdrawals: 0 });
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    Promise.all(platformScope.map(async ({ pid }) => {
      const response = await fetch("/api/bi/channels/detail", { method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal, body: JSON.stringify({ platformId: pid, dateRange: resolveDashboardDateRange(filters), page: 1, pageSize: 100 }) });
      const payload = await readJsonResponse<{ success: boolean; data?: { rows: ChannelRow[]; total: number }; error?: { message?: string } }>(response, "渠道数据服务");
      if (!response.ok || !payload.success || !payload.data) throw new Error(payload.error?.message ?? `${pid} 渠道数据查询失败`);
      return payload.data;
    })).then((results) => {
        setRows(results.flatMap((item) => item.rows));
        setTotal(results.reduce((sum, item) => sum + item.total, 0));
      }).catch((reason) => { if (!controller.signal.aborted) { setRows([]); setError(reason instanceof Error ? reason.message : "渠道数据查询失败"); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [platformKey, range, filters.customStart, filters.customEnd]);
  useEffect(() => {
    const controller = new AbortController();
    if (platformScope.length !== 1) { setRelated({ partners: 0, templates: 0, withdrawals: 0 }); return () => controller.abort(); }
    const request = (domain: string) => fetch(`/api/bi/metadata/${domain}`, { method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal, body: JSON.stringify({ platformId: platformScope[0].pid }) }).then((response) => response.json());
    Promise.all([request("partners"), request("landing-templates"), request("withdrawals")]).then(([partners, templates, withdrawals]) => setRelated({ partners: Number(partners.data?.total ?? partners.data?.rows?.length ?? 0), templates: Number(templates.data?.rows?.length ?? 0), withdrawals: Number(withdrawals.data?.total ?? withdrawals.data?.rows?.length ?? 0) })).catch(() => undefined);
    return () => controller.abort();
  }, [platformKey]);
  const ranked = useMemo(() => [...rows].filter((row) => row.channel).sort((a, b) => b.registeredUsers - a.registeredUsers).slice(0, 12), [rows]);
  const summary = useMemo(() => rows.reduce((sum, row) => ({ login: sum.login + row.loginUsers, register: sum.register + row.registeredUsers, viewer: sum.viewer + row.viewers, paid: sum.paid + row.paidUsers, revenue: sum.revenue + row.revenue }), { login: 0, register: 0, viewer: 0, paid: 0, revenue: 0 }), [rows]);
  const cooperation = useMemo(() => Object.entries(rows.reduce<Record<string, number>>((result, row) => ({ ...result, [row.cooperationType || "未标记"]: (result[row.cooperationType || "未标记"] ?? 0) + row.registeredUsers }), {})), [rows]);
  const rankingOption = useMemo<EChartsOption>(() => ({ tooltip: { trigger: "axis" }, legend: { top: 0 }, grid: { left: 108, right: 20, top: 38, bottom: 24 }, xAxis: { type: "value", splitLine: { lineStyle: { color: "#edf1f7" } } }, yAxis: { type: "category", inverse: true, data: ranked.map((row) => `${row.platformId} · ${row.channel}`), axisTick: { show: false } }, series: [{ name: "注册用户", type: "bar", data: ranked.map((row) => row.registeredUsers), itemStyle: { color: "#2563eb", borderRadius: [0, 4, 4, 0] } }, { name: "观看用户", type: "bar", data: ranked.map((row) => row.viewers), itemStyle: { color: "#60a5fa", borderRadius: [0, 4, 4, 0] } }] }), [ranked]);
  const cooperationOption = useMemo<EChartsOption>(() => ({ tooltip: { trigger: "item" }, legend: { bottom: 0 }, series: [{ type: "pie", radius: ["48%", "72%"], center: ["50%", "44%"], data: cooperation.map(([name, value]) => ({ name, value })), label: { formatter: "{b}\n{d}%" }, itemStyle: { borderColor: "#fff", borderWidth: 3 } }] }), [cooperation]);
  const tableRows = ranked.map((row) => ({ 平台: row.platformId, 渠道: row.channel, 合作类型: row.cooperationType, 负责人: row.owner, 登录用户: row.loginUsers, 注册用户: row.registeredUsers, 观看用户: row.viewers, 观看率: `${(row.viewRate * 100).toFixed(1)}%`, 点击人数: row.clickUsers, 付费人数: row.paidUsers, 收入: `¥${row.revenue.toFixed(2)}`, 状态: row.running ? "运行中" : "已停用" }));
  return <section className="channel-page">
    <div className="dashboard-head"><div><h1>渠道获客与转化</h1><p>识别高质量渠道、注册承接和付费贡献。</p></div><div className="scope-note">当前范围 · {scopeLabel}</div></div>
    <DataState loading={loading} error={error} empty={!loading && !error && rows.length === 0} loadingLabel="正在加载真实渠道数据..." emptyLabel="所选平台和时间范围没有渠道记录" />
    <div className="channel-source"><span className="status-dot" /><b>{loading ? "真实渠道数据加载中" : "真实 API"}</b><span>{platformScope.length} 个平台共 {total.toLocaleString()} 条，本页每个平台最多读取 100 条</span>{platformScope.length === 1 && <span>合作方 {related.partners} · 落地页模板 {related.templates} · 提现记录 {related.withdrawals}</span>}</div>
    <div className="channel-kpis"><div><span><FieldLabel label="登录用户" /></span><b>{summary.login.toLocaleString()}</b></div><div><span><FieldLabel label="注册用户" /></span><b>{summary.register.toLocaleString()}</b></div><div><span><FieldLabel label="观看用户" /></span><b>{summary.viewer.toLocaleString()}</b></div><div><span><FieldLabel label="付费人数" /></span><b>{summary.paid.toLocaleString()}</b></div><div><span><FieldLabel label="收入" /></span><b>¥{summary.revenue.toLocaleString()}</b></div></div>
    <div className="channel-chart-grid"><section className="card"><div className="chart-card-head"><div><div className="card-title"><span>渠道注册与观看排行</span><small>前 12 个渠道</small></div></div></div>{rows.length ? <Chart option={rankingOption} /> : <div className="empty-preview">当前条件下暂无渠道数据</div>}</section><section className="card"><div className="chart-card-head"><div><div className="card-title"><span>合作类型贡献</span><small>按注册用户</small></div></div></div>{rows.length ? <Chart option={cooperationOption} /> : <div className="empty-preview">当前条件下暂无渠道数据</div>}</section></div>
    <section className="card channel-table"><div className="chart-card-head"><div><div className="card-title"><span>渠道表现明细</span><small>真实字段归一化</small></div></div><button onClick={() => downloadCsv(`渠道分析-${platformKey}-${range}.csv`, tableRows)}>导出</button></div><DataTable rows={tableRows} /></section>
  </section>;
}

interface ContentCategoryRow { category: string; watches: number; viewers: number; clicks: number; likes: number; collects: number; watchesPerViewer: number; playPerClick: number; likeRate: number; collectRate: number }

function ContentDashboard({ filters }: { filters: DashboardFilters }) {
  const platformScope = selectedPlatformScope(filters);
  const platformKey = platformScope.map((item) => item.pid).join(",");
  const scopeLabel = filters.mode === "all" ? "全部 20 个平台" : platformScope.map((item) => item.name).join("、");
  const range = filters.dateRange;
  const [rows, setRows] = useState<ContentCategoryRow[]>([]);
  const [approximateUv, setApproximateUv] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(null);
    Promise.all(platformScope.map(async ({ pid }) => { const response = await fetch("/api/bi/content/categories", { method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal, body: JSON.stringify({ platformId: pid, dateRange: resolveDashboardDateRange(filters), page: 1, pageSize: 100 }) }); const payload = await readJsonResponse<{ success: boolean; data?: { rows: ContentCategoryRow[]; approximateUv: boolean }; error?: { message?: string } }>(response, "分类内容服务"); if (!response.ok || !payload.success || !payload.data) throw new Error(payload.error?.message ?? `${pid} 分类内容查询失败`); return payload.data; })).then((results) => {
      const groups = new Map<string, ContentCategoryRow[]>();
      results.flatMap((item) => item.rows).forEach((row) => groups.set(row.category, [...(groups.get(row.category) ?? []), row]));
      setRows([...groups].map(([category, items]) => { const sums = items.reduce((sum, row) => ({ watches: sum.watches + row.watches, viewers: sum.viewers + row.viewers, clicks: sum.clicks + row.clicks, likes: sum.likes + row.likes, collects: sum.collects + row.collects }), { watches: 0, viewers: 0, clicks: 0, likes: 0, collects: 0 }); return { category, ...sums, watchesPerViewer: sums.viewers ? sums.watches / sums.viewers : 0, playPerClick: sums.clicks ? sums.watches / sums.clicks : 0, likeRate: sums.viewers ? sums.likes / sums.viewers : 0, collectRate: sums.viewers ? sums.collects / sums.viewers : 0 }; }).sort((a, b) => b.watches - a.watches));
      setApproximateUv(results.some((item) => item.approximateUv));
    }).catch((reason) => { if (!controller.signal.aborted) { setRows([]); setError(reason instanceof Error ? reason.message : "分类内容查询失败"); } }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [platformKey, range, filters.customStart, filters.customEnd]);
  const top = rows.slice(0, 15);
  const totals = rows.reduce((sum, row) => ({ watches: sum.watches + row.watches, viewers: sum.viewers + row.viewers, clicks: sum.clicks + row.clicks, likes: sum.likes + row.likes, collects: sum.collects + row.collects }), { watches: 0, viewers: 0, clicks: 0, likes: 0, collects: 0 });
  const rankOption = useMemo<EChartsOption>(() => ({ tooltip: { trigger: "axis" }, legend: { top: 0 }, grid: { left: 88, right: 22, top: 38, bottom: 24 }, xAxis: { type: "value", splitLine: { lineStyle: { color: "#edf1f7" } } }, yAxis: { type: "category", inverse: true, data: top.map((row) => row.category) }, series: [{ name: "观看次数", type: "bar", data: top.map((row) => row.watches), itemStyle: { color: "#2563eb", borderRadius: [0, 4, 4, 0] } }, { name: "观看人数", type: "bar", data: top.map((row) => row.viewers), itemStyle: { color: "#93c5fd", borderRadius: [0, 4, 4, 0] } }] }), [top]);
  const efficiencyOption = useMemo<EChartsOption>(() => ({ tooltip: { formatter: (params: any) => `${params.data.name}<br/>人均观看 ${params.value[0].toFixed(2)}<br/>点赞率 ${(params.value[1] * 100).toFixed(2)}%<br/>观看人数 ${params.value[2].toLocaleString()}` }, grid: { left: 54, right: 24, top: 30, bottom: 42 }, xAxis: { type: "value", name: "人均观看次数", splitLine: { lineStyle: { color: "#edf1f7" } } }, yAxis: { type: "value", name: "点赞率", axisLabel: { formatter: (value: number) => `${(value * 100).toFixed(1)}%` }, splitLine: { lineStyle: { color: "#edf1f7" } } }, series: [{ type: "scatter", data: top.map((row) => ({ name: row.category, value: [row.watchesPerViewer, row.likeRate, row.viewers] })), symbolSize: (value: number[]) => Math.max(12, Math.min(46, Math.sqrt(value[2]) / 18)), itemStyle: { color: "#16a34a", opacity: .78 }, label: { show: true, position: "top", formatter: (params: any) => params.data.name } }] }), [top]);
  const displayRows = rows.map((row) => ({ 分类: row.category, 观看次数: row.watches, 观看人数: row.viewers, 点击次数: row.clicks, 人均观看: row.watchesPerViewer.toFixed(2), 播放点击比: row.playPerClick.toFixed(2), 点赞: row.likes, 点赞率: `${(row.likeRate * 100).toFixed(2)}%`, 收藏: row.collects, 收藏率: `${(row.collectRate * 100).toFixed(2)}%` }));
  return <section className="channel-page content-page"><div className="dashboard-head"><div><h1>内容分类表现</h1><p>定位高消费、高互动和低承接分类。</p></div><div className="scope-note">当前范围 · {scopeLabel}</div></div>
    <DataState loading={loading} error={error} empty={!loading && !error && rows.length === 0} loadingLabel="正在加载真实分类数据..." emptyLabel="所选平台和时间范围没有分类统计" />{approximateUv && <div className="card-data-warning">后台标记观看人数为近似 UV，涉及观看人数的比率仅用于趋势判断。</div>}
    <div className="channel-source"><span className="status-dot" /><b>{loading ? "真实分类数据加载中" : "真实 API"}</b><span>当前返回 {rows.length} 个分类</span></div>
    <div className="channel-kpis"><div><span><FieldLabel label="观看次数" /></span><b>{totals.watches.toLocaleString()}</b></div><div><span><FieldLabel label="观看人数" /></span><b>{totals.viewers.toLocaleString()}</b></div><div><span><FieldLabel label="点击次数" /></span><b>{totals.clicks.toLocaleString()}</b></div><div><span><FieldLabel label="点赞" /></span><b>{totals.likes.toLocaleString()}</b></div><div><span><FieldLabel label="收藏" /></span><b>{totals.collects.toLocaleString()}</b></div></div>
    <div className="channel-chart-grid"><section className="card"><div className="chart-card-head"><div><div className="card-title"><span>分类消费规模</span><small>观看次数与人数</small></div></div></div>{rows.length ? <Chart option={rankOption} /> : <div className="empty-preview">当前条件下暂无分类数据</div>}</section><section className="card"><div className="chart-card-head"><div><div className="card-title"><span>分类消费效率</span><small>气泡大小代表观看人数</small></div></div></div>{rows.length ? <Chart option={efficiencyOption} /> : <div className="empty-preview">当前条件下暂无分类数据</div>}</section></div>
    <section className="card channel-table"><div className="chart-card-head"><div><div className="card-title"><span>分类指标明细</span><small>真实接口字段</small></div></div><button onClick={() => downloadCsv(`内容分类-${platformKey}-${range}.csv`, displayRows)}>导出</button></div><DataTable rows={displayRows} /></section></section>;
}

type SpecialDomain = "navigation" | "cnzz" | "snapshots" | "news" | "surveys";
const specialDomainMeta: Record<SpecialDomain, { name: string; description: string }> = {
  navigation: { name: "导航点击", description: "导航入口、分类和位置点击表现" },
  cnzz: { name: "访问下载", description: "渠道访问、用户与下载转化" },
  snapshots: { name: "快照内容", description: "图集快照的浏览、互动与内容量" },
  news: { name: "资讯统计", description: "资讯接口当前周期数据" },
  surveys: { name: "问卷统计", description: "问卷接口当前周期数据" }
};

function SpecialDashboard({ filters }: { filters: DashboardFilters }) {
  const [domain, setDomain] = useState<SpecialDomain>("navigation");
  const platformScope = selectedPlatformScope(filters);
  const platformKey = platformScope.map((item) => item.pid).join(",");
  const scopeLabel = filters.mode === "all" ? "全部 20 个平台" : platformScope.map((item) => item.name).join("、");
  const range = filters.dateRange;
  const [rows, setRows] = useState<Array<Record<string, string | number | boolean>>>([]);
  const [total, setTotal] = useState(0);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(null);
    Promise.all(platformScope.map(async ({ pid, name }) => { const response = await fetch(`/api/bi/special/${domain}`, { method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal, body: JSON.stringify({ platformId: pid, dateRange: resolveDashboardDateRange(filters), page: 1, pageSize: 100 }) }); const payload = await readJsonResponse<{ success: boolean; data?: { rows: Array<Record<string, string | number | boolean>>; total: number; warnings: string[] }; error?: { message?: string } }>(response, "专项数据服务"); if (!response.ok || !payload.success || !payload.data) throw new Error(payload.error?.message ?? `${name} 专项数据查询失败`); return { ...payload.data, rows: payload.data.rows.map((row) => ({ 分析平台: name, ...row })) }; }))
      .then((results) => { setRows(results.flatMap((item) => item.rows)); setTotal(results.reduce((sum, item) => sum + item.total, 0)); setWarnings([...new Set(results.flatMap((item) => item.warnings))]); })
      .catch((reason) => { if (!controller.signal.aborted) { setRows([]); setWarnings([]); setError(reason instanceof Error ? reason.message : "专项数据查询失败"); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [domain, platformKey, range, filters.customStart, filters.customEnd]);
  const ranked = useMemo(() => [...rows].sort((a, b) => Number(b.clicks ?? b.downloads ?? b.views ?? 0) - Number(a.clicks ?? a.downloads ?? a.views ?? 0)).slice(0, 15), [rows]);
  const chartOption = useMemo<EChartsOption>(() => {
    const labelKey = domain === "navigation" ? "name" : domain === "cnzz" ? "channel" : "name";
    const valueKey = domain === "navigation" ? "clicks" : domain === "cnzz" ? "downloads" : "views";
    const secondaryKey = domain === "navigation" ? "clickUsers" : domain === "cnzz" ? "users" : "likes";
    return { tooltip: { trigger: "axis" }, legend: { top: 0 }, grid: { left: 130, right: 22, top: 38, bottom: 24 }, xAxis: { type: "value", splitLine: { lineStyle: { color: "#edf1f7" } } }, yAxis: { type: "category", inverse: true, data: ranked.map((row) => `${String(row.分析平台 ?? "")} · ${String(row[labelKey] ?? "--")}`), axisLabel: { width: 116, overflow: "truncate" } }, series: [{ name: domain === "navigation" ? "点击次数" : domain === "cnzz" ? "下载次数" : "浏览次数", type: "bar", data: ranked.map((row) => Number(row[valueKey] ?? 0)), itemStyle: { color: "#2563eb", borderRadius: [0, 4, 4, 0] } }, { name: domain === "navigation" ? "点击人数" : domain === "cnzz" ? "用户数" : "点赞数", type: "bar", data: ranked.map((row) => Number(row[secondaryKey] ?? 0)), itemStyle: { color: "#93c5fd", borderRadius: [0, 4, 4, 0] } }] };
  }, [domain, ranked]);
  const displayRows = rows.map((row) => domain === "navigation" ? { 平台: row.分析平台, 日期: row.date, 导航名称: row.name, 分类: row.category, 位置: row.position, 点击人数: row.clickUsers, 点击次数: row.clicks, 人均点击: Number(row.clicksPerUser).toFixed(2) } : domain === "cnzz" ? { 平台: row.分析平台, 日期: row.date, 渠道: row.channel, 访问次数: row.visits, 用户数: row.users, 下载次数: row.downloads, 下载率: `${(Number(row.downloadRate) * 100).toFixed(1)}%`, 安卓下载: row.androidDownloads, iOS下载: row.iosDownloads, 重复下载: row.repeatDownloads } : domain === "snapshots" ? { 平台: row.分析平台, 发布日期: row.releaseDate, 快照ID: row.snapshotId, 名称: row.name, 浏览: row.views, 点赞: row.likes, 收藏: row.collects, 内容数: row.contentCount, 标签: row.tags, 状态: row.state } : Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === "boolean" ? String(value) : value])));
  const primary = rows.reduce((sum, row) => sum + Number(row.clicks ?? row.downloads ?? row.views ?? 0), 0);
  const secondary = rows.reduce((sum, row) => sum + Number(row.clickUsers ?? row.users ?? row.likes ?? 0), 0);
  return <section className="channel-page special-page">
    <div className="dashboard-head"><div><h1>专项数据分析</h1><p>导航、下载、快照、资讯和问卷的集中观察。</p></div><div className="scope-note">当前范围 · {scopeLabel}</div></div>
    <div className="special-tabs">{(Object.keys(specialDomainMeta) as SpecialDomain[]).map((id) => <button className={domain === id ? "on" : ""} key={id} onClick={() => setDomain(id)}><b>{specialDomainMeta[id].name}</b><span>{specialDomainMeta[id].description}</span></button>)}</div>
    <DataState loading={loading} error={error} empty={!loading && !error && rows.length === 0} loadingLabel={`正在加载${specialDomainMeta[domain].name}...`} emptyLabel="当前接口没有返回记录，未使用 Mock 数据替代" />
    {warnings.map((warning) => <div className="card-data-warning" key={warning}>{warning}</div>)}
    <div className="channel-source"><span className="status-dot" /><b>{loading ? "真实数据加载中" : "真实 API"}</b><span>接口记录 {total.toLocaleString()} 条，本次载入 {rows.length} 条</span></div>
    <div className="channel-kpis special-kpis"><div><span><FieldLabel label="接口记录" /></span><b>{total.toLocaleString()}</b></div><div><span><FieldLabel label={domain === "navigation" ? "点击次数" : domain === "cnzz" ? "下载次数" : domain === "snapshots" ? "浏览次数" : "当前数据"} /></span><b>{primary.toLocaleString()}</b></div><div><span><FieldLabel label={domain === "navigation" ? "点击人数" : domain === "cnzz" ? "用户数" : domain === "snapshots" ? "点赞数" : "载入记录"} /></span><b>{secondary.toLocaleString()}</b></div></div>
    {["navigation", "cnzz", "snapshots"].includes(domain) && <section className="card special-chart"><div className="chart-card-head"><div><div className="card-title"><span>{specialDomainMeta[domain].name}排行</span><small>真实接口前 15 项</small></div></div></div>{rows.length ? <Chart option={chartOption} /> : <div className="empty-preview">当前条件下暂无数据</div>}</section>}
    <section className="card channel-table"><div className="chart-card-head"><div><div className="card-title"><span>{specialDomainMeta[domain].name}明细</span><small>接口字段归一化</small></div></div><button onClick={() => downloadCsv(`${specialDomainMeta[domain].name}-${platformKey}-${range}.csv`, displayRows as Record<string, string | number>[])}>导出</button></div><DataTable rows={displayRows as Record<string, string | number>[]} /></section>
  </section>;
}

interface DataSourceStatus {
  site: "primary" | "secondary";
  configured: boolean;
  tokenHint: string;
  updatedAt: string | null;
  userName: string;
}

function DataSourceMaintenance() {
  const secureContext = window.location.protocol === "https:" || ["localhost", "127.0.0.1"].includes(window.location.hostname);
  const [keyDraft, setKeyDraft] = useState("");
  const [authorized, setAuthorized] = useState(false);
  const [statuses, setStatuses] = useState<DataSourceStatus[]>([]);
  const [tokens, setTokens] = useState({ primary: "", secondary: "" });
  const [busySite, setBusySite] = useState<"primary" | "secondary" | null>(null);
  const [message, setMessage] = useState("");

  const request = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(path, { ...init, credentials: "same-origin", headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
    const payload = await readJsonResponse<{ success: boolean; data?: unknown; error?: { message?: string } }>(response, "数据源维护服务");
    if (!response.ok || !payload.success) throw new Error(payload.error?.message ?? "数据源维护请求失败");
    return payload.data;
  };
  const loadStatus = async () => {
    const data = await request("/api/bi/admin/data-sources/status") as DataSourceStatus[];
    setStatuses(data); setAuthorized(true); setMessage("");
  };
  useEffect(() => {
    if (!secureContext) {
      const timer = window.setTimeout(() => window.location.assign(secureMaintenanceUrl()), 800);
      return () => window.clearTimeout(timer);
    }
    loadStatus().catch(() => setAuthorized(false));
    return undefined;
  }, [secureContext]);
  const login = async () => {
    try {
      await request("/api/bi/admin/auth/login", { method: "POST", body: JSON.stringify({ password: keyDraft }) });
      setKeyDraft("");
      await loadStatus();
    }
    catch (error) { setMessage(error instanceof Error ? error.message : "维护密码验证失败"); }
  };
  const logout = async () => {
    await request("/api/bi/admin/auth/logout", { method: "POST" }).catch(() => undefined);
    setAuthorized(false);
    setStatuses([]);
    setTokens({ primary: "", secondary: "" });
  };
  const testSite = async (site: "primary" | "secondary") => {
    setBusySite(site); setMessage("");
    try { await request("/api/bi/admin/data-sources/test", { method: "POST", body: JSON.stringify({ site }) }); setMessage(`${site === "primary" ? "站1" : "站2"} 当前 Token 连接正常`); }
    catch (error) { setMessage(error instanceof Error ? error.message : "连接测试失败"); }
    finally { setBusySite(null); }
  };
  const saveSite = async (site: "primary" | "secondary") => {
    const token = tokens[site].trim();
    if (!token) { setMessage("请先输入新 Token"); return; }
    setBusySite(site); setMessage("");
    try {
      await request("/api/bi/admin/data-sources/token", { method: "PUT", body: JSON.stringify({ site, token }) });
      setTokens((current) => ({ ...current, [site]: "" }));
      await loadStatus();
      setMessage(`${site === "primary" ? "站1" : "站2"} Token 已验证并立即生效`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Token 更新失败，旧 Token 已保留"); }
    finally { setBusySite(null); }
  };
  if (!secureContext) return <section className="data-source-page"><div className="maintenance-login insecure"><span>安全跳转</span><h1>正在打开数据源配置</h1><p>为避免密码和 Token 被截获，即将自动切换到同一系统的 HTTPS 配置页。</p><button className="primary-btn" onClick={() => window.location.assign(secureMaintenanceUrl())}>立即进入安全配置页</button></div></section>;
  if (!authorized) return <section className="data-source-page"><div className="maintenance-login"><span>受保护配置</span><h1>数据源维护</h1><p>请输入独立维护密码。连续输错 5 次将锁定当前 IP 15 分钟。</p><label><b>维护密码</b><input type="password" autoComplete="current-password" value={keyDraft} onChange={(event) => setKeyDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") login(); }} /></label><button className="primary-btn" disabled={keyDraft.length < 12} onClick={login}>进入维护页面</button>{message && <em>{message}</em>}</div></section>;
  return <section className="data-source-page">
    <div className="data-source-head"><div><span>系统配置</span><h1>数据源维护</h1><p>Token 保存前会请求真实后台验证；验证失败不会覆盖当前凭证。</p></div><button onClick={logout}>退出维护</button></div>
    {message && <div className="maintenance-message">{message}</div>}
    <div className="source-site-grid">{(["primary", "secondary"] as const).map((site) => {
      const status = statuses.find((item) => item.site === site);
      const siteOne = site === "primary";
      return <article className="source-site-card" key={site}><div className="source-site-title"><div><i className={status?.configured ? "ready" : ""} /><span>{siteOne ? "站1" : "站2"}</span><b>{siteOne ? "主后台" : "第二后台"}</b></div><em>{status?.configured ? "已配置" : "未配置"}</em></div><dl><div><dt>请求用户名</dt><dd>{status?.userName || "--"}</dd></div><div><dt>当前 Token</dt><dd>{status?.tokenHint ?? "--"}</dd></div><div><dt>页面更新时间</dt><dd>{status?.updatedAt ? new Date(status.updatedAt).toLocaleString("zh-CN") : "由服务器环境变量提供"}</dd></div><div><dt>平台范围</dt><dd>{siteOne ? "PH 等主站平台" : "FBI、BZMH、TJD 等第二站平台"}</dd></div></dl><label><span>粘贴新 Token</span><input type="password" autoComplete="new-password" placeholder="Token 不会在保存后回显" value={tokens[site]} onChange={(event) => setTokens((current) => ({ ...current, [site]: event.target.value }))} /></label><small>仅更新 Token；请求地址、用户名和 PID 路由仍由服务器配置管理。</small><div className="source-site-actions"><button disabled={busySite !== null} onClick={() => testSite(site)}>{busySite === site ? "验证中..." : "测试当前连接"}</button><button className="primary-btn" disabled={busySite !== null || !tokens[site].trim()} onClick={() => saveSite(site)}>{busySite === site ? "验证并保存中..." : "验证并保存"}</button></div></article>;
    })}</div>
    <div className="credential-security-note"><b>安全说明</b><span>Token 只发送给本站 BI 后端，浏览器不保存、不回显；服务器以仅 root 可读文件保存。维护密码只用于登录，登录后使用30分钟安全会话，浏览器脚本无法读取会话凭证。</span></div>
  </section>;
}

export function LegacyApp() {
  const [templates, setTemplates] = useState<DashboardTemplate[]>(loadTemplatesFromStorage);
  const [cardAssets, setCardAssets] = useState<CardAsset[]>(loadCardAssetsFromStorage);
  const [templateId, setTemplateId] = useState(dashboardTemplates[0].id);
  const [drill, setDrill] = useState<DrilldownPayload | null>(null);
  const [workspace, setWorkspace] = useState<Workspace>(initialWorkspace);
  const [activeCreateModel, setActiveCreateModel] = useState<AnalysisModelId>("content_position");
  const [draftTemplate, setDraftTemplate] = useState<DashboardTemplate>(() => createCardDraft("content_position"));
  const [draftHistory, setDraftHistory] = useState<DashboardTemplate[]>([]);
  const [editingAssetId, setEditingAssetId] = useState<string | null>(null);
  const [workspaceHydrated, setWorkspaceHydrated] = useState(false);
  const [workspaceRemoteAvailable, setWorkspaceRemoteAvailable] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => loadPersisted("bi-sidebar-collapsed", false));
  const [globalFilters, setGlobalFilters] = useState<DashboardFilters>(() => loadPersisted("bi-global-filters", { dateRange: "近7日", mode: "all", platforms: ["Pornhub", "TikTok"] }));
  const template = templates.find((item) => item.id === templateId) ?? templates[0];
  const systemSurface = systemSurfaceTemplates.find((item) => item.id === templateId) ?? null;
  const modernActive = uiVersion === "v13";
  const workspaceLabel: Record<Workspace, string> = { templates: "看板中心", cards: "分析中心", cardFactory: "创建分析", templateFactory: "模板管理", dictionary: "数据字典", dataSources: "数据源维护" };
  useBodyScrollLock(Boolean(drill) || (modernActive && navOpen));
  useEffect(() => {
    if (!modernActive) setNavOpen(false);
  }, [modernActive]);
  useEffect(() => {
    try { localStorage.setItem("bi-sidebar-collapsed", JSON.stringify(sidebarCollapsed)); } catch { /* 保持当前会话状态 */ }
  }, [sidebarCollapsed]);
  useEffect(() => {
    try {
      localStorage.setItem("bi-templates-v3-api", JSON.stringify(templates));
      localStorage.setItem("bi-card-assets-v3-api", JSON.stringify(cardAssets));
    } catch {
      notify("浏览器本地备份失败，服务器仍会继续保存");
    }
  }, [cardAssets, templates]);
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("workspace", workspace);
    window.history.replaceState(null, "", url);
  }, [workspace]);
  useEffect(() => {
    const restoreWorkspace = () => setWorkspace(initialWorkspace());
    window.addEventListener("popstate", restoreWorkspace);
    return () => window.removeEventListener("popstate", restoreWorkspace);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/bi/workspace", { signal: controller.signal }).then(async (response) => {
      const payload = await readJsonResponse<{ success: boolean; data?: { templates?: unknown; cardAssets?: unknown } | null }>(response, "工作区服务");
      if (!response.ok || !payload.success) throw new Error("工作区读取失败");
      setWorkspaceRemoteAvailable(true);
      if (payload.data) {
        const remoteTemplates = normalizeTemplates(payload.data.templates);
        setTemplates((current) => normalizeTemplates(mergeTemplatesByRecency(remoteTemplates, current)));
        if (Array.isArray(payload.data.cardAssets) && payload.data.cardAssets.length) {
          setCardAssets((current) => mergeCardAssets(normalizeCardAssets(payload.data?.cardAssets), current));
        }
      }
    }).catch((error) => {
      if (!controller.signal.aborted) notify(error instanceof Error ? `${error.message}，当前使用浏览器本地数据` : "工作区服务暂时不可用，当前使用浏览器本地数据");
    }).finally(() => { if (!controller.signal.aborted) setWorkspaceHydrated(true); });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!workspaceHydrated || !workspaceRemoteAvailable) return undefined;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      fetch("/api/bi/workspace", { method: "PUT", headers: { "content-type": "application/json" }, signal: controller.signal, body: JSON.stringify({ schemaVersion: 1, templates, cardAssets }) })
        .then((response) => { if (!response.ok) throw new Error("工作区保存失败"); })
        .catch((error) => { if (!controller.signal.aborted) notify(error instanceof Error ? error.message : "工作区保存失败"); });
    }, 500);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [cardAssets, templates, workspaceHydrated, workspaceRemoteAvailable]);
  const changeCreateModel = (modelId: AnalysisModelId) => {
    setActiveCreateModel(modelId);
    setDraftTemplate(createCardDraft(modelId));
    setDraftHistory([]);
    setEditingAssetId(null);
  };
  const navigateWorkspace = (nextWorkspace: Workspace) => {
    if (nextWorkspace === workspace) {
      setNavOpen(false);
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set("workspace", nextWorkspace);
    window.history.pushState({ workspace: nextWorkspace }, "", url);
    setWorkspace(nextWorkspace);
    setNavOpen(false);
  };
  const startCreateCard = (modelId: AnalysisModelId = activeCreateModel) => {
    setActiveCreateModel(modelId);
    setDraftTemplate(createCardDraft(modelId));
    setDraftHistory([]);
    setEditingAssetId(null);
    setWorkspace("cardFactory");
  };
  const saveCardAsset = () => {
    if (!draftTemplate.name.trim() || !draftTemplate.cards.length) {
      notify("请填写卡片名称并保留至少一张分析卡片");
      return;
    }
    const issues = draftTemplate.cards.flatMap((card) => validateCardCapability(card).issues);
    if (issues.length) {
      notify(`当前配置超出 API 能力：${issues[0]}`);
      return;
    }
    const stamp = Date.now();
    if (editingAssetId) {
      const mainCard = draftTemplate.cards[0];
      setCardAssets((current) => current.map((asset) => asset.id === editingAssetId ? { ...asset, name: draftTemplate.name, description: draftTemplate.scenario, config: { ...mainCard, id: asset.config.id, title: draftTemplate.name }, updatedAt: new Date().toISOString() } : asset));
      notify("卡片修改已保存");
    } else {
      const assets = draftTemplate.cards.map((card, index): CardAsset => ({
        id: `asset-${stamp}-${index}`,
        name: index === 0 ? draftTemplate.name : `${draftTemplate.name} · 明细`,
        description: draftTemplate.scenario,
        config: { ...card, id: `asset-card-${stamp}-${index}`, title: index === 0 ? draftTemplate.name : `${draftTemplate.name} · 明细` },
        updatedAt: new Date().toISOString()
      }));
      setCardAssets((current) => [...assets, ...current]);
      notify(`已保存 ${assets.length} 张分析卡片`);
    }
    setEditingAssetId(null);
    setDraftHistory([]);
    setWorkspace("cards");
  };
  const updateDraft = (next: DashboardTemplate) => {
    setDraftHistory((current) => [...current.slice(-19), draftTemplate]);
    setDraftTemplate(next);
  };
  const undoDraft = () => {
    const previous = draftHistory.at(-1);
    if (!previous) return;
    setDraftTemplate(previous);
    setDraftHistory((current) => current.slice(0, -1));
  };
  const exitCardFactory = () => {
    if (draftHistory.length > 0 && !window.confirm("当前修改尚未保存，确认返回卡片库？")) return;
    setEditingAssetId(null);
    setDraftHistory([]);
    setWorkspace("cards");
  };

  return <div className={`app${modernActive ? ` ui-v13 workspace-${workspace}${sidebarCollapsed ? " sidebar-collapsed" : ""}` : ""}`}>
    {modernActive ? <PlatformTopbar section={workspaceLabel[workspace]} status={<QueryHealth />} onOpenNavigation={() => setNavOpen(true)} onNavigateHome={() => navigateWorkspace("templates")} /> : <header className="topbar"><div><b>多平台经营分析 BI</b><span>真实数据 · 受控自助分析</span></div><QueryHealth /></header>}
    <main className={workspace === "templateFactory" ? `layout template-editor-shell${modernActive ? " platform-layout platform-template-layout" : ""}` : workspace === "cardFactory" ? `layout card-factory-layout${modernActive ? " platform-layout" : ""}` : workspace === "templates" ? `layout dashboard-layout${modernActive ? " platform-dashboard-layout platform-layout" : ""}` : `layout compact-workspace-layout${modernActive ? " platform-layout" : ""}`}>
      {modernActive ? <PlatformSidebar active={workspace} version={uiVersion} open={navOpen} collapsed={sidebarCollapsed} onClose={() => setNavOpen(false)} onToggleCollapse={() => setSidebarCollapsed((current) => !current)} onNavigate={(next) => navigateWorkspace(next as Workspace)} /> : workspace !== "templateFactory" && <WorkspaceNav active={workspace} />}
      {workspace === "templates" && <section className="main-panel dashboard-workspace">
        {(!modernActive || systemSurface) && <div className="dashboard-command-bar"><TemplateCenter templates={templates} surfaces={systemSurfaceTemplates} activeId={templateId} onChange={setTemplateId} /><GlobalFilterBar filters={globalFilters} onChange={setGlobalFilters} /></div>}
        {systemSurface?.id === "system-content-categories" && <ContentDashboard filters={globalFilters} />}
        {systemSurface?.id === "system-channels" && <ChannelDashboard filters={globalFilters} />}
        {systemSurface?.id === "system-special" && <SpecialDashboard filters={globalFilters} />}
        {!systemSurface && <DashboardRenderer template={template} filters={globalFilters} onDrill={setDrill} onSaveLayout={(cards) => setTemplates((current) => current.map((item) => item.id === template.id ? { ...item, cards, updatedAt: "刚刚" } : item))} toolbar={modernActive ? <><TemplateCenter templates={templates} surfaces={systemSurfaceTemplates} activeId={templateId} onChange={setTemplateId} /><GlobalFilterBar filters={globalFilters} onChange={setGlobalFilters} /></> : undefined} modern={modernActive} />}
      </section>}
      {workspace === "cards" && <section className="main-panel span-workspace"><CardLibrary assets={cardAssets} onCreate={() => startCreateCard("content_position")} onEdit={(asset) => { setDraftTemplate({ ...createCardDraft(asset.config.model), name: asset.name, scenario: asset.description, cards: [asset.config] }); setDraftHistory([]); setEditingAssetId(asset.id); setActiveCreateModel(asset.config.model); setWorkspace("cardFactory"); }} onDuplicate={(asset) => { const stamp = Date.now(); setCardAssets((current) => [{ ...asset, id: `asset-${stamp}`, name: `${asset.name} 副本`, config: { ...asset.config, id: `asset-card-${stamp}`, title: `${asset.name} 副本` }, updatedAt: "刚刚" }, ...current]); notify("卡片副本已创建"); }} onDelete={(id) => { if (window.confirm("确认删除这张分析卡片？模板中已使用的副本不会受到影响。")) { setCardAssets((current) => current.filter((asset) => asset.id !== id)); notify("卡片已删除"); } }} /></section>}
      {workspace === "cardFactory" && <section className="main-panel create-main">
        <AnalysisTypeCenter activeId={activeCreateModel} onChange={changeCreateModel} />
        <AnalysisCreator modelId={activeCreateModel} draft={draftTemplate} onDraftChange={updateDraft} onUndo={undoDraft} canUndo={draftHistory.length > 0} onSave={saveCardAsset} onExit={exitCardFactory} />
      </section>}
      {workspace === "templateFactory" && <section className="main-panel template-editor-workspace"><TemplateFactory templates={templates} assets={cardAssets} activeTemplateId={templateId} filters={globalFilters} onTemplateChange={setTemplateId} onTemplatesChange={setTemplates} onCreateCard={() => startCreateCard("content_position")} onDrill={setDrill} onExit={() => setWorkspace("templates")} /></section>}
      {workspace === "dictionary" && <section className="main-panel span-workspace"><Dictionaries onUseModel={startCreateCard} /></section>}
      {workspace === "dataSources" && <section className="main-panel span-workspace"><DataSourceMaintenance /></section>}
    </main>
    <Drawer payload={drill} onClose={() => setDrill(null)} />
    <ToastHost />
  </div>;
}
