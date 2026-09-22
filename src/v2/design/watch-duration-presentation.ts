/** Unit conversion only: keep the original metric value and denominator unchanged. */
export function readableWatchDuration(value: number, unit: string): string | null {
  const perPerson = unit.endsWith("/人");
  const durationUnit = perPerson ? unit.slice(0, -2) : unit;
  const scale = durationUnit === "分钟" ? 60 : durationUnit === "秒" ? 1 : durationUnit === "小时" ? 3600 : null;
  if (scale === null || !Number.isFinite(value) || value < 0) return null;
  const seconds = Math.round(value * scale);
  if (!Number.isSafeInteger(seconds)) return null;
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), rest = seconds % 60;
  return [hours ? `${hours.toLocaleString("zh-CN")}小时` : "", minutes ? `${minutes}分` : "", rest || (!hours && !minutes) ? `${rest}秒` : ""].filter(Boolean).join(" ") + (perPerson ? "/人" : "");
}
