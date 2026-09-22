import type { LiveDashboardReading } from "../features/dashboards/LiveDashboardContext";
import { liveCalculation, liveExportMetadata, liveMetricUnit, livePeriodStatus, liveStateLabel } from "../features/dashboards/LiveDashboardContext";
import type { GroupedTrendPoint } from "../features/dashboards/GroupedTrend";
import { PreviewExportControl } from "../features/dashboards/PreviewExportControl";
import { paymentGroups, type PaymentDimension } from "./payment-observations";
import { downloadPreviewWorkbook } from "./preview-workbook";

const ids = (dimension?:PaymentDimension, group?:string) => dimension==="product" ? {amount:group==="vip"?"M065":"M066",users:"",arppu:""} : dimension==="stage" ? {amount:"M058."+group,users:"M059."+group,arppu:"M067."+group} : {amount:"M058",users:"M059",arppu:"M067"};
export const connectedPaymentUnit = (live: LiveDashboardReading, measure: "amount" | "users" | "arppu" = "amount") => liveMetricUnit(live, ids()[measure]) ?? "";
export function connectedPaymentSnapshot(live:LiveDashboardReading, dimension?:PaymentDimension, group?:string, date=live.query.dateRange[1], before=false) {
  const source=before?live.comparison?.state:live.state, result=source?.status==="success"&&source.data?.data.query.pid===live.query.pid?source.data:null, mapping=ids(dimension,group);
  const read=(id:string)=>result?.data.series.find(series=>series.metric.id===id)?.points.find(point=>point.date===date)?.value??null;
  return {amount:read(mapping.amount),users:read(mapping.users),arppu:read(mapping.arppu)};
}
export function connectedPaymentPoints(live:LiveDashboardReading, dimension:PaymentDimension, measure:"amount"|"users"|"arppu"|"share"):GroupedTrendPoint[] {
  const data=live.state.status==="success"?live.state.data:null, baseline=live.comparison?.state.status==="success"?live.comparison.state.data:null;
  const groups=paymentGroups[dimension];
  const snapshot=(date:string,before=false)=>{
    const source=before?baseline:data,total=connectedPaymentSnapshot(live,undefined,undefined,date,before),rows=groups.map(group=>connectedPaymentSnapshot(live,dimension,group.id,date,before));
    const complete=total.amount!==null&&total.amount>0&&rows.every(row=>row.amount!==null)&&Math.abs(rows.reduce((sum,row)=>sum+row.amount!,0)-total.amount)<.01;
    const overallSeries=source?.data.series.find(series=>series.metric.id===(measure==="arppu"?"M067":"M058")),overallPoint=overallSeries?.points.find(point=>point.date===date);
    const amountUnit=source?.data.series.find(series=>series.metric.id==="M058")?.metric.unit??"";
    return {overall:measure==="share"?complete?1:null:total[measure],
      overallBasis:measure==="arppu"&&overallSeries&&overallPoint?liveCalculation(overallSeries,overallPoint):measure==="share"?{numerator:{name:"总充值金额",value:total.amount,unit:amountUnit},denominator:{name:"总充值金额",value:total.amount,unit:amountUnit},formula:"总充值金额 ÷ 总充值金额 × 100%",scope:date+" · 待验数",result:complete?"100.00%":"—",percentage:true}:undefined,
      shares:measure==="amount"&&complete?Object.fromEntries(groups.map((group,i)=>[group.id,rows[i].amount!/total.amount!])):undefined,
      values:Object.fromEntries(groups.map((group,i)=>[group.id,measure==="share"?complete?rows[i].amount!/total.amount!:null:rows[i][measure]])),
      states:Object.fromEntries(groups.map(group=>{const id=ids(dimension,group.id)[measure==="share"?"amount":measure],point=source?.data.series.find(s=>s.metric.id===id)?.points.find(p=>p.date===date);return[group.id,!live.metricIds.includes(id)?"切片待接入":point?liveStateLabel[point.state]:"读取中"];})),
      basis:measure==="arppu"?Object.fromEntries(groups.flatMap(group=>{const series=source?.data.series.find(s=>s.metric.id===ids(dimension,group.id).arppu),point=series?.points.find(p=>p.date===date),basis=series&&point?liveCalculation(series,point):undefined;return basis?[[group.id,basis]]:[];})):measure==="share"?Object.fromEntries(groups.map((group,i)=>[group.id,{numerator:{name:group.label+"充值金额",value:rows[i].amount,unit:amountUnit},denominator:{name:"总充值金额",value:total.amount,unit:amountUnit},formula:"分类充值金额 ÷ 总充值金额 × 100%",scope:date+" · 待验数",result:complete?(rows[i].amount!/total.amount!*100).toFixed(2)+"%":"—",percentage:true}])):undefined};
  };
  return (data?.data.series[0].points??[]).map((point,i)=>{const before=baseline?.data.series[0].points[i]?.date;return{date:point.date,...snapshot(point.date),comparison:before?{date:before,...snapshot(before,true)}:undefined};});
}
export function ConnectedPaymentExport({live,title,pending=false}:{live:LiveDashboardReading;title:string;pending?:boolean}) {
  return <PreviewExportControl name={title} dataOrigin="live" scope="真实分组逐日金额、人数、ARPPU及计算输入；未接入字段不补值" context={connectedPaymentUnit(live)+" · 待验数"} pending={pending||!live.canExport||live.controls.dirty||live.state.status!=="success"} onDownloadPreview={()=>{
    if(pending||!live.canExport||live.controls.dirty||live.state.status!=="success")return;
    const periods=[{name:"当前",result:live.state.data},...(live.comparison?.state.status==="success"&&live.comparison.state.data?[{name:"对比",result:live.comparison.state.data}]:[])];
    downloadPreviewWorkbook(title,[{name:"数据说明",rows:liveExportMetadata(live)},{name:"真实明细",rows:[["周期","日期","指标","值","单位","计算输入","状态","平台","查询时间","刷新状态"],...periods.flatMap(period=>period.result.data.series.filter(series=>["M058","M059","M067","M065","M066"].some(id=>series.metric.id===id||series.metric.id.startsWith(id+"."))).flatMap(series=>series.points.map(point=>[period.name,point.date,series.metric.name,point.value,series.metric.unit,series.metric.inputs.map((input,i)=>input.name+": "+(point.inputs[i].value??"—")+" "+input.unit).join(" / "),liveStateLabel[point.state]+" · 待验数",period.result.data.query.pid,period.result.data.fetchedAt,livePeriodStatus(live,period.name==="对比")])))]}], "pending");
  }}/>;
}
