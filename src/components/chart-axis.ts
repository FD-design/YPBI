/** One readable step policy for both compact and full value axes. */
export function chartAxisScale(min: number, max: number, minInterval = 0) {
  const span = max - min;
  if (!Number.isFinite(span) || span <= 0) throw new RangeError("Axis extent must be finite and increasing");
  const nextStep = (value: number) => {
    const magnitude = 10 ** Math.floor(Math.log10(value));
    const normalized = value / magnitude;
    return [1, 2, 5, 10].find(step => step >= normalized - 1e-12)! * magnitude;
  };
  let interval = nextStep(Math.max(minInterval, span / 4));
  const extent = () => {
    // Round quotients before floor/ceil so floating-point noise cannot add an extra tick.
    const lower = Math.floor(Number((min / interval).toPrecision(14)));
    const upper = Math.ceil(Number((max / interval).toPrecision(14)));
    return { lower, upper };
  };
  let bounds = extent();
  while (bounds.upper - bounds.lower > 4) {
    interval = nextStep(interval * 1.01);
    bounds = extent();
  }
  const ticks = Array.from({ length: bounds.upper - bounds.lower + 1 }, (_, index) =>
    Number(((bounds.lower + index) * interval).toPrecision(14)));
  return { min: ticks[0], max: ticks[ticks.length - 1], spread: ticks[ticks.length - 1] - ticks[0], interval, ticks };
}

export function chartValueExtent(values: (number | null)[], includeZero = false, minInterval = 0) {
  const finite = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (!finite.length) return null;
  let min = Math.min(...finite), max = Math.max(...finite);
  if (includeZero) { min = Math.min(0, min); max = Math.max(0, max); }
  if (min === max) { const padding = Math.max(Math.abs(min) * .05, minInterval, min === 0 ? 1 : 0); min -= padding; max += padding; if (finite.every(value => value >= 0)) min = Math.max(0, min); }
  return chartAxisScale(min, max, minInterval);
}

/** Standardize automatic Cartesian axes; explicit bounds, stacks and specialized charts retain their own contracts. */
export function standardChartAxes(option: any) {
  const series = Array.isArray(option.series) ? option.series : option.series ? [option.series] : [];
  const output = { ...option };
  for (const name of ["xAxis", "yAxis"] as const) {
    const source = option[name]; if (!source) continue;
    const axes = Array.isArray(source) ? source : [source];
    const updated = axes.map((axis: any, index: number) => {
      if (axis.type !== "value" || axis.min != null || axis.max != null || axis.interval != null) return axis;
      const associated = series.filter((item: any) => (item[`${name}Index`] ?? 0) === index);
      if (!associated.length || associated.some((item: any) => !["line", "bar"].includes(item.type) || item.stack || !Array.isArray(item.data))) return axis;
      const values = associated.flatMap((item: any) => item.data.map((value: any) => value && typeof value === "object" && !Array.isArray(value) ? value.value : value));
      if (values.some((value: any) => value != null && typeof value !== "number")) return axis;
      const extent = chartValueExtent(values, associated.some((item: any) => item.type === "bar") || !axis.scale, axis.minInterval ?? 0);
      return extent ? { ...axis, min: extent.min, max: extent.max, interval: extent.interval } : axis;
    });
    output[name] = Array.isArray(source) ? updated : updated[0];
  }
  return output;
}

/** Axis labels use a single scale and retain enough precision to distinguish ticks. */
export function chartAxisLabels(values: number[], scale = 1, suffix = "") {
  const scaled = values.map(value => value * scale);
  let precision = suffix === "%" ? 1 : 0;
  const format = () => scaled.map(value => value.toLocaleString("en-US", { maximumFractionDigits: precision }) + suffix);
  while (precision < 12 && new Set(format()).size < new Set(scaled).size) precision += 1;
  return format();
}
