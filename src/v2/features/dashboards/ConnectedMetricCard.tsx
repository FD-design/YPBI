import { useState, type ReactNode } from "react";
import { Download } from "lucide-react";
import type { DailyDashboardSuccess } from "../../../../contracts/daily-dashboard";
import { Button } from "../../../components/ui/Button";
import { PaginatedTable } from "../../../components/ui/PaginatedTable";
import { DataOriginProvider } from "../../components/DataOrigin";
import type { DashboardMetricCardProps } from "./DashboardMetricCard";
import { liveCalculation, liveMetricModel, liveDailyReferenceRows, liveDataEnvironment, livePeriodStatus, livePointStateLabel, liveValue, type LiveDashboardReading, type LiveSeries } from "./LiveDashboardContext";
import { dailyDashboardEnvironment, dataEnvironmentLabel } from "../../api/daily-dashboard-environment";
import type { DataEnvironmentMode } from "../../api/dataEnvironmentPreference";
import { MetricReadingDialog } from "./MetricReadingDialog";
import { CalculationEvidence } from "./CalculationEvidence";
import { ComparisonDetails } from "./ComparisonDetails";
import { availablePeriodStatistics, periodStatisticLabel } from "./live-period-statistics";
import { isRegistrationRetentionMetric, readableRegistrationCohortSeries } from "./registration-cohort";
import { retentionReferenceRatio, safeDiagnosticSeries } from "./diagnostic-inputs";
import { isMonthlyMetric, liveMonthlySeriesRows, monthlyComparisonReason } from "./live-monthly-reading";
const readableSeries = (series: LiveSeries) => readableRegistrationCohortSeries(safeDiagnosticSeries(series));

