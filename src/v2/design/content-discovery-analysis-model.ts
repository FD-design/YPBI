import type { DateRangeValue } from "../../components/ui/date-range-model";
import { changeDirection } from "../../components/ui/change-presentation";
import type { CalculationBasis } from "../features/dashboards/CalculationEvidence";
import type { DashboardMetricCardModel, DashboardMetricTrendPoint } from "../features/dashboards/dashboard-metric-card-model";
import type { WorkbookSheet } from "./preview-workbook";
import {
  demoCalculationBasis,
  demoCategories,
  demoDates,
  demoMetric,
  demoPrevious,
  demoRangeLabel,
  demoResult,
  demoUnit,
  demoValue,
  extendedMetricModel,
  type DemoCategory
} from "./extended-board-model";

export type BoardSortOrder = "position" | "desc";

export function orderBoardRows<T extends { position: number }>(rows: readonly T[], order: BoardSortOrder, value: (row: T) => number) {
  return [...rows].sort((left, right) => order === "desc" ? value(right) - value(left) || left.position - right.position : left.position - right.position);
}

export interface ContentPositionRow extends DemoCategory {
  page: string;
  list: string;
  current: CalculationBasis;
  comparison: CalculationBasis;
}

const CONTENT_CONTEXTS = [
  ["演示页面 A", "演示列表 01"], ["演示页面 A", "演示列表 02"],
  ["演示页面 B", "演示列表 01"], ["演示页面 B", "演示列表 02"],
  ["演示页面 C", "演示列表 01"], ["演示页面 C", "演示列表 02"],
  ["演示页面 D", "演示列表 01"], ["演示页面 D", "演示列表 02"]
] as const;

export function contentDiscoveryOverall(range: DateRangeValue) {
  const current = demoCalculationBasis("M044", range);
  const comparison = demoCalculationBasis("M044", demoPrevious(range));
  if (!current || !comparison) throw new Error("M044 缺少权威计算关系");
  return { current, comparison };
}

export function contentPositionRows(range: DateRangeValue): ContentPositionRow[] {
  return demoCategories("位置").map((category, index) => {
    const current = demoCalculationBasis("M044", range, index + 1);
    const comparison = demoCalculationBasis("M044", demoPrevious(range), index + 1);
    if (!current || !comparison) throw new Error("M044 位置结果缺少权威计算关系");
    return { ...category, name: `演示位置 ${String(index + 1).padStart(2, "0")}`, page: CONTENT_CONTEXTS[index][0], list: CONTENT_CONTEXTS[index][1], current, comparison };
  });
}

export const contentPositionTrendModel = (range: DateRangeValue, compared: boolean, position: number) =>
  extendedMetricModel("M044", range, compared, false, position);

export interface SearchDemandRow extends DemoCategory {
  searches: number;
  users: number;
  conversion: CalculationBasis;
  comparisonSearches: number;
  comparisonUsers: number;
  comparisonConversion: CalculationBasis;
}

export function searchDemandRows(range: DateRangeValue, group: "搜索词" | "搜索类型"): SearchDemandRow[] {
  const before = demoPrevious(range);
  return demoCategories(group).map((category, index) => {
    const position = index + 1;
    const conversion = demoCalculationBasis("M046", range, position);
    const comparisonConversion = demoCalculationBasis("M046", before, position);
    if (!conversion || !comparisonConversion) throw new Error("M046 缺少权威计算关系");
    return {
      ...category,
      searches: demoResult("M092", range, position),
      users: demoResult("M093", range, position),
      conversion,
      comparisonSearches: demoResult("M092", before, position),
      comparisonUsers: demoResult("M093", before, position),
      comparisonConversion
    };
  });
}

export const searchDemandTrendModel = (id: "M092" | "M093" | "M046", range: DateRangeValue, compared: boolean, position: number) =>
  extendedMetricModel(id, range, compared, false, position);

const rawResult = (basis: CalculationBasis) => basis.denominator.value && basis.numerator.value !== null ? basis.numerator.value / basis.denominator.value : null;
const percent = (basis: CalculationBasis) => { const value = rawResult(basis); return value === null ? null : value * 100; };

