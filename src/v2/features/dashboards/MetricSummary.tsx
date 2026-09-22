import { type ReactNode } from "react";
import { FloatingHint } from "../../../components/ui/FloatingHint";
import { ComparisonDetails } from "./ComparisonDetails";
import { ChangeValue } from "../../../components/ui/ChangeValue";
import type { DashboardMetricComparison, DashboardMetricReading } from "./dashboard-metric-card-model";
import { dailyDateLabel } from "./daily-reading-model";
import "./metric-summary.css";

/** Read-only presentation: values and comparisons are supplied by the query model. */
export function MetricSummary({ title, context, value, unit, comparison, comparisons, note, size = "standard", horizontal = false, supplementary, numberClassName = "", comparisonClassName = "" }: {
  title?: ReactNode;
  context?: ReactNode;
  value: string;
  unit?: string;
  comparison?: DashboardMetricComparison | null;
  comparisons?: readonly DashboardMetricComparison[];
  note?: ReactNode;
  size?: "standard" | "supporting";
  horizontal?: boolean;
  supplementary?: ReactNode;
  numberClassName?: string;
  comparisonClassName?: string;
}) {
  const visibleComparisons = comparisons ?? (comparison ? [comparison] : []);
  return <div className={`metric-summary metric-summary--${size}${horizontal ? " metric-summary--horizontal" : ""}`}>
    <div className="metric-summary__primary">
      {title && <div className="metric-summary__title">{title}</div>}
      {context && <div className="metric-summary__context">{context}</div>}
      <div className={`metric-summary__number ${numberClassName}`}><strong>{value}</strong>{unit && <small>{unit}</small>}</div>
    </div>
    {visibleComparisons.length > 0 && <div className={`metric-summary__comparisons ${comparisonClassName}`}>{visibleComparisons.map((item, index) => <SummaryComparison key={`${item.label}-${index}`} comparison={item} />)}</div>}
    {supplementary && <div className="metric-summary__supplementary">{supplementary}</div>}
    {note && <div className="metric-summary__note">{note}</div>}
  </div>;
}

export function MetricPeriodStatistics({ items }: { items: DashboardMetricReading["statistics"] }) {
  return <>{items.map(item => <FloatingHint key={item.label} content={item.detail} pinOnClick>
    <button type="button" className="metric-summary__statistic" aria-label={`${item.label} ${item.display}${item.unit ?? ""}，查看统计范围`}><span>{item.label}</span><b>{item.display}</b>{item.unit && <span>{item.unit}</span>}</button>
  </FloatingHint>)}</>;
}

export function MetricReadingContext({ reading }: { reading: DashboardMetricReading }) {
  return reading.primaryDate
    ? <time className="metric-summary__date" dateTime={reading.primaryDate} title={reading.primaryDate}>{dailyDateLabel(reading.primaryDate)}</time>
    : <>{reading.primaryLabel}</>;
}

function SummaryComparison({ comparison }: { comparison: DashboardMetricComparison }) {
  return <FloatingHint className="metric-summary__comparison ui-metric-comparison" content={<ComparisonDetails comparison={comparison} />} pinOnClick>
    <button type="button"><span>{comparison.label}</span><ChangeValue direction={comparison.status === "available" ? comparison.direction : null}>{comparison.status === "available" ? comparison.display : "不可比"}</ChangeValue></button>
  </FloatingHint>;
}
