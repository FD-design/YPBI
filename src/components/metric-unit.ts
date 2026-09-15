/** Omit only units already unambiguously expressed by a named metric. */
export function metricHeadingUnit(name: string, unit: string) {
  if (unit === "人" && /用户|人数|人次/.test(name)) return "";
  if (unit === "次" && /次数/.test(name)) return "";
  if (unit === "单" && /订单数/.test(name)) return "";
  if (unit.includes(":") && name.toLowerCase().includes(unit.toLowerCase())) return "";
  return unit;
}
