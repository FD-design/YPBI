import definitions from "../generated/metric-definitions-ui.json";

export const VERSION_CLIENTS = [
  { id: "android", label: "Android" },
  { id: "ios", label: "iOS" }
] as const;

export type VersionClient = typeof VERSION_CLIENTS[number]["id"];
export type VersionClientScope = "overall" | VersionClient;

export const VERSION_CLIENT_SCOPES = [
  { id: "overall", label: "全部客户端" },
  ...VERSION_CLIENTS
] as const;

export const VERSION_AUDIENCES = [
  { id: "overall", label: "总体" },
  { id: "new", label: "新用户" },
  { id: "existing", label: "老用户" }
] as const;

export type VersionAudience = typeof VERSION_AUDIENCES[number]["id"];

export interface VersionOption {
  key: string;
  client: VersionClient;
  name: string;
  label: string;
  unknown?: boolean;
}

const option = (client: VersionClient, name: string, unknown = false): VersionOption => ({
  key: `${client}:${unknown ? "unknown" : name}`,
  client,
  name: unknown ? "版本未知" : name,
  label: `${VERSION_CLIENTS.find(item => item.id === client)!.label} · ${unknown ? "版本未知" : name}`,
  unknown
});

/** DEV-only version names. They are interaction fixtures, not observed releases or build metadata. */
export const VERSION_OPTIONS: readonly VersionOption[] = [
  option("android", "6.8.0"), option("android", "6.7.2"), option("android", "6.6.1"), option("android", "", true),
  option("ios", "6.8.0"), option("ios", "6.7.4"), option("ios", "6.6.0"), option("ios", "", true)
];

const VERSION_METRIC_CONFIG = [
  { id: "M091", unit: "次", kind: "count", audience: "split", attribution: "按启动行为发生时的客户端与版本归属。" },
  { id: "M080", unit: "%", kind: "ratio", audience: "split", attribution: "按启动行为发生时的客户端与版本归属。" },
  { id: "M016", unit: "人", kind: "daily_count", audience: "split", attribution: "按登录活跃行为发生时的客户端与版本归属；同一用户可能使用多个版本，各版本人数不可相加。" },
  { id: "M083", unit: "%", kind: "ratio", audience: "split", attribution: "按构成指标的播放事实发生时客户端与版本归属。" },
  { id: "M031", unit: "%", kind: "ratio", audience: "split", attribution: "按构成指标的播放事实发生时客户端与版本归属。" },
  { id: "M081", unit: "%", kind: "ratio", audience: "split", attribution: "分子、分母使用同一行为日、客户端、版本与人群范围。" },
  { id: "M036", unit: "%", kind: "ratio", audience: "split", attribution: "按构成指标的播放事实发生时客户端、版本与人群范围归属。" },
  { id: "M020", unit: "%", kind: "retention", audience: "registered_cohort", attribution: "D0 按注册时客户端与版本冻结；D1 跨版本、跨端登录仍算留存。" },
  { id: "M024", unit: "%", kind: "retention", audience: "existing_cohort", attribution: "仅含注册满 2 天的存量用户；D0 按观察日首次登录活跃时的客户端与版本冻结，D1 跨版本、跨端登录仍算复访。" }
] as const;

export type VersionMetricId = typeof VERSION_METRIC_CONFIG[number]["id"];
const metricAuthority = new Map(definitions.items.map(item => [item.id, item]));
export const VERSION_METRICS = VERSION_METRIC_CONFIG.map(config => {
  const authority = metricAuthority.get(config.id);
  if (!authority) throw new Error(`Missing metric authority ${config.id}`);
  return { ...config, name: authority.name, definition: authority.definition };
});
export type VersionDistributionMetric = "launches" | "active_users";
export type VersionQueryRange = "all" | "focused";
export type VersionDisplayMode = "overall" | "groups";
/** Retained only so previously copied v1 links continue to parse; the flat page no longer hides either module. */
export type VersionPanel = "startup" | "version";