export function LiveSeriesDetails({ series, result }: { series: LiveSeries; result: DailyDashboardSuccess }) {
  series = readableSeries(series);
  const monthly = isMonthlyMetric(series.metric.id);
  const monthRows = liveMonthlySeriesRows(series, result);
  const points = monthly ? monthRows.map(row => row.point) : series.points;
  const dateLabel = (date: string) => monthly ? monthRows.find(row => row.point.date === date)?.label ?? "月度查询范围未返回" : date;
  const statistics = availablePeriodStatistics(series, result);
  const hasReference = series.points.some(point => retentionReferenceRatio(series.metric, point));
  return <><p>{series.metric.definition}</p>{series.metric.formula && <p>计算口径：{series.metric.formula}</p>}
    <p>{result.data.query.pid} · {monthly ? "独立自然月结果；日期筛选仅定位月份，查询截至不代表数据水位" : `${result.data.query.dateRange.join(" 至 ")} · 逐日结果`} · 待验数</p>
    {statistics && statistics.dayCount > 1 && <p aria-label="周期统计">{statistics.values.map(item => `${periodStatisticLabel(item.kind)} ${item.value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })} ${series.metric.unit}`).join(" · ")} · {statistics.dayCount} 个业务日</p>}
    <PaginatedTable label={`${series.metric.name}${monthly ? "自然月" : "每日"}数据`} columnCount={series.metric.inputs.length + 3 + (hasReference ? 2 : 0)} head={<tr><th>{monthly ? "自然月与实际查询范围" : "日期"}</th>{series.metric.inputs.map(input => <th key={input.key}>{input.name}（{input.unit}）</th>)}<th>结果（{series.metric.unit}）</th><th>状态</th>{hasReference && <><th>参考比率（%）</th><th>参考说明</th></>}</tr>}
      rows={points.map(point => { const reference = retentionReferenceRatio(series.metric, point); return <tr key={point.date}><td>{dateLabel(point.date)}</td>{point.inputs.map((input, index) => <td key={input.key}>{liveValue(input.value, series.metric.inputs[index].unit)}</td>)}<td>{liveValue(point.value, series.metric.unit)}</td><td>{monthly && point.state === "no_record" ? "本月未返回记录" : livePointStateLabel(point, series.metric)}</td>{hasReference && <><td>{reference ? `${liveValue(reference.value, "%")}%` : "—"}</td><td>{reference?.label ?? "—"}</td></>}</tr>; })} />
    <details><summary>数据来源与状态</summary><p>{monthly ? "主值为所选结束日所属自然月的独立去重人数；历史月查询整月，当前月查询至执行快照中已结束的北京时间业务日。" : isRegistrationRetentionMetric(series.metric.id)?"按注册日展示；摘要按已结束观察且已返回批次的分子、分母汇总计算。":"主值为所选结束日期，不累计跨日人数。"}完整性未知，数据水位未返回。</p>{series.metric.sourceNote && <p>{series.metric.sourceNote}</p>}<p>查询时间：{new Date(result.data.fetchedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}（北京时间）</p><p>指标版本：{series.metric.authorityVersion}</p></details></>;
}
export function LiveSeriesExport({ series, result, stale = false, comparison, comparisonStatus = "未启用对比", dayReferences = [], dataEnvironment, comparisonEnvironment }: { series: LiveSeries; result: DailyDashboardSuccess; stale?: boolean; comparison?: DailyDashboardSuccess | null; comparisonStatus?: string; dayReferences?: ReturnType<typeof liveDailyReferenceRows>; dataEnvironment?: DataEnvironmentMode; comparisonEnvironment?: DataEnvironmentMode }) {
  return <Button onClick={() => {
    const monthly = isMonthlyMetric(series.metric.id);
    const periods = [{ label: "当前期", series:readableSeries(series), result }, ...(comparison ? comparison.data.series.filter(item => item.metric.id === series.metric.id).map(series => ({ label: "对比期", series:readableSeries(series), result: comparison })) : [])];
    const currentMonth = monthly ? liveMonthlySeriesRows(series, result).at(-1) : undefined;
    const previousMonths = monthly && comparison ? comparison.data.series.filter(item => item.metric.id === series.metric.id).flatMap(item => liveMonthlySeriesRows(item, comparison)) : [];
    const reason = currentMonth && comparison ? monthlyComparisonReason(currentMonth.scope, (previousMonths.find(row => !monthlyComparisonReason(currentMonth.scope, row.scope)) ?? previousMonths.at(-1))?.scope) : null;
    if (reason) comparisonStatus = `不可比：${reason}`;
    if (monthly) dayReferences = [];
    const hasReference = periods.some(period => period.series.points.some(point => retentionReferenceRatio(period.series.metric, point)));
    const cells = [["周期", "平台", monthly ? "自然月与实际查询范围（非数据水位）" : "日期", ...series.metric.inputs.map(input => `${input.name}（${input.unit}）`), `结果（${series.metric.unit === "%" ? "原始比值" : series.metric.unit}）`, "状态", "验数", "完整性", "查询时间", "刷新状态", "对比状态", "计算口径", "来源口径", ...(hasReference ? ["参考比率（%）", "参考说明"] : [])],
      ...periods.flatMap(period => {
        const rows = monthly ? liveMonthlySeriesRows(period.series, period.result).map(row => ({ point: row.point, date: row.label })) : period.series.points.map(point => ({ point, date: point.date }));
        return rows.map(({ point, date }) => { const reference = retentionReferenceRatio(period.series.metric, point); return [period.label, period.result.data.query.pid, date, ...point.inputs.map(input => input.value ?? ""), point.value ?? "", monthly && point.state === "no_record" ? "本月未返回记录" : livePointStateLabel(point, period.series.metric), "待验数", "未知", period.result.data.fetchedAt, stale ? "包含上次结果" : "本次结果", comparisonStatus, period.series.metric.formula ?? "", period.series.metric.sourceNote ?? "", ...(hasReference ? [reference ? reference.value * 100 : "", reference?.label ?? ""] : [])]; });
      }),
      ...periods.flatMap(period => (availablePeriodStatistics(period.series, period.result)?.values ?? []).map(item => [period.label + "·" + periodStatisticLabel(item.kind), period.result.data.query.pid, period.result.data.query.dateRange.join(" 至 "), ...series.metric.inputs.map(() => ""), item.value, "已返回", "待验数", "未知", period.result.data.fetchedAt, stale ? "包含上次结果" : "本次结果", comparisonStatus, period.series.metric.formula ?? "", period.series.metric.sourceNote ?? "", ...(hasReference ? ["", ""] : [])])),
      ...dayReferences.map(point => [point.label + "基准", result.data.query.pid, point.date, ...series.metric.inputs.map(input => point.inputs.find(item => item.key === input.key)?.value ?? ""), point.value ?? "", point.reason ?? "该日未返回", "待验数", "未知", point.fetchedAt, point.freshness ?? "本次结果", comparisonStatus, series.metric.formula ?? "", series.metric.sourceNote ?? "", ...(hasReference ? ["", ""] : [])])];
    const withEnvironment = cells.map((row, index) => { const position = row.length - (hasReference ? 2 : 0); return [...row.slice(0, position), index === 0 ? "数据环境" : dataEnvironmentLabel(
      String(row[0]).startsWith("对比期") ? dailyDashboardEnvironment(comparison) ?? comparisonEnvironment
        : String(row[0]).endsWith("基准") ? dayReferences.find(point => `${point.label}基准` === row[0])?.dataEnvironment
          : dailyDashboardEnvironment(result) ?? dataEnvironment), ...row.slice(position)]; });
    const csv = withEnvironment.map(row => row.map(value => { let text = String(value); if (/^[=+@\-\t\r]/.test(text)) text = "'" + text; return `"${text.replaceAll('"', '""')}"`; }).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${series.metric.name}-${result.data.query.pid}-${result.data.query.dateRange.join("_")}.csv`;
    (document.querySelector("dialog[open]") ?? document.body).appendChild(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
  }}><Download size={14} />导出</Button>;
}
export function ConnectedMetricCard({ live, original, render }: { live: LiveDashboardReading; original: DashboardMetricCardProps; render: (props: DashboardMetricCardProps) => ReactNode }) {
  const [reading, setReading] = useState<{ kind: "all" | "comparison" | "point"; date?: string; period?: "current" | "comparison" } | null>(null);
  const model = liveMetricModel(original.model, live);
  const result = live.state.status === "success" ? live.state.data : null;
  const source = result?.data.series.find(item => item.metric.id === original.model.metric.id);
  const series = source && readableSeries(source);
  const previous = live.comparison?.state.status === "success" ? live.comparison.state.data : null;
  const previousSource = previous?.data.series.find(item => item.metric.id === original.model.metric.id);
  const previousSeries = previousSource && readableSeries(previousSource);
  const available = model.result.status === "available" ? model.result : model.result.history;
  const dayReferences = liveDailyReferenceRows(live, [original.model.metric.id]);
  const selected = (reading?.period === "comparison" ? available?.trend.comparison : available?.trend.current)?.find(point => point.actualDate === reading?.date);
  const selectedSeries = reading?.period === "comparison" ? previousSeries : series;
  const selectedPoint = selectedSeries?.points.find(point => point.date === selected?.key);
  const selectedCalculation = selectedSeries && selectedPoint ? liveCalculation(selectedSeries, selectedPoint) : selected?.calculation;
  const exportAction = series && result && live.canExport && !live.controls.dirty ? <LiveSeriesExport series={series} result={result} comparison={previous} dataEnvironment={liveDataEnvironment(live)} comparisonEnvironment={live.comparison ? liveDataEnvironment(live.comparison) : undefined} comparisonStatus={livePeriodStatus(live, true)} dayReferences={dayReferences} stale={Boolean((live.state.status === "success" && live.state.refreshError) || (live.comparison?.state.status === "success" && live.comparison.state.refreshError))} /> : <></>;
  const details = series && result ? <><div className="ui-chart-data-dialog__actions">{exportAction}</div>
    {reading?.kind === "point" && selected && <><h3>{reading.period === "comparison" ? "对比期" : "当前期"} · {selected.actualDate}</h3><p>{selected.value?.display ?? "—"} {series.metric.unit} · {selected.stateLabel}</p>{selected.counterpart && <p>对应日期 {selected.counterpart.actualDate}：{selected.counterpart.display} {series.metric.unit}</p>}{selected.differenceDisplay && <p>差值：{selected.differenceDisplay}</p>}{selectedCalculation && <CalculationEvidence basis={selectedCalculation}/>}</>}
    {reading?.kind === "comparison" && (available?.reading ? available.reading.comparisons.map((comparison, index) => <ComparisonDetails key={index} comparison={comparison}/>) : available?.comparison && <ComparisonDetails comparison={available.comparison}/>)}<LiveSeriesDetails series={series} result={result}/>
    {dayReferences.length > 0 && <details><summary>日值比较基准</summary>{dayReferences.map(point => <div key={point.date}><p>{point.label} · {point.date}：{point.display} {point.unit} · {point.reason}{point.freshness ? ` · ${point.freshness}` : ""}</p>{point.calculation && <CalculationEvidence basis={point.calculation}/>}</div>)}</details>}
    {previousSeries && previous && <details><summary>对比期完整数据</summary><LiveSeriesDetails series={previousSeries} result={previous}/></details>}
  </> : <p>当前真实查询尚无可用结果；请重试读取。</p>;
  return <DataOriginProvider value="pending">{render({ ...original, model, tableExport: exportAction, note: undefined,
    onOpenAnalysis: () => setReading({ kind: "all" }), onOpenDefinition: () => setReading({ kind: "all" }), onOpenComparison: () => setReading({ kind: "comparison" }), onOpenTrendPoint: (_, point, period) => setReading({ kind: "point", date: point.actualDate, period }), onRetry: live.retry,
    onOpenBreakdown: undefined, breakdownDimensions: undefined })}
    {reading && <MetricReadingDialog title={model.metric.name} content={details} onClose={() => setReading(null)} />}
  </DataOriginProvider>;
}
