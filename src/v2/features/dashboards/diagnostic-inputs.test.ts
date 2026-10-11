import { test } from "node:test";
import assert from "node:assert/strict";
import type { DailyPoint } from "../../../../contracts/daily-dashboard";
import { diagnosticRatioInputs, retentionReferenceRatio, RETENTION_REFERENCE_LABEL } from "./diagnostic-inputs";

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
