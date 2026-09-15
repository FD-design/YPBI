export function retentionMatrixScale(values: (number | null)[], mode: "rate" | "count") {
  const valid = values.filter((value): value is number => value !== null && Number.isFinite(value) && value >= 0);
  const max = mode === "rate" ? 1 : valid.length ? Math.max(...valid) : 0;
  return { max, empty: valid.length === 0, single: valid.length > 0 && valid.every(value => value === valid[0]) ? valid[0] : null,
    intensity: (value: number | null) => value === null || !Number.isFinite(value) || value < 0 ? null : max === 0 ? 0 : Math.min(1, value / max) };
}
