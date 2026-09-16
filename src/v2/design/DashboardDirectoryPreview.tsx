import { useDialogBackdrop } from "../../components/ui/useDialogBackdrop";
import { ReviewTools } from "../components/ReviewTools";
import { Suspense, lazy, useSyncExternalStore, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, PanelLeftOpen, X } from "lucide-react";
import { navigate, NAVIGATION_EVENT, ProductLink, useBrowserLocation } from "../app/router";
import { useBodyScrollLock } from "../../components/layout/useBodyScrollLock";
import { DashboardDirectory } from "../features/dashboards/DashboardDirectory";
import { DashboardHeader } from "../features/dashboards/DashboardPresentation";
import { FloatingHint } from "../../components/ui/FloatingHint";
import { normalizeDirectoryNavigation, type DirectoryItem, type DirectoryNavigationState } from "../features/dashboards/dashboard-directory-model";
import { previewBoardHref, previewBoardId, resolveDevelopmentPreview } from "./development-preview-route";
import { StatePanel } from "../components/StatePanel";
import plan from "./generated/dashboard-directory-preview.json";
import { previewFavorites } from "./preview-favorites";
import { readPreviewQuery, savePreviewQuery, type PreviewQuery } from "./preview-query";
import { DateRangePicker } from "../../components/ui/DateRangePicker";
import { rangeError } from "../../components/ui/date-range-model";
import { Button } from "../../components/ui/Button";
import "./dashboard-directory-preview.css";
import { personalHref, readWorkspace, subscribeWorkspace } from "./personal-workspace-model";
import { PreviewBoardPresentation } from "./PreviewBoardPresentation";

const PersonalWorkspace = lazy(() => import("./PersonalWorkspacePreview"));
let lastPublicHref = "/dashboards/public?design=dashboard-center";
let lastPersonalHref = "/dashboards/mine?design=personal-workspace";
const CoreOverview = lazy(() => import("./CoreOverviewDesignFixture"));
const Acquisition = lazy(() => import("./AcquisitionPreview"));
const Topics = lazy(() => import("./TopicPreviews"));
const ExtendedBoard = lazy(() => import("./ExtendedBoardPreview"));
const FunctionUsage = lazy(() => import("./FunctionUsagePreview"));
const historyKey = "ypbi.dashboard-navigation.v2";
const entries = plan.items.map((item) => ({ ...item, id: item.section }));
const readNavigation = () => normalizeDirectoryNavigation(window.history.state?.[historyKey], plan.categories);

