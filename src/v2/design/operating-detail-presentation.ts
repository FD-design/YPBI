import { changeDirection } from "../../components/ui/change-presentation.ts";
import { metricNumberFormatOptions } from "../../components/metric-number-format";

export type DetailValueKind = "count" | "events" | "average" | "duration" | "currency" | "ratio" | "platformRatio";

export function formatDetailValue(value: number | null, kind: DetailValueKind, includeUnit = true, unit?: string) {
  if (value === null || !Number.isFinite(value)) return "—";
  if (kind === "ratio") return `${(value * 100).toFixed(2)}%`;
  if (kind === "platformRatio") return `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })} : 1`;
  if (kind === "currency") {
    const dollar = unit?.startsWith("USD") || unit === undefined;
    return `${dollar ? "$" : ""}${value.toLocaleString("en-US", metricNumberFormatOptions(value, unit ?? "USD"))}${includeUnit ? dollar ? unit?.endsWith("/人") ? "/人" : "" : " " + unit : ""}`;
  }
  const precision = kind === "duration" && value !== 0 && Math.abs(value) < 1
    ? { maximumSignificantDigits: 4 }
    : kind === "average" ? metricNumberFormatOptions(value, unit ?? "次/人")
      : { maximumFractionDigits: kind === "duration" ? 2 : 0 };
  const number = value.toLocaleString("en-US", precision);
  return includeUnit ? `${number} ${unit ?? (kind === "duration" ? "小时" : kind === "events" ? "次" : kind === "average" ? "次/人" : "人")}` : number;
}

/** DEV snapshots only. Production comparisons must come from the validated query. */
export function detailChange(current: number | null, baseline: number | null, kind: DetailValueKind) {
  if (kind === "platformRatio") return null;
  if (current === null || baseline === null || !Number.isFinite(current) || !Number.isFinite(baseline)) return null;
  const difference = kind === "ratio" ? (current - baseline) * 100 : baseline === 0 ? null : ((current - baseline) / baseline) * 100;
  if (difference === null || !Number.isFinite(difference)) return null;
  const direction = changeDirection(difference);
  const arrow = direction === "up" ? "↑" : direction === "down" ? "↓" : "—";
  return { direction, display: `${arrow} ${Math.abs(difference).toFixed(kind === "ratio" ? 2 : 1)}${kind === "ratio" ? " 个百分点" : "%"}` };
}
