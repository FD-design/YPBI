import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { calculationTableCells, calculationTableColumns, missingCalculationValues } from "./calculation-table-model";
import { DetailedMetricTrend } from "./DetailedMetricTrend";
import { CalculationEvidence, type CalculationBasis } from "./CalculationEvidence";
import { acquisitionCards } from "../../design/acquisition-preview-model";

const basis = (numerator = "新增用户有效观影人数", denominator = "新增用户数", numeratorValue: number | null = 0, denominatorValue: number | null = 100): CalculationBasis => ({
  numerator: { name: numerator, value: numeratorValue, unit: "人" }, denominator: { name: denominator, value: denominatorValue, unit: "人" },
  formula: `${numerator} ÷ ${denominator} × 100%`, scope: "2026-09-08", result: "0%", percentage: true
});

test("带单位换算的计算依据保留源公式，不自行拼出缺少换算因子的等式", () => {
  const converted: CalculationBasis = {
    formula: "接口记录观影时长（暂按秒） ÷ 同范围观影用户数 ÷ 60",
    scope: "同平台同日 · 待验数", numerator: { name: "接口记录观影时长", value: 7200, unit: "秒（暂定）" },
    denominator: { name: "同范围观影用户数", value: 4, unit: "人" }, result: "30 分钟/人", percentage: false
  };
  const html = renderToStaticMarkup(<CalculationEvidence basis={converted} />);
  expect(html).toContain("÷ 60");
  expect(html).toContain("7,200 秒（暂定）");
  expect(html).toContain("4 人");
  expect(html).toContain("30 分钟/人");
  expect(html).not.toContain("7,200 ÷ 4");
  expect(renderToStaticMarkup(<CalculationEvidence basis={{ ...converted, denominator: { ...converted.denominator, value: 0 } }} />)).toContain("分母为0，不能计算。");
});

test("同口径输入每期精简为两个实名列，真实0及单位保留", () => {
  const input = basis();
  const columns = calculationTableColumns([input, basis(undefined, undefined, 49)]);
  expect(columns.map(column => column.heading)).toEqual(["新增用户有效观影人数（分子）", "新增用户数（分母）"]);
  expect(calculationTableCells(input, columns)).toEqual(["0 人", "100 人"]);
  const comparison = basis(undefined, undefined, 32, 87);
  const comparisonColumns = calculationTableColumns([comparison], "对比");
  expect(comparisonColumns.map(column => column.heading)).toEqual(["对比新增用户有效观影人数（分子）", "对比新增用户数（分母）"]);
  expect(calculationTableCells(comparison, comparisonColumns)).toEqual(["32 人", "87 人"]);
});

test("变化的输入名逐行保留，仅移除稳定角色的重复名称", () => {
  const first = basis("新用户充值金额", "付费用户数", 23.56789, 10);
  const second = basis("老用户充值金额", "付费用户数", 42, 11);
  first.numerator.unit = "USD"; second.numerator.unit = "EUR";
  const columns = calculationTableColumns([first, second]);
  expect(columns.map(column => column.heading)).toEqual(["分子指标", "分子值", "付费用户数（分母）"]);
  expect(calculationTableCells(first, columns)).toEqual(["新用户充值金额", "23.5679 USD", "10 人"]);
  expect(calculationTableCells(second, columns)).toEqual(["老用户充值金额", "42 EUR", "11 人"]);
  expect(calculationTableColumns([first, undefined]).map(column => column.heading)).toEqual(["分子指标", "分子值", "分母指标", "分母值"]);
});

test("缺失输入只继承已知身份，两个值始终待接入且不污染原快照", () => {
  const input = basis(undefined, undefined, 25, 100);
  const fallback = missingCalculationValues(input);
  const columns = calculationTableColumns([input, fallback]);
  expect(calculationTableCells(fallback, columns)).toEqual(["待接入", "待接入"]);
  expect(input.numerator.value).toBe(25);
  expect(input.denominator.value).toBe(100);
  expect(calculationTableCells(undefined, calculationTableColumns([undefined]))).toEqual(["待登记", "待接入", "待登记", "待接入"]);
  expect(calculationTableCells(basis(undefined, undefined, Number.NaN, Number.POSITIVE_INFINITY), columns)).toEqual(["待接入", "待接入"]);
});

test("新增有效观影完整表当前与对比均为两列，待接入及七日结果对齐", () => {
  const model = acquisitionCards(true).find(item => item.model.metric.id === "M037")!.model;
  const html = renderToStaticMarkup(<DetailedMetricTrend model={model} onOpenPoint={() => {}} exportAction={<button>导出</button>} view="table" />);
  expect([...html.matchAll(/<th>/g)]).toHaveLength(10);
  expect(html).toContain("新增用户有效观影人数（分子）");
  expect(html).toContain("对比新增用户数（分母）");
  expect(html).not.toContain("分子指标");
  const rows = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].slice(1).map(row => [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(cell => cell[1].replace(/<[^>]+>/g, "")));
  expect(rows).toHaveLength(7);
  expect(rows.every(row => row.length === 10)).toBe(true);
  expect(rows[0].slice(0, 8)).toEqual(["2026-09-02", "待接入", "待接入", "47.60%", "2026-08-26", "待接入", "待接入", "47.00%"]);
  expect(rows[0][9]).toContain("计算输入待接入");
});
