import { CHART_LINE_STYLES, CHART_PALETTE } from "./tokens";

export function v13SeriesStyle(index: number) {
  const style = CHART_LINE_STYLES[index % CHART_LINE_STYLES.length];
  return {
    color: CHART_PALETTE[index % CHART_PALETTE.length],
    lineStyle: { type: style.type, width: 2 },
    symbol: style.symbol,
    symbolSize: 7,
    showSymbol: false
  } as const;
}

export const V13_CHART_BASE = {
  color: [...CHART_PALETTE],
  textStyle: {
    color: "#5E6673",
    fontFamily: 'Inter, "PingFang SC", "Microsoft YaHei", sans-serif',
    fontSize: 12
  }
};
