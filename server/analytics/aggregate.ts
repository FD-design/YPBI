import { metrics } from "./registry";

export type NumericRow = object;

function sum(rows: NumericRow[], field: string): number {
  return rows.reduce((total, row) => {
    const value = Reflect.get(row, field) as unknown;
    return total + (typeof value === "number" ? value : 0);
  }, 0);
}

function dailyAverage(rows: NumericRow[], field: string): number | null {
  const dailyTotals = new Map<string, number>();
  rows.forEach((row, index) => {
    const value = Reflect.get(row, field) as unknown;
    if (typeof value !== "number") return;
    const rawDate = Reflect.get(row, "date") as unknown;
    const date = typeof rawDate === "string" && rawDate ? rawDate : `row-${index}`;
    dailyTotals.set(date, (dailyTotals.get(date) ?? 0) + value);
  });
  if (!dailyTotals.size) return null;
  return [...dailyTotals.values()].reduce((total, value) => total + value, 0) / dailyTotals.size;
}

export function aggregateMetric(metricId: string, rows: NumericRow[]): number | null {
  const metric = metrics[metricId];
  if (!metric) throw new Error(`未知指标：${metricId}`);
  if (!rows.length) return null;
  if (metric.aggregation === "latest") {
    const value = Reflect.get(rows.at(-1)!, metricId) as unknown;
    return typeof value === "number" ? value : null;
  }
  if (metric.aggregation === "dailyAverage") return dailyAverage(rows, metricId);
  if (metric.aggregation === "sum") return sum(rows, metricId);
  const numerator = sum(rows, metric.numeratorMetricId!);
  const denominator = sum(rows, metric.denominatorMetricId!);
  return denominator === 0 ? null : numerator / denominator;
}
