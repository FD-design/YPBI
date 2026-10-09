import { useState, type ReactNode } from "react";
import { DashboardPanel } from "../features/dashboards/DashboardPresentation";
import { CompositionChart } from "../features/dashboards/CompositionChart";
import { GroupedTrend, useGroupSelection, type GroupedTrendPoint } from "../features/dashboards/GroupedTrend";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { Button } from "../../components/ui/Button";
import { PreviewExportControl } from "../features/dashboards/PreviewExportControl";
import type { CalculationBasis } from "../features/dashboards/CalculationEvidence";
import { acquisitionCards,acquisitionDailyCards,acquisitionRows,acquisitionMetric,acquisitionBaseline,sourceDaily,downloadTargetDaily,type AcquisitionFilters } from "./acquisition-preview-model";
import { exportAcquisition, exportAcquisitionTrend } from "./acquisition-export";
import { CHART_PALETTE } from "../../theme/tokens";
import "./acquisition-visuals.css";
import "./payment-breakdowns.css";
import { useLiveDashboard, liveDailyReferenceRows, liveMetricModel, livePeriodStatus } from "../features/dashboards/LiveDashboardContext";
import { DataOriginProvider } from "../components/DataOrigin";
import { ConnectedStructureContent } from "./ConnectedStructure";
import { CompactMetricReading } from "../features/dashboards/CompactMetricReading";
import { LiveSeriesExport } from "../features/dashboards/ConnectedMetricCard";
import type { DashboardMetricCardModel } from "../features/dashboards/dashboard-metric-card-model";
import { acquisitionDownloadPoints, acquisitionDownloadWorkbook, DOWNLOAD_TARGET_UNAVAILABLE } from "./acquisition-download-source";
import { downloadPreviewWorkbook } from "./preview-workbook";

