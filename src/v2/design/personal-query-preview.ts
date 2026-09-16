import { computeFunnel, funnelFacts, FUNNEL_SAMPLE_EVENTS, type FunnelResult } from "./funnel-analysis-preview";
import metricSnapshot from "../../../server/v2/generated/metric-definitions.json";
import eventSnapshot from "./generated/event-catalog-preview.json";
import platformSnapshot from "../../../server/platforms/platform-catalog.v1.json";
import { SAMPLE_EVENTS, eventConfigurationIssue, eventItemSeries } from "./event-analysis-preview";
import { corePeriodMetric } from "./core-period-preview";
import { rangeError, shiftDate } from "../../components/ui/date-range-model";
import { analysisFingerprint, type AnalysisConfig } from "./personal-workspace-model";

export const workspaceMetrics = metricSnapshot.items;
export const workspaceEvents = eventSnapshot.items;
export const workspacePlatforms = platformSnapshot.items.filter(item => item.enabled).sort((a, b) => a.order - b.order);
export const PREVIEW_METRICS = new Set(["M016", "M008", "M026", "M102", "M059", "M058", "M081", "M036", "M020"]);
export const PREVIEW_EVENTS = SAMPLE_EVENTS;
export const previewDateLimits = { today: "2026-09-10", minDate: "2026-03-13", maxDate: "2026-09-08", maxDays: 180 };
export interface AnalysisPoint { date: string; actualDate: string; value: number | null; display: string; state: string }
export interface AnalysisSeries { key: string; itemKey?: string; groupValues?: Record<string, string | number | boolean | null>; name: string; unit: string; points: AnalysisPoint[]; summary: string; summaryRaw: number | null; note: string; previous?: boolean }
export interface AnalysisResult { fingerprint: string; config: AnalysisConfig; series: AnalysisSeries[]; totals?: AnalysisSeries[]; funnel?: FunnelResult; warnings: string[] }
export function configurationError(config: AnalysisConfig) {
  const min=config.kind==="funnels"?2:1,max=config.kind==="funnels"?10:5;
  if (config.items.length<min || config.items.length>max) return `请选择${min}～${max}个分析项。`;
  if(config.kind==="funnels" && (config.items.some(i=>i.ref && !FUNNEL_SAMPLE_EVENTS.has(i.ref)) || !Number.isInteger(config.windowMinutes??1440) || (config.windowMinutes??1440)<1 || (config.windowMinutes??1440)>43200 || config.comparison)) return "漏斗样例支持已标记事件和1分钟～30天窗口，周期对比待接入。";
  if (config.items.some(item => !item.ref)) return "请先为每个分析项选择指标或事件。";
  const definitions = config.kind === "metrics" ? workspaceMetrics : workspaceEvents;
  if (config.items.some(item => !definitions.some(definition => definition.id === item.ref))) return "所选定义已失效，请重新选择。";
  if (config.items.some(item => item.version !== (config.kind === "metrics" ? workspaceMetrics.find(m => m.id === item.ref)!.authority.version : workspaceEvents.find(e => e.id === item.ref)!.version))) return "引用的权威版本已变化，请重新选择并核对。";
  return rangeError(config.range, previewDateLimits) || (config.kind !== "metrics" ? eventConfigurationIssue(config) : (config.filters?.length || config.secondaryGroup && config.secondaryGroup !== "none" || config.grain && config.grain !== "day") ? "当前指标样例仅支持按日查询，其他能力待接入。" : null);
}
const display = (value: number | null) => value === null ? "—" : value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
export function analysisCellDisplay(value: number | null, unit: string) { return display(value !== null && ["%", "比例"].includes(unit) ? value * 100 : value); }
export function queryAnalysisPreview(config: AnalysisConfig): AnalysisResult {
  const error = configurationError(config);
  if (error) throw new Error(error);
  const result: AnalysisResult = { fingerprint: analysisFingerprint(config), config: structuredClone(config), series: [], warnings: [] };
  if (config.scope !== "overall" && (config.kind !== "metrics" || !workspacePlatforms.some(platform => platform.pid === config.scope))) {
    result.warnings.push("当前样例未提供该业务平台的独立结果；已保留选择，未以大盘结果替代。");
    return result;
  }
  if (config.kind === "metrics" && config.group !== "none") {
    result.warnings.push("当前指标样例未提供平台维度查询；正式能力需按所选指标交集接入。");
    return result;
  }
  if (config.kind === "funnels") {
    result.funnel=computeFunnel(config,funnelFacts(config.range.start,shiftDate(config.range.end,30)));
    result.series=result.funnel.groups.map((g,i)=>({key:String(i),name:g.name,unit:"人",summary:String(g.steps[0].count),summaryRaw:g.steps[0].count,note:"合成有序事件 · 非业务结果",points:g.steps.map(s=>({date:s.name,actualDate:config.range.start+" 至 "+config.range.end,value:s.count,display:String(s.count),state:"合成样例"}))}));
    return result;
  }
  config.items.forEach(item => {
    if (config.kind === "metrics") {
      const definition = workspaceMetrics.find(metric => metric.id === item.ref)!;
      if (!PREVIEW_METRICS.has(item.ref)) { result.warnings.push(`${definition.name}：已登记定义，尚未提供本地查询样例。`); return; }
      const model = corePeriodMetric(item.ref, config.range, config.comparison);
      if (model.result.status !== "available") { result.warnings.push(`${definition.name}：当前范围暂无可展示样例。`); return; }
      const source = model.result;
      const points = (previous: boolean): AnalysisPoint[] => source.trend.current.map(point => ({ date: point.actualDate, actualDate: (previous ? point.counterpart : point.value)?.actualDate ?? point.actualDate, value: (previous ? point.counterpart : point.value)?.raw ?? null, display: analysisCellDisplay((previous ? point.counterpart : point.value)?.raw ?? null, source.value.unit), state: point.stateLabel }));
      result.series.push({ key: item.key, name: item.alias?.trim() || definition.name, unit: source.value.unit, points: points(false), summary: source.value.display, summaryRaw: source.value.raw, note: model.metric.aggregationLabel });
      if (config.comparison && source.trend.current.some(p => p.counterpart)) result.series.push({ key: item.key + ":previous", name: `${item.alias?.trim() || definition.name} · 对比期`, unit: source.value.unit, points: points(true), summary: "—", summaryRaw: null, note: "按同位置对齐对比日", previous: true });
    } else {
      const event = workspaceEvents.find(event => event.id === item.ref)!;
      if (!PREVIEW_EVENTS.has(item.ref)) { result.warnings.push(`${event.name}：尚未提供本地查询样例。`); return; }
      const queried = eventItemSeries(config, item);
      result.series.push(...queried.series);
      (result.totals ??= []).push(...queried.totals);
    }
  });
  if (config.scope !== "overall") result.series = result.series.map(series => ({ ...quickPlatformSample(series, config.scope)!, name: series.name }));
  return result;
}
export function resultRows(result: AnalysisResult) {
  return result.series.flatMap(series => series.points.map(point => [point.actualDate, series.name, point.value, series.unit, point.state]));
}