export default function DashboardDirectoryPreview() {
  const [, refreshQuery] = useState(0);
  const location = useBrowserLocation();
  const personal = location.pathname === "/dashboards/mine";
  const workspace = useSyncExternalStore(subscribeWorkspace, readWorkspace);
  const objectId = new URLSearchParams(location.search).get("object");
  const personalEntries: DirectoryItem[] = [{ id:"all", title:"全部我的看板", category:null, scope:"个人看板" }, ...workspace.boards.map(board => ({id:board.id,title:board.name,category:null,scope:"个人看板"}))];
  useEffect(() => { if(personal) lastPersonalHref=location.pathname+location.search; else lastPublicHref=location.pathname+location.search; },[personal,location.pathname,location.search]);
  // Only route traversal remounts a board; recording its local view in the URL does not.
  const [navigationRevision, setNavigationRevision] = useState(0);
  useEffect(() => {
    const update = () => setNavigationRevision(value => value + 1);
    window.addEventListener("popstate", update);
    window.addEventListener(NAVIGATION_EVENT, update);
    return () => { window.removeEventListener("popstate", update); window.removeEventListener(NAVIGATION_EVENT, update); };
  }, []);
  const entryKey = `${personal ? objectId ?? "mine" : previewBoardId(location.search)}:${navigationRevision}`;
  const selectedId = previewBoardId(location.search);
  const selected = entries.find((item) => item.id === selectedId);
  const inherited = readPreviewQuery();
  const rangeBlocked = ["5.8", "5.9"].includes(selectedId) && !new URLSearchParams(location.search).has("view")
    && Boolean(rangeError(inherited.range, { today: "2026-09-10", maxDate: "2026-09-08", minDate: "2026-03-13", maxDays: 180 }));
  const [navigationState, setNavigationState] = useState(readNavigation);
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 767px)").matches);
  const [menuOpen, setMenuOpen] = useState(false);
  const [favorites, setFavorites] = useState(previewFavorites);
  useEffect(() => { const update = () => setFavorites(previewFavorites()); window.addEventListener("preview-favorites-change", update); window.addEventListener("storage", update); return () => { window.removeEventListener("preview-favorites-change", update); window.removeEventListener("storage", update); }; }, []);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const contentRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const directoryId = useId();
  const backdrop = useDialogBackdrop(dialogRef, ()=>closeMenu());
  useBodyScrollLock(menuOpen && mobile);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const update = () => { setMobile(media.matches); setMenuOpen(false); };
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useLayoutEffect(() => {
    setNavigationState(readNavigation());
    contentRef.current?.scrollTo({ top: 0, left: 0 });
    setMenuOpen(false);
  }, [entryKey]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (menuOpen && mobile && dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, [menuOpen, mobile]);
  useEffect(() => {
    if (personal || !selected) return;
    document.title = selected.title + " · 公共概览 · YPBI";
  }, [selected, personal]);
  function changeNavigation(next: DirectoryNavigationState) {
    setNavigationState(next);
    if (["dashboard-center", "personal-workspace"].includes(resolveDevelopmentPreview(window.location) ?? "")) {
      window.history.replaceState({ ...window.history.state, [historyKey]: next }, "");
    }
  }
  function selectBoard(item: DirectoryItem) {
    navigate(personal ? personalHref("/dashboards/mine",item.id === "all" ? undefined : item.id) : previewBoardHref(item.id), { preserveScroll: true, historyState: { [historyKey]: navigationState } });
    if (mobile) {
      setMenuOpen(false);
      requestAnimationFrame(() => contentRef.current?.focus());
    }
  }
  function closeMenu() {
    setMenuOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }
  const directory = <div id={directoryId} className="dashboard-workbench__directory-inner" hidden={!mobile && navigationState.hidden}>
    <div className="dashboard-workbench__scope"><ProductLink href={personal ? lastPublicHref : location.pathname+location.search} aria-current={!personal ? "page" : undefined}>公共概览</ProductLink><ProductLink href={personal ? location.pathname+location.search : lastPersonalHref} aria-current={personal ? "page" : undefined}>我的概览</ProductLink>
      {mobile && <button type="button" aria-label="关闭看板目录" onClick={closeMenu} autoFocus><X aria-hidden="true" /></button>}
    </div>
    <DashboardDirectory scope={personal ? "mine" : "public"} items={personal ? personalEntries : entries.map(item => ({ ...item, favorite: favorites.includes(item.id) }))} categories={personal ? [] : plan.categories} selectedId={personal ? objectId ?? "all" : selectedId} state={navigationState} onStateChange={changeNavigation}
      hrefFor={(item) => personal ? personalHref("/dashboards/mine", item.id === "all" ? undefined : item.id) : previewBoardHref(item.id)} onSelect={selectBoard} />
    {personal && <p className="dashboard-workbench__local-note">本次体验内保存，刷新后清空，未同步账号。</p>}
  </div>;
  const toggleLabel = navigationState.hidden ? "展开目录" : "收起目录";
  return <div className={"dashboard-workbench" + (navigationState.hidden ? " is-directory-hidden" : "")} data-page="dashboard-directory-preview">
    {!mobile && <aside className="dashboard-workbench__directory" aria-label={personal ? "我的概览导航" : "公共概览导航"}>
      {directory}
      <FloatingHint className="dashboard-workbench__edge" content={toggleLabel}>
        <button type="button" className="dashboard-workbench__edge-toggle" aria-label={toggleLabel} aria-controls={directoryId} aria-expanded={!navigationState.hidden}
          onClick={() => changeNavigation({ ...navigationState, hidden: !navigationState.hidden })}>
          {navigationState.hidden ? <ChevronRight aria-hidden="true" /> : <ChevronLeft aria-hidden="true" />}
          {!navigationState.hidden && <span>收起目录</span>}
        </button>
      </FloatingHint>
    </aside>}
    <section ref={contentRef} className="dashboard-workbench__content" aria-label={personal ? "我的概览内容" : selected?.title ?? "看板内容"} tabIndex={-1}>
      {mobile && <button ref={triggerRef} type="button" className="dashboard-workbench__reveal" aria-expanded={menuOpen}
        onClick={() => setMenuOpen(true)}>
        <PanelLeftOpen aria-hidden="true" />选择看板
      </button>}
      {personal ? <Suspense fallback={<StatePanel kind="loading" title="正在打开我的概览" description="正在读取个人看板。" />}><PersonalWorkspace embedded boardSearch={navigationState.query}/></Suspense> : <PreviewBoardPresentation key={selectedId} board={selectedId}>
      {rangeBlocked ? <UnsupportedQuery title={selected!.title} category={selected!.category ?? "官方看板"} query={inherited} onApply={() => refreshQuery(value => value + 1)} key={entryKey} />
        : selectedId === "5.2" ? <Suspense fallback={<StatePanel kind="loading" title="正在加载核心经营总览" description="正在加载开发环境样板。" />}><CoreOverview key={entryKey} /></Suspense>
        : selectedId === "5.7" ? <Suspense fallback={<StatePanel kind="loading" title="正在加载获客与新增" description="正在加载开发环境样板。" />}><Acquisition key={entryKey} /></Suspense>
        : selectedId === "5.5" ? <Suspense fallback={<StatePanel kind="loading" title="正在加载功能使用概览" description="正在加载本地目录与演示结果。" />}><FunctionUsage key={entryKey} /></Suspense>
        : selectedId === "5.8" || selectedId === "5.9" ? <Suspense fallback={<StatePanel kind="loading" title="正在加载专题看板" description="正在加载开发环境样例。" />}><Topics board={selectedId} key={`${selectedId}-${entryKey}`} /></Suspense>
        : ["5.10", "5.11", "5.12", "5.13", "5.14", "5.15"].includes(selectedId) ? <Suspense fallback={<StatePanel kind="loading" title="正在加载专题看板" description="正在加载开发环境样例。" />}><ExtendedBoard board={selectedId} key={`${selectedId}-${entryKey}`} /></Suspense>
        : selected ? <div className="dashboard-workbench__pending" key={selected.id}>
          <ReviewTools><div className="dashboard-workbench__preview-note">开发环境体验 · 未开放正式业务数据</div></ReviewTools>
          <DashboardHeader title={selected.title} breadcrumb={`公共概览 / ${selected.category}`} description={`${selected.scope} ${selected.admission}`}>{null}</DashboardHeader>
          <StatePanel kind="empty" title="该专题看板尚未接入" description="页面建设与数据接入完成后，在这里直接查看该看板。当前不会显示占位图表或模拟业务结果。" />
        </div> : <StatePanel kind="empty" title="当前看板不可访问" description="请从左侧选择可访问的看板。" />}
      </PreviewBoardPresentation>}
    </section>
    {mobile && menuOpen && <dialog {...backdrop} ref={dialogRef} className="dashboard-workbench__mobile-directory" aria-label="选择看板" onCancel={(event) => { event.preventDefault(); closeMenu(); }}>{directory}</dialog>}
  </div>;
}

function UnsupportedQuery({ title, category, query, onApply }: { title: string; category: string; query: PreviewQuery; onApply: () => void }) {
  const [range, setRange] = useState(query.range);
  const error = rangeError(range, { today: "2026-09-10", maxDate: "2026-09-08", minDate: "2026-03-13", maxDays: 180 });
  return <div className="v2-page topic-preview">
    <DashboardHeader title={title} breadcrumb={`公共概览 / ${category}`}><DateRangePicker value={range} onChange={setRange} today="2026-09-10" maxDate="2026-09-08" minDate="2026-03-13" maxDays={180} /><Button variant="primary" disabled={Boolean(error)} onClick={() => { savePreviewQuery(range, query.compared); onApply(); }}>应用</Button></DashboardHeader>
    <StatePanel kind="empty" title="当前日期超出本看板可查询范围" description={`已保留 ${query.range.start} 至 ${query.range.end}；本地体验支持 2026-03-13 至 2026-09-08，单次最多 180 天。请调整日期后应用；其他看板继续保留原条件。`} />
  </div>;
}
