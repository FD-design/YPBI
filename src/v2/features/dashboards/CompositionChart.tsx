import { useState, type ReactNode } from "react";
import { Chart } from "../../../components/Chart";
import { CalculationEvidence } from "./CalculationEvidence";
import { compositionStatus } from "./composition-model";
import "./composition-chart.css";
import { DataOriginBadge } from "../../components/DataOrigin";
export interface CompositionItem {id:string;label:string;color:string;value:number|null;comparison?:number|null}
export function CompositionChart({title,items,total,totalLabel,scope,unit,complete,onOpen,selected,valueLabel="金额"}: {
  title:string;items:CompositionItem[];total:number|null;totalLabel:string;scope:string;unit:string;complete:boolean;onOpen:(title:string,content:ReactNode)=>void;selected?:string[];valueLabel?:string;
}) {
  const [focus,setFocus]=useState<string|null>(null),reason=compositionStatus(items.map(item=>item.value),total,complete);
  const money=(value:number|null)=>value===null?"未产出":`${value.toLocaleString("zh-CN",{minimumFractionDigits:valueLabel==="金额"?2:0,maximumFractionDigits:valueLabel==="金额"?2:0})} ${unit}`;
  const share=(value:number|null)=>reason||value===null||!total?"—":value>0&&value/total<.0001?"<0.01%":`${(value/total*100).toFixed(2)}%`;
  const open=(item:CompositionItem)=>onOpen(`${title} · ${item.label}`,<><p>{money(item.value)} · {scope}</p>{reason?<p>{reason}，不绘制完整构成。</p>:<CalculationEvidence basis={{formula:`${item.label}${valueLabel} ÷ ${totalLabel} × 100%`,scope,numerator:{name:item.label+valueLabel,value:item.value,unit},denominator:{name:totalLabel,value:total,unit},result:share(item.value),percentage:true}}/>}</>);
  return <section className="composition-chart" aria-label={title}>
    <h3>{title}<DataOriginBadge/></h3><p className="composition-chart__scope">{scope}</p>
    <div className="composition-chart__body"><div className="composition-chart__plot">
      <Chart theme="v13" ariaLabel={title+(reason?valueLabel+"比较":"构成环图")} style={{height:270}} onHover={params=>setFocus(params?items[(params as {dataIndex:number}).dataIndex]?.id??null:null)} onClick={params=>{const item=items[(params as {dataIndex:number}).dataIndex];if(item)open(item);}} option={{tooltip:{trigger:"item",formatter:(params:{dataIndex:number})=>{const item=items[params.dataIndex];return item?`${item.label}<br/>${valueLabel} ${money(item.value)}<br/>占比 ${share(item.value)}`:"";}},...(reason?{grid:{left:76,right:20,top:20,bottom:36},xAxis:{type:"value"},yAxis:{type:"category",data:items.map(item=>item.label)},series:[{type:"bar",data:items.map(item=>({value:item.value,itemStyle:{color:item.color}})),barMaxWidth:30}]}:{series:[{type:"pie",radius:["55%","78%"],center:["50%","50%"],avoidLabelOverlap:true,minAngle:0,label:{show:false},emphasis:{scale:true},data:items.map(item=>({name:item.label,value:item.value,itemStyle:{color:item.color,opacity:focus?focus===item.id?1:.3:selected&&!selected.includes(item.id)?.3:1}}))}]})}}/>
      {!reason&&<div className="composition-chart__center"><strong title={money(total)}>{total?.toLocaleString("zh-CN",{maximumFractionDigits:2})}</strong><span>{unit} · {totalLabel}</span></div>}
    </div><div className="composition-chart__details" role="list">{items.map(item=><button key={item.id} type="button" role="listitem" className={focus===item.id?"is-highlighted":""} onMouseEnter={()=>setFocus(item.id)} onMouseLeave={()=>setFocus(null)} onFocus={()=>setFocus(item.id)} onBlur={()=>setFocus(null)} onClick={()=>open(item)}><span><i style={{background:item.color}}/>{item.label}</span><b>{money(item.value)}</b><small>占比 {share(item.value)}</small>{item.comparison!==undefined&&<small>对比期 {money(item.comparison??null)}</small>}</button>)}</div></div>
    {reason&&<p className="composition-chart__state" role="status">{reason}；保留精确{valueLabel}，不补“其他”凑总数。</p>}
  </section>;
}
