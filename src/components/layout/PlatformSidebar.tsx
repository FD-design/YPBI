import { BookOpen, ChartNoAxesCombined, Database, LayoutDashboard, PanelLeftClose, PanelLeftOpen, PanelsTopLeft, X } from "lucide-react";
import { useEffect, useRef, type ComponentType, type MouseEvent, type SVGProps } from "react";
import type { UiVersion } from "../../app/uiVersion";
import { withUiVersion } from "../../app/uiVersion";
import { IconButton } from "../ui/IconButton";

export type WorkspaceId = "templates" | "cards" | "cardFactory" | "templateFactory" | "dictionary" | "dataSources";

interface NavItem {
  id: WorkspaceId;
  label: string;
  description: string;
  path: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}

const NAV_ITEMS: NavItem[] = [
  { id: "templates", label: "看板中心", description: "阅读与下钻", path: "/?workspace=templates", icon: LayoutDashboard },
  { id: "cardFactory", label: "分析中心", description: "创建分析卡片", path: "/?workspace=cards", icon: ChartNoAxesCombined },
  { id: "templateFactory", label: "模板管理", description: "组装与发布", path: "/?workspace=templateFactory", icon: PanelsTopLeft },
  { id: "dictionary", label: "数据字典", description: "指标与口径", path: "/?workspace=dictionary", icon: BookOpen },
  { id: "dataSources", label: "数据源维护", description: "连接状态", path: "/?workspace=dataSources", icon: Database }
];

interface PlatformSidebarProps {
  active: WorkspaceId;
  version: UiVersion;
  open: boolean;
  collapsed: boolean;
  onClose: () => void;
  onToggleCollapse: () => void;
  onNavigate: (workspace: WorkspaceId) => void;
}

export function PlatformSidebar({ active, version, open, collapsed, onClose, onToggleCollapse, onNavigate }: PlatformSidebarProps) {
  const navRef = useRef<HTMLElement | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    if (document.activeElement instanceof HTMLElement) previousFocus.current = document.activeElement;
    const nav = navRef.current;
    const focusables = () => [...(nav?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])') ?? [])].filter((element) => element.getClientRects().length > 0);
    window.requestAnimationFrame(() => focusables()[0]?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
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
      previousFocus.current?.focus();
    };
  }, [open]);
  return <>
    <button className={`platform-nav-backdrop${open ? " is-open" : ""}`} aria-label="关闭主导航" onClick={onClose} />
    <aside ref={navRef} id="platform-workspace-nav" className={`platform-sidebar${open ? " is-open" : ""}${collapsed ? " is-collapsed" : ""}`} aria-label="工作区导航">
      <div className="platform-sidebar__head"><span>工作空间</span><IconButton label="关闭主导航" icon={X} onClick={onClose} /></div>
      <nav>
        {NAV_ITEMS.map(({ id, label, description, path, icon: Icon }) => {
          const selected = active === id || (id === "cardFactory" && active === "cards");
          const navigate = (event: MouseEvent<HTMLAnchorElement>) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            onNavigate(id === "cardFactory" ? "cards" : id);
          };
          return <a key={id} className={selected ? "active" : ""} href={withUiVersion(path, version)} onClick={navigate} aria-label={label} title={collapsed ? `${label} · ${description}` : label} aria-current={selected ? "page" : undefined}>
            <Icon aria-hidden="true" />
            <span><b>{label}</b><small>{description}</small></span>
          </a>;
        })}
      </nav>
      <div className="platform-sidebar__footer">
        <div><span>统一设计系统</span><small>指标与数据口径保持不变</small></div>
        <button className="platform-sidebar__collapse" onClick={onToggleCollapse} aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"} title={collapsed ? "展开侧边栏" : "收起侧边栏"}>
          {collapsed ? <PanelLeftOpen aria-hidden="true" /> : <PanelLeftClose aria-hidden="true" />}
          <span>{collapsed ? "展开" : "收起导航"}</span>
        </button>
      </div>
    </aside>
  </>;
}
