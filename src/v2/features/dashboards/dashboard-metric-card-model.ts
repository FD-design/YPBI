import type { ChangeDirection } from "../../../components/ui/change-presentation.ts";
import type { CalculationBasis } from "./CalculationEvidence";

export type DashboardMetricDirection = ChangeDirection;

export interface DashboardMetricIdentity {
  id: string;
  name: string;
  aggregationLabel: string;
  definitionLabel: string;
}

export interface DashboardMetricTrendValue {
  raw: number;
  display: string;
  actualDate: string;
}

export interface DashboardMetricTrendPoint {
  calculation?: CalculationBasis;
  key: string;
  label: string;
  actualDate: string;
  value: DashboardMetricTrendValue | null;
  counterpart: DashboardMetricTrendValue | null;
  differenceDisplay: string | null;
  state: "available" | "no_record" | "no_value" | "not_produced" | "immature";
  stateLabel: string;
}

export interface DashboardMetricTrendSeries {
  current: DashboardMetricTrendPoint[];
  comparison: DashboardMetricTrendPoint[] | null;
}

export interface DashboardMetricAvailableComparison {
  status: "available";
  label: string;
  display: string;
  detail: string;
  notice?: string;
  direction: DashboardMetricDirection | null;
  kind: "relative_change" | "percentage_point" | "absolute";
  rows?: { label: string; date: string; value: string }[];
  difference?: { display: string; direction: DashboardMetricDirection | null };
}

export interface DashboardMetricUnavailableComparison {
  status: "unavailable";
  label: string;
  detail: string;
}

export type DashboardMetricComparison = DashboardMetricAvailableComparison | DashboardMetricUnavailableComparison;

/** Card-only reading metadata. It does not replace the original interval trend. */
export interface DashboardMetricReading {
  primaryLabel: string;
  primaryDate?: string;
  comparisons: DashboardMetricComparison[];
  statistics: { label: string; display: string; unit?: string; detail: string }[];
  trendComparisonLabel?: string;
}

export type DashboardMetricRefresh =
  | { status: "idle" }
  | { status: "refreshing"; source: "page" | "card" }
  | { status: "failed"; source: "page" | "card"; message: string; retryable: boolean };

export interface DashboardMetricAvailableResult {
  reading?: DashboardMetricReading;
  calculation?: CalculationBasis;
  status: "available";
  completeness: "complete" | "partial" | "unknown";
  refresh: DashboardMetricRefresh;
  value: {
    raw: number;
    display: string;
    unit: string;
  };
  comparison: DashboardMetricComparison | null;
  trendKind: "line" | "bar";
  trend: DashboardMetricTrendSeries;
  validationLabel: string;
  watermarkLabel: string;
  watermarkDateTime?: string;
}

export type DashboardMetricUnavailableStatus =
  | "loading"
  | "no_records"
  | "no_values"
  | "not_produced"
  | "immature"
  | "failed"
  | "not_ready"
  | "unsupported";

export interface DashboardMetricUnavailableResult {
  reading?: DashboardMetricReading;
  history?: DashboardMetricAvailableResult;
  status: DashboardMetricUnavailableStatus;
  contextLabel: string;
  retryable: boolean;
  label?: string;
  message?: string;
  validationLabel?: string;
  watermarkLabel?: string;
  watermarkDateTime?: string;
}

export interface DashboardMetricCardModel {
  metric: DashboardMetricIdentity;
  result: DashboardMetricAvailableResult | DashboardMetricUnavailableResult;
}

export interface DashboardMetricStatusPresentation {
  label: string;
  description: string;
  tone: "success" | "warning" | "loading" | "neutral";
}

