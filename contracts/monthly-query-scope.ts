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
