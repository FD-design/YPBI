export const CHART_PALETTE = ["#285FE8", "#007A8A", "#6D57C7", "#A65F00", "#117A4F", "#526DA4"] as const;

export const CHART_LINE_STYLES = [
  { type: "solid", symbol: "circle" },
  { type: "dashed", symbol: "rect" },
  { type: "dotted", symbol: "triangle" },
  { type: "solid", symbol: "diamond" },
  { type: "dashed", symbol: "roundRect" },
  { type: "dotted", symbol: "pin" }
] as const;

export const UI_TOKENS = {
  brand: "#285FE8",
  textPrimary: "#1F2329",
  textSecondary: "#5E6673",
  textTertiary: "#6B7280",
  pageBackground: "#F5F7FA",
  surface: "#FFFFFF",
  border: "#E5E9F0",
  success: "#117A4F",
  warning: "#A65F00",
  danger: "#C62832"
} as const;
