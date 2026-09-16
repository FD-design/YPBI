export type ChangeDirection = "up" | "down" | "flat";

/** 数值方向用于展示；不推断业务评价，缺失及非有限数不产生方向。 */
export function changeDirection(value: number | null | undefined): ChangeDirection | null {
  if (value == null || !Number.isFinite(value)) return null;
  return value > 0 ? "up" : value < 0 ? "down" : "flat";
}

export function changeTextColor(direction: ChangeDirection | null, onEmphasis = false) {
  return `var(--color-change-${direction ?? "flat"}${onEmphasis ? "-on-emphasis" : ""})`;
}

/** ECharts HTML tooltip 与 React 共用方向和 Token；传入的文字始终转义。 */
export function changeValueHtml(value: number | null, display: string) {
  const direction = changeDirection(value);
  const escaped = display.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]!);
  return `<span data-change-direction="${direction ?? "unavailable"}" style="color:${changeTextColor(direction, true)}">${escaped}</span>`;
}
