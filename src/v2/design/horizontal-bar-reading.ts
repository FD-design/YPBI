import { V13_CHART_BASE } from "../../theme/chartTheme";

/**
 * Shared reading treatment for horizontal category bars in the V2 review boards.
 * Only the current series receives a fixed end value; comparison and calculation
 * details stay in the tooltip and exact table.
 */
export const HORIZONTAL_BAR_GRID = {
  left: 145,
  right: 104,
  top: 20,
  bottom: 35
} as const;

export function horizontalBarEndLabel(format: (value: number | null) => string) {
  return {
    show: true,
    position: "right" as const,
    distance: 7,
    color: V13_CHART_BASE.textStyle.color,
    fontFamily: V13_CHART_BASE.textStyle.fontFamily,
    fontSize: V13_CHART_BASE.textStyle.fontSize,
    formatter: (params: { value?: unknown }) => {
      const value = typeof params.value === "number" && Number.isFinite(params.value) ? params.value : null;
      return format(value);
    }
  };
}
