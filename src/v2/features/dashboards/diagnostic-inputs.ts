import type { DailyDashboardSuccess } from "../../../../contracts/daily-dashboard";

type Series = DailyDashboardSuccess["data"]["series"][number];
type Point = Series["points"][number];
type RatioMetric = { id: string; unit: string; inputs: readonly { key: string }[] };
export const DIAGNOSTIC_INPUTS_LABEL = "来源不完整，仅供核对";
export const RETENTION_REFERENCE_LABEL = "部分数据，仅供参考";
export const isRegistrationRetentionMetric = (id: string) => /^M02[0-3](?:\.(?:android|ios|natural|internal))?$/.test(id);
const retentionReferenceMetricIds = new Set(["M020.android", "M020.ios", "M020.natural", "M020.internal"]);

/** Diagnostic inputs never make a formal result readable or enter a formal derived metric. */
export function diagnosticRatioInputs(metric: RatioMetric, point: Point | undefined) {
  if (!point || metric.unit !== "%" || metric.inputs.length !== 2 || point.inputs.length !== 2
    || point.sourceStatus !== "SOURCE_INCOMPLETE" || point.state !== "no_value" || point.value !== null
    || point.inputs[0].key === point.inputs[1].key || point.inputs.some((input, index) => input.key !== metric.inputs[index].key)) return null;
  const [numerator, denominator] = point.inputs.map(input => input.value);
  return numerator !== null && denominator !== null && Number.isSafeInteger(numerator) && Number.isSafeInteger(denominator)
    && numerator >= 0 && denominator >= 0 && (!isRegistrationRetentionMetric(metric.id) || numerator <= denominator)
    ? { numerator, denominator } : null;
}

/** The four D1 groups allow a private reference ratio (1/2 = 0.5); views format the percentage once. */
export function retentionReferenceRatio(metric: RatioMetric, point: Point | undefined) {
  if (!retentionReferenceMetricIds.has(metric.id)) return null;
  const inputs = diagnosticRatioInputs(metric, point);
  return inputs && inputs.denominator > 0
    ? { value: inputs.numerator / inputs.denominator, ...inputs, label: RETENTION_REFERENCE_LABEL }
    : null;
}

/** Preserve legacy/READY formal behavior; reference presentation never changes series readability. */
export function safeDiagnosticSeries<T extends Series>(series: T): T {
  return { ...series, points: series.points.map(point => !point.sourceStatus || point.sourceStatus === "READY" ? point : {
    ...point, value: null, inputs: diagnosticRatioInputs(series.metric, point) ? point.inputs : point.inputs.map(input => ({ ...input, value: null })),
    state: point.sourceStatus === "FAILED" ? "source_failure" : point.sourceStatus === "NOT_MATURE" ? "immature" : "no_value"
  }) };
}
