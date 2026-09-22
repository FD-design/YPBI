import definitions from "../generated/metric-definitions-ui.json";
import { isDate, shiftDate, type DateRangeValue } from "../../components/ui/date-range-model";
import { changeDirection } from "../../components/ui/change-presentation";
import type { DashboardMetricCardModel, DashboardMetricTrendPoint } from "../features/dashboards/dashboard-metric-card-model";
import type { CalculationBasis } from "../features/dashboards/CalculationEvidence";
import { dailyMetricReading, periodMetricReading } from "../features/dashboards/daily-reading-model";
import { DEFAULT_TOPIC_SCOPE, type TopicScope } from "./topic-preview-view";

// DEV-only synthetic observations for layout and interaction review. No production query uses this file.
export const TOPIC_PREVIEW_MARKER = "TOPIC_PREVIEW_MARKER";
export const END = "2026-09-08", MIN = "2026-03-13";
export const DEFAULT_RANGE = { start: "2026-09-02", end: END };
export const topicMetric = (id: string) => { const item = definitions.items.find(item => item.id === id); if (!item) throw new Error(`指标未登记：${id}`); return item; };
export const authorityVersion = definitions.authorityVersion;
export const dayCount = (range: DateRangeValue) => (Date.parse(range.end) - Date.parse(range.start)) / 86400000 + 1;
export const rangeLabel = (range: DateRangeValue) => `${range.start} 至 ${range.end}`;
export const datesIn = (range: DateRangeValue) => Array.from({ length: dayCount(range) }, (_, i) => shiftDate(range.start, i));
export const validRange = (range: DateRangeValue) => isDate(range.start) && isDate(range.end) && range.start <= range.end && range.start >= MIN && range.end <= END && dayCount(range) <= 180;
export const previousRange = (range: DateRangeValue) => ({ start: shiftDate(range.start, -dayCount(range)), end: shiftDate(range.start, -1) });
export const RETENTION_WINDOWS: Record<string, number> = { M020: 1, M021: 3, M022: 7, M023: 30, M024: 1, M025: 3, M040: 1, M041: 3, M042: 7 };
const rateIds = new Set([...Object.keys(RETENTION_WINDOWS), "M081", "M036"]);
export const topicUnit = (id: string) => rateIds.has(id) ? "%" : ["M102"].includes(id) ? "小时" : ["M098", "M043"].includes(id) ? "分钟" : ["M101", "M034", "M097"].includes(id) ? "次" : "人";
export function topicValue(id: string, raw: number | null, withUnit = true) {
  if (raw === null) return "—";
  const unit = topicUnit(id), number = (raw * (unit === "%" ? 100 : 1)).toLocaleString("zh-CN", { maximumFractionDigits: unit === "人" || unit === "次" ? 0 : 2, minimumFractionDigits: unit === "%" ? 2 : 0 });
  return `${number}${withUnit ? ` ${unit}` : ""}`;
}
export interface CohortCell { id: string; count: number | null; rate: number | null; status: "完整" | "未成熟" | "迟到缓冲中" | "待加工"; availableAt: string }
export interface CohortRow { date: string; base: number; cells: CohortCell[] }
export const REGISTER_IDS = ["M020", "M021", "M022", "M023"];
export const WATCH_RETENTION_IDS = ["M040", "M041", "M042"];
function seed(date: string) { return Math.round((Date.parse(date) - Date.parse("2025-01-01")) / 86400000); }
function syntheticCohort(date: string, id: string, mixed = false, reactivationWindow: 48 | 72 = 72): { base: number; cell: CohortCell } {
  const n = seed(date), watch = WATCH_RETENTION_IDS.includes(id), returning = id === "M024", failed = id === "M025";
  const base = (watch ? 11500 : returning ? 145000 : failed ? 1600 : 5100) + (n % 13) * 137;
  const window = id === "M025" ? reactivationWindow / 24 : RETENTION_WINDOWS[id];
  const availableAt = shiftDate(date, id === "M025" ? window + 1 : window);
  const status = availableAt > END ? "未成熟" : mixed && date === "2026-09-04" ? "迟到缓冲中" : mixed && date === "2026-09-03" ? "待加工" : "完整";
  const rate = Math.max(.06, .43 - Math.log2(window + 1) * .049 + (n % 11) * .003 + (watch ? .035 : returning ? .17 : failed ? -.21 : 0));
  const count = status === "完整" ? mixed && date === "2026-09-02" ? 0 : Math.round(base * rate) : null;
  return { base, cell: { id, count, rate: count === null ? null : count / base, status, availableAt: status === "迟到缓冲中" ? shiftDate(END, 1) : availableAt } };
}
export function cohortRows(range: DateRangeValue, ids: string[], mixed = false): CohortRow[] {
  return datesIn(range).map(date => ({ date, base: syntheticCohort(date, ids[0]).base, cells: ids.map(id => syntheticCohort(date, id, mixed).cell) }));
}
function syntheticDay(date: string) {
  const n = seed(date), dau = 180000 + (n % 17) * 1547, users = Math.round(dau * (.74 + (n % 7) * .008));
  const attempts = users * 7 + (n % 5) * 5341, starts = Math.round(attempts * .943), effective = Math.round(starts * (.61 + (n % 9) * .003));
  const hours = Math.round(users * 2.55 + (n % 5) * 1345);
  return { dau, users, attempts, starts, effective, hours, effectiveUsers: Math.round(users * .79), effectiveMinutes: hours * 60 * .89 };
}
export const TOPIC_CLIENTS = [{ value: "overall", label: "总体" }, { value: "android", label: "Android" }, { value: "ios", label: "iOS" }, { value: "web", label: "Web" }] as const;
export const TOPIC_AUDIENCES = [{ value: "overall", label: "总体" }, { value: "new", label: "新用户" }, { value: "existing", label: "老用户" }] as const;
export const topicScopeLabel = (scope: TopicScope) => `${scope.client === "overall" ? "全部客户端" : TOPIC_CLIENTS.find(item => item.value === scope.client)!.label} · ${scope.audience === "overall" ? "全部用户" : TOPIC_AUDIENCES.find(item => item.value === scope.audience)!.label}`;
// Isolated joint-grain observations. The real path selects independently returned
// scopes; these synthetic allocations are never used to fill production cells.
function scopedDay(date: string, scope: TopicScope) {
  const overall = syntheticDay(date);
  if (scope.client === "overall" && scope.audience === "overall") return overall;
  const weights = [.12, .34, .08, .27, .04, .15].map((weight, index) => weight * (1 + .06 * Math.sin(seed(date) * .3 + index)));
  const allocate = (total: number, values: number[]) => {
    const sum = values.reduce((a, b) => a + b, 0), raw = values.map(value => total * value / sum), allocated = raw.map(Math.floor);
    const order = raw.map((value, index) => ({ index, remainder: value - allocated[index] })).sort((a, b) => b.remainder - a.remainder);
    for (let n = 0; n < Math.round(total) - allocated.reduce((a, b) => a + b, 0); n++) allocated[order[n % order.length].index]++;
    return allocated;
  };
  const dau = allocate(overall.dau, weights);
  const users = allocate(overall.users, dau.map((value, i) => value * (.77 + i % 2 * .04)));
  const attempts = allocate(overall.attempts, users.map((value, i) => value * (6 + i * .2)));
  const starts = allocate(overall.starts, attempts.map((value, i) => value * (.94 + i * .002)));
  const effective = allocate(overall.effective, starts.map((value, i) => value * (.6 + i * .01)));
  const hours = allocate(overall.hours, users.map((value, i) => value * (2 + i * .1)));
  const effectiveUsers = allocate(overall.effectiveUsers, users);
  const effectiveMinutes = allocate(overall.effectiveMinutes, hours);
  const selected = weights.map((_, i) => i).filter(i => (scope.client === "overall" || TOPIC_CLIENTS[Math.floor(i / 2) + 1].value === scope.client) && (scope.audience === "overall" || TOPIC_AUDIENCES[i % 2 + 1].value === scope.audience));
  const sum = (values: number[]) => selected.reduce((total, i) => total + values[i], 0);
  return { dau: sum(dau), users: sum(users), attempts: sum(attempts), starts: sum(starts), effective: sum(effective), hours: sum(hours), effectiveUsers: sum(effectiveUsers), effectiveMinutes: sum(effectiveMinutes) };
}
function dailyValue(date: string, id: string, scope = DEFAULT_TOPIC_SCOPE) {
  const d = scopedDay(date, scope);
  return ({ M016: d.dau, M026: d.users, M101: d.attempts, M097: d.starts, M102: d.hours, M098: d.hours * 60 / d.users, M081: d.users / d.dau, M036: d.effective / d.starts, M034: d.effective, M035: d.effectiveUsers, M043: d.effectiveMinutes / d.effectiveUsers } as Record<string, number>)[id];
}
// Synthetic period outputs are separate from daily UV; they are not a client-side deduplication algorithm.
function fixturePeriodValue(id: string, dates: string[], scope = DEFAULT_TOPIC_SCOPE) {
  if (id === "M016") return dailyValue(dates.at(-1)!, id, scope);
  const rows = dates.map(date => scopedDay(date, scope)), sum = (key: keyof ReturnType<typeof syntheticDay>) => rows.reduce((total, row) => total + row[key], 0);
  if (id === "M026") return sum("users") / rows.length;
  if (id === "M101") return sum("attempts");
  if (id === "M097") return sum("starts");
  if (id === "M102") return sum("hours");
  if (id === "M034") return sum("effective");
  if (id === "M081") return sum("users") / sum("dau");
  if (id === "M036") return sum("effective") / sum("starts");
  // These period semantics still require authority review. Do not invent a temporal UV formula.
  if (rows.length > 1) throw new Error(`多日口径尚未准入：${id}`);
  return dailyValue(dates[0], id, scope);
}
export function topicCard(id: string, range: DateRangeValue, compared: boolean, mixed = false, scope = DEFAULT_TOPIC_SCOPE, reactivationWindow: 48 | 72 = 72): DashboardMetricCardModel {
  const metric = topicMetric(id), retention = id in RETENTION_WINDOWS;
  const retentionWindow = id === "M025" ? reactivationWindow / 24 : RETENTION_WINDOWS[id];
  const anchor = REGISTER_IDS.includes(id) ? "注册日期" : WATCH_RETENTION_IDS.includes(id) ? "首次有效观看日期" : id === "M025" ? "首次体验失败日期" : "业务日";
  const label = `${range.start.slice(5)} 至 ${range.end.slice(5)} · ${anchor}${id === "M025" ? ` · ${reactivationWindow}小时窗口` : ""}${scope !== DEFAULT_TOPIC_SCOPE ? " · " + topicScopeLabel(scope) : ""}`;
  const identity = { ...metric, definitionLabel: metric.definition, aggregationLabel: label };
  if (["M098", "M035", "M043"].includes(id) && dayCount(range) > 1) return { metric: identity, result: { status: "not_ready", label: "多日去重数据待接入", message: "沿用现有指标定义，等待同范围区间去重和时长数据；可选择单日核对展示，不由每日人数或均值推算多日结果。", contextLabel: label, retryable: false } };
  if (mixed && id === "M034") return { metric: identity, result: { status: "failed", label: "当前指标加载失败", message: "本次演示结果未加载，其他指标保持可读。", retryable: true, contextLabel: label } };
  const dates = datesIn(range), before = previousRange(range);
  const read = (date: string) => retention ? syntheticCohort(date, id, mixed, reactivationWindow).cell.rate : mixed && id === "M101" && date === "2026-09-04" ? null : dailyValue(date, id, scope);
  const currentValues = dates.map(read), eligible = dates.filter((_, i) => currentValues[i] !== null);
  if (!retention && !eligible.length) return { metric: identity, result: { status: "not_produced", label: "该日待加工", message: "当前业务日尚无已产出结果。", contextLabel: label, retryable: false, validationLabel: "演示数据" } };
  const pendingProduction = retention && dates.some(date => ["迟到缓冲中", "待加工"].includes(syntheticCohort(date, id, mixed, reactivationWindow).cell.status));
  if (!eligible.length) return { metric: identity, result: { status: pendingProduction ? "not_produced" : "immature", label: pendingProduction ? "当前范围尚无已产出结果" : "当前范围暂无观察期已结束的用户", message: pendingProduction ? "观察窗口已结束，部分批次仍在迟到缓冲或等待加工；完成时间待确认。" : `所选 ${anchor} 尚无完整的${id === "M025" ? `${reactivationWindow}小时观察窗口及24小时迟到缓冲` : `第 ${retentionWindow} 天`}结果；最早可用日为 ${shiftDate(range.start, id === "M025" ? retentionWindow + 1 : retentionWindow)}。`, contextLabel: label, retryable: false, validationLabel: "演示数据" } };
  const included = { start: eligible[0], end: eligible.at(-1)! };
  const referenceDates = eligible.map(date => shiftDate(date, -dates.length));
  const summarize = (selected: string[]) => retention ? (() => { const rows = selected.map(date => syntheticCohort(date, id, mixed, reactivationWindow)).filter(row => row.cell.count !== null); return rows.reduce((s, r) => s + r.cell.count!, 0) / rows.reduce((s, r) => s + r.base, 0); })() : fixturePeriodValue(id, selected, scope);
  const raw = summarize(eligible), baseline = summarize(referenceDates), difference = raw - baseline, unit = topicUnit(id);
  const basis = (selected: string[]): CalculationBasis | undefined => {
    if (!selected.length) return undefined;
    let numerator: CalculationBasis["numerator"], denominator: CalculationBasis["denominator"];
    if (retention) {
      const cohorts=selected.map(date=>syntheticCohort(date,id,mixed,reactivationWindow)).filter(row=>row.cell.count !== null);
      if (!cohorts.length) return undefined;
      numerator={name:id === "M025" ? `${reactivationWindow}小时内再次激活用户数` : `${retentionWindow===1?"次日":`第${retentionWindow}日`}${WATCH_RETENTION_IDS.includes(id)?"再次有效观看":"留存"}用户数`,value:cohorts.reduce((sum,row)=>sum+row.cell.count!,0),unit:"人"};
      denominator={name:`已成熟${anchor}批次用户数`,value:cohorts.reduce((sum,row)=>sum+row.base,0),unit:"人"};
    } else {
      const facts=selected.map(date => scopedDay(date, scope)),sum=(key:keyof ReturnType<typeof syntheticDay>)=>facts.reduce((sum,row)=>sum+row[key],0);
      if(id === "M081") { numerator={name:selected.length===1?"观影用户数":"观影人天",value:sum("users"),unit:selected.length===1?"人":"人天"};denominator={name:selected.length===1?"日活跃用户数":"活跃人天",value:sum("dau"),unit:selected.length===1?"人":"人天"}; }
      else if(id === "M036") { numerator={name:"有效观影次数",value:sum("effective"),unit:"次"};denominator={name:"成功起播次数",value:sum("starts"),unit:"次"}; }
      else if(id === "M098") { numerator={name:"观影总时长",value:sum("hours")*60,unit:"分钟"};denominator={name:"观影用户数",value:sum("users"),unit:"人"}; }
      else if(id === "M043") { numerator={name:"有效观影总时长",value:sum("effectiveMinutes"),unit:"分钟"};denominator={name:"有效观影用户数",value:sum("effectiveUsers"),unit:"人"}; }
      else return undefined;
    }
    return {formula:metric.definition,scope:`${selected[0]} 至 ${selected.at(-1)} · ${topicScopeLabel(scope)} · 同范围合成演示数据`,numerator,denominator,result:topicValue(id,summarize(selected)),percentage:unit==="%"};
  };
  const comparable = Number.isFinite(baseline) && (unit === "%" || baseline !== 0) && (retention || eligible.length === dates.length);
  const differenceDisplay = `${difference > 0 ? "+" : ""}${topicValue(id, difference, false)} ${unit === "%" ? "个百分点" : unit}`;
  const points: DashboardMetricTrendPoint[] = dates.map((date, i) => {
    const value = currentValues[i], previousDate = shiftDate(date, -dates.length), previous = value === null ? null : read(previousDate);
    return { key: `${id}-${date}`, label: date, actualDate: date, calculation:value===null?undefined:basis([date]), value: value === null ? null : { raw: value, display: topicValue(id, value), actualDate: date }, counterpart: compared && previous !== null ? { raw: previous, display: topicValue(id, previous), actualDate: previousDate } : null, differenceDisplay: compared && previous !== null && value !== null ? `${topicValue(id, value - previous, false)} ${unit === "%" ? "个百分点" : unit}` : null, state: value === null ? retention ? "immature" : "not_produced" : "available", stateLabel: value === null ? retention ? syntheticCohort(date, id, mixed, reactivationWindow).cell.status : "待加工" : "完整" };
  });
  return { metric: { ...identity, aggregationLabel: `${label} · ${retention ? `成熟 ${eligible.length}/${dates.length} 批` : id === "M016" ? `主值 ${range.end.slice(5)}` : id === "M026" ? "完整业务日日均" : ["M101", "M102", "M034"].includes(id) ? "区间累计" : "区间结果"}` }, result: {
    status: "available", calculation:basis(eligible), completeness: pendingProduction || (!retention && eligible.length < dates.length) ? "partial" : "complete", refresh: { status: "idle" }, value: { raw, display: topicValue(id, raw, false), unit }, trendKind: "line", validationLabel: "演示数据", watermarkLabel: `数据至 ${END}`,
    comparison: compared ? !comparable ? { status: "unavailable", label: "暂不可比", detail: "当前存在未产出结果或有效基准不足，不能生成整段变化。" } : { status: "available", label: "较对比周期", kind: unit === "%" ? "percentage_point" : "relative_change", direction: changeDirection(difference), display: `${difference > 0 ? "↑" : difference < 0 ? "↓" : "—"} ` + (unit === "%" ? `${Math.abs(difference * 100).toFixed(2)} 个百分点` : `${Math.abs(difference / baseline * 100).toFixed(1)}%`), detail: retention ? `仅纳入双方均成熟的对应批次：当前 ${rangeLabel(included)}；对比 ${referenceDates[0]} 至 ${referenceDates.at(-1)}。` : `当前 ${rangeLabel(range)}；对比 ${rangeLabel(before)}。`, rows: [{ label: "当前期", date: id === "M016" ? range.end : rangeLabel(included), value: topicValue(id, raw) }, { label: "对比期", date: id === "M016" ? before.end : `${referenceDates[0]} 至 ${referenceDates.at(-1)}`, value: topicValue(id, baseline) }], difference: { display: differenceDisplay, direction: changeDirection(difference) } } : null,
    trend: { current: points, comparison: compared ? points.map(point => ({ ...point, calculation:point.counterpart?basis([shiftDate(point.actualDate,-dates.length)]):undefined, key: `${point.key}-previous`, actualDate: shiftDate(point.actualDate, -dates.length), value: point.counterpart, counterpart: point.value })) : null }
  } };
}
/** Day-card view does not change the period models used by structures and cohorts. */
export function topicDailyCard(id: string, range: DateRangeValue, compared: boolean, mixed = false, scope = DEFAULT_TOPIC_SCOPE, reactivationWindow: 48 | 72 = 72): DashboardMetricCardModel {
  let model = topicCard(id, range, compared, mixed, scope, reactivationWindow);
  if (id in RETENTION_WINDOWS) return periodMetricReading(model, `${rangeLabel(range)} · ${REGISTER_IDS.includes(id) ? "已成熟注册批次" : WATCH_RETENTION_IDS.includes(id) ? "已成熟首次有效观看批次" : id === "M025" ? `已成熟首次体验失败批次 · ${reactivationWindow}小时窗口` : "已成熟业务日批次"}`);
  const daily = (date: string) => topicCard(id, { start: date, end: date }, false, mixed, scope, reactivationWindow);
  // Single-day inputs exist independently; their missing period UV is not a missing day value.
  if (["M098", "M035", "M043"].includes(id) && model.result.status === "not_ready") {
    const last = daily(range.end), dates = datesIn(range);
    if (last.result.status === "available") {
      const current = dates.map(date => {
        const day = daily(date), reference = compared ? daily(shiftDate(date, -dates.length)) : null;
        const result = day.result.status === "available" ? day.result : null;
        const before = reference?.result.status === "available" ? reference.result : null;
        return { key: `${id}-${date}`, label: date, actualDate: date, value: result ? { ...result.value, actualDate: date } : null, calculation: result?.calculation, counterpart: before ? { ...before.value, actualDate: shiftDate(date, -dates.length) } : null, differenceDisplay: null, state: result ? "available" as const : "no_value" as const, stateLabel: result ? "完整" : day.result.status === "available" ? "完整" : day.result.label ?? "该日不可用" };
      });
      model = { ...last, result: { ...last.result, comparison: null, trend: { current, comparison: compared ? current.map(point => {
        const reference = daily(shiftDate(point.actualDate, -dates.length)).result;
        return { ...point, key: `${point.key}-previous`, actualDate: shiftDate(point.actualDate, -dates.length), value: point.counterpart, counterpart: point.value, calculation: reference.status === "available" ? reference.calculation : undefined };
      }) : null } } };
    }
  }
  model = { ...model, metric: { ...model.metric, aggregationLabel: `${rangeLabel(range)} · 业务日 · ${topicScopeLabel(scope)}` } };
  const result = model.result, days = dayCount(range), statistics: import("../features/dashboards/dashboard-metric-card-model").DashboardMetricReading["statistics"] = [];
  if (result.status === "available" && result.completeness === "complete" && days > 1) {
    const detail = `${rangeLabel(range)} · ${topicScopeLabel(scope)} · 演示数据`;
    if (["M016", "M026"].includes(id)) statistics.push({ label: "均值", display: topicValue(id, datesIn(range).reduce((sum, date) => sum + dailyValue(date, id, scope), 0) / days, false), unit: topicUnit(id), detail: `${detail} · 逐日人数均值，不作为区间去重人数` });
    if (["M101", "M097", "M102", "M034"].includes(id)) statistics.push({ label: "合计", display: result.value.display, unit: result.value.unit, detail }, { label: "均值", display: topicValue(id, result.value.raw / days, false), unit: result.value.unit, detail: `${detail} · 周期合计 ÷ ${days} 个完整业务日` });
    if (["M081", "M036"].includes(id)) statistics.push({ label: id === "M081" ? "周期观影率" : "周期有效观影率", display: result.value.display, unit: result.value.unit, detail: `${detail} · ${id === "M081" ? "观影人天 ÷ 活跃人天" : "有效观影次数 ÷ 成功起播次数"}，不平均日比率` });
  }
  return dailyMetricReading(model, { date: range.end, compared, statistics, read: date => {
    const day = daily(date).result;
    return { date, value: day.status === "available" ? day.value.raw : null, display: day.status === "available" ? day.value.display : "—", reason: day.status === "available" ? "完整" : day.label, calculation: day.status === "available" ? day.calculation : undefined };
  } });
}
export function monthCard(range: DateRangeValue, compared: boolean): DashboardMetricCardModel {
  return periodMetricReading(monthPeriodCard(range, compared), `${range.end.slice(0, 7)}-01 至 ${range.end} · 自然月`);
}
function monthPeriodCard(range: DateRangeValue, compared: boolean): DashboardMetricCardModel {
  const metric = topicMetric("M018"), end = range.end, start = `${end.slice(0, 7)}-01`;
  const previousMonth = new Date(`${start}T00:00:00Z`); previousMonth.setUTCMonth(previousMonth.getUTCMonth() - 1);
  const previousStart = previousMonth.toISOString().slice(0, 10), lastPrevious = new Date(`${start}T00:00:00Z`); lastPrevious.setUTCDate(0);
  const previousEnd = shiftDate(previousStart, Math.min(Number(end.slice(8)), lastPrevious.getUTCDate()) - 1);
  const complete = shiftDate(end, 1).slice(0, 7) !== end.slice(0, 7);
  const monthlySample = (date: string) => {
    const anchor = ({ "2026-04-30": 495260, "2026-05-31": 523701, "2026-06-30": 561980, "2026-07-31": 587612, "2026-08-31": 605932, "2026-09-08": 483612, "2026-08-08": 466940 } as Record<string, number>)[date];
    if (anchor !== undefined) return anchor;
    const progress = Number(date.slice(8)), month = Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7));
    return Math.round(210000 + 62000 * Math.sqrt(progress) * (1 + .08 * Math.sin(month)));
  };
  const raw = monthlySample(end), baseline = monthlySample(previousEnd), delta = raw - baseline, direction = changeDirection(delta);
  const point = (date: string, raw: number): DashboardMetricTrendPoint => ({ key: date, actualDate: date, label: date.slice(0, 7), value: { raw, display: topicValue("M018", raw), actualDate: date }, counterpart: null, differenceDisplay: null, state: "available", stateLabel: date === end && !complete ? "当月截至日" : "完整月" });
  return { metric: { ...metric, definitionLabel: metric.definition, aggregationLabel: `${start} 至 ${end} · ${complete ? "完整自然月" : "当月截至日"}` }, result: { status: "available", completeness: "complete", refresh: { status: "idle" }, value: { raw, display: topicValue("M018", raw, false), unit: "人" }, trendKind: "line", validationLabel: "演示数据", watermarkLabel: `数据至 ${END}`, comparison: compared ? { status: "available", label: complete ? "较上一自然月" : "较上月同期进度", display: `${delta > 0 ? "↑" : delta < 0 ? "↓" : "—"} ${Math.abs(delta / baseline * 100).toFixed(1)}%`, detail: `${start} 至 ${end} 对比 ${previousStart} 至 ${previousEnd}；月趋势逐点标注实际区间。`, direction, kind: "relative_change", rows: [{ label: "当前期", date: `${start} 至 ${end}`, value: topicValue("M018", raw) }, { label: "对比期", date: `${previousStart} 至 ${previousEnd}`, value: topicValue("M018", baseline) }], difference: { display: `${delta > 0 ? "+" : ""}${topicValue("M018", delta)}`, direction } } : null, trend: { current: Array.from({ length: 6 }, (_, i) => { const month = new Date(`${start}T00:00:00Z`); month.setUTCMonth(month.getUTCMonth() - (5 - i) + 1); month.setUTCDate(0); return point(i === 5 ? end : month.toISOString().slice(0, 10), monthlySample(i === 5 ? end : month.toISOString().slice(0, 10))); }), comparison: null } } };
}
export interface StructureRow { label: string; platform: string; userType: string; current: number; previous: number; calculation?:CalculationBasis }
export function structureRows(dimension: string, id: string, range: DateRangeValue = DEFAULT_RANGE): StructureRow[] {
  if (["platform", "users", "cross"].includes(dimension)) {
    const scopes: TopicScope[] = dimension === "platform" ? TOPIC_CLIENTS.slice(1).map(client => ({client: client.value, audience: "overall"})) : dimension === "users" ? TOPIC_AUDIENCES.slice(1).map(audience => ({client: "overall", audience: audience.value})) : TOPIC_CLIENTS.slice(1).flatMap(client => TOPIC_AUDIENCES.slice(1).map(audience => ({client: client.value, audience: audience.value})));
    return scopes.map(scope => { const result = topicCard(id, range, false, false, scope).result, before = topicCard(id, previousRange(range), false, false, scope).result;
      const platform = TOPIC_CLIENTS.find(item => item.value === scope.client)!.label, userType = TOPIC_AUDIENCES.find(item => item.value === scope.audience)!.label;
      if (result.status !== "available" || before.status !== "available") throw new Error(`维度结果未准入：${id}`);
      return { label: dimension === "cross" ? `${platform} · ${userType}` : dimension === "users" ? userType : platform, platform, userType, current: result.value.raw, previous: before.value.raw, calculation: result.calculation };
    });
  }
  const categories = dimension === "channel" ? Array.from({ length: 12 }, (_, i) => `演示渠道 ${String.fromCharCode(65 + i)}`) : ["自然新增", "推广新增"];
  const samples = [88531, 62408, 43400, 25291, 16344, 12597, 8952, 7204, 6200, 4150, 3230, 2510];
  const summarize=(period:DateRangeValue,i:number)=>{
    const facts=structureFacts(period,samples[i],i);
    const sum=(key:"base"|"count"|"hours")=>facts.reduce((total,row)=>total+row[key],0);
    if(id==="M036")return facts.reduce((n,row)=>n+row.effective,0)/facts.reduce((n,row)=>n+row.starts,0);
    if(rateIds.has(id)) return sum("count")/sum("base");
    if(id==="M026")return sum("count")/facts.length;
    if(id==="M101")return sum("base")*7;
    if(id==="M102")return sum("hours");
    if(topicUnit(id)==="分钟")return sum("hours")*60/sum("base");
    return sum("base")/facts.length;
  };
  return categories.map((label,i)=>({label,platform:label.split(" · ")[0],userType:label.split(" · ")[1]??"",current:summarize(range,i),previous:summarize(previousRange(range),i),calculation:structureCalculation(id,label,range,structureFacts(range,samples[i],i))}));
}
function structureFacts(period:DateRangeValue,sample:number,index:number) {
  return datesIn(period).map(date=>{const base=Math.round(sample*(1+.09*Math.sin(seed(date)*.23+index))),count=Math.round(base*(.65+index%5*.028)),starts=base*7;return {base,count,starts,effective:Math.round(starts*(.60+index%5*.028)),hours:Math.round(base*2.3)};});
}
function structureCalculation(id:string,label:string,range:DateRangeValue,facts:ReturnType<typeof structureFacts>):CalculationBasis|undefined {
  if(!["M081","M036"].includes(id))return undefined;
  const numerator=facts.reduce((n,row)=>n+(id==="M081"?row.count:row.effective),0),denominator=facts.reduce((n,row)=>n+(id==="M081"?row.base:row.starts),0),unit=id==="M036"?"次":facts.length>1?"人天":"人";
  return {formula:topicMetric(id).definition,scope:rangeLabel(range)+" · "+label+" · 合成样例",numerator:{name:id==="M081"?"观影用户"+(facts.length>1?"人天":"数"):"有效观看次数",value:numerator,unit},denominator:{name:id==="M081"?"活跃用户"+(facts.length>1?"人天":"数"):"起播次数",value:denominator,unit},result:denominator?(numerator/denominator*100).toFixed(2)+"%":"分母为0",percentage:true};
}
export function structureDaily(dimension:string,id:string,range:DateRangeValue,compared=false) {
  return datesIn(range).map(date=>{const rows=structureRows(dimension,id,{start:date,end:date}),before=shiftDate(date,-dayCount(range)),previous=structureRows(dimension,id,{start:before,end:before});return {date,overall:dailyValue(date,id),overallBasis:(()=>{const result=topicCard(id,{start:date,end:date},false).result;return result.status==="available"?result.calculation:undefined;})(),values:Object.fromEntries(rows.map(row=>[row.label,row.current])),basis:Object.fromEntries(rows.filter(row=>row.calculation).map(row=>[row.label,row.calculation!])),comparison:compared?{date:before,overall:dailyValue(before,id),overallBasis:(()=>{const result=topicCard(id,{start:before,end:before},false).result;return result.status==="available"?result.calculation:undefined;})(),basis:Object.fromEntries(previous.filter(row=>row.calculation).map(row=>[row.label,row.calculation!])),values:Object.fromEntries(previous.map(row=>[row.label,row.current]))}:undefined};});
}
export interface ContentRow { id: string; title: string; kind: string; attempts: number; starts: number; effective: number; hours: number; previous?: { attempts: number; starts: number; effective: number; hours: number } }
export const CONTENT_ROWS: ContentRow[] = Array.from({ length: 126 }, (_, i) => { const attempts = 58420 - i * 317, starts = Math.round(attempts * .946), effective = Math.round(starts * (.56 + (i % 13) * .019)); return { id: `demo-video-${String(i + 1).padStart(4, "0")}`, title: `演示内容 ${String(i + 1).padStart(3, "0")}`, kind: i % 3 ? "短视频" : "长视频", attempts, starts, effective, hours: Math.round(attempts * .035) }; });
export const contentValue = (row: ContentRow, id: string) => id === "M036" ? row.effective / row.starts : id === "M102" ? row.hours : id === "M097" ? row.starts : id === "M034" ? row.effective : row.attempts;
export function contentBaseline(row: ContentRow, id: string) {
  if (row.previous) return contentValue({ ...row, ...row.previous, previous: undefined }, id);
  const index = Number(row.id.slice(-4)), attempts = 57230 - (index - 1) * 309, starts = Math.round(attempts * .94), effective = Math.round(starts * (.55 + (index % 11) * .02));
  return id === "M036" ? effective / starts : id === "M102" ? Math.round(attempts * .033) : id === "M097" ? starts : id === "M034" ? effective : attempts;
}

export function contentRows(range: DateRangeValue): ContentRow[] {
  if (range.start === DEFAULT_RANGE.start && range.end === DEFAULT_RANGE.end) return CONTENT_ROWS;
  const project = (row: ContentRow, period: DateRangeValue, index: number) => { const rows = datesIn(period).map(date => { const attempts = Math.round(row.attempts / 7 * (1 + .12 * Math.sin(seed(date) * .29 + index))), starts = Math.round(attempts * .946), effective = Math.round(starts * (.56 + index % 13 * .019)); return { attempts, starts, effective, hours: Math.round(attempts * .035) }; }); return rows.reduce((sum, item) => ({ attempts: sum.attempts + item.attempts, starts: sum.starts + item.starts, effective: sum.effective + item.effective, hours: sum.hours + item.hours }), { attempts: 0, starts: 0, effective: 0, hours: 0 }); };
  return CONTENT_ROWS.map((row, i) => ({ ...row, ...project(row, range, i), previous: project(row, previousRange(range), i) }));
}
