import "../../theme/tokens.css";
import "../../components/ui/primitives.css";
import "../v2.css";
import "../motion.css";
import { lazy, Suspense, useEffect } from "react";
import { AuthenticationProvider, useAuthentication } from "./AuthProvider";
import { ProductShell } from "./ProductShell";
import { defaultProductRoute, exactSecondaryNavigationItem, normalizeProductPath, routeTitle } from "./navigation";
import { navigate, useBrowserLocation, type BrowserLocationSnapshot } from "./router";
import { MetricCatalogPage } from "../pages/MetricCatalogPage";
import { MetricAnalysisPage } from "../pages/MetricAnalysisPage";
import { NotFoundPage, UnavailablePage } from "../pages/UnavailablePage";
import { DataSourceMaintenancePage } from "../pages/DataSourceMaintenancePage";
import { DailyDashboardPage } from "../pages/DailyDashboardPage";
import {
  AuthenticationLoadingPage,
  AuthenticationUnavailablePage,
  exactCurrentPath,
  ForcedPasswordChangePage,
  LoginPage,
  safeReturnPath
} from "../pages/AuthenticationPages";
import { StatePanel } from "../components/StatePanel";
import type { AuthenticatedSession } from "../api/auth";
import { DemoDataProvider } from "../components/DataOrigin";
import { isPersonalPreviewPath, resolveDevelopmentPreview } from "../design/development-preview-route";
import { DataEnvironmentProvider, useDataEnvironment } from "./DataEnvironmentProvider";

const V1ChartStatesFixture = import.meta.env.DEV
  ? lazy(() => import("../design/V1ChartStatesFixture"))
  : null;
const DashboardDirectoryPreview = import.meta.env.DEV
  ? lazy(() => import("../design/DashboardDirectoryPreview"))
  : null;
const DevelopmentDesignPreviewBoundary = import.meta.env.DEV
  ? lazy(() => import("../design/DevelopmentDesignPreviewBoundary"))
  : null;
const CatalogCenterPreview = import.meta.env.DEV ? lazy(() => import("../design/CatalogCenterPreview")) : null;
const PersonalWorkspacePreview = import.meta.env.DEV ? lazy(() => import("../design/PersonalWorkspacePreview")) : null;

function developmentDesignPreview(location: Pick<BrowserLocationSnapshot, "pathname" | "search" | "hash">) {
  return import.meta.env.DEV ? resolveDevelopmentPreview(location) : null;
}

function routeContent(location: BrowserLocationSnapshot, user: AuthenticatedSession["user"]) {
  const path = normalizeProductPath(location.pathname);
  if (developmentDesignPreview(location) === "personal-workspace" && path !== "/dashboards/mine" && PersonalWorkspacePreview) return <Suspense fallback={<StatePanel kind="loading" title="正在打开个人工作区" description="本地交互体验。" />}><PersonalWorkspacePreview /></Suspense>;
  if (developmentDesignPreview(location) === "catalog-center" && CatalogCenterPreview) return <Suspense fallback={<StatePanel kind="loading" title="正在读取目录" description="正在加载权威文件投影。" />}><CatalogCenterPreview kind={path === "/data/events" ? "events" : "metrics"} /></Suspense>;
  if ((developmentDesignPreview(location) === "dashboard-center" || (developmentDesignPreview(location) === "personal-workspace" && path === "/dashboards/mine")) && DashboardDirectoryPreview) {
    return <Suspense fallback={<StatePanel kind="loading" title="正在加载看板目录" description="此页面用于体验已确认的看板规划与进入流程。" />}><DashboardDirectoryPreview /></Suspense>;
  }
  if (developmentDesignPreview(location) === "v1-chart-states" && V1ChartStatesFixture) {
    return <Suspense fallback={<StatePanel kind="loading" title="正在加载图表体验页" description="此页面仅用于确认 V1 图表、表格与数据状态。" />}><V1ChartStatesFixture /></Suspense>;
  }
  if (path === "/dashboards/public" || path === "/dashboards/mine") return <DailyDashboardPage />;
  if (import.meta.env.DEV && new URLSearchParams(location.search).get("local") === "workspace" && isPersonalPreviewPath(path) && PersonalWorkspacePreview) return <Suspense fallback={<StatePanel kind="loading" title="正在打开工作区" description="正在载入已有分析页面。"/>}><DemoDataProvider><PersonalWorkspacePreview/></DemoDataProvider></Suspense>;
  if (path === "/" || path === "/data/metrics") return <MetricCatalogPage />;
  if (path === "/admin/data-sources") return user.permissions.includes("bi:data-source-maintenance:enter")
    ? <DataSourceMaintenancePage />
    : <div className="v2-page"><header className="v2-page-head"><div><span className="v2-eyebrow">访问控制</span><h1>无权访问管理中心</h1><p>数据源配置需要有效的 BI 账号和维护权限。</p></div></header><StatePanel kind="forbidden" title="当前账号没有维护权限" description="你仍可使用指标、分析与看板等已开放功能。" code="ADMIN_ACCESS_DENIED" /></div>;
  const metricMatch = path.match(/^\/analysis\/metrics\/([^/]+)$/);
  if (metricMatch) {
    let metricId = metricMatch[1];
    try { metricId = decodeURIComponent(metricId); } catch { return <NotFoundPage />; }
    return <MetricAnalysisPage metricId={metricId} />;
  }
  const reserved = exactSecondaryNavigationItem(path);
  if (reserved?.implementationState === "reserved") return <UnavailablePage title={reserved.label} description={reserved.description} />;
  return <NotFoundPage />;
}

