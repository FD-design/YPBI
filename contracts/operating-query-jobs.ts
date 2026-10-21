import { z } from "zod";
import { biQueryJobHandleSchema, biQueryJobProgressSchema } from "./query-jobs";
import { dailyDashboardMatchesQuery, dailyDashboardSuccessSchema } from "./daily-dashboard";
import { OPERATING_METRIC_IDS } from "./operating-detail-projection";

const pid = z.string().min(1).max(32).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
const pids = z.array(pid).min(1).max(20).refine(values => new Set(values).size === values.length, "平台不能重复");
const scope = { kind: z.literal("operating-snapshot"), pids, date: z.iso.date() };
export const operatingQueryJobRequestSchema = z.object(scope).strict();
export type OperatingQueryJobRequest = z.infer<typeof operatingQueryJobRequestSchema>;

export function operatingQueryDateRange(date: string): [string, string] {
  return [new Date(Date.parse(date) - 7 * 86_400_000).toISOString().slice(0, 10), date];
}

export const operatingQueryJobCreatedSchema = z.object({ success: z.literal(true), data: z.object({
  ...scope, handle: biQueryJobHandleSchema, reused: z.boolean()
}).strict() }).strict();
export const operatingQueryJobProgressSchema = biQueryJobProgressSchema.extend({
  ...scope, phase: z.enum(["query", "projection", "complete"])
}).strict().refine(value => value.phase === "query" || value.status === "SUCCEEDED", "投影阶段须对应已成功的后台任务");
export type OperatingQueryJobProgress = z.infer<typeof operatingQueryJobProgressSchema>;
export const operatingQueryJobStatusSchema = z.object({ success: z.literal(true), data: operatingQueryJobProgressSchema }).strict();
export const operatingQueryJobResultSchema = z.object({ success: z.literal(true), data: operatingQueryJobProgressSchema.safeExtend({
  dashboards: z.array(dailyDashboardSuccessSchema).min(1).max(20).optional()
}).superRefine((data, ctx) => {
  if (data.phase !== "complete") {
    if (data.dashboards !== undefined) ctx.addIssue({ code: "custom", message: "投影完成前不能交付看板结果" });
    return;
  }
  if (!data.dashboards || data.dashboards.length !== data.pids.length || data.dashboards.some((dashboard, index) => !dailyDashboardMatchesQuery(dashboard, {
    boardId: "5.2", projection: "operating_snapshot", pid: data.pids[index], dateRange: operatingQueryDateRange(data.date)
  }, OPERATING_METRIC_IDS))) ctx.addIssue({ code: "custom", message: "经营结果须匹配全部平台、日期及93列" });
}) }).strict();

export type OperatingQueryJobCreated = z.infer<typeof operatingQueryJobCreatedSchema>;
export type OperatingQueryJobStatus = z.infer<typeof operatingQueryJobStatusSchema>;
export type OperatingQueryJobResult = z.infer<typeof operatingQueryJobResultSchema>;
