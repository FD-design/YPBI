import type { ChartOption } from "../../../components/Chart";
import { comparisonTooltip, singleSeriesTooltip } from "../../../components/chart-tooltip-content";
import { CHART_PALETTE } from "../../../theme/tokens";
import { chartValueExtent } from "../../../components/chart-axis";

export interface DetailedTrendData {
  kind: "line" | "bar";
  unit: string;
  dates: string[];
  values: (number | null)[];
  comparison?: { dates: string[]; values: (number | null)[] } | null;
}

/** Presentation only. Values, dates and period aggregation belong to the caller. */
export function detailedTrendOption(data: DetailedTrendData): ChartOption {
  const ratio = data.unit === "%" || data.unit === "比例";
  const plotValues = (values: (number | null)[]) => values.map(value => value === null ? null : ratio ? Number((value * 100).toFixed(6)) : value);
  const current = plotValues(data.values);
  const compare = data.comparison ? plotValues(data.comparison.values) : null;
  const isBar = data.kind === "bar";
  const extent = chartValueExtent([...current, ...(compare ?? [])], isBar, ratio ? 0 : 1);
  const series = (name: string, values: (number | null)[], previous: boolean) => ({
    name, type: data.kind, data: values, connectNulls: false, showSymbol: data.dates.length <= 31,
    symbol: previous ? "emptyCircle" : "circle", symbolSize: 5,
    barMaxWidth: 22, barGap: "25%",
    lineStyle: { width: previous ? 1.5 : 2, type: previous ? "dashed" : "solid" },
    itemStyle: { color: previous ? "#7186b7" : CHART_PALETTE[0], ...(isBar ? { borderRadius: [2, 2, 0, 0], opacity: previous ? .7 : 1 } : {}) }
  });
  return {
    animation: false,
    grid: { left: 8, right: 12, top: 16, bottom: 44, containLabel: true },
    tooltip: { trigger: "axis", axisPointer: { type: isBar ? "shadow" : "line" }, formatter: (params: any) => {
      const index = Number((Array.isArray(params) ? params[0] : params)?.dataIndex ?? 0);
      const date = data.dates[index];
      if (compare && data.comparison) return comparisonTooltip({ currentDate: date, currentValue: current[index], comparisonDate: data.comparison.dates[index], comparisonValue: compare[index], unit: ratio ? "%" : data.unit, differenceUnit: ratio ? "个百分点" : data.unit });
      return singleSeriesTooltip(date, current[index], ratio ? "%" : data.unit);
    } },
    legend: { bottom: 0, right: 8, selectedMode: false, itemWidth: 14, itemHeight: 8, textStyle: { fontSize: 11 }, data: compare ? ["当前期", "对比期"] : ["当前期"] },
    xAxis: { type: "category", data: data.dates.map(date => date.slice(5)), boundaryGap: isBar || data.dates.length === 1, axisTick: { show: false }, axisLine: { show: false }, axisLabel: { fontSize: 11, interval: data.dates.length <= 7 ? 0 : "auto", hideOverlap: true, showMinLabel: true, showMaxLabel: true } },
    yAxis: { type: "value", scale: !isBar, min: extent?.min, max: extent?.max, interval: extent?.interval, minInterval: ratio ? undefined : 1, splitNumber: 3, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { fontSize: 11, formatter: (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 6 }) + (ratio ? "%" : "") }, splitLine: { lineStyle: { color: "#edf0f4" } } },
    series: [...(compare ? [series("对比期", compare, true)] : []), series("当前期", current, false)]
  };
}
