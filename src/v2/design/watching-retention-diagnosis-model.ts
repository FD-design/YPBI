import type { CohortRow } from "./topic-preview-fixtures";
import type { WorkbookSheet } from "./preview-workbook";

export type WatchingWindow = 1 | 3 | 7;
export const WATCHING_OUTCOMES = ["未回访", "回访未有效观看", "再次有效观看"] as const;
const metrics = { 1: "M040", 3: "M041", 7: "M042" } as const;
export interface WatchingOutcomeRow {
  date: string; base: number; availableAt: string; status: string;
  counts: [number, number, number] | null;
}

/** Isolated demonstration only. Real outcomes require one server-side user cohort;
 * independent daily aggregates must never be substituted into this partition. */
export function demoWatchingOutcomes(rows: CohortRow[], window: WatchingWindow): WatchingOutcomeRow[] {
  return rows.map(row => {
    const cell = row.cells.find(cell => cell.id === metrics[window]);
    if (!cell || cell.status !== "完整" || cell.count === null) return { date: row.date, base: row.base, availableAt: cell?.availableAt ?? "", status: cell?.status ?? "待加工", counts: null };
    if (!Number.isInteger(row.base) || row.base < 0 || !Number.isInteger(cell.count) || cell.count < 0 || cell.count > row.base) throw new Error("Invalid watching cohort counts");
    const remainder = row.base - cell.count;
    const seed = Math.floor(Date.parse(row.date) / 86400000);
    const returnedWithoutWatch = Math.round(remainder * (0.27 + (seed % 5) * 0.02));
    return { date: row.date, base: row.base, availableAt: cell.availableAt, status: cell.status, counts: [remainder - returnedWithoutWatch, returnedWithoutWatch, cell.count] };
  });
}

export function summarizeWatchingOutcomes(rows: WatchingOutcomeRow[]) {
  const complete = rows.filter(row => row.counts !== null);
  const base = complete.reduce((sum, row) => sum + row.base, 0);
  const counts = [0, 1, 2].map(index => complete.reduce((sum, row) => sum + row.counts![index], 0)) as [number, number, number];
  return { base, counts, rates: base > 0 ? counts.map(count => count / base) : null, complete: complete.length, excluded: rows.length - complete.length };
}

export function watchingOutcomesSheet(rows: WatchingOutcomeRow[], window: WatchingWindow, previous?: WatchingOutcomeRow[]): WorkbookSheet {
  const exportRows = (items: WatchingOutcomeRow[], period: string) => items.map(row => [period, row.date, window, row.base, ...(row.counts ?? [null, null, null]), row.counts && row.base > 0 ? row.counts[2] / row.base * 100 : null, row.availableAt, row.status, "演示数据"]);
  return { name: "06_观影后用户去向", rows: [
    ["同一首次有效观看用户批次；完整批次三类互斥且合计等于基数；再次有效观看率与同周期有效观影留存一致。"],
    ["数据期", "首次有效观看日期", "观察天数", "首次有效观看用户数", ...WATCHING_OUTCOMES, "再次有效观看率（%）", "观察窗口结束", "状态", "数据来源"],
    ...exportRows(rows, "当前期"), ...(previous ? exportRows(previous, "对比期") : [])
  ] };
}
