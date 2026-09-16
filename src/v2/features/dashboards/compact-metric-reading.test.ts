import { expect, test } from "bun:test";
import { acquisitionDailyCards, DEFAULT_ACQUISITION_FILTERS } from "../../design/acquisition-preview-model";
import { compactTrendReading } from "./CompactMetricReading";
import { extendedDailyMetricModel } from "../../design/extended-board-model";

test("轻量诊断直接消费日末阅读，比较关闭后不残留变化或对比线", () => {
  const compared = acquisitionDailyCards(true).find(item => item.model.metric.id === "M001")!.model;
  if (compared.result.status !== "available") throw new Error("missing acquisition fixture");
  expect(compared.result.value.raw).toBe(89804);
  expect(compared.result.reading?.primaryLabel).toBe(`所选日 ${DEFAULT_ACQUISITION_FILTERS.end}`);
  expect(compared.result.reading?.comparisons.map(item => item.label)).toEqual(["较前一天", "较上周同日"]);
  expect(compactTrendReading(compared)?.comparison).not.toBe("");

  const plain = acquisitionDailyCards(false).find(item => item.model.metric.id === "M001")!.model;
  if (plain.result.status !== "available") throw new Error("missing acquisition fixture");
  expect(plain.result.reading?.comparisons).toEqual([]);
  expect(compactTrendReading(plain)?.comparison).toBe("");
});

test("轻量趋势对缺失日断线，且不裁剪超过100%的候选比率", () => {
  const mixed = acquisitionDailyCards(true, true).find(item => item.model.metric.id === "M005")!.model;
  const path = compactTrendReading(mixed)?.current ?? "";
  expect((path.match(/M/g) ?? []).length).toBe(3);

  const ratio = acquisitionDailyCards(true).find(item => item.model.metric.id === "M006")!.model;
  if (ratio.result.status !== "available") throw new Error("missing ratio fixture");
  const last = ratio.result.trend.current.at(-1)!;
  last.value = { raw: 1.2, display: "120.00%", actualDate: last.actualDate };
  ratio.result.value = { raw: 1.2, display: "120.00", unit: "%" };
  expect(ratio.result.value.raw).toBe(1.2);
  expect(compactTrendReading(ratio)?.availablePoints).toBe(ratio.result.trend.current.length);
});

test("单日趋势保留可见点，播放关系复用同一日读取而不改周期统计", () => {
  const single = acquisitionDailyCards(true, false, [], { ...DEFAULT_ACQUISITION_FILTERS, start: DEFAULT_ACQUISITION_FILTERS.end }).find(item => item.model.metric.id === "M001")!.model;
  const geometry = compactTrendReading(single);
  expect(geometry?.currentPoints).toHaveLength(1);
  expect(geometry?.comparisonPoints).toHaveLength(1);

  const playback = extendedDailyMetricModel("M101", DEFAULT_ACQUISITION_FILTERS, true);
  if (playback.result.status !== "available") throw new Error("missing playback fixture");
  expect(playback.result.reading?.primaryLabel).toBe(`所选日 ${DEFAULT_ACQUISITION_FILTERS.end}`);
  expect(playback.result.reading?.comparisons.map(item => item.label)).toEqual(["较前一天", "较上周同日"]);
  expect(playback.result.reading?.statistics.some(item => item.label === "合计")).toBe(true);
});

test("多日缺口形成的孤立有效段保留点标记，连续线段不重复铺点", () => {
  const model = acquisitionDailyCards(true).find(item => item.model.metric.id === "M001")!.model;
  if (model.result.status !== "available") throw new Error("missing acquisition fixture");
  model.result.trend.current = model.result.trend.current.map((point, index) => [0, 2, 4, 5].includes(index) ? point : { ...point, value: null, state: "no_value", stateLabel: "缺失" });
  const geometry = compactTrendReading(model);
  expect(geometry?.currentPoints).toHaveLength(2);
  expect(geometry?.current).toContain("M8.0");
  expect(geometry?.current).toContain("M82.7");
  expect(geometry?.current).toContain("M157.3");
  expect(geometry?.current).toContain("L194.7");
});
