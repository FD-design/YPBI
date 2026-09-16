import { expect, test } from "bun:test";
import { cohortRows, WATCH_RETENTION_IDS, topicCard } from "./topic-preview-fixtures";
import { demoWatchingOutcomes, summarizeWatchingOutcomes, watchingOutcomesSheet } from "./watching-retention-diagnosis-model";
import { DEFAULT_TOPIC_READING, DEFAULT_TOPIC_VIEW, parseTopicView } from "./topic-preview-view";

test("三类去向逐批互斥闭合，第三类精确复用有效观影留存", () => {
  const range = { start: "2026-08-01", end: "2026-09-08" };
  const cohorts = cohortRows(range, WATCH_RETENTION_IDS);
  for (const window of [1, 3, 7] as const) {
    const rows = demoWatchingOutcomes(cohorts, window);
    for (const [index, row] of rows.entries()) if (row.counts) {
      expect(row.counts.reduce((a, b) => a + b, 0)).toBe(row.base);
      expect(row.counts[2]).toBe(cohorts[index].cells.find(cell => cell.id === ({ 1: "M040", 3: "M041", 7: "M042" })[window])!.count);
    }
    const summary = summarizeWatchingOutcomes(rows);
    const model = topicCard(({ 1: "M040", 3: "M041", 7: "M042" })[window], range, false);
    expect(model.result.status).toBe("available");
    if (model.result.status === "available") expect(summary.rates![2]).toBeCloseTo(model.result.value.raw, 12);
    expect(summary.excluded).toBe(window);
  }
});
test("未成熟、迟到、待加工不补0；真实演示0保留；导出包含全批与状态", () => {
  const rows = demoWatchingOutcomes(cohortRows(DEFAULT_TOPIC_VIEW.cohort, WATCH_RETENTION_IDS, true), 1);
  expect(rows[0].counts![2]).toBe(0);
  expect(rows[1].counts).toBeNull();
  expect(rows[2].counts).toBeNull();
  expect(rows.at(-1)!.counts).toBeNull();
  expect(watchingOutcomesSheet(rows, 1).rows.length).toBe(rows.length + 2);
  expect(summarizeWatchingOutcomes([]).rates).toBeNull();
  expect(summarizeWatchingOutcomes(rows.slice(-1)).rates).toBeNull();
});
test("无效分区拒绝，阅读周期严格恢复并拒绝跨看板状态", () => {
  const row = cohortRows({ start: "2026-08-01", end: "2026-08-01" }, WATCH_RETENTION_IDS)[0];
  expect(() => demoWatchingOutcomes([{ ...row, base: 0 }], 1)).toThrow();
  const zero = demoWatchingOutcomes([{ ...row, base: 0, cells: row.cells.map(cell => ({ ...cell, count: 0, rate: null })) }], 1);
  expect(zero[0].counts).toEqual([0, 0, 0]);
  expect(summarizeWatchingOutcomes(zero)).toMatchObject({ complete: 1, base: 0, rates: null });
  const view = { ...DEFAULT_TOPIC_VIEW, reading: { ...DEFAULT_TOPIC_READING, retentionWindow: 7 } };
  expect(parseTopicView(JSON.stringify(view), "5.9")?.reading?.retentionWindow).toBe(7);
  expect(parseTopicView(JSON.stringify(view), "5.8")).toBeNull();
  expect(parseTopicView(JSON.stringify({ ...view, reading: { ...view.reading, retentionWindow: 30 } }), "5.9")).toBeNull();
});
