import { CARTESIAN_DEFAULTS } from "../../../contracts/chart-presentation";
import definitions from "../generated/metric-definitions-ui.json";
import { changeDirection } from "../../components/ui/change-presentation";
import { rangeError, shiftDate, type DateRangeValue } from "../../components/ui/date-range-model";
import type { DashboardMetricCardModel, DashboardMetricComparison } from "../features/dashboards/dashboard-metric-card-model";
import type { CalculationBasis } from "../features/dashboards/CalculationEvidence";
import { dailyMetricReading, periodMetricReading } from "../features/dashboards/daily-reading-model";

// All values in this file are DEV-only fabricated fixtures, not business query results.
export const ACQUISITION_IDS = ["M001", "M003", "M008", "M005", "M006", "M007", "M033", "M037", "M038"] as const;
export const DEFAULT_ACQUISITION_FILTERS = { start: "2026-09-02", end: "2026-09-08", scope: "all", channel: "all", comparison: "none" };
export type AcquisitionFilters = typeof DEFAULT_ACQUISITION_FILTERS;
export const CURRENT_DATES = ["2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06", "2026-09-07", "2026-09-08"];
export const BASELINE_DATES = ["2026-08-26", "2026-08-27", "2026-08-28", "2026-08-29", "2026-08-30", "2026-08-31", "2026-09-01"];
const authority = new Map(definitions.items.map(item => [item.id, item]));
export function acquisitionMetric(id: string) { const item = authority.get(id); if (!item) throw new Error(`Missing metric authority ${id}`); return item; }
export function fixtureSupports(filters: AcquisitionFilters) { return !rangeError(filters, { today: "2026-09-10", maxDate: "2026-09-08", maxDays: 366 }) && filters.scope === "all" && filters.channel === "all" && ["previous", "none"].includes(filters.comparison); }
export const acquisitionDates = (range: DateRangeValue) => Array.from({ length: (Date.parse(range.end) - Date.parse(range.start)) / 86400000 + 1 }, (_, i) => shiftDate(range.start, i));
export const acquisitionBaseline = (range: DateRangeValue) => ({ start: shiftDate(range.start, -acquisitionDates(range).length), end: shiftDate(range.start, -1) });
export const acquisitionRangeLabel = (range: DateRangeValue) => `${range.start} 至 ${range.end}`;
export const metricUnit = (id: string) => ["M001", "M003"].includes(id) ? "次" : ["M008", "M011", "M038"].includes(id) ? "人" : "%";
export function fixtureValue(id: string, value: number | null, withUnit = true) {
  if (value === null) return "—";
  const unit = metricUnit(id);
  return unit === "%" ? `${(value * 100).toFixed(2)}%` : value.toLocaleString("en-US", { maximumFractionDigits: 0 }) + (withUnit ? ` ${unit}` : "");
}
export function fixtureComparison(id: string, current: number | null, baseline: number | null, range: DateRangeValue = DEFAULT_ACQUISITION_FILTERS, baselineRange: DateRangeValue = acquisitionBaseline(range)): DashboardMetricComparison {
  if (current === null || baseline === null) return { status: "unavailable", label: "较对比周期", detail: "本期或对比期缺失，无法比较。" };
  const ratio = metricUnit(id) === "%";
  if (!ratio && baseline === 0) return { status: "unavailable", label: "较对比周期", detail: `当前期 ${fixtureValue(id, current)}；对比期 0，无法计算变化率。` };
  const delta = current - baseline;
  const change = ratio ? delta * 100 : delta / baseline * 100;
  const direction = changeDirection(delta);
  const display = `${direction === "up" ? "↑" : direction === "down" ? "↓" : "—"} ${Math.abs(change).toFixed(ratio ? 2 : 1)}${ratio ? " 个百分点" : "%"}`;
  return { status: "available", label: "较对比周期", display, direction, kind: ratio ? "percentage_point" : "relative_change", detail: "", rows: [{ label: "当前期", date: acquisitionRangeLabel(range), value: fixtureValue(id, current) }, { label: "对比期", date: acquisitionRangeLabel(baselineRange), value: fixtureValue(id, baseline) }], difference: { display: `${delta > 0 ? "+" : ""}${ratio ? (delta * 100).toFixed(2) + " 个百分点" : fixtureValue(id, delta)}`, direction } };
}
const sum = (items: number[]) => items.reduce((total, value) => total + value, 0);
const visits = [82000, 85000, 91000, 89000, 94000, 91000, 89804];
const clicks = [13200, 13800, 14200, 14600, 15900, 15400, 15378];
const registrations = [6000, 6200, 6800, 6700, 7100, 7000, 6826];
const previousVisits = [80000, 83000, 86000, 87000, 90000, 87000, 87000];
const previousClicks = [12500, 13100, 13300, 14200, 15100, 14500, 14300];
const previousRegistrations = [6100, 6500, 6600, 7000, 7100, 7200, 7126];
const downloadIpDays = [9000, 9300, 10000, 10100, 11000, 10800, 10600];
const visitIpDays = [40000, 41000, 43500, 43100, 46000, 44500, 44300];
const previousDownloadIpDays=[9100,9500,10100,10200,11000,10700,10800];
const previousVisitIpDays=[41000,42000,44000,43500,46000,45000,44800];
const ratio = (n: number[], d: number[]) => n.map((value, index) => value / d[index]);
const samples: Record<string, { current: number; baseline: number; values: number[]; previous: number[]; note?: string }> = {
  M001: { current: sum(visits), baseline: sum(previousVisits), values: visits, previous: previousVisits },
  M003: { current: sum(clicks), baseline: sum(previousClicks), values: clicks, previous: previousClicks },
  M008: { current: sum(registrations), baseline: sum(previousRegistrations), values: registrations, previous: previousRegistrations },
  M005: { current: sum(clicks) / sum(visits), baseline: sum(previousClicks) / sum(previousVisits), values: ratio(clicks, visits), previous: ratio(previousClicks, previousVisits) },
  M006: { current: sum(registrations) / sum(downloadIpDays), baseline: sum(previousRegistrations)/sum(previousDownloadIpDays), values: ratio(registrations, downloadIpDays), previous: ratio(previousRegistrations,previousDownloadIpDays), note: "趋势参考，非精确漏斗 · 按下载 IP·天比较" },
  M007: { current: sum(registrations) / sum(visitIpDays), baseline: sum(previousRegistrations)/sum(previousVisitIpDays), values: ratio(registrations, visitIpDays), previous: ratio(previousRegistrations,previousVisitIpDays), note: "趋势参考，非精确漏斗 · 按访问 IP·天比较" },
  M033: { current: .8364, baseline: .8242, values: [.821, .827, .833, .831, .841, .846, .85], previous: [.816, .818, .821, .825, .83, .829, .831] },
  M037: { current: .4968, baseline: .4851, values: [.476, .48, .493, .497, .51, .51, .511], previous: [.47, .475, .48, .488, .491, .493, .499] },
  M038: { current: 15910, baseline: 15204, values: [2040, 2080, 2180, 2270, 2400, 2480, 2460], previous: [1900, 2010, 2140, 2220, 2300, 2310, 2324] }
};
/** Calendar-keyed synthetic observations: the same day has the same value in every range. */
function dailySample(id: string, date: string): number {
  if(id==="M006"||id==="M007")return dailySample("M008",date)/ipObservation(id,date);
  const current = CURRENT_DATES.indexOf(date), previous = BASELINE_DATES.indexOf(date);
  if (current >= 0) return samples[id].values[current];
  if (previous >= 0) return samples[id].previous[previous];
  const ordinal = Math.floor(Date.parse(date) / 86400000), seed = Number(id.slice(1));
  const wave = Math.sin(ordinal * .37 + seed) * .09 + Math.cos(ordinal * .13 + seed) * .055;
  if (id === "M005") return dailySample("M003", date) / dailySample("M001", date);
  return metricUnit(id) === "%" ? Math.max(0, Math.min(1, samples[id].current + wave * .18)) : Math.round(samples[id].current / 7 * (1 + wave));
}
function ipObservation(id:string,date:string) {
  const index=CURRENT_DATES.indexOf(date),prior=BASELINE_DATES.indexOf(date);
  if(index>=0)return (id==="M006"?downloadIpDays:visitIpDays)[index];
  if(prior>=0)return (id==="M006"?previousDownloadIpDays:previousVisitIpDays)[prior];
  // Synthetic IP membership counts, independent of the ratio output.
  return Math.round(dailySample(id==="M006"?"M003":"M001",date)*(id==="M006"?.68:.49));
}
export function acquisitionCalculation(id:string,dates:string[]):CalculationBasis|undefined {
  if(!["M005","M006","M007"].includes(id)||!dates.length)return undefined;
  const numerator=sum(dates.map(date=>dailySample(id==="M005"?"M003":"M008",date))),denominator=sum(dates.map(date=>id==="M005"?dailySample("M001",date):ipObservation(id,date)));
  return {formula:acquisitionMetric(id).definition,scope:`${dates[0]} 至 ${dates.at(-1)} · ${dates.length}个完整业务日 · 合成样例`,numerator:{name:id==="M005"?"落地页下载点击次数":"注册用户数（区间排重）",value:numerator,unit:id==="M005"?"次":"人"},denominator:{name:id==="M005"?"落地页访问次数":id==="M006"?"下载IP·天合计":"落地页访问IP·天合计",value:denominator,unit:id==="M005"?"次":"IP·天"},result:denominator?`${(numerator/denominator*100).toFixed(2)}%`:"分母为0",percentage:true};
}
function periodSample(id: string, range: DateRangeValue) {
  const dates = acquisitionDates(range), baselineDates = acquisitionDates(acquisitionBaseline(range));
  const aggregate = (days: string[]) => {
    if (days.length === 1) return dailySample(id, days[0]);
    if (metricUnit(id) !== "%") return sum(days.map(date => dailySample(id, date)));
    if (id === "M005") return sum(days.map(date => dailySample("M003", date))) / sum(days.map(date => dailySample("M001", date)));
    if (["M006", "M007"].includes(id)) return sum(days.map(date => dailySample("M008", date))) / sum(days.map(date => ipObservation(id,date)));
    const bases = days.map(date => dailySample("M008", date));
    return sum(days.map((date, i) => dailySample(id, date) * bases[i])) / sum(bases);
  };
  return { ...samples[id], current: aggregate(dates), baseline: aggregate(baselineDates), values: dates.map(date => dailySample(id, date)), previous: baselineDates.map(date => dailySample(id, date)) };
}
export function acquisitionCards(comparison: boolean, mixed = false, recovered: string[] = [], range: DateRangeValue = DEFAULT_ACQUISITION_FILTERS) {
  if (rangeError(range, { today: "2026-09-10", maxDate: "2026-09-08", maxDays: 366 })) throw new Error("演示日期范围无效");
  const currentDates = acquisitionDates(range), baselineDates = acquisitionDates(acquisitionBaseline(range));
  return ACQUISITION_IDS.map(id => {
    const metric = acquisitionMetric(id), sample = range.start === DEFAULT_ACQUISITION_FILTERS.start && range.end === DEFAULT_ACQUISITION_FILTERS.end ? samples[id] : periodSample(id, range);
    const aggregation = ["M033", "M037", "M038"].includes(id) ? "首次体验窗口" : metricUnit(id) === "%" ? "区间转化率" : "区间累计";
    const model: DashboardMetricCardModel = { metric: { id, name: metric.name, definitionLabel: metric.definition, aggregationLabel: `${acquisitionRangeLabel(range)} · ${aggregation}` }, result: { status: "available", completeness: "complete", refresh: { status: "idle" }, value: { raw: sample.current, display: fixtureValue(id, sample.current, false).replace(/%$/, ""), unit: metricUnit(id) }, comparison: comparison ? fixtureComparison(id, sample.current, sample.baseline, range) : null, trendKind: CARTESIAN_DEFAULTS.time_trend, validationLabel: "演示数据", watermarkLabel: "数据至 09-08", trend: { current: [], comparison: null } } };
    if (model.result.status !== "available") return { model, note: sample.note };
    const result = model.result;
    if(!mixed)result.calculation=acquisitionCalculation(id,currentDates);
    const values: (number | null)[] = mixed && id === "M001" ? sample.values.map((v, index) => index === 1 ? 0 : v) : mixed && id === "M005" ? sample.values.map((v, index) => index === 1 || index === 3 ? null : v) : sample.values;
    if (mixed && id === "M001") { result.value = { raw: sum(values as number[]), display: fixtureValue(id, sum(values as number[]), false), unit: metricUnit(id) }; result.comparison = comparison ? fixtureComparison(id, result.value.raw, sample.baseline, range) : null; }
    if (mixed && id === "M005") { result.completeness = "partial"; const completeDates=currentDates.filter((_,i)=>values[i]!==null); const basis=acquisitionCalculation(id,completeDates); result.calculation=basis; const value=basis!.numerator.value!/basis!.denominator.value!; result.value={raw:value,display:fixtureValue(id,value,false),unit:"%"}; result.comparison=null; }
    result.trend.current = values.map((value, index) => ({ key: currentDates[index], calculation:!mixed?acquisitionCalculation(id,[currentDates[index]]):undefined, label: currentDates[index].slice(5), actualDate: currentDates[index], value: value === null ? null : { raw: value, display: fixtureValue(id, value), actualDate: currentDates[index] }, counterpart: comparison ? { raw: sample.previous[index], display: fixtureValue(id, sample.previous[index]), actualDate: baselineDates[index] } : null, differenceDisplay: comparison && value !== null ? `${value > sample.previous[index] ? "+" : ""}${metricUnit(id) === "%" ? ((value - sample.previous[index]) * 100).toFixed(2) + " 个百分点" : fixtureValue(id, value - sample.previous[index])}` : null, state: value === null ? "not_produced" : "available", stateLabel: value === null ? mixed&&id==="M005"&&index===1?"分母为0":"未产出" : "完整" }));
    result.trend.comparison = comparison ? sample.previous.map((value, index) => ({ ...result.trend.current[index], calculation:!mixed?acquisitionCalculation(id,[baselineDates[index]]):undefined, key: baselineDates[index], actualDate: baselineDates[index], value: { raw: value, display: fixtureValue(id, value), actualDate: baselineDates[index] }, counterpart: result.trend.current[index].value, state: "available", stateLabel: "完整" })) : null;
    if (mixed && id === "M003") model.result = { status: "not_produced", contextLabel: "当前期", retryable: false, message: "落地页下载结果尚未产出，其他指标继续展示。" };
    if (mixed && id === "M037" && !recovered.includes(id)) model.result = { status: "failed", contextLabel: "当前期", retryable: true, message: "首次激活结果暂时无法加载，可仅重试此卡。" };
    return { model, note: sample.note };
  });
}

