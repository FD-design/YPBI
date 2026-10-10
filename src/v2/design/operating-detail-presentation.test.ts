import assert from "node:assert/strict";
import test from "node:test";
import { detailChange, formatDetailValue } from "./operating-detail-presentation.ts";

test("经营快照保留真实零、负值；一般空值不推断来源状态，列表单位不重复", () => {
  assert.equal(formatDetailValue(0, "count", false), "0");
  assert.equal(formatDetailValue(-1250, "count", false), "-1,250");
  assert.equal(formatDetailValue(1200, "duration"), "1,200 小时");
  assert.equal(formatDetailValue(1200, "duration", false), "1,200");
  for (const value of [null, NaN, Infinity, -Infinity]) assert.equal(formatDetailValue(value, "ratio"), "—");
});

test("百分率用百分点而不是相对增长，持平保留中性", () => {
  assert.deepEqual(detailChange(.7813, .7749, "ratio"), { direction: "up", display: "↑ 0.64 个百分点" });
  assert.deepEqual(detailChange(99, 100, "count"), { direction: "down", display: "↓ 1.0%" });
  assert.deepEqual(detailChange(0, 0, "ratio"), { direction: "flat", display: "— 0.00 个百分点" });
  assert.deepEqual(detailChange(0, 100, "count"), { direction: "down", display: "↓ 100.0%" });
});

test("小时保留小数，秒换算后的正时长与真实零可区分", () => {
  assert.equal(formatDetailValue(64 / 3600, "duration", true, "小时"), "0.01778 小时");
  assert.equal(formatDetailValue(64 / 3600, "duration", false, "小时"), "0.01778");
  assert.equal(formatDetailValue(1.25, "duration", true, "小时"), "1.25 小时");
  assert.equal(formatDetailValue(0, "duration", true, "小时"), "0 小时");
  for (const value of [1 / 3600, 1e-9, Number.MIN_VALUE]) {
    assert.ok(Number(formatDetailValue(value, "duration", false, "小时")) > 0);
  }
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

test("小额人均金额和次数保留四位精度，不改变其他类型与单位样式", () => {
  for (const value of [.004, -.004, 0, 12345.6789]) {
    const formatted = value === 12345.6789 ? "12,345.68" : String(value);
    assert.equal(formatDetailValue(value, "currency", true, "元/人"), `${formatted} 元/人`);
    assert.equal(formatDetailValue(value, "currency", false, "元/人"), formatted);
    assert.equal(formatDetailValue(value, "currency", true, "USD/人"), `$${formatted}/人`);
    assert.equal(formatDetailValue(value, "average", true, "次/人"), `${formatted} 次/人`);
  }
  for (const kind of ["currency", "average"] as const) assert.equal(formatDetailValue(null, kind, false, "元/人"), "—");
  assert.equal(formatDetailValue(.004, "currency", true, "元"), "0 元");
  assert.equal(formatDetailValue(.004, "currency", true, "USD"), "$0");
  assert.equal(formatDetailValue(.004, "ratio"), "0.40%");
  assert.equal(formatDetailValue(.004, "count", false), "0");
  assert.equal(formatDetailValue(64 / 3600, "duration", false, "小时"), "0.01778");
});
