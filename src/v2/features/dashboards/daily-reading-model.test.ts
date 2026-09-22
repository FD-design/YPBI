import { expect, test } from "bun:test";
import { dailyComparison, dailyDateLabel, dailyMetricReading } from "./daily-reading-model";
import { supplementaryDailyQuery, previousDailyQuery } from "./daily-reference-plan";
import { acquisitionDailyCards, acquisitionCards } from "../../design/acquisition-preview-model";
import { topicDailyCard, topicCard, monthCard } from "../../design/topic-preview-fixtures";
import { coreDailyCards, corePeriodCards } from "../../design/core-period-preview";
import { extendedDailyMetricModel, EXTENDED_BOARDS } from "../../design/extended-board-model";
import type { DailyDashboardQuery } from "../../../../contracts/daily-dashboard";
import { shiftDate } from "../../../components/ui/date-range-model";
import { metricRows } from "../../design/topic-preview-export";
import { acquisitionTrendWorkbook, acquisitionWorkbook } from "../../design/acquisition-export";
import { DEFAULT_ACQUISITION_FILTERS } from "../../design/acquisition-preview-model";

const range = { start: "2026-09-02", end: "2026-09-08" };
const point = (date: string, value: number | null) => ({ date, value, display: String(value), reason: value === null ? "该日未返回" : undefined });
test("日卡日期简写保留星期，跨年与无效日期不偏移", () => {
  expect(dailyDateLabel("2026-08-31")).toBe("8-31（一）");
  expect(dailyDateLabel("2026-09-12")).toBe("9-12（六）");
  expect(dailyDateLabel("2027-01-01")).toBe("1-1（五）");
  expect(dailyDateLabel("2026-02-30")).toBe("2026-02-30");
  const model = acquisitionDailyCards(false, false, [], range)[0].model;
  expect(model.result.reading?.primaryDate).toBe(range.end);
  expect(model.result.reading?.primaryLabel).toBe(`所选日 ${range.end}`);
});
test("日比较精确日期、率百分点和零基准语义", () => {
  expect(dailyComparison(point(range.end, .6), point("2026-09-07", .5), "%", "较前一天")).toMatchObject({ status: "available", display: "+10.00 个百分点", rows: [{ date: range.end }, { date: "2026-09-07" }] });
  expect(dailyComparison(point(range.end, 10), point("2026-09-07", 0), "次", "较前一天").status).toBe("unavailable");
  expect(dailyComparison(point(range.end, 0), point("2026-09-07", 10), "次", "较前一天")).toMatchObject({ status: "available", display: "-100.00%" });
  expect(dailyComparison(point(range.end, null), point("2026-09-07", 10), "次", "较前一天").status).toBe("unavailable");
});
test("微小真实变化不显示带方向的0.00，极小值保留界限", () => {
  expect(dailyComparison(point(range.end, .0002), point("2026-09-07", .00021), "%", "较前一天")).toMatchObject({ display: "-0.0010 个百分点", direction: "down" });
  expect(dailyComparison(point(range.end, .0002100001), point("2026-09-07", .00021), "%", "较前一天")).toMatchObject({ display: "+<0.0001 个百分点", direction: "up" });
  expect(dailyComparison(point(range.end, .0002), point("2026-09-07", .0002), "%", "较前一天")).toMatchObject({ display: "0.00 个百分点", direction: "flat" });
});
test("不对比只读D，不读取或残留两参考日；失败不借回调恢复值", () => {
  const model = acquisitionCards(false, false, [], range)[0].model, reads: string[] = [];
  const result = dailyMetricReading(model, { date: range.end, compared: false, read: date => { reads.push(date); return point(date, 123); } }).result;
  expect(reads).toEqual([range.end]); expect(result.reading?.comparisons).toEqual([]);
  const failed = dailyMetricReading({ ...model, result: { status: "failed", contextLabel: "演示", label: "失败", retryable: true } }, { date: range.end, compared: true, read: date => point(date, 123) }).result;
  expect(failed.status).toBe("failed"); expect(failed.reading?.comparisons.every(item => item.status === "unavailable")).toBe(true);
});
test("末日缺失不取最近有数日，历史保留", () => {
  const model = acquisitionCards(true, false, [], range)[0].model;
  const result = dailyMetricReading(model, { date: range.end, compared: true, read: date => point(date, date === range.end ? null : 99) }).result;
  expect(result.status).toBe("no_values");
  if (result.status === "available") throw Error("must keep missing D");
  expect(result.history?.value.display).toBe("—"); expect(result.history?.trend.current.length).toBe(7);
  expect(result.reading?.comparisons.every(item => item.status === "unavailable")).toBe(true);
  const exported = metricRows([{ ...model, result }]);
  expect(exported[1][3]).toBeNull();
  expect(exported.filter(row => row[1] === "趋势")).toHaveLength(7);
});
test("日卡导出不把原周期比较混入末日摘要，周期统计单列", () => {
  const model = acquisitionDailyCards(true, false, [], range)[0].model;
  const exported = metricRows([model]);
  expect(exported[1][2]).toBe(`所选日 ${range.end}`); expect(exported[1][5]).toBeNull();
  expect(exported.find(row => row[1] === "较前一天")?.[5]).toBe("2026-09-07");
  expect(exported.find(row => row[1] === "较上周同日")?.[5]).toBe("2026-09-01");
  expect(exported.filter(row => ["合计", "均值"].includes(String(row[1])))).toHaveLength(2);
  const single = acquisitionTrendWorkbook(model, { ...DEFAULT_ACQUISITION_FILTERS, comparison: "previous" });
  expect(single.find(sheet => sheet.name === "02_日值与周期辅助")?.rows.find(row => row[1] === "较上周同日")?.[5]).toBe("2026-09-01");
  const board = acquisitionWorkbook({ ...DEFAULT_ACQUISITION_FILTERS, comparison: "previous" }, false, []);
  expect(board.find(sheet => sheet.name === "03_主卡日值与周期辅助")?.rows.filter(row => row[1] === "较前一天")).toHaveLength(6);
});
test("固定核心演示累计与日均从相同逐日源派生，独立去重与比率不按日聚合", () => {
  for (const card of corePeriodCards("normal", range, true)) {
    if (card.result.status !== "available") throw Error("normal fixture");
    const sum = card.result.trend.current.reduce((total, point) => total + point.value!.raw, 0);
    if (["M008", "M102", "M058"].includes(card.metric.id)) expect(card.result.value.raw).toBe(sum);
    if (["M016", "M026"].includes(card.metric.id)) expect(card.result.value.raw).toBe(sum / 7);
    if (card.metric.id === "M059") expect(card.result.value.raw).toBe(18429);
    if (card.metric.id === "M081") expect(card.result.value.raw).toBe(.7813);
  }
});
test("1/2/3天仅补缺失D-7，4/31/366天复用已有结果，关闭比较不补读", () => {
  for (const days of [1, 2, 3, 4, 31, 366]) {
    const query: DailyDashboardQuery = { boardId: "5.2", pid: "PH", dateRange: [shiftDate(range.end, 1 - days), range.end] };
    expect(supplementaryDailyQuery(query, false)).toBeNull();
    expect(previousDailyQuery(query).dateRange).toEqual([shiftDate(query.dateRange[0], -days), shiftDate(query.dateRange[0], -1)]);
    expect(supplementaryDailyQuery(query, true)).toEqual(days < 4 ? { ...query, dateRange: ["2026-09-01", "2026-09-01"] } : null);
  }
});
test("各普通演示主卡1/31天固定D，参考D-1/D-7，原周期模型保持独立", () => {
  for (const days of [1, 7, 31]) {
    const selected = { start: shiftDate(range.end, 1 - days), end: range.end };
    const cards = [
      ...acquisitionDailyCards(true, false, [], selected).slice(0, 6).map(item => item.model),
      ...coreDailyCards("normal", selected, true).filter(model => model.metric.id !== "M020"),
      ...["M016", "M026", "M101", "M097", "M102", "M098", "M081", "M036", "M034", "M035", "M043"].map(id => topicDailyCard(id, selected, true)),
      ...Object.values(EXTENDED_BOARDS).flatMap(board => board.sections.flatMap(section => section.ids)).filter(id => !["M064", "M088", "M090", "M076"].includes(id)).map(id => extendedDailyMetricModel(id, selected, true))
    ];
    for (const model of cards) {
      const result = model.result;
      expect(result.reading?.primaryLabel).toBe(`所选日 ${range.end}`);
      if (result.status !== "available") continue;
      expect(result.value.raw).toBe(result.trend.current.find(day => day.actualDate === range.end)?.value?.raw);
      expect(result.reading?.comparisons.map(item => item.label)).toEqual(["较前一天", "较上周同日"]);
      for (const [index, comparison] of (result.reading?.comparisons ?? []).entries()) if (comparison.status === "available") expect(comparison.rows?.[1].date).toBe(index ? "2026-09-01" : "2026-09-07");
    }
  }
  expect(acquisitionCards(true, false, [], range)[0].model.result).not.toHaveProperty("reading");
  expect(topicCard("M102", range, true).result).not.toHaveProperty("reading");
  expect(corePeriodCards("normal", range, true)[0].result).not.toHaveProperty("reading");
});
test("月活与成熟留存例外；日均时长/UV无周期权威结果不造统计", () => {
  for (const id of ["M020", "M022", "M024", "M040", "M041", "M025"]) {
    const result = topicDailyCard(id, range, true).result;
    expect(result.reading?.primaryLabel).toContain("成熟"); expect(result.reading?.primaryLabel).not.toContain("所选日");
  }
  expect(monthCard(range, true).result.reading?.primaryLabel).toContain("自然月");
  for (const id of ["M098", "M035", "M043"]) {
    const model = topicDailyCard(id, range, true);
    expect(model.result.status).toBe("available"); expect(model.result.reading?.statistics).toEqual([]);
    if (model.result.status === "available") expect(model.result.trend.current).toHaveLength(7);
  }
  const missing = topicDailyCard("M101", { start: "2026-09-02", end: "2026-09-04" }, true, true).result;
  expect(missing.status).toBe("no_values"); expect(missing.reading?.comparisons.every(item => item.status === "unavailable")).toBe(true);
});
