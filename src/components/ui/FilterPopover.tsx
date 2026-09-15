import { useEffect, useRef, useState, type ReactNode } from "react";
import { SlidersHorizontal } from "lucide-react";
import { Button } from "./Button";
import { FloatingHint } from "./FloatingHint";

export function FilterPopover({ children, active = false }: { children: ReactNode; active?: boolean }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    // A date dialog is portalled, but still belongs to this filter panel.
    const ownsModal = () => Array.from(root.current?.querySelectorAll('[aria-controls]') ?? []).some(control => {
      const target = document.getElementById(control.getAttribute("aria-controls") ?? "");
      return target instanceof HTMLDialogElement && target.open;
    });
    const outside = (event: PointerEvent) => { if (!ownsModal() && !root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented && !ownsModal() && !root.current?.querySelector('[role="listbox"]')) { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  return <div className="ui-filter-popover" ref={root}>
    <FloatingHint content="更多筛选"><button ref={trigger} type="button" className={`ui-icon-button${active ? " is-active" : ""}`} aria-label="更多筛选" aria-expanded={open} onClick={() => setOpen(value => !value)}><SlidersHorizontal aria-hidden="true" /></button></FloatingHint>
    {open && <section className="ui-filter-popover__panel" aria-label="更多筛选条件"><strong>更多筛选</strong>{children}<Button size="sm" onClick={() => { setOpen(false); trigger.current?.focus(); }}>完成</Button></section>}
  </div>;
}
