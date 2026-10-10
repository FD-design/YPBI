/** Numeric precision only; callers retain their locale, scale and unit layout. */
export function metricNumberFormatOptions(value: number, unit: string): Intl.NumberFormatOptions {
  return {
    maximumFractionDigits: ["人", "次"].includes(unit) ? 0 : unit.includes("/人") && Math.abs(value) > 0 && Math.abs(value) < .1 ? 4 : 2,
    minimumFractionDigits: unit === "%" ? 2 : 0
  };
}
