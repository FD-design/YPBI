import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, PanelLeftOpen, X } from "lucide-react";
import type { DailyDashboardCatalog, DailyDashboardQuery } from "../../../contracts/daily-dashboard";
import { dailyDashboardQuerySchema } from "../../../contracts/daily-dashboard";
import type { V2PlatformCatalogSuccess } from "../../../contracts/bi-v2";
import { fetchPlatformCatalog, fetchReadableDashboards } from "../api/client";
import { useV2Resource } from "../api/useV2Resource";
import { navigate, ProductLink, useBrowserLocation } from "../app/router";
import { ResourceFailurePanel, StatePanel } from "../components/StatePanel";
import { DashboardDirectory } from "../features/dashboards/DashboardDirectory";
import { DemoDataProvider } from "../components/DataOrigin";
import type { LocalDirectoryState } from "../design/ConnectedDirectoryState";
import { normalizeDirectoryNavigation, type DirectoryNavigationState } from "../features/dashboards/dashboard-directory-model";
import { useBodyScrollLock } from "../../components/layout/useBodyScrollLock";
import { useDialogBackdrop } from "../../components/ui/useDialogBackdrop";
import "../features/dashboards/dashboard-workbench.css";

type Board = DailyDashboardCatalog["items"][number];
type Platforms = V2PlatformCatalogSuccess["data"]["items"];
const internalDashboardPreviewEnabled = import.meta.env.VITE_INTERNAL_DASHBOARD_PREVIEW_ENABLED === "true";
const ConnectedBoard = import.meta.env.DEV || internalDashboardPreviewEnabled ? lazy(() => import("../design/ConnectedBoard")) : null;
const PersonalWorkspace = import.meta.env.DEV ? lazy(() => import("../design/PersonalWorkspacePreview")) : null;
const ConnectedDirectoryState = import.meta.env.DEV ? lazy(() => import("../design/ConnectedDirectoryState")) : null;
const navigationKey = "ypbi.daily-dashboard.navigation";
const dateAt = (offset: number) => new Date(Date.now() + 8 * 3600000 + offset * 86400000).toISOString().slice(0, 10);
function href(query: DailyDashboardQuery, personal = false) {
  const params = new URLSearchParams({ board: query.boardId, pid: query.pid, start: query.dateRange[0], end: query.dateRange[1] });
  if (new URLSearchParams(window.location.search).get("compare") === "previous") params.set("compare", "previous");
  return `${personal ? "/dashboards/mine" : "/dashboards/public"}?${params}`;
}

export function DailyDashboardPage() {
  const resource = useV2Resource("daily-dashboard-catalog", async signal => {
    const [catalog, platforms] = await Promise.all([fetchReadableDashboards(signal), fetchPlatformCatalog(signal)]);
    return { catalog, platforms };
  });
  if (resource.state.status === "loading") return <div className="v2-page"><StatePanel kind="loading" title="正在读取看板目录" description="正在确认可访问的平台。" /></div>;
  if (resource.state.status === "failure") return <div className="v2-page"><ResourceFailurePanel state={resource.state} onRetry={resource.retry} /></div>;
  return <DailyWorkbench {...resource.state.data} />;
}

