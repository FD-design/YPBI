import { useEffect, useRef, useState, type RefObject } from "react";
import { Button } from "../../../components/ui/Button";
import { MenuSelect } from "../../../components/ui/MenuSelect";
import "./DashboardSectionNavigation.css";

const headings = ".dashboard-section-title,.dashboard-panel__title";
const excluded = '.dashboard-metric-card,dialog,[role="dialog"],.dashboard-section-navigation';

export interface DashboardSectionTarget { label: string; element: HTMLElement }
interface NavigationItem extends DashboardSectionTarget { id: string }

function visibleHeading(element: HTMLElement) {
  if (element.closest(excluded)) return false;
  for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor.hidden || ancestor.hasAttribute("inert") || ancestor.getAttribute("aria-hidden") === "true"
      || ancestor.tagName === "DETAILS" && !ancestor.hasAttribute("open")) return false;
    const style = ancestor.ownerDocument.defaultView?.getComputedStyle(ancestor);
    if (style?.display === "none" || style?.visibility === "hidden" || style?.visibility === "collapse") return false;
  }
  return true;
}

/** Existing outer section headings own any panels nested inside their section. */
export function collectDashboardSections(page: HTMLElement): DashboardSectionTarget[] {
  const sections: (DashboardSectionTarget & { owner: HTMLElement })[] = [];
  for (const element of page.querySelectorAll<HTMLElement>(headings)) {
    const label = element.textContent?.replace(/\s+/g, " ").trim() ?? "";
    if (!label || !visibleHeading(element)) continue;
    const owner = element.closest<HTMLElement>("section,article") ?? element.parentElement ?? element;
    if (sections.some(section => section.owner.contains(owner))) continue;
    sections.push({ label, element, owner });
  }
  return sections.map(({ label, element }) => ({ label, element }));
}

function elementFor(node: Node): Element | null {
  return node.nodeType === 1 ? node as Element : node.parentElement;
}

function containsHeading(node: Node) {
  const element = node.nodeType === 1 ? node as Element : null;
  return Boolean(element && !element.closest(excluded) && (element.matches(headings) || element.querySelector(headings)));
}

/** Numeric text, charts and table rows cannot trigger a page inventory scan. */
export function dashboardSectionMutationRelevant(record: MutationRecord, current: readonly DashboardSectionTarget[] = []) {
  const target = elementFor(record.target);
  if (!target || target.closest(excluded)) return false;
  if (target.closest(headings)) return true;
  if (record.type === "attributes") return containsHeading(target) || current.some(section => target.contains(section.element));
  return record.type === "childList" && [...record.addedNodes, ...record.removedNodes].some(containsHeading);
}

export function scrollToDashboardSection(element: HTMLElement, reducedMotion: boolean) {
  if (!element.isConnected || !visibleHeading(element)) return () => {};
  const hadTabIndex = element.hasAttribute("tabindex");
  if (!hadTabIndex) element.setAttribute("tabindex", "-1");
  element.scrollIntoView({ block: "start", inline: "nearest", behavior: reducedMotion ? "instant" : "smooth" });
  element.focus({ preventScroll: true });
  const cleanup = () => {
    element.removeEventListener("blur", cleanup);
    if (!hadTabIndex && element.getAttribute("tabindex") === "-1") element.removeAttribute("tabindex");
  };
  element.addEventListener("blur", cleanup, { once: true });
  return cleanup;
}

export function DashboardSectionNavigationControls({ items, mobile, value, onNavigate }: {
  items: readonly { id: string; label: string }[]; mobile: boolean; value: string; onNavigate: (id: string) => void;
}) {
  if (items.length < 3) return null;
  return <nav className="dashboard-section-navigation" aria-label="本页区块">
    {mobile ? <MenuSelect label="定位区块" density="compact" value={value} placeholder="选择区块"
      groups={[{ label: "本页区块", options: items.map(item => ({ value: item.id, label: item.label })) }]} onChange={onNavigate} />
      : <><span className="dashboard-section-navigation__label">定位区块</span>{items.map(item => <Button key={item.id} type="button" variant="ghost" size="sm" onClick={() => onNavigate(item.id)}>{item.label}</Button>)}</>}
  </nav>;
}

/** Header opt-in; navigation changes only this page's reading position. */
export function DashboardSectionNavigation({ headerRef }: { headerRef: RefObject<HTMLElement | null> }) {
  const [items, setItems] = useState<NavigationItem[]>([]);
  const [mobile, setMobile] = useState(false);
  const [selected, setSelected] = useState("");
  const inventory = useRef<NavigationItem[]>([]);
  const frames = useRef<number[]>([]);
  const focusCleanup = useRef<(() => void) | null>(null);

  useEffect(() => {
    const page = headerRef.current?.closest<HTMLElement>(".v2-page");
    if (!page) return;
    const view = page.ownerDocument.defaultView;
    if (!view) return;
    const keys = new WeakMap<HTMLElement, string>();
    let nextKey = 0, scanFrame: number | null = null;
    const collect = () => {
      const next = collectDashboardSections(page).map(section => {
        let id = keys.get(section.element);
        if (!id) { id = `section-${nextKey++}`; keys.set(section.element, id); }
        return { ...section, id };
      });
      const prior = inventory.current;
      if (prior.length === next.length && next.every((item, i) => item.element === prior[i].element && item.label === prior[i].label)) return;
      inventory.current = next;
      setItems(next);
    };
    collect();
    const observer = new MutationObserver(records => {
      if (scanFrame !== null || !records.some(record => dashboardSectionMutationRelevant(record, inventory.current))) return;
      scanFrame = view.requestAnimationFrame(() => { scanFrame = null; collect(); });
    });
    observer.observe(page, { childList: true, characterData: true, subtree: true, attributes: true,
      attributeFilter: ["hidden", "aria-hidden", "inert", "open", "class", "style"] });
    const media = view.matchMedia("(max-width: 767px)");
    const responsive = () => setMobile(media.matches);
    responsive();
    media.addEventListener("change", responsive);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", responsive);
      if (scanFrame !== null) view.cancelAnimationFrame(scanFrame);
      frames.current.forEach(frame => view.cancelAnimationFrame(frame));
      frames.current = [];
      focusCleanup.current?.();
      focusCleanup.current = null;
    };
  }, [headerRef]);

  const navigate = (id: string) => {
    const item = inventory.current.find(section => section.id === id), view = item?.element.ownerDocument.defaultView;
    if (!item || !view) return;
    setSelected(id);
    frames.current.forEach(frame => view.cancelAnimationFrame(frame));
    // MenuSelect restores its trigger first; the subsequent frame moves focus
    // and reading position together instead of scrolling back to the header.
    frames.current = [view.requestAnimationFrame(() => {
      frames.current = [view.requestAnimationFrame(() => {
        frames.current = [];
        if (!inventory.current.some(section => section.element === item.element)) return;
        focusCleanup.current?.();
        focusCleanup.current = scrollToDashboardSection(item.element, view.matchMedia("(prefers-reduced-motion: reduce)").matches);
      })];
    })];
  };
  return <DashboardSectionNavigationControls items={items} mobile={mobile} value={items.some(item => item.id === selected) ? selected : ""} onNavigate={navigate} />;
}
