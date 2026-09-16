import { ChartNoAxesCombined, Database, LayoutDashboard, Settings2, Users, type LucideIcon } from "lucide-react";

export type ProductNavigationAreaId = "dashboards" | "analysis" | "data" | "sources" | "team";
export type ProductRouteImplementationState = "available" | "reserved";

export interface ProductSecondaryNavigationItem {
  id: string;
  label: string;
  description: string;
  href: string;
  implementationState: ProductRouteImplementationState;
}

export interface ProductNavigationItem {
  id: ProductNavigationAreaId;
  label: string;
  description: string;
  href: string;
  icon: LucideIcon;
  children?: ProductSecondaryNavigationItem[];
}

export interface ProductNavigationGroup {
  label: string;
  items: ProductNavigationItem[];
}

export const PRODUCT_NAVIGATION: ProductNavigationGroup[] = [
  {
    label: "工作空间",
    items: [
      {
        id: "dashboards",
        label: "看板中心",
        description: "经营阅读与个人看板",
        href: "/dashboards/public",
        icon: LayoutDashboard,
        children: [
          { id: "dashboard-public", label: "公共概览", description: "按业务分类阅读官方看板", href: "/dashboards/public", implementationState: "reserved" },
          { id: "dashboard-mine", label: "我的概览", description: "创建和维护个人看板", href: "/dashboards/mine", implementationState: "reserved" },
          { id: "dashboard-metric-overviews", label: "指标速览", description: "集中查看个人关注指标", href: "/dashboards/metric-overviews", implementationState: "reserved" }
        ]
      },
      {
        id: "analysis",
        label: "分析中心",
        description: "指标、事件与漏斗分析",
        href: "/analysis/metrics",
        icon: ChartNoAxesCombined,
        children: [
          { id: "analysis-metrics", label: "指标分析", description: "查询权威指标趋势与构成", href: "/analysis/metrics", implementationState: "reserved" },
          { id: "analysis-events", label: "事件分析", description: "探索事件规模与属性", href: "/analysis/events", implementationState: "reserved" },
          { id: "analysis-funnels", label: "漏斗分析", description: "分析有序步骤转化", href: "/analysis/funnels", implementationState: "reserved" },
          { id: "analysis-saved", label: "已保存的分析", description: "管理可重复执行的分析", href: "/analysis/saved", implementationState: "reserved" }
        ]
      },
      {
        id: "data",
        label: "数据中心",
        description: "权威指标与事件目录",
        href: "/data/metrics",
        icon: Database,
        children: [
          { id: "data-metrics", label: "指标中心", description: "查看指标定义与可用状态", href: "/data/metrics", implementationState: "available" },
          { id: "data-events", label: "事件中心", description: "查看事件契约与查询状态", href: "/data/events", implementationState: "reserved" }
        ]
      }
    ]
  },
  {
    label: "管理",
    items: [
      { id: "sources", label: "数据源维护", description: "连接配置、检测与运行状态", href: "/admin/data-sources", icon: Settings2 },
      { id: "team", label: "账号管理", description: "团队账号与访问权限", href: "/admin/accounts", icon: Users }
    ]
  }
];

export function normalizeProductPath(pathname: string) {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

function pathMatches(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function productNavigationItems() {
  return PRODUCT_NAVIGATION.flatMap((group) => group.items);
}

export function productSecondaryNavigationItems() {
  return productNavigationItems().flatMap((item) => item.children ?? []);
}

export function navigationItemForPath(pathname: string) {
  pathname = normalizeProductPath(pathname);
  if (pathname === "/") return productNavigationItems().find((item) => item.id === "data") ?? null;
  return productNavigationItems().find((item) => {
    if (item.id === "dashboards") return pathname === "/dashboards" || pathname.startsWith("/dashboards/");
    if (item.id === "analysis") return pathname === "/analysis" || pathname.startsWith("/analysis/");
    if (item.id === "data") return pathname === "/data" || pathname.startsWith("/data/");
    return pathname === "/admin" || pathMatches(pathname, item.href);
  }) ?? null;
}

export function secondaryNavigationItemForPath(pathname: string) {
  pathname = normalizeProductPath(pathname);
  if (pathname === "/") return productSecondaryNavigationItems().find((item) => item.href === "/data/metrics") ?? null;
  return productSecondaryNavigationItems()
    .filter((item) => pathMatches(pathname, item.href))
    .sort((left, right) => right.href.length - left.href.length)[0] ?? null;
}

export function exactSecondaryNavigationItem(pathname: string) {
  pathname = normalizeProductPath(pathname);
  return productSecondaryNavigationItems().find((item) => item.href === pathname) ?? null;
}

export function activeNavigationId(pathname: string): ProductNavigationAreaId | null {
  return navigationItemForPath(pathname)?.id ?? null;
}

export function activeSecondaryNavigationId(pathname: string) {
  return secondaryNavigationItemForPath(pathname)?.id ?? null;
}

export function defaultProductRoute(pathname: string) {
  pathname = normalizeProductPath(pathname);
  if (pathname === "/dashboards/favorites") return "/dashboards/public";
  if (!["/dashboards", "/analysis", "/data", "/admin"].includes(pathname)) return null;
  return navigationItemForPath(pathname)?.href ?? null;
}

export function routeTitle(pathname: string) {
  pathname = normalizeProductPath(pathname);
  if (pathname === "/login") return "登录";
  const secondary = secondaryNavigationItemForPath(pathname);
  if (secondary) return secondary.label;
  return navigationItemForPath(pathname)?.label ?? "页面未找到";
}

export function routeArea(pathname: string) {
  pathname = normalizeProductPath(pathname);
  if (pathname === "/login") return "账号";
  const item = navigationItemForPath(pathname);
  if (!item) return "工作台";
  return item.id === "sources" ? "管理" : item.label;
}
