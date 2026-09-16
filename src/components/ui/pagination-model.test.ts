import { expect, test } from "bun:test";
import { pageBounds, pageItems } from "./pagination-model";
import { CARTESIAN_DEFAULTS } from "../../../contracts/chart-presentation";
import { CORE_OVERVIEW_CARD_SPECS } from "../../../contracts/core-overview";

test("时间趋势默认折线；类别和离散数量比较保留柱状", () => {
  expect(CARTESIAN_DEFAULTS).toEqual({ time_trend: "line", category_comparison: "bar", discrete_quantity: "bar" });
  expect(CORE_OVERVIEW_CARD_SPECS.every(spec => spec.trendKind === CARTESIAN_DEFAULTS.time_trend)).toBe(true);
});
test("分页空值、整页、尾页和越界钳制", () => {
  expect(pageBounds(0, 50, 10)).toEqual({ count: 1, current: 0, start: 0, end: 0 });
  expect(pageBounds(50, 50, 0).end).toBe(50);
  expect(pageBounds(2880, 50, 100)).toEqual({ count: 58, current: 57, start: 2850, end: 2880 });
  expect(pageBounds(1, 50, -2).current).toBe(0);
});
test("页码保留首尾与当前位置，单个缺口展示数字而不是省略号", () => {
  expect(pageItems(1, 0)).toEqual([0]);
  expect(pageItems(6, 0)).toEqual([0, 1, 2, 3, 4, 5]);
  expect(pageItems(58, 0)).toEqual([0, 1, 2, 3, "gap", 57]);
  expect(pageItems(58, 28)).toEqual([0, "gap", 27, 28, 29, "gap", 57]);
  expect(pageItems(58, 57)).toEqual([0, "gap", 54, 55, 56, 57]);
});
