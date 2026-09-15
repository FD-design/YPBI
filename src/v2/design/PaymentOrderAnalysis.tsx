import { liveDailyReferenceRows, liveExportMetadata, liveMetricModel, livePeriodStatus, liveStateLabel, liveValue, useLiveDashboard } from "../features/dashboards/LiveDashboardContext";
import { DataOriginBadge, DataOriginProvider } from "../components/DataOrigin";
import { LiveSeriesExport } from "../features/dashboards/ConnectedMetricCard";
import { liveObservation } from "./live-reading-projection";
import { useMemo, useState, type ReactNode } from "react";
import { DashboardPanel, DashboardGuidance } from "../features/dashboards/DashboardPresentation";
import { PaginatedTable } from "../../components/ui/PaginatedTable";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { ChartDataTable } from "../../components/ui/ChartDataTable";
import { Chart } from "../../components/Chart";
import { PreviewExportControl } from "../features/dashboards/PreviewExportControl";
import { paymentBusinessAggregate, paymentDates, paymentWays, type PaymentRange } from "./payment-observations";
import { downloadPreviewWorkbook, type WorkbookSheet } from "./preview-workbook";
import { CHART_PALETTE } from "../../theme/tokens";
import { Button } from "../../components/ui/Button";
import { CompactMetricReading } from "../features/dashboards/CompactMetricReading";
import { dailyReferenceDates } from "../features/dashboards/daily-reading-model";
import { metricRows } from "./topic-preview-export";
import { PAYMENT_BUSINESS_METRICS, PAYMENT_DAILY_FORMULA, paymentBusinessBasis, paymentBusinessDisplay, paymentBusinessMetricModels } from "./payment-order-reading";
import "./payment-order-analysis.css";