export function contentDiscoverySheet(range: DateRangeValue, compared: boolean, order: BoardSortOrder = "position"): WorkbookSheet {
  const overall = contentDiscoveryOverall(range);
  const rows = orderBoardRows(contentPositionRows(range), order, row => rawResult(row.current) ?? -Infinity);
  return {
    name: "内容发现总体与位置",
    rows: [
      ["指标", "视频内容曝光-点击转化率"],
      ["计算规则", overall.current.formula],
      ["总体匹配点击数", overall.current.numerator.value, "总体合格曝光数", overall.current.denominator.value, "总体转化率（%）", percent(overall.current)],
      [],
      ["页面", "列表", "位置", "稳定标识", overall.current.numerator.name, overall.current.denominator.name, "转化率（%）", ...(compared ? ["对比匹配点击", "对比合格曝光", "对比转化率（%）"] : []), "状态"],
      ...rows.map(row => [row.page, row.list, row.name, row.key, row.current.numerator.value, row.current.denominator.value, percent(row.current), ...(compared ? [row.comparison.numerator.value, row.comparison.denominator.value, percent(row.comparison)] : []), "隔离演示"])
    ]
  };
}

const searchSortValue = (id: "M092" | "M093" | "M046", row: SearchDemandRow) =>
  id === "M092" ? row.searches : id === "M093" ? row.users : rawResult(row.conversion) ?? -Infinity;

export function searchDemandSheet(range: DateRangeValue, compared: boolean, group: "搜索词" | "搜索类型" = "搜索词", order: BoardSortOrder = "position", sortId: "M092" | "M093" | "M046" = "M092"): WorkbookSheet {
  const rows = orderBoardRows(searchDemandRows(range, group), order, row => searchSortValue(sortId, row));
  return {
    name: "搜索规模与承接",
    rows: [
      ["指标", "搜索次数、搜索用户数、搜索结果-内容点击转化率"],
      ["承接计算规则", rows[0]?.conversion.formula ?? ""],
      [],
      [group, "稳定标识", "位置", "搜索次数", "搜索用户数", rows[0]?.conversion.numerator.name ?? "承接分子", rows[0]?.conversion.denominator.name ?? "承接分母", "搜索承接率（%）", ...(compared ? ["对比搜索次数", "对比搜索用户数", "对比承接分子", "对比承接分母", "对比承接率（%）"] : []), "状态"],
      ...rows.map(row => [row.name, row.key, row.position, row.searches, row.users, row.conversion.numerator.value, row.conversion.denominator.value, percent(row.conversion), ...(compared ? [row.comparisonSearches, row.comparisonUsers, row.comparisonConversion.numerator.value, row.comparisonConversion.denominator.value, percent(row.comparisonConversion)] : []), "隔离演示"])
    ]
  };
}

export interface VideoClickSourceDefinition {
  key: string;
  position: number;
  pageId: string;
  pageName: string;
  listId: string;
  listName: string;
  tabGroupId: string | null;
  tabId: string | null;
  tabName: string | null;
}

export interface VideoClickSourceRow extends VideoClickSourceDefinition {
  current: number;
  comparison: number;
}

const videoSource = (
  position: number,
  pageId: string,
  pageName: string,
  listId: string,
  listName: string,
  tab?: readonly [groupId: string, tabId: string, tabName: string]
): VideoClickSourceDefinition => ({
  key: pageId + "/" + listId + "/" + (tab?.[0] ?? "none") + "/" + (tab?.[1] ?? "none"),
  position,
  pageId,
  pageName,
  listId,
  listName,
  tabGroupId: tab?.[0] ?? null,
  tabId: tab?.[1] ?? null,
  tabName: tab?.[2] ?? null
});

/**
 * Isolated DEV source catalog. Stable keys mirror already registered page/list
 * contexts, but values below are synthetic and never masquerade as connected data.
 */
