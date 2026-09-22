import assert from "node:assert/strict";
import test from "node:test";
import { chartAxisLabels, chartAxisScale, chartValueExtent, standardChartAxes } from "./chart-axis.ts";
import { metricHeadingUnit } from "./metric-unit.ts";
import { init, use } from "echarts/core";
import { GridComponent } from "echarts/components";
import { LineChart } from "echarts/charts";
import { SVGRenderer } from "echarts/renderers";

test("坐标刻度使用完整分组数字，同轴不同刻度不会缩写成相同标签", () => {
  assert.deepEqual(chartAxisLabels([2640, 2550, 2460]), ["2,640", "2,550", "2,460"]);
  assert.deepEqual(chartAxisLabels([446916, 223458, 0]), ["446,916", "223,458", "0"]);
  assert.deepEqual(chartAxisLabels([.624, .6175, .611], 100, "%"), ["62.4%", "61.8%", "61.1%"]);
  assert.equal(new Set(chartAxisLabels([.62101, .62102, .62103], 100, "%")).size, 3);
  assert.deepEqual(chartAxisLabels([-1000, 0, 1000]), ["-1,000", "0", "1,000"]);
});

test("紧凑轴沿用完整图表的规整刻度，覆盖数据而非直接标最大最小中点", () => {
  assert.deepEqual(chartAxisScale(0, 7200).ticks, [0, 2000, 4000, 6000, 8000]);
  assert.deepEqual(chartAxisScale(176000, 201000).ticks, [170000, 180000, 190000, 200000, 210000]);
  assert.deepEqual(chartAxisScale(139000, 161000).ticks, [130000, 140000, 150000, 160000, 170000]);
  assert.deepEqual(chartAxisScale(2460, 2640).ticks, [2450, 2500, 2550, 2600, 2650]);
  assert.deepEqual(chartAxisLabels(chartAxisScale(.611, .624).ticks, 100, "%"), ["61%", "61.5%", "62%", "62.5%"]);
  assert.deepEqual(chartAxisScale(0, 1, 1).ticks, [0, 1]);
});

test("相同数据与刻度密度下，紧凑轴和完整 ECharts 实际轴结果一致", () => {
  use([GridComponent, LineChart, SVGRenderer]);
  for (const [min, max] of [[0, 7200], [176000, 201000], [139000, 161000], [2460, 2640], [.611, .624], [.147, .1575]]) {
    const chart = init(null, undefined, { renderer: "svg", ssr: true, width: 500, height: 300 });
    try {
      chart.setOption(standardChartAxes({ animation: false, xAxis: { type: "category", data: ["开始", "结束"] }, yAxis: { type: "value", scale: true, splitNumber: 3 }, series: [{ type: "line", data: [min, max] }] }));
      const ticks = (chart as any).getModel().getComponent("yAxis").axis.scale.getTicks().map((tick: { value: number }) => tick.value);
      assert.deepEqual(chartAxisScale(min, max).ticks, ticks);
    } finally { chart.dispose(); }
  }
});

test("规整坐标保留负数、极小变化及大数且无截断、非等距和重复轴标", () => {
  assert.deepEqual(chartAxisLabels(chartAxisScale(.147, .1575).ticks, 100, "%"), ["14.5%", "15%", "15.5%", "16%"]);
  assert.equal(chartValueExtent([null, null]), null);
  assert.deepEqual(chartValueExtent([0, 0], true).ticks, [0, .5, 1]);
  for (const [min, max] of [[-7200, 0], [-5, 7], [0, 446916], [1e9, 1.41e9], [.62101, .62103], [0, 1e-9]]) {
    const axis = chartAxisScale(min, max);
    assert.ok(axis.min <= min && axis.max >= max);
    assert.ok(axis.ticks.length >= 2 && axis.ticks.length <= 5);
    for (let i = 1; i < axis.ticks.length; i++) assert.ok(Math.abs(axis.ticks[i] - axis.ticks[i - 1] - axis.interval) < axis.interval * 1e-6);
    assert.equal(new Set(chartAxisLabels(axis.ticks)).size, axis.ticks.length);
  }
  assert.ok(chartAxisScale(.62101, .62103).spread < .0001);
  assert.throws(() => chartAxisScale(NaN, 1));
  assert.throws(() => chartAxisScale(1, 1));
});

test("指标列名仅省略已表达的计数单位，时长币种与复合单位保留", () => {
  assert.equal(metricHeadingUnit("日活跃用户数", "人"), "");
  assert.equal(metricHeadingUnit("观看人数", "人"), "");
  assert.equal(metricHeadingUnit("访问次数", "次"), "");
  assert.equal(metricHeadingUnit("支付提交", "次"), "次");
  assert.equal(metricHeadingUnit("观影总时长", "小时"), "小时");
  assert.equal(metricHeadingUnit("总充值金额", "USD"), "USD");
  assert.equal(metricHeadingUnit("观看深度", "次/人"), "次/人");
  assert.equal(metricHeadingUnit("日活Android:iOS比值", "Android:iOS"), "");
  assert.equal(metricHeadingUnit("新增Android:iOS比值", "Android:iOS"), "");
  assert.equal(metricHeadingUnit("端别比值", "Android:iOS"), "Android:iOS");
});
