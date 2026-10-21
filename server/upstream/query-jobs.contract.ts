import { z } from "zod";
import type { PlatformSiteId } from "../platforms/registry";

const csv = z.string().min(1).max(8192).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*(?:,[A-Za-z0-9][A-Za-z0-9_.-]*)*$/);
const querySchema = z.object({
  pid: csv.refine(value => value.split(",").length <= 20),
  metricCodes: csv.optional(),
  startDate: z.iso.date(),
  endDate: z.iso.date(),
  granularity: z.enum(["day", "summary", "cohort_day"]).optional(),
  dimensions: csv.optional(),
  dimensionFilters: z.string().max(2048).refine(value => {
    try { const parsed: unknown = JSON.parse(value); return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed); }
    catch { return false; }
  }).optional(),
  includeIncomplete: z.boolean().optional()
}).strict().refine(query => {
  const days = (Date.parse(query.endDate) - Date.parse(query.startDate)) / 86_400_000;
  return days > 0 && days <= 366;
}, "查询范围必须为左闭右开的 1 至 366 天");

export const queryJobCreateRequestSchema = z.object({
  queries: z.array(z.object({
    domain: z.enum(["user-watch", "playback", "retention", "payment-funnel", "landing-funnel", "advertising", "payment-value"]).optional(),
    query: querySchema
  }).strict().refine(unit => unit.domain !== undefined || unit.query.metricCodes !== undefined, "通用查询必须指定指标")).min(1).max(64)
}).strict();

export type QueryJobCreateRequest = z.infer<typeof queryJobCreateRequestSchema>;

/** Server-only binding references; neither reference contains credentials or grants BI access. */
export interface QueryJobContext {
  readonly routingPid: string;
  readonly siteId: PlatformSiteId;
  readonly environment: "production" | "test";
  readonly accountRef: string;
  readonly sourceRef: string;
}

export type QueryJobOperation =
  | { kind: "create"; body: QueryJobCreateRequest }
  | { kind: "status"; taskId: string }
  | { kind: "result"; taskId: string };

export const queryJobTaskIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);
export const queryJobStateSchema = z.enum(["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "EXPIRED"]);
const count = z.number().int().nonnegative().safe();
const statusFields = {
  taskId: queryJobTaskIdSchema,
  status: queryJobStateSchema,
  completedUnits: count.optional(),
  totalUnits: count.optional(),
  attempts: count.optional(),
  createdAtMs: count.optional(),
  startedAtMs: count.nullable().optional(),
  finishedAtMs: count.nullable().optional(),
  expiresAtMs: count.optional(),
  errorCode: z.string().optional()
};

export const queryJobCreatedSchema = z.object({
  code: z.literal(200),
  msg: z.looseObject({ taskId: queryJobTaskIdSchema, reused: z.boolean() })
});
export const queryJobStatusSchema = z.object({ code: z.literal(200), msg: z.looseObject(statusFields) });
export const queryJobResultSchema = z.object({
  code: z.literal(200),
  msg: z.discriminatedUnion("status", [
    z.looseObject({
      ...statusFields,
      status: z.literal("SUCCEEDED"),
      results: z.array(z.looseObject({ rows: z.array(z.unknown()), generatedAt: z.iso.datetime({ offset: true }) }))
    }),
    z.looseObject({ ...statusFields, status: z.enum(["QUEUED", "RUNNING", "FAILED", "EXPIRED"]) })
  ])
});

export type QueryJobCreated = z.infer<typeof queryJobCreatedSchema>;
export type QueryJobStatus = z.infer<typeof queryJobStatusSchema>;
export type QueryJobResult = z.infer<typeof queryJobResultSchema>;
