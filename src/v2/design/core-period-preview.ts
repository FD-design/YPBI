import type { DateRangeValue } from "../../components/ui/date-range-model";
import type { DashboardMetricCardModel } from "../features/dashboards/dashboard-metric-card-model";
import { acquisitionCards } from "./acquisition-preview-model";
import { topicCard } from "./topic-preview-fixtures";
import { coreOverviewDesignCardModels, type CoreOverviewDesignMode } from "./core-overview-contract-fixture";
import { DEMO_RANGE, extendedMetricModel, demoRangeLabel } from "./extended-board-model";
import { dailyMetricReading, periodMetricReading } from "../features/dashboards/daily-reading-model";

export function corePeriodMetric(id: string, range: DateRangeValue, compared: boolean): DashboardMetricCardModel {
  if (range.start === DEMO_RANGE.start && range.end === DEMO_RANGE.end) {
    const accepted = coreOverviewDesignCardModels("normal").find(model => model.metric.id === id);
    if (accepted) return withComparison(structuredClone(accepted), compared);
  }
  if (["M001", "M003", "M005", "M006", "M007", "M008"].includes(id)) return acquisitionCards(compared, false, [], range).find(item => item.model.metric.id === id)!.model;
  if (["M016", "M026", "M102", "M081", "M036", "M020", "M035"].includes(id)) {
    const model = topicCard(id, range, compared);
    if (id === "M016" && model.result.status === "available") {
      const result = model.result, current = result.trend.current;
      const raw = current.reduce((sum, point) => sum + point.value!.raw, 0) / current.length;
      const baseline = current.reduce((sum, point) => sum + (point.counterpart?.raw ?? 0), 0) / current.length;
      const delta = raw - baseline;
      result.value = { raw, display: Math.round(raw).toLocaleString(), unit: "人" };
      model.metric.aggregationLabel = `${demoRangeLabel(range)} · 日均活跃用户数`;
      if (result.comparison?.status === "available") result.comparison = { ...result.comparison, display: `${delta > 0 ? "↑" : delta < 0 ? "↓" : "—"} ${Math.abs(delta / baseline * 100).toFixed(1)}%`, direction: delta > 0 ? "up" : delta < 0 ? "down" : "flat", rows: [{ label: "当前期", date: demoRangeLabel(range), value: `${Math.round(raw).toLocaleString()} 人` }, { label: "对比期", date: `${current[0].counterpart!.actualDate} 至 ${current.at(-1)!.counterpart!.actualDate}`, value: `${Math.round(baseline).toLocaleString()} 人` }], difference: { display: `${delta > 0 ? "+" : ""}${Math.round(delta).toLocaleString()} 人`, direction: delta > 0 ? "up" : delta < 0 ? "down" : "flat" } };
    }
    return model;
  }
  return extendedMetricModel(id, range, compared);
}
function withComparison(model: DashboardMetricCardModel, compared: boolean) {
  if (!compared && model.result.status === "available") {
    model.result.comparison = null;
    model.result.trend.comparison = null;
    model.result.trend.current = model.result.trend.current.map(point => ({ ...point, counterpart: null, differenceDisplay: null }));
  }
  return model;
}
export function corePeriodCards(mode: CoreOverviewDesignMode, range: DateRangeValue, compared: boolean) {
  const fixed = coreOverviewDesignCardModels(mode);
  const defaultRange = range.start === DEMO_RANGE.start && range.end === DEMO_RANGE.end;
  return fixed.map(model => {
    const next = defaultRange || (mode === "mixed" && model.result.status !== "available") ? structuredClone(model) : corePeriodMetric(model.metric.id, range, compared);
    return withComparison(next, compared);
  });
}

/** Main KPI reading is independent from period stage and structural projections. */
export function coreDailyCards(mode: CoreOverviewDesignMode, range: DateRangeValue, compared: boolean) {
  return corePeriodCards(mode, range, compared).map(model => {
    const id = model.metric.id;
    if (id === "M020") return periodMetricReading(model, `${demoRangeLabel(range)} · 已成熟注册批次`);
    const result = model.result, days = Math.round((Date.parse(range.end) - Date.parse(range.start)) / 86400000) + 1;
    const statistics: import("../features/dashboards/dashboard-metric-card-model").DashboardMetricReading["statistics"] = [];
    if (result.status === "available" && result.completeness === "complete" && days > 1) {
      const completeDays = result.trend.current.filter(point => point.value !== null);
      const detail = `${demoRangeLabel(range)} · 演示数据`;
      if (completeDays.length === days && ["M016", "M026", "M008", "M102", "M058"].includes(id)) {
        const total = completeDays.reduce((sum, point) => sum + point.value!.raw, 0);
        const display = (value: number) => value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
        if (["M008", "M102", "M058"].includes(id)) statistics.push({ label: "合计", display: display(total), unit: result.value.unit, detail: `${detail} · 按对应业务日累计` });
        statistics.push({ label: "均值", display: display(total / days), unit: result.value.unit, detail: `${detail} · ${days} 个完整业务日均值${["M016", "M026"].includes(id) ? "，不作为区间去重人数" : ""}` });
      }
      if (id === "M059") statistics.push({ label: "区间去重", display: result.value.display, unit: result.value.unit, detail: `${detail} · 独立周期去重结果，不累计日用户数` });
      if (["M081", "M036"].includes(id)) statistics.push({ label: "周期比率", display: result.value.display, unit: result.value.unit, detail: `${detail} · 独立周期结果，不平均日比率` });
    }
    return dailyMetricReading({ ...model, metric: { ...model.metric, aggregationLabel: `${demoRangeLabel(range)} · 业务日` } }, { date: range.end, compared, statistics, read: date => {
      const point = result.status === "available" ? result.trend.current.find(point => point.actualDate === date) ?? result.trend.comparison?.find(point => point.actualDate === date) : undefined;
      if (point) return { date, value: point.value?.raw ?? null, display: point.value?.display ?? "—", reason: point.stateLabel, calculation: point.calculation };
      const day = corePeriodMetric(id, { start: date, end: date }, false).result;
      return { date, value: day.status === "available" ? day.value.raw : null, display: day.status === "available" ? day.value.display : "—", reason: day.status === "available" ? "完整" : day.label, calculation: day.status === "available" ? day.calculation : undefined };
    } });
  });
}
