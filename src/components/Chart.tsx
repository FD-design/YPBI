import { useEffect, useRef, type CSSProperties } from "react";
import { init, use } from "echarts/core";
import { BarChart, FunnelChart, HeatmapChart, LineChart, PieChart, SankeyChart, ScatterChart, TreemapChart } from "echarts/charts";
import { AriaComponent, GridComponent, LegendComponent, TitleComponent, TooltipComponent, VisualMapComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { ECharts, EChartsCoreOption } from "echarts/core";
import { V13_CHART_BASE } from "../theme/chartTheme";

use([BarChart, FunnelChart, HeatmapChart, LineChart, PieChart, SankeyChart, ScatterChart, TreemapChart, AriaComponent, GridComponent, LegendComponent, TitleComponent, TooltipComponent, VisualMapComponent, CanvasRenderer]);

export type ChartOption = EChartsCoreOption;

export function escapeChartTooltipText(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function sanitizeChartTooltipHtml(value: unknown) {
  return escapeChartTooltipText(value).replace(/&lt;br\s*\/?&gt;/gi, "<br/>");
}

export function secureChartTooltipFormatter(formatter: (...args: any[]) => unknown) {
  return function securedTooltipFormatter(this: unknown, ...args: any[]) {
    const safeArgs = [...args];
    if (typeof safeArgs[2] === "function") {
      const originalCallback = safeArgs[2];
      safeArgs[2] = (ticket: unknown, value: unknown) => originalCallback(ticket, sanitizeChartTooltipHtml(value));
    }
    const value = formatter.apply(this, safeArgs);
    return value === undefined ? undefined : sanitizeChartTooltipHtml(value);
  };
}

export function secureChartTooltipStringFormatter(template: string) {
  const safeTemplate = sanitizeChartTooltipHtml(template);
  // ECharts substitutes values into string templates after receiving them. A
  // function wrapper returns the already-sanitized text directly, so tokens
  // such as {b} cannot inject an unescaped runtime name.
  return () => safeTemplate;
}

function safeTooltipColor(value: unknown) {
  const color = String(value ?? "");
  return /^(?:#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%]+\))$/i.test(color) ? color : "#4f7cff";
}

function formatTooltipValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "--";
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number.toLocaleString() : escapeChartTooltipText(value);
}

export function Chart({ option, onClick, ariaLabel, style, theme = "classic" }: { option: ChartOption; onClick?: (params: unknown) => void; ariaLabel?: string; style?: CSSProperties; theme?: "classic" | "v13" }) {
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
    const safeFormatter = sourceTooltip.trigger === "axis" && !sourceTooltip.formatter
      ? (params: any[]) => {
        const items = [...params].sort((left, right) => Number(right.value ?? 0) - Number(left.value ?? 0));
        const title = escapeChartTooltipText(items[0]?.axisValueLabel ?? items[0]?.name ?? "数据详情");
        const rows = items.map((item) => {
          const seriesName = escapeChartTooltipText(item.seriesName ?? "未命名系列");
          const color = safeTooltipColor(item.color);
          return `<div style="display:grid;grid-template-columns:10px minmax(92px,1fr) auto;gap:7px;align-items:center;min-width:0"><i style="width:7px;height:7px;border-radius:50%;background:${color};display:block"></i><span style="overflow:hidden;text-overflow:ellipsis" title="${seriesName}">${seriesName}</span><b style="font-variant-numeric:tabular-nums">${formatTooltipValue(item.value)}</b></div>`;
        }).join("");
        return `<div style="min-width:300px;max-width:500px"><strong style="display:block;margin-bottom:8px">${title}</strong><div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 16px">${rows}</div></div>`;
      }
      : typeof sourceTooltip.formatter === "function"
        ? secureChartTooltipFormatter(sourceTooltip.formatter)
        : typeof sourceTooltip.formatter === "string"
          ? secureChartTooltipStringFormatter(sourceTooltip.formatter)
          : sourceTooltip.formatter;
    instance.current?.setOption({
      ...(theme === "v13" ? V13_CHART_BASE : {}),
      ...option,
      tooltip: {
        ...sourceTooltip,
        formatter: safeFormatter,
        appendToBody: true,
        confine: false,
        extraCssText: "max-width:min(520px,calc(100vw - 32px));max-height:min(70vh,560px);overflow:auto;white-space:normal;z-index:99999;"
      },
      aria: { enabled: true, description: ariaLabel }
    }, { notMerge: true });
  }, [ariaLabel, option, theme]);
  useEffect(() => {
    const chart = instance.current;
    if (!chart || !onClick) return undefined;
    chart.on("click", onClick);
    return () => { chart.off("click", onClick); };
  }, [onClick]);

  return <div className="chart" ref={ref} role="img" aria-label={ariaLabel ?? "数据图表"} style={style} />;
}
