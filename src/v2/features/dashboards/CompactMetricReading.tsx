import { useState, type ReactElement, type ReactNode } from "react";
import { FloatingHint } from "../../../components/ui/FloatingHint";
import { CardViewSwitch, type CardView } from "../../../components/ui/CardViewSwitch";
import { ChangeValue } from "../../../components/ui/ChangeValue";
import { changeDirection } from "../../../components/ui/change-presentation";
import { CalculationEvidence } from "./CalculationEvidence";
import { DetailedMetricTrend } from "./DetailedMetricTrend";
import { MetricReadingContext, MetricSummary } from "./MetricSummary";
import {
  dashboardMetricStatusPresentation,
  dashboardTrendDomain,
  dashboardTrendPath,
  type DashboardMetricCardModel,
  type DashboardMetricTrendPoint
} from "./dashboard-metric-card-model";
import "./compact-metric-reading.css";

type OpenReading = (title: string, content: ReactNode) => void;

export interface CompactMetricReadingProps {
  model: DashboardMetricCardModel;
  onOpen: OpenReading;
  exportAction: ReactElement;
  note?: ReactNode;
  tone?: "stage" | "relation";
  showCalculation?: boolean;
  trendVariant?: "mini" | "link";
}

function availableResult(model: DashboardMetricCardModel) {
  return model.result.status === "available" ? model.result : model.result.history;
}

function hasVisibleState(model: DashboardMetricCardModel) {
  return model.result.status !== "available"
    || model.result.refresh.status !== "idle"
    || model.result.completeness !== "complete";
}

/** Pure projection used by the compact renderer and its regression tests. */
export function compactTrendReading(model: DashboardMetricCardModel) {
  const result = availableResult(model);
  if (!result?.trend.current.length) return null;
  const domain = dashboardTrendDomain(result.trend);
  if (!domain) return null;
  const current = dashboardTrendPath(result.trend.current, domain);
  const comparison = result.trend.comparison?.length
    ? dashboardTrendPath(result.trend.comparison, domain)
    : "";
  const dates = result.trend.current.map(point => point.actualDate);
  const isolatedPoints = (points: DashboardMetricTrendPoint[]) => points.flatMap((point, index) => {
    const raw = point.value?.raw;
    if (typeof raw !== "number" || !Number.isFinite(raw)) return [];
    const available = (candidate: DashboardMetricTrendPoint | undefined) => typeof candidate?.value?.raw === "number" && Number.isFinite(candidate.value.raw);
    if (available(points[index - 1]) || available(points[index + 1])) return [];
    const x = points.length === 1 ? 120 : 8 + index * (224 / (points.length - 1));
    return [{ x, y: 50 - ((raw - domain.min) / domain.spread) * 40 }];
  });
  return {
    current,
    comparison,
    currentPoints: isolatedPoints(result.trend.current),
    comparisonPoints: isolatedPoints(result.trend.comparison ?? []),
    start: dates[0],
    end: dates.at(-1)!,
    availablePoints: result.trend.current.filter(point => point.value !== null).length
  };
}

function MetricTitle({ model, onOpen }: { model: DashboardMetricCardModel; onOpen: OpenReading }) {
  const result = availableResult(model);
  return <FloatingHint content={model.metric.definitionLabel} pinOnClick>
    <button type="button" className="compact-metric-reading__title" onClick={() => onOpen(model.metric.name, <><p>{model.metric.definitionLabel}</p>{result?.calculation && <CalculationEvidence basis={result.calculation} />}</>)}>
      {model.metric.name}
    </button>
  </FloatingHint>;
}

function CompactTrend({ model, onOpen, exportAction }: { model: DashboardMetricCardModel; onOpen: OpenReading; exportAction: ReactElement }) {
  const geometry = compactTrendReading(model);
  const result = availableResult(model);
  if (!geometry || !result) return <div className="compact-metric-reading__trend-empty" role="status">当前范围暂无趋势</div>;
  const trendComparison = result.reading?.trendComparisonLabel;
  const actionLabel = `查看${model.metric.name}完整趋势与同口径数据${trendComparison ? `；${trendComparison}` : ""}`;
  return <div className="compact-metric-reading__trend-wrap">
    <FloatingHint content={actionLabel}>
      <button type="button" className="compact-metric-reading__trend" aria-label={actionLabel} onClick={() => onOpen(`${model.metric.name} · 完整趋势与数据`, <CompactMetricDetails model={model} exportAction={exportAction} />)}>
        <svg viewBox="0 0 240 58" preserveAspectRatio="none" role="img" aria-label={`${model.metric.name} ${geometry.start} 至 ${geometry.end} 的轻量趋势`}>
          <line x1="0" x2="240" y1="50" y2="50" />
          {geometry.comparison && <path className="is-comparison" d={geometry.comparison} />}
          <path className="is-current" d={geometry.current} />
          {geometry.comparisonPoints.map((point, index) => <circle key={`comparison-${index}`} className="is-comparison" cx={point.x} cy={point.y} r="3" />)}
          {geometry.currentPoints.map((point, index) => <circle key={`current-${index}`} className="is-current" cx={point.x} cy={point.y} r="3.5" />)}
        </svg>
        <span className="compact-metric-reading__dates" aria-hidden="true"><span>{geometry.start.slice(5)}</span><span>{geometry.end.slice(5)}</span></span>
      </button>
    </FloatingHint>
  </div>;
}

