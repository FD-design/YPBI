import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Button } from "../../../components/ui/Button";
import { Maximize2 } from "lucide-react";
import { Chart } from "../../../components/Chart";
import { ChartDataTable } from "../../../components/ui/ChartDataTable";
import { CHART_PALETTE } from "../../../theme/tokens";
import { FloatingHint } from "../../../components/ui/FloatingHint";
import { PaginatedTable } from "../../../components/ui/PaginatedTable";
import { SegmentedControl } from "../../../components/ui/SegmentedControl";
import { CalculationEvidence, type CalculationBasis } from "./CalculationEvidence";
import { retentionMatrixScale } from "./retention-matrix-scale";
import "./retention-matrix.css";

export interface RetentionMatrixRow { date: string; base: number | null; cells: { id: string; count: number | null; rate: number | null; status: string; availableAt: string }[] }
export function RetentionMatrix({ title, rows, columns, dateLabel, baseLabel, onOpen, tools, resetKey, expanded=false, initialView="heatmap", initialMode="rate" }: {
  title: string; rows: RetentionMatrixRow[]; columns: { id: string; name: string; label: string; definition: string }[]; dateLabel: string; baseLabel: string;
  onOpen: (title: string, content: ReactNode) => void; tools?: ReactNode; resetKey: string; expanded?:boolean; initialView?:string; initialMode?:"rate"|"count";
}) {
  const [view,setView]=useState(initialView);
  const [mode, setMode] = useState<"rate" | "count">(initialMode);
  const [focus, setFocus] = useState<{date: string; id: string} | null>(null);
  const scale = useMemo(() => retentionMatrixScale(rows.flatMap(row => row.cells.map(cell => mode === "rate" ? cell.rate : cell.count)), mode), [rows, mode]);
  const format = (value: number) => mode === "rate" ? `${(value * 100).toFixed(2)}%` : value.toLocaleString();
  const chartHeight=expanded?560:380;
  const cellDetail=(row:RetentionMatrixRow,cell:RetentionMatrixRow["cells"][number])=>{
    const column=columns.find(column=>column.id===cell.id)!;
    onOpen(`${row.date} · ${column.name}`,<><CalculationEvidence basis={{formula:column.definition,scope:`${dateLabel} ${row.date} · 观察窗口结束日 ${cell.availableAt}`,numerator:{name:`${column.label}留存人数`,value:cell.count,unit:"人"},denominator:{name:baseLabel,value:row.base,unit:"人"},result:cell.rate===null?cell.status:`${(cell.rate*100).toFixed(2)}%`,percentage:true}}/><p>{cell.status}</p></>);
  };

  return <div className="retention-matrix" style={{"--retention-table-width": `${236 + columns.length * 112}px`} as CSSProperties}>
    <div className="retention-matrix__tools"><div className="retention-matrix__choices"><SegmentedControl label={`${title}显示`} value={mode} options={[{value:"rate",label:"留存率"},{value:"count",label:"留存人数"}]} onChange={value => setMode(value as "rate" | "count")} /><SegmentedControl label={`${title}视图`} value={view} onChange={setView} options={[{value:"heatmap",label:"热力图"},{value:"line",label:"趋势"},{value:"table",label:"表格"}]}/></div><div className="retention-matrix__actions">{!expanded&&<Button size="sm" icon={Maximize2} onClick={()=>onOpen(title+" · 放大查看",<RetentionMatrix title={title} rows={rows} columns={columns} dateLabel={dateLabel} baseLabel={baseLabel} onOpen={onOpen} tools={tools} resetKey={resetKey} initialView={view} initialMode={mode} expanded/>)}>放大查看</Button>}{tools}</div></div>
    <p className="retention-matrix__range">{dateLabel} {rows[0]?.date??"—"} 至 {rows.at(-1)?.date??"—"} · 共 {rows.length} 个日期批次；热力图可滚动查看全部日期；趋势对比完整周期。</p>
    {view==="heatmap"&&<div className="retention-matrix__heatmap-scroll" role="region" aria-label={title+"全部日期热力图"} tabIndex={0} style={{maxHeight:chartHeight}}>
      <table className="retention-matrix__heatmap" style={{minWidth:120+columns.length*112}}>
        <thead><tr><th>{dateLabel}</th>{columns.map(column=><th key={column.id}>{column.label}</th>)}</tr></thead>
        <tbody>{rows.map(row=><tr key={row.date}><th scope="row">{row.date}</th>{columns.map(column=>{
          const cell=row.cells.find(cell=>cell.id===column.id);
          const value=cell?(mode==="rate"?cell.rate:cell.count):null;
          const intensity=scale.intensity(value);
          return <td key={column.id} style={{"--retention-intensity":intensity===null?"0%":`${6+intensity*84}%`,color:intensity!==null&&intensity>.65?"var(--color-text-on-emphasis)":"var(--color-text-1)"} as CSSProperties} className={value===null?"is-pending":undefined}>
            <FloatingHint content={<><strong>{row.date} · {column.label}</strong><p>{baseLabel}：{(row.base?.toLocaleString() ?? "—")} 人</p><p>留存人数：{cell?.count?.toLocaleString()??cell?.status??"未产出"}</p><p>留存率：{cell?.rate==null?cell?.status??"未产出":(cell.rate*100).toFixed(2)+"%"}</p><p>观察窗口结束：{cell?.availableAt??"—"}</p></>}>
              <button type="button" onClick={()=>cell&&cellDetail(row,cell)} aria-label={`${row.date} ${column.label} ${value==null?cell?.status??"未产出":format(value)}`}>{value==null?cell?.status??"未产出":format(value)}</button>
            </FloatingHint>
          </td>;
        })}</tr>)}</tbody>
      </table>
    </div>}
    {view==="line"&&<Chart theme="v13" ariaLabel={title+"各周期趋势"} style={{height:chartHeight}} onClick={params=>{const item=params as {dataIndex:number;seriesIndex:number};const row=rows[item.dataIndex],cell=row?.cells.find(cell=>cell.id===columns[item.seriesIndex]?.id);if(row&&cell)cellDetail(row,cell);}} option={{grid:{left:65,right:24,top:24,bottom:68},legend:{top:"auto",bottom:8,data:columns.map(c=>c.label),textStyle:{fontSize:12}},tooltip:{trigger:"axis",formatter:(params:{dataIndex:number}[])=>{const row=rows[params[0]?.dataIndex];return row?[row.date,`${baseLabel}：${(row.base?.toLocaleString() ?? "—")} 人`,...columns.map(column=>{const cell=row.cells.find(c=>c.id===column.id),value=cell?(mode==="rate"?cell.rate:cell.count):null;return `${column.label}：${value==null?cell?.status??"未产出":format(value)}`;})].join("<br/>"):"";}},xAxis:{type:"category",data:rows.map(row=>row.date),axisLabel:{formatter:(date:string)=>date.slice(5),hideOverlap:true}},yAxis:{type:"value",min:0,axisLabel:{formatter:(value:number)=>format(value)}},series:columns.map((column,i)=>({name:column.label,type:"line",connectNulls:false,showSymbol:rows.length<=10,symbolSize:7,data:rows.map(row=>{const cell=row.cells.find(cell=>cell.id===column.id);return cell?(mode==="rate"?cell.rate:cell.count):null;}),lineStyle:{color:CHART_PALETTE[i%CHART_PALETTE.length]},itemStyle:{color:CHART_PALETTE[i%CHART_PALETTE.length]}}))}}/>}
    {view==="table"&&
    <PaginatedTable label={title} tableClassName="retention-matrix__table" resetKey={resetKey} columnCount={columns.length + 2} head={<tr><th>{dateLabel}</th><th>{baseLabel}</th>{columns.map(column => <th key={column.id} className={focus?.id === column.id ? "is-highlighted" : ""}><FloatingHint content={column.definition}><span>{column.label}</span></FloatingHint></th>)}</tr>} rows={rows.map(row => <tr key={row.date} className={focus?.date === row.date ? "is-highlighted" : ""}><td>{row.date}</td><td>{(row.base?.toLocaleString() ?? "—")}</td>{row.cells.map(cell => {
      const column = columns.find(column => column.id === cell.id)!;
      const value = mode === "rate" ? cell.rate : cell.count, intensity = scale.intensity(value);
      const result = cell.rate === null ? cell.status : `${(cell.rate * 100).toFixed(2)}%`;
      const basis: CalculationBasis = {formula:column.definition, scope:`${dateLabel} ${row.date} · 观察窗口结束日 ${cell.availableAt}`, numerator:{name:`${column.label}留存人数`,value:cell.count,unit:"人"},denominator:{name:baseLabel,value:row.base,unit:"人"},result,percentage:true};
      return <td key={cell.id} className={`${intensity === null ? "is-pending" : ""} ${focus?.id === cell.id ? "is-highlighted" : ""}`} style={intensity === null ? undefined : {"--retention-intensity":`${6 + intensity * 84}%`, color:intensity > .65 ? "var(--color-text-on-emphasis)" : "var(--color-text-1)"} as CSSProperties} onMouseEnter={() => setFocus({date:row.date,id:cell.id})} onMouseLeave={() => setFocus(null)}>
        <FloatingHint content={<><strong>{row.date} · {column.label}</strong><p>{baseLabel} {(row.base?.toLocaleString() ?? "—")} 人</p><p>留存人数 {cell.count === null ? cell.status : cell.count.toLocaleString() + " 人"} · 留存率 {result}</p><p>观察窗口结束日 {cell.availableAt}</p></>}>
          <button type="button" aria-label={`${row.date} ${column.label} ${value === null ? cell.status : format(value)}`} onFocus={() => setFocus({date:row.date,id:cell.id})} onBlur={() => setFocus(null)} onClick={() => onOpen(`${row.date} · ${column.name}`, <><CalculationEvidence basis={basis} /><p>{cell.status} · 观察窗口结束日 {cell.availableAt}</p></>)}>{value === null ? cell.status : format(value)}</button>
        </FloatingHint>
      </td>;
    })}</tr>)} />}
    <ChartDataTable title={title+"同口径数据表"} exportAction={<>{tools}</>}><div className="retention-matrix__formula"><p>留存率 = 对应周期留存人数 ÷ {baseLabel} × 100%</p><details><summary>查看各周期定义</summary>{columns.map(column=><p key={column.id}><b>{column.label}：</b>{column.definition}</p>)}</details></div><PaginatedTable label={title+"计算明细"} resetKey={resetKey} columnCount={7} head={<tr><th>{dateLabel}</th><th>留存周期</th><th>{baseLabel}</th><th>留存人数</th><th>留存率</th><th>观察窗口结束</th><th>状态</th></tr>} rows={rows.flatMap(row=>row.cells.map(cell=><tr key={row.date+cell.id}><td>{row.date}</td><td>{columns.find(c=>c.id===cell.id)?.label}</td><td>{(row.base?.toLocaleString() ?? "—")} 人</td><td>{cell.count===null?"—":cell.count.toLocaleString()+" 人"}</td><td>{cell.rate===null?"—":(cell.rate*100).toFixed(2)+"%"}</td><td>{cell.availableAt}</td><td>{cell.status}</td></tr>))}/></ChartDataTable>
    {view!=="line"&&<div className="retention-matrix__legend" aria-label={`${title}色阶`}><span>{mode === "rate" ? "留存率" : "留存人数（人）"}</span>{scale.empty ? <span>当前范围暂无成熟结果</span> : scale.single !== null ? <span>有效值均为 {format(scale.single)}{mode === "count" ? " 人" : ""}</span> : <><span>{format(0)}</span><i aria-hidden="true" /><span>{format(scale.max)}</span></>}<span className="retention-matrix__legend-state">未成熟、待加工等状态不参与色阶</span></div>}
  </div>;
}
