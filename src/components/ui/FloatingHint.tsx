import { cloneElement, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type HTMLAttributes, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "./floating-hint.css";

/** Restoring the reading position is not a new request to open help. */
export function restoreReadingFocus(element: HTMLElement | null | undefined) {
  document.dispatchEvent(new CustomEvent("ui-hint-open", { detail: null }));
  if (!element?.isConnected) return;
  element.dataset.restoringFocus = "true";
  element.focus({ preventScroll: true });
  delete element.dataset.restoringFocus;
}

/** Shared help layer: measured positioning, independent typography and scroll clipping isolation. */
export function FloatingHint({ children, content, className = "", panelClassName = "", pinOnClick = false, style }: {
  children: ReactElement<HTMLAttributes<HTMLElement>>; content: ReactNode; className?: string; panelClassName?: string; pinOnClick?: boolean; style?: CSSProperties;
}) {
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reveal = () => { clearTimeout(timer.current); if (open) return; document.dispatchEvent(new CustomEvent("ui-hint-open", { detail: id })); setOpen(true); };
  const close = () => { clearTimeout(timer.current); setOpen(false); setPinned(false); };
  const leave = () => { if (!pinned) timer.current = setTimeout(() => setOpen(false), 120); };
  useLayoutEffect(() => {
    if (!open || !panel.current || !anchor.current) return;
    const element = panel.current;
    element.showPopover?.();
    const position = () => {
      const source = anchor.current?.getBoundingClientRect(); if (!source) return;
      const box = element.getBoundingClientRect();
      const left = Math.max(8, Math.min(source.left, window.innerWidth - box.width - 8));
      const below = source.bottom + 8;
      const top = below + box.height <= window.innerHeight - 8 ? below : Math.max(8, source.top - box.height - 8);
      element.style.left = `${left}px`; element.style.top = `${top}px`;
    };
    position(); const observer = new ResizeObserver(position); observer.observe(element);
    window.addEventListener("scroll", position, true); window.addEventListener("resize", position);
    return () => { observer.disconnect(); window.removeEventListener("scroll", position, true); window.removeEventListener("resize", position); element.hidePopover?.(); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: Event) => {
      if (event.type === "keydown" && (event as KeyboardEvent).key !== "Escape") return;
      if (event.type !== "keydown" && (panel.current?.contains(event.target as Node) || anchor.current?.contains(event.target as Node))) return;
      close();
    };
    document.addEventListener("keydown", dismiss); document.addEventListener("pointerdown", dismiss);
    return () => { document.removeEventListener("keydown", dismiss); document.removeEventListener("pointerdown", dismiss); };
  }, [open]);
  useEffect(() => {
    const supersede = (event: Event) => { if ((event as CustomEvent<string>).detail !== id) close(); };
    document.addEventListener("ui-hint-open", supersede);
    return () => document.removeEventListener("ui-hint-open", supersede);
  }, [id]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const trigger = cloneElement(children, { "aria-describedby": open ? id : undefined,
    onClick: (event) => { children.props.onClick?.(event); if (pinOnClick) { if (pinned) close(); else { reveal(); setPinned(true); } } else close(); }
  });
  return <span ref={anchor} style={style} className={`ui-hint ${className}`} onMouseMove={reveal} onMouseLeave={leave} onFocus={event => { const target = event.target as HTMLElement; if (!target.dataset.restoringFocus && target.matches(":focus-visible")) reveal(); }} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) close(); }}>
    {trigger}
    {open && createPortal(<div ref={panel} popover="manual" role="tooltip" id={id} className={`ui-hint-panel ${panelClassName}`} onMouseEnter={() => clearTimeout(timer.current)} onMouseLeave={leave}>{content}</div>, document.body)}
  </span>;
}
