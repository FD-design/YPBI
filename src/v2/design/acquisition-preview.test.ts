import { expect, test } from "bun:test";
import { acquisitionCards, acquisitionRows, fixtureSupports, fixtureComparison, DEFAULT_ACQUISITION_FILTERS, DETAIL_METRICS } from "./acquisition-preview-model";
import { acquisitionViewHref, DEFAULT_ACQUISITION_VIEW, parseAcquisitionView, readAcquisitionView, resetAcquisitionPages } from "./acquisition-view-state";
import { resolveDevelopmentPreview } from "./development-preview-route";
import { detailedTrendOption } from "../features/dashboards/detailed-trend-option";
import { buildPreviewWorkbook } from "./preview-workbook";
import { acquisitionWorkbook, acquisitionTrendWorkbook, acquisitionDimensionWorkbook } from "./acquisition-export";

test("九项同源详细卡，计数摘要与逐日结果一致，转化分母独立", () => {
  const cards = acquisitionCards(true);
  expect(cards.map(item => item.model.metric.id)).toEqual(["M001", "M003", "M008", "M005", "M006", "M007", "M033", "M037", "M038"]);
  for (const { model } of cards) {
    expect(model.metric.definitionLabel).not.toMatch(/<span|launch_result|effective_play_flag/);
    if (model.result.status !== "available") throw new Error("Missing sample");
    const result = model.result;
    expect(result.trend.current).toHaveLength(7);
    expect(result.trendKind).toBe("line");
    if (["M001", "M003", "M008", "M038"].includes(model.metric.id)) expect(result.trend.current.reduce((sum, point) => sum + point.value!.raw, 0)).toBe(result.value.raw);
  }
  expect(cards.find(item => item.model.metric.id === "M006")?.note).toContain("IP·天");
  expect(DETAIL_METRICS.target).not.toContain("M006");
  expect(DETAIL_METRICS.type).toEqual(["M008"]);
});
test("对比详情使用显式实际基准日期，当前值与变化口径不变", () => {
  const comparison = fixtureComparison("M008", 84, 70, DEFAULT_ACQUISITION_FILTERS, { start: "2026-08-02", end: "2026-08-08" });
  expect(comparison.status).toBe("available");
  if (comparison.status !== "available") throw new Error("missing comparison");
  expect(comparison.rows?.[1].date).toBe("2026-08-02 至 2026-08-08");
  expect(comparison.display).toBe("↑ 20.0%");
});
test("未覆盖筛选不复用旧快照，无对比没有遗留系列，真实0和未产出分离", () => {
  expect(fixtureSupports(DEFAULT_ACQUISITION_FILTERS)).toBe(true);
  for (const patch of [{ end: "2026-09-10" }, { start: "2026-09-09" }, { start: "2025-09-01" }, { channel: "a" }, { scope: "single" }, { comparison: "year" }]) expect(fixtureSupports({ ...DEFAULT_ACQUISITION_FILTERS, ...patch })).toBe(false);
  for (const { model } of acquisitionCards(false)) if (model.result.status === "available") { expect(model.result.comparison).toBeNull(); expect(model.result.trend.comparison).toBeNull(); expect(model.result.trend.current.every(point => point.counterpart === null)).toBe(true); }
  const mixed = acquisitionCards(true, true);
  const visits = mixed[0].model.result;
  if (visits.status !== "available") throw new Error("Missing sample");
  expect(visits.trend.current[1].value?.raw).toBe(0);
  expect(mixed[1].model.result.status).toBe("not_produced");
  expect(mixed[7].model.result.status).toBe("failed");
  expect(acquisitionCards(true, true, ["M037"])[7].model.result.status).toBe("available");
});
test("视图白名单可还原筛选和局部表格状态，非法外链参数失败关闭", () => {
  const view = { ...DEFAULT_ACQUISITION_VIEW, detail: { ...DEFAULT_ACQUISITION_VIEW.detail, sections: { ...DEFAULT_ACQUISITION_VIEW.detail.sections, target: { ...DEFAULT_ACQUISITION_VIEW.detail.sections.target, search: "Android", sort: { id: "M005", descending: false } } } } };
  const url = new URL(acquisitionViewHref(view), "http://localhost");
  expect(readAcquisitionView(url.search)).toEqual(view);
  expect(resolveDevelopmentPreview(url)).toBe("dashboard-center");
  expect(resolveDevelopmentPreview({ ...url, pathname: url.pathname, search: url.search + "&extra=1", hash: "" })).toBeNull();
  expect(parseAcquisitionView(JSON.stringify({ ...view, filters: { ...view.filters, start: "2026-02-30" } }))).toBeNull();
  expect(parseAcquisitionView("x".repeat(3001))).toBeNull();
});
test("旧分组链接只恢复对应区块，四块阅读状态独立且统一重置页码", () => {
  const reading = { search: "Android", showChange: "previous", page: 2, sort: { id: "M005", descending: false } };
  const legacy = { v: 1, filters: DEFAULT_ACQUISITION_FILTERS, detail: { tab: "growth", dimension: "target", ...reading }, mixed: false };
  const migrated = parseAcquisitionView(JSON.stringify(legacy))!;
  expect(migrated.v).toBe(2);
  expect(migrated.detail.sections.target).toEqual(reading);
  expect(migrated.detail.sections.channel.search).toBe("");
  expect(migrated.detail.sections.type.search).toBe("");
  expect(resetAcquisitionPages(migrated.detail).sections.target).toEqual({ ...reading, page: 0 });
  const settlement = parseAcquisitionView(JSON.stringify({ ...legacy, detail: { ...legacy.detail, tab: "settlement", sort: { id: "M011", descending: true } } }))!;
  expect(settlement.detail.sections.settlement.search).toBe("Android");
  expect(settlement.detail.sections.target.search).toBe("");
  expect(parseAcquisitionView(JSON.stringify({ ...migrated, detail: { ...migrated.detail, sections: { ...migrated.detail.sections, type: { ...reading, page: -1 } } } }))).toBeNull();
});
test("下载目标和获客类型局部导出仅包含自己的完整结果", () => {
  const target = acquisitionDimensionWorkbook(DEFAULT_ACQUISITION_FILTERS, "target");
  expect(target).toHaveLength(3);
  expect(target[1].rows).toHaveLength(16);
  expect(target.flatMap(sheet => sheet.rows).flat()).toContain("App Store");
  expect(target.map(sheet => sheet.name).join()).not.toContain("来源渠道");
  const types = acquisitionDimensionWorkbook(DEFAULT_ACQUISITION_FILTERS, "type");
  expect(types[1].rows).toHaveLength(3);
  expect(types[1].rows.flat()).toContain("内部导量");
  expect(types[1].rows.flat()).not.toContain("Android");
  expect(types[0].rows.flat()).toContain("演示数据，不用于经营决策或结算");
});
test("详细图共用轴触发，不对比删系列，比率差使用百分点并保留安全标记", () => {
  const option = detailedTrendOption({ kind: "bar", unit: "人", dates: ["2026-09-02"], values: [0] });
  expect(option.tooltip.trigger).toBe("axis"); expect(option.yAxis.min).toBe(0); expect(option.series).toHaveLength(1); expect(option.series[0].data).toEqual([0]);
  const ratio = detailedTrendOption({ kind: "line", unit: "%", dates: ["2026-09-02"], values: [.21], comparison: { dates: ["2026-08-26"], values: [.20] } });
  expect(ratio.tooltip.formatter([{ dataIndex: 0 }])).toContain("1 个百分点");
  expect(ratio.tooltip.formatter([{ dataIndex: 0 }])).not.toContain("单位：");
  expect(ratio.xAxis.boundaryGap).toBe(true);
  const long = detailedTrendOption({ kind: "line", unit: "人", dates: Array.from({ length: 90 }, (_, i) => `day-${i}`), values: Array.from({ length: 90 }, (_, i) => i) });
  expect(long.series[0].showSymbol).toBe(false);
  expect(long.series[0].data).toHaveLength(90);
  expect(long.xAxis.axisLabel.hideOverlap).toBe(true);
});
test("完整演示工作簿包含所有明细、结算隔离、空值与安全文本", () => {
  const sheets = acquisitionWorkbook(DEFAULT_ACQUISITION_FILTERS, true, []);
  expect(sheets[0].name).toBe("00_导出说明"); expect(sheets.at(-1)?.name).toBe("99_数据状态与限制");
  expect(sheets.find(sheet => sheet.name.includes("来源渠道"))?.rows).toHaveLength(96);
  expect(sheets.filter(sheet => sheet.name.includes("来源渠道"))).toHaveLength(1);
  expect(sheets.find(sheet => sheet.name.includes("渠道结算"))?.rows.flat()).toContain("新增用户数（扣后）");
  const binary = buildPreviewWorkbook([...sheets, { name: "安全文本", rows: [["=HYPERLINK(\"bad\")", "<script>&", 0, null]] }]);
  expect([...binary.slice(0, 4)]).toEqual([80, 75, 3, 4]);
  const raw = new TextDecoder().decode(binary);
  expect(raw).toContain('t="inlineStr"'); expect(raw).not.toContain("<f>"); expect(raw).toContain("&lt;script&gt;&amp;"); expect(raw).toContain("<v>0</v>");
  expect(() => buildPreviewWorkbook([{ name: "invalid/name", rows: [] }])).toThrow();
});

