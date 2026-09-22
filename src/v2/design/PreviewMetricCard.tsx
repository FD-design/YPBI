import type { ComponentProps, ReactElement, ReactNode } from "react";
import { DashboardMetricCard } from "../features/dashboards/DashboardMetricCard";
import { ComparisonDetails } from "../features/dashboards/ComparisonDetails";
import { CalculationEvidence } from "../features/dashboards/CalculationEvidence";
import type { DashboardMetricCardModel } from "../features/dashboards/dashboard-metric-card-model";

export type OpenPreviewReading = (title: string, content: ReactNode) => void;
export function PreviewMetricCard({ model, open, retry, compact = false, exportAction }: { model: DashboardMetricCardModel; open: OpenPreviewReading; retry: () => void; compact?: boolean; exportAction: ReactElement }) {
  const ratio = model.result.status === "available" && (model.result.value.unit === "%" || Boolean(model.result.calculation));
  const definition = <><p>{model.metric.definitionLabel}</p>{ratio && model.result.status === "available" && <CalculationEvidence basis={model.result.calculation} />}</>;
  const shared = {
    model, analysisHref: `/analysis/metrics/${model.metric.id}`,
    onOpenAnalysis: () => open(model.metric.name, <>{definition}<p>当前为演示样例。真实指标查询与分析跳转将在数据准入后开放。</p></>),
    onOpenDefinition: () => open(model.metric.name, definition),
    onOpenComparison: () => { if (model.result.status === "available" && model.result.comparison) open(`${model.metric.name} · 对比说明`, <ComparisonDetails comparison={model.result.comparison} onEmphasis={false} />); },
    onOpenTrendPoint: (_model: DashboardMetricCardModel, point: Parameters<NonNullable<ComponentProps<typeof DashboardMetricCard>["onOpenTrendPoint"]>>[1]) => open(`${model.metric.name} · ${point.actualDate}`, <><p>{point.value?.display ?? point.stateLabel}</p>{(ratio || point.calculation) && <CalculationEvidence basis={point.calculation} />}{point.counterpart && <p>对比 {point.counterpart.actualDate} · {point.counterpart.display}</p>}<p>{point.differenceDisplay ? `差值 ${point.differenceDisplay}` : point.stateLabel}</p></>), onRetry: retry
  };
  return compact ? <DashboardMetricCard {...shared} variant="compact" compactDetails tableExport={exportAction} /> : <DashboardMetricCard {...shared} variant="detailed" tableExport={exportAction} />;
}