export const VIDEO_CLICK_SOURCES: readonly VideoClickSourceDefinition[] = [
  videoSource(1, "video_home", "视频首页", "video_primary_feed", "主内容流", ["video_channel", "tiktok_featured", "TikTok 精选"]),
  videoSource(2, "video_home", "视频首页", "video_primary_feed", "主内容流", ["video_channel", "selected", "精选"]),
  videoSource(3, "video_home", "视频首页", "video_primary_feed", "主内容流", ["video_channel", "vip_zone", "VIP 专区"]),
  videoSource(4, "video_home", "视频首页", "video_today_featured", "今日精选"),
  videoSource(5, "video_home", "视频首页", "video_home_rank_tiktok_featured", "排行 · TikTok 精品"),
  videoSource(6, "video_home", "视频首页", "video_home_rank_latest", "排行 · 最新上架"),
  videoSource(7, "video_home", "视频首页", "video_home_rank_most_viewed", "排行 · 最多观看"),
  videoSource(8, "video_home", "视频首页", "video_home_rank_most_favorited", "排行 · 最多收藏"),
  videoSource(9, "search_home", "搜索首页", "search_recommended_video", "推荐视频"),
  videoSource(10, "search_results", "搜索结果", "search_result_video", "视频结果"),
  videoSource(11, "video_detail", "视频详情", "video_detail_related", "猜你喜欢"),
  videoSource(12, "my_records", "我的记录", "video_history_list", "浏览记录 · 视频"),
  videoSource(13, "my_records", "我的记录", "video_favorites_list", "收藏 · 视频"),
  videoSource(14, "my_records", "我的记录", "video_liked_list", "喜欢 · 视频"),
  videoSource(15, "user_profile", "作者主页", "creator_profile_video_list", "作者视频"),
  videoSource(16, "acg_home", "ACG 内容中心", "acg_anime_video_list", "动漫视频"),
  videoSource(17, "dark_web_home", "暗网首页", "dark_web_video_feed", "暗网视频流", ["dark_web_content_type", "video", "视频"]),
  videoSource(18, "short_video_feed", "短视频 Feed", "short_video_feed", "沉浸式短视频"),
  videoSource(19, "unknown", "未知来源", "unknown", "待治理来源")
];

export interface VideoClickSourceDailyFact extends VideoClickSourceDefinition {
  date: string;
  clicks: number;
}

const sourceObservation = (date: string, source: VideoClickSourceDefinition) => {
  const day = Math.floor(Date.parse(date) / 86400000);
  const sourceScale = source.pageId === "unknown" ? 0.07 : Math.max(0.3, 1 - (source.position - 1) * 0.035);
  return Math.max(0, Math.round((4600 + 520 * Math.sin(day * 0.37 + source.position * 0.71)) * sourceScale));
};

export function videoClickSourceDailyFacts(range: DateRangeValue): VideoClickSourceDailyFact[] {
  return demoDates(range).flatMap(date => VIDEO_CLICK_SOURCES.map(source => ({ ...source, date, clicks: sourceObservation(date, source) })));
}

const clickTotals = <T extends { key: string; clicks: number }>(facts: readonly T[]) => {
  const totals = new Map<string, number>();
  for (const fact of facts) totals.set(fact.key, (totals.get(fact.key) ?? 0) + fact.clicks);
  return totals;
};

export function videoClickSourceRows(range: DateRangeValue): VideoClickSourceRow[] {
  const before = demoPrevious(range);
  const current = clickTotals(videoClickSourceDailyFacts(range));
  const comparison = clickTotals(videoClickSourceDailyFacts(before));
  return VIDEO_CLICK_SOURCES.map(source => ({
    ...source,
    current: current.get(source.key) ?? 0,
    comparison: comparison.get(source.key) ?? 0
  }));
}

export interface VideoHomeCategoryDailyFact extends DemoCategory {
  sourceKey: string;
  date: string;
  clicks: number;
}

export interface VideoHomeCategoryRow extends DemoCategory {
  current: number;
  comparison: number;
}

const allocateClicks = (total: number, weights: readonly number[]) => {
  const weightTotal = weights.reduce((sum, value) => sum + value, 0);
  const raw = weights.map(value => total * value / weightTotal);
  const allocated = raw.map(Math.floor);
  const remaining = total - allocated.reduce((sum, value) => sum + value, 0);
  const order = raw.map((value, index) => ({ index, remainder: value - allocated[index] }))
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index);
  for (let index = 0; index < remaining; index++) allocated[order[index % order.length].index] += 1;
  return allocated;
};

