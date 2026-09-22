import { ChangeValue } from "../../../components/ui/ChangeValue";
import type { DashboardMetricComparison } from "./dashboard-metric-card-model";

export function ComparisonDetails({ comparison, onEmphasis = true }: { comparison: DashboardMetricComparison; onEmphasis?: boolean }) {
  if (comparison.status !== "available" || !comparison.rows) return <span>{comparison.detail.replaceAll("；", "\n")}</span>;
  return <div className="ui-comparison-details">
    {comparison.rows.map((row) => <div className="ui-comparison-details__row" key={row.label}>
      <span>{row.label}</span><strong>{row.value}</strong><small>{row.date}</small>
    </div>)}
    {comparison.kind !== "percentage_point" && comparison.difference && <div className="ui-comparison-details__change"><span>差值</span><ChangeValue direction={comparison.difference.direction} onEmphasis={onEmphasis}>{comparison.difference.display}</ChangeValue></div>}
    <div className="ui-comparison-details__change"><span>{comparison.kind === "percentage_point" ? "百分点变化" : comparison.kind === "absolute" ? "变化量" : "变化率"}</span><ChangeValue direction={comparison.direction} onEmphasis={onEmphasis}>{comparison.display}</ChangeValue></div>
    {comparison.notice && <small className="ui-comparison-details__notice">{comparison.notice}</small>}
  </div>;
}