export interface VersionPerformanceView {
  v: 1;
  panel: VersionPanel;
  client: VersionClientScope;
  version: string;
  comparison: string;
  distribution: VersionDistributionMetric;
  metric: VersionMetricId;
  audience: VersionAudience;
  search: string;
  versionRange: VersionQueryRange;
  display: VersionDisplayMode;
  /** Explicit display-group focus. Absent in legacy links, which retain one exact entity. */
  versionGroup?: string;
  focusClient?: VersionClientScope;
}

export const DEFAULT_VERSION_PERFORMANCE_VIEW: VersionPerformanceView = {
  v: 1,
  panel: "startup",
  client: "overall",
  version: "android:6.8.0",
  comparison: "none",
  distribution: "active_users",
  metric: "M080",
  audience: "overall",
  search: "",
  versionRange: "all",
  display: "groups"
};

export function versionsForClient(client: VersionClient) {
  return VERSION_OPTIONS.filter(item => item.client === client);
}

export function versionsForScope(client: VersionClientScope) {
  return client === "overall" ? [...VERSION_OPTIONS] : versionsForClient(client);
}

export function versionOption(key: string) {
  return VERSION_OPTIONS.find(item => item.key === key);
}

export function versionMetric(id: VersionMetricId) {
  const metric = VERSION_METRICS.find(item => item.id === id);
  if (!metric) throw new Error(`Missing version metric ${id}`);
  return metric;
}

export function versionMetricSupportsAudience(id: VersionMetricId) {
  return versionMetric(id).audience === "split";
}

export function versionMetricAudienceScope(id: VersionMetricId) {
  const metric = versionMetric(id);
  if (metric.audience === "registered_cohort") return "固定注册批次，D0 按注册时客户端与版本归属。";
  if (metric.audience === "existing_cohort") return "固定为注册满 2 天的存量用户，D0 按首次登录活跃客户端与版本归属。";
  if (id === "M091" || id === "M080") return "包含未分类启动，按客户端和版本范围独立计算。";
  return "包含原口径中的全部用户，按客户端和版本范围独立计算。";
}

export function versionQueryKeys(view: VersionPerformanceView): string[] {
  if (view.versionRange === "all") return VERSION_OPTIONS.map(item => item.key);
  return view.versionGroup === undefined ? [view.version] : VERSION_OPTIONS.filter(item => item.name === view.versionGroup).map(item => item.key);
}

export function versionQueryLabel(view: VersionPerformanceView): string {
  if (view.versionRange === "all") return "全部 Android / iOS 版本";
  if (view.versionGroup === undefined) return versionOption(view.version)!.label;
  const clients = VERSION_CLIENTS.filter(client => versionQueryKeys(view).some(key => versionOption(key)?.client === client.id));
  return `${view.versionGroup} · ${clients.map(client => client.label).join(" / ")}`;
}

export function focusVersionGroup(view: VersionPerformanceView, name: string, client: VersionClientScope): VersionPerformanceView {
  const group = VERSION_OPTIONS.filter(item => item.name === name);
  if (!group.length || (client !== "overall" && !group.some(item => item.client === client))) return view;
  return { ...view, client: "overall", version: group[0].key, versionGroup: name, focusClient: client, versionRange: "focused", comparison: "none", audience: "overall" };
}

/** Derives input names from the generated metric authority; it never maintains a second formula dictionary. */
export function versionMetricInputs(id: VersionMetricId) {
  const metric = versionMetric(id);
  const expression = metric.definition.includes("公式：") ? metric.definition.split("公式：").at(-1)!.trim() : "";
  const [numerator, rawDenominator] = expression.split("÷").map(value => value.trim());
  if (!numerator || !rawDenominator) return { numerator: metric.name, denominator: "—" };
  return { numerator, denominator: rawDenominator.replace(/\s*[×*]\s*100%\s*$/, "").trim() };
}

