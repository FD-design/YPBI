import { useState, type ReactNode } from "react";
import { DashboardPanel } from "../features/dashboards/DashboardPresentation";
import { RetentionMatrix } from "../features/dashboards/RetentionMatrix";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { MetricReadingDialog } from "../features/dashboards/MetricReadingDialog";
import { PreviewExportControl } from "../features/dashboards/PreviewExportControl";
import { PreviewBoardPresentation } from "./PreviewBoardPresentation";
import { DashboardCardModeControl } from "../features/dashboards/DashboardCardMode";
import { PreviewMetricCard } from "./PreviewMetricCard";
import { cohortRows, REGISTER_IDS, RETENTION_WINDOWS, DEFAULT_RANGE, topicMetric, topicCard } from "./topic-preview-fixtures";
import { cohortExport, metricRows } from "./topic-preview-export";
import { downloadPreviewWorkbook } from "./preview-workbook";
import { retentionDayLabel } from "./topic-preview-labels";
import { shiftDate } from "../../components/ui/date-range-model";
import "./operations-chart-examples.css";
import { GroupedTrend } from "../features/dashboards/GroupedTrend";
import { structureDaily, structureRows } from "./topic-preview-fixtures";
import { structureDetailExport } from "./topic-preview-export";
import { DEFAULT_TOPIC_VIEW } from "./topic-preview-view";
import { CHART_PALETTE } from "../../theme/tokens";
import { IncomeComposition, NewOldPayment } from "./PaymentBreakdowns";
import { AdvertisingOverview } from "./AdvertisingOverview";
import { AcquisitionVisuals } from "./AcquisitionVisuals";
import { DEFAULT_ACQUISITION_FILTERS } from "./acquisition-preview-model";
import { PaymentOrderAnalysis } from "./PaymentOrderAnalysis";

export function CommerceChartExamples() {
  const [reading,setReading]=useState<{title:string;content:ReactNode}|null>(null),[mixed,setMixed]=useState("normal"),[audience,setAudience]=useState("all");
  const props={range:DEFAULT_RANGE,compared:false,onOpen:(title:string,content:ReactNode)=>setReading({title,content})};
  return <section className="operations-example" aria-label="经营组合图表示例"><SegmentedControl label="经营组合示例状态" value={mixed} onChange={setMixed} options={[{value:"normal",label:"完整样例"},{value:"partial",label:"部分结果"}]}/><NewOldPayment {...props}/><IncomeComposition {...props} incomplete={mixed==="partial"}/><PaymentOrderAnalysis {...props} mixed={mixed==="partial"}/><AdvertisingOverview {...props} audience={audience} onAudience={setAudience} mixed={mixed==="partial"}/><AcquisitionVisuals filters={DEFAULT_ACQUISITION_FILTERS} mixed={mixed==="partial"} pending={false} onOpen={props.onOpen} onLocate={dimension=>setReading({title:"完整获客明细",content:<p>请在“获客与新增”看板按{dimension==="target"?"下载目标":"来源渠道"}查看完整明细。</p>})}/>{reading&&<MetricReadingDialog {...reading} onClose={()=>setReading(null)}/>}</section>;
}

export function GroupedTrendExample() {
  const [reading,setReading]=useState<{title:string;content:ReactNode}|null>(null);
  const groups=structureRows("users","M016").map((row,i)=>({id:row.label,label:row.label,color:CHART_PALETTE[i]}));
  return <DashboardPanel title="分组比较与局部聚焦" note="新老用户独立日结果 · 合成演示数据" chartKind="grouped-trend"><GroupedTrend title="分组比较" groups={groups} points={structureDaily("users","M016",DEFAULT_RANGE)} kind="bar" unit="人" format={value=>value===null?"未产出":value.toLocaleString()+" 人"} queryKey="gallery" onOpen={(title,content)=>setReading({title,content})} exportAction={<PreviewExportControl name="分组比較" scope="完整日期与所有分组" context="合成演示数据" onDownloadPreview={()=>downloadPreviewWorkbook("分组比较",[{name:"01_分组日结果",rows:structureDetailExport("users","M016",DEFAULT_TOPIC_VIEW)}])} />} />{reading&&<MetricReadingDialog {...reading} onClose={()=>setReading(null)}/>}</DashboardPanel>;
}

export function RetentionChartExample() {
  const [days,setDays]=useState("7"), [mixed,setMixed]=useState("normal"), [reading,setReading]=useState<{title:string;content:ReactNode}|null>(null);
  const range=mixed === "immature" ? {start:DEFAULT_RANGE.end,end:DEFAULT_RANGE.end} : {start:shiftDate(DEFAULT_RANGE.end,1-Number(days)),end:DEFAULT_RANGE.end};
  const rows=cohortRows(range,REGISTER_IDS,mixed!=="normal");
  const data=rows;
  return <DashboardPanel className="operations-example" chartKind="cohort-matrix" title="用户留存矩阵" note="注册批次 · D1 / D3 / D7 / D30 · 合成演示数据" tools={<><SegmentedControl label="矩阵示例范围" value={days} onChange={setDays} options={[{value:"7",label:"7日"},{value:"30",label:"30日"}]} /><SegmentedControl label="矩阵示例状态" value={mixed} onChange={setMixed} options={[{value:"normal",label:"正常"},{value:"mixed",label:"零值与待加工"},{value:"immature",label:"全部未成熟"}]} /></>}>
    <RetentionMatrix title="用户留存矩阵" rows={data} columns={REGISTER_IDS.map(id=>({id,name:topicMetric(id).name,label:retentionDayLabel(RETENTION_WINDOWS[id]),definition:topicMetric(id).definition}))} dateLabel="注册日期" baseLabel="注册用户数" resetKey={`${days}:${mixed}`} onOpen={(title,content)=>setReading({title,content})} tools={<PreviewExportControl name="用户留存矩阵" scope="完整注册批次与所有窗口，保留数值及状态" context="合成演示数据" onDownloadPreview={()=>downloadPreviewWorkbook("用户留存矩阵",[{name:"01_注册留存",rows:cohortExport(data)}])} />} />
    {reading && <MetricReadingDialog {...reading} onClose={()=>setReading(null)} />}
  </DashboardPanel>;
}

export function CardModeExample() {
  const [reading,setReading]=useState<{title:string;content:ReactNode}|null>(null);
  const models=["M016","M081"].map(id=>topicCard(id,DEFAULT_RANGE,false));
  return <PreviewBoardPresentation board="gallery-card-mode"><DashboardPanel title="整板指标卡展示" chartKind="board-card-mode" note="只收起普通卡内趋势，完整结果和专用分析图保留。仅本机记忆。" tools={<DashboardCardModeControl />}><div className="operations-example__cards topic-preview__grid is-two">{models.map(model=><PreviewMetricCard key={model.metric.id} model={model} open={(title,content)=>setReading({title,content})} retry={()=>{}} exportAction={<PreviewExportControl name={model.metric.name} scope="当前示例完整结果" context="合成演示数据" onDownloadPreview={()=>downloadPreviewWorkbook(model.metric.name,[{name:"01_指标结果",rows:metricRows([model])}])} />} />)}</div></DashboardPanel>{reading && <MetricReadingDialog {...reading} onClose={()=>setReading(null)} />}</PreviewBoardPresentation>;
}
