import { ChartNoAxesCombined, Database, LayoutDashboard, Settings2, type LucideIcon } from "lucide-react";

export interface ProductNavigationItem {
  id: "dashboards" | "analysis" | "data" | "sources";
  label: string;
  description: string;
  href: string;
  icon: LucideIcon;
}

export interface ProductNavigationGroup {
  label: string;
  items: ProductNavigationItem[];
}

export const PRODUCT_NAVIGATION: ProductNavigationGroup[] = [
  {
    label: "工作空间",
    items: [
      { id: "dashboards", label: "看板中心", description: "公共与个人看板", href: "/dashboards/public", icon: LayoutDashboard },
      { id: "analysis", label: "分析中心", description: "指标、事件与漏斗", href: "/analysis/metrics/M016", icon: ChartNoAxesCombined },
      { id: "data", label: "数据中心", description: "权威指标与事件", href: "/data/metrics", icon: Database }
    ]
  },
  {
    label: "管理",
    items: [
      { id: "sources", label: "数据源维护", description: "连接与运行状态", href: "/admin/data-sources", icon: Settings2 }
    ]
  }
];

export function normalizeProductPath(pathname: string) {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

export function activeNavigationId(pathname: string): ProductNavigationItem["id"] | null {
  pathname = normalizeProductPath(pathname);
  if (pathname === "/" || pathname.startsWith("/data/")) return "data";
  if (pathname.startsWith("/dashboards/")) return "dashboards";
  if (pathname.startsWith("/analysis/")) return "analysis";
  if (pathname.startsWith("/admin/")) return "sources";
  return null;
}

export function routeTitle(pathname: string) {
  pathname = normalizeProductPath(pathname);
  if (pathname === "/" || pathname === "/data/metrics") return "指标中心";
  if (pathname === "/data/events") return "事件中心";
  if (pathname.startsWith("/analysis/metrics/")) return "指标分析";
  if (pathname === "/analysis/metrics") return "指标分析";
  if (pathname === "/analysis/events") return "事件分析";
  if (pathname === "/analysis/funnels") return "漏斗分析";
  if (pathname === "/analysis/saved") return "已保存的分析";
  if (pathname.startsWith("/dashboards/")) return "看板中心";
  if (pathname === "/admin/data-sources") return "数据源维护";
  return "页面未找到";
}

export function routeArea(pathname: string) {
  pathname = normalizeProductPath(pathname);
  if (pathname === "/" || pathname.startsWith("/data")) return "数据";
  if (pathname.startsWith("/dashboards")) return "看板";
  if (pathname.startsWith("/analysis")) return "分析";
  if (pathname.startsWith("/admin")) return "管理";
  return "工作台";
}
