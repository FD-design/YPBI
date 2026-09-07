import { Menu, Search } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { IconButton } from "../ui/IconButton";

export function PlatformTopbar({ section, status, onOpenNavigation, onNavigateHome }: { section: string; status: ReactNode; onOpenNavigation: () => void; onNavigateHome: () => void }) {
  const navigateHome = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onNavigateHome();
  };
  return <header className="platform-topbar">
    <div className="platform-topbar__brand">
      <IconButton className="platform-topbar__menu" label="打开主导航" icon={Menu} onClick={onOpenNavigation} aria-controls="platform-workspace-nav" />
      <span className="platform-topbar__lockup" aria-label="YPBI">
        <span className="platform-topbar__logo" aria-hidden="true">
          <svg viewBox="0 0 24 30" fill="none"><path d="M3 5.5 12 15v10" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/><path d="m21 5.5-9 9.5" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/><path d="m17.1 9.6-5.1 5.4" stroke="var(--color-brand-600)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </span>
        <span className="platform-topbar__wordmark" aria-hidden="true">PBI</span>
      </span>
    </div>
    <nav className="platform-topbar__primary" aria-label="一级导航">
      <a href="/?workspace=templates&ui=v13" onClick={navigateHome}>分析工作台</a><i>/</i><b>{section}</b>
    </nav>
    <div className="platform-topbar__tools">
      <IconButton label="全局搜索（即将开放）" icon={Search} disabled />
      {status}
      <span className="platform-topbar__avatar" aria-label="当前用户：产品负责人">产</span>
    </div>
  </header>;
}
