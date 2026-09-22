import { ChevronDown, ChevronRight, KeyRound, LoaderCircle, LogOut, Menu, PanelsTopLeft, UserRound, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useBodyScrollLock } from "../../components/layout/useBodyScrollLock";
import { activeNavigationId, activeSecondaryNavigationId, normalizeProductPath, PRODUCT_NAVIGATION, routeArea, routeTitle } from "./navigation";
import { ProductLink, useBrowserLocation } from "./router";
import { useAuthentication } from "./AuthProvider";
import { AuthRequestError } from "../api/auth";
import { PasswordForm } from "../pages/AuthenticationPages";
import { BrandLogo } from "../components/BrandLogo";
import { ReviewToolsMenuItem } from "../components/ReviewTools";
import { ProductTopNavigation } from "./ProductTopNavigation";
import "./product-shell-navigation.css";
import { useDataEnvironment } from "./DataEnvironmentProvider";
import { internalPreviewEnabled } from "./internal-preview";

export function ProductShell({ children, contextualNavigation = false, previewDataSourceEntry = false, navigationHref = (href: string) => href }: { children: ReactNode; contextualNavigation?: boolean; previewDataSourceEntry?: boolean; navigationHref?: (href: string) => string }) {
  const { state, logout } = useAuthentication();
  if (state.status !== "authenticated") throw new Error("ProductShell requires an authenticated session");
  const { session } = state;
  const dataEnvironment = useDataEnvironment();
  const user = session.user;
  const displayName = user.displayName ?? user.username;
  const location = useBrowserLocation();
  const pathname = normalizeProductPath(location.pathname);
  const activeId = activeNavigationId(pathname);
  const activeSecondaryId = activeSecondaryNavigationId(pathname);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [mobileNavigation, setMobileNavigation] = useState(() => window.matchMedia("(max-width: 900px)").matches);
  const overlayNavigation = mobileNavigation;
  const navigationRef = useRef<HTMLElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const userMenuRef = useRef<HTMLDivElement | null>(null);
  const userButtonRef = useRef<HTMLButtonElement | null>(null);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<AuthRequestError | null>(null);
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  useBodyScrollLock(navigationOpen);
  useBodyScrollLock(passwordDialogOpen);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 900px)");
    const update = () => setMobileNavigation(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!overlayNavigation) setNavigationOpen(false);
  }, [overlayNavigation]);

  useEffect(() => setNavigationOpen(false), [location.key]);

  useEffect(() => {
    if (!userMenuOpen) return undefined;
    const menuItems = () => [...(userMenuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])]
      .filter((element) => element.getClientRects().length > 0);
    window.requestAnimationFrame(() => menuItems()[0]?.focus());
    const handlePointerDown = (event: PointerEvent) => {
      if (!userMenuRef.current?.contains(event.target as Node)) setUserMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setUserMenuOpen(false);
        window.requestAnimationFrame(() => userButtonRef.current?.focus());
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const items = menuItems();
      if (!items.length) return;
      event.preventDefault();
      const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
      const nextIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown"
            ? currentIndex < 0 ? 0 : (currentIndex + 1) % items.length
            : currentIndex < 0 ? items.length - 1 : (currentIndex - 1 + items.length) % items.length;
      items[nextIndex]?.focus();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [userMenuOpen]);

  const signOut = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    setLogoutError(null);
    try {
      await logout();
      dataEnvironment.useProduction();
      setUserMenuOpen(false);
    } catch (error) {
      setLogoutError(error instanceof AuthRequestError ? error : new AuthRequestError("退出失败，请稍后重试", { kind: "error", code: "AUTH_LOGOUT_FAILED", status: 0 }));
    } finally {
      setLoggingOut(false);
    }
  };

  const roleLabel = user.role === "maintainer" ? "管理员" : "普通账号";
  const canMaintainDataSources = user.permissions.includes("bi:data-source-maintenance:enter");
  const navigationGroups = PRODUCT_NAVIGATION.map((group) => ({
    ...group,
    items: group.items
      .filter((item) => (item.id !== "sources" || canMaintainDataSources) && (item.id !== "team" || user.role === "maintainer"))
      .map(item => ({ ...item, href: navigationHref(item.href), children: item.children?.map(child => ({ ...child, href: navigationHref(child.href) })) }))
  })).filter((group) => group.items.length > 0);
  const closePasswordDialog = () => {
    setPasswordDialogOpen(false);
    window.requestAnimationFrame(() => userButtonRef.current?.focus());
  };

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

  return <div className={`ypbi-v2${contextualNavigation ? " ypbi-v2--contextual" : ""}`}>
    <a className="v2-skip-link" href="#v2-main-content">跳到主要内容</a>
    <header className="v2-topbar" inert={overlayNavigation && navigationOpen ? true : undefined}>
      <div className="v2-topbar-brand">
        {mobileNavigation && <button ref={menuButtonRef} type="button" className="v2-icon-button v2-menu-button" aria-label="打开主导航" aria-expanded={navigationOpen} aria-controls="v2-primary-navigation" onClick={() => setNavigationOpen(true)}><Menu aria-hidden="true" /></button>}
        <ProductLink className="v2-brand" href={navigationHref("/data/metrics")} aria-label="YPBI 指标中心"><BrandLogo /></ProductLink>
      </div>
      {mobileNavigation ? <nav className="v2-breadcrumb" aria-label="当前位置">
        <span>{routeArea(pathname)}</span><ChevronRight aria-hidden="true" /><b>{routeTitle(pathname)}</b>
      </nav> : <ProductTopNavigation groups={navigationGroups} activeId={activeId} secondaryId={activeSecondaryId} />}
      <div className="v2-topbar-actions">
        <div className={`v2-data-environment${dataEnvironment.state.mode === "test" ? " is-test" : ""}${dataEnvironment.state.status === "expired" ? " is-expired" : ""}`}>
          <span>{dataEnvironment.state.status === "expired" ? "测试数据已失效" : dataEnvironment.state.mode === "test" ? "测试数据" : "正式数据"}</span>
          {dataEnvironment.state.mode === "test"
            ? <button type="button" onClick={dataEnvironment.useProduction}>切回正式</button>
            : dataEnvironment.state.testAvailable && canMaintainDataSources
              ? <ProductLink href="/admin/data-sources">切换</ProductLink>
              : null}
        </div>
        {internalPreviewEnabled && previewDataSourceEntry && <a className="ui-button ui-button--secondary ui-button--sm" href="/admin/data-sources" title="离开演示页，使用正式 BI 账号登录后连接后台数据">连接真实数据</a>}
        <div className="v2-user-menu" ref={userMenuRef}>
          <button ref={userButtonRef} type="button" className="v2-user-trigger" aria-label={`账号菜单，${displayName}`} aria-haspopup="menu" aria-expanded={userMenuOpen} onClick={() => { setUserMenuOpen((value) => !value); setLogoutError(null); }} onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); setUserMenuOpen(true); setLogoutError(null); } }}>
            <span className="v2-user-avatar" aria-hidden="true">{displayName.slice(0, 1).toUpperCase()}</span>
            <span className="v2-user-copy"><b>{displayName}</b><small>{roleLabel}</small></span>
            <ChevronDown aria-hidden="true" />
          </button>
          {userMenuOpen && <div className="v2-user-popover" role="menu">
            <div className="v2-user-summary"><UserRound aria-hidden="true"/><span><b>{displayName}</b><small>@{user.username} · {roleLabel}</small></span></div>
            {internalPreviewEnabled && previewDataSourceEntry && <ReviewToolsMenuItem onSelect={() => setUserMenuOpen(false)} />}
            <button type="button" role="menuitem" onClick={() => { setUserMenuOpen(false); setPasswordDialogOpen(true); }}><KeyRound aria-hidden="true"/>修改密码</button>
            <button type="button" role="menuitem" onClick={signOut} disabled={loggingOut}>{loggingOut ? <LoaderCircle className="is-spinning" aria-hidden="true"/> : <LogOut aria-hidden="true"/>}{loggingOut ? "正在退出" : "退出登录"}</button>
            {logoutError && <p role="alert">{logoutError.message}</p>}
          </div>}
        </div>
      </div>
    </header>

    <button type="button" data-overlay={overlayNavigation || undefined} className={`v2-nav-backdrop${navigationOpen ? " is-open" : ""}`} aria-label="关闭主导航" tabIndex={navigationOpen ? 0 : -1} onClick={() => setNavigationOpen(false)} />
    {mobileNavigation && <aside
      ref={navigationRef}
      id="v2-primary-navigation"
      className={`v2-sidebar${navigationOpen ? " is-open" : ""}`}
      data-overlay={overlayNavigation || undefined}
      role={overlayNavigation && navigationOpen ? "dialog" : undefined}
      aria-modal={overlayNavigation && navigationOpen ? "true" : undefined}
      aria-labelledby={overlayNavigation && navigationOpen ? "v2-navigation-title" : undefined}
      aria-label={overlayNavigation && navigationOpen ? undefined : "产品主导航"}
      aria-hidden={overlayNavigation && !navigationOpen ? "true" : undefined}
      inert={overlayNavigation && !navigationOpen ? true : undefined}
    >
      <div className="v2-sidebar-mobile-head"><span id="v2-navigation-title">产品导航</span><button type="button" className="v2-icon-button" aria-label="关闭主导航" onClick={() => setNavigationOpen(false)}><X aria-hidden="true" /></button></div>
      <nav>
        {navigationGroups.map((group) => <section key={group.label} className="v2-nav-group">
          <h2>{group.label}</h2>
          {group.items.map(({ id, label, description, href, icon: Icon, children: secondaryItems }) => {
            const sectionActive = activeId === id;
            return <div key={id} className={`v2-nav-item${sectionActive ? " is-section-active" : ""}`}>
              <ProductLink className={!secondaryItems?.length && sectionActive ? "is-active" : ""} href={href} aria-current={!secondaryItems?.length && sectionActive ? "page" : undefined}>
                <Icon aria-hidden="true" />
                <span><b>{label}</b><small>{description}</small></span>
              </ProductLink>
              {secondaryItems?.length ? <ul className="v2-subnav" aria-label={`${label}页面`}>
                {secondaryItems.map((item) => {
                  const active = activeSecondaryId === item.id;
                  return <li key={item.id}>
                    <ProductLink className={active ? "is-active" : ""} href={item.href} aria-current={active ? "page" : undefined}>
                      <span>{item.label}</span>
                      {item.implementationState === "reserved" ? <small>待接入</small> : null}
                    </ProductLink>
                  </li>;
                })}
              </ul> : null}
            </div>;
          })}
        </section>)}
      </nav>
      <div className="v2-sidebar-note"><PanelsTopLeft aria-hidden="true" /><span><b>数据可信优先</b><small>未完成验数或缺少可信水位的数据不作为正式结果展示</small></span></div>
    </aside>}

    <main id="v2-main-content" className="v2-main" inert={overlayNavigation && navigationOpen ? true : undefined} tabIndex={-1}>{children}</main>
    {passwordDialogOpen && <PasswordDialog onClose={closePasswordDialog}/>}
  </div>;
}

function PasswordDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
      window.requestAnimationFrame(() => dialog.querySelector<HTMLInputElement>('input[autocomplete="current-password"]')?.focus());
    }
    return () => { if (dialog?.open) dialog.close(); };
  }, []);
  return <dialog ref={dialogRef} className="v2-account-dialog" aria-labelledby="v2-account-password-title" onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <div className="v2-account-dialog__head"><div><h2 id="v2-account-password-title">修改密码</h2><p>更新后继续使用当前账号。</p></div><button type="button" className="v2-icon-button" aria-label="关闭修改密码" onClick={onClose}><X aria-hidden="true"/></button></div>
    <PasswordForm forced={false} onCancel={onClose} onComplete={onClose}/>
  </dialog>;
}