function AuthenticatedProductApp() {
  const location = useBrowserLocation();
  const { state } = useAuthentication();
  useEffect(() => {
    document.title = `${routeTitle(location.pathname)} · YPBI`;
  }, [location.pathname]);
  if (state.status === "checking") return <AuthenticationLoadingPage />;
  if (state.status === "unavailable") return <AuthenticationUnavailablePage />;

  const queryReturnTo = location.pathname === "/login"
    ? safeReturnPath(new URLSearchParams(location.search).get("returnTo"))
    : exactCurrentPath();
  if (state.status === "anonymous") return <LoginPage returnTo={queryReturnTo} />;
  if (state.session.mustChangePassword) return <ForcedPasswordChangePage returnTo={queryReturnTo} />;
  if (location.pathname === "/login") return <AuthenticatedRedirect to={queryReturnTo} />;
  const defaultRoute = defaultProductRoute(location.pathname);
  if (defaultRoute) return <AuthenticatedRedirect to={defaultRoute} />;
  return <DataEnvironmentProvider key={state.authScopeKey} subjectId={state.session.user.subjectId}>
    <EnvironmentProductShell location={location} user={state.session.user} preview={Boolean(developmentDesignPreview(location))} />
  </DataEnvironmentProvider>;
}

function EnvironmentProductShell({ location, user, preview }: { location: BrowserLocationSnapshot; user: AuthenticatedSession["user"]; preview: boolean }) {
  const environment = useDataEnvironment();
  return <ProductShell contextualNavigation={["/dashboards/public", "/dashboards/mine"].includes(location.pathname)} previewDataSourceEntry={preview} navigationHref={preview ? previewNavigationHref : undefined}>
    <EnvironmentRoute key={environment.dataScopeKey} location={location} user={user} />
  </ProductShell>;
}

function EnvironmentRoute({ location, user }: { location: BrowserLocationSnapshot; user: AuthenticatedSession["user"] }) {
  return routeContent(location, user);
}

function previewNavigationHref(href: string) {
  if (isPersonalPreviewPath(href)) return href + "?design=personal-workspace";
  if (href === "/data/metrics" || href === "/data/events") return href + "?design=catalog-center";
  if (href === "/dashboards/public") return href + "?design=dashboard-center";
  return href;
}

function AuthenticatedRedirect({ to }: { to: string }) {
  useEffect(() => {
    navigate(to, { replace: true });
  }, [to]);
  return <AuthenticationLoadingPage />;
}

export function ProductApp() {
  useEffect(() => {
    const syncVisibility = () => { document.documentElement.dataset.uiMotionPaused = String(document.visibilityState !== "visible"); };
    syncVisibility();
    document.addEventListener("visibilitychange", syncVisibility);
    return () => { document.removeEventListener("visibilitychange", syncVisibility); delete document.documentElement.dataset.uiMotionPaused; };
  }, []);
  const location = useBrowserLocation();
  const preview = developmentDesignPreview(location);
  if (preview && DevelopmentDesignPreviewBoundary) {
    return <Suspense fallback={<StatePanel kind="loading" title="正在进入设计评审" description="此入口只在本地开发环境开放。" />}>
      <DevelopmentDesignPreviewBoundary key={`development-preview:${preview === "dashboard-center" || preview === "personal-workspace" ? "workspace" : preview}`}>
        <AuthenticatedProductApp />
      </DevelopmentDesignPreviewBoundary>
    </Suspense>;
  }
  return <AuthenticationProvider key="authenticated-product"><AuthenticatedProductApp /></AuthenticationProvider>;
}
