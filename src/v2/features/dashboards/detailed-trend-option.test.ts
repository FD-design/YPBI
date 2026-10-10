import { expect, test } from "bun:test";
import { init, use } from "echarts/core";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { BarChart, LineChart } from "echarts/charts";
import { SVGRenderer } from "echarts/renderers";
import { chartValueExtent } from "../../../components/chart-axis";
import { isIntegerMetricUnit } from "../../../components/metric-unit";
import { detailedTrendOption, type DetailedTrendData } from "./detailed-trend-option";

use([GridComponent, LegendComponent, TooltipComponent, BarChart, LineChart, SVGRenderer]);

function rendered(data: DetailedTrendData, width = 500) {
  const option = detailedTrendOption(data);
  const chart = init(null, undefined, { renderer: "svg", ssr: true, width, height: 280 });
  try {
    chart.setOption(option);
    const axis = (chart as any).getModel().getComponent("yAxis").axis;
    return { option, labels: axis.getViewLabels().map((label: { tick: { value: number }; formattedLabel: string }) => ({ value: label.tick.value, text: label.formattedLabel })), svg: chart.renderToSVGString() };
  } finally { chart.dispose(); }
}

test("详细图按已登记单位区分整数计数与小数，compact共用同一判定", () => {
  for (const unit of ["人", "次", "单"]) {
    expect(isIntegerMetricUnit(unit)).toBe(true);
    const { option, labels } = rendered({ kind: "line", unit, dates: ["2020-01-01"], values: [1] });
    expect(option.yAxis.minInterval).toBe(1);
    expect(labels.every(label => Number.isInteger(label.value))).toBe(true);
    for (const label of labels) expect(label.text).toBe(label.value.toLocaleString("en-US", { maximumFractionDigits: 6 }));
  }
  for (const unit of ["元", "USD", "元/人", "次/人", "分钟/人", "小时", "秒", "比例", "未知单位", ""]) expect(isIntegerMetricUnit(unit)).toBe(false);
});

test("金额、人均及时长的小额详细轴覆盖真实读数且不被整数跨度压平", () => {
  for (const kind of ["line", "bar"] as const) {
    for (const unit of ["元", "USD", "元/人", "次/人", "分钟/人", "小时", "秒"]) {
      for (const value of [0.004, 0.000004, 0.62101]) {
        const { option, labels, svg } = rendered({ kind, unit, dates: ["2020-01-01"], values: [value] });
        const extent = chartValueExtent([value], kind === "bar")!;
        expect(option.yAxis.minInterval).toBeUndefined();
        expect(option.yAxis.min).toBe(extent.min);
        expect(option.yAxis.max).toBe(extent.max);
        expect(option.yAxis.interval).toBeLessThan(1);
        expect(labels[0].value).toBeLessThanOrEqual(value);
        expect(labels.at(-1)!.value).toBeGreaterThanOrEqual(value);
        expect(new Set(labels.map(label => label.text)).size).toBe(labels.length);
        for (const label of labels) {
          expect(Number(label.text.replaceAll(",", ""))).toBeCloseTo(label.value, 12);
          expect(svg).toContain(`>${label.text}</text>`);
        }
      }
    }
  }
});

test("详细图保留百分比缩放、零与缺失、比较两期和短长周期符号边界", () => {
  const ratio = detailedTrendOption({ kind: "line", unit: "%", dates: ["2020-01-01"], values: [.21], comparison: { dates: ["2019-12-31"], values: [.2] } });
  expect(ratio.series.map((series: any) => series.data)).toEqual([[20], [21]]);
  expect(ratio.yAxis.axisLabel.formatter(20.5)).toBe("20.5%");
  expect(ratio.series.every((series: any) => series.showSymbol)).toBe(true);
  const long = detailedTrendOption({ kind: "line", unit: "元/人", dates: Array.from({ length: 90 }, (_, index) => `day-${index}`), values: Array(90).fill(.004) });
  expect(long.series[0].showSymbol).toBe(false);
  const boundary = detailedTrendOption({ kind: "line", unit: "元/人", dates: ["2020-01-01", "2020-01-02", "2020-01-03"], values: [0, null, .004], comparison: { dates: ["2019-12-29", "2019-12-30", "2019-12-31"], values: [null, .008, 0] } });
  expect(boundary.series.map((series: any) => series.data)).toEqual([[null, .008, 0], [0, null, .004]]);
  expect(boundary.series.every((series: any) => !series.connectNulls)).toBe(true);
});

test("详细图两种视口保持一致小数刻度及原高度", () => {
  const data: DetailedTrendData = { kind: "line", unit: "元/人", dates: ["2020-01-01"], values: [.004] };
  const desktop = rendered(data, 1024), narrow = rendered(data, 320);
  expect(narrow.labels).toEqual(desktop.labels);
  expect(narrow.svg).toContain('height="280"');
  expect(desktop.svg).toContain('height="280"');
});

test("明确不可比时保留两期图值和日期，tooltip不重新计算差值", () => {
  for (const kind of ["line", "bar"] as const) {
    const option = detailedTrendOption({ kind, unit: "%", dates: ["2020-01-01"], values: [.75], comparison: { dates: ["2019-12-31"], values: [.25], unavailableReasons: ["规则版本不同，不比较差值 <v1>"] } });
    expect(option.series.map((series: any) => series.data)).toEqual([[25], [75]]);
    const tooltip = option.tooltip.formatter([{ dataIndex: 0 }]);
    expect(tooltip).toContain("当前期 2020-01-01 · 75 %");
    expect(tooltip).toContain("对比期 2019-12-31 · 25 %");
    expect(tooltip).toContain("规则版本不同，不比较差值 &lt;v1&gt;");
    expect(tooltip).not.toContain("+50"); expect(tooltip).not.toContain("较对比期");
  }
  const comparable = detailedTrendOption({ kind: "line", unit: "%", dates: ["2020-01-01"], values: [.75], comparison: { dates: ["2019-12-31"], values: [.25] } });
  expect(comparable.tooltip.formatter([{ dataIndex: 0 }])).toContain("+50 个百分点");
});
