import { preserveAuthenticatedReadingRoute } from "./reading-route";
import catalog from "./generated/function-catalog-preview.json";
import { demoDates, demoPrevious, validDemoRange, DEMO_RANGE } from "./extended-board-model";
import { shiftDate, type DateRangeValue } from "../../components/ui/date-range-model";
import type { DashboardMetricCardModel } from "../features/dashboards/dashboard-metric-card-model";
import { changeDirection } from "../../components/ui/change-presentation";
import { DEFAULT_NAVIGATION_VIEW, parseNavigationView, type NavigationView } from "./global-navigation-usage-model";
import { OVERALL_USAGE_SCOPE, usageObservations, usageScopeKey, usageScopeLabel, validUsageScope, type UsageScope } from "./usage-observation-fixtures";
import type { CalculationBasis } from "../features/dashboards/CalculationEvidence";

export const FUNCTION_MARKER = "FUNCTION_USAGE_DEV_ONLY";
export const functionCatalog = catalog;
export type FunctionStatus = "完整" | "未启用" | "无记录" | "未产出" | "查询失败";
export interface FunctionView { range: DateRangeValue; compared: boolean; mixed: boolean; selected: string[]; days: 7 | 30; dimension: string; structureScope?: UsageScope; navigation?: NavigationView }
export const DEFAULT_FUNCTION_VIEW: FunctionView = { range: DEMO_RANGE, compared: false, mixed: false, selected: [], days: 7, dimension: "平台", structureScope: OVERALL_USAGE_SCOPE, navigation: DEFAULT_NAVIGATION_VIEW };
export const functionTrendRange = (view: FunctionView) => ({ start: shiftDate(view.range.end, -(view.days - 1)), end: view.range.end });
export function parseFunctionView(text: string | null): FunctionView | null {
  if (!text || text.length > 1500) return null;
  try {
    const v = JSON.parse(text);
    if (Object.keys(v).filter(key => !["navigation", "structureScope"].includes(key)).sort().join() !== "compared,days,dimension,mixed,range,selected" || (v.navigation !== undefined && !parseNavigationView(v.navigation)) || (v.structureScope !== undefined && !validUsageScope(v.structureScope)) || typeof v.compared !== "boolean" || typeof v.mixed !== "boolean" || !validDemoRange(v.range) || Object.keys(v.range).sort().join() !== "end,start" || ![7, 30].includes(v.days) || !["平台", "新老用户", "获客类型", "平台 × 新老用户"].includes(v.dimension) || !Array.isArray(v.selected) || v.selected.length > 5 || new Set(v.selected).size !== v.selected.length || v.selected.some((id: unknown) => !catalog.items.some(item => item.id === id))) return null;
    return { ...v, structureScope: v.structureScope ?? OVERALL_USAGE_SCOPE, navigation: v.navigation === undefined ? DEFAULT_NAVIGATION_VIEW : parseNavigationView(v.navigation)! };
  } catch { return null; }
}
export const functionHref = (view: FunctionView) => preserveAuthenticatedReadingRoute(`/dashboards/public?design=dashboard-center&board=5.5&view=${encodeURIComponent(JSON.stringify(view))}`);
export const percentage = (value: number | null) => value === null ? "—" : `${(value * 100).toFixed(2)}%`;

