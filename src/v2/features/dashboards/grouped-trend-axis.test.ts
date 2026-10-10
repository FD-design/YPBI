import { expect, test } from "bun:test";
import { init, use } from "echarts/core";
import { GridComponent } from "echarts/components";
import { LineChart } from "echarts/charts";
import { SVGRenderer } from "echarts/renderers";
import { groupedTrendValueAxis } from "./GroupedTrend";

use([GridComponent, LineChart, SVGRenderer]);

function renderedAxis(values: (number | null)[], unit: string, width = 500) {
  const chart = init(null, undefined, { renderer: "svg", ssr: true, width, height: 280 });
  try {
    chart.setOption({ animation: false, grid: { left: 58, right: 20, top: 24, bottom: 36 },
      xAxis: { type: "category", data: values.map((_, index) => `第${index + 1}日`) },
      yAxis: groupedTrendValueAxis(unit), series: [{ type: "line", data: values, connectNulls: false }] });
    const axis = (chart as any).getModel().getComponent("yAxis").axis;
    return { labels: axis.getViewLabels().map((label: { tick: { value: number }; formattedLabel: string }) => ({ value: label.tick.value, text: label.formattedLabel })), svg: chart.renderToSVGString() };
  } finally { chart.dispose(); }
}

test("人均小数轴使用实际刻度精度，0.004及更小读数不会全部显示0", () => {
  for (const unit of ["元/人", "次/人", "分钟/人"]) {
    for (const values of [[0.004], [0.000004, 0.000009], [0.099, 0.101], [0.62101, 0.62103], [0, 0], [null, 0.004]]) {
      const { labels, svg } = renderedAxis(values, unit);
      expect(labels.length).toBeGreaterThan(1);
      expect(new Set(labels.map(label => label.text)).size).toBe(labels.length);
      for (const label of labels) {
        expect(Number(label.text.replaceAll(",", ""))).toBeCloseTo(label.value, 12);
        expect(svg).toContain(`>${label.text}</text>`);
      }
    }
  }
  expect(renderedAxis([0.004], "元/人").labels.some(label => label.text === "0.004")).toBe(true);
});

test("普通金额、人数、次数及百分比保留既定轴格式", () => {
  for (const unit of ["元", "USD", "人", "次", "%"]) {
    const { labels } = renderedAxis(unit === "%" ? [0, 0.4] : [0, 12000], unit);
    for (const label of labels) expect(label.text).toBe(unit === "%" ? `${(label.value * 100).toFixed(0)}%`
      : label.value.toLocaleString("zh-CN", { notation: "compact", maximumFractionDigits: 1 }));
  }
});

test("大小视口共享人均刻度与单位，零基线及图表高度不变", () => {
  const desktop = renderedAxis([0.004, 0.008], "元/人", 1024);
  const narrow = renderedAxis([0.004, 0.008], "元/人", 320);
  expect(narrow.labels).toEqual(desktop.labels);
  expect(narrow.labels[0]).toEqual({ value: 0, text: "0" });
  expect(narrow.svg).toContain("元/人");
  expect(narrow.svg).toContain('height="280"');
  expect(desktop.svg).toContain('height="280"');
});
