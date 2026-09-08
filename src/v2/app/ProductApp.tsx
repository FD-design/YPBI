import "../../theme/tokens.css";
import "../v2.css";
import { useEffect } from "react";
import { ProductShell } from "./ProductShell";
import { normalizeProductPath, routeTitle } from "./navigation";
import { useBrowserLocation } from "./router";
import { MetricCatalogPage } from "../pages/MetricCatalogPage";
import { MetricAnalysisPage } from "../pages/MetricAnalysisPage";
import { NotFoundPage, UnavailablePage } from "../pages/UnavailablePage";
import { DataSourceMaintenancePage } from "../pages/DataSourceMaintenancePage";

const RESERVED_ROUTES: Record<string, { title: string; description: string }> = {
  "/dashboards": { title: "看板中心", description: "公共看板与个人看板将在真实查询、权限和保存契约完成后接入。" },
  "/dashboards/public": { title: "公共看板", description: "公共看板将在真实查询和可见范围契约完成后接入。" },
  "/dashboards/mine": { title: "我的看板", description: "个人看板将在身份、权限和持久化契约完成后接入。" },
  "/analysis": { title: "分析中心", description: "首批先用 M016 贯通真实指标分析，其他分析类型按契约逐步接入。" },
  "/analysis/metrics": { title: "指标分析", description: "请选择已经开放的指标；首批可查询 M016 日活跃用户数。" },
  "/analysis/events": { title: "事件分析", description: "事件分析将在事件目录、范围权限和查询契约完成后接入。" },
  "/analysis/funnels": { title: "漏斗分析", description: "漏斗分析将在事件顺序、身份归一和漏斗计算契约明确后接入。" },
  "/analysis/saved": { title: "已保存的分析", description: "保存能力涉及身份、权限和持久化，当前只读版本不提供。" },
  "/data": { title: "数据中心", description: "首批开放指标目录；事件目录将在权威契约完成后接入。" },
  "/data/events": { title: "事件中心", description: "事件中心将在权威事件目录接口完成后接入。" },
  "/admin": { title: "管理中心", description: "管理能力将在权限模型和可审计写入流程完成后接入。" },
};

function routeContent(pathname: string) {
  const path = normalizeProductPath(pathname);
  if (path === "/" || path === "/data/metrics") return <MetricCatalogPage />;
  if (path === "/admin/data-sources") return <DataSourceMaintenancePage />;
  const metricMatch = path.match(/^\/analysis\/metrics\/([^/]+)$/);
  if (metricMatch) {
    let metricId = metricMatch[1];
    try { metricId = decodeURIComponent(metricId); } catch { return <NotFoundPage />; }
    return <MetricAnalysisPage metricId={metricId} />;
  }
  const reserved = RESERVED_ROUTES[path];
  if (reserved) return <UnavailablePage title={reserved.title} description={reserved.description} />;
  return <NotFoundPage />;
}

export function ProductApp() {
  const location = useBrowserLocation();
  useEffect(() => {
    document.title = `${routeTitle(location.pathname)} · YPBI`;
  }, [location.pathname]);
  return <ProductShell>{routeContent(location.pathname)}</ProductShell>;
}
