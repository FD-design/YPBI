export interface DateRangeValue { start: string; end: string }
export interface DateRangeLimits { today: string; maxDate: string; minDate?: string; maxDays?: number; launchDate?: string }
export function shiftDate(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10);
}
export function shiftMonth(value: string, months: number) {
  const date = new Date(`${value.slice(0, 7)}-01T00:00:00Z`); date.setUTCMonth(date.getUTCMonth() + months); return date.toISOString().slice(0, 10);
}
export function isDate(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function rangeError(value: DateRangeValue, limits: DateRangeLimits) {
  if (!isDate(value.start) || !isDate(value.end)) return "请填写有效的开始和结束日期";
  if (value.start > value.end) return "开始日期不能晚于结束日期";
  if (limits.minDate && value.start < limits.minDate) return `最早可查询 ${limits.minDate}`;
  if (value.end > limits.maxDate) return `可查询数据截至 ${limits.maxDate}`;
  const days = (Date.parse(value.end) - Date.parse(value.start)) / 86400000 + 1;
  if (limits.maxDays && days > limits.maxDays) return `单次最多查询 ${limits.maxDays} 天`;
  return null;
}
export function quickDateRanges(limits: DateRangeLimits) {
  const { today, maxDate } = limits;
  const monday = shiftDate(today, -(new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7);
  const month = `${today.slice(0, 7)}-01`, year = `${today.slice(0, 4)}-01-01`;
  const end = today < maxDate ? today : maxDate;
  const entries = [
    { label: "今天", start: today, end: today }, { label: "昨天", start: shiftDate(today, -1), end: shiftDate(today, -1) },
    { label: "本周", start: monday, end }, { label: "上周", start: shiftDate(monday, -7), end: shiftDate(monday, -1) },
    { label: "本月", start: month, end }, { label: "上月", start: shiftMonth(month, -1), end: shiftDate(month, -1) },
    { label: "本年", start: year, end }, { label: "去年", start: shiftMonth(year, -12), end: shiftDate(year, -1) },
    ...[7, 14, 30, 60, 90, 180].map((days) => ({ label: `过去 ${days} 天`, start: shiftDate(maxDate, 1 - days), end: maxDate })),
    ...(limits.launchDate ? [{ label: "上线至今", start: limits.launchDate, end: maxDate }] : [])
  ];
  return entries.map((entry) => ({ ...entry, reason: entry.start > entry.end ? "当前周期暂无可查询日期" : rangeError(entry, limits) }));
}
export function monthCells(month: string) {
  const start = `${month.slice(0, 7)}-01`;
  const offset = (new Date(`${start}T00:00:00Z`).getUTCDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, index) => shiftDate(start, index - offset));
}
