import definitions from "../generated/metric-definitions-ui.json";
import { rangeError, shiftDate, type DateRangeValue } from "../../components/ui/date-range-model";
import type { DashboardMetricCardModel } from "../features/dashboards/dashboard-metric-card-model";
import { changeDirection } from "../../components/ui/change-presentation";
import { paymentAggregate, paymentMetric, paymentMetricIds, type PaymentDimension } from "./payment-observations";
import { missingCalculation, type CalculationBasis } from "../features/dashboards/CalculationEvidence";
import { topicCard, topicDailyCard } from "./topic-preview-fixtures";
import { dailyMetricReading, periodMetricReading } from "../features/dashboards/daily-reading-model";

// Isolated DEV observations. These fixtures never register a query mapping or a metric definition.
export const EXTENDED_BOARD_MARKER = "EXTENDED_BOARD_DEV_ONLY";
export const DEMO_END = "2026-09-08";
export const DEMO_RANGE = { start: "2026-09-02", end: DEMO_END };
export const demoDates = (range: DateRangeValue) => Array.from({ length: (Date.parse(range.end) - Date.parse(range.start)) / 86400000 + 1 }, (_, i) => shiftDate(range.start, i));
export const demoPrevious = (range: DateRangeValue) => ({ start: shiftDate(range.start, -demoDates(range).length), end: shiftDate(range.start, -1) });
export const demoRangeLabel = (range: DateRangeValue) => `${range.start} 至 ${range.end}`;
export const validDemoRange = (range: DateRangeValue) => !rangeError(range, { today: "2026-09-10", maxDate: DEMO_END, maxDays: 366 });
export function demoMetric(id: string) { const item = definitions.items.find(item => item.id === id); if (!item) throw new Error(`缺少权威指标 ${id}`); return item; }
const rates = new Set(["M036", "M061", "M064", "M073", "M069", "M070", "M071", "M090", "M072", "M083", "M031", "M044", "M046", "M050", "M074", "M076", "M077", "M078", "M080", "M052"]);
const money = new Set(["M058", "M105", "M067", "M088", "M087", "M065", "M066"]);
const people = new Set(["M059", "M104", "M068", "M085", "M030", "M093", "M107", "M049", "M051", "M075", "M079"]);
const averages = new Set(["M067", "M087", "M088", "M108"]);
export const demoUnit = (id: string) => rates.has(id) ? "%" : money.has(id) ? "USD" : people.has(id) ? "人" : id === "M108" ? "次/人" : id === "M086" ? "单" : "次";
export function demoValue(id: string, value: number | null, unit = true) { if (value === null) return "—"; const u = demoUnit(id); return (value * (u === "%" ? 100 : 1)).toLocaleString("zh-CN", { maximumFractionDigits: u === "%" || u === "USD" || averages.has(id) ? 2 : 0, minimumFractionDigits: u === "%" || u === "USD" ? 2 : 0 }) + (unit ? ` ${u}` : ""); }
export const demoAnchor = (id: string) => ["M064", "M088"].includes(id) ? "注册日期" : id === "M090" ? "提交日期 · 已结束观察窗口" : ["M084", "M085"].includes(id) ? "支付提交日期" : ["M086", "M072"].includes(id) ? "到账成功日期" : money.has(id) || ["M059", "M104"].includes(id) ? "支付成功日期 · USD" : "业务日期";
const ordinal = (date: string) => Math.floor(Date.parse(date) / 86400000);
function observation(id: string, date: string, group: number) {
  const n = Number(id.slice(1)), d = ordinal(date), scale = 1 / (1 + group * .32);
  const base = Math.round((11000 + n * 170) * scale * (1 + .12 * Math.sin(d * .29 + n + group)));
  const rate = .64 + (n % 19) * .012 + .023 * Math.cos(d * .31 + group);
  const users = Math.max(1, Math.round(base / (4 + n % 5)));
  return { base, users, successes: Math.round(base * rate), amount: Math.round(base * (1.31 + n % 7) * 100) / 100 };
}
export interface DemoFactSummary { base: number; users: number; successes: number; amount: number }
const CONTENT_POSITION_COUNT = 8;
const sumFacts = (rows: ReturnType<typeof observation>[]): DemoFactSummary => ({
  base: rows.reduce((sum, row) => sum + row.base, 0),
  users: rows.reduce((sum, row) => sum + row.users, 0),
  successes: rows.reduce((sum, row) => sum + row.successes, 0),
  amount: Math.round(rows.reduce((sum, row) => sum + row.amount, 0) * 100) / 100
});
/** Isolated facts are generated before the displayed rate; callers must never backsolve inputs from a rate. */
export function demoFacts(id: string, range: DateRangeValue, group = 0): DemoFactSummary {
  const groups = id === "M044" && group === 0 ? Array.from({ length: CONTENT_POSITION_COUNT }, (_, index) => index + 1) : [group];
  return sumFacts(groups.flatMap(groupIndex => demoDates(range).map(date => observation(id, date, groupIndex))));
}
function summarize(id: string, days: string[], group: number) {
  const range = { start: days[0], end: days.at(-1)! }, facts = demoFacts(id, range, group);
  if (rates.has(id)) return facts.successes / facts.base;
  if (averages.has(id)) return (money.has(id) ? facts.amount : facts.base) / facts.users;
  // Synthetic memberships: a shared pool plus disjoint date-specific users. Never sum daily UV.
  if (people.has(id)) {
    const rows = days.map(date => observation(id, date, group));
    return Math.max(...rows.map(row => Math.floor(row.users * .7))) + rows.reduce((sum, row) => sum + row.users - Math.floor(row.users * .7), 0);
  }
  return money.has(id) ? facts.amount : facts.base;
}
export function demoResult(id: string, range: DateRangeValue, group = 0) {
  if(group===0&&["M036","M097","M101"].includes(id)){const result=topicCard(id,range,false).result;if(result.status!=="available")throw new Error("观影样例尚未就绪");return result.value.raw;}
  return summarize(id, demoDates(range), group);
}
const inputUnit = (name: string) => name.includes("用户") || name.includes("人数") ? "人" : name.includes("订单") ? "单" : name.includes("金额") ? "USD" : "次";
export function demoCalculationBasis(id: string, range: DateRangeValue, group = 0): CalculationBasis | undefined {
  if(group===0&&["M036","M097","M101"].includes(id)){
    const result=topicCard(id,range,false).result;
    return result.status==="available"?result.calculation:undefined;
  }
  const definition = demoMetric(id), parsed = missingCalculation(definition.definition, `${demoRangeLabel(range)} · 隔离合成演示事实`, demoValue(id, demoResult(id, range, group)), demoUnit(id) === "%");
  if (!parsed) return undefined;
  const facts = demoFacts(id, range, group);
  const numerator = rates.has(id) ? facts.successes : money.has(id) ? facts.amount : facts.base;
  const denominator = rates.has(id) ? facts.base : facts.users;
  return {
    ...parsed,
    numerator: { ...parsed.numerator, value: numerator, unit: inputUnit(parsed.numerator.name) },
    denominator: { ...parsed.denominator, value: denominator, unit: inputUnit(parsed.denominator.name) }
  };
}
export function extendedMetricModel(id: string, range: DateRangeValue, compared: boolean, mixed = false, group = 0, paymentFilter?:Partial<Record<PaymentDimension,string>>): DashboardMetricCardModel {
  if (!validDemoRange(range)) throw new Error("演示日期无效");
  const definition = demoMetric(id), unit = demoUnit(id), days = demoDates(range), before = demoPrevious(range);
  const metric = { ...definition, definitionLabel: definition.definition, aggregationLabel: `${demoRangeLabel(range)} · ${demoAnchor(id)}${people.has(id) ? " · 区间去重样例" : ""}` };
  if (mixed && ["M065", "M097", "M047", "M075", "M091"].includes(id)) return { metric, result: { status: "failed", label: "当前指标加载失败", message: "演示失败状态；其他结果保持可读，可单独重试。", contextLabel: demoRangeLabel(range), retryable: true } };
  if (mixed && ["M090", "M076"].includes(id)) return { metric, result: { status: "immature", label: "观察窗口尚未结束", message: "观察中的样本不计失败，也不生成 0 或变化率。", contextLabel: demoRangeLabel(range), retryable: false } };
  if(group===0&&["M036","M097","M101"].includes(id))return topicCard(id,range,compared,mixed);
  const read=(period:DateRangeValue)=>paymentFilter&&paymentMetricIds.has(id)?paymentMetric(id,period,paymentFilter):demoResult(id,period,group);
  const calculation=(period:DateRangeValue):CalculationBasis|undefined=>{
    if(id==="M067"&&paymentFilter){
      const row=paymentAggregate(period,paymentFilter);
      return {formula:definition.definition,scope:`${demoRangeLabel(period)} · 支付成功日 · 合成演示数据`,numerator:{name:"总充值金额",value:row.amount,unit:"USD"},denominator:{name:"付费用户数（区间去重）",value:row.users,unit:"人"},result:demoValue(id,row.arppu),percentage:false};
    }
    return demoCalculationBasis(id,period,group);
  };
  const raw = read(range), baseline = read(before), delta = raw - baseline;
  const difference = (a: number, b: number) => `${a > b ? "+" : ""}${unit === "%" ? ((a - b) * 100).toFixed(2) + " 个百分点" : demoValue(id, a - b)}`;
  const points = days.map(date => { const value = read({start:date,end:date}), counterpartDate = shiftDate(date, -days.length), counterpart = read({start:counterpartDate,end:counterpartDate}); return { key: date, label: date.slice(5), actualDate: date, calculation:calculation({start:date,end:date}), value: { raw: value, display: demoValue(id, value), actualDate: date }, counterpart: compared ? { raw: counterpart, display: demoValue(id, counterpart), actualDate: counterpartDate } : null, differenceDisplay: compared ? difference(value, counterpart) : null, state: "available" as const, stateLabel: "完整" }; });
  return { metric, result: { status: "available", calculation:calculation(range), completeness: "complete", refresh: { status: "idle" }, value: { raw, display: demoValue(id, raw, false), unit }, validationLabel: "演示数据", watermarkLabel: `数据至 ${DEMO_END}`, trendKind: "line", comparison: compared ? { status: "available", kind: unit === "%" ? "percentage_point" : "relative_change", label: "较对比周期", direction: changeDirection(delta), display: `${delta > 0 ? "↑" : delta < 0 ? "↓" : "—"} ${unit === "%" ? `${Math.abs(delta * 100).toFixed(2)} 个百分点` : `${Math.abs(delta / baseline * 100).toFixed(1)}%`}`, detail: `${demoAnchor(id)}；独立合成样例，不代表正式口径已接入。`, rows: [{ label: "当前期", date: demoRangeLabel(range), value: demoValue(id, raw) }, { label: "对比期", date: demoRangeLabel(before), value: demoValue(id, baseline) }], difference: { display: difference(raw, baseline), direction: changeDirection(delta) } } : null, trend: { current: points, comparison: compared ? points.map(point => ({ ...point, calculation:calculation({start:point.counterpart!.actualDate,end:point.counterpart!.actualDate}), key: point.counterpart!.actualDate, actualDate: point.counterpart!.actualDate, value: point.counterpart, counterpart: point.value })) : null } } };
}

