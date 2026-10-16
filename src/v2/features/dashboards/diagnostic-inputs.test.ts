import { test } from "node:test";
import assert from "node:assert/strict";
import type { DailyPoint } from "../../../../contracts/daily-dashboard";
import { calculationInputValues, diagnosticRatioInputs, retentionReferenceRatio, RETENTION_REFERENCE_LABEL, safeDiagnosticSeries } from "./diagnostic-inputs";

const metric = (id = "M020.android") => ({ id, unit: "%", inputs: [{ key: "retained" }, { key: "registered" }] });
const point = (numerator: number | null = 1, denominator: number | null = 2, overrides: Partial<DailyPoint> = {}): DailyPoint => ({
  date: "2020-01-01", state: "no_value", sourceStatus: "SOURCE_INCOMPLETE", value: null,
  inputs: [{ key: "retained", value: numerator }, { key: "registered", value: denominator }], ...overrides
});

for (const [id, numerator, denominator, value] of [
  ["M020.android", 1, 2, 0.5], ["M020.ios", 2, 2, 1],
  ["M020.natural", 2, 4, 0.5], ["M020.internal", 3, 3, 1]
] as const) {
  test(`${id} 来源不完整的合法人数返回 ${value} 参考比率`, () => {
    assert.deepEqual(retentionReferenceRatio(metric(id), point(numerator, denominator)), {
      value, numerator, denominator, label: "部分数据，仅供参考"
    });
  });
}

test("参考标记固定且真实零分子保留为0%", () => {
  assert.equal(RETENTION_REFERENCE_LABEL, "部分数据，仅供参考");
  assert.deepEqual(retentionReferenceRatio(metric(), point(0, 2)), {
    value: 0, numerator: 0, denominator: 2, label: RETENTION_REFERENCE_LABEL
  });
});

test("零分母保留诊断输入但不产生参考值", () => {
  const source = point(0, 0);
  assert.deepEqual(diagnosticRatioInputs(metric(), source), { numerator: 0, denominator: 0 });
  assert.equal(retentionReferenceRatio(metric(), source), null);
});

for (const [name, numerator, denominator] of [
  ["负分子", -1, 2], ["负分母", 0, -2],
  ["分子NaN", NaN, 2], ["分母NaN", 1, NaN],
  ["分子Infinity", Infinity, 2], ["分母Infinity", 1, Infinity],
  ["分子非整数", 1.5, 2], ["分母非整数", 1, 2.5],
  ["分子不安全整数", Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 1],
  ["分母不安全整数", 1, Number.MAX_SAFE_INTEGER + 1],
  ["分子超过分母", 3, 2], ["分子缺失", null, 2], ["分母缺失", 1, null]
] as const) {
  test(`${name} 不产生参考比率`, () => {
    assert.equal(retentionReferenceRatio(metric(), point(numerator, denominator)), null);
  });
}

test("输入键不匹配、颠倒或重复时不产生参考比率", () => {
  for (const inputs of [
    [{ key: "other", value: 1 }, { key: "registered", value: 2 }],
    [{ key: "registered", value: 1 }, { key: "retained", value: 2 }],
    [{ key: "retained", value: 1 }, { key: "retained", value: 2 }]
  ]) assert.equal(retentionReferenceRatio(metric(), point(1, 2, { inputs })), null);
});

test("非百分比、非双输入和缺少数据点不产生参考比率", () => {
  assert.equal(retentionReferenceRatio({ ...metric(), unit: "人" }, point()), null);
  assert.equal(retentionReferenceRatio({ ...metric(), inputs: [{ key: "retained" }] }, point()), null);
  assert.equal(retentionReferenceRatio(metric(), point(1, 2, { inputs: [{ key: "retained", value: 1 }] })), null);
  assert.equal(retentionReferenceRatio(metric(), undefined), null);
});

for (const sourceStatus of ["READY", "FAILED", "NOT_MATURE", "PROCESSING", undefined] as const) {
  test(`${sourceStatus ?? "无来源状态"} 不产生参考比率`, () => {
    assert.equal(retentionReferenceRatio(metric(), point(1, 2, { sourceStatus })), null);
  });
}

test("正式结果已有数值或状态不是no_value时不产生参考比率", () => {
  assert.equal(retentionReferenceRatio(metric(), point(1, 2, { value: 50 })), null);
  for (const state of ["available", "no_record", "invalid_value", "zero_denominator", "immature", "source_failure"] as const) {
    assert.equal(retentionReferenceRatio(metric(), point(1, 2, { state })), null);
  }
});

for (const id of ["M020", "M021.android", "M022.ios", "M023.natural", "M020.ads", "M090", "M020.android.extra"]) {
  test(`${id} 不属于四个D1参考展示分组`, () => {
    assert.equal(retentionReferenceRatio(metric(id), point()), null);
  });
}

test("参考计算保留原数据对象、输入、正式空值及不可读状态", () => {
  const source = point();
  const original = structuredClone(source);
  const originalInputs = source.inputs;
  Object.freeze(source.inputs[0]);
  Object.freeze(source.inputs[1]);
  Object.freeze(source.inputs);
  Object.freeze(source);
  assert.equal(retentionReferenceRatio(metric(), source)?.value, 0.5);
  assert.deepEqual(source, original);
  assert.equal(source.inputs, originalInputs);
  assert.equal(source.value, null);
  assert.equal(source.state, "no_value");
  assert.equal(source.sourceStatus, "SOURCE_INCOMPLETE");
});

