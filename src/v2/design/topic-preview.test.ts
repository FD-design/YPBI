import { describe, expect, test } from "bun:test";
import { DEFAULT_RANGE, END, REGISTER_IDS, WATCH_RETENTION_IDS, CONTENT_ROWS, cohortRows, topicCard, monthCard, structureRows, validRange } from "./topic-preview-fixtures";
import { cohortExport, metricRows, rankingExport } from "./topic-preview-export";
import { DEFAULT_TOPIC_VIEW, parseTopicView, topicHref } from "./topic-preview-view";
import { resolveDevelopmentPreview } from "./development-preview-route";
describe("专题演示边界", () => {
  test("所有留存窗口未成熟保持空值，跨窗口复用同一 Cohort 基数", () => {
    for (const ids of [REGISTER_IDS, WATCH_RETENTION_IDS]) for (const row of cohortRows(DEFAULT_RANGE, ids)) for (const cell of row.cells) {
      if (cell.availableAt > END) { expect(cell.status).toBe("未成熟"); expect(cell.rate).toBeNull(); expect(cell.count).toBeNull(); }
      else expect(cell.rate).toBe(cell.count! / row.base);
    }
    expect(topicCard("M023", DEFAULT_RANGE, true).result.status).toBe("immature");
  });
  test("单日、默认周、跨月及180天保留完整点，0和待加工不混用", () => {
    for (const start of [END, "2026-09-02", "2026-08-10", "2026-06-11", "2026-03-13"]) {
      const range = { start, end: END }, model = topicCard("M101", range, true);
      expect(validRange(range)).toBe(true);
      if (model.result.status !== "available") throw Error("fixture unavailable");
      expect(model.result.trend.current.length).toBe((Date.parse(END) - Date.parse(start)) / 86400000 + 1);
    }
    const mixed = cohortRows(DEFAULT_RANGE, REGISTER_IDS, true);
    expect(mixed[0].cells[0].count).toBe(0);
    expect(mixed[1].cells[0].count).toBeNull();
    expect(cohortExport(mixed)[1][4]).toBe(0);
  });
  test("多日去重与人均边界关闭；日均人数不是累计UV", () => {
    for (const id of ["M098", "M035", "M043"]) {
      expect(topicCard(id, DEFAULT_RANGE, true).result.status).toBe("not_ready");
      expect(topicCard(id, { start: END, end: END }, true).result.status).toBe("available");
    }
    const model = topicCard("M026", DEFAULT_RANGE, true);
    if (model.result.status !== "available") throw Error("fixture unavailable");
    expect(model.result.value.raw).toBe(model.result.trend.current.reduce((sum, point) => sum + point.value!.raw, 0) / 7);
  });
  test("普通结果不完整禁止整段比较；不对比清除基准；自然月日期无重复", () => {
    const partial = topicCard("M101", DEFAULT_RANGE, true, true), single = topicCard("M016", DEFAULT_RANGE, false);
    expect(partial.result.status === "available" && partial.result.comparison?.status).toBe("unavailable");
    expect(single.result.status === "available" && single.result.comparison).toBeNull();
    expect(single.result.status === "available" && single.result.trend.current.every(p => p.counterpart === null)).toBe(true);
    for (const end of ["2026-08-31", END]) { const model = monthCard({ start: "2026-08-01", end }, true); if (model.result.status !== "available") throw Error("fixture unavailable"); expect(new Set(model.result.trend.current.map(p => p.actualDate)).size).toBe(6); }
  });
  test("导出保留全部126条及空状态；二维数据独立", () => {
    expect(rankingExport(CONTENT_ROWS, "M036").length).toBe(127);
    expect(structureRows("cross", "M016").length).toBe(6);
    expect(metricRows([topicCard("M023", DEFAULT_RANGE, true)])[1][3]).toBeNull();
    const none = metricRows([topicCard("M016", DEFAULT_RANGE, false)]);
    expect(none[0]).not.toContain("对比值");
    expect(none[0].slice(-8)).toEqual(["分子指标","分子值","分子单位","分母指标","分母值","分母单位","公式","计算范围"]);
    expect(none.every(row => row.length === 14)).toBe(true);
    const compared = metricRows([topicCard("M016", DEFAULT_RANGE, true)]);
    expect(compared[0]).toContain("对比值");
    expect(compared.every(row => row.length === 16)).toBe(true);
  });
  test("专题深链仅接受合法条件和登记阅读枚举", () => {
    const href = topicHref("5.8", DEFAULT_TOPIC_VIEW), url = new URL(href, "http://localhost");
    expect(resolveDevelopmentPreview(url)).toBe("dashboard-center");
    expect(parseTopicView(JSON.stringify({ ...DEFAULT_TOPIC_VIEW, active: { start: "2025-01-01", end: END } }))).toBeNull();
    expect(parseTopicView(JSON.stringify({ ...DEFAULT_TOPIC_VIEW, reading: { dimension: "private-data" } }))).toBeNull();
  });
});