export function versionClientLabel(client: VersionClient) {
  return VERSION_CLIENTS.find(item => item.id === client)!.label;
}

export function versionClientScopeLabel(client: VersionClientScope) {
  return client === "overall" ? "全部客户端（分别列示）" : versionClientLabel(client);
}

export function changeVersionClient(view: VersionPerformanceView, client: VersionClientScope): VersionPerformanceView {
  if (client === "overall") return { ...view, client };
  const current = versionOption(view.version);
  if (current?.client === client) return {
    ...view,
    client,
    comparison: view.comparison === "none" || versionOption(view.comparison)?.client === client ? view.comparison : "none"
  };
  return { ...view, client, version: versionsForClient(client)[0].key, comparison: "none" };
}

export function searchVersionOptions(client: VersionClientScope, search: string, options: readonly VersionOption[] = VERSION_OPTIONS) {
  const query = search.trim().toLocaleLowerCase("zh-CN");
  return options.filter(item => (client === "overall" || item.client === client)
    && (!query || `${item.label} ${item.key}`.toLocaleLowerCase("zh-CN").includes(query)));
}

export function parseVersionPerformanceView(value: unknown): VersionPerformanceView | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item);
  const allowedKeys = new Set(["v", "panel", "client", "version", "comparison", "distribution", "metric", "audience", "search", "versionRange", "display", "versionGroup", "focusClient"]);
  const requiredKeys = ["v", "panel", "client", "version", "comparison", "distribution", "metric"];
  if (keys.some(key => !allowedKeys.has(key)) || requiredKeys.some(key => !keys.includes(key)) || item.v !== 1
    || !VERSION_CLIENT_SCOPES.some(client => client.id === item.client)
    || !["startup", "version"].includes(String(item.panel))
    || !["launches", "active_users"].includes(String(item.distribution))
    || !VERSION_METRICS.some(metric => metric.id === item.metric)
    || (item.audience !== undefined && !VERSION_AUDIENCES.some(audience => audience.id === item.audience))
    || (item.search !== undefined && (typeof item.search !== "string" || item.search.length > 120))
    || (item.versionRange !== undefined && !["all", "focused"].includes(String(item.versionRange)))
    || (item.display !== undefined && !["overall", "groups"].includes(String(item.display)))
    || (item.versionGroup !== undefined && (typeof item.versionGroup !== "string" || !VERSION_OPTIONS.some(option => option.name === item.versionGroup)))
    || (item.focusClient !== undefined && !VERSION_CLIENT_SCOPES.some(client => client.id === item.focusClient))
    || typeof item.version !== "string" || typeof item.comparison !== "string") return null;
  const client = item.client as VersionClientScope;
  const current = versionOption(item.version);
  const comparison = item.comparison === "none" ? null : versionOption(item.comparison);
  if (!current || (client !== "overall" && current.client !== client) || (item.comparison !== "none" && !comparison)
    || (comparison && (comparison.client !== current.client || comparison.key === current.key))) return null;
  if (item.versionGroup !== undefined && (current.name !== item.versionGroup || item.versionRange !== "focused" || client !== "overall")) return null;
  const focusKeys = item.versionGroup === undefined ? [current] : VERSION_OPTIONS.filter(option => option.name === item.versionGroup);
  if (item.focusClient !== undefined && item.focusClient !== "overall" && !focusKeys.some(option => option.client === item.focusClient)) return null;
  return {
    ...item,
    audience: "overall",
    search: item.search === undefined ? "" : item.search as string,
    // Previously copied links always named one explicit version. Keeping that
    // exact scope avoids silently widening an old analysis to all versions.
    versionRange: item.versionRange === undefined ? "focused" : item.versionRange as VersionQueryRange,
    display: item.display === undefined ? "groups" : item.display as VersionDisplayMode
  } as unknown as VersionPerformanceView;
}
