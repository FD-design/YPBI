import { ChevronDown, ChevronRight, Search, Star, X } from "lucide-react";
import { useRef, useState } from "react";
import type { DirectoryItem, DirectoryNavigationState } from "./dashboard-directory-model";
import "./dashboard-directory.css";

export function DashboardDirectory({ items, categories, selectedId, state, onStateChange, hrefFor, onSelect, scope = "public", showFavorites = true }: {
  showFavorites?: boolean;
  scope?: "public" | "mine";
  items: readonly DirectoryItem[];
  categories: readonly string[];
  selectedId: string;
  state: DirectoryNavigationState;
  onStateChange: (state: DirectoryNavigationState) => void;
  hrefFor: (item: DirectoryItem) => string;
  onSelect: (item: DirectoryItem) => void;
}) {
  const searchRef = useRef<HTMLInputElement>(null);
  const [expandedTitle, setExpandedTitle] = useState<{ id: string; above: boolean } | null>(null);
  const query = state.query.trim().toLocaleLowerCase();
  const matches = items.filter((item) => item.title.toLocaleLowerCase().includes(query));
  const favorites = matches.filter(item => item.favorite);
  const categoryMatches = query ? matches.filter(item => !item.favorite) : matches;
  const favoritesOpen = Boolean(query) || !state.collapsed.includes("我的收藏");
  function revealTruncatedTitle(link: HTMLAnchorElement, id: string) {
    const label = link.querySelector<HTMLElement>(".dashboard-directory__name");
    const list = link.closest("nav");
    setExpandedTitle(label && label.scrollWidth > label.clientWidth
      ? { id, above: Boolean(list && list.getBoundingClientRect().bottom - link.getBoundingClientRect().bottom < 80) }
      : null);
  }
  function row(item: DirectoryItem, section = "category") {
    const titleKey = section + item.id;
    return <a key={item.id} href={hrefFor(item)} className="dashboard-directory__item" aria-current={selectedId === item.id ? "page" : undefined}
      onMouseEnter={(event) => revealTruncatedTitle(event.currentTarget, titleKey)} onMouseLeave={() => setExpandedTitle(null)}
      onFocus={(event) => revealTruncatedTitle(event.currentTarget, titleKey)} onBlur={() => setExpandedTitle(null)}
      onKeyDown={(event) => { if (event.key === "Escape") setExpandedTitle(null); }}
      onClick={(event) => {
        if (event.button || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
        event.preventDefault(); onSelect(item);
      }}>
      <span className="dashboard-directory__name">{item.title}</span>{item.favorite && <Star aria-hidden="true" size={12} fill="currentColor" />}{expandedTitle?.id === titleKey && <span className="dashboard-directory__full-name" data-above={expandedTitle.above || undefined} aria-hidden="true">{item.title}</span>}
    </a>;
  }
  return <div className="dashboard-directory">
    <div className="dashboard-directory__search ui-search"><Search aria-hidden="true" />
      <input ref={searchRef} aria-label={scope === "mine" ? "搜索我的看板" : "搜索看板"} placeholder="搜索看板" type="search" maxLength={120} value={state.query}
        onChange={(event) => onStateChange({ ...state, query: event.target.value })} />
      {state.query && <button type="button" className="dashboard-directory__clear" aria-label="清除搜索" onClick={() => { onStateChange({ ...state, query: "" }); searchRef.current?.focus(); }}><X aria-hidden="true" /><span className="dashboard-directory__full-name" aria-hidden="true">清除搜索</span></button>}
    </div>
    <nav aria-label={scope === "mine" ? "个人看板列表" : "公共看板列表"} className="dashboard-directory__list">
      {showFavorites && scope === "public" && (!query || favorites.length > 0) && <section className="dashboard-directory__group" aria-label="我的收藏">
        <button type="button" className="dashboard-directory__category" aria-expanded={favoritesOpen} disabled={Boolean(query)}
          onClick={() => onStateChange({ ...state, collapsed: favoritesOpen ? [...state.collapsed, "我的收藏"] : state.collapsed.filter(name => name !== "我的收藏") })}>
          {favoritesOpen ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}<span>我的收藏</span><small>{favorites.length}</small>
        </button>
        {favoritesOpen && <div className="dashboard-directory__children">{favorites.map(item => row(item, "favorite"))}{!favorites.length && <p className="dashboard-directory__favorite-empty">点击看板右上角星标收藏</p>}</div>}
      </section>}
      {categoryMatches.filter((item) => item.category === null).map(item => row(item))}
      {categories.map((category) => {
        const children = categoryMatches.filter((item) => item.category === category);
        if (!children.length) return null;
        const open = Boolean(query) || !state.collapsed.includes(category);
        return <section key={category} className="dashboard-directory__group">
          <button type="button" className="dashboard-directory__category" aria-expanded={open} disabled={Boolean(query)}
            onClick={() => onStateChange({ ...state, collapsed: open ? [...state.collapsed, category] : state.collapsed.filter((name) => name !== category) })}>
            {open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}<span>{category}</span><small>{children.length}</small>
          </button>
          {open && <div className="dashboard-directory__children">{children.map(item => row(item))}</div>}
        </section>;
      })}
      {!matches.length && <div className="dashboard-directory__empty" role="status"><p>{query ? "没有匹配的看板" : "暂无看板"}</p>{query && <button type="button" onClick={() => { onStateChange({ ...state, query: "" }); searchRef.current?.focus(); }}>清除搜索</button>}</div>}
    </nav>
  </div>;
}
