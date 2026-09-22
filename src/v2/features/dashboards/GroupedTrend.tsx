import { useState, type ReactElement, type ReactNode } from "react";
import type { AnalysisDisplayMode } from "./AnalysisScopeControls";
import { Chart } from "../../../components/Chart";
import { groupedTrendTooltip } from "../../../components/chart-tooltip-content";
import { PaginatedLegend } from "../../../components/ui/PaginatedLegend";
import { PaginatedTable } from "../../../components/ui/PaginatedTable";
import { ChartDataTable } from "../../../components/ui/ChartDataTable";
import { SegmentedControl } from "../../../components/ui/SegmentedControl";
import { TrendRange, useTrendRange } from "../../../components/ui/TrendRange";
import { CalculationEvidence, CalculationColumnHeaders, CalculationColumns, type CalculationBasis } from "./CalculationEvidence";
import { calculationTableColumns, missingCalculationValues } from "./calculation-table-model";
import "./grouped-trend.css";

export interface TrendGroup { id:string; label:string; color:string }
export interface GroupedTrendPoint {
  date:string; values:Record<string,number|null>; states?:Record<string,string>;
  basis?:Record<string,CalculationBasis>;
  overall?:number|null; overallBasis?:CalculationBasis; shares?:Record<string,number|null>;
  comparison?:{date:string;values:Record<string,number|null>;overall?:number|null;basis?:Record<string,CalculationBasis>;overallBasis?:CalculationBasis};
}
export function useGroupSelection(groups:TrendGroup[], queryKey:string) {
  const key=queryKey+groups.map(group=>group.id).join("|"),all=groups.map(group=>group.id);
  const [state,setState]=useState({key,selected:all});
  const selected=state.key===key?state.selected:all;
  if(state.key!==key) setState({key,selected:all});
  const setSelected=(values:string[])=>{const next=all.filter(id=>values.includes(id));if(next.length)setState({key,selected:next});};
  return {selected,setSelected};
}