function pointDisplay(display: string | undefined, unit: string) {
  if (!display || display === "—" || !unit || display.includes(unit)) return display ?? "—";
  return `${display} ${unit}`;
}

function CompactMetricDetails({ model, exportAction }: { model: DashboardMetricCardModel; exportAction: ReactElement }) {
  const [view, setView] = useState<CardView>("trend");
  const [selected, setSelected] = useState<{ point: DashboardMetricTrendPoint; period: "current" | "comparison" } | null>(null);
  const result = availableResult(model);
  const chartModel: DashboardMetricCardModel = result ? { ...model, result } : model;
  const presentation = dashboardMetricStatusPresentation(model);
  if (!result) return <p role="status">{presentation.label}：{presentation.description}</p>;
  return <div className="compact-metric-reading__details">
    {hasVisibleState(model) && <p role="status" className="compact-metric-reading__state">{presentation.label}：{presentation.description}</p>}
    <div className="compact-metric-reading__details-head"><p>{model.metric.aggregationLabel}</p><CardViewSwitch label={model.metric.name} value={view} onChange={setView} /></div>
    {selected && <section className="compact-metric-reading__point" aria-label="所选趋势点">
      <div><b>{selected.period === "current" ? "当前期" : "对比期"} · {selected.point.actualDate}</b><button type="button" onClick={() => setSelected(null)}>收起点位</button></div>
      <p>{pointDisplay(selected.point.value?.display, result.value.unit)} · {selected.point.stateLabel}</p>
      {selected.point.counterpart && <p>对应日期 {selected.point.counterpart.actualDate}：{pointDisplay(selected.point.counterpart.display, result.value.unit)}</p>}
      {selected.point.differenceDisplay && <p>差值：<ChangeValue direction={selected.point.value && selected.point.counterpart ? changeDirection(selected.period === "comparison" ? selected.point.counterpart.raw - selected.point.value.raw : selected.point.value.raw - selected.point.counterpart.raw) : null}>{selected.point.differenceDisplay}</ChangeValue></p>}
      {selected.point.calculation && <CalculationEvidence basis={selected.point.calculation} />}
    </section>}
    <DetailedMetricTrend model={chartModel} view={view} exportAction={exportAction} onOpenPoint={(point, period) => setSelected({ point, period })} />
  </div>;
}

export function CompactMetricReading({ model, onOpen, exportAction, note, tone = "stage", showCalculation = false, trendVariant = "mini" }: CompactMetricReadingProps) {
  const result = availableResult(model);
  const current = model.result.status === "available" ? model.result : null;
  const reading = model.result.reading ?? result?.reading;
  const comparisons = reading?.comparisons ?? (current?.comparison ? [current.comparison] : []);
  const presentation = dashboardMetricStatusPresentation(model);
  const stateLabel = hasVisibleState(model) ? presentation.label : null;
  const summaryNote = note || stateLabel ? <span className="compact-metric-reading__note">
    {note && <span>{note}</span>}
    {stateLabel && <span role="status">{stateLabel}</span>}
  </span> : undefined;
  return <section role="article" className={`compact-metric-reading is-${tone} is-${model.result.status}${trendVariant === "link" ? " is-link-only" : ""}`} aria-label={`${model.metric.name}轻量诊断`}>
    <MetricSummary
      title={<MetricTitle model={model} onOpen={onOpen} />}
      context={reading ? <MetricReadingContext reading={reading} /> : model.metric.aggregationLabel}
      value={current?.value.display ?? "—"}
      unit={current ? current.value.unit : undefined}
      comparisons={comparisons}
      size="supporting"
      note={summaryNote}
    />
    {trendVariant === "mini" && <CompactTrend model={model} onOpen={onOpen} exportAction={exportAction} />}
    <div className="compact-metric-reading__actions">
      {showCalculation && result && <CalculationEvidence compact basis={result.calculation} />}
      <button type="button" onClick={() => onOpen(`${model.metric.name} · 完整趋势与数据`, <CompactMetricDetails model={model} exportAction={exportAction} />)}>查看趋势与数据</button>
    </div>
  </section>;
}
