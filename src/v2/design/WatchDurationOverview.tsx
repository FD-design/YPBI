import type { ReactNode } from "react";
import { ChartDataTable } from "../../components/ui/ChartDataTable";
import { PaginatedTable } from "../../components/ui/PaginatedTable";
import { Button } from "../../components/ui/Button";
import { DataOriginBadge, DataOriginProvider } from "../components/DataOrigin";
import { DashboardPanel } from "../features/dashboards/DashboardPresentation";
import { liveMetricModel, livePeriodStatus, useLiveDashboard } from "../features/dashboards/LiveDashboardContext";
import { LiveSeriesDetails, LiveSeriesExport } from "../features/dashboards/ConnectedMetricCard";
import { CalculationEvidence } from "../features/dashboards/CalculationEvidence";
import type { DashboardMetricCardModel } from "../features/dashboards/dashboard-metric-card-model";
import { readableWatchDuration } from "./watch-duration-presentation";
import "./watch-duration-overview.css";

const TYPES = ["长视频", "短视频", "其他 / 未分类"];

export function WatchDurationOverview({ models, exportDemo }: {
  models: DashboardMetricCardModel[];
  exportDemo: (model: DashboardMetricCardModel) => ReactNode;
}) {
  const live = useLiveDashboard();
  const items = models.map(original => {
    const connected = Boolean(live?.metricIds.includes(original.metric.id));
    return { model: connected ? liveMetricModel(original, live!) : original, connected };
  });
  const result = live?.state.status === "success" ? live.state.data : null;
  const previous = live?.comparison?.state.status === "success" ? live.comparison.state.data : null;
  return <DataOriginProvider value={null}><DashboardPanel title="观影时长结构与人均时长" className="watch-duration" chartKind="duration-summary">
    <div className="watch-duration__layout">
      <div className="watch-duration__summary" aria-label="观影时长数值摘要">
        {items.map(({ model, connected }) => {
          const available = model.result.status === "available" ? model.result : null;
          const readable = model.metric.id === "M098" && available ? readableWatchDuration(available.value.raw, available.value.unit) : null;
          return <DataOriginProvider key={model.metric.id} value={connected ? "pending" : "demo"}><section aria-label={`${model.metric.name}摘要`}>
            <div className="watch-duration__label"><span>{model.metric.name}</span><DataOriginBadge /></div>
            <div className="watch-duration__value"><strong>{readable ?? available?.value.display ?? "—"}</strong>{available && !readable && <span>{available.value.unit}</span>}</div>
            {readable && available && <small>精确值 {available.value.display} {available.value.unit}</small>}
            <p>{model.metric.aggregationLabel}</p>
            {!available && <p className="watch-duration__status" role="status">{model.result.status !== "available" && model.result.label}</p>}
            {available?.comparison && <p>{available.comparison.label}：{available.comparison.status === "available" ? available.comparison.display : "暂无可比结果"}</p>}
            {available && available.refresh.status !== "idle" && <p role="status">{available.refresh.status === "refreshing" ? "刷新中，保留上次查询结果" : "刷新失败，保留上次查询结果"}</p>}
            {connected && model.result.status !== "available" && model.result.retryable && <Button onClick={live!.retry}>重试读取</Button>}
          </section></DataOriginProvider>;
        })}
      </div>
      <section className="watch-duration__types" aria-label="视频类型时长比较">
        <div className="watch-duration__type-heading"><h3>哪类视频贡献时长</h3><span>类型数据待接入</span></div>
        <div className="watch-duration__type-table" role="table" aria-label="长短视频时长明细">
          <div role="row" className="watch-duration__type-head"><span role="columnheader">类型</span><span role="columnheader">总时长</span><span role="columnheader">占总体</span><span role="columnheader">人均时长</span></div>
          {TYPES.map(type => <div role="row" key={type}><span role="rowheader">{type}</span><span role="cell">—</span><span role="cell">—</span><span role="cell">—</span></div>)}
        </div>
        <p>长短视频的时长与用户基数尚未接入，暂不展示贡献比例。</p>
      </section>
    </div>
    <ChartDataTable title="观影时长同口径数据表" exportAction={<></>}>
      {items.map(({ model, connected }) => {
        const series = connected ? result?.data.series.find(item => item.metric.id === model.metric.id) : null;
        const available = model.result.status === "available" ? model.result : null;
        return <section key={model.metric.id}><h3>{model.metric.name}</h3>{connected && series && result ? <>
          {live!.canExport && !live!.controls.dirty && <LiveSeriesExport series={series} result={result} comparison={previous} comparisonStatus={livePeriodStatus(live!, true)} stale={Boolean(live!.state.status === "success" && live!.state.refreshError)} />}
          <LiveSeriesDetails series={series} result={result}/>
        </> : <><p>{model.metric.aggregationLabel}</p><p>{model.metric.definitionLabel}</p><p>{available ? `${available.value.display} ${available.value.unit} · 演示数据` : model.result.status !== "available" ? model.result.label : "—"}</p>{available?.calculation && <CalculationEvidence basis={available.calculation}/>}{connected ? <p>当前真实查询无可用结果，未使用演示替代。</p> : exportDemo(model)}</>}</section>;
      })}
      <PaginatedTable label="视频类型数据状态" columnCount={2} head={<tr><th>类型</th><th>数据状态</th></tr>} rows={TYPES.map(type => <tr key={type}><td>{type}</td><td>类型时长与同范围观影用户基数待接入</td></tr>)}/>
      <p className="dashboard-table-context">类型占比以全部观影时长为分母。不同类型的观影用户可重叠，人均时长不相加、不平均；有播放但时长为0的用户仍按原口径计入基数。</p>
    </ChartDataTable>
  </DashboardPanel></DataOriginProvider>;
}