/** Ordinary KPI presentation; the period projection above remains shared by diagnostics and exports. */
export function acquisitionDailyCards(comparison: boolean, mixed = false, recovered: string[] = [], range: DateRangeValue = DEFAULT_ACQUISITION_FILTERS) {
  return acquisitionCards(comparison, mixed, recovered, range).map(item => {
    if (["M033", "M037", "M038"].includes(item.model.metric.id)) return { ...item, model: periodMetricReading(item.model, `${acquisitionRangeLabel(range)} · 首次体验批次`) };
    const id = item.model.metric.id, result = item.model.result;
    const counts = ["M001", "M003", "M008"].includes(id), complete = result.status === "available" && result.completeness === "complete", days = acquisitionDates(range).length;
    const statistics = complete && days > 1 ? [{ label: counts ? "合计" : "周期转化率", display: result.value.display, unit: result.value.unit, detail: `${acquisitionRangeLabel(range)} · ${counts ? "按对应业务日累计" : "按周期合法分子、分母重算，不平均日比率"} · 演示数据` }, ...(counts ? [{ label: "均值", display: (result.value.raw / days).toLocaleString("zh-CN", { maximumFractionDigits: 2 }), unit: result.value.unit, detail: `${acquisitionRangeLabel(range)} · 周期合计 ÷ ${days} 个完整业务日 · 演示数据` }] : [])] : [];
    return { ...item, model: dailyMetricReading({ ...item.model, metric: { ...item.model.metric, aggregationLabel: `${acquisitionRangeLabel(range)} · 业务日` } }, { date: range.end, compared: comparison, statistics, read: date => {
      const point = result.status === "available" ? result.trend.current.find(point => point.actualDate === date) : undefined;
      const value = point ? point.value?.raw ?? null : dailySample(id, date);
      return { date, value, display: fixtureValue(id, value, false), reason: point?.stateLabel, calculation: point?.calculation ?? (value === null ? undefined : acquisitionCalculation(id, [date])) };
    } }) };
  });
}

