// ECharts 的 Canvas 渲染器不能直接解析 CSS custom properties，因此这里只保留
// 图表色板的运行时投影；theme-tokens.test.ts 会阻止它与 tokens.css 漂移。
export const CHART_PALETTE = ["#285FE8", "#007A8A", "#6D57C7", "#A65F00", "#117A4F", "#526DA4"] as const;

export const CHART_LINE_STYLES = [
  { type: "solid", symbol: "circle" },
  { type: "dashed", symbol: "rect" },
  { type: "dotted", symbol: "triangle" },
  { type: "solid", symbol: "diamond" },
  { type: "dashed", symbol: "roundRect" },
  { type: "dotted", symbol: "pin" }
] as const;