export function extendedDailyMetricModel(id: string, range: DateRangeValue, compared: boolean, mixed = false, group = 0, paymentFilter?: Partial<Record<PaymentDimension, string>>): DashboardMetricCardModel {
  const model = extendedMetricModel(id, range, compared, mixed, group, paymentFilter);
  if (group === 0 && ["M036", "M097", "M101"].includes(id)) {
    return model.result.status === "available" ? topicDailyCard(id, range, compared, mixed) : model;
  }
  if (["M064", "M088", "M090", "M076"].includes(id)) return periodMetricReading(model, `${demoRangeLabel(range)} · ${demoAnchor(id)}`);
  const result = model.result, days = demoDates(range).length;
  const additive = new Set(["M058", "M105", "M065", "M066", "M084", "M086", "M045", "M047", "M048", "M082", "M091", "M092", "M096", "M101", "M106", "M109", "M089"]);
  const statistics = result.status === "available" && result.completeness === "complete" && days > 1 ? [{
    label: additive.has(id) ? "合计" : people.has(id) ? "周期去重人数" : rates.has(id) ? "周期比率" : averages.has(id) ? "周期人均" : "周期结果",
    display: result.value.display, unit: result.value.unit, detail: `${demoRangeLabel(range)} · ${people.has(id) ? "独立合成成员去重结果" : rates.has(id) || averages.has(id) ? "使用周期事实及合法分母，不平均日结果" : "既有隔离周期事实"}`
  }, ...(additive.has(id) ? [{ label: "均值", display: (result.value.raw / days).toLocaleString("zh-CN", { maximumFractionDigits: 2 }), unit: result.value.unit, detail: `${demoRangeLabel(range)} · 合计 ÷ ${days} 个完整业务日` }] : [])] : [];
  return dailyMetricReading({ ...model, metric: { ...model.metric, aggregationLabel: `${demoRangeLabel(range)} · ${demoAnchor(id)}` } }, { date: range.end, compared, statistics, read: date => {
    const day = extendedMetricModel(id, { start: date, end: date }, false, mixed, group, paymentFilter).result;
    return { date, value: day.status === "available" ? day.value.raw : null, display: day.status === "available" ? day.value.display : "—", reason: day.status === "available" ? undefined : day.label ?? day.message, calculation: day.status === "available" ? day.calculation : undefined };
  } });
}

