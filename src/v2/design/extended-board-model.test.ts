import { describe, expect, test } from "bun:test";
import { DEMO_RANGE, EXTENDED_BOARDS, demoDates, demoCategories, demoUnit, extendedMetricModel, extendedDailyMetricModel } from "./extended-board-model";
import { corePeriodCards } from "./core-period-preview";
import { contentRows, monthCard, structureRows } from "./topic-preview-fixtures";
import { metricRows } from "./topic-preview-export";
import { parseExtendedView, extendedBoardHref } from "./extended-board-view";
import { resolveDevelopmentPreview } from "./development-preview-route";
import { DEFAULT_VERSION_PERFORMANCE_VIEW } from "./version-performance-model";

describe("后续看板共享日期与单位", () => {
  const ids = [...new Set(Object.values(EXTENDED_BOARDS).flatMap(board => board.sections.flatMap(section => section.ids)))];
  for (const range of [{ start: "2026-09-03", end: "2026-09-03" }, { start: "2026-08-01", end: "2026-08-31" }, { start: "2025-09-08", end: "2026-09-08" }]) for (const id of ids) {
    test(`${id} ${range.start}至${range.end} 保留日值并清除关闭后的比较`, () => {
      const model = extendedMetricModel(id, range, true), result = model.result;
      if (result.status !== "available") throw Error(id);
      expect(result.trend.current.map(point => point.actualDate)).toEqual(demoDates(range));
      for (const point of result.trend.current.slice(0, 2)) {
        const single = extendedMetricModel(id, { start: point.actualDate, end: point.actualDate }, false).result;
        if (single.status !== "available") throw Error(id);
        expect(point.value!.raw).toBe(single.value.raw);
      }
      expect(result.value.raw).toBeGreaterThanOrEqual(0);
      if (demoUnit(id) === "%") expect(result.value.raw).toBeLessThanOrEqual(1);
      const without = extendedMetricModel(id, range, false).result;
      if (without.status !== "available") throw Error(id);
      expect(without.comparison).toBeNull(); expect(without.trend.comparison).toBeNull();
      expect(without.trend.current.every(p => !p.counterpart)).toBe(true);
    });
  }
  test("失败与未产出保留空值和实际单位；交叉独立、分类全集与稳定键", () => {
    const failed = extendedMetricModel("M065", DEMO_RANGE, true, true);
    expect(failed.result.status).toBe("failed");
    expect(metricRows([failed], demoUnit)[1][3]).toBeNull();
    expect(metricRows([failed], demoUnit)[1][4]).toBe("USD");
    expect(extendedMetricModel("M090", DEMO_RANGE, true, true).result.status).toBe("immature");
    expect(demoCategories("平台 × 新老用户")).toHaveLength(6);
    expect(demoCategories("一级分类 Tab")).toHaveLength(12);
    expect(demoCategories("视频")).toHaveLength(126);
    expect(demoCategories("一级分类 Tab").map(row => row.key)).not.toEqual(demoCategories("一级内容分类").map(row => row.key));
  });
  test("日卡投影保留播放失败和固定批次未成熟状态，重试后可恢复", () => {
    for (const range of [DEMO_RANGE, { start: "2026-09-03", end: "2026-09-03" }, { start: "2026-08-01", end: "2026-08-31" }]) {
      for (const id of ["M065", "M097", "M047", "M075", "M091"]) {
        expect(extendedDailyMetricModel(id, range, true, true).result).toMatchObject({
          status: "failed", label: "当前指标加载失败", retryable: true
        });
        expect(extendedDailyMetricModel(id, range, true, false).result.status).toBe("available");
      }
      for (const id of ["M090", "M076"]) expect(extendedDailyMetricModel(id, range, true, true).result.status).toBe("immature");
      for (const id of ["M036", "M101"]) expect(extendedDailyMetricModel(id, range, true, true).result.status).toBe("available");
    }
  });
  test("核心卡、月活、结构和内容排行随实际日期改变", () => {
    const range = { start: "2026-08-01", end: "2026-08-31" };
    const cards = corePeriodCards("normal", range, false);
    expect(cards).toHaveLength(9);
    for (const model of cards) if (model.result.status === "available") { expect(model.result.trend.current[0].actualDate).toBe(range.start); expect(model.result.comparison).toBeNull(); }
    const month = monthCard(range, true).result, week = monthCard(DEMO_RANGE, true).result;
    if (month.status !== "available" || week.status !== "available") throw Error("monthly");
    expect(month.value.raw).not.toBe(week.value.raw); expect(week.value.raw).toBe(483612);
    expect(month.trend.current.at(-1)!.value!.raw).toBe(month.value.raw);
    expect(contentRows(range)[0].attempts).not.toBe(contentRows(DEMO_RANGE)[0].attempts);
    expect(structureRows("platform", "M101", range)[0].current).not.toBe(structureRows("platform", "M101", DEMO_RANGE)[0].current);
  });
  test("深链严格校验，目录预览不扩大正式身份边界", () => {
    const view = { range: DEMO_RANGE, compared: true, mixed: false };
    for (const id of ["5.2", ...Object.keys(EXTENDED_BOARDS)]) expect(resolveDevelopmentPreview(new URL(extendedBoardHref(id, view), "http://localhost"))).toBe("dashboard-center");
    expect(parseExtendedView(JSON.stringify({ ...view, token: "invalid" }))).toBeNull();
    expect(parseExtendedView(JSON.stringify({ ...view, range: { start: "2026-02-30", end: "2026-09-08" } }))).toBeNull();
    for (const kind of ["metrics", "events"]) {
      expect(resolveDevelopmentPreview(new URL(`/data/${kind}?design=catalog-center`, "http://localhost"))).toBe("catalog-center");
      expect(resolveDevelopmentPreview(new URL(`/data/${kind}?design=catalog-center&anything=1`, "http://localhost"))).toBeNull();
    }
  });
  test("版本表现状态只准入产品体验看板并可复制恢复", () => {
    const view = { range: DEMO_RANGE, compared: true, mixed: false, experience: { ...DEFAULT_VERSION_PERFORMANCE_VIEW, panel: "version" as const, version: "android:6.7.2", comparison: "android:6.8.0" } };
    const href = extendedBoardHref("5.15", view);
    expect(parseExtendedView(JSON.stringify(view), "5.15")).toEqual(view);
    expect(resolveDevelopmentPreview(new URL(href, "http://localhost"))).toBe("dashboard-center");
    expect(parseExtendedView(JSON.stringify(view), "5.14")).toBeNull();
    expect(parseExtendedView(JSON.stringify(view))).toBeNull();
    expect(resolveDevelopmentPreview(new URL(extendedBoardHref("5.14", view), "http://localhost"))).toBeNull();
  });
});