type Props={filters:AcquisitionFilters;mixed:boolean;pending:boolean;onOpen:(title:string,content:ReactNode)=>void;onLocate:(dimension:"target"|"channel"|"type")=>void};
function downloadBasis(date:string,label:string,value:number,total:number):CalculationBasis {
  const name=label==="总体"?"下载点击总次数":label+"下载点击次数";
  return {formula:name+" ÷ 下载点击总次数 × 100%",scope:date+" · 合成演示数据",numerator:{name,value,unit:"次"},denominator:{name:"下载点击总次数",value:total,unit:"次"},result:total?`${(value/total*100).toFixed(2)}%`:"分母为0",percentage:true};
}
function demoDownloadSource(filters:AcquisitionFilters,mixed:boolean,mode:string) {
  const compared=filters.comparison!=="none",download=acquisitionCards(compared,mixed,[],filters).find(item=>item.model.metric.id==="M003")!.model.result,available=download.status==="available";
  const daily=downloadTargetDaily(filters),previous=downloadTargetDaily(acquisitionBaseline(filters)),rows=acquisitionRows("target",filters),groups=rows.map((row,i)=>({id:row.name,label:row.name,color:CHART_PALETTE[i]}));
  const points:GroupedTrendPoint[]=daily.map((point,index)=>{
    const total=Object.values(point.values).reduce((a,b)=>a+b,0),before=previous[index],prior=Object.values(before.values).reduce((a,b)=>a+b,0);
    return {date:point.date,overall:!available?null:mode==="share"?(total?1:null):total,overallBasis:mode==="share"&&available?downloadBasis(point.date,"总体",total,total):undefined,
      shares:mode==="count"&&available?Object.fromEntries(groups.map(group=>[group.id,total?point.values[group.id]/total:null])):undefined,
      values:Object.fromEntries(groups.map(group=>[group.id,!available?null:mode==="share"?total?point.values[group.id]/total:null:point.values[group.id]])),
      comparison:compared?{date:before.date,overallBasis:mode==="share"?downloadBasis(before.date,"总体",prior,prior):undefined,
        basis:mode==="share"?Object.fromEntries(groups.map(group=>[group.id,downloadBasis(before.date,group.label,before.values[group.id],prior)])):undefined,
        overall:mode==="share"?(prior?1:null):prior,values:Object.fromEntries(groups.map(group=>[group.id,mode==="share"?prior?before.values[group.id]/prior:null:before.values[group.id]]))}:undefined,
      basis:mode==="share"&&available?Object.fromEntries(groups.map(group=>[group.id,downloadBasis(point.date,group.label,point.values[group.id],total)])):undefined};
  });
  return {groups,points,available,total:download.status==="available"?download.value.raw:null,items:groups.map(group=>({...group,value:available?rows.find(row=>row.name===group.id)!.values.M003:null}))};
}
function demoAcquisitionExport(filters:AcquisitionFilters,mixed:boolean,pending:boolean) {
  return <PreviewExportControl name="获客完整结果" scope="全部日期、下载目标与渠道，保留计算依据及状态" context="合成演示数据" pending={pending} onDownloadPreview={()=>exportAcquisition(filters,mixed,[])}/>;
}
export function AcquisitionVisuals({filters,mixed,pending,onOpen,onLocate}:Props) {
  const live=useLiveDashboard();
  const [downloadMode,setDownloadMode]=useState("count"),compared=filters.comparison!=="none";
  const [downloadView,setDownloadView]=useState<"overall"|"groups">(live?"overall":"groups");
  const landingModels=acquisitionDailyCards(compared,mixed,[],filters).map(item=>item.model);
  const getLanding=(metric:string)=>{const model=landingModels.find(item=>item.metric.id===metric)!;return live?liveMetricModel(model,live):model;};
  const download=live?{groups:[],items:[],total:null,available:false,points:acquisitionDownloadPoints(live,downloadMode)}:demoDownloadSource(filters,mixed,downloadMode);
  const {groups,available}=download,queryKey=JSON.stringify(live?live.query:filters),selection=useGroupSelection(groups,queryKey);
  const downloadScope=live?`${live.platformName} · ${live.query.dateRange.join(" 至 ")} · 下载目标维度待接入`:`${filters.start} 至 ${filters.end} · 合成演示数据`;
  const exportAction=live?<PreviewExportControl name="下载表现" scope="总体下载点击次数的完整逐日结果、实际输入及两期状态；下载目标分组与占比待接入。" context={`${live.platformName} · ${live.query.dateRange.join(" 至 ")} · 待验数`} dataOrigin="live" pending={pending||live.controls.dirty||!live.canExport||live.state.status!=="success"} onDownloadPreview={()=>{
    if(pending||live.controls.dirty||!live.canExport||live.state.status!=="success")return;
    downloadPreviewWorkbook("下载表现",acquisitionDownloadWorkbook(live),"pending");
  }}/>:demoAcquisitionExport(filters,mixed,pending);
  const metricExport=(model:DashboardMetricCardModel)=>{
    if(!live)return <PreviewExportControl name={`${model.metric.name}同口径数据表`} scope="当前指标全部逐日结果、实际比较日期、计算输入与状态" context={`${filters.start} 至 ${filters.end} · 大盘整体 · 合成演示数据`} pending={pending} onDownloadPreview={()=>exportAcquisitionTrend(model,filters)}/>;
    const result=live.state.status==="success"?live.state.data:null,series=result?.data.series.find(item=>item.metric.id===model.metric.id),previousResult=live.comparison?.state.status==="success"?live.comparison.state.data:null;
    return series&&result&&live.canExport&&!live.controls.dirty?<LiveSeriesExport series={series} result={result} comparison={previousResult} comparisonStatus={livePeriodStatus(live,true)} dayReferences={liveDailyReferenceRows(live,[model.metric.id])} stale={Boolean((live.state.status==="success"&&live.state.refreshError)||(live.comparison?.state.status==="success"&&live.comparison.state.refreshError))}/>:<Button disabled>导出未就绪</Button>;
  };
  return <>
    <DataOriginProvider value={live?"pending":"demo"}><DashboardPanel title="下载表现" guidanceKey="acquisition.download" note="下载目标与注册客户端分别统计；默认次数口径，不表示安装完成。" chartKind="download-composition">
      <DataOriginProvider value={live?null:"demo"}><CompositionChart title="下载目标构成" items={download.items} total={download.total} totalLabel="下载点击总量" scope={downloadScope} unit="次" valueLabel="次数" complete={available} onOpen={onOpen} selected={selection.selected}/></DataOriginProvider>
      {live&&<p className="dashboard-table-context" role="status">{DOWNLOAD_TARGET_UNAVAILABLE}</p>}
      <div className="payment-breakdown__tools"><h3>每日下载点击</h3>{(live||available)&&<SegmentedControl label="下载趋势数值" value={downloadMode} onChange={setDownloadMode} options={[{value:"count",label:"次数"},{value:"share",label:"占比"}]}/>}<button type="button" onClick={()=>onLocate("target")}>查看下载明细</button></div>
      <GroupedTrend title="分目标下载" groups={groups} selection={selection} points={download.points} mode={downloadView} onModeChange={setDownloadView} kind="bar" stack={available} unit={downloadMode==="share"?"%":"次"} format={value=>value===null?(live?downloadMode==="share"?"占比待接入":"未返回":"未产出"):downloadMode==="share"?`${(value*100).toFixed(2)}%`:`${value.toLocaleString()} 次`} queryKey={queryKey} onOpen={onOpen} exportAction={exportAction}/>
    </DashboardPanel></DataOriginProvider>
    <DataOriginProvider value={live?"pending":"demo"}><DashboardPanel title="落地页转化诊断" guidanceKey="acquisition.landing" note="访问、下载点击与注册分别统计，不是同用户有序漏斗；日末值、变化与完整趋势均可就地核对。" chartKind="landing-stage-comparison">
      <div className="acquisition-visuals__stages">{["M001","M003","M008"].map(metric=>{const model=getLanding(metric);return <CompactMetricReading key={metric} model={model} tone="stage" onOpen={onOpen} exportAction={metricExport(model)} note={metric==="M008"?"注册业务日 · 去重用户":"行为发生日 · 事件次数"}/>;})}</div>
      <div className="acquisition-visuals__relations">{["M005","M006","M007"].map(metric=>{const model=getLanding(metric);return <CompactMetricReading key={metric} model={model} tone="relation" showCalculation onOpen={onOpen} exportAction={metricExport(model)} note={metric==="M005"?"同日次数关系": "IP·天分母 · 趋势参考"}/>;})}</div>
      <div className="payment-breakdown__tools"><button type="button" onClick={()=>onLocate("channel")}>查看渠道明细</button><span>用户转化漏斗待支持：需统一身份、跨端关联、有序事实与正式归因窗口。</span></div>
    </DashboardPanel></DataOriginProvider>
    <AcquisitionSources filters={filters} mixed={mixed} pending={pending} onOpen={onOpen} onLocate={onLocate}/>
  </>;
}
function AcquisitionSources({filters,mixed,pending,onOpen,onLocate}:Props) {
  const live=useLiveDashboard();
  const supportsTypes=live?.state.status==="success"&&["M008.nature","M008.internal"].every(id=>live.state.status==="success"&&live.state.data.data.series.some(series=>series.metric.id===id));
  const before=sourceDaily(acquisitionBaseline(filters));
  const rows=acquisitionRows("type",filters),groups=rows.map((row,i)=>({id:row.name,label:row.name,color:CHART_PALETTE[i]}));
  return <DataOriginProvider value={live?"pending":"demo"}><DashboardPanel title="新增来源比较" guidanceKey="acquisition.sources" tools={supportsTypes&&<Button size="sm" onClick={()=>onLocate("type")}>查看来源明细</Button>} note="当前已登记视图：自然新增、内部导量。买量/自然/裂变的归因与互斥完备关系待确认，不先画100%构成。" chartKind="acquisition-source-comparison">{live?<ConnectedStructureContent live={live} title="新增来源" id="M008" dimension="acquisition" open={onOpen}/>:<GroupedTrend title="新增来源" groups={groups} points={sourceDaily(filters).map((point,index)=>({...point,comparison:filters.comparison!=="none"?before[index]:undefined}))} kind="bar" unit="人" format={value=>value===null?"未产出":value.toLocaleString()+" 人"} queryKey={JSON.stringify(filters)} onOpen={onOpen} exportAction={demoAcquisitionExport(filters,mixed,pending)} summary={selected=><div className="topic-preview__group-summary">{rows.filter(row=>selected.includes(row.name)).map(row=><section key={row.name}><span>{row.name}</span><strong>{row.values.M008?.toLocaleString()} 人</strong></section>)}</div>}/>}</DashboardPanel></DataOriginProvider>;
}
