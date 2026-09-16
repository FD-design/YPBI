import catalog from "./generated/event-catalog-preview.json";
import { shiftDate } from "../../components/ui/date-range-model";
import { matchesFilter, type SampleEventFact } from "./event-analysis-preview";
import type { AnalysisConfig } from "./personal-workspace-model";

export { FUNNEL_SAMPLE_EVENTS } from "./analysis-sample-capabilities";
export const FUNNEL_WATERMARK = Date.parse("2026-09-09T00:00:00+08:00");
export interface FunnelFact extends SampleEventFact { event: string; seq: number; pid: string }
export interface FunnelStep { name: string; count: number; overall: number | null; conversion: number | null; loss: number | null; lossRate: number | null; medianMs: number | null }
export interface FunnelGroup { name: string; steps: FunnelStep[]; medianMs: number | null; trend: { date: string; entered: number; converted: number; rate: number | null }[] }
export interface FunnelResult { groups: FunnelGroup[]; pending: number; watermark: string; identity: string; excluded: number }
const median = (values: number[]) => { const sorted=[...values].sort((a,b)=>a-b), n=sorted.length; return n ? (sorted[Math.floor((n-1)/2)]+sorted[Math.floor(n/2)])/2 : null; };
const before = (a: FunnelFact, b: FunnelFact) => a.timestamp < b.timestamp || a.timestamp === b.timestamp && a.seq < b.seq;

// Fixed synthetic event stream; independent of the selected steps and their filters.
export function funnelFacts(start: string, end: string): FunnelFact[] {
  const facts:FunnelFact[]=[];
  const days=Math.round((Date.parse(end)-Date.parse(start))/86400000)+1;
  const paths=[["video_content_click","video_play_start","video_watch_stay"],["recharge_page_view","recharge_submit_click","order_create_request_result"]];
  for(let i=0;i<days;i++) {
    const date=shiftDate(start,i), day=Math.floor(Date.parse(date)/86400000);
    for(let user=0;user<24;user++) for(let path=0;path<paths.length;path++) {
      const depth=1+(user+day+path)%3;
      for(let step=0;step<depth;step++) {
        const timestamp=Date.parse(date+"T10:00:00+08:00")+user*60000+path*3600000+step*(1+user%9)*60000;
        if(timestamp>FUNNEL_WATERMARK) continue;
        facts.push({id:`sample:${day}:${user}:${path}:${step}`,event:paths[path][step],subject:`sample-person-${user}`,pid:"sample-pid",date,timestamp,seq:day*1000+path*10+step,values:{platform:user%2?"ios":"android",is_login:user%7!==0,network:"wifi",source_channel:`sample_channel_${1+user%3}`}});
      }
    }
  }
  return facts;
}
export function computeFunnel(config: AnalysisConfig, facts: FunnelFact[], watermark=FUNNEL_WATERMARK): FunnelResult {
  const windowMs=(config.windowMinutes??1440)*60000;
  const from=Date.parse(config.range.start+"T00:00:00+08:00"),to=Date.parse(shiftDate(config.range.end,1)+"T00:00:00+08:00");
  const dedup=[...new Map(facts.map(f=>[f.id,f])).values()].filter(f=>(config.filters??[]).every(filter=>matchesFilter(f,filter)));
  const candidates=config.items.map(item=>dedup.filter(f=>f.event===item.ref&&(item.filters??[]).every(filter=>matchesFilter(f,filter))));
  const entered=candidates[0].filter(f=>f.timestamp>=from&&f.timestamp<to);
  const pending=entered.filter(f=>f.timestamp+windowMs>watermark).length;
  const representatives=new Map<string,FunnelFact[]>();
  for(const entry of entered.filter(f=>f.timestamp+windowMs<=watermark)) {
    const levels:FunnelFact[][]=[[entry]];
    for(let step=1;step<config.items.length;step++) {
      const previous=levels[step-1], reachable=candidates[step].filter(f=>f.subject===entry.subject&&f.pid===entry.pid&&f.timestamp-entry.timestamp<=windowMs&&previous.some(p=>before(p,f)));
      if(!reachable.length) break;
      levels.push(reachable);
    }
    const complete=levels.length===config.items.length;
    const ordered=[...levels.at(-1)!].sort((a,b)=>a.timestamp-b.timestamp||a.seq-b.seq);
    const chain=[complete?ordered[0]:ordered.at(-1)!];
    for(let level=levels.length-2;level>=0;level--) chain.unshift([...levels[level]].filter(f=>before(f,chain[0])).sort((a,b)=>b.timestamp-a.timestamp||b.seq-a.seq)[0]);
    const key=entry.pid+":"+entry.subject, old=representatives.get(key);
    const target=chain.at(-1)!, previous=old?.at(-1);
    if(!old || complete && (old.length<config.items.length || before(target,previous!)) || !complete && old.length<config.items.length && (chain.length>old.length || chain.length===old.length&&before(previous!,target))) representatives.set(key,chain);
  }
  const groups=new Map<string,FunnelFact[][]>();
  for(const chain of representatives.values()) { const value=config.group==="none"?"总体":String(chain[0].values[config.group]??"无值"); groups.set(value,[...(groups.get(value)??[]),chain]); }
  if(!groups.size) groups.set("总体",[]);
  return {pending,watermark:new Date(watermark).toISOString(),identity:"合成样例身份 v1 · 100%",excluded:0,groups:[...groups.entries()].map(([name,chains])=>{
    const counts=config.items.map((_,i)=>chains.filter(chain=>chain.length>i).length);
    return {name,medianMs:median(chains.filter(c=>c.length===config.items.length).map(c=>c.at(-1)!.timestamp-c[0].timestamp)),
      steps:config.items.map((item,i)=>({name:item.alias||catalog.items.find(e=>e.id===item.ref)?.name||item.ref,count:counts[i],overall:counts[0]?counts[i]/counts[0]:null,conversion:i&&counts[i-1]?counts[i]/counts[i-1]:null,loss:i?counts[i-1]-counts[i]:null,lossRate:i&&counts[i-1]?(counts[i-1]-counts[i])/counts[i-1]:null,medianMs:i?median(chains.filter(c=>c.length>i).map(c=>c[i].timestamp-c[i-1].timestamp)):null})),
      trend:Array.from({length:Math.round((Date.parse(config.range.end)-Date.parse(config.range.start))/86400000)+1},(_,i)=>{const date=shiftDate(config.range.start,i),entries=chains.filter(c=>c[0].date===date),converted=entries.filter(c=>c.length===config.items.length).length;return {date,entered:entries.length,converted,rate:entries.length?converted/entries.length:null};})};
    })};
}