export function functionObservations(id: string, range: DateRangeValue, zero = false) {
  const index = catalog.items.findIndex(item => item.id === id);
  if (index < 0 || !validDemoRange(range)) throw Error("功能或日期不在演示范围内");
  return usageObservations(range, index + 11, zero);
}
export function functionResult(id: string, range: DateRangeValue, scope: UsageScope = OVERALL_USAGE_SCOPE, zero = false) {
  const { users, active } = functionObservations(id, range, zero).summary.find(row => usageScopeKey(row.scope) === usageScopeKey(scope))!;
  return { users, active, rate: active ? users / active : null };
}
export function functionBasis(value: { users: number; active: number; rate: number | null }, context: string): CalculationBasis {
  return { formula: "使用用户数 ÷ 同范围活跃用户数 × 100%", scope: context, numerator: { name: "使用用户数", value: value.users, unit: "人" }, denominator: { name: "同范围活跃用户数", value: value.active, unit: "人" }, result: percentage(value.rate), percentage: true };
}
export function functionRows(view: FunctionView) {
  const overall = (id: string, range: DateRangeValue, zero = false) => { const value = functionResult(id, range, OVERALL_USAGE_SCOPE, zero); if (value.rate === null) throw new Error("功能总体样例缺少活跃基数"); return { ...value, rate: value.rate }; };
  return catalog.items.map((item, index) => {
    const status: FunctionStatus = view.mixed ? ({ 1: "未启用", 2: "无记录", 3: "未产出", 4: "查询失败" } as Record<number, FunctionStatus>)[index] ?? "完整" : "完整";
    const current = status === "完整" ? overall(item.id, view.range, view.mixed && index === 0) : null;
    const previous = view.compared && status === "完整" ? overall(item.id, demoPrevious(view.range)) : null;
    return { ...item, index, status, current, previous };
  });
}
export function sortFunctionRows(rows: ReturnType<typeof functionRows>, order: string) {
  const value = (row: typeof rows[number]) => order === "change" ? row.current?.rate != null && row.previous?.rate != null ? row.current.rate - row.previous.rate : null : row.current?.rate ?? null;
  return [...rows].sort((a, b) => {
    if (order === "module") return a.module.localeCompare(b.module, "zh") || a.index - b.index;
    const left = value(a), right = value(b);
    return left === null ? right === null ? a.index - b.index : 1 : right === null ? -1 : right - left || a.index - b.index;
  });
}
export function functionMetric(id: string, range: DateRangeValue, compared: boolean, scope: UsageScope = OVERALL_USAGE_SCOPE, zeroCurrent = false): DashboardMetricCardModel {
  const item = catalog.items.find(item => item.id === id)!;
  const current = functionResult(id, range, scope, zeroCurrent), before = demoPrevious(range), previous = functionResult(id, before, scope);
  const metric = { id: "template:module-penetration", name: `${item.name} · 功能渗透率`, definitionLabel: `${catalog.template.definition}。${catalog.template.rule}。本地合成数据不代表正式接入。`, aggregationLabel: `${range.start} 至 ${range.end} · ${usageScopeLabel(scope)} · 模块通用模板` };
  if (current.rate === null) return { metric, result: { status: "no_values", contextLabel: metric.aggregationLabel, label: "活跃用户基数为0", message: "人数保留0，渗透率不可计算。", retryable: false, validationLabel: "演示数据" } };
  const difference = previous.rate === null ? null : current.rate - previous.rate;
  const previousDates = demoDates(before);
  const points = demoDates(range).map((date, i) => {
    const value = functionResult(id, { start: date, end: date }, scope, zeroCurrent), counterpartDate = previousDates[i], counterpart = functionResult(id, { start: counterpartDate, end: counterpartDate }, scope);
    return { key: date, label: date.slice(5), actualDate: date, value: value.rate === null ? null : { raw: value.rate, display: percentage(value.rate), actualDate: date }, counterpart: compared && counterpart.rate !== null ? { raw: counterpart.rate, display: percentage(counterpart.rate), actualDate: counterpartDate } : null, calculation: functionBasis(value, `${date} · ${usageScopeLabel(scope)}`), differenceDisplay: compared && value.rate !== null && counterpart.rate !== null ? `${((value.rate - counterpart.rate) * 100).toFixed(2)} 个百分点` : null, state: value.rate === null ? "no_value" as const : "available" as const, stateLabel: value.rate === null ? "活跃用户基数为0" : "完整" };
  });
  return { metric, result: { status: "available", completeness: "complete", refresh: { status: "idle" }, value: { raw: current.rate, display: (current.rate * 100).toFixed(2), unit: "%" }, calculation: functionBasis(current, metric.aggregationLabel), trendKind: "line", validationLabel: "演示数据", watermarkLabel: "数据至 2026-09-08", comparison: compared ? difference === null ? { status: "unavailable", label: "较对比周期", detail: "对比期活跃分母为0，不可比。" } : { status: "available", label: "较对比周期", kind: "percentage_point", direction: changeDirection(difference), display: `${difference > 0 ? "+" : ""}${(difference * 100).toFixed(2)} 个百分点`, detail: `${range.start} 至 ${range.end} 对比 ${before.start} 至 ${before.end} · ${usageScopeLabel(scope)}`, rows: [{ label: "当前期", date: `${range.start} 至 ${range.end}`, value: percentage(current.rate) }, { label: "对比期", date: `${before.start} 至 ${before.end}`, value: percentage(previous.rate) }], difference: { display: `${(difference * 100).toFixed(2)} 个百分点`, direction: changeDirection(difference) } } : null, trend: { current: points, comparison: compared ? points.map((p, i) => ({ ...p, key: previousDates[i], actualDate: previousDates[i], value: p.counterpart, counterpart: p.value, calculation: functionBasis(functionResult(id, { start: previousDates[i], end: previousDates[i] }, scope), `${previousDates[i]} · ${usageScopeLabel(scope)}`) })) : null } } };
}
