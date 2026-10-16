import { z } from "zod";

/** Inclusive statistical cutoff and calendar-month closure; processing readiness is dataStatus. */
export const monthlyMetricMetadataSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/).refine(value => z.iso.date().safeParse(`${value}-01`).success, "月活所属月份无效").optional(),
  cutoffDate: z.iso.date().optional(),
  isComplete: z.boolean().optional()
}).strict().superRefine((metadata, ctx) => {
  if (Object.values(metadata).every(value => value === undefined)) {
    ctx.addIssue({ code: "custom", message: "月活来源元数据不能为空" });
  }
  if (metadata.month && metadata.cutoffDate && metadata.cutoffDate.slice(0, 7) !== metadata.month) {
    ctx.addIssue({ code: "custom", path: ["cutoffDate"], message: "月活所属月份与统计截止日不一致" });
  }
});
export type MonthlyMetricMetadata = z.infer<typeof monthlyMetricMetadataSchema>;

/** Internal query bounds shared by the monthly adapter and its readers, not data watermarks. */
export interface MonthlyQueryScope {
  month: string;
  anchor: string;
  monthStart: string;
  monthEnd: string;
  queryStart: string | null;
  queryEnd: string | null;
}

const shiftDay = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
function nextMonth(monthStart: string) {
  const date = new Date(`${monthStart}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date.toISOString().slice(0, 10);
}

/** Dates are validated business dates; end bounds are inclusive. */
export function monthlyQueryScopes(startDate: string, endDate: string, today: string): MonthlyQueryScope[] {
  const yesterday = shiftDay(today, -1);
  const scopes: MonthlyQueryScope[] = [];
  for (let monthStart = `${startDate.slice(0, 7)}-01`; monthStart <= endDate; monthStart = nextMonth(monthStart)) {
    const monthEnd = shiftDay(nextMonth(monthStart), -1);
    const queryEnd = monthEnd < yesterday ? monthEnd : yesterday;
    const selectedStart = startDate > monthStart ? startDate : monthStart;
    const queried = queryEnd >= selectedStart;
    scopes.push({ month: monthStart.slice(0, 7), anchor: endDate < monthEnd ? endDate : monthEnd, monthStart, monthEnd,
      queryStart: queried ? monthStart : null, queryEnd: queried ? queryEnd : null });
  }
  return scopes;
}