export interface BoardSection { title: string; ids: string[]; columns: 2 | 3; note?: string }
export interface ExtendedBoard { sections: BoardSection[]; dimensions: { title: string; ids: string[]; groups: string[] }[] }
export const EXTENDED_BOARDS: Record<string, ExtendedBoard> = {
  "5.10": { sections: [{ title: "付费核心", ids: ["M058", "M059", "M061", "M067", "M104", "M105"], columns: 3 }, { title: "新用户与用户价值", ids: ["M064", "M088", "M087"], columns: 3 }, { title: "收入结构", ids: ["M065", "M066"], columns: 2, note: "VIP 与金币分别统计，不默认合计为总充值金额。" }, { title: "会员引导与付费墙", ids: ["M073", "M068", "M069"], columns: 3 }], dimensions: [{ title: "付费结构", ids: ["M058", "M059", "M061", "M067", "M104", "M105"], groups: ["客户端平台", "新老用户", "来源渠道", "支付方式", "商品", "平台 × 新老用户"] }] },
  "5.11": { sections: [{ title: "支付链路核心", ids: ["M084", "M086", "M090", "M070", "M071", "M072"], columns: 3 }, { title: "提交用户规模", ids: ["M085"], columns: 2 }], dimensions: [{ title: "支付方式比较", ids: ["M084", "M085", "M086", "M090"], groups: ["支付方式"] }, { title: "商品与到账诊断", ids: ["M086", "M090"], groups: ["商品", "充值场景", "到账类型", "商品 × 到账类型"] }] },
  "5.12": { sections: [{ title: "播放是否发起、是否成功、是否有效", ids: ["M083", "M031", "M036", "M097"], columns: 2 }, { title: "用户规模", ids: ["M030"], columns: 2 }], dimensions: [{ title: "播放质量诊断", ids: ["M083", "M031", "M036", "M097", "M030"], groups: ["客户端平台", "版本", "视频类型", "触发方式", "播放模式"] }] },
  "5.13": { sections: [{ title: "发现、搜索与视频互动", ids: ["M044", "M092", "M093", "M046", "M047", "M048"], columns: 3 }, { title: "视频首页顶部频道Tab", ids: ["M106", "M107", "M108"], columns: 3, note: "仅统计用户主动切换顶部频道" }, { title: "视频点击来源", ids: ["M109"], columns: 2, note: "全局页面 / 列表来源与视频首页一级分类上下同显；顶部频道 Tab 点击另行统计" }, { title: "作者与社区", ids: ["M049", "M050", "M051"], columns: 3 }], dimensions: [{ title: "顶部频道Tab比较", ids: ["M106", "M107", "M108"], groups: ["顶部频道Tab"] }, { title: "视频首页一级分类内容点击", ids: ["M109"], groups: ["一级内容分类"] }, { title: "内容发现结构", ids: ["M044"], groups: ["位置"] }, { title: "搜索需求", ids: ["M092", "M093", "M046"], groups: ["搜索词", "搜索类型"] }, { title: "视频互动排行", ids: ["M047", "M048"], groups: ["视频", "视频类型"] }, { title: "作者与社区明细", ids: ["M049", "M050", "M051"], groups: ["作者", "帖子", "内容类型"] }] },
  "5.14": { sections: [{ title: "玩法结果规模", ids: ["M075", "M079"], columns: 2 }, { title: "过程与成功质量", ids: ["M074", "M076", "M077", "M078"], columns: 2 }], dimensions: [{ title: "签到拆解", ids: ["M074", "M075"], groups: ["签到入口", "签到周期"] }, { title: "任务与福利", ids: ["M076", "M077"], groups: ["任务类型", "任务周期", "福利类型"] }, { title: "分享邀请", ids: ["M078", "M079"], groups: ["绑定来源", "奖励接收方", "里程碑"] }] },
  "5.15": { sections: [{ title: "启动核心", ids: ["M080", "M091"], columns: 2, note: "启动成功率按已成熟有效启动计算；成熟后缺少结果的启动仍计入分母。" }], dimensions: [{ title: "启动结构与质量诊断", ids: ["M080", "M091"], groups: ["客户端平台", "启动类型", "版本"] }] }
};

