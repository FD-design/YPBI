/** Numeric precision only; callers retain their locale, scale and unit layout. */
export function metricNumberFormatOptions(value: number, unit: string): Intl.NumberFormatOptions {
  return {
    maximumFractionDigits: ["人", "次"].includes(unit) ? 0 : unit.includes("/人") && Math.abs(value) > 0 && Math.abs(value) < .1 ? 4 : 2,
    minimumFractionDigits: unit === "%" ? 2 : 0
  };
}

const numberFormatters = new Map<string, Intl.NumberFormat>();
const MAX_NUMBER_FORMATTERS = 24;

/** Reuse display configuration only; numeric results and data environments are not cached. */
export function formatMetricNumber(value: number, locale: "en-US" | "zh-CN", options: Intl.NumberFormatOptions): string {
  const key = JSON.stringify([locale, options]);
  let formatter = numberFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, options);
    if (numberFormatters.size === MAX_NUMBER_FORMATTERS) numberFormatters.delete(numberFormatters.keys().next().value!);
    numberFormatters.set(key, formatter);
  }
  return formatter.format(value);
}
