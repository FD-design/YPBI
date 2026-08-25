import { z } from "zod";

export const analysisTypeSchema = z.enum(["metric", "trend", "ranking", "table", "funnel", "retention"]);
export type AnalysisType = z.infer<typeof analysisTypeSchema>;
export const MAX_METRICS_PER_QUERY = 16;

export const analyticsQuerySchema = z.object({
  modelId: z.string().min(1),
  analysisType: analysisTypeSchema,
  metricIds: z.array(z.string()).max(MAX_METRICS_PER_QUERY).default([]),
  dimensionIds: z.array(z.string()).max(3).default([]),
  eventIds: z.array(z.string()).max(8).default([]),
  platformMode: z.enum(["all", "single", "compare"]).default("single"),
  platformIds: z.array(z.string()).min(1).max(20),
  dateRange: z.tuple([z.iso.date(), z.iso.date()]),
  filters: z.record(z.string(), z.union([z.string(), z.number(), z.array(z.string())])).default({}),
  sort: z.object({ field: z.string(), direction: z.enum(["asc", "desc"]) }).optional(),
  limit: z.number().int().min(1).max(500).default(50)
}).superRefine((query, context) => {
  if (query.dateRange[0] > query.dateRange[1]) {
    context.addIssue({ code: "custom", path: ["dateRange"], message: "开始日期不能晚于结束日期" });
  }
  if (query.platformMode === "single" && query.platformIds.length !== 1) {
    context.addIssue({ code: "custom", path: ["platformIds"], message: "单平台模式只能选择 1 个平台" });
  }
  if (query.platformMode === "compare" && query.platformIds.length > 8) {
    context.addIssue({ code: "custom", path: ["platformIds"], message: "平台对比最多选择 8 个平台" });
  }
});

export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;

export interface AnalyticsResponse {
  data: {
    columns: Array<{ id: string; name: string; type: "string" | "number" | "date" }>;
    rows: Array<Record<string, string | number | null>>;
    summary?: Record<string, number | null>;
  };
  meta: {
    queryId: string;
    grain: string;
    sourceApiIds: string[];
    fetchedAt: string;
    cacheHit: boolean;
    partial: boolean;
    failedPlatforms: Array<{ platformId: string; errorCode: string }>;
    warnings: string[];
  };
}