test("单指标导出与整板逐日结果同源，保留精度、对比、状态并拒绝未覆盖日期", () => {
  const model = acquisitionCards(true)[5].model;
  const single = acquisitionTrendWorkbook(model, DEFAULT_ACQUISITION_FILTERS);
  const rows = single[1].rows;
  expect(rows).toHaveLength(8);
  expect(rows[0]).toContain("差值（百分点）");
  const boardRows = acquisitionWorkbook({ ...DEFAULT_ACQUISITION_FILTERS, comparison: "previous" }, false, [])[2].rows;
  const retainedColumns = boardRows[0].map((header, index) => ["分子指标", "分母指标"].includes(String(header)) ? -1 : index).filter(index => index >= 0);
  expect(rows.slice(1)).toEqual(boardRows.slice(1).filter(row => row[0] === model.metric.name).map(row => retainedColumns.map(index => row[index])));
  expect(typeof rows[1][2]).toBe("number"); expect(typeof rows[1][6]).toBe("number");
  expect(rows[2][6]).toBeLessThan(0);
  const none = acquisitionTrendWorkbook(acquisitionCards(false)[5].model, { ...DEFAULT_ACQUISITION_FILTERS, comparison: "none" });
  expect(none[1].rows.every(row => row.length === 11)).toBe(true);
  expect(none[1].rows[0]).not.toContain("对比日期");
  expect(none[1].rows[0].slice(-6)).toEqual(["注册用户数（区间排重）（分子）","分子单位","落地页访问IP·天合计（分母）","分母单位","公式","计算范围"]);
  const mixed = acquisitionCards(true, true);
  expect(acquisitionTrendWorkbook(mixed[0].model, DEFAULT_ACQUISITION_FILTERS)[1].rows[2][2]).toBe(0);
  expect(() => acquisitionTrendWorkbook(mixed[1].model, DEFAULT_ACQUISITION_FILTERS)).toThrow();
  for (const start of ["2026-09-08", "2026-08-10", "2026-06-11"]) {
    const filters = { ...DEFAULT_ACQUISITION_FILTERS, start };
    expect(() => acquisitionTrendWorkbook(model, filters)).toThrow();
    const current = acquisitionCards(true, false, [], filters)[5].model;
    expect(() => acquisitionTrendWorkbook(current, filters)).not.toThrow();
    expect(() => acquisitionWorkbook(filters, false, [])).not.toThrow();
  }
});

