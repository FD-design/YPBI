import { useState } from "react";
import { ArrowDown, ArrowUp, Copy, Plus, Trash2 } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { DateRangePicker } from "../../components/ui/DateRangePicker";
import { TabList } from "../../components/ui/TabList";
import { PaginatedTable } from "../../components/ui/PaginatedTable";
import { Chart } from "../../components/Chart";
import { DefinitionSelect, FilterEditor, QuerySelect } from "./AnalysisQueryBuilder";
import { commonFields, eventFields } from "./event-analysis-preview";
import { configurationError, previewDateLimits, type AnalysisResult } from "./personal-query-preview";
import { localId, type AnalysisConfig } from "./personal-workspace-model";
import { downloadPreviewWorkbook } from "./preview-workbook";
import type { FunnelGroup } from "./funnel-analysis-preview";

const rate=(v:number|null)=>v===null?"—":(v*100).toFixed(2)+"%";
const time=(v:number|null)=>v===null?"—":(v/60000).toLocaleString("zh-CN",{maximumFractionDigits:2})+" 分钟";
export function FunnelQueryBuilder({config,onChange,desktop,onQuery}:{config:AnalysisConfig;onChange:(config:AnalysisConfig)=>void;desktop:boolean;onQuery:()=>void}) {
  const patch=(next:Partial<AnalysisConfig>)=>onChange({...config,...next});
  const error=configurationError(config);
  const reorder=(index:number,offset:number)=>{const items=[...config.items];[items[index],items[index+offset]]=[items[index+offset],items[index]];patch({items});};
  return <details open={desktop} className="personal-config-shell personal-surface"><summary>漏斗条件配置 · {config.items.length} 步</summary><div className="personal-config">
    <header><h2>有序人数漏斗</h2><span className="personal-note">同一合成主体 · 非严格相邻 · 单一演示业务平台</span></header>
    <p className="personal-note">可体验视频点击→起播→观看停留，或充值页→点击支付→下单结果。观看停留不等于有效播放，下单结果不等于支付成功；完整内容消费、支付成功与到账链路待权威映射和接口接入。</p>
    {config.items.map((item,index)=><section className="personal-analysis-item" key={item.key}>
      <div className="analysis-item-controls"><b>步骤 {index+1}</b><DefinitionSelect kind="funnels" item={item} disabled={!desktop} onChange={next=>patch({items:config.items.map((v,i)=>i===index?next:v)})} />
        <input aria-label={`步骤${index+1}别名`} placeholder="步骤别名（选填）" maxLength={40} disabled={!desktop} value={item.alias??""} onChange={e=>patch({items:config.items.map((v,i)=>i===index?{...v,alias:e.target.value}:v)})} />
        <Button icon={ArrowUp} variant="ghost" aria-label={`上移步骤${index+1}`} disabled={!desktop||index===0} onClick={()=>reorder(index,-1)} />
        <Button icon={ArrowDown} variant="ghost" aria-label={`下移步骤${index+1}`} disabled={!desktop||index===config.items.length-1} onClick={()=>reorder(index,1)} />
        <Button icon={Copy} variant="ghost" aria-label={`复制步骤${index+1}`} disabled={!desktop||config.items.length>=10} onClick={()=>patch({items:[...config.items,{...structuredClone(item),key:localId()}]})} />
        <Button icon={Trash2} variant="ghost" aria-label={`删除步骤${index+1}`} disabled={!desktop||config.items.length<=2} onClick={()=>patch({items:config.items.filter((_,i)=>i!==index)})} />
      </div>
      <FilterEditor label={`步骤${index+1}`} event={item.ref} fields={eventFields(item.ref)} filters={item.filters??[]} disabled={!desktop} onChange={filters=>patch({items:config.items.map((v,i)=>i===index?{...v,filters}:v)})} />
    </section>)}
    <Button icon={Plus} variant="ghost" disabled={!desktop||config.items.length>=10} onClick={()=>patch({items:[...config.items,{key:localId(),ref:"",version:"",measure:"users"}]})}>添加步骤（{config.items.length}/10）</Button>
    <section className="analysis-config-row"><h3>全局筛选</h3><FilterEditor label="全局" event={config.items[0].ref} fields={commonFields(config)} filters={config.filters??[]} disabled={!desktop} onChange={filters=>patch({filters})} /></section>
    <section className="analysis-config-row"><h3>日期与窗口</h3><div className="personal-tools">
      <fieldset className="analysis-fieldset" disabled={!desktop}><DateRangePicker value={config.range} onChange={range=>patch({range})} {...previewDateLimits}/></fieldset>
      <label className="personal-date">窗口（分钟）<input type="number" aria-label="转化窗口分钟" min={1} max={43200} value={config.windowMinutes??1440} disabled={!desktop} onChange={e=>patch({windowMinutes:Number(e.target.value)})}/></label>
      <QuerySelect label="漏斗分组" value={config.group} disabled={!desktop} options={[{value:"none",label:"不分组"},{value:"platform",label:"客户端平台"}]} onChange={group=>patch({group})}/>
      <small>首步日期 · 默认1天 · 1分钟～30天 · 后续步骤可跨日</small>
    </div></section>
    <details><summary>属性关联与正式查询能力</summary><p className="personal-note">跨步骤业务对象映射、周期对比与多业务平台查询尚未接入；本地合成样例不开放这些配置。正式身份、可靠水位与异常排除须按 PRD 第9章验收。</p></details>
    <footer className="personal-tools"><Button variant="primary" disabled={!!error} onClick={onQuery}>查询样例</Button><p className="personal-note">{error??"仅查询本地合成事件事实，不调用正式漏斗接口。"}</p></footer>
  </div></details>;
}
function stepRows(group:FunnelGroup) {return group.steps.map(s=>[s.name,s.count,s.overall,s.conversion===null?null:s.count,s.conversion,s.loss,s.lossRate,s.medianMs]);}
export function exportFunnel(result:AnalysisResult) {
  const f=result.funnel!;
  downloadPreviewWorkbook("漏斗合成样例",[
    {name:"00_导出说明",rows:[["数据","合成有序事件，非正式业务结果"],["配置快照",JSON.stringify(result.config)],["窗口分钟",result.config.windowMinutes??1440],["百分比","按0～1原值导出；耗时毫秒"]]},
    {name:"01_关键结果",rows:[["分组","起始用户","最终转化用户","总转化率","总流失用户","总耗时中位数毫秒"],...f.groups.map(g=>[g.name,g.steps[0].count,g.steps.at(-1)!.count,g.steps.at(-1)!.overall,g.steps[0].count-g.steps.at(-1)!.count,g.medianMs])]},
    {name:"02_步骤结果",rows:[["分组","步骤","到达用户数","相对首步转化率","上一步到本步转化人数","相邻转化率","相邻流失人数","相邻流失率","相邻耗时中位数毫秒"],...f.groups.flatMap(g=>stepRows(g).map(row=>[g.name,...row]))]},
    {name:"03_转化趋势",rows:[["分组","首步日期","成熟进入用户","最终转化用户","总转化率"],...f.groups.flatMap(g=>g.trend.map(t=>[g.name,t.date,t.entered,t.converted,t.rate]))]},
    {name:"99_数据状态与限制",rows:[["水位",f.watermark],["身份",f.identity],["待成熟进入",f.pending],["歧义排除",f.excluded],["业务链路","有效播放、支付成功、到账步骤待正式映射"]]}
  ]);
}
export function FunnelResultView({result,stale=false}:{result:AnalysisResult;stale?:boolean}) {
  const [view,setView]=useState("funnel"),[selected,setSelected]=useState("0");
  const f=result.funnel!,group=f.groups[Number(selected)]??f.groups[0],first=group.steps[0],last=group.steps.at(-1)!;
  return <div className="personal-result">
    {stale&&<p className="personal-warning" role="status">配置已修改，需重新查询；当前仍为上次漏斗结果。</p>}
    <p className="personal-note">共同水位 {f.watermark} · {f.identity} · 待成熟进入 {f.pending} 条（不进入分母或流失） · 歧义排除 {f.excluded} 人</p>
    <div className="personal-summary">{[["起始用户",first.count+" 人"],["最终转化",last.count+" 人"],["总转化率",rate(last.overall)],["总流失用户",first.count-last.count+" 人"],["总耗时中位数",time(group.medianMs)]].map(([name,value])=><section key={name}><h3>{name}</h3><strong>{value}</strong></section>)}</div>
    <div className="personal-tools"><QuerySelect label="查看漏斗分组" value={selected} onChange={setSelected} options={f.groups.map((g,i)=>({value:String(i),label:g.name==="android"?"Android":g.name==="ios"?"iOS":g.name}))}/><TabList label="漏斗结果展示" value={view} onChange={setView} panelId="funnel-result-panel" items={[{id:"funnel",label:"漏斗步骤"},{id:"trend",label:"转化趋势"},{id:"table",label:"表格"}]}/></div>
    <div id="funnel-result-panel" role="tabpanel">
      {view==="funnel"&&<Chart theme="v13" ariaLabel="有序人数漏斗步骤" style={{height:310}} option={{animation:false,tooltip:{trigger:"axis",renderMode:"richText",formatter:(params:any[])=>{const s=group.steps[params[0]?.dataIndex??0];return `${s.name}\n到达 ${s.count} 人\n相对首步 ${rate(s.overall)}\n相邻转化 ${rate(s.conversion)}\n流失 ${s.loss??"—"} 人\n相邻耗时中位数 ${time(s.medianMs)}`;}},grid:{left:50,right:25,top:35,bottom:40,containLabel:true},xAxis:{type:"category",data:group.steps.map((s,i)=>`${i+1}. ${s.name}`),axisLabel:{interval:0,width:130,overflow:"break"}},yAxis:{type:"value",min:0,name:"到达用户（人）"},series:[{type:"bar",barMaxWidth:80,label:{show:true,position:"top",formatter:(p:any)=>`${p.value} 人`},data:group.steps.map(s=>s.count)}]}}/>}
      {view==="trend"&&<Chart theme="v13" ariaLabel="漏斗总转化率趋势" style={{height:280}} option={{animation:false,tooltip:{trigger:"axis"},grid:{left:50,right:20,bottom:30,top:20,containLabel:true},xAxis:{type:"category",data:group.trend.map(t=>t.date)},yAxis:{type:"value",min:0,max:100,axisLabel:{formatter:"{value}%"}},series:[{name:"总转化率（%）",type:"line",connectNulls:false,data:group.trend.map(t=>t.rate===null?null:t.rate*100)}]}}/>}
    </div>
    <PaginatedTable label="漏斗完整聚合结果" columnCount={9} head={<tr>{["分组","步骤","到达用户","相对首步","相邻转化人数","相邻转化率","相邻流失人数","相邻流失率","相邻耗时中位数"].map(h=><th key={h}>{h}</th>)}</tr>} rows={f.groups.flatMap(g=>g.steps.map((s,i)=><tr key={g.name+i}><td>{g.name}</td><td>{s.name}</td><td>{s.count}</td><td>{rate(s.overall)}</td><td>{i?s.count:"—"}</td><td>{rate(s.conversion)}</td><td>{s.loss??"—"}</td><td>{rate(s.lossRate)}</td><td>{time(s.medianMs)}</td></tr>))}/>
  </div>;
}