export type AcquisitionDimension = "channel" | "target" | "type";
export const DETAIL_METRICS: Record<AcquisitionDimension, string[]> = { channel: ["M008", "M001", "M003", "M005", "M006", "M007", "M099"], target: ["M008", "M001", "M003", "M005", "M099"], type: ["M008"] };
export interface AcquisitionRow { name: string; values: Record<string, number | null>; baseline: Record<string, number | null>; state: string }
function row(name: string, values: Record<string, number>, baseline: Record<string, number>): AcquisitionRow { return { name, values, baseline, state: "完整" }; }
export const DETAIL_ROWS: Record<AcquisitionDimension, AcquisitionRow[]> = {
  channel: [
    row("推广渠道 A", { M001: 190000, M003: 33000, M008: 15500, M005: 33000/190000, M006: .69, M007: .162, M099: .23 }, { M001: 182000, M003: 31000, M008: 15900, M005: 31000/182000, M006: .70, M007: .165, M099: .228 }),
    row("推广渠道 B", { M001: 160000, M003: 28000, M008: 12100, M005: .175, M006: .65, M007: .155, M099: .24 }, { M001: 155000, M003: 27000, M008: 12000, M005: 27000/155000, M006: .64, M007: .15, M099: .238 }),
    row("合作渠道 C", { M001: 110000, M003: 17000, M008: 8500, M005: 17000/110000, M006: .68, M007: .16, M099: .21 }, { M001: 105000, M003: 16000, M008: 8300, M005: 16000/105000, M006: .67, M007: .158, M099: .20 }),
    row("直接访问", { M001: 100000, M003: 16000, M008: 6800, M005: .16, M006: .63, M007: .148, M099: .205 }, { M001: 96000, M003: 15000, M008: 7000, M005: .15625, M006: .65, M007: .15, M099: .21 }),
    row("未归类", { M001: 61804, M003: 8478, M008: 3726, M005: 8478/61804, M006: .60, M007: .13, M099: .19 }, { M001: 62000, M003: 8000, M008: 4426, M005: 8000/62000, M006: .63, M007: .14, M099: .18 })
  ],
  target: [
    row("Android", { M001: 370000, M003: 65000, M008: 29000, M005: 65000/370000, M099: .238 }, { M001: 355000, M003: 60000, M008: 30000, M005: 60000/355000, M099: .234 }),
    row("iOS", { M001: 150000, M003: 23500, M008: 10000, M005: 23500/150000, M099: .216 }, { M001: 148000, M003: 23000, M008: 10200, M005: 23000/148000, M099: .219 }),
    row("App Store", { M001: 101804, M003: 13978, M008: 7626, M005: 13978/101804, M099: .21 }, { M001: 97000, M003: 14000, M008: 7426, M005: 14000/97000, M099: .218 })
  ],
  type: [row("自然新增", { M008: 30100 }, { M008: 31626 }), row("内部导量", { M008: 16526 }, { M008: 16000 })]
};
export const SETTLEMENT_ROWS = [row("结算渠道 A", { M011: 13820 }, { M011: 14020 }), row("结算渠道 B", { M011: 10200 }, { M011: 9950 }), row("结算渠道 C", { M011: 7540 }, { M011: 7350 })];

