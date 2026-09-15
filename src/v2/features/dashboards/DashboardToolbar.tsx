import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { DashboardCardModeControl } from "./DashboardCardMode";
import { LiveHeaderExportContext, useLiveDashboard } from "./LiveDashboardContext";
import type { DateRangeValue } from "../../../components/ui/date-range-model";

function withAction(node: ReactNode, action: () => void): ReactNode {
  if (!isValidElement(node)) return node;
  const element = node as ReactElement<{ onClick?: (...args: unknown[]) => void; children?: ReactNode }>;
  if (!element.props.onClick && element.type !== "button") {
    return cloneElement(element, { children: isValidElement(element.props.children) ? withAction(element.props.children, action) : Children.map(element.props.children, child => withAction(child, action)) });
  }
  return cloneElement(element, { onClick: (...args: unknown[]) => { element.props.onClick?.(...args); action(); } });
}

function samePresentation(target: ReactNode, source: ReactNode) {
  if (!isValidElement(target) || !isValidElement(source)) return target;
  const original = source as ReactElement<{ className?: string; align?: "start" | "end" }>;
  const connected = target as ReactElement<{ className?: string }>;
  return cloneElement(target as ReactElement<{ className?: string; align?: "start" | "end" }>, {
    ...(original.props.className ? { className: [original.props.className, connected.props.className].filter(Boolean).join(" ") } : {}),
    ...(original.props.align ? { align: original.props.align } : {})
  });
}

/** Slot order is shared; capability and responsive visibility remain with each query. */
export function DashboardQueryFields({ date, scope, filters, comparison, apply }: {
  date: ReactNode; scope?: ReactNode; filters?: ReactNode; comparison?: ReactNode; apply: ReactNode;
}) {
  const live = useLiveDashboard();
  if (!live?.metricIds.length) return <>{date}{scope}{filters}{comparison}{apply}</>;
  let connectedDate = samePresentation(live.controls.date, date), connectedComparison = samePresentation(live.controls.comparison, comparison);
  if (isValidElement(connectedDate) && isValidElement(date)) {
    const source = date as ReactElement<{ onChange?: (value: DateRangeValue) => void; maxDate?: string; minDate?: string; maxDays?: number }>;
    const target = connectedDate as ReactElement<{ onChange: (value: DateRangeValue) => void }>;
    connectedDate = cloneElement(target, { onChange: value => {
      target.props.onChange(value);
      if (live.controls.acceptsSharedRange(value)) source.props.onChange?.(value);
    } });
  }
  if (isValidElement(connectedComparison) && isValidElement(comparison)) {
    const source = comparison as ReactElement<{ onChange?: (value: string) => void }>;
    const target = connectedComparison as ReactElement<{ onChange: (value: string) => void }>;
    connectedComparison = cloneElement(target, { onChange: value => { source.props.onChange?.(value); target.props.onChange(value); } });
  }
  return <>{connectedDate}{samePresentation(live.controls.scope, scope)}{filters}{connectedComparison}{withAction(apply, live.controls.apply)}</>;
}

export function DashboardActions({ favorite, copyLink, refresh, fullscreen, exportAction }: {
  favorite?: ReactNode; copyLink?: ReactNode; refresh?: ReactNode; fullscreen?: ReactNode; exportAction?: ReactNode;
}) {
  const live = useLiveDashboard();
  return <><DashboardCardModeControl />{favorite}{copyLink}{live ? withAction(refresh, live.retry) : refresh}{fullscreen}<LiveHeaderExportContext.Provider value={Boolean(live)}>{exportAction}</LiveHeaderExportContext.Provider></>;
}
