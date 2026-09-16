import { MAX_M016_QUERY_DAYS } from "../../../contracts/bi-v2";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function formatDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function shiftDate(date: string, days: number) {
  return formatDate(new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS));
}

function isCalendarDate(value: string) {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && formatDate(parsed) === value;
}

export function defaultM016DateRange(): [string, string] {
  const shanghaiToday = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
  const end = shiftDate(shanghaiToday, -1);
  return [shiftDate(end, -6), end];
}

export function validateDateRange(start: string, end: string) {
  if (!DATE_PATTERN.test(start) || !DATE_PATTERN.test(end)) return "请选择完整的开始和结束日期";
  if (!isCalendarDate(start) || !isCalendarDate(end)) return "请选择有效的开始和结束日期";
  if (start > end) return "开始日期不能晚于结束日期";
  const days = Math.floor((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS) + 1;
  if (days > MAX_M016_QUERY_DAYS) return `首批日趋势单次最多查询 ${MAX_M016_QUERY_DAYS} 个业务日`;
  return null;
}
