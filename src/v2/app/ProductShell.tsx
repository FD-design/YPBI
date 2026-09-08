import { ChevronRight, Menu, PanelsTopLeft, RotateCcw, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useBodyScrollLock } from "../../components/layout/useBodyScrollLock";
import { activeNavigationId, PRODUCT_NAVIGATION, routeArea, routeTitle } from "./navigation";
import { ProductLink, useBrowserLocation } from "./router";

function V2Mark() {
  return <span className="v2-brand-mark" aria-hidden="true">
    <svg viewBox="0 0 24 30" fill="none"><path d="M3 5.5 12 15v10" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/><path d="m21 5.5-9 9.5" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/><path d="m17.1 9.6-5.1 5.4" stroke="var(--color-brand-600)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/></svg>
  </span>;
}

export function ProductShell({ children }: { children: ReactNode }) {
  const location = useBrowserLocation();
  const activeId = activeNavigationId(location.pathname);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [mobileNavigation, setMobileNavigation] = useState(() => window.matchMedia("(max-width: 767px)").matches);
  const navigationRef = useRef<HTMLElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  useBodyScrollLock(navigationOpen);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 767px)");
    const update = () => setMobileNavigation(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!mobileNavigation) setNavigationOpen(false);
  }, [mobileNavigation]);

  useEffect(() => setNavigationOpen(false), [location.key]);

  useEffect(() => {
    if (!navigationOpen) return undefined;
    const navigation = navigationRef.current;
    const focusable = () => [...(navigation?.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), [tabindex]:not([tabindex="-1"])') ?? [])]
      .filter((element) => element.getClientRects().length > 0);
    window.requestAnimationFrame(() => focusable()[0]?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setNavigationOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0];
      const last = items.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      menuButtonRef.current?.focus();
    };
  }, [navigationOpen]);

  return <div className="ypbi-v2">
    <a className="v2-skip-link" href="#v2-main-content">跳到主要内容</a>
    <header className="v2-topbar">
      <div className="v2-topbar-brand">
        <button ref={menuButtonRef} type="button" className="v2-icon-button v2-menu-button" aria-label="打开主导航" aria-expanded={navigationOpen} aria-controls="v2-primary-navigation" onClick={() => setNavigationOpen(true)}><Menu aria-hidden="true" /></button>
        <ProductLink className="v2-brand" href="/data/metrics" aria-label="YPBI 指标中心"><V2Mark /><span>YPBI</span></ProductLink>
      </div>
      <nav className="v2-breadcrumb" aria-label="当前位置">
        <span>{routeArea(location.pathname)}</span><ChevronRight aria-hidden="true" /><b>{routeTitle(location.pathname)}</b>
      </nav>
      <div className="v2-topbar-actions">
        <a className="v2-classic-link" href="/?workspace=templates&ui=v13" aria-label="返回经典版"><RotateCcw aria-hidden="true" /><span>返回经典版</span></a>
      </div>
    </header>

    <button type="button" className={`v2-nav-backdrop${navigationOpen ? " is-open" : ""}`} aria-label="关闭主导航" tabIndex={navigationOpen ? 0 : -1} onClick={() => setNavigationOpen(false)} />
    <aside
      ref={navigationRef}
      id="v2-primary-navigation"
      className={`v2-sidebar${navigationOpen ? " is-open" : ""}`}
      role={mobileNavigation && navigationOpen ? "dialog" : undefined}
      aria-modal={mobileNavigation && navigationOpen ? "true" : undefined}
      aria-labelledby={mobileNavigation && navigationOpen ? "v2-navigation-title" : undefined}
      aria-label={mobileNavigation && navigationOpen ? undefined : "产品主导航"}
      aria-hidden={mobileNavigation && !navigationOpen ? "true" : undefined}
      inert={mobileNavigation && !navigationOpen ? true : undefined}
    >
      <div className="v2-sidebar-mobile-head"><span id="v2-navigation-title">产品导航</span><button type="button" className="v2-icon-button" aria-label="关闭主导航" onClick={() => setNavigationOpen(false)}><X aria-hidden="true" /></button></div>
      <nav>
        {PRODUCT_NAVIGATION.map((group) => <section key={group.label} className="v2-nav-group">
          <h2>{group.label}</h2>
          {group.items.map(({ id, label, description, href, icon: Icon }) => {
            const active = activeId === id;
            return <ProductLink key={id} className={active ? "is-active" : ""} href={href} aria-current={active ? "page" : undefined}>
              <Icon aria-hidden="true" />
              <span><b>{label}</b><small>{description}</small></span>
            </ProductLink>;
          })}
        </section>)}
      </nav>
      <div className="v2-sidebar-note"><PanelsTopLeft aria-hidden="true" /><span><b>首批只读切片</b><small>当前仅开放指标目录与 M016 分析</small></span></div>
    </aside>

    <main id="v2-main-content" className="v2-main" tabIndex={-1}>{children}</main>
  </div>;
}