function DailyWorkbench({ catalog, platforms }: { catalog: DailyDashboardCatalog; platforms: Platforms }) {
  const location = useBrowserLocation();
  const personal = location.pathname === "/dashboards/mine";
  const [localDirectory, setLocalDirectory] = useState<LocalDirectoryState>({ favorites: [], boards: [] });
  const params = new URLSearchParams(location.search);
  const defaultQuery: DailyDashboardQuery = { boardId: "5.2", pid: platforms[0]?.pid ?? "", dateRange: [dateAt(-7), dateAt(-1)] };
  const parsed = dailyDashboardQuerySchema.safeParse({ boardId: params.get("board") ?? defaultQuery.boardId, pid: params.get("pid") ?? defaultQuery.pid,
    dateRange: [params.get("start") ?? defaultQuery.dateRange[0], params.get("end") ?? defaultQuery.dateRange[1]] });
  const query = parsed.success ? parsed.data : defaultQuery;
  const selected = catalog.items.find(item => item.id === query.boardId);
  const valid = parsed.success && Boolean(selected) && platforms.some(platform => platform.pid === query.pid);
  const [navigation, setNavigation] = useState(() => normalizeDirectoryNavigation(window.history.state?.[navigationKey], catalog.categories));
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 767px)").matches);
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null), trigger = useRef<HTMLButtonElement>(null), content = useRef<HTMLElement>(null);
  function close() { setOpen(false); requestAnimationFrame(() => trigger.current?.focus()); }
  const backdrop = useDialogBackdrop(dialog, close);
  useBodyScrollLock(mobile && open);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const change = () => { setMobile(media.matches); setOpen(false); };
    media.addEventListener("change", change); return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => { if (open) dialog.current?.showModal(); const node = dialog.current; return () => node?.close(); }, [open]);
  useEffect(() => {
    setNavigation(normalizeDirectoryNavigation(window.history.state?.[navigationKey], catalog.categories));
    setOpen(false); content.current?.scrollTo({ top: 0 });
  }, [location.search, location.pathname, catalog.categories]);
  function changeNavigation(next: DirectoryNavigationState) {
    setNavigation(next); window.history.replaceState({ ...window.history.state, [navigationKey]: next }, "");
  }
  const directory = <div className="dashboard-workbench__directory-inner" hidden={!mobile && navigation.hidden}>
    <div className="dashboard-workbench__scope"><ProductLink href={href(query)} aria-current={!personal ? "page" : undefined}>公共概览</ProductLink><ProductLink href={href(query, true)} aria-current={personal ? "page" : undefined}>我的概览</ProductLink>{mobile && <button type="button" aria-label="关闭看板目录" onClick={close} autoFocus><X /></button>}</div>
    <DashboardDirectory scope={personal ? "mine" : "public"} items={personal ? localDirectory.boards : catalog.items.map(item => ({ ...item, scope: "官方看板", favorite: localDirectory.favorites.includes(item.id) }))} categories={personal ? [] : catalog.categories}
      selectedId={personal ? params.get("object") ?? "all" : query.boardId} state={navigation} onStateChange={changeNavigation} hrefFor={item => personal ? `${href(query, true)}${item.id === "all" ? "" : "&object=" + encodeURIComponent(item.id)}` : href({ ...(valid ? query : defaultQuery), boardId: item.id })}
      onSelect={item => { navigate(personal ? `${href(query, true)}${item.id === "all" ? "" : "&object=" + encodeURIComponent(item.id)}` : href({ ...(valid ? query : defaultQuery), boardId: item.id }), { historyState: { [navigationKey]: navigation } }); if (mobile) requestAnimationFrame(() => content.current?.focus()); }} />
    {personal && <p className="dashboard-workbench__local-note">本次体验内保存，刷新后清空，未同步账号。</p>}
  </div>;
  return <div className={`dashboard-workbench${navigation.hidden ? " is-directory-hidden" : ""}`} data-page="daily-dashboard">
    {ConnectedDirectoryState && <Suspense fallback={null}><ConnectedDirectoryState onChange={setLocalDirectory}/></Suspense>}
    {!mobile && <aside className="dashboard-workbench__directory" aria-label="看板目录">{directory}<div className="dashboard-workbench__edge"><button type="button" className="dashboard-workbench__edge-toggle" aria-label={navigation.hidden ? "展开目录" : "收起目录"} aria-expanded={!navigation.hidden} onClick={() => changeNavigation({ ...navigation, hidden: !navigation.hidden })}>{navigation.hidden ? <ChevronRight /> : <><ChevronLeft /><span>收起目录</span></>}</button></div></aside>}
    <section className="dashboard-workbench__content" ref={content} tabIndex={-1} aria-label={personal ? "我的概览内容" : selected?.title ?? "看板内容"}>
      {mobile && <button ref={trigger} type="button" className="dashboard-workbench__reveal" aria-expanded={open} onClick={() => setOpen(true)}><PanelLeftOpen />选择看板</button>}
      {personal && PersonalWorkspace ? <Suspense fallback={<StatePanel kind="loading" title="正在打开我的概览" description="正在读取个人看板。"/>}><DemoDataProvider><PersonalWorkspace embedded boardSearch={navigation.query}/></DemoDataProvider></Suspense>
        : !catalog.enabled ? <StatePanel kind="empty" title="当前环境未开启真实看板读取" description="数据源维护仍可正常使用；请联系维护人员开启本地看板读取。" />
        : !platforms.length ? <StatePanel kind="forbidden" title="暂无可访问的平台" description="请联系管理员确认账号的数据范围。" />
        : !valid ? <StatePanel kind="error" title="看板查询条件无效" description="请选择有权限的平台及1至366天的日期范围。" action={{ label: "恢复默认条件", onClick: () => navigate(href(defaultQuery), { replace: true }) }} />
        : <DailyBoard key={JSON.stringify([query, params.get("compare")])} query={query} board={selected!} platforms={platforms} />}
    </section>
    {mobile && open && <dialog {...backdrop} ref={dialog} className="dashboard-workbench__mobile-directory" aria-label="选择看板" onCancel={event => { event.preventDefault(); close(); }}>{directory}</dialog>}
  </div>;
}

function DailyBoard({ query, board, platforms }: { query: DailyDashboardQuery; board: Board; platforms: Platforms }) {
  return ConnectedBoard ? <>
    {internalDashboardPreviewEnabled && <aside className="dashboard-workbench__internal-preview" role="note" aria-label="内测数据说明">
      <strong>内测环境</strong>
      <span>页面同时包含真实数据、待验数结果和用于展示样式的演示数据；请以每个区块的数据来源标记为准。</span>
    </aside>}
    <Suspense fallback={<StatePanel kind="loading" title="正在打开看板" description="正在载入既有看板。" />}><ConnectedBoard query={query} board={board} platforms={platforms} /></Suspense>
  </> : <StatePanel kind="empty" title="当前构建未开启内测看板" description="需要在受保护的内测部署中显式开启，不会默认把演示数据带入其他环境。" />;
}
