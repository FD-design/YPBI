import type { ReactNode } from "react";
import { Info } from "lucide-react";
import { DashboardPanel } from "../features/dashboards/DashboardPresentation";
import { GroupedTrend } from "../features/dashboards/GroupedTrend";
import { DataOriginProvider, DataOriginBadge } from "../components/DataOrigin";
import { LiveSeriesDetails } from "../features/dashboards/ConnectedMetricCard";
import { liveCalculation, liveExportMetadata, liveStateLabel, liveValue, type LiveDashboardReading } from "../features/dashboards/LiveDashboardContext";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { PreviewExportControl } from "../features/dashboards/PreviewExportControl";
import { CHART_PALETTE } from "../../theme/tokens";
import { topicMetric } from "./topic-preview-fixtures";
import { paymentDates } from "./payment-observations";
import { liveObservation } from "./live-reading-projection";
import { downloadPreviewWorkbook } from "./preview-workbook";

export function ConnectedAdvertising({ live, audience, onAudience, onOpen, id, setId }: { live: LiveDashboardReading; audience:string; onAudience: (value: string) => void; onOpen: (title: string, content: ReactNode) => void; id: string; setId: (value: string) => void }) {
  const projections:Record<string,string>={M094:audience==="new"?"M094.new":"M094.ads",M055:audience==="new"?"M055.new":"M055.ads",M111:audience==="new"?"M111.new":"M111",M110:audience==="new"?"M110.new":"M110"};
  const navigation=["M055.navigation","M094.navigation","M055.total","M094.total"].map(id=>id+(audience==="new"?".new":""));
  const range = { start: live.query.dateRange[0], end: live.query.dateRange[1] }, days = paymentDates(range);
  const row = (metric: string, date = range.end) => liveObservation(live, projections[metric] ?? metric, date) ?? {value:null,unit:metric==="M111"?"%":"次/人",display:"—",state:"分母待核对",basis:undefined,series:undefined,result:null};
  const selected = row(id), unit = selected.unit || (id === "M111" ? "%" : id === "M110" ? "次/人" : id === "M055" ? "次" : "人");
  const previous = live.comparison?.state.status === "success" ? live.comparison.state.data : null;
  const previousSeries = previous?.data.series.find(series => series.metric.id === projections[id]);
  const detail = (metric: string) => { const value = row(metric); onOpen(value.series?.metric.name ?? topicMetric(metric).name, value.series && value.result ? <LiveSeriesDetails series={value.series} result={value.result} /> : <p>{value.state}</p>); };
  const exported = <PreviewExportControl name="广告点击表现" scope="广告、导航广告与总点击的逐日结果及计算输入" context={`${range.start} 至 ${range.end} · ${live.platformName} · 待验数`} dataOrigin="live" pending={live.state.status !== "success" || !live.canExport || live.controls.dirty} onDownloadPreview={() => {
    if (live.state.status !== "success" || !live.canExport || live.controls.dirty) return;
    const ids = [...Object.values(projections), ...navigation];
    downloadPreviewWorkbook("广告点击表现", [{ name: "数据说明", rows: [...liveExportMetadata(live), ["数据性质", "真实后台结果，待验数"], ["完整性", "未知"], ["水位", "未返回"], ["平台", live.query.pid], ["查询时间", live.state.data.data.fetchedAt]] },
      ...[{ label: "当前", result: live.state.data, stale: Boolean(live.state.refreshError) }, ...(previous ? [{ label: "对比", result: previous, stale: Boolean(live.comparison?.state.status === "success" && live.comparison.state.refreshError) }] : [])].flatMap(period => period.result.data.series.filter(series => ids.includes(series.metric.id)).map(series => ({ name: period.label + "-" + series.metric.name, rows: [["日期", `值（${series.metric.unit === "%" ? "原始比值" : series.metric.unit}）`, ...series.metric.inputs.map(input => input.name), "状态", "查询时间", "刷新状态"], ...series.points.map(point => [point.date, point.value, ...point.inputs.map(input => input.value), liveStateLabel[point.state], period.result.data.fetchedAt, period.stale ? "上次查询结果" : "本次查询结果"])] }))) ], "pending");
  }} />;
  return <DataOriginProvider value="pending"><DashboardPanel title="广告点击表现" note={`摘要日期 ${range.end} · ${live.platformName} · ${audience==="new"?"新用户":"总体"}`} chartKind="advertising-summary-trend" tools={<SegmentedControl label="广告人群" value={audience} onChange={onAudience} options={[{ value: "all", label: "总体" }, { value: "new", label: "新用户" }]} />}>
    <div className="ad-overview__summaries">{Object.keys(projections).map(metric => { const value = row(metric); return <section key={metric} className={id === metric ? "is-selected" : ""}><button type="button" className="ad-overview__choose" aria-pressed={id === metric} aria-label={`选择${topicMetric(metric).name}`} onClick={() => setId(metric)}><span>{topicMetric(metric).name}</span><strong>{value.display} {value.unit}</strong></button><button type="button" className="ui-icon-button ad-overview__info" aria-label={`${topicMetric(metric).name}数值与计算依据`} onClick={() => detail(metric)}><Info /></button></section>; })}</div>
    <details className="payment-business__advanced"><summary>导航广告与总点击</summary><p>导航广告指导航Tab中的广告。</p><div className="ad-overview__summaries">{navigation.map(metric => { const value = row(metric); const name = value.series?.metric.name ?? ({ "M055.navigation": "导航广告点击次数", "M094.navigation": "导航广告点击人数", "M055.total": "总点击次数", "M094.total": "总点击人数" }[metric.replace(/\.new$/, "")]); return <section key={metric}><button type="button" className="ad-overview__choose" onClick={() => { if (value.series && value.result) onOpen(name!, <LiveSeriesDetails series={value.series} result={value.result} />); }}><span>{name}</span><strong>{value.display} {value.unit}</strong></button></section>; })}</div><p>各项直接读取后台结果；总点击人数不由分组人数相加。</p></details>
    <GroupedTrend title={topicMetric(id).name} groups={[{ id: "current", label: topicMetric(id).name, color: CHART_PALETTE[0] }]}
      points={days.map((date, index) => {
        const value = row(id, date), prior = previousSeries?.points[index];
        const basis = prior && previousSeries ? liveCalculation(previousSeries, prior) : undefined;
        return { date, values: { current: value.value }, states: { current: value.state + " · 待验数" },
          basis: value.basis ? { current: value.basis } : undefined,
          comparison: prior ? { date: prior.date, values: { current: prior.value }, basis: basis ? { current: basis } : undefined } : undefined };
      })}
      kind={["M110", "M111"].includes(id) ? "line" : "bar"} unit={unit} format={value => `${liveValue(value, unit)} ${unit}`}
      queryKey={JSON.stringify([live.query, id])} onOpen={onOpen} exportAction={exported} />
  </DashboardPanel></DataOriginProvider>;
}
