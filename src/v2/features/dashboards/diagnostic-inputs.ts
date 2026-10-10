import type { DailyDashboardSuccess } from "../../../../contracts/daily-dashboard";

type Series = DailyDashboardSuccess["data"]["series"][number];
type Point = Series["points"][number];
type RatioMetric = { id: string; unit: string; inputs: readonly { key: string }[] };
export const DIAGNOSTIC_INPUTS_LABEL = "来源不完整，仅供核对";
export const isRegistrationRetentionMetric = (id: string) => /^M02[0-3](?:\.(?:android|ios|natural|internal))?$/.test(id);

/** Diagnostic inputs never make a result readable or enter a derived metric. */
export function diagnosticRatioInputs(metric: RatioMetric, point: Point | undefined) {
  if (!point || metric.unit !== "%" || metric.inputs.length !== 2 || point.inputs.length !== 2
    || point.sourceStatus !== "SOURCE_INCOMPLETE" || point.state !== "no_value" || point.value !== null
    || point.inputs[0].key === point.inputs[1].key || point.inputs.some((input, index) => input.key !== metric.inputs[index].key)) return null;
  const [numerator, denominator] = point.inputs.map(input => input.value);
  return numerator !== null && denominator !== null && Number.isSafeInteger(numerator) && Number.isSafeInteger(denominator)
    && numerator >= 0 && denominator >= 0 && (!isRegistrationRetentionMetric(metric.id) || numerator <= denominator)
    ? { numerator, denominator } : null;
}

/** Preserve legacy/READY behavior; non-READY results remain unavailable. */
export function safeDiagnosticSeries<T extends Series>(series: T): T {
  return { ...series, points: series.points.map(point => !point.sourceStatus || point.sourceStatus === "READY" ? point : {
    ...point, value: null, inputs: diagnosticRatioInputs(series.metric, point) ? point.inputs : point.inputs.map(input => ({ ...input, value: null })),
    state: point.sourceStatus === "FAILED" ? "source_failure" : point.sourceStatus === "NOT_MATURE" ? "immature" : "no_value"
  }) };
}