export function paymentOrderSheets(range:PaymentRange,_mixed=false,compared=false):WorkbookSheet[] {
  const periods=[{label:range.start+" 至 "+range.end,range},...paymentDates(range).map(date=>({label:date,range:{start:date,end:date}}))];
  const records=periods.flatMap(period=>paymentWays.map(way=>({period,way,row:paymentBusinessAggregate(period.range,way.id)})));
  const references=compared?[{label:"所选日",date:range.end},...dailyReferenceDates(range.end).map((date,index)=>({label:index===0?"较前一天":"较上周同日",date}))]:[];
  return [
    {name:"01_支付数据说明",rows:[["数据性质","演示数据，非真实业务结果"],["成功率口径",PAYMENT_DAILY_FORMULA],["数值精度","保留原始计算精度；百分率数值以百分数导出"],["人数口径","区间及跨方式去重，分组人数不直接相加"]]},
    {name:"02_拉单与充值",rows:[["范围","支付方式",...PAYMENT_BUSINESS_METRICS.map(metric=>metric.name+"（"+metric.unit+"）"),"活跃用户数（去重）"],...records.map(({period,way,row})=>[period.label,way.label,...PAYMENT_BUSINESS_METRICS.map(metric=>row.values[metric.id]*(metric.unit==="%"?100:1)),row.inputs.activeUsers])]},
    {name:"03_支付计算依据",rows:[["范围","支付方式","指标","分子指标","分子值","分子单位","分母指标","分母值","分母单位","公式","结果（原始比值）","单位"],...records.flatMap(({period,way,row})=>PAYMENT_BUSINESS_METRICS.flatMap(metric=>{const basis=paymentBusinessBasis(metric.id,period.range,way.id,row);return basis?[[period.label,way.label,metric.name,basis.numerator.name,basis.numerator.value,basis.numerator.unit,basis.denominator.name,basis.denominator.value,basis.denominator.unit,basis.formula,row.values[metric.id],metric.unit==="%"?"比值":metric.unit]]:[]}))]},
    ...(references.length?[{name:"04_日值比较基准",rows:[["比较项","实际日期","支付方式","指标","值","单位"],...references.flatMap(reference=>paymentWays.flatMap(way=>{const row=paymentBusinessAggregate({start:reference.date,end:reference.date},way.id);return PAYMENT_BUSINESS_METRICS.map(metric=>[reference.label,reference.date,way.label,metric.name,row.values[metric.id]*(metric.unit==="%"?100:1),metric.unit]);}))]}]:[])
  ];
}
export function PaymentOrderAnalysis({range,compared=false,pending=false,onOpen}: {range:PaymentRange;compared?:boolean;mixed?:boolean;pending?:boolean;onOpen:(title:string,content:ReactNode)=>void}) {
  const live = useLiveDashboard();
  const [way,setWay]=useState("all"),[measure,setMeasure]=useState("M114");
  const connected = (id: string, scope = way) => live ? liveObservation(live, id + (scope === "all" ? "" : "." + scope), live.query.dateRange[1]) : null;
  const snapshots=useMemo(()=>paymentWays.map(item=>({...item,...paymentBusinessAggregate(range,item.id)})),[range.start,range.end]);
  const current=snapshots.find(item=>item.id===way)!,metric=PAYMENT_BUSINESS_METRICS.find(metric=>metric.id===measure)!;
  const methodRows = snapshots.slice(1).map(row => {
    const real = connected("M114", row.id);
    const basis = real ? real.basis : paymentBusinessBasis("M114", range, row.id, row);
    return {
      id: row.id, label: row.label, basis,
      result: real ? `${real.display}${real.value === null ? "" : " %"}` : `${paymentBusinessDisplay("M114", row.values.M114)} %`,
      date: real ? live!.query.dateRange[1] : `${range.start} 至 ${range.end}`,
      source: real ? "pending" as const : "demo" as const,
      state: real ? real.state : "演示数据"
    };
  });
  const paymentModels = useMemo(() => paymentBusinessMetricModels(range, way, compared).map(model => {
    if (!live) return model;
    const queryId = way === "all" ? model.metric.id : `${model.metric.id}.${way}`;
    return liveMetricModel({ ...model, metric: { ...model.metric, id: queryId } }, live);
  }), [range.start, range.end, way, compared, live]);
  const scope=(live?live.query.dateRange[0]:range.start)+" 至 "+(live?live.query.dateRange[1]:range.end)+" · "+current.label+" · 日报经营口径" + (live ? `；真实主值 ${live.query.dateRange[1]} · ${live.platformName}` : "");
  const metricExport = (model: (typeof paymentModels)[number]) => {
    if (!live) return <PreviewExportControl name={`${model.metric.name}同口径数据表`} scope={`所选支付方式的末日值、D−1 / D−7、完整逐日趋势与计算输入`} context={`${range.start} 至 ${range.end} · ${current.label} · 演示数据`} pending={pending} onDownloadPreview={() => downloadPreviewWorkbook(`${model.metric.name}同口径数据表`, [{ name: "01_同口径数据", rows: metricRows([model], () => model.result.status === "available" ? model.result.value.unit : "") }])} />;
    const result = live.state.status === "success" ? live.state.data : null;
    const series = result?.data.series.find(item => item.metric.id === model.metric.id);
    const previousResult = live.comparison?.state.status === "success" ? live.comparison.state.data : null;
    return series && result && live.canExport && !live.controls.dirty
      ? <LiveSeriesExport series={series} result={result} comparison={previousResult} comparisonStatus={livePeriodStatus(live, true)} dayReferences={liveDailyReferenceRows(live, [model.metric.id])} stale={Boolean((live.state.status === "success" && live.state.refreshError) || (live.comparison?.state.status === "success" && live.comparison.state.refreshError))} />
      : <Button disabled>导出未就绪</Button>;
  };
  const exportAction=<PreviewExportControl name="拉单与充值" scope="总体、支付宝、微信；全部指标、逐日值和计算输入" context={scope} dataOrigin={live ? "mixed" : "demo"} pending={pending || Boolean(live && (!live.canExport || live.controls.dirty || live.state.status !== "success"))} onDownloadPreview={()=>{
    if(live && (!live.canExport || live.controls.dirty || live.state.status !== "success"))return;
    const demoSheets=paymentOrderSheets(range,false,compared);
    if(!live){downloadPreviewWorkbook("拉单与充值",demoSheets);return;}
    const periods=[...(live.state.status==="success"?[{label:"当前",result:live.state.data,stale:Boolean(live.state.refreshError)}]:[]),...(live.comparison?.state.status==="success"&&live.comparison.state.data?[{label:"对比",result:live.comparison.state.data,stale:Boolean(live.comparison.state.refreshError)}]:[])];
    const dayReferences=liveDailyReferenceRows(live,live.metricIds);
    downloadPreviewWorkbook("拉单与充值",[{name:"来源说明",rows:[...liveExportMetadata(live),["真实结果","总体逐日结果，待验数；完整性未知、水位未返回"],["真实日期",live.query.dateRange.join(" 至 ")],["真实平台",live.query.pid],["查询时间",live.state.status==="success"?live.state.data.data.fetchedAt:""],["刷新状态",live.state.status==="success"&&live.state.refreshError?"上次查询结果":"本次查询结果"],["演示范围",range.start+" 至 "+range.end+"；未接入指标（逐格标注）"],["来源隔离","真实与演示分Sheet保存，不混算"]] },
      ...periods.flatMap(period=>period.result.data.series.map(series=>({name:period.label+"-"+series.metric.name,rows:[["日期","值","单位",...series.metric.inputs.map(input=>input.name+"（"+input.unit+"）"),"状态","平台","查询时间","刷新状态"],...series.points.map(point=>[point.date,point.value,series.metric.unit==="%"?"原始比值":series.metric.unit,...point.inputs.map(input=>input.value),liveStateLabel[point.state],live.query.pid,period.result.data.fetchedAt,period.stale?"上次查询结果":"本次查询结果"])]}))),
      ...(dayReferences.length?[{name:"真实-日值比较基准",rows:[["比较项","指标","指标标识","实际日期","值","单位","计算输入","状态","查询时间","刷新状态"],...dayReferences.map(reference=>[reference.label,periods.flatMap(period=>period.result.data.series).find(series=>series.metric.id===reference.metricId)?.metric.name??reference.metricId,reference.metricId,reference.date,reference.value,reference.unit,reference.inputs.map(input=>`${input.key}=${input.value??""}`).join("；"),reference.reason??"该日未返回",reference.fetchedAt,reference.freshness??"本次结果"])]}]:[]),
      ...demoSheets.map(sheet=>({...sheet,name:"演示-"+sheet.name}))], "mixed");
  }}/>;
  const table=<PaginatedTable label="拉单与充值完整明细" columnCount={11} head={<tr><th>范围</th>{PAYMENT_BUSINESS_METRICS.map(metric=><th key={metric.id}>{metric.name}</th>)}<th>活跃用户数</th></tr>} rows={snapshots.map(row=><tr key={row.id}><td>{row.label}</td>{PAYMENT_BUSINESS_METRICS.map(metric=>{const real=connected(metric.id,row.id);return <td key={metric.id}>{real?real.display:paymentBusinessDisplay(metric.id,row.values[metric.id])}{real?" "+real.unit:metric.unit==="%"?"%":metric.unit.startsWith("USD")?" USD":""}{live&&<DataOriginProvider value={real?"pending":"demo"}><DataOriginBadge/></DataOriginProvider>}</td>;})}<td>{(() => { const real = connected("M061", row.id); return <>{real ? liveValue(real.basis?.denominator.value ?? null, "人") : row.inputs.activeUsers.toLocaleString()} 人{live && <DataOriginProvider value={real ? "pending" : "demo"}><DataOriginBadge/></DataOriginProvider>}</>; })()}</td></tr>)}/>;
  return <DataOriginProvider value={live?null:"demo"}><DashboardPanel title="拉单与充值转化" note={scope} chartKind="payment-daily-business" tools={<SegmentedControl label="支付范围" value={way} onChange={setWay} options={paymentWays.map(item=>({value:item.id,label:item.label}))}/>}>
    <div className="payment-business__summary">{paymentModels.map(model => {
      const real = live?.state.status === "success" && live.state.data.data.series.some(series => series.metric.id === model.metric.id);
      const hasRatioBasis = ["M114", "M061", "M087", "M067"].includes(model.metric.id.split(".")[0]);
      return <DataOriginProvider key={model.metric.id} value={live ? real ? "pending" : null : "demo"}><CompactMetricReading model={model} tone="relation" trendVariant="link" showCalculation={hasRatioBasis} onOpen={onOpen} exportAction={metricExport(model)} note={real ? <DataOriginBadge /> : undefined} /></DataOriginProvider>;
    })}</div>
    <div className="payment-business__comparison-head"><div className="dashboard-section-heading"><h3>支付方式比较 <DataOriginProvider value={connected(measure,"alipay")?"pending":"demo"}><DataOriginBadge/></DataOriginProvider></h3><DashboardGuidance title="支付方式比较" /></div><SegmentedControl label="支付方式比较指标" value={measure} onChange={setMeasure} options={[{value:"M114",label:"成功率"},{value:"M112",label:"拉单次数"},{value:"M058",label:"充值金额"}]}/></div>
    <Chart theme="v13" ariaLabel={metric.name+"支付方式比较"+(connected(measure,"alipay")?"（待验数）":"（演示数据）")} style={{height:240}} option={{grid:{left:72,right:48,top:20,bottom:35,containLabel:true},tooltip:{trigger:"axis"},xAxis:{type:"value",min:0,name:metric.unit},yAxis:{type:"category",data:snapshots.slice(1).map(item=>item.label)},series:[{type:"bar",barMaxWidth:34,data:snapshots.slice(1).map((item,index)=>({value:connected(measure,item.id)?((value)=>value===null?null:value*(metric.unit==="%"?100:1))(connected(measure,item.id)!.value):metric.unit==="%"?item.values[measure]*100:item.values[measure],itemStyle:{color:CHART_PALETTE[index]}})),label:{show:true,position:"right",formatter:(item:{value:number})=>item.value.toFixed(2)+(metric.unit==="%"?"%":"")}}]}}/>
    <PaginatedTable label="支付方式成功率核对" columnCount={6} head={<tr><th>支付方式</th><th>充值成功次数</th><th>拉单次数</th><th>充值成功率</th><th>实际日期</th><th>状态</th></tr>} rows={methodRows.map(row => <tr key={row.id}><td>{row.label}</td><td>{row.basis?.numerator.value == null ? "—" : `${row.basis.numerator.value.toLocaleString("zh-CN")} 次`}</td><td>{row.basis?.denominator.value == null ? "—" : `${row.basis.denominator.value.toLocaleString("zh-CN")} 次`}</td><td>{row.result}</td><td>{row.date}</td><td><DataOriginProvider value={row.source}><DataOriginBadge /></DataOriginProvider>{row.state !== "演示数据" && row.state !== "已返回" && <small> · {row.state}</small>}</td></tr>)} />
    <ChartDataTable title="拉单与充值完整明细" exportAction={exportAction}><p className="dashboard-table-context">{live ? `真实值及分母对应 ${live.query.dateRange[1]} · ${live.platformName}，待验数；其余单元按演示数据标签及区间阅读。` : "演示数据；成功率为同范围充值成功次数 ÷ 拉单次数。人数按区间去重，活跃用户付费率与 ARPU 的分母为同范围全站活跃用户数。"}</p>{table}</ChartDataTable>
    <details className="payment-business__advanced"><summary>计算口径与同批订单转化说明</summary><p>充值成功率：{PAYMENT_DAILY_FORMULA}。摘要读取所选结束日；完整明细保留所选周期核对口径。{live?"多日人数不相加为区间去重人数。":"周期演示结果使用同范围事实汇总；充值人数按区间去重，不把分组人数相加。"}日报不是同批订单漏斗，不将未支付差额认定为支付失败。</p><p>同批订单转化需另有订单关联和观察窗口；此处保留日报，不从日报拼接有序用户漏斗。</p></details>
  </DashboardPanel></DataOriginProvider>;
}