export interface DemoCategory { key: string; name: string; position: number; row?: string; column?: string }
export function demoCategories(group: string): DemoCategory[] {
  const staticLabels: Record<string, string[]> = { "客户端平台": ["Android", "iOS", "Web"], "新老用户": ["新用户", "老用户"], "启动类型": ["应用启动", "首次加载", "刷新加载"], "视频类型": ["默认类型", "长视频", "短视频", "短视频与图片"], "奖励接收方": ["邀请人", "被邀请人"], "支付方式": ["支付宝", "微信"] };
  if (group.includes(" × ")) { const [left, right] = group.split(" × "), a = left === "平台" ? demoCategories("客户端平台") : demoCategories(left), b = right === "新老用户" ? demoCategories(right) : demoCategories(right); return a.slice(0, 4).flatMap((row, i) => b.slice(0, 4).map((column, j) => ({ key: `${row.key}:${column.key}`, name: `${row.name} · ${column.name}`, position: i * 4 + j, row: row.name, column: column.name }))); }
  const count = ["视频", "作者", "帖子", "搜索词"].includes(group) ? 126 : ["一级分类 Tab", "一级内容分类"].includes(group) ? 12 : group === "底部导航 Tab" ? 5 : 8;
  return (staticLabels[group] ?? Array.from({ length: count }, (_, i) => `${group.includes("Tab") ? "演示导航" : "演示" + group} ${String(i + 1).padStart(2, "0")}`)).map((name, i) => ({ name, key: `demo-${group === "一级分类 Tab" ? "tab" : group === "一级内容分类" ? "category" : group}-${i + 1}`, position: i + 1 }));
}
