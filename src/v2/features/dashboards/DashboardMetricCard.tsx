import { CircleAlert, Info, Maximize2 } from "lucide-react";
import { useId, useEffect, useRef, useState, type CSSProperties, type ReactElement } from "react";
import { chartAxisLabels, chartAxisScale } from "../../../components/chart-axis";
import { FloatingHint } from "../../../components/ui/FloatingHint";
import { ComparisonDetails } from "./ComparisonDetails";
import { ChangeValue } from "../../../components/ui/ChangeValue";
import { changeDirection } from "../../../components/ui/change-presentation";
import { ProductLink } from "../../app/router";
import { DetailedMetricTrend } from "./DetailedMetricTrend";
import { MetricReadingDialog } from "./MetricReadingDialog";
import { LoadingIndicator } from "../../../components/ui/LoadingIndicator";
import { CardViewSwitch, type CardView } from "../../../components/ui/CardViewSwitch";
import { TrendRange, useTrendRange } from "../../../components/ui/TrendRange";
import { useDashboardCardMode } from "./DashboardCardMode";
import { Button } from "../../../components/ui/Button";
import { CalculationEvidence, missingCalculation } from "./CalculationEvidence";
import { DataOriginBadge, useDataOrigin } from "../../components/DataOrigin";
import { useLiveDashboard } from "./LiveDashboardContext";
import { ConnectedMetricCard } from "./ConnectedMetricCard";
import { MetricPeriodStatistics, MetricReadingContext, MetricSummary } from "./MetricSummary";
import {
  dashboardMetricStatusPresentation,
  dashboardTrendDomain,
  dashboardTrendPath,
  type DashboardMetricCardModel,
  type DashboardMetricTrendPoint
} from "./dashboard-metric-card-model";
import "./dashboard-metric-card.css";

export type DashboardMetricCardProps = ({ variant?: "compact" | "value"; tableExport?: ReactElement } | { variant: "detailed"; tableExport: ReactElement }) & {
  note?: string;
  compactDetails?: boolean;
  model: DashboardMetricCardModel;
  analysisHref: string;
  onOpenAnalysis?: (model: DashboardMetricCardModel) => void;
  onOpenDefinition: (model: DashboardMetricCardModel) => void;
  onOpenComparison: (model: DashboardMetricCardModel) => void;
  onOpenTrendPoint: (model: DashboardMetricCardModel, point: DashboardMetricTrendPoint, series: "current" | "comparison") => void;
  onRetry?: (model: DashboardMetricCardModel) => void;
  onOpenBreakdown?: (model: DashboardMetricCardModel) => void;
  breakdownDimensions?: string;
}

function shortDate(value: string) {
  const matched = value.match(/(\d{2})-(\d{2})$/);
  return matched ? `${matched[1]}-${matched[2]}` : value;
}