const derivedMetric = (id = "M087") => ({ id, unit: id === "M098" ? "分钟/人" : "元/人",
  inputs: [{ key: "amount", unit: id === "M098" ? "秒" : "元" }, { key: "people", unit: "人" }] });
const derivedPoint = (numerator: number | null = null, denominator: number | null = 6, overrides: Partial<DailyPoint> = {}): DailyPoint => ({
  ...point(), inputs: [{ key: "amount", value: numerator }, { key: "people", value: denominator }], ...overrides
});

for (const [id, denominator] of [["M087", 6], ["M088", 10], ["M067", 5], ["M067.new", 3], ["M098", 5]] as const) {
  test(`${id}派生结果缺失时独立保留实际分母${denominator}，不产生正式或参考结果`, () => {
    const metadata = derivedMetric(id), source = derivedPoint(null, denominator), before = structuredClone(source);
    assert.deepEqual(calculationInputValues(metadata, source), [null, denominator]);
    assert.equal(diagnosticRatioInputs(metadata, source), null);
    assert.equal(retentionReferenceRatio(metadata, source), null);
    assert.deepEqual(source, before);
  });
}

test("派生输入真实0与合法金额小数保留，缺失的另一项继续为空", () => {
  for (const inputs of [[null, 0], [0, null], [162.02, null]] as const) {
    assert.deepEqual(calculationInputValues(derivedMetric(), derivedPoint(...inputs)), inputs);
  }
});

test("派生结果的来源状态分别保留，输入展示不把未就绪结果变为READY", () => {
  for (const [sourceStatus, state] of [["PROCESSING", "no_value"], ["NOT_MATURE", "immature"], ["FAILED", "source_failure"]] as const) {
    const source = derivedPoint(null, 6, { sourceStatus, state });
    assert.deepEqual(calculationInputValues(derivedMetric(), source), [null, 6]);
    assert.equal(source.value, null);
    assert.equal(source.sourceStatus, sourceStatus);
    assert.equal(source.state, state);
  }
  assert.deepEqual(calculationInputValues(derivedMetric(), derivedPoint(null, 6, { sourceStatus: "FAILED" })), [null, null]);
});

test("完整非READY派生输入、脏结果、错误身份或单位均不放宽为可展示输入", () => {
  assert.deepEqual(calculationInputValues(derivedMetric(), derivedPoint(162.02, 6)), [null, null]);
  for (const overrides of [{ value: 1 }, { state: "available" as const },
    { inputs: [{ key: "people", value: null }, { key: "amount", value: 6 }] },
    { inputs: [{ key: "amount", value: null }, { key: "amount", value: 6 }] }]) {
    assert.deepEqual(calculationInputValues(derivedMetric(), derivedPoint(null, 6, overrides)), [null, null]);
  }
  for (const metadata of [{ ...derivedMetric(), unit: "USD/人" },
    { ...derivedMetric(), inputs: [{ key: "amount", unit: "USD" }, { key: "people", unit: "人" }] },
    { ...derivedMetric(), inputs: [{ key: "amount", unit: "元" }, { key: "people", unit: "次" }] }]) {
    assert.deepEqual(calculationInputValues(metadata, derivedPoint()), [null, null]);
  }
});

test("部分派生输入逐项拒绝负数、非有限值和非法人数，普通非READY数字继续隐藏", () => {
  for (const denominator of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(calculationInputValues(derivedMetric(), derivedPoint(null, denominator)), [null, null]);
  }
  for (const numerator of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(calculationInputValues(derivedMetric(), derivedPoint(numerator, null)), [null, null]);
  }
  for (const id of ["M058", "M102", "M061", "M020.android", "M067.old", "M098.new"]) {
    assert.deepEqual(calculationInputValues(derivedMetric(id), derivedPoint()), [null, null]);
  }
});

test("共享安全序列保留派生单项输入且保持正式空值，原完整D1参考规则不变", () => {
  const metadata = { ...derivedMetric(), name: "活跃ARPU", definition: "同日同群", referenceMetricId: "M087", authorityVersion: "fixture", formula: "金额 ÷ 人数", sourceNote: null,
    inputs: derivedMetric().inputs.map(input => ({ ...input, name: input.key })) };
  const source = { metric: metadata, points: [derivedPoint()] }, before = structuredClone(source);
  const safe = safeDiagnosticSeries(source);
  assert.deepEqual(safe.points[0].inputs.map(input => input.value), [null, 6]);
  assert.equal(safe.points[0].value, null);
  assert.equal(safe.points[0].state, "no_value");
  assert.deepEqual(source, before);
  assert.deepEqual(calculationInputValues(metric(), point(null, 2)), [null, null]);
  assert.equal(retentionReferenceRatio(metric(), point(null, 2)), null);
  assert.deepEqual(calculationInputValues(metric(), point(1, 2)), [1, 2]);
  assert.equal(retentionReferenceRatio(metric(), point(1, 2))?.value, .5);
});
