import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ProductNavigationGroup } from "./navigation";
import { ProductLink, useBrowserLocation } from "./router";

/** 全局导航与窄屏目录共用 navigation.ts，展开只改变导航状态。 */
export function ProductTopNavigation({ groups, activeId, secondaryId }: {
  groups: ProductNavigationGroup[]; activeId: string | null; secondaryId: string | null;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const root = useRef<HTMLElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const location = useBrowserLocation();
  const cancel = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  const close = () => { cancel(); setOpen(null); };
  const focusItem = (id: string, last = false) => window.requestAnimationFrame(() => {
    const links = root.current?.querySelectorAll<HTMLAnchorElement>(`#top-navigation-${id} a`);
    (last ? links?.[links.length - 1] : links?.[0])?.focus();
  });
  useEffect(() => { close(); }, [location.key]);
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      root.current?.querySelector<HTMLButtonElement>(`[aria-controls="top-navigation-${open}"]`)?.focus();
      close();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [open]);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) close(); };
    document.addEventListener("pointerdown", outside);
    return () => { cancel(); document.removeEventListener("pointerdown", outside); };
  }, []);

  return <nav ref={root} className="v2-top-navigation" aria-label="产品主导航"
    onBlur={(event) => { if (open && !event.currentTarget.contains(event.relatedTarget as Node)) close(); }}>
    {groups.flatMap((group) => group.items).map((item) => <div className="v2-top-navigation__item" key={item.id}
      onBlur={(event) => { if (open === item.id && !event.currentTarget.contains(event.relatedTarget as Node)) close(); }}
      onPointerEnter={(event) => { if (event.pointerType === "touch") return; cancel(); if (item.children?.length) timer.current = setTimeout(() => setOpen(item.id), 200); }}
      onPointerLeave={(event) => { if (event.pointerType === "touch") return; cancel(); timer.current = setTimeout(() => setOpen(null), 250); }}>
      {item.children?.length ? <>
        <button type="button" className={activeId === item.id ? "is-active" : ""}
          aria-expanded={open === item.id} aria-controls={`top-navigation-${item.id}`}
          onClick={() => { cancel(); setOpen(open === item.id ? null : item.id); }}
          onKeyDown={(event) => {
            if (["ArrowDown", "ArrowUp"].includes(event.key)) {
              event.preventDefault(); cancel(); setOpen(item.id); focusItem(item.id, event.key === "ArrowUp");
            }
          }}>{item.label}<ChevronDown aria-hidden="true" /></button>
        <div id={`top-navigation-${item.id}`} className="v2-top-navigation__popover" hidden={open !== item.id}
          onKeyDown={(event) => {
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const links = [...event.currentTarget.querySelectorAll<HTMLAnchorElement>("a")];
            const index = links.indexOf(document.activeElement as HTMLAnchorElement);
            const next = event.key === "Home" ? 0 : event.key === "End" ? links.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + links.length) % links.length;
            links[next]?.focus();
          }}>
          {item.children.map((child) => <ProductLink key={child.id} href={child.href} aria-label={child.label} aria-current={secondaryId === child.id ? "page" : undefined}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              root.current?.querySelector<HTMLButtonElement>(`[aria-controls="top-navigation-${item.id}"]`)?.focus();
              close();
            }}>
            <b>{child.label}</b><small>{child.description}</small>
          </ProductLink>)}
        </div>
      </> : <ProductLink className={activeId === item.id ? "is-active" : ""} href={item.href} aria-current={activeId === item.id ? "page" : undefined}>{item.label}</ProductLink>}
    </div>)}
  </nav>;
}
