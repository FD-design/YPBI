import { useEffect, useRef, type CSSProperties } from "react";
import { init, use } from "echarts/core";
import { BarChart, FunnelChart, HeatmapChart, LineChart, PieChart, SankeyChart, ScatterChart, TreemapChart } from "echarts/charts";
import { AriaComponent, GridComponent, LegendComponent, TitleComponent, TooltipComponent, VisualMapComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { ECharts, EChartsCoreOption } from "echarts/core";

use([BarChart, FunnelChart, HeatmapChart, LineChart, PieChart, SankeyChart, ScatterChart, TreemapChart, AriaComponent, GridComponent, LegendComponent, TitleComponent, TooltipComponent, VisualMapComponent, CanvasRenderer]);

export type ChartOption = EChartsCoreOption;

export function Chart({ option, onClick, ariaLabel, style }: { option: ChartOption; onClick?: (params: unknown) => void; ariaLabel?: string; style?: CSSProperties }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const instance = useRef<ECharts | null>(null);

  useEffect(() => {
    if (!ref.current) return undefined;
    instance.current = init(ref.current);
    const resize = () => instance.current?.resize();
    const observer = new ResizeObserver(resize);
    observer.observe(ref.current);
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      observer.disconnect();
      instance.current?.dispose();
      instance.current = null;
    };
  }, []);

  useEffect(() => {
    const sourceTooltip: any = option.tooltip && !Array.isArray(option.tooltip) ? option.tooltip : {};
    const axisFormatter = sourceTooltip.trigger === "axis" && !sourceTooltip.formatter
      ? (params: any[]) => {
        const items = [...params].sort((left, right) => Number(right.value ?? 0) - Number(left.value ?? 0));
        const title = items[0]?.axisValueLabel ?? items[0]?.name ?? "数据详情";
        const rows = items.map((item) => `<div style="display:grid;grid-template-columns:10px minmax(92px,1fr) auto;gap:7px;align-items:center;min-width:0"><i style="width:7px;height:7px;border-radius:50%;background:${item.color};display:block"></i><span style="overflow:hidden;text-overflow:ellipsis" title="${item.seriesName}">${item.seriesName}</span><b style="font-variant-numeric:tabular-nums">${item.value == null ? "--" : Number(item.value).toLocaleString()}</b></div>`).join("");
        return `<div style="min-width:300px;max-width:500px"><strong style="display:block;margin-bottom:8px">${title}</strong><div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 16px">${rows}</div></div>`;
      }
      : sourceTooltip.formatter;
    instance.current?.setOption({
      ...option,
      tooltip: {
        ...sourceTooltip,
        formatter: axisFormatter,
        appendToBody: true,
        confine: false,
        extraCssText: "max-width:min(520px,calc(100vw - 32px));max-height:min(70vh,560px);overflow:auto;white-space:normal;z-index:99999;"
      },
      aria: { enabled: true, description: ariaLabel }
    }, { notMerge: true });
  }, [ariaLabel, option]);
  useEffect(() => {
    const chart = instance.current;
    if (!chart || !onClick) return undefined;
    chart.on("click", onClick);
    return () => { chart.off("click", onClick); };
  }, [onClick]);

  return <div className="chart" ref={ref} role="img" aria-label={ariaLabel ?? "数据图表"} style={style} />;
}
