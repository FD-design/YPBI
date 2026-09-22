import { expect, test } from "bun:test";
import { corePeriodCards, corePeriodMetric } from "./core-period-preview";
import { DEMO_RANGE } from "./extended-board-model";

test("核心摘要、重复链路指标与导出读取相同日历快照", () => {
  for (const range of [DEMO_RANGE, { start: "2026-08-01", end: "2026-08-31" }]) {
    for (const card of corePeriodCards("normal", range, true)) {
      expect(corePeriodMetric(card.metric.id, range, true)).toEqual(card);
    }
  }
  const rate = corePeriodMetric("M081", DEMO_RANGE, true);
  expect(rate.result.status === "available" && rate.result.value.display).toBe("78.13");
});

test("核心重复指标关闭比较后不保留对比值或点位", () => {
  for (const card of corePeriodCards("normal", DEMO_RANGE, false)) {
    const chain = corePeriodMetric(card.metric.id, DEMO_RANGE, false);
    expect(chain).toEqual(card);
    if (chain.result.status === "available") {
      expect(chain.result.comparison).toBeNull();
      expect(chain.result.trend.comparison).toBeNull();
      expect(chain.result.trend.current.every(point => point.counterpart === null)).toBe(true);
    }
  }
});
