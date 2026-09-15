import { useState, type ReactNode } from "react";
import { Info } from "lucide-react";
import { DashboardPanel } from "../features/dashboards/DashboardPresentation";
import { GroupedTrend } from "../features/dashboards/GroupedTrend";
import { CalculationEvidence, type CalculationBasis } from "../features/dashboards/CalculationEvidence";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { PreviewExportControl } from "../features/dashboards/PreviewExportControl";
import { corePeriodMetric } from "./core-period-preview";
import { paymentDates, type PaymentRange } from "./payment-observations";
import { shiftDate } from "../../components/ui/date-range-model";
import { topicMetric } from "./topic-preview-fixtures";
import { downloadPreviewWorkbook, type WorkbookSheet } from "./preview-workbook";
import { CHART_PALETTE } from "../../theme/tokens";
import "./advertising-overview.css";
import { useLiveDashboard } from "../features/dashboards/LiveDashboardContext";
import { ConnectedAdvertising } from "./ConnectedAdvertising";

export const AD_IDS=["M094","M055","M111","M110"];
const unit=(id:string)=>id==="M111"?"%":id==="M110"?"次/人":id==="M055"?"次":"人";
const format=(id:string,value:number|null)=>value===null?"未产出":`${(value*(id==="M111"?100:1)).toLocaleString("zh-CN",{maximumFractionDigits:id==="M111"||id==="M110"?2:0})} ${unit(id)}`;
function facts(date:string,audience:string,mixed:boolean) {
  const baseResult=corePeriodMetric(audience==="new"?"M008":"M016",{start:date,end:date},false).result;
  const n=Math.floor(Date.parse(date)/86400000),base=baseResult.status==="available"?(audience==="new"?Math.floor(baseResult.value.raw*(.81+n%5*.012)):baseResult.value.raw):null;
  const users=base===null?null:Math.round(base*(.19+n%7*.003)),clicks=users===null?null:users*3+(n%5)*19;
  return {base,users,clicks: mixed&&date==="2026-09-06"?null:clicks};
}
function observation(id:string,date:string,audience:string,mixed:boolean) {
  const row=facts(date,audience,mixed),value=id==="M094"?row.users:id==="M055"?row.clicks:row.base?((id==="M111"?row.users:row.clicks)===null?null:(id==="M111"?row.users!:row.clicks!)/row.base):null;
  const basis:CalculationBasis|undefined=["M111","M110"].includes(id)?{formula:topicMetric(id).definition,scope:`${date} · ${audience==="new"?"注册当日新用户":"总体"} · 同快照合成样例`,numerator:{name:id==="M111"?"广告点击用户数":"广告点击次数",value:id==="M111"?row.users:row.clicks,unit:id==="M111"?"人":"次"},denominator:{name:audience==="new"?"注册当日新用户活跃数":"日活跃用户数",value:row.base,unit:"人"},result:format(id,value),percentage:id==="M111"}:undefined;
  return {value,basis,base:row.base,status:row.base===0&&["M111","M110"].includes(id)?"分母为0":value===null?"未产出":"完整"};
}
export function advertisingSheet(range:PaymentRange,audience:string,mixed=false,compared=false):WorkbookSheet {
  const days=paymentDates(range);
  return {name:"07_广告点击表现",rows:[["日期","指标","值","单位","人群","分子指标","分子值","分母指标","分母值","对比日期","对比值","状态"],...days.flatMap(date=>AD_IDS.map(id=>{const row=observation(id,date,audience,mixed),before=shiftDate(date,-days.length);return [date,topicMetric(id).name,row.value===null?null:row.value*(id==="M111"?100:1),unit(id),audience==="new"?"注册当日新用户":"总体",row.basis?.numerator.name??null,row.basis?.numerator.value??null,row.basis?.denominator.name??null,row.basis?.denominator.value??null,compared?before:null,compared?((value)=>value===null?null:value*(id==="M111"?100:1))(observation(id,before,audience,false).value):null,row.status];}))]};
}
export function AdvertisingOverview({range,audience,onAudience,compared=false,mixed=false,pending=false,onOpen}: {range:PaymentRange;audience:string;onAudience:(value:string)=>void;compared?:boolean;mixed?:boolean;pending?:boolean;onOpen:(title:string,content:ReactNode)=>void}) {
  const [id,setId]=useState("M094"),days=paymentDates(range),label=audience==="new"?"注册当日新用户":"总体";
  const live = useLiveDashboard();
  if (live) return <ConnectedAdvertising live={live} audience={audience} onAudience={onAudience} onOpen={onOpen} id={id} setId={setId} />;
  const detail=(metric:string)=>{const row=observation(metric,range.end,audience,mixed);onOpen(topicMetric(metric).name,<><p>{range.end} · {label} · {format(metric,row.value)}</p><p>{topicMetric(metric).definition}</p>{row.basis&&<CalculationEvidence basis={row.basis}/>}</>);};
  return <DashboardPanel title="广告点击表现" note={`摘要日期 ${range.end} · ${label} · 合成演示数据`} chartKind="advertising-summary-trend" tools={<SegmentedControl label="广告人群" value={audience} onChange={onAudience} options={[{value:"all",label:"总体"},{value:"new",label:"新用户"}]}/>}>
    <div className="ad-overview__summaries">{AD_IDS.map(metric=>{const row=observation(metric,range.end,audience,mixed),before=observation(metric,shiftDate(range.end,-days.length),audience,false);return <section key={metric} className={id===metric?"is-selected":""}><button type="button" className="ad-overview__choose" aria-pressed={id===metric} aria-label={`选择${topicMetric(metric).name}`} onClick={()=>setId(metric)}><span>{topicMetric(metric).name}</span><strong>{format(metric,row.value)}</strong></button><button type="button" className="ui-icon-button ad-overview__info" aria-label={`${topicMetric(metric).name}数值与计算依据`} onClick={()=>detail(metric)}><Info/></button>{compared&&<small>对比 {shiftDate(range.end,-days.length)}：{format(metric,before.value)}</small>}</section>;})}</div>
    <details className="payment-business__advanced"><summary>导航广告与总点击</summary>
      <p>导航广告指导航Tab中的广告，不是底部导航按钮。现有导航统计接口已登记，真实结果及分类覆盖待接入核对。</p>
      <div className="ad-overview__summaries">{["导航广告点击次数","导航广告点击IP数","总点击次数","总点击人数（去重）"].map(name=><section key={name}><span>{name}</span><strong>—</strong><small>待接入</small></section>)}</div>
      <p>总点击次数仅在广告与导航广告互斥、日期和平台一致时相加；总点击人数需跨类去重。接口IP数不替代账号用户数，不据此生成占比。</p>
    </details>
    <GroupedTrend title={topicMetric(id).name} groups={[{id:"current",label:topicMetric(id).name,color:CHART_PALETTE[0]}]} points={days.map(date=>{const row=observation(id,date,audience,mixed),before=shiftDate(date,-days.length);return {date,values:{current:row.value},states:{current:row.status},basis:row.basis?{current:row.basis}:undefined,comparison:compared?{date:before,values:{current:observation(id,before,audience,false).value},basis:observation(id,before,audience,false).basis?{current:observation(id,before,audience,false).basis!}:undefined}:undefined};})} kind={["M111","M110"].includes(id)?"line":"bar"} unit={unit(id)} format={value=>format(id,value)} queryKey={JSON.stringify([range,audience,id])} onOpen={onOpen} exportAction={<PreviewExportControl name="广告点击表现" scope="已应用人群下四项指标全部日期及计算依据，摘要为结束业务日" context="合成演示数据" pending={pending} onDownloadPreview={()=>downloadPreviewWorkbook("广告点击表现",[advertisingSheet(range,audience,mixed,compared)])}/>} />
  </DashboardPanel>;
}