test("单日、整月与全年按同一演示日期生成卡片、维度明细及完整导出", () => {
  for (const range of [{ start: "2026-09-03", end: "2026-09-03" }, { start: "2026-08-01", end: "2026-08-31" }, { start: "2025-09-08", end: "2026-09-08" }]) {
    const filters = { ...DEFAULT_ACQUISITION_FILTERS, ...range };
    expect(fixtureSupports(filters)).toBe(true);
    const cards = acquisitionCards(true, false, [], filters);
    const count = (Date.parse(range.end) - Date.parse(range.start)) / 86400000 + 1;
    for (const { model } of cards) {
      if (model.result.status !== "available") throw new Error("Missing date fixture");
      expect(model.result.trend.current).toHaveLength(count);
      expect(model.result.trend.current[0].actualDate).toBe(range.start);
      expect(model.result.trend.current.at(-1)?.actualDate).toBe(range.end);
      expect(model.result.trend.comparison).toHaveLength(count);
      expect(acquisitionTrendWorkbook(model, filters)[1].rows).toHaveLength(count + 1);
      if (["M001", "M003", "M008"].includes(model.metric.id)) {
        expect(model.result.trend.current.reduce((s, p) => s + p.value!.raw, 0)).toBe(model.result.value.raw);
        expect(acquisitionRows("channel", range).reduce((s, row) => s + row.values[model.metric.id]!, 0)).toBe(model.result.value.raw);
      }
    }
  }
  const single = acquisitionCards(true, false, [], { start: "2026-09-03", end: "2026-09-03" })[0].model.result;
  if (single.status !== "available") throw new Error("Missing day");
  expect(single.value.raw).toBe(85000);
});