function DashboardMiniTrend({ model, onOpenTrendPoint }: Pick<DashboardMetricCardProps, "model" | "onOpenTrendPoint">) {
  const stage = useRef<HTMLDivElement>(null);
  const [stageWidth, setStageWidth] = useState(280);
  useEffect(() => {
    const element = stage.current; if (!element) return;
    const observer = new ResizeObserver(([entry]) => setStageWidth(Math.round(entry.contentRect.width)));
    observer.observe(element); return () => observer.disconnect();
  }, [model.result]);
  const result = model.result;
  if (result.status !== "available") return null;
  if (!result.trend.current.length && !result.trend.comparison?.length) return <div className="dashboard-metric-card__trend-empty" role="status">当前范围暂无可展示趋势</div>;
  const dataDomain = dashboardTrendDomain(result.trend, result.trendKind === "bar");
  if (!dataDomain) return <div className="dashboard-metric-card__trend-empty" role="status">当前范围暂无可展示趋势</div>;
  const domain = chartAxisScale(dataDomain.min, dataDomain.max, ["人", "次", "单"].includes(result.value.unit) ? 1 : 0);
  const comparisonVisible = Boolean(result.trend.comparison?.length);
  const pointCount = Math.max(result.trend.current.length, result.trend.comparison?.length ?? 0, 1);
  const pointStep = pointCount > 1 ? 224 / (pointCount - 1) : 240;
  const barWidth = Math.min(7, pointStep * .3), barGap = Math.min(1, pointStep * .05);
  const zeroY = 50 - ((0 - domain.min) / domain.spread) * 40;
  const axisValues = [...domain.ticks].reverse();
  const axisPositions = axisValues.map(value => 50 - (value - domain.min) / domain.spread * 40);
  const isRatio = result.value.unit === "%" || result.value.unit === "比例";
  const axisLabels = chartAxisLabels(axisValues, isRatio ? 100 : 1, isRatio ? "%" : "");
  const axisWidth = Math.max(42, ...axisLabels.map(label => label.length * 6.5));
  const axisDates = (result.trend.current.length ? result.trend.current : result.trend.comparison ?? [])
    .map((point) => point.actualDate);
  const axisLabelStep = Math.max(1, Math.ceil((axisDates.length - 1) * 52 / Math.max(stageWidth * 224 / 240, 1)));
  const axisIndices = axisDates.flatMap((_, i) => i === 0 || i === axisDates.length - 1 || (i % axisLabelStep === 0 && axisDates.length - 1 - i >= axisLabelStep) ? [i] : []);
  const renderBars = (points: DashboardMetricTrendPoint[], series: "current" | "comparison") => points.flatMap((point, index) => {
    if (!point.value) return [];
    const center = points.length === 1 ? 120 : 8 + index * (224 / (points.length - 1));
    const y = 50 - ((point.value.raw - domain.min) / domain.spread) * 40;
    const x = series === "comparison" ? center - barWidth - barGap : center + barGap;
    return [<rect key={`${point.key}-${series}`} className={series === "comparison" ? "is-compare" : "is-current"} x={x} y={Math.min(zeroY, y)} width={barWidth} height={Math.abs(zeroY - y)} rx="1.5" />];
  });
  const seriesArePaired = Boolean(
    result.trend.comparison
    && result.trend.comparison.length === result.trend.current.length
  );
  const interactivePoints = ([
    ["current", result.trend.current],
    ["comparison", result.trend.comparison ?? []]
  ] as const).flatMap(([series, points]) => points.map((point, index) => ({ series, points, point, index })));
  return <div className={`dashboard-mini-trend is-${result.trendKind}${pointCount > 31 ? " is-dense" : ""}`} role="group" aria-label={`${model.metric.name}当前期${comparisonVisible ? "与对比期" : ""}趋势`}>
    <div className="dashboard-mini-trend__plot" style={{ gridTemplateColumns: `${axisWidth}px minmax(0, 1fr)` }}>
      <div className="dashboard-mini-trend__y-axis" aria-hidden="true">{axisLabels.map((label, index) => <span key={index} style={{ top: `${axisPositions[index] / 58 * 100}%` }}>{label}</span>)}</div>
      <div className="dashboard-mini-trend__stage" ref={stage}>
        <div className="dashboard-mini-trend__canvas">
          <svg viewBox="0 0 240 58" preserveAspectRatio="none" aria-hidden="true">
            {axisPositions.map(y => <line key={y} x1="0" x2="240" y1={y} y2={y} />)}
            {result.trendKind === "line" ? <>
              {comparisonVisible && <path className="is-compare" d={dashboardTrendPath(result.trend.comparison ?? [], domain)} />}
              <path className="is-current" d={dashboardTrendPath(result.trend.current, domain)} />
            </> : <>{renderBars(result.trend.comparison ?? [], "comparison")}{renderBars(result.trend.current, "current")}</>}
          </svg>
          {interactivePoints.map(({ series, points, point, index }) => {
      const center = points.length === 1 ? 120 : 8 + index * (224 / (points.length - 1));
      const plottedX = result.trendKind === "bar"
        ? series === "comparison" ? center - barWidth / 2 - barGap : center + barWidth / 2 + barGap
        : center;
      const x = (plottedX / 240) * 100;
      const plottedValue = point.value ?? (seriesArePaired ? point.counterpart : null);
      const y = plottedValue
        ? ((50 - ((plottedValue.raw - domain.min) / domain.spread) * 40) / 58) * 100
        : (50 / 58) * 100;
      const seriesLabel = series === "current" ? "当前期" : "对比期";
      const valueLabel = point.value ? `${point.actualDate} · ${point.value.display}` : `${point.actualDate} · ${point.stateLabel}`;
      const paired = Boolean(point.counterpart);
      const currentRaw = series === "current" ? point.value?.raw : point.counterpart?.raw;
      const comparisonRaw = series === "comparison" ? point.value?.raw : point.counterpart?.raw;
      const differenceDirection = point.differenceDisplay !== null && currentRaw != null && comparisonRaw != null
        ? changeDirection(currentRaw - comparisonRaw)
        : null;
      const currentLabel = series === "current" ? valueLabel : point.counterpart ? `${point.counterpart.actualDate} · ${point.counterpart.display}` : null;
      const comparisonLabel = series === "comparison" ? valueLabel : point.counterpart ? `${point.counterpart.actualDate} · ${point.counterpart.display}` : null;
      const ariaLabel = paired
        ? `${seriesLabel}${point.label}，当前 ${currentLabel}，对比 ${comparisonLabel}，差值 ${point.differenceDisplay ?? "不可比"}`
        : `${seriesLabel}${point.label}，${valueLabel}`;
      const step = points.length > 1 ? 224 / (points.length - 1) : 240;
      const bandStart = index === 0 ? 0 : center - step / 2;
      const bandEnd = index === points.length - 1 ? 240 : center + step / 2;
      const split = seriesArePaired && comparisonVisible;
      const hitStart = split && series === "current" ? center : bandStart;
      const hitEnd = split && series === "comparison" ? center : bandEnd;
      const hitWidth = hitEnd - hitStart;
      const dateBand = seriesArePaired || !comparisonVisible;
      return <FloatingHint key={`${series}-${point.key}`} className="dashboard-mini-trend__hit"
        style={dateBand
          ? { left: `${hitStart / 240 * 100}%`, top: `${10 / 58 * 100}%`, width: `${hitWidth / 240 * 100}%`, height: `${40 / 58 * 100}%`, translate: "0 0", "--point-left": `${(plottedX - hitStart) / hitWidth * 100}%`, "--point-top": `${(y * 58 / 100 - 10) / 40 * 100}%` } as CSSProperties
          : { left: `${x}%`, top: `${y}%` }}
        content={<div className="dashboard-mini-trend__tooltip">{paired
          ? <><span>当前 {currentLabel}</span><span>对比 {comparisonLabel}</span><span>较对比期 <ChangeValue direction={differenceDirection} onEmphasis>{point.differenceDisplay ?? "不可比"}</ChangeValue></span></>
          : <span>{seriesLabel} {valueLabel}</span>}</div>}>
      <button
        type="button"
        className={`dashboard-mini-trend__point is-${series}${dateBand ? " is-date-band" : ""}${point.value ? "" : " is-unavailable"}`}
        aria-label={ariaLabel}
        onClick={() => onOpenTrendPoint(model, point, series)}
      /></FloatingHint>;
          })}
        </div>
        <div className="dashboard-mini-trend__x-axis" aria-hidden="true">{axisIndices.map(index => <span key={`${axisDates[index]}-${index}`} style={{ left: `${axisDates.length === 1 ? 50 : index === 0 ? 0 : index === axisDates.length - 1 ? 100 : (8 + index * 224 / (axisDates.length - 1)) / 240 * 100}%`, translate: axisDates.length === 1 ? "-50% 0" : index === 0 ? "0 0" : index === axisDates.length - 1 ? "-100% 0" : "-50% 0" }}>{shortDate(axisDates[index])}</span>)}</div>
      </div>
    </div>
    <div className="dashboard-mini-trend__legend" aria-hidden="true"><span>当前期</span>{comparisonVisible && <span>对比期</span>}</div>
  </div>;
}