const UNAVAILABLE_PRESENTATION: Record<DashboardMetricUnavailableStatus, DashboardMetricStatusPresentation> = {
  loading: {
    label: "正在加载",
    description: "只加载本卡；其他已完成结果保持可用。",
    tone: "loading"
  },
  no_records: {
    label: "当前范围无记录",
    description: "查询成功，但没有业务记录；不会补成 0。",
    tone: "neutral"
  },
  no_values: {
    label: "有记录但无可用值",
    description: "来源返回了记录，但指标值为空；不会补成 0。",
    tone: "neutral"
  },
  not_produced: {
    label: "当前数据尚未产出",
    description: "保留实际查询范围，数据产出后再返回结果。",
    tone: "neutral"
  },
  immature: {
    label: "等待数据成熟",
    description: "实际数据日保持可见；成熟后再返回结果。",
    tone: "neutral"
  },
  failed: {
    label: "单卡查询失败",
    description: "其他卡片继续展示；本卡可以独立重试。",
    tone: "warning"
  },
  not_ready: {
    label: "尚未完成数据准入",
    description: "映射、验数或可信数据水位尚未全部就绪。",
    tone: "neutral"
  },
  unsupported: {
    label: "当前能力不支持",
    description: "该指标或当前筛选尚未通过正式数据准入。",
    tone: "neutral"
  }
};

export function dashboardMetricStatusPresentation(model: DashboardMetricCardModel): DashboardMetricStatusPresentation {
  if (model.result.status !== "available") {
    const presentation = UNAVAILABLE_PRESENTATION[model.result.status];
    return {
      ...presentation,
      ...(model.result.label ? { label: model.result.label } : {}),
      ...(model.result.message ? { description: model.result.message } : {})
    };
  }
  if (model.result.refresh.status === "failed") {
    return {
      label: model.result.completeness === "partial" ? "刷新失败，保留部分旧值" : "刷新失败，保留旧值",
      description: model.result.refresh.message || "当前展示的是上次成功结果，不冒充本次刷新成功。",
      tone: "warning"
    };
  }
  if (model.result.refresh.status === "refreshing") {
    return {
      label: model.result.completeness === "partial" ? "正在刷新部分数据" : "正在刷新",
      description: "旧结果保持可读，刷新完成后再整体替换本卡结果。",
      tone: "loading"
    };
  }
  if (model.result.completeness === "partial") {
    return { label: "部分数据", description: "当前结果只覆盖部分已确认范围。", tone: "warning" };
  }
  if (model.result.value.raw === 0) {
    return { label: "真实 0", description: "来源明确返回有效数值 0。", tone: "success" };
  }
  if (model.result.completeness === "unknown") return { label: "待验数", description: "真实后台结果；上游未返回完整性标记。", tone: "neutral" };
  return { label: "完整", description: "当前查询范围完整且已通过数据准入。", tone: "success" };
}

export function dashboardTrendDomain(series: DashboardMetricTrendSeries, anchorZero = false) {
  const values = [...series.current, ...(series.comparison ?? [])].map((point) => point.value?.raw)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (!values.length) return null;
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const min = anchorZero ? Math.min(0, rawMin) : rawMin;
  const max = anchorZero ? Math.max(0, rawMax) : rawMax;
  if (max !== min) return { min, max, spread: max - min };
  if (max === 0) return { min: 0, max: 1, spread: 1 };
  const padding = Math.max(Math.abs(max) * 0.05, 1e-9);
  return { min: min - padding, max: max + padding, spread: padding * 2 };
}

export function dashboardTrendPath(
  points: DashboardMetricTrendPoint[],
  domain: { min: number; spread: number }
) {
  let drawing = false;
  return points.map((point, index) => {
    const value = point.value?.raw;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      drawing = false;
      return "";
    }
    const x = points.length === 1 ? 120 : 8 + index * (224 / (points.length - 1));
    const y = 50 - ((value - domain.min) / domain.spread) * 40;
    const command = drawing ? "L" : "M";
    drawing = true;
    return `${command}${x.toFixed(1)},${y.toFixed(1)}`;
  }).filter(Boolean).join(" ");
}