/** DEV-only dimension snapshots share the applied range with cards and exports. */
export function acquisitionRows(dimension: AcquisitionDimension | "settlement", range: DateRangeValue): AcquisitionRow[] {
  const source = dimension === "settlement" ? SETTLEMENT_ROWS : DETAIL_ROWS[dimension];
  if (!["target","type"].includes(dimension)&&range.start === DEFAULT_ACQUISITION_FILTERS.start && range.end === DEFAULT_ACQUISITION_FILTERS.end) return source;
  const result = source.map(item => ({ ...item, values: { ...item.values }, baseline: { ...item.baseline } }));
  for (const id of Object.keys(source[0].values)) {
    const referenceId = id === "M011" ? "M008" : id === "M099" ? "M005" : id;
    const sample = periodSample(referenceId, range);
    for (const key of ["values", "baseline"] as const) {
      const amount = key === "values" ? sample.current : sample.baseline;
      const reference = key === "values" ? samples[referenceId].current : samples[referenceId].baseline;
      if (metricUnit(id) === "%") {
        result.forEach((item, i) => { item[key][id] = Math.min(1, source[i][key][id]! * amount / reference); });
      } else {
        const originalTotal = sum(source.map(item => item[key][id]!));
        const total = id === "M011" ? Math.round(originalTotal * amount / reference) : amount;
        let allocated = 0;
        result.forEach((item, i) => { const value = i === result.length - 1 ? total - allocated : Math.floor(total * source[i][key][id]! / originalTotal); item[key][id] = value; allocated += value; });
      }
    }
  }
  if(dimension==="type")for(const key of ["values","baseline"] as const){const daily=sourceDaily(key==="values"?range:acquisitionBaseline(range));for(const item of result)item[key].M008=daily.reduce((total,point)=>total+point.values[item.name],0);}
  if(dimension==="target")for(const key of ["values","baseline"] as const){const daily=downloadTargetDaily(key==="values"?range:acquisitionBaseline(range));for(const item of result)item[key].M003=daily.reduce((total,point)=>total+point.values[item.name],0);}
  for (const item of result) for (const key of ["values", "baseline"] as const) if ("M005" in item[key]) item[key].M005 = item[key].M003! / item[key].M001!;
  return result;
}
export function sourceDaily(range:DateRangeValue) {
  const source=DETAIL_ROWS.type,total=sum(source.map(row=>row.values.M008!));
  return acquisitionDates(range).map(date=>{const count=dailySample("M008",date);let allocated=0;return {date,values:Object.fromEntries(source.map((row,index)=>{const value=index===source.length-1?count-allocated:Math.floor(count*row.values.M008!/total);allocated+=value;return [row.name,value];}))};});
}
export function downloadTargetDaily(range:DateRangeValue) {
  const source=DETAIL_ROWS.target,total=sum(source.map(row=>row.values.M003!));
  return acquisitionDates(range).map(date=>{const count=dailySample("M003",date);let allocated=0;const values=Object.fromEntries(source.map((row,index)=>{const value=index===source.length-1?count-allocated:Math.floor(count*row.values.M003!/total);allocated+=value;return [row.name,value];}));return {date,values};});
}
