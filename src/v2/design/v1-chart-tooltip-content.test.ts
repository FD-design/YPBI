import assert from "node:assert/strict";
import test from "node:test";
import {
  cohortTooltip,
  comparisonTooltip,
  focusedSeriesTooltip,
  funnelTooltip,
  multiPidTooltip,
  singleSeriesTooltip,
  structureTooltip
} from "../../components/chart-tooltip-content.ts";

test("数值将单位附在值后，真实 0 不追加状态说明", () => {
  const tooltip = singleSeriesTooltip("2026-09-04", 0, "人");
  assert.equal(tooltip, "2026-09-04<br/>0 人");
  assert.doesNotMatch(tooltip, /单位：|状态：|真实 0|当前值/);
});

test("单系列只在缺失时给出一条恢复理解所需的短说明", () => {
  const tooltip = focusedSeriesTooltip("2026-09-06", "Android DAU", null, "人");
  assert.equal(tooltip, "2026-09-06<br/>Android DAU<br/>缺失<br/>折线在此处断开");
});

test("两期对比保留实际日期、值和差值，不显示第 N 天", () => {
  const tooltip = comparisonTooltip({
    currentDate: "2026-09-05",
    currentValue: 176540,
    comparisonDate: "2026-08-29",
    comparisonValue: 171320,
    unit: "人"
  });
  assert.equal(tooltip.replace(/<span[^>]*>|<\/span>/g, ""), "当前期 2026-09-05 · 176,540 人<br/>对比期 2026-08-29 · 171,320 人<br/>较对比期 +5,220 人");
  assert.match(tooltip, /data-change-direction="up"/);
  assert.doesNotMatch(tooltip, /第\s*\d+\s*天|单位：|状态：/);
});

test("比较提示区分下降、持平、真实零值和缺失，不为缺失生成涨跌", () => {
  const input = { currentDate: "2026-09-05", comparisonDate: "2026-08-29", comparisonValue: 10, unit: "人" };
  assert.match(comparisonTooltip({ ...input, currentValue: 0 }), /data-change-direction="down".*-10 人/);
  assert.match(comparisonTooltip({ ...input, currentValue: 10 }), /data-change-direction="flat".*0 人/);
  assert.doesNotMatch(comparisonTooltip({ ...input, currentValue: null }), /data-change-direction/);
});

test("多 PID 提示只保留日期、平台、PID、值、排名和必要异常", () => {
  const normal = multiPidTooltip({ date: "2026-09-08", platform: "TikTok", pid: "TT", value: 194319, unit: "人", rank: 1, rankedCount: 12 });
  assert.equal(normal, "2026-09-08<br/>TikTok<br/>PID：TT<br/>值：194,319 人<br/>当日排名：1 / 12");
  assert.doesNotMatch(normal, /指标|状态|单位：|当前值/);

  const missing = multiPidTooltip({ date: "2026-09-06", platform: "TikTok", pid: "TT", value: null, unit: "人", rank: null, rankedCount: 11 });
  assert.match(missing, /该日缺失，折线断开$/);
});

test("饼图和环图不重复当前值或数据日标签", () => {
  const tooltip = structureTooltip("端别", "Android", 119880, "人", 61.69);
  assert.equal(tooltip, "端别 Android<br/>119,880 人<br/>占整体 61.69%");
  assert.doesNotMatch(tooltip, /当前值|数据日|单位：/);
});

test("漏斗起点不展示上一步、流失、耗时和冗余 100%", () => {
  const tooltip = funnelTooltip({ dateRange: "2026-09-02 至 2026-09-08", stageName: "访问", stageValue: 120000 });
  assert.equal(tooltip, "2026-09-02 至 2026-09-08<br/>访问<br/>到达用户 120,000 人");
  assert.doesNotMatch(tooltip, /上一步|流失|耗时|100%/);
});

test("Cohort 成熟数据不显示状态，未成熟仅出现一次", () => {
  const mature = cohortTooltip({ cohort: "09-02 新增", observationDay: "D6", cohortBase: 46626, retained: 7973, retentionRate: 17.1 });
  assert.doesNotMatch(mature, /成熟状态|已成熟/);

  const immature = cohortTooltip({ cohort: "09-08 新增", observationDay: "D6", cohortBase: 47280, retained: null, retentionRate: null });
  assert.equal((immature.match(/未成熟/g) ?? []).length, 1);
  assert.doesNotMatch(immature, /留存人数|留存率|成熟状态/);
});