/** Render totals and shares supplied by the snapshot; never sum distinct users or ratios. */
export function GroupedTrend({title,groups,points,kind,stack=false,unit,format,queryKey,exportAction,onOpen,selection,summary,mode:controlledMode,onModeChange,showControls=true,showLegend=showControls,showDataTable=true}: {
  title:string;groups:TrendGroup[];points:GroupedTrendPoint[];kind:"line"|"bar";stack?:boolean;unit:string;format:(value:number|null)=>string;queryKey:string;exportAction:ReactElement;
  onOpen:(title:string,content:ReactNode)=>void;selection?:{selected:string[];setSelected:(values:string[])=>void};summary?:(selected:string[])=>ReactNode;
  mode?:AnalysisDisplayMode;onModeChange?:(mode:AnalysisDisplayMode)=>void;showControls?:boolean;showLegend?:boolean;showDataTable?:boolean;
}) {
  const own=useGroupSelection(groups,queryKey),{selected,setSelected}=selection??own;
  const [internalMode,setInternalMode]=useState<AnalysisDisplayMode>("groups");
  const view=controlledMode??internalMode;
  const setView=(value:string)=>{const next=value as AnalysisDisplayMode;onModeChange?.(next);if(controlledMode===undefined)setInternalMode(next);};
  const hasOverall=points.some(point=>Object.hasOwn(point,"overall"));
  const overall=view==="overall"&&hasOverall;
  const totalGroup={id:"__overall",label:"总体",color:groups[0]?.color??"#2563eb"};
  const shown=overall?[totalGroup]:groups.filter(group=>selected.includes(group.id));
  const value=(point:GroupedTrendPoint,id:string)=>id==="__overall"?point.overall??null:point.values[id]??null;
  const basis=(point:GroupedTrendPoint,id:string)=>id==="__overall"?point.overallBasis:point.basis?.[id];
  const previous=(point:GroupedTrendPoint,id:string)=>id==="__overall"?point.comparison?.overall??null:point.comparison?.values[id]??null;
  const previousBasis=(point:GroupedTrendPoint,id:string)=>id==="__overall"?point.comparison?.overallBasis:point.comparison?.basis?.[id];
  const dates=points.map(point=>point.date),range=useTrendRange(dates),visible=points.slice(range.start,range.end+1);
  const [allTable,setAllTable]=useState(false),[search,setSearch]=useState("");
  const share=(point:GroupedTrendPoint,id:string)=>point.shares?.[id]==null?"":` · 占总体 ${(point.shares[id]!*100).toFixed(2)}%`;
  const openPoint=(point:GroupedTrendPoint,detailGroups=shown)=>onOpen(`${title} · ${point.date}`,<>{hasOverall&&<p>总体：{format(point.overall??null)}</p>}{detailGroups.map(group=><section key={group.id}><h3>{group.label}</h3><p>{format(value(point,group.id))}{share(point,group.id)} · {point.states?.[group.id]??(value(point,group.id)==null?"未产出":"完整")}</p>{basis(point,group.id)&&<CalculationEvidence basis={basis(point,group.id)!} />}{point.comparison&&<><p>对比 {point.comparison.date} · {format(previous(point,group.id))}</p>{previousBasis(point,group.id)&&<CalculationEvidence basis={previousBasis(point,group.id)}/>}</>}</section>)}</>);
  const tooltip=(point:GroupedTrendPoint)=>groupedTrendTooltip({
    date:point.date,
    overall:hasOverall?{value:format(point.overall??null)}:undefined,
    groups:overall?[]:shown.map(group=>({label:group.label,value:format(value(point,group.id)),color:group.color,share:point.shares?.[group.id],state:point.states?.[group.id]})),
    comparison:point.comparison?{
      date:point.comparison.date,
      overall:hasOverall?{value:format(point.comparison.overall??null)}:undefined,
      groups:overall?[]:shown.map(group=>({label:group.label,value:format(previous(point,group.id)),color:group.color}))
    }:undefined
  });
  const tableGroups=allTable?[...(hasOverall?[totalGroup]:[]),...groups]:shown;
  const hasComparison=points.some(point=>point.comparison);
  const calculated=points.some(point=>Object.keys(point.basis??{}).length>0||point.overallBasis||Object.keys(point.comparison?.basis??{}).length>0||point.comparison?.overallBasis);
  const tableInputs=points.flatMap(point=>tableGroups.map(group=>({point,group,current:basis(point,group.id),comparison:previousBasis(point,group.id)})));
  const groupFallbacks=new Map(tableGroups.map(group=>[group.id,missingCalculationValues(points.flatMap(point=>[basis(point,group.id),previousBasis(point,group.id)]).find(Boolean))]));
  const currentColumns=calculationTableColumns(tableInputs.map(row=>row.current??groupFallbacks.get(row.group.id)));
  const comparisonColumns=calculationTableColumns(tableInputs.map(row=>row.comparison??groupFallbacks.get(row.group.id)),"对比");
  const hasShares=points.some(point=>point.shares);
  return <div className="grouped-trend">
    {showControls&&<div className="grouped-trend__controls">
      {hasOverall&&<SegmentedControl label={`${title}展示范围`} value={overall?"overall":"groups"} onChange={setView} options={[{value:"overall",label:"总体"},{value:"groups",label:"分组对比"}]}/>}
      {!overall&&groups.length>1&&<><span>显示 {shown.length}/{groups.length} 组</span><button type="button" disabled={shown.length===groups.length} onClick={()=>setSelected(groups.map(group=>group.id))}>恢复全部</button><span className="grouped-trend__hint">点击图例单独查看；占比保持原总体基数</span></>}
    </div>}
    {showLegend&&!overall&&groups.length>6&&<label className="grouped-trend__search">查找分组<input aria-label={`${title}查找分组`} value={search} onChange={event=>setSearch(event.target.value.slice(0,100))}/></label>}
    {showLegend&&!overall&&groups.length>1&&<PaginatedLegend label={`${title}分组`} items={groups.filter(group=>group.label.toLowerCase().includes(search.toLowerCase())).map(group=>({...group,selected:selected.includes(group.id)}))} onToggle={id=>setSelected(selected.includes(id)?selected.filter(value=>value!==id):[...selected,id])} />}
    {!overall&&summary?.(selected)}
    <Chart theme="v13" ariaLabel={`${title}日趋势`} style={{height:280}} onClick={params=>{const point=visible[(params as {dataIndex:number}).dataIndex];if(point)openPoint(point);}} option={{grid:{left:58,right:20,top:24,bottom:36},tooltip:{trigger:"axis",formatter:(params:{dataIndex:number}[])=>params[0]&&visible[params[0].dataIndex]?tooltip(visible[params[0].dataIndex]):""},xAxis:{type:"category",data:visible.map(point=>point.date),axisLabel:{formatter:(date:string)=>date.slice(5),hideOverlap:true}},yAxis:{type:"value",name:unit,min:0,axisLabel:{formatter:(value:number)=>unit==="%"?`${(value*100).toFixed(0)}%`:value.toLocaleString("zh-CN",{notation:"compact",maximumFractionDigits:1})}},series:shown.flatMap(group=>[{name:group.label,type:kind,data:visible.map(point=>value(point,group.id)),stack:stack&&!overall?"groups":undefined,connectNulls:false,showSymbol:visible.length<=7,symbolSize:7,barMaxWidth:36,itemStyle:{color:group.color},lineStyle:{color:group.color}},...(hasComparison?[{name:`${group.label}（对比）`,type:"line",data:visible.map(point=>previous(point,group.id)),connectNulls:false,showSymbol:false,lineStyle:{color:group.color,type:"dashed",width:1.5},itemStyle:{color:group.color}}]:[])])}} />
    <TrendRange dates={dates} values={points.map(point=>value(point,shown[0]?.id))} {...range} onChange={range.setRange}/>
    {showDataTable&&<ChartDataTable title={`${title}同口径数据表`} exportAction={exportAction}>
      <div className="grouped-trend__controls"><span>{allTable?"全部分组与总体":`已显示：${shown.map(group=>group.label).join("、")}`}</span><button type="button" onClick={()=>setAllTable(!allTable)}>{allTable?"仅查看已显示分组":"查看全部分组"}</button></div>
      {calculated?<PaginatedTable label={`${title}逐日明细`} resetKey={queryKey+tableGroups.map(g=>g.id).join()} columnCount={5+currentColumns.length+(hasComparison?2+comparisonColumns.length:0)} head={<tr><th>日期</th><th>分组</th><CalculationColumnHeaders columns={currentColumns}/><th>公式</th><th>结果</th>{hasComparison&&<><th>对比日期</th><CalculationColumnHeaders columns={comparisonColumns}/><th>对比结果</th></>}<th>状态</th></tr>} rows={tableInputs.map(({point,group,current,comparison})=><tr key={point.date+group.id}><td>{point.date}</td><td>{group.label}</td><CalculationColumns basis={current} fallback={groupFallbacks.get(group.id)} columns={currentColumns}/><td className="calculation-table__name">{current?.formula??"计算依据待接入"}</td><td>{format(value(point,group.id))}</td>{hasComparison&&<><td>{point.comparison?.date??"—"}</td><CalculationColumns basis={comparison} fallback={groupFallbacks.get(group.id)} columns={comparisonColumns}/><td>{format(previous(point,group.id))}</td></>}<td>{point.states?.[group.id]??(current?"完整":"计算输入待接入")}</td></tr>)}/>
      :<PaginatedTable label={`${title}逐日明细`} resetKey={queryKey+tableGroups.map(g=>g.id).join()} columnCount={2+(hasComparison?1:0)+tableGroups.length*((hasComparison?2:1)+(hasShares?1:0))} head={<tr><th>日期</th>{tableGroups.map(group=><th key={group.id}>{group.label}</th>)}{hasShares&&tableGroups.map(group=><th key={group.id}>{group.label}占总体</th>)}{hasComparison&&<><th>对比日期</th>{tableGroups.map(group=><th key={group.id}>{group.label}对比值</th>)}</>}<th>详情</th></tr>} rows={points.map(point=><tr key={point.date}><td>{point.date}</td>{tableGroups.map(group=><td key={group.id}>{format(value(point,group.id))}</td>)}{hasShares&&tableGroups.map(group=><td key={group.id}>{group.id==="__overall"?(point.overall==null||point.overall===0?"—":"100.00%"):point.shares?.[group.id]==null?"—":`${(point.shares[group.id]!*100).toFixed(2)}%`}</td>)}{hasComparison&&<><td>{point.comparison?.date??"—"}</td>{tableGroups.map(group=><td key={group.id}>{format(previous(point,group.id))}</td>)}</>}<td><button type="button" onClick={()=>openPoint(point,tableGroups)}>查看当日详情</button></td></tr>)}/>}
      <p className="dashboard-table-context">缩放不裁剪完整日期。人数总体独立去重；比例、人均值不相加。总体与分组不重复堆叠。</p>
    </ChartDataTable>}
  </div>;
}
