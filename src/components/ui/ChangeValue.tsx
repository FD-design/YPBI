import type { ReactNode } from "react";
import { changeTextColor, type ChangeDirection } from "./change-presentation";

/** 颜色只覆盖差异值，父级保留周期、说明与排版。 */
export function ChangeValue({ direction, children, onEmphasis = false }: {
  direction: ChangeDirection | null;
  children: ReactNode;
  onEmphasis?: boolean;
}) {
  return <span
    data-change-direction={direction ?? "unavailable"}
    style={{ color: changeTextColor(direction, onEmphasis) }}
  >{children}</span>;
}
