import { useId } from "react";
import "./tab-list.css";

export function TabList({ label, value, items, onChange, panelId, idPrefix }: { label: string; value: string; items: { id: string; label: string }[]; onChange: (value: string) => void; panelId: string; idPrefix?: string }) {
  const generatedId = useId(), prefix = idPrefix ?? generatedId;
  return <div className="ui-tab-list" role="tablist" aria-label={label}>{items.map((item, index) => <button key={item.id} id={`${prefix}-${item.id}`} type="button" role="tab" aria-controls={panelId} aria-selected={value === item.id} tabIndex={value === item.id ? 0 : -1} onClick={() => onChange(item.id)} onKeyDown={event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowRight" ? 1 : items.length - 1)) % items.length;
    onChange(items[next].id); document.getElementById(`${prefix}-${items[next].id}`)?.focus();
  }}>{item.label}</button>)}</div>;
}
