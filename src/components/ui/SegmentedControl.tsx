import { useRef } from "react";
import "./segmented-control.css";

export function SegmentedControl({ label, value, options, onChange }: {
  label: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  return <div ref={root} className="ui-segmented-control" role="radiogroup" aria-label={label}>
    {options.map((option, index) => <button key={option.value} type="button" role="radio" aria-checked={value === option.value} tabIndex={value === option.value ? 0 : -1} onClick={() => onChange(option.value)} onKeyDown={event => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (index + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : options.length - 1)) % options.length;
      onChange(options[next].value); root.current?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
    }}>{option.label}</button>)}
  </div>;
}