/**
 * Each isolated video-home click keeps its source key and receives one independent
 * first-level content category. Category IDs do not reuse navigation Tab IDs.
 */
export function videoHomeCategoryDailyFacts(range: DateRangeValue): VideoHomeCategoryDailyFact[] {
  const categories = demoCategories("一级内容分类");
  return videoClickSourceDailyFacts(range)
    .filter(fact => fact.pageId === "video_home")
    .flatMap(fact => {
      const day = Math.floor(Date.parse(fact.date) / 86400000);
      const weights = categories.map((_, index) => 1 + 0.22 * Math.sin(day * 0.19 + fact.position * 0.31 + index * 0.67));
      const values = allocateClicks(fact.clicks, weights);
      return categories.map((category, index) => ({ ...category, sourceKey: fact.key, date: fact.date, clicks: values[index] }));
    });
}

export function videoHomeCategoryRows(range: DateRangeValue): VideoHomeCategoryRow[] {
  const before = demoPrevious(range);
  const current = clickTotals(videoHomeCategoryDailyFacts(range));
  const comparison = clickTotals(videoHomeCategoryDailyFacts(before));
  return demoCategories("一级内容分类").map(category => ({
    ...category,
    current: current.get(category.key) ?? 0,
    comparison: comparison.get(category.key) ?? 0
  }));
}

const countDifference = (value: number) => (value > 0 ? "+" : "") + value.toLocaleString("zh-CN") + " 次";
const trendValue = (value: number, date: string) => ({ raw: value, display: demoValue("M109", value), actualDate: date });
const trendPoint = (date: string, value: number, counterpartDate: string | null, counterpartValue: number | null): DashboardMetricTrendPoint => ({
  key: date,
  label: date.slice(5),
  actualDate: date,
  value: trendValue(value, date),
  counterpart: counterpartDate === null || counterpartValue === null ? null : trendValue(counterpartValue, counterpartDate),
  differenceDisplay: counterpartValue === null ? null : countDifference(value - counterpartValue),
  state: "available",
  stateLabel: "完整"
});

/**
 * M109 summary, daily trend and source table all read the same generated click
 * facts. A source key narrows the model without deriving a new metric or UV.
 */
export function videoClickSourceMetricModel(range: DateRangeValue, compared: boolean, sourceKey?: string): DashboardMetricCardModel {
  const days = demoDates(range);
  const before = demoPrevious(range);
  const comparisonDays = demoDates(before);
  const sourceDefinition = sourceKey === undefined ? null : VIDEO_CLICK_SOURCES.find(item => item.key === sourceKey) ?? null;
  if (sourceKey !== undefined && sourceDefinition === null) throw new Error("未知的视频点击来源");
  const currentFacts = videoClickSourceDailyFacts(range);
  const comparisonFacts = videoClickSourceDailyFacts(before);
  const dailyTotals = (dates: readonly string[], facts: readonly VideoClickSourceDailyFact[]) => dates.map(date => facts
    .filter(fact => fact.date === date && (sourceKey === undefined || fact.key === sourceKey))
    .reduce((sum, fact) => sum + fact.clicks, 0));
  const dailyCurrent = dailyTotals(days, currentFacts);
  const dailyComparison = dailyTotals(comparisonDays, comparisonFacts);
  return videoClickMetricModel(
    range,
    compared,
    dailyCurrent,
    dailyComparison,
    sourceDefinition ? sourceDefinition.pageName + " / " + sourceDefinition.listName + (sourceDefinition.tabName ? " / " + sourceDefinition.tabName : "") : "全局来源合计",
    "两期使用相同的页面、列表与 Tab 来源键。"
  );
}

