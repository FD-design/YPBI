import { useId } from "react";
import "./card-view-switch.css";
export type CardView = "trend" | "bar" | "table";
export function CardViewSwitch({ value, onChange, label }: { value: CardView; onChange: (value: CardView) => void; label: string }) {
  const id = useId();
  const views: { value: CardView; label: string }[] = [{ value: "trend", label: "折线" }, { value: "bar", label: "柱状" }, { value: "table", label: "表格" }];
  return <div className="ui-card-view-switch" role="tablist" aria-label={`${label}阅读视图`}>{views.map((view, index) => <button id={`${id}-${view.value}`} type="button" role="tab" key={view.value} aria-selected={value === view.value} tabIndex={value === view.value ? 0 : -1} onClick={() => onChange(view.value)} onKeyDown={event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? views.length - 1 : (index + (event.key === "ArrowRight" ? 1 : views.length - 1)) % views.length;
    onChange(views[next].value); document.getElementById(`${id}-${views[next].value}`)?.focus();
  }}>{view.label}</button>)}</div>;
}
