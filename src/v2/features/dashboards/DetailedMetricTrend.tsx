import { useMemo, type ReactElement } from "react";
import { ChartDataTable } from "../../../components/ui/ChartDataTable";
import { Chart } from "../../../components/Chart";
import { ChangeValue } from "../../../components/ui/ChangeValue";
import { changeDirection } from "../../../components/ui/change-presentation";
import { detailedTrendOption } from "./detailed-trend-option";
import { PaginatedTable } from "../../../components/ui/PaginatedTable";
import type { CardView } from "../../../components/ui/CardViewSwitch";
import { TrendRange, useTrendRange } from "../../../components/ui/TrendRange";
import type { DashboardMetricCardModel, DashboardMetricTrendPoint } from "./dashboard-metric-card-model";
import "./detailed-metric-trend.css";
import { CalculationColumnHeaders, CalculationColumns, missingCalculation } from "./CalculationEvidence";
import { calculationTableColumns, missingCalculationValues } from "./calculation-table-model";

export function DetailedMetricTrend({ model, onOpenPoint, exportAction, view = "trend", summaryOnly = false }: { model: DashboardMetricCardModel; onOpenPoint: (point: DashboardMetricTrendPoint, period: "current" | "comparison") => void; exportAction: ReactElement; view?: CardView; summaryOnly?: boolean }) {
  const result = model.result.status === "available" ? { ...model.result, trendKind: view === "bar" ? "bar" as const : "line" as const } : model.result;
  const dates = result.status === "available" ? result.trend.current.map(point => point.actualDate) : [];
  const range = useTrendRange(dates);
  const option = useMemo(() => result.status === "available" ? detailedTrendOption({ kind: result.trendKind, unit: result.value.unit, dates: dates.slice(range.start, range.end + 1), values: result.trend.current.slice(range.start, range.end + 1).map(point => point.value?.raw ?? null), comparison: result.trend.comparison ? { dates: result.trend.comparison.slice(range.start, range.end + 1).map(point => point.actualDate), values: result.trend.comparison.slice(range.start, range.end + 1).map(point => point.value?.raw ?? null) } : null }) : null, [result, range.start, range.end]);
  if (result.status !== "available" || !option) return null;
  const fallback = missingCalculationValues(result.calculation) ?? missingCalculation(model.metric.definitionLabel, model.metric.aggregationLabel, result.value.display, result.value.unit === "%");
  const currentFallback = missingCalculationValues(result.trend.current.find(point => point.calculation)?.calculation) ?? fallback;
  const comparisonFallback = missingCalculationValues(result.trend.comparison?.find(point => point.calculation)?.calculation) ?? fallback;
  const calculated = !!fallback || [...result.trend.current, ...(result.trend.comparison ?? [])].some(point => point.calculation);
  const rowCount = Math.max(result.trend.current.length, result.trend.comparison?.length ?? 0);
  const currentColumns = calculationTableColumns(Array.from({ length: rowCount }, (_, index) => result.trend.current[index]?.calculation ?? currentFallback));
  const comparisonColumns = calculationTableColumns(Array.from({ length: rowCount }, (_, index) => result.trend.comparison?.[index]?.calculation ?? comparisonFallback), "对比");
  const head = <tr><th>日期</th>{calculated && <CalculationColumnHeaders columns={currentColumns}/>}<th>当前值</th>{result.trend.comparison && <><th>对比日期</th>{calculated && <CalculationColumnHeaders columns={comparisonColumns}/>}<th>对比值</th><th>差值</th></>}<th>状态</th></tr>;
  const rows = Array.from({ length: rowCount }, (_, index) => {
    const point = result.trend.current[index];
    const previous = point?.counterpart ?? (!point ? result.trend.comparison?.[index]?.value : null);
    return <tr key={point?.key ?? `comparison-${index}`}><td>{point ? <button type="button" onClick={() => onOpenPoint(point, "current")}>{point.actualDate}</button> : "—"}</td>{calculated && <CalculationColumns basis={point?.calculation} fallback={currentFallback} columns={currentColumns}/>}<td>{point?.value?.display ?? "—"}</td>{result.trend.comparison && <><td>{previous?.actualDate ?? result.trend.comparison[index]?.actualDate ?? "—"}</td>{calculated && <CalculationColumns basis={result.trend.comparison[index]?.calculation} fallback={comparisonFallback} columns={comparisonColumns}/>}<td>{previous?.display ?? "—"}</td><td><ChangeValue direction={point?.value && previous ? changeDirection(point.value.raw - previous.raw) : null}>{point?.differenceDisplay ?? "不可比"}</ChangeValue></td></>}<td>{point?.stateLabel ?? "仅对比期"}{calculated && !point?.calculation ? " · 计算输入待接入" : ""}</td></tr>;
  });
  const table = (compact: boolean) => <>{calculated && <p className="dashboard-table-context">公式：{result.calculation?.formula ?? fallback?.formula}。各行输入对应当日及当前筛选；缺失不反推。</p>}<PaginatedTable label={`${model.metric.name}逐日数据`} head={head} rows={rows} columnCount={(result.trend.comparison ? 6 : 3)+(calculated ? currentColumns.length + (result.trend.comparison ? comparisonColumns.length : 0) : 0)} resetKey={`${model.metric.id}:${dates.join()}`} compact={compact} /></>;
  if (summaryOnly) return <ChartDataTable title={`${model.metric.name}同口径数据表`} exportAction={exportAction}>{table(false)}</ChartDataTable>;
  return <div className="detailed-metric-trend">
    <div className="detailed-metric-trend__view" data-long-series={dates.length>31||undefined} role="region" aria-label={`${model.metric.name}${view === "table" ? "表格" : view === "bar" ? "柱状" : "折线"}视图`}>
      {view !== "table" ? <><Chart option={option} theme="v13" ariaLabel={`${model.metric.name}逐日${result.trendKind === "bar" ? "柱状" : "折线"}趋势`} style={{ height: 220 }} onClick={(params: any) => { const period = params.seriesName === "对比期" ? "comparison" : "current"; const point = result.trend[period]?.[range.start + Number(params.dataIndex)]; if (point) onOpenPoint(point, period); }} /><TrendRange values={model.result.status === "available" ? model.result.trend.current.map(point => point.value?.raw ?? null) : []} dates={dates} {...range} onChange={range.setRange} /></> : table(true)}
    </div>
    {view === "table" && <div className="detailed-metric-trend__export">{exportAction}</div>}
    <ChartDataTable title={`${model.metric.name}同口径数据表`} exportAction={exportAction}>
      {table(false)}
    </ChartDataTable>
  </div>;
}
