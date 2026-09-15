import { useState, type ReactNode } from "react";
import { DashboardPanel } from "../features/dashboards/DashboardPresentation";
import { CompositionChart } from "../features/dashboards/CompositionChart";
import { GroupedTrend, useGroupSelection, type GroupedTrendPoint } from "../features/dashboards/GroupedTrend";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { PaginatedTable } from "../../components/ui/PaginatedTable";
import { PreviewExportControl } from "../features/dashboards/PreviewExportControl";
import { CHART_PALETTE } from "../../theme/tokens";
import { paymentAggregate, paymentDates, paymentGroups, type PaymentDimension, type PaymentRange } from "./payment-observations";
import { downloadPreviewWorkbook, type WorkbookSheet, type WorkbookCell } from "./preview-workbook";
import { shiftDate } from "../../components/ui/date-range-model";
import { demoMetric } from "./extended-board-model";
import "./payment-breakdowns.css";
import { useLiveDashboard } from "../features/dashboards/LiveDashboardContext";
import { DataOriginBadge, DataOriginProvider } from "../components/DataOrigin";
import { connectedPaymentSnapshot, connectedPaymentPoints, connectedPaymentUnit, ConnectedPaymentExport } from "./connected-payment-data";

const groups=(dimension:PaymentDimension)=>paymentGroups[dimension].map((group,i)=>({...group,color:CHART_PALETTE[i]}));
const previous=(range:PaymentRange)=>({start:shiftDate(range.start,-paymentDates(range).length),end:shiftDate(range.start,-1)});
const money=(value:number|null)=>value===null?"未产出":`${value.toLocaleString("zh-CN",{minimumFractionDigits:2,maximumFractionDigits:2})} USD`;
const scope=(range:PaymentRange)=>`${range.start} 至 ${range.end} · 支付成功日 · USD · 合成演示数据`;
type Props={range:PaymentRange;compared:boolean;pending?:boolean;onOpen:(title:string,content:ReactNode)=>void;incomplete?:boolean;onRetry?:()=>void};
function resultRows(range:PaymentRange,dimension:PaymentDimension,compared:boolean,incomplete=false):WorkbookCell[][] {
  return [["记录","日期/范围","维度","分类","充值金额","总体金额","占比（%）","付费用户数","ARPPU","币种","对比日期","对比金额","对比付费用户数","对比ARPPU","状态"],...[{label:`${range.start} 至 ${range.end}`,range},...paymentDates(range).map(date=>({label:date,range:{start:date,end:date}}))].flatMap((row,index)=>{
    const total=paymentAggregate(row.range),before=index===0?previous(range):{start:shiftDate(row.range.start,-paymentDates(range).length),end:shiftDate(row.range.end,-paymentDates(range).length)};
    return groups(dimension).map(group=>{const value=paymentAggregate(row.range,{[dimension]:group.id}),missing=incomplete&&dimension==="product"&&group.id==="vip";return [index===0?"区间摘要":"逐日结果",row.label,dimension,group.label,missing?null:value.amount,total.amount,missing?null:value.amount/total.amount*100,value.users,missing?null:value.arppu,"USD",compared?`${before.start} 至 ${before.end}`:null,compared?paymentAggregate(before,{[dimension]:group.id}).amount:null,compared?paymentAggregate(before,{[dimension]:group.id}).users:null,compared?paymentAggregate(before,{[dimension]:group.id}).arppu:null,missing?"未产出":"合成演示数据"] as WorkbookCell[];});
  })];
}
export function paymentStructureSheets(range:PaymentRange,compared:boolean,incomplete=false):WorkbookSheet[] {
  return [{name:"03_付费结构",rows:resultRows(range,"stage",compared)},{name:"04_收入结构",rows:[...resultRows(range,"product",compared,incomplete),[],...resultRows(range,"client",compared),[],["商品×客户端","充值金额（USD）","状态"],...groups("product").flatMap(product=>groups("client").map(client=>[`${product.label} · ${client.label}`,incomplete&&product.id==="vip"?null:paymentAggregate(range,{product:product.id,client:client.id}).amount,incomplete&&product.id==="vip"?"未产出":"合成演示数据"]))]}];
}
function Export({title,sheet,pending}: {title:string;sheet:WorkbookSheet;pending?:boolean}) {
  return <PreviewExportControl name={title} scope="全部分组及完整日期，包含金额、占比、人数、ARPPU与状态；不受聚焦影响" context="USD · 合成演示数据，非正式业务结果" pending={pending} onDownloadPreview={()=>downloadPreviewWorkbook(title,[{name:"00_导出说明",rows:[["数据性质","本地合成演示数据"],["人数","每日与区间分别去重，不跨日或跨组相加"],["占比","同一行分类金额/总体金额；保留原总体分母"],["ARPPU","同一行金额/同范围付费去重人数"]]},sheet])}/>;
}
function points(range:PaymentRange,dimension:PaymentDimension,measure:"amount"|"users"|"arppu"|"share",compared:boolean,incomplete=false):GroupedTrendPoint[] {
  const snapshot=(date:string):Omit<GroupedTrendPoint,"date"|"comparison">=>{
    const period={start:date,end:date},total=paymentAggregate(period),categories=groups(dimension);
    const missing=(id:string)=>incomplete&&dimension==="product"&&id==="vip";
    const value=(id:string)=>{const row=paymentAggregate(period,{[dimension]:id});return missing(id)?null:measure==="share"?row.amount/total.amount:row[measure];};
    const calculated=measure==="arppu"||measure==="share";
    const calculation=(id?:string)=>{
      const row=id?paymentAggregate(period,{[dimension]:id}):total,label=categories.find(group=>group.id===id)?.label??"总体",unavailable=id?missing(id):false;
      return {formula:measure==="arppu"?demoMetric("M067").definition:"同范围分类充值金额 ÷ 总充值金额 × 100%",scope:scope(period),
        numerator:{name:id?`${label}充值金额`:"总充值金额",value:unavailable?null:row.amount,unit:"USD"},
        denominator:{name:measure==="arppu"?(id?`${label}付费用户数`:"付费用户数"):"总充值金额",value:measure==="arppu"?row.users:total.amount,unit:measure==="arppu"?"人":"USD"},
        result:unavailable?"未产出":measure==="arppu"?money(row.arppu):`${(row.amount/total.amount*100).toFixed(2)}%`,percentage:measure==="share"};
    };
    return {overall:measure==="share"?1:total[measure],
      overallBasis:calculated?calculation():undefined,
      shares:measure==="amount"?Object.fromEntries(categories.map(group=>[group.id,missing(group.id)?null:value(group.id)!/total.amount])):undefined,
      values:Object.fromEntries(categories.map(group=>[group.id,value(group.id)])),
      states:Object.fromEntries(categories.map(group=>[group.id,missing(group.id)?"未产出":"完整"])),
      basis:calculated?Object.fromEntries(categories.map(group=>[group.id,calculation(group.id)])):undefined};
  };
  return paymentDates(range).map(date=>{const before=shiftDate(date,-paymentDates(range).length);return {date,...snapshot(date),comparison:compared?{date:before,...snapshot(before)}:undefined};});
}
export function NewOldPayment({range,compared,pending,onOpen}:Props) {
  const live=useLiveDashboard();
  if(live) {range={start:live.query.dateRange[0],end:live.query.dateRange[1]};compared=Boolean(live.comparison);}
  const [measure,setMeasure]=useState("amount"),categories=groups("stage"),selection=useGroupSelection(categories,JSON.stringify(range));
  const read=(group?:string,before=false)=>live?connectedPaymentSnapshot(live,group?"stage":undefined,group,before?live.comparison?.query.dateRange[1]??range.end:range.end,before):paymentAggregate(before?previous(range):range,group?{stage:group}:{});
  const amountUnit=live?connectedPaymentUnit(live):"USD",arppuUnit=live?connectedPaymentUnit(live,"arppu"):"USD/人";
  const total=read(),money=(value:number|null,perUser=false)=>value===null?"—":value.toLocaleString("zh-CN",{maximumFractionDigits:2})+" "+(perUser?arppuUnit:amountUnit);
  const complete=total.amount!==null&&categories.every(group=>read(group.id).amount!==null)&&Math.abs(categories.reduce((sum,group)=>sum+read(group.id).amount!,0)-total.amount)<.01;
  const share=(value:number|null)=>!complete||value===null||!total.amount?"—":(value/total.amount*100).toFixed(2)+"%";
  const summaryScope=live?range.end+" · "+live.platformName+" · 单日 · "+amountUnit+" · 待验数":scope(range);
  const format=(value:number|null)=>measure==="users"?(value===null?"未产出":value.toLocaleString()+" 人"):money(value,measure==="arppu");
  return <DataOriginProvider value={live?"pending":"demo"}><DashboardPanel title="新老用户付费表现" note="按账号注册业务日分类；与首充、复购分别统计。" chartKind="payment-user-composition">
    <div className="payment-breakdown__overview">
    <CompositionChart title="充值金额构成" items={categories.map(group=>({...group,value:read(group.id).amount,comparison:compared?read(group.id,true).amount:undefined}))} total={total.amount} totalLabel="总充值金额" unit={amountUnit} scope={summaryScope} complete={complete} onOpen={onOpen} selected={selection.selected}/>
    <div className="payment-breakdown__summary"><p>整体付费用户数 {total.users?.toLocaleString()??"—"} 人 · {live?"主值 "+range.end:"区间去重"}；各组人数不相加为总体。</p><PaginatedTable label="新老付费摘要" resetKey={selection.selected.join()} columnCount={compared?6:5} head={<tr><th>用户阶段</th><th>充值金额</th><th>金额占比</th><th>付费用户数</th><th>ARPPU</th>{compared&&<th>充值金额变化</th>}</tr>} rows={[{id:"overall",label:"总体"},...categories.filter(group=>selection.selected.includes(group.id))].map(group=>{const row=read(group.id==="overall"?undefined:group.id),before=read(group.id==="overall"?undefined:group.id,true);return <tr key={group.id}><td>{group.label}</td><td>{money(row.amount)}</td><td>{share(row.amount)}</td><td>{row.users?.toLocaleString()??"—"} 人</td><td>{money(row.arppu,true)}</td>{compared&&<td>{money(row.amount===null||before.amount===null?null:row.amount-before.amount)}</td>}</tr>;})}/></div>
    </div>
    <div className="payment-breakdown__tools"><h3>每日付费趋势</h3><SegmentedControl label="新老付费趋势指标" value={measure} onChange={setMeasure} options={[{value:"amount",label:"充值金额"},{value:"users",label:"付费人数"},{value:"arppu",label:"ARPPU"}]}/></div>
    <GroupedTrend title="新老用户付费" groups={categories} selection={selection} points={live?connectedPaymentPoints(live,"stage",measure as "amount"|"users"|"arppu"):points(range,"stage",measure as "amount"|"users"|"arppu",compared)} kind={measure==="arppu"?"line":"bar"} stack={measure==="amount"&&complete} unit={measure==="users"?"人":measure==="arppu"?arppuUnit:amountUnit} format={format} queryKey={JSON.stringify(range)} onOpen={onOpen} exportAction={live?<ConnectedPaymentExport live={live} title="新老用户付费表现" pending={pending}/>:<Export title="新老用户付费表现" sheet={paymentStructureSheets(range,compared)[0]} pending={pending}/>}/>
  </DashboardPanel></DataOriginProvider>;
}
export function IncomeComposition({range,compared,pending,onOpen,incomplete=false,onRetry}:Props) {
  const live=useLiveDashboard();
  const amountUnit=live?connectedPaymentUnit(live):"USD";
  incomplete = !live && incomplete;
  const [dimension,setDimension]=useState("product"),[mode,setMode]=useState("amount"),[cross,setCross]=useState(false),total=paymentAggregate(range),actualMode=incomplete&&dimension==="product"?"amount":mode;
  const categories=groups(dimension as PaymentDimension),selection=useGroupSelection(categories,JSON.stringify([range,dimension])),sheet=paymentStructureSheets(range,compared,incomplete)[1];
  return <DataOriginProvider value={live?null:"demo"}><DashboardPanel title="商品与分端收入" note="同币种、同范围、互斥完整分类才展示构成；商品×端别使用独立交叉记录。" chartKind="income-composition">
    {incomplete&&onRetry&&<div className="payment-order__state" role="status"><b>当前指标加载失败</b><p>VIP充值金额暂不可用，其余收入结果保留。</p><button type="button" onClick={onRetry}>重试收入数据</button></div>}
    <div className="payment-breakdown__compositions">{(["product","client"] as const).map(dimension=>{const connected=live&&dimension==="product";return <DataOriginProvider key={dimension} value={connected?"pending":"demo"}><CompositionChart title={dimension==="product"?"商品收入构成":"分端收入构成"} items={groups(dimension).map(group=>({...group,value:connected?connectedPaymentSnapshot(live,"product",group.id).amount:incomplete&&dimension==="product"&&group.id==="vip"?null:paymentAggregate(range,{[dimension]:group.id}).amount,comparison:connected?live.comparison?connectedPaymentSnapshot(live,"product",group.id,live.comparison.query.dateRange[1],true).amount:undefined:compared?paymentAggregate(previous(range),{[dimension]:group.id}).amount:undefined}))} total={connected?connectedPaymentSnapshot(live).amount:total.amount} totalLabel="总充值金额" scope={connected?live.query.dateRange[1]+" · 单日 · "+amountUnit+" · 待验数":scope(range)} unit={connected?amountUnit:"USD"} complete={connected?groups("product").every(group=>connectedPaymentSnapshot(live,"product",group.id).amount!==null):!(incomplete&&dimension==="product")} onOpen={onOpen}/></DataOriginProvider>;})}</div>
    <div className="payment-breakdown__tools"><h3>每日收入趋势 <DataOriginProvider value={live&&dimension==="product"?"pending":"demo"}><DataOriginBadge/></DataOriginProvider></h3><SegmentedControl label="收入趋势维度" value={dimension} onChange={setDimension} options={[{value:"product",label:"按商品"},{value:"client",label:"按客户端"}]}/>{!(incomplete&&dimension==="product")&&<SegmentedControl label="收入趋势数值" value={actualMode} onChange={setMode} options={[{value:"amount",label:"金额"},{value:"share",label:"占比"}]}/>}</div>
    <DataOriginProvider value={live&&dimension==="product"?"pending":"demo"}><GroupedTrend title="每日收入" groups={categories} selection={selection} points={live&&dimension==="product"?connectedPaymentPoints(live,"product",actualMode as "amount"|"share"):points(range,dimension as PaymentDimension,actualMode as "amount"|"share",compared,incomplete)} kind="bar" stack={!(incomplete&&dimension==="product")} unit={actualMode==="share"?"%":live&&dimension==="product"?connectedPaymentUnit(live):"USD"} format={value=>actualMode==="share"?(value===null?"未产出":`${(value*100).toFixed(2)}%`):live&&dimension==="product"?(value===null?"—":value.toLocaleString()+" "+connectedPaymentUnit(live)):money(value)} queryKey={JSON.stringify([range,dimension])} onOpen={onOpen} exportAction={live&&dimension==="product"?<ConnectedPaymentExport live={live} title="商品与分端收入" pending={pending}/>:<Export title="商品与分端收入" sheet={sheet} pending={pending}/>} /></DataOriginProvider>
    <div className="payment-breakdown__tools"><button type="button" aria-expanded={cross} onClick={()=>setCross(!cross)}>{cross?"收起":"查看"}商品 × 客户端明细</button><DataOriginProvider value="demo"><DataOriginBadge/></DataOriginProvider></div>
    {cross&&<DataOriginProvider value="demo"><div className="payment-breakdown__summary"><PaginatedTable label="商品与客户端交叉明细" columnCount={4} head={<tr><th>商品</th>{groups("client").map(group=><th key={group.id}>{group.label}（USD）</th>)}</tr>} rows={groups("product").map(product=><tr key={product.id}><td>{product.label}</td>{groups("client").map(client=><td key={client.id}>{incomplete&&product.id==="vip"?"未产出":paymentAggregate(range,{product:product.id,client:client.id}).amount.toLocaleString("zh-CN",{minimumFractionDigits:2,maximumFractionDigits:2})}</td>)}</tr>)}/></div></DataOriginProvider>}
  </DashboardPanel></DataOriginProvider>;
}
