import type { DailyDashboardSuccess } from "../../../../contracts/daily-dashboard";

type Series = DailyDashboardSuccess["data"]["series"][number];
type Point = Series["points"][number];
type RatioMetric = { id: string; unit: string; inputs: readonly { key: string; unit?: string }[] };
export const DIAGNOSTIC_INPUTS_LABEL = "来源不完整，仅供核对";
export const RETENTION_REFERENCE_LABEL = "部分数据，仅供参考";
export const isRegistrationRetentionMetric = (id: string) => /^M02[0-3](?:\.(?:android|ios|natural|internal))?$/.test(id);
const retentionReferenceMetricIds = new Set(["M020.android", "M020.ios", "M020.natural", "M020.internal"]);
const partialDerivedMetricIds = new Set(["M087", "M088", "M067", "M067.new", "M098"]);

/** Registered BI-derived results can retain one validated input while their result remains unavailable. */
function partialDerivedInputValues(metric: RatioMetric, point: Point): (number | null)[] | null {
  if (!partialDerivedMetricIds.has(metric.id) || point.value !== null
    || !["no_value", "no_record", "invalid_value", "immature", "source_failure"].includes(point.state)
    || metric.inputs.length !== 2 || point.inputs.length !== 2
    || metric.inputs[0].key === metric.inputs[1].key
    || point.inputs.some((input, index) => input.key !== metric.inputs[index].key)
    || !point.inputs.some(input => input.value === null)) return null;
  const sourceState = point.sourceStatus === "FAILED" ? "source_failure"
    : point.sourceStatus === "NOT_MATURE" ? "immature" : "no_value";
  if (point.sourceStatus && point.sourceStatus !== "READY" && point.state !== sourceState) return null;
  const numeratorUnit = metric.id === "M098" ? "秒" : "元";
  if (metric.unit !== (metric.id === "M098" ? "分钟/人" : "元/人")
    || metric.inputs[0].unit !== numeratorUnit || metric.inputs[1].unit !== "人") return null;
  return point.inputs.map((input, index) => input.value !== null && Number.isFinite(input.value)
    && input.value >= 0 && input.value <= Number.MAX_SAFE_INTEGER
    && (index === 0 || Number.isSafeInteger(input.value)) ? input.value : null);
}

/** Input visibility is separate from formal result readability and reference-ratio admission. */
export function calculationInputValues(metric: RatioMetric, point: Point | undefined): (number | null)[] {
  if (!point) return metric.inputs.map(() => null);
  const readable = (!point.sourceStatus || point.sourceStatus === "READY")
    && (point.state === "available" || point.state === "zero_denominator");
  if (readable || diagnosticRatioInputs(metric, point)) {
    return metric.inputs.map(input => point.inputs.find(value => value.key === input.key)?.value ?? null);
  }
  return partialDerivedInputValues(metric, point) ?? metric.inputs.map(() => null);
}

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
  return { ...series, points: series.points.map(point => {
    if (!point.sourceStatus || point.sourceStatus === "READY") return point;
    const inputs = calculationInputValues(series.metric, point);
    return { ...point, value: null, inputs: point.inputs.map((input, index) => ({ ...input, value: inputs[index] ?? null })),
      state: point.sourceStatus === "FAILED" ? "source_failure" : point.sourceStatus === "NOT_MATURE" ? "immature" : "no_value" };
  }) };
}
