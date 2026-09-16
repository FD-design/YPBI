import assert from "node:assert/strict";
import test from "node:test";
import { detailChange, formatDetailValue } from "./operating-detail-presentation.ts";

test("经营快照保留真实零、负值与无记录；列表单位不重复", () => {
  assert.equal(formatDetailValue(0, "count", false), "0");
  assert.equal(formatDetailValue(-1250, "count", false), "-1,250");
  assert.equal(formatDetailValue(1200, "duration"), "1,200 小时");
  assert.equal(formatDetailValue(1200, "duration", false), "1,200");
  assert.equal(formatDetailValue(null, "ratio"), "无记录");
});

test("百分率用百分点而不是相对增长，持平保留中性", () => {
  assert.deepEqual(detailChange(.7813, .7749, "ratio"), { direction: "up", display: "↑ 0.64 个百分点" });
  assert.deepEqual(detailChange(99, 100, "count"), { direction: "down", display: "↓ 1.0%" });
  assert.deepEqual(detailChange(0, 0, "ratio"), { direction: "flat", display: "— 0.00 个百分点" });
  assert.deepEqual(detailChange(0, 100, "count"), { direction: "down", display: "↓ 100.0%" });
});

test("零基准增长率、缺失与非法数值不生成变化", () => {
  for (const current of [0, 100, -100]) assert.equal(detailChange(current, 0, "count"), null);
  for (const value of [null, NaN, Infinity, -Infinity]) {
    assert.equal(detailChange(value, 100, "count"), null);
    assert.equal(detailChange(100, value, "ratio"), null);
  }
});

test("次数、人均广告、订单、ARPPU 与端别比值单位独立", () => {
  assert.equal(formatDetailValue(12, "events", true, "次"), "12 次");
  assert.equal(formatDetailValue(12, "events", true, "单"), "12 单");
  assert.equal(formatDetailValue(.35, "average", true, "次/人"), "0.35 次/人");
  assert.equal(formatDetailValue(23.45, "currency", true, "USD/人"), "$23.45/人");
  assert.equal(formatDetailValue(23.45, "currency", true, "元"), "23.45 元");
  assert.equal(formatDetailValue(23.45, "currency", true, "元/人"), "23.45 元/人");
  assert.equal(formatDetailValue(23.45, "currency", false, "元/人"), "23.45");
  assert.equal(formatDetailValue(23.45, "currency", false, ""), "23.45");
  assert.equal(formatDetailValue(2.5, "platformRatio"), "2.5 : 1");
  assert.equal(detailChange(2.5, 2, "platformRatio"), null);
});
