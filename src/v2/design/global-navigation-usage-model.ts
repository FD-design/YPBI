import type { DateRangeValue } from "../../components/ui/date-range-model";
import type { CalculationBasis } from "../features/dashboards/CalculationEvidence";
import { demoPrevious, validDemoRange } from "./extended-board-model";
import type { WorkbookCell, WorkbookSheet } from "./preview-workbook";
import { usageObservations, validUsageScope, type UsageObservation } from "./usage-observation-fixtures";

export const GLOBAL_NAVIGATION_MARKER = "GLOBAL_NAVIGATION_USAGE_DEV_ONLY";
export const NAVIGATION_TABS = Array.from({ length: 5 }, (_, index) => ({ id: `demo-global-tab-${index + 1}`, name: `演示导航 ${String(index + 1).padStart(2, "0")}`, position: index + 1 }));
export const NAVIGATION_MEASURES = [
  { id: "penetration", name: "渗透率", unit: "%" }, { id: "users", name: "点击用户数", unit: "人" },
  { id: "clicks", name: "点击次数", unit: "次" }, { id: "frequency", name: "使用者人均点击次数", unit: "次/人" },
] as const;
export type NavigationMeasure = typeof NAVIGATION_MEASURES[number]["id"];
export interface NavigationView { selected: string | null; measure: NavigationMeasure }
export const DEFAULT_NAVIGATION_VIEW: NavigationView = { selected: null, measure: "penetration" };
export function parseNavigationView(value: unknown): NavigationView | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>, keys = Object.keys(v).sort().join();
  if (!(v.selected === null || NAVIGATION_TABS.some(tab => tab.id === v.selected)) || !NAVIGATION_MEASURES.some(metric => metric.id === v.measure)) return null;
  const view = { selected: v.selected as string | null, measure: v.measure as NavigationMeasure };
  if (keys === "measure,selected") return view;
  // Existing navigation links retain their Tab and measure in the overall view.
  if (keys === "measure,scope,selected" && validUsageScope(v.scope)) return view;
  if (keys === "dimension,measure,selected" && ["overall", "platform", "userType"].includes(v.dimension as string)) return view;
  return null;
}
export const validNavigationView = (value: unknown) => parseNavigationView(value) !== null;
export type NavigationStatus = "完整" | "未配置" | "未产出" | "部分数据" | "查询失败";
export interface NavigationReading { tabId: string; name: string; position: number; users: number | null; clicks: number | null; active: number | null; penetration: number | null; frequency: number | null; status: NavigationStatus }
export interface NavigationDay extends NavigationReading { date: string }
export interface NavigationPeriod { label: string; range: DateRangeValue; summary: NavigationReading[]; daily: NavigationDay[] }
export interface NavigationSnapshot { periods: NavigationPeriod[]; sheets: WorkbookSheet[] }
export const navigationReading = (period: NavigationPeriod | undefined, tabId: string) => period?.summary.find(row => row.tabId === tabId);
const overallObservation = (row: UsageObservation) => row.scope.client === "overall" && row.scope.audience === "overall";

function period(range: DateRangeValue, label: string, mixed: boolean, recovered: string[]): NavigationPeriod {
  const summary: NavigationReading[] = [], daily: NavigationDay[] = [];
  NAVIGATION_TABS.forEach((tab, index) => {
    const facts = usageObservations(range, index + 2, mixed && index === 0);
    const status = (date?: string): NavigationStatus => {
      if (!mixed || recovered.includes(tab.id)) return "完整";
      if (index === 1) return "未配置";
      if (index === 3) return "查询失败";
      if (index === 2 && (!date || date === range.end)) return !date && range.start !== range.end ? "部分数据" : "未产出";
      return "完整";
    };
    const read = (row: UsageObservation, state: NavigationStatus): NavigationReading => {
      const complete = state === "完整", users = complete ? row.users : null, active = complete ? row.active : null, clicks = complete ? row.clicks : null;
      return { tabId: tab.id, name: tab.name, position: tab.position, users, active, clicks,
        penetration: users !== null && active ? users / active : null, frequency: users && clicks !== null ? clicks / users : null, status: state };
    };
    summary.push(...facts.summary.filter(overallObservation).map(row => read(row, status())));
    daily.push(...facts.daily.filter(overallObservation).map(row => ({ date: row.date, ...read(row, status(row.date)) })));
  });
  return { label, range, summary, daily };
}

export function navigationFormat(measure: NavigationMeasure | "active", value: number | null) {
  if (value === null) return "—";
  return measure === "penetration" ? `${(value * 100).toFixed(2)}%` : measure === "frequency" ? value.toFixed(2) : value.toLocaleString("zh-CN");
}
export function navigationBasis(reading: NavigationReading, measure: NavigationMeasure, scope: string): CalculationBasis | undefined {
  if (measure !== "penetration" && measure !== "frequency") return undefined;
  const rate = measure === "penetration";
  return { formula: rate ? "点击用户数 ÷ 同范围活跃用户数 × 100%" : "点击次数 ÷ 点击用户数", scope,
    numerator: { name: rate ? "点击用户数" : "点击次数", value: rate ? reading.users : reading.clicks, unit: rate ? "人" : "次" },
    denominator: { name: rate ? "同范围活跃用户数" : "点击用户数", value: rate ? reading.active : reading.users, unit: "人" },
    result: navigationFormat(measure, reading[measure]), percentage: rate };
}
export const navigationResultHeaders = ["点击用户数", "点击次数", "同范围活跃用户数", "渗透率（%）", "使用者人均点击次数（次/人）", "状态"];
export const navigationResultCells = (row: NavigationReading): WorkbookCell[] => [row.users, row.clicks, row.active, row.penetration === null ? null : row.penetration * 100, row.frequency, row.status];
const identity = (row: NavigationReading): WorkbookCell[] => [row.name, row.tabId, row.position];
export function navigationSheets(periods: NavigationPeriod[]): WorkbookSheet[] {
  const identityHeaders = ["导航", "稳定演示Tab ID", "位置"];
  return [
    { name: "05_全局导航", rows: [["周期", "开始日期", "结束日期", ...identityHeaders, ...navigationResultHeaders], ...periods.flatMap(p => p.summary.map(row => [p.label, p.range.start, p.range.end, ...identity(row), ...navigationResultCells(row)]))] },
    { name: "06_导航逐日", rows: [["周期", "实际日期", ...identityHeaders, ...navigationResultHeaders], ...periods.flatMap(p => p.daily.map(row => [p.label, row.date, ...identity(row), ...navigationResultCells(row)]))] },
  ];
}
export function navigationSnapshot(range: DateRangeValue, compared: boolean, mixed = false, recovered: string[] = []): NavigationSnapshot {
  if (!validDemoRange(range)) throw new Error("导航演示日期无效");
  const periods = [period(range, "当前期", mixed, recovered), ...(compared ? [period(demoPrevious(range), "对比期", false, [])] : [])];
  return { periods, sheets: navigationSheets(periods) };
}
