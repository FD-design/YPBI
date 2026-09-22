import { describe, expect, test } from "bun:test";
import {
  contentDiscoveryOverall,
  contentDiscoverySheet,
  contentPositionTrendModel,
  contentPositionRows,
  orderBoardRows,
  searchDemandRows,
  searchDemandSheet,
  searchDemandTrendModel,
  VIDEO_CLICK_SOURCES,
  videoClickSourceDailyFacts,
  videoClickSourceMetricModel,
  videoClickSourceRows,
  videoClickSourceSheet,
  videoHomeCategoryDailyFacts,
  videoHomeCategoryMetricModel,
  videoHomeCategoryRows
} from "./content-discovery-analysis-model";
import { DEMO_RANGE, EXTENDED_BOARDS, demoCalculationBasis, demoUnit, extendedMetricModel } from "./extended-board-model";
import { topicCard } from "./topic-preview-fixtures";
import { metricRows } from "./topic-preview-export";
import { HORIZONTAL_BAR_GRID, horizontalBarEndLabel } from "./horizontal-bar-reading";

const rate = (basis: ReturnType<typeof contentDiscoveryOverall>["current"]) => basis.numerator.value! / basis.denominator.value!;

describe("诊断阅读使用同源事实", () => {
  test("M044 总体由同一批位置输入汇总，位置结果不从比率倒推", () => {
    const overall = contentDiscoveryOverall(DEMO_RANGE).current;
    const rows = contentPositionRows(DEMO_RANGE);
    expect(overall.numerator.value).toBe(rows.reduce((sum, row) => sum + row.current.numerator.value!, 0));
    expect(overall.denominator.value).toBe(rows.reduce((sum, row) => sum + row.current.denominator.value!, 0));
    expect(rows.every(row => rate(row.current) > 0 && rate(row.current) <= 1)).toBe(true);
    const model = extendedMetricModel("M044", DEMO_RANGE, false).result;
    if (model.status !== "available") throw new Error("M044 演示结果不可用");
    expect(model.value.raw).toBeCloseTo(rate(overall), 12);
  });

  test("搜索规模、用户和承接输入同表保留各自统计主体", () => {
    const rows = searchDemandRows(DEMO_RANGE, "搜索词");
    expect(rows).toHaveLength(126);
    expect(rows.every(row => row.searches >= row.users)).toBe(true);
    expect(rows.every(row => row.conversion.numerator.value! <= row.conversion.denominator.value!)).toBe(true);
    const sheet = searchDemandSheet(DEMO_RANGE, true, "搜索词", "desc");
    expect(sheet.rows[1][1]).toContain("÷");
    expect(sheet.rows[3]).toContain("搜索次数");
    expect(sheet.rows[3]).toContain("搜索用户数");
    const rateSheet = searchDemandSheet(DEMO_RANGE, false, "搜索词", "desc", "M046");
    const exportedRates = rateSheet.rows.slice(4).map(row => row[7] as number);
    expect(exportedRates).toEqual([...exportedRates].sort((a, b) => b - a));
  });

  test("位置和搜索行趋势复用该行同源事实", () => {
    const position = contentPositionRows(DEMO_RANGE)[3];
    const positionTrendModel = contentPositionTrendModel(DEMO_RANGE, true, position.position);
    const positionTrend = positionTrendModel.result;
    if (positionTrend.status !== "available") throw new Error("M044 位置趋势不可用");
    expect(positionTrend.value.raw).toBeCloseTo(rate(position.current), 12);
    expect(positionTrend.calculation?.numerator.value).toBe(position.current.numerator.value);
    expect(positionTrend.calculation?.denominator.value).toBe(position.current.denominator.value);
    expect(metricRows([positionTrendModel], demoUnit)).toHaveLength(9);

    const search = searchDemandRows(DEMO_RANGE, "搜索词")[7];
    const searchTrend = searchDemandTrendModel("M046", DEMO_RANGE, true, search.position).result;
    if (searchTrend.status !== "available") throw new Error("M046 搜索趋势不可用");
    expect(searchTrend.value.raw).toBeCloseTo(rate(search.conversion), 12);
    expect(searchTrend.calculation?.numerator.value).toBe(search.conversion.numerator.value);
    expect(searchTrend.calculation?.denominator.value).toBe(search.conversion.denominator.value);
  });

  test("业务顺序和当前值降序使用同一投影，导出不被图形TopN裁剪", () => {
    const rows = contentPositionRows(DEMO_RANGE);
    expect(orderBoardRows(rows, "position", row => rate(row.current)).map(row => row.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const desc = orderBoardRows(rows, "desc", row => rate(row.current));
    expect(desc.map(row => rate(row.current))).toEqual([...desc.map(row => rate(row.current))].sort((a, b) => b - a));
    expect(contentDiscoverySheet(DEMO_RANGE, false, "desc").rows.slice(5)).toHaveLength(rows.length);
  });

  test("启动主卡使用合法终态输入，网络与导航不再属于启动或播放看板", () => {
    const result = extendedMetricModel("M080", DEMO_RANGE, false).result;
    if (result.status !== "available") throw new Error("M080 演示结果不可用");
    expect(result.calculation?.denominator.name).toBe("不同启动标识启动数");
    expect(result.calculation?.denominator.value).toBeGreaterThan(0);
    expect(result.calculation?.numerator.value).toBeLessThanOrEqual(result.calculation!.denominator.value!);
    expect(result.calculation?.denominator.name).not.toContain("应用启动次数");
    for (const board of ["5.12", "5.15"]) expect(EXTENDED_BOARDS[board].dimensions.flatMap(item => item.groups).some(group => group.includes("网络"))).toBe(false);
    expect(EXTENDED_BOARDS["5.15"].dimensions.some(item => item.title === "全局导航")).toBe(false);
  });

  test("观影原专题总体值和计算依据保持同一事实源", () => {
    for (const id of ["M036", "M097", "M101"]) {
      const source = topicCard(id, DEMO_RANGE, false).result;
      if (source.status !== "available") throw new Error(`${id} 原专题结果不可用`);
      expect(demoCalculationBasis(id, DEMO_RANGE)).toEqual(source.calculation);
      const model = extendedMetricModel(id, DEMO_RANGE, false).result;
      if (model.status !== "available") throw new Error(`${id} 总体结果不可用`);
      expect(model.value.raw).toBe(source.value.raw);
      expect(model.calculation).toEqual(source.calculation);
    }
  });

  test("M109 全局来源总体、逐日、完整表和单来源趋势共用点击事实", () => {
    const rows = videoClickSourceRows(DEMO_RANGE);
    const facts = videoClickSourceDailyFacts(DEMO_RANGE);
    const overall = videoClickSourceMetricModel(DEMO_RANGE, true).result;
    if (overall.status !== "available") throw new Error("M109 来源总体不可用");
    expect(rows).toHaveLength(VIDEO_CLICK_SOURCES.length);
    expect(rows.some(row => row.pageId === "unknown" && row.listId === "unknown")).toBe(true);
    expect(rows.reduce((sum, row) => sum + row.current, 0)).toBe(overall.value.raw);
    expect(facts.reduce((sum, row) => sum + row.clicks, 0)).toBe(overall.value.raw);
    expect(overall.trend.current.reduce((sum, point) => sum + (point.value?.raw ?? 0), 0)).toBe(overall.value.raw);

    const selected = rows.find(row => row.tabId === "selected")!;
    const selectedModel = videoClickSourceMetricModel(DEMO_RANGE, true, selected.key).result;
    if (selectedModel.status !== "available") throw new Error("M109 单来源趋势不可用");
    expect(selectedModel.value.raw).toBe(selected.current);
    expect(selectedModel.trend.current.reduce((sum, point) => sum + (point.value?.raw ?? 0), 0)).toBe(selected.current);

    const sheet = videoClickSourceSheet(DEMO_RANGE, true, "desc");
    expect(sheet.rows.slice(5)).toHaveLength(VIDEO_CLICK_SOURCES.length);
    expect(sheet.rows[4]).toContain("page_name");
    expect(sheet.rows[4]).toContain("list_id");
    expect(sheet.rows[4]).toContain("tab_id");
  });

  test("M109 视频首页一级分类由全局来源子集守恒分配，且不复用 Tab 标识", () => {
    const sourceFacts = videoClickSourceDailyFacts(DEMO_RANGE);
    const categoryFacts = videoHomeCategoryDailyFacts(DEMO_RANGE);
    const sourceRows = videoClickSourceRows(DEMO_RANGE);
    const categoryRows = videoHomeCategoryRows(DEMO_RANGE);
    const homeTotal = sourceFacts.filter(fact => fact.pageId === "video_home").reduce((sum, fact) => sum + fact.clicks, 0);
    const globalTotal = sourceRows.reduce((sum, row) => sum + row.current, 0);

    expect(categoryFacts.reduce((sum, fact) => sum + fact.clicks, 0)).toBe(homeTotal);
    expect(categoryRows.reduce((sum, row) => sum + row.current, 0)).toBe(homeTotal);
    expect(homeTotal).toBeLessThanOrEqual(globalTotal);
    for (const source of VIDEO_CLICK_SOURCES.filter(item => item.pageId === "video_home")) {
      for (const date of [...new Set(sourceFacts.map(fact => fact.date))]) {
        const sourceCount = sourceFacts.find(fact => fact.key === source.key && fact.date === date)!.clicks;
        const categoryCount = categoryFacts.filter(fact => fact.sourceKey === source.key && fact.date === date).reduce((sum, fact) => sum + fact.clicks, 0);
        expect(categoryCount).toBe(sourceCount);
      }
    }
    expect(categoryRows.some(row => VIDEO_CLICK_SOURCES.some(source => source.tabId === row.key))).toBe(false);

    const selected = categoryRows[4];
    const model = videoHomeCategoryMetricModel(DEMO_RANGE, true, selected.key).result;
    if (model.status !== "available") throw new Error("M109 一级分类趋势不可用");
    expect(model.value.raw).toBe(selected.current);
    expect(model.trend.current.reduce((sum, point) => sum + (point.value?.raw ?? 0), 0)).toBe(selected.current);
  });

  test("M109 全局来源和视频首页一级分类保留为同屏的两个不同范围", () => {
    const section = EXTENDED_BOARDS["5.13"].sections[2];
    expect(section.title).toBe("视频点击来源");
    expect(section.ids).toEqual(["M109"]);
    expect(EXTENDED_BOARDS["5.13"].dimensions[1]).toEqual({
      title: "视频首页一级分类内容点击",
      ids: ["M109"],
      groups: ["一级内容分类"]
    });
  });

  test("横向排行只给当前值固定端点读数并预留标签空间", () => {
    const label = horizontalBarEndLabel(value => value === null ? "—" : value.toLocaleString("zh-CN") + " 次");
    expect(HORIZONTAL_BAR_GRID.right).toBeGreaterThanOrEqual(96);
    expect(label.show).toBe(true);
    expect(label.position).toBe("right");
    expect(label.formatter({ value: 12800 })).toBe("12,800 次");
    expect(label.formatter({ value: null })).toBe("—");
  });
});
