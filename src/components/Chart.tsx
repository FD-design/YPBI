import { useEffect, useRef, type CSSProperties } from "react";
import { init, use } from "echarts/core";
import { BarChart, FunnelChart, HeatmapChart, LineChart, PieChart, SankeyChart, ScatterChart, TreemapChart } from "echarts/charts";
import { AriaComponent, GridComponent, LegendComponent, TitleComponent, TooltipComponent, VisualMapComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { ECharts, EChartsCoreOption } from "echarts/core";
import { V13_CHART_BASE } from "../theme/chartTheme";
import { changeTextColor } from "./ui/change-presentation";
import { standardChartAxes } from "./chart-axis";
import { axisSeriesTooltip, escapeChartTooltipText, readTrustedChartTooltipHtml } from "./chart-tooltip-content";

export { axisSeriesTooltip, escapeChartTooltipText } from "./chart-tooltip-content";

use([BarChart, FunnelChart, HeatmapChart, LineChart, PieChart, SankeyChart, ScatterChart, TreemapChart, AriaComponent, GridComponent, LegendComponent, TitleComponent, TooltipComponent, VisualMapComponent, CanvasRenderer]);

export type ChartOption = EChartsCoreOption;

export function sanitizeChartTooltipHtml(value: unknown) {
  // Only the exact shared directional token is markup; all external text stays escaped.
  const markup = /<br\s*\/?\s*>|<span data-change-direction="(up|down|flat|unavailable)" style="color:var\(--color-change-(up|down|flat)-on-emphasis\)">([^<]*)<\/span>/gi;
  const source = String(value ?? "");
  let cursor = 0, result = "";
  for (const match of source.matchAll(markup)) {
    result += escapeChartTooltipText(source.slice(cursor, match.index));
    if (!match[1]) result += "<br/>";
    else if ((match[1] === "unavailable" ? "flat" : match[1]) === match[2]) {
      const direction = match[1] as "up" | "down" | "flat" | "unavailable";
      const text = match[3].replace(/&(amp|lt|gt|quot|#39);/g, (_, entity: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[entity]!);
      result += `<span data-change-direction="${direction}" style="color:${changeTextColor(direction === "unavailable" ? null : direction, true)}">${escapeChartTooltipText(text)}</span>`;
    } else result += escapeChartTooltipText(match[0]);
    cursor = match.index! + match[0].length;
  }
  return result + escapeChartTooltipText(source.slice(cursor));
}

export function secureChartTooltipFormatter(formatter: (...args: any[]) => unknown) {
  const secure = (value: unknown) => readTrustedChartTooltipHtml(value) ?? sanitizeChartTooltipHtml(value);
  return function securedTooltipFormatter(this: unknown, ...args: any[]) {
    const safeArgs = [...args];
    if (typeof safeArgs[2] === "function") {
      const originalCallback = safeArgs[2];
      safeArgs[2] = (ticket: unknown, value: unknown) => originalCallback(ticket, secure(value));
    }
    const value = formatter.apply(this, safeArgs);
    return value === undefined ? undefined : secure(value);
  };
}

export function secureChartTooltipStringFormatter(template: string) {
  const safeTemplate = sanitizeChartTooltipHtml(template);
  // ECharts substitutes values into string templates after receiving them. A
  // function wrapper returns the already-sanitized text directly, so tokens
  // such as {b} cannot inject an unescaped runtime name.
  return () => safeTemplate;
}

export function chartTooltipPosition(point: number[], content: number[], bounds: { left: number; top: number }, viewport: number[]) {
  const margin = 16, gap = 12;
  const axis = (cursor: number, length: number, limit: number) => {
    const preferred = cursor + gap + length <= limit - margin ? cursor + gap : cursor - gap - length;
    return Math.max(margin, Math.min(preferred, limit - margin - length));
  };
  return [
    axis(bounds.left + point[0], content[0], viewport[0]) - bounds.left,
    axis(bounds.top + point[1], content[1], viewport[1]) - bounds.top
  ];
}

export function Chart({ option, onClick, onHover, ariaLabel, style, theme = "classic" }: { option: ChartOption; onClick?: (params: unknown) => void; onHover?: (params: unknown | null) => void; ariaLabel?: string; style?: CSSProperties; theme?: "classic" | "v13" }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const instance = useRef<ECharts | null>(null);

  useEffect(() => {
    if (!ref.current) return undefined;
    instance.current = init(ref.current);
    const resize = () => instance.current?.resize();
    const observer = new ResizeObserver(resize);
    observer.observe(ref.current);
    window.addEventListener("resize", resize);
    const hideTooltip = () => instance.current?.dispatchAction({ type: "hideTip" });
    window.addEventListener("scroll", hideTooltip, true);
    return () => {
      window.removeEventListener("resize", resize);
      window.removeEventListener("scroll", hideTooltip, true);
      observer.disconnect();
      instance.current?.dispose();
      instance.current = null;
    };
  }, []);

  useEffect(() => {
    const sourceTooltip: any = option.tooltip && !Array.isArray(option.tooltip) ? option.tooltip : {};
    const safeFormatter = sourceTooltip.trigger === "axis" && !sourceTooltip.formatter
      ? (params: any[]) => axisSeriesTooltip(params, sourceTooltip)
      : typeof sourceTooltip.formatter === "function"
        ? secureChartTooltipFormatter(sourceTooltip.formatter)
        : typeof sourceTooltip.formatter === "string"
          ? secureChartTooltipStringFormatter(sourceTooltip.formatter)
          : sourceTooltip.formatter;
    instance.current?.setOption({
      ...(theme === "v13" ? V13_CHART_BASE : {}),
      ...(theme === "v13" ? standardChartAxes(option) : option),
      tooltip: {
        ...sourceTooltip,
        formatter: safeFormatter,
        ...(theme === "v13" && ref.current ? { backgroundColor: getComputedStyle(ref.current).getPropertyValue("--chart-tooltip-bg").trim(), borderWidth: 0, textStyle: { color: getComputedStyle(ref.current).getPropertyValue("--color-text-on-emphasis").trim(), fontSize: parseFloat(getComputedStyle(ref.current).getPropertyValue("--font-size-body")) } } : {}),
        appendToBody: true,
        hideDelay: 0,
        transitionDuration: 0,
        confine: false,
        position: (point: number[], _params: unknown, _dom: unknown, _rect: unknown, size: { contentSize: number[] }) => {
          const bounds = ref.current?.getBoundingClientRect();
          return bounds ? chartTooltipPosition(point, size.contentSize, bounds, [window.innerWidth, window.innerHeight]) : point;
        },
        className: theme === "v13" ? "ui-chart-tooltip" : sourceTooltip.className,
        extraCssText: "max-width:min(380px,calc(100vw - 32px));max-height:min(70vh,560px);overflow:auto;white-space:normal;z-index:99999;"
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

  useEffect(() => {
    const chart = instance.current;
    if (!chart || !onHover) return;
    const leave = () => onHover(null);
    chart.on("mouseover", onHover);
    chart.on("globalout", leave);
    return () => { chart.off("mouseover", onHover); chart.off("globalout", leave); };
  }, [onHover]);

  return <div className="chart" ref={ref} role="img" aria-label={ariaLabel ?? "数据图表"} style={style} />;
}