export function DashboardMetricCard(props: DashboardMetricCardProps) {
  const live = useLiveDashboard();
  // Operating-detail value cards have their own scope and remain on their own source.
  return live && props.variant !== "value" && live.metricIds.includes(props.model.metric.id)
    ? <ConnectedMetricCard live={live} original={props} render={resolved => <DashboardMetricCardView {...resolved} />} />
    : <DashboardMetricCardView {...props} />;
}

function DashboardMetricCardView({ model, analysisHref, onOpenAnalysis, onOpenDefinition, onOpenComparison, onOpenTrendPoint, onRetry, onOpenBreakdown, breakdownDimensions, variant: requestedVariant, note, tableExport, compactDetails = false }: DashboardMetricCardProps) {
  const origin = useDataOrigin();
  const mode = useDashboardCardMode(requestedVariant !== "value");
  const modeValue = mode === "value";
  const variant = modeValue ? "value" : requestedVariant;
  const [view, setView] = useState<CardView>("trend");
  const [fullTrendOpen, setFullTrendOpen] = useState(false);
  const [fullTrendView, setFullTrendView] = useState<CardView>("trend");
  const history = model.result.status !== "available" ? model.result.history : undefined;
  const chartModel = history ? { ...model, result: history } : model;
  const trendDates = chartModel.result.status === "available" ? chartModel.result.trend.current.map(point => point.actualDate) : [];
  const range = useTrendRange(trendDates);
  const visibleModel = chartModel.result.status === "available" && (range.start !== 0 || range.end !== trendDates.length - 1) ? { ...chartModel, result: { ...chartModel.result, trend: { current: chartModel.result.trend.current.slice(range.start, range.end + 1), comparison: chartModel.result.trend.comparison?.slice(range.start, range.end + 1) ?? null } } } : chartModel;
  const presentation = dashboardMetricStatusPresentation(model);
  const unavailable = model.result.status !== "available";
  const availableResult = model.result.status === "available" ? model.result : null;
  const reading = model.result.reading;
  const unavailableResult = model.result.status === "available" ? null : model.result;
  const titleId = `dashboard-metric-${useId().replaceAll(":", "")}`;
  const watermarkLabel = availableResult?.watermarkLabel ?? unavailableResult?.watermarkLabel;
  const validationLabel = origin === "demo" ? null : availableResult?.validationLabel ?? unavailableResult?.validationLabel;
  const contextTitle = [validationLabel, watermarkLabel].filter(Boolean).join(" · ");
  const compactWatermark = watermarkLabel
    ?.replace(/^数据完整至\s*/, "数据至 ")
    .replace(/^旧结果完整至\s*/, "旧结果至 ")
    .replace(/(数据至|旧结果至)\s+\d{4}-(\d{2})-(\d{2})/, "$1 $2-$3");
  const headerMeta = [model.metric.aggregationLabel, validationLabel, compactWatermark].filter(Boolean).join(" · ");
  const showFooter = Boolean(availableResult && (
    availableResult.completeness === "partial"
    || availableResult.refresh.status !== "idle"
  ));
  const cardRetryAvailable = Boolean(
    availableResult?.refresh.status === "failed"
    && availableResult.refresh.source === "card"
    && availableResult.refresh.retryable
    && onRetry
  );
  const canBreakDown = requestedVariant === "value" && Boolean(onOpenBreakdown);
  return <article className={`dashboard-metric-card ui-chart-surface${variant === "detailed" ? " is-detailed" : variant === "value" ? " is-value" : ""}${modeValue ? " is-mode-value" : ""}${canBreakDown ? " has-breakdown" : ""}${availableResult?.comparison ? " has-comparison" : ""}${reading ? " has-daily-reading" : ""}${showFooter ? " has-footer" : ""} is-${model.result.status}${model.result.status === "available" ? ` is-${model.result.completeness} is-refresh-${model.result.refresh.status}` : ""}`} aria-labelledby={titleId}
    onClick={event => { if (canBreakDown && !(event.target as HTMLElement).closest("a,button,input,select,summary")) { event.currentTarget.querySelector<HTMLButtonElement>(".dashboard-metric-card__title-button")?.focus(); onOpenBreakdown?.(model); } }}>
    <header>
      <div>
        {canBreakDown ? <button id={titleId} type="button" className="dashboard-metric-card__title-button" aria-label={`${model.metric.name}，按${breakdownDimensions ?? "可用维度"}拆解`} onClick={() => onOpenBreakdown?.(model)}>{model.metric.name}</button> : <FloatingHint content={model.metric.definitionLabel}><ProductLink id={titleId} href={analysisHref} onClick={(event) => { if (onOpenAnalysis) { event.preventDefault(); onOpenAnalysis(model); } }}>{model.metric.name}</ProductLink></FloatingHint>}
        <DataOriginBadge /><p title={headerMeta || contextTitle || undefined}>{headerMeta}</p>
      </div>
      <div className="dashboard-metric-card__tools">
        {compactDetails && (availableResult || history) && <FloatingHint content="查看完整趋势"><button type="button" className="ui-icon-button" aria-label={`查看${model.metric.name}完整趋势`} onClick={() => setFullTrendOpen(true)}><Maximize2 aria-hidden="true" /></button></FloatingHint>}
        {variant === "detailed" && (availableResult || history) && <CardViewSwitch value={view} onChange={setView} label={model.metric.name} />}
        <FloatingHint content={model.metric.definitionLabel}><button type="button" className="dashboard-metric-card__hint" aria-label={`查看${model.metric.name}说明`} onClick={() => onOpenDefinition(model)}><Info aria-hidden="true" /></button></FloatingHint>
      </div>
    </header>
    {unavailable ? <div className="dashboard-metric-card__unavailable">
      <span>{model.result.status === "failed" ? <CircleAlert aria-hidden="true" /> : model.result.status === "loading" ? <LoadingIndicator /> : <Info aria-hidden="true" />}</span>
      <div><b>{presentation.label}</b><p>{presentation.description}</p></div>
      {model.result.status === "failed" && model.result.retryable && onRetry && <button type="button" onClick={() => onRetry(model)}>重试此卡</button>}
    </div> : availableResult ? <>
      {reading ? <MetricSummary horizontal context={<MetricReadingContext reading={reading} />} value={availableResult.value.display} unit={availableResult.value.unit}
        numberClassName="dashboard-metric-card__value" comparisonClassName="dashboard-metric-card__comparison" comparisons={reading.comparisons}
        supplementary={reading.statistics.length ? <MetricPeriodStatistics items={reading.statistics} /> : undefined} />
        : <div className="dashboard-metric-card__value"><strong>{availableResult.value.display}</strong><span>{availableResult.value.unit}</span></div>}
      {!reading && availableResult.comparison && <FloatingHint className="dashboard-metric-card__comparison ui-metric-comparison" content={<ComparisonDetails comparison={availableResult.comparison} />}>
        <button type="button" aria-label={`查看${model.metric.name}对比${availableResult.comparison.status === "available" ? "详情" : "不可用原因"}`} onClick={() => onOpenComparison(model)}>
          <span>{availableResult.comparison.label}</span>
          {availableResult.comparison.status === "available" && <ChangeValue direction={availableResult.comparison.direction}>{availableResult.comparison.display}</ChangeValue>}
          <Info aria-hidden="true" />
        </button>
      </FloatingHint>}
      {note && <p className="dashboard-metric-card__note">{note}</p>}
      {(availableResult.calculation || (requestedVariant !== "value" && (availableResult.value.unit === "%" || availableResult.value.unit.includes("/人")))) && <CalculationEvidence basis={availableResult.calculation ?? missingCalculation(model.metric.definitionLabel, model.metric.aggregationLabel, availableResult.value.display, availableResult.value.unit === "%")} compact />}
      {variant === "detailed" || modeValue ? <DetailedMetricTrend model={model} view={view} summaryOnly={modeValue} exportAction={tableExport ?? <Button disabled title="该指标的独立导出尚未接入，请使用看板完整导出。">导出未接入</Button>} onOpenPoint={(point, period) => onOpenTrendPoint(model, point, period)} /> : variant !== "value" ? <><DashboardMiniTrend model={visibleModel} onOpenTrendPoint={(_, point, series) => onOpenTrendPoint(model, point, series)} /><TrendRange values={model.result.status === "available" ? model.result.trend.current.map(point => point.value?.raw ?? null) : []} dates={trendDates} {...range} onChange={range.setRange} /></> : null}
    </> : null}
    {unavailable && reading && <div className="dashboard-metric-card__unavailable-reading"><MetricReadingContext reading={reading} />
      {reading.comparisons.length > 0 && <MetricSummary value="—" comparisons={reading.comparisons} size="supporting" />}
      {reading.statistics.length > 0 && <MetricPeriodStatistics items={reading.statistics} />}
    </div>}
    {history && (variant === "detailed" || modeValue ? <DetailedMetricTrend model={chartModel} view={view} summaryOnly={modeValue} exportAction={tableExport ?? <></>} onOpenPoint={(point, period) => onOpenTrendPoint(model, point, period)} /> : variant !== "value" ? <><DashboardMiniTrend model={visibleModel} onOpenTrendPoint={(_, point, period) => onOpenTrendPoint(model, point, period)} /><TrendRange values={history.trend.current.map(point => point.value?.raw ?? null)} dates={trendDates} {...range} onChange={range.setRange} /></> : null)}
    {compactDetails && variant === "compact" && tableExport && (availableResult || history) && <DetailedMetricTrend model={chartModel} summaryOnly exportAction={tableExport} onOpenPoint={(point, period) => onOpenTrendPoint(model, point, period)} />}
    {compactDetails && fullTrendOpen && (availableResult || history) && <MetricReadingDialog title={`${model.metric.name} · 完整趋势`} onClose={() => setFullTrendOpen(false)} content={<><p>{model.metric.aggregationLabel}</p><CardViewSwitch value={fullTrendView} onChange={setFullTrendView} label={model.metric.name} /><DetailedMetricTrend model={chartModel} view={fullTrendView} exportAction={tableExport ?? <Button disabled>导出未接入</Button>} onOpenPoint={(point, period) => onOpenTrendPoint(model, point, period)} /></>} />}
    {canBreakDown && <p className="dashboard-metric-card__dimensions">{breakdownDimensions}</p>}
    {showFooter && <footer>
      <span className={`ui-status ui-status--${presentation.tone}`}>{presentation.label}</span>
      <div className="dashboard-metric-card__footer-meta">
        {cardRetryAvailable && <button type="button" onClick={() => onRetry?.(model)}>重试此卡</button>}
        <span>{presentation.description}</span>
      </div>
    </footer>}
  </article>;
}