export function videoHomeCategoryMetricModel(range: DateRangeValue, compared: boolean, categoryKey: string): DashboardMetricCardModel {
  const category = demoCategories("一级内容分类").find(item => item.key === categoryKey);
  if (!category) throw new Error("未知的视频首页一级内容分类");
  const days = demoDates(range);
  const before = demoPrevious(range);
  const comparisonDays = demoDates(before);
  const currentFacts = videoHomeCategoryDailyFacts(range);
  const comparisonFacts = videoHomeCategoryDailyFacts(before);
  const totals = (dates: readonly string[], facts: readonly VideoHomeCategoryDailyFact[]) => dates.map(date => facts
    .filter(fact => fact.date === date && fact.key === categoryKey)
    .reduce((sum, fact) => sum + fact.clicks, 0));
  return videoClickMetricModel(
    range,
    compared,
    totals(days, currentFacts),
    totals(comparisonDays, comparisonFacts),
    `视频首页 / 一级内容分类 / ${category.name}`,
    "两期使用相同的一级内容分类标识；分类标识独立于导航 Tab。"
  );
}

function videoClickMetricModel(
  range: DateRangeValue,
  compared: boolean,
  dailyCurrent: readonly number[],
  dailyComparison: readonly number[],
  context: string,
  comparisonDetail: string
): DashboardMetricCardModel {
  const definition = demoMetric("M109");
  const days = demoDates(range);
  const before = demoPrevious(range);
  const comparisonDays = demoDates(before);
  const current = dailyCurrent.reduce((sum, value) => sum + value, 0);
  const comparison = dailyComparison.reduce((sum, value) => sum + value, 0);
  const difference = current - comparison;
  const pairedCurrent = days.map((date, index) => trendPoint(date, dailyCurrent[index], comparisonDays[index] ?? null, compared ? dailyComparison[index] ?? null : null));
  const pairedComparison = compared ? comparisonDays.map((date, index) => trendPoint(date, dailyComparison[index], days[index] ?? null, dailyCurrent[index] ?? null)) : null;
  const relative = comparison === 0 ? "—" : Math.abs(difference / comparison * 100).toFixed(1) + "%";
  return {
    metric: {
      id: definition.id,
      name: definition.name,
      aggregationLabel: demoRangeLabel(range) + " · 用户主动点击 · " + context,
      definitionLabel: definition.definition
    },
    result: {
      status: "available",
      completeness: "complete",
      refresh: { status: "idle" },
      value: { raw: current, display: demoValue("M109", current, false), unit: demoUnit("M109") },
      comparison: compared ? {
        status: "available",
        kind: "relative_change",
        label: "较对比周期",
        direction: changeDirection(difference),
        display: (difference > 0 ? "↑ " : difference < 0 ? "↓ " : "— ") + relative,
        detail: comparisonDetail,
        rows: [
          { label: "当前期", date: demoRangeLabel(range), value: demoValue("M109", current) },
          { label: "对比期", date: demoRangeLabel(before), value: demoValue("M109", comparison) }
        ],
        difference: { display: countDifference(difference), direction: changeDirection(difference) }
      } : null,
      trendKind: "line",
      trend: { current: pairedCurrent, comparison: pairedComparison },
      validationLabel: "演示数据",
      watermarkLabel: "隔离演示来源 · 数据至 " + range.end
    }
  };
}

export function videoClickSourceSheet(range: DateRangeValue, compared: boolean, order: BoardSortOrder = "desc"): WorkbookSheet {
  const rows = orderBoardRows(videoClickSourceRows(range), order, row => row.current);
  const total = rows.reduce((sum, row) => sum + row.current, 0);
  const comparisonTotal = rows.reduce((sum, row) => sum + row.comparison, 0);
  return {
    name: "全局视频点击来源",
    rows: [
      ["指标", demoMetric("M109").name],
      ["范围", demoRangeLabel(range), "总体点击次数", total, ...(compared ? ["对比总体点击次数", comparisonTotal] : [])],
      ["数据性质", "隔离演示来源事实，非正式来源查询"],
      [],
      ["页面", "page_name", "列表", "list_id", "Tab 上下文", "tab_group_id", "tab_id", "当前点击次数", ...(compared ? ["对比点击次数", "差值"] : []), "状态"],
      ...rows.map(row => [
        row.pageName,
        row.pageId,
        row.listName,
        row.listId,
        row.tabName ?? "不受 Tab 控制",
        row.tabGroupId,
        row.tabId,
        row.current,
        ...(compared ? [row.comparison, row.current - row.comparison] : []),
        "隔离演示"
      ])
    ]
  };
}
