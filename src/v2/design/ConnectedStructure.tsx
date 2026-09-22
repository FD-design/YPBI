import type { ReactNode } from "react";
import { GroupedTrend, type GroupedTrendPoint } from "../features/dashboards/GroupedTrend";
import { DataOriginBadge, DataOriginProvider } from "../components/DataOrigin";
import { liveCalculation, liveExportMetadata, liveStateLabel, liveValue, type LiveDashboardReading } from "../features/dashboards/LiveDashboardContext";
import { PreviewExportControl } from "../features/dashboards/PreviewExportControl";
import { CHART_PALETTE } from "../../theme/tokens";
import { downloadPreviewWorkbook } from "./preview-workbook";
import { RefreshNotice } from "../components/StatePanel";
import { shiftDate } from "../../components/ui/date-range-model";
export function liveStructureIds(live: LiveDashboardReading | null, id: string, dimension: string) {
  if (!live) return null;
  const groups = dimension === "platform" ? ["android","ios","web"].map((suffix,i) => ({ id:id+"."+suffix, label:["Android","iOS","Web"][i] })) :
    dimension === "users" ? ["new","old"].map((suffix,i) => ({id:id+"."+suffix,label:["新用户","老用户"][i]})) : dimension==="acquisition"?[{id:id+".nature",label:"自然新增"},{id:id+".internal",label:"内部导量"}]:[];
  return groups.some(group => live.metricIds.includes(group.id)) ? groups : null;
}
export function ConnectedStructureContent({ live, title, id, dimension, open }: { live:LiveDashboardReading;title:string;id:string;dimension:string;open:(title:string,content:ReactNode)=>void }) {
  const groups = liveStructureIds(live,id,dimension)!, unit = id === "M081" ? "%" : "人";
  const result = live.state.status === "success" && live.state.data.data.query.pid === live.query.pid ? live.state.data : null, previous = live.comparison?.state.status === "success" ? live.comparison.state.data : null;
  const series = (id:string,before=false) => (before?previous:result)?.data.series.find(s=>s.metric.id===id);
  const dates = Array.from({length:(Date.parse(live.query.dateRange[1])-Date.parse(live.query.dateRange[0]))/86400000+1},(_,i)=>shiftDate(live.query.dateRange[0],i));
  const points:GroupedTrendPoint[] = dates.map((date,index) => {
    const snapshot = (before=false) => ({
      values:Object.fromEntries(groups.map(group=>[group.id,series(group.id,before)?.points[index]?.value??null])),
      states:Object.fromEntries(groups.map(group=>{const point=series(group.id,before)?.points[index],state=before?live.comparison?.state:live.state;return[group.id,!live.metricIds.includes(group.id)?"切片待接入":state?.status==="failure"?"读取失败":point?liveStateLabel[point.state]+(state?.status==="success"&&state.refreshError?" · 上次查询结果":""):"读取中"];})),
      basis:Object.fromEntries(groups.flatMap(group=>{const s=series(group.id,before),p=s?.points[index],basis=s&&p?liveCalculation(s,p):undefined;return basis?[[group.id,basis]]:[];}))
    });
    return {date,...snapshot(),comparison:previous?{date:previous.data.series[0].points[index].date,...snapshot(true)}:undefined};
  });
  const exported = <PreviewExportControl name={title} dataOrigin="live" pending={!live.canExport||live.controls.dirty||!result} context={live.query.dateRange.join(" 至 ")+" · 待验数"} scope="当前分组完整日期，含基数和状态" onDownloadPreview={()=>{
    if(!result||!live.canExport||live.controls.dirty)return;
    downloadPreviewWorkbook(title,[{name:"数据说明",rows:liveExportMetadata(live)},{name:"分组明细",rows:[["周期","日期","分组","值（"+unit+"）","计算输入","状态","平台","查询时间"],...[{name:"当前",result},...(previous?[{name:"对比",result:previous}]:[])].flatMap(period=>groups.flatMap(group=>period.result.data.series.filter(s=>s.metric.id===group.id).flatMap(s=>s.points.map(point=>[period.name,point.date,group.label,point.value===null?null:point.value*(unit==="%"?100:1),s.metric.inputs.map((input,i)=>input.name+": "+(point.inputs[i].value??"—")+" "+input.unit).join(" / "),liveStateLabel[point.state]+" · 待验数"+((period.name==="当前"?live.state:live.comparison?.state)?.status==="success"&&((period.name==="当前"?live.state:live.comparison?.state) as {refreshError?:unknown}).refreshError?" · 上次查询结果":""),live.query.pid,period.result.data.fetchedAt]))))]}], "pending");
  }}/>;
  return <>{live.state.status==="failure"?<RefreshNotice onRetry={live.retry}>真实结构读取失败，请重试。</RefreshNotice>:live.state.status==="success"&&live.state.refreshError?<RefreshNotice onRetry={live.retry}>结构刷新失败，当前保留上次查询结果。</RefreshNotice>:null}<GroupedTrend title={title} groups={groups.map((group,i)=>({...group,color:CHART_PALETTE[i]}))} points={points} kind={unit==="%"?"line":"bar"} unit={unit} format={value=>liveValue(value,unit)+" "+unit} queryKey={JSON.stringify([live.query,id,dimension])} onOpen={open} exportAction={exported}
    summary={selected=><div className="topic-preview__group-summary">{groups.filter(group=>selected.includes(group.id)).map(group=>{
      const s=series(group.id),valid=Boolean(s?.points.length)&&s!.points.every(point=>point.value!==null);
      const denominator=valid&&unit==="%"?s!.points.reduce((sum,point)=>sum+(point.inputs[1]?.value??0),0):0;
      const value=valid?unit==="%"?denominator>0?s!.points.reduce((sum,point)=>sum+(point.inputs[0]?.value??0),0)/denominator:null:s!.points.reduce((sum,point)=>sum+point.value!,0)/(id==="M008"?1:s!.points.length):null;
      return <section key={group.id}><span>{group.label}<DataOriginProvider value={live.metricIds.includes(group.id)?"pending":null}><DataOriginBadge/></DataOriginProvider></span><strong>{liveValue(value,unit)} {unit}</strong><small>{live.metricIds.includes(group.id)?unit==="%"?"所选范围按基数加权":id==="M008"?"所选范围累计":"所选范围日均":"切片待接入"}</small></section>;
    })}</div>}/></>;
}
