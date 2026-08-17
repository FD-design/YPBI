export type ChartType =
  | "kpi"
  | "line"
  | "bar"
  | "heatmap"
  | "funnel"
  | "treemap"
  | "table"
  | "diagnosis"
  | "scatter"
  | "cohort"
  | "waterfall"
  | "sankey";

export type AnalysisModelId =
  | "business_overview"
  | "platform_compare"
  | "content_position"
  | "search_demand"
  | "payment_conversion"
  | "member_operation"
  | "retention_quality"
  | "usage_depth"
  | "acquisition_conversion"
  | "custom_table";

export type MetricId =
  | "dau"
  | "dauUserDays"
  | "newUsers"
  | "viewerCount"
  | "viewerUserDays"
  | "searchCount"
  | "revenue"
  | "viewRate"
  | "payRate"
  | "payerCount"
  | "payerUserDays"
  | "visits"
  | "downloads"
  | "visitDownloadRate"
  | "downloadRegisterRate"
  | "visitRegisterRate"
  | "retentionD1"
  | "retentionD3"
  | "retentionD7"
  | "retentionD30"
  | "videoCtr"
  | "playRate"
  | "completeRate"
  | "searchNoResultRate"
  | "arppu"
  | "arpu"
  | "androidDau"
  | "androidDauUserDays"
  | "iosDau"
  | "iosDauUserDays"
  | "androidNewUsers"
  | "iosNewUsers"
  | "organicNewUsers"
  | "internalNewUsers"
  | "adClickCount"
  | "adClickUsers"
  | "adClickUserDays"
  | "adClickRate"
  | "adClickUserRate"
  | "newAdClickCount"
  | "newAdClickUsers"
  | "newAdClickRate"
  | "newAdClickUserRate"
  | "oldAdClickCount"
  | "oldAdClickUsers"
  | "oldAdClickUserDays"
  | "oldAdClickRate"
  | "oldAdClickUserRate"
  | "newRevenue"
  | "newPayerCount"
  | "newPayRate"
  | "newArpu"
  | "newArppu"
  | "oldRevenue"
  | "oldPayerCount"
  | "oldPayerUserDays"
  | "oldPayRate"
  | "oldArpu"
  | "oldArppu"
  | "channelNewRevenue"
  | "internalNewRevenue"
  | "avgUsageMinutes"
  | "avgWatchMinutes"
  | "pageViews"
  | "pageClicks"
  | "currentPaidMembers"
  | "historicalPaidMembers"
  | "renewalRate"
  | "videoWatchCount"
  | "videoViewerCount"
  | "videoLikeCount"
  | "videoCollectCount";

export type DimensionId =
  | "date"
  | "platform"
  | "page"
  | "position"
  | "positionRank"
  | "category"
  | "content"
  | "keyword"
  | "paymentChannel"
  | "memberPlan"
  | "memberStatus"
  | "result"
  | "appVersion"
  | "channel";

export interface EventPropertyDefinition {
  id: string;
  name: string;
  type: "string" | "number" | "boolean";
  required?: boolean;
  example?: string;
}

export interface EventDefinition {
  id: string;
  name: string;
  domain: string;
  requiredProperties: DimensionId[];
  description: string;
  trigger?: string;
  status?: "ready" | "partial" | "missing";
  coverage?: string[];
  properties?: EventPropertyDefinition[];
}

export interface MetricDefinition {
  id: MetricId;
  name: string;
  formula: string;
  source: string;
  owner: string;
  status: "ready" | "partial" | "missing";
  unit?: "number" | "percent" | "currency" | "minutes";
  aggregation?: "sum" | "average" | "latest" | "weighted";
  description?: string;
}

export interface AnalysisModel {
  id: AnalysisModelId;
  name: string;
  description: string;
  eventChain: string[];
  allowedDimensions: DimensionId[];
  allowedMetrics: MetricId[];
  defaultDrillPath: DimensionId[];
  recommendedCharts?: ChartType[];
}

export type ApiCapabilityStatus = "ready" | "partial" | "limited";

export interface ApiAnalysisCapability {
  modelId: AnalysisModelId;
  apiPaths: string[];
  dataGrain: string;
  status: ApiCapabilityStatus;
  statusLabel: string;
  allowedCharts: ChartType[];
  allowedDimensions: DimensionId[];
  allowedMetrics: MetricId[];
  funnelEvents: string[];
  filters: string[];
  limitations: string[];
}

export interface DashboardCardConfig {
  id: string;
  title: string;
  type: ChartType;
  model: AnalysisModelId;
  metrics: MetricId[];
  dimensions: DimensionId[];
  size: "sm" | "md" | "lg" | "full";
  funnelSteps?: string[];
  conversionWindow?: string;
  drillPath?: DimensionId[];
  diagnosisRules?: string[];
  sort?: "asc" | "desc";
  limit?: number;
  sourceApi?: string;
  platformMode?: "global" | "all" | "single" | "compare";
  platforms?: string[];
}

export interface DashboardTemplate {
  id: string;
  name: string;
  scenario: string;
  model: AnalysisModelId;
  filters: DimensionId[];
  cards: DashboardCardConfig[];
  status?: "draft" | "published";
  updatedAt?: string;
}

export interface DrilldownPayload {
  title: string;
  subtitle: string;
  model: AnalysisModelId;
  dimensions: DimensionId[];
  metrics: MetricId[];
  rows: Record<string, string | number>[];
  diagnosis: string[];
  actions: string[];
  scope?: string;
  benchmark?: string;
  platformIds: string[];
  dateRange: [string, string];
  detailKind: "users" | "circles";
}
