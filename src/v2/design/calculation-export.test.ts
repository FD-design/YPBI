import { expect, test } from "bun:test";
import { calculationCells, calculationExport, calculationHeaders } from "./calculation-export";
import { topicCard, DEFAULT_RANGE } from "./topic-preview-fixtures";
import { metricRows } from "./topic-preview-export";
import { acquisitionCards, DEFAULT_ACQUISITION_FILTERS } from "./acquisition-preview-model";
import { acquisitionTrendWorkbook } from "./acquisition-export";

test("稳定实名导出只移除重复名称，原始精度、独立单位及缺失均保留", () => {
  const model = topicCard("M036", DEFAULT_RANGE, true);
  if (model.result.status !== "available") throw Error("fixture unavailable");
  const basis = structuredClone(model.result.calculation!);
  basis.numerator.value = 15.123456789;
  const input = calculationExport([basis]);
  expect(input.headers).toEqual(["有效观影次数（分子）", "分子单位", "成功起播次数（分母）", "分母单位", "公式", "计算范围"]);
  expect(input.cells(basis)).toEqual([15.123456789, "次", basis.denominator.value, "次", basis.formula, basis.scope]);
  expect(input.cells()).toEqual([null, null, null, null, null, null]);
});

test("单指标摘要与逐日身份不同时保留姓名列，混合指标仍使用逐行实名", () => {
  const daily = topicCard("M081", DEFAULT_RANGE, true);
  const effective = topicCard("M036", DEFAULT_RANGE, true);
  const single = metricRows([daily]);
  expect(single[0]).toContain("分子指标");
  expect(single.flat()).toContain("观影人天");
  expect(single.flat()).toContain("观影用户数");
  const mixed = metricRows([daily, effective]);
  expect(mixed[0].slice(-8)).toEqual(calculationHeaders);
  expect(mixed.flat()).toContain("有效观影次数");
  expect(mixed.every(row => row.length === mixed[0].length)).toBe(true);
  if (effective.result.status !== "available") throw Error("fixture unavailable");
  expect(calculationCells(effective.result.calculation)).toHaveLength(8);
  const stable = metricRows([topicCard("M036", DEFAULT_RANGE, false)]);
  expect(stable[0]).toContain("有效观影次数（分子）");
  expect(stable[0]).not.toContain("分子指标");
  expect(stable.every(row => row.length === stable[0].length)).toBe(true);
});

test("公式已登记而输入待接入时，实名表头保留且输入导出为空", () => {
  const model = acquisitionCards(true).find(item => item.model.metric.id === "M037")!.model;
  const rows = acquisitionTrendWorkbook(model, DEFAULT_ACQUISITION_FILTERS)[1].rows;
  expect(rows[0].slice(-6)).toEqual(["首次体验终态为“完成”或“已激活未完成”的去重用户数（分子）", "分子单位", "首次体验已成熟并结束的去重用户数（分母）", "分母单位", "公式", "计算范围"]);
  expect(rows.slice(1).every(row => row.slice(-6).every(value => value === null))).toBe(true);
  expect(rows.every(row => row.length === rows[0].length)).toBe(true);
});