/** Deterministic PID fixtures shared by quick view and its analysis handoff. */
export function quickPlatformSample(series:AnalysisSeries|undefined,pid:string):AnalysisSeries|undefined {
  if(!series)return undefined;
  const index=workspacePlatforms.findIndex(item=>item.pid===pid);
  if(index<0)return undefined;
  const factor=(date:string)=>{
    const day=Math.floor(Date.parse(date)/86400000);
    return ["%","比例"].includes(series.unit)?0.78+((index*7+day)%17)/100:0.025+(index%6)*0.013+((day+index)%7)*0.0008;
  };
  const points=series.points.map(point=>{const raw=point.value===null?null:point.value*factor(point.actualDate);const value=raw===null?null:["人","次"].includes(series.unit)?Math.round(raw):raw;return {...point,value,display:analysisCellDisplay(value,series.unit),state:"演示数据"};});
  const summaryRaw=points.length===1?points[0].value:series.summaryRaw===null?null:series.summaryRaw*factor(points.at(-1)?.actualDate??"2026-09-08");
  return {...series,key:series.key+":"+pid,name:workspacePlatforms[index].name,points,summaryRaw,summary:analysisCellDisplay(summaryRaw,series.unit),note:"平台演示数据，不代表真实平台结果"};
}
export function quickPlatformChange(id:string,date:string,current:AnalysisSeries|undefined,pid:string,offset:number) {
  const definition=workspaceMetrics.find(metric=>metric.id===id)!;
  const day=shiftDate(date,offset);
  const result=queryAnalysisPreview({...emptyQuickConfig(id,definition.authority.version),range:{start:day,end:day}});
  const baseline=quickPlatformSample(result.series[0],pid)?.summaryRaw;
  if(current?.summaryRaw==null||baseline==null)return "不可比";
  const ratio=["%","比例"].includes(current.unit);
  if(!ratio&&baseline===0)return "不可比（基准为0）";
  const change=ratio?(current.summaryRaw-baseline)*100:(current.summaryRaw-baseline)/Math.abs(baseline)*100;
  return (change>0?"+":"")+change.toFixed(2)+(ratio?" 个百分点":"%");
}
const emptyQuickConfig=(id:string,version:string):AnalysisConfig=>({kind:"metrics",items:[{key:id,ref:id,version,measure:"count"}],range:{start:"2026-09-08",end:"2026-09-08"},scope:"overall",comparison:false,group:"none"});
export const quickMetricDate = (id: string, date: string) => id === "M020" && date > "2026-09-07" ? "2026-09-07" : date;
export function quickSampleChange(id: string, date: string, current: AnalysisSeries | undefined, offset: number) {
  if (!current || current.summaryRaw === null || !PREVIEW_METRICS.has(id)) return "待支持";
  const referenceDate = shiftDate(date, offset), baseline = corePeriodMetric(id, { start: referenceDate, end: referenceDate }, false);
  if (baseline.result.status !== "available") return "不可比";
  const base = baseline.result.value.raw;
  const ratio = ["%", "比例"].includes(current.unit);
  if (!ratio && base === 0) return "不可比（基准为0）";
  const delta = ratio ? (current.summaryRaw - base) * 100 : (current.summaryRaw - base) / Math.abs(base) * 100;
  return `${delta > 0 ? "+" : ""}${delta.toFixed(2)}${ratio ? " 个百分点" : "%"}`;
}
