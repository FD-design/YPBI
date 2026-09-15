import { shiftDate } from "../../components/ui/date-range-model";
import { dailyMetricReading } from "../features/dashboards/daily-reading-model";
import type { CalculationBasis } from "../features/dashboards/CalculationEvidence";
import type { DashboardMetricCardModel, DashboardMetricTrendPoint } from "../features/dashboards/dashboard-metric-card-model";
import { demoMetric } from "./extended-board-model";
import { paymentBusinessAggregate, paymentDates, paymentWays, type PaymentRange } from "./payment-observations";

export const PAYMENT_BUSINESS_METRICS = [
  { id: "M113", name: "拉单人数", unit: "人" },
  { id: "M112", name: "拉单次数", unit: "次" },
  { id: "M060", name: "充值成功次数", unit: "次" },
  { id: "M114", name: "充值成功率", unit: "%" },
  { id: "M059", name: "充值人数", unit: "人" },
  { id: "M061", name: "活跃用户付费率", unit: "%" },
  { id: "M058", name: "充值金额", unit: "USD" },
  { id: "M087", name: "活跃用户人均充值金额（ARPU）", unit: "USD/人" },
  { id: "M067", name: "付费用户人均充值金额（ARPPU）", unit: "USD/人" }
] as const;

export const PAYMENT_DAILY_FORMULA = "同日充值成功次数 ÷ 同日拉单次数 × 100%";

export function paymentBusinessDisplay(id: string, value: number) {
  const metric = PAYMENT_BUSINESS_METRICS.find(item => item.id === id)!;
  return (metric.unit === "%" ? value * 100 : value).toLocaleString("zh-CN", {
    maximumFractionDigits: metric.unit === "人" || metric.unit === "次" ? 0 : 2,
    minimumFractionDigits: metric.unit === "%" || metric.unit.startsWith("USD") ? 2 : 0
  });
}

export function paymentBusinessBasis(id: string, range: PaymentRange, way = "all", snapshot?: ReturnType<typeof paymentBusinessAggregate>): CalculationBasis | undefined {
  const row = snapshot ?? paymentBusinessAggregate(range, way), inputs = row.inputs;
  const input = (name: string, value: number, unit: string) => ({ name, value, unit });
  const pairs: Record<string, [CalculationBasis["numerator"], CalculationBasis["denominator"]]> = {
    M114: [input("充值成功次数", inputs.successes, "次"), input("拉单次数", inputs.requests, "次")],
    M061: [input("充值人数", inputs.paidUsers, "人"), input("活跃用户数", inputs.activeUsers, "人")],
    M087: [input("充值金额", inputs.amount, "USD"), input("活跃用户数", inputs.activeUsers, "人")],
    M067: [input("充值金额", inputs.amount, "USD"), input("充值人数", inputs.paidUsers, "人")]
  };
  if (!pairs[id]) return undefined;
  const [numerator, denominator] = pairs[id], metric = PAYMENT_BUSINESS_METRICS.find(item => item.id === id)!;
  return {
    numerator,
    denominator,
    percentage: metric.unit === "%",
    formula: id === "M114" ? PAYMENT_DAILY_FORMULA : numerator.name + " ÷ " + denominator.name + (metric.unit === "%" ? " × 100%" : ""),
    scope: `${range.start} 至 ${range.end} · ${paymentWays.find(item => item.id === way)?.label} · 演示数据；活跃基数使用同范围全站去重人数`,
    result: `${paymentBusinessDisplay(id, row.values[id])} ${metric.unit}`
  };
}

function previousRange(range: PaymentRange): PaymentRange {
  const days = paymentDates(range).length;
  return { start: shiftDate(range.start, -days), end: shiftDate(range.start, -1) };
}

function difference(id: string, current: number, prior: number) {
  const metric = PAYMENT_BUSINESS_METRICS.find(item => item.id === id)!;
  const delta = current - prior;
  const display = paymentBusinessDisplay(id, Math.abs(delta));
  return `${delta > 0 ? "+" : delta < 0 ? "-" : ""}${display}${metric.unit === "%" ? " 个百分点" : ` ${metric.unit}`}`;
}

function paymentPoint(id: string, date: string, way: string, counterpartDate: string | null): DashboardMetricTrendPoint {
  const current = paymentBusinessAggregate({ start: date, end: date }, way).values[id];
  const prior = counterpartDate ? paymentBusinessAggregate({ start: counterpartDate, end: counterpartDate }, way).values[id] : null;
  return {
    key: date,
    label: date.slice(5),
    actualDate: date,
    value: { raw: current, display: paymentBusinessDisplay(id, current), actualDate: date },
    counterpart: prior === null || counterpartDate === null ? null : { raw: prior, display: paymentBusinessDisplay(id, prior), actualDate: counterpartDate },
    differenceDisplay: prior === null ? null : difference(id, current, prior),
    state: "available",
    stateLabel: "完整",
    calculation: paymentBusinessBasis(id, { start: date, end: date }, way)
  };
}

/** DEV-only projection. Current value, references, trend and export all read the same payment observations. */
export function paymentBusinessMetricModel(id: string, range: PaymentRange, way = "all", compared = false): DashboardMetricCardModel {
  const metric = PAYMENT_BUSINESS_METRICS.find(item => item.id === id);
  if (!metric) throw new Error(`Unknown payment business metric ${id}`);
  const dates = paymentDates(range), before = previousRange(range), beforeDates = paymentDates(before);
  const period = paymentBusinessAggregate(range, way);
  const current = dates.map((date, index) => paymentPoint(id, date, way, compared ? beforeDates[index] : null));
  const comparison = compared ? beforeDates.map((date, index) => {
    const point = paymentPoint(id, date, way, dates[index]);
    const pairedCurrent = current[index].value?.raw;
    return {
      ...point,
      key: `comparison-${date}`,
      differenceDisplay: pairedCurrent == null || point.value == null ? null : difference(id, pairedCurrent, point.value.raw)
    };
  }) : null;
  const model: DashboardMetricCardModel = {
    metric: {
      id,
      name: metric.name,
      definitionLabel: demoMetric(id).definition,
      aggregationLabel: `${range.start} 至 ${range.end} · ${paymentWays.find(item => item.id === way)?.label} · 支付业务日`
    },
    result: {
      status: "available",
      completeness: "complete",
      refresh: { status: "idle" },
      value: { raw: period.values[id], display: paymentBusinessDisplay(id, period.values[id]), unit: metric.unit },
      comparison: null,
      calculation: paymentBusinessBasis(id, range, way, period),
      trendKind: "line",
      trend: { current, comparison },
      validationLabel: "演示数据",
      watermarkLabel: `数据至 ${range.end}`
    }
  };
  return dailyMetricReading(model, {
    date: range.end,
    compared,
    read: date => {
      const snapshot = paymentBusinessAggregate({ start: date, end: date }, way), value = snapshot.values[id];
      return {
        date,
        value,
        display: paymentBusinessDisplay(id, value),
        calculation: paymentBusinessBasis(id, { start: date, end: date }, way, snapshot)
      };
    }
  });
}

export function paymentBusinessMetricModels(range: PaymentRange, way = "all", compared = false) {
  return PAYMENT_BUSINESS_METRICS.map(metric => paymentBusinessMetricModel(metric.id, range, way, compared));
}
