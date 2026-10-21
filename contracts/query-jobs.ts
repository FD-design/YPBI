import { z } from "zod";

const csv = z.string().max(4096).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*(?:,[A-Za-z0-9][A-Za-z0-9_.-]*)*$/);
const filters = z.string().max(2048).refine(value => {
  try {
    const object: unknown = JSON.parse(value);
    return object !== null && typeof object === "object" && !Array.isArray(object)
      && Object.entries(object).length <= 12
      && Object.entries(object).every(([key, entry]) => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)
        && (typeof entry === "string" && entry.length <= 256 || typeof entry === "number" && Number.isFinite(entry)));
  } catch { return false; }
});

/** The first BI task boundary accepts explicit, scoped metric queries only. */
export const biQueryJobRequestSchema = z.object({
  queries: z.array(z.object({
    query: z.object({
      pid: csv.refine(value => value.split(",").length <= 20),
      metricCodes: csv,
      startDate: z.iso.date(),
      endDate: z.iso.date(),
      granularity: z.enum(["day", "summary", "cohort_day"]),
      dimensions: csv.optional(),
      dimensionFilters: filters.optional(),
      includeIncomplete: z.literal(true)
    }).strict().refine(query => {
      const days = (Date.parse(query.endDate) - Date.parse(query.startDate)) / 86_400_000;
      return days > 0 && days <= 366;
    }, "查询范围必须为左闭右开的1至366天")
  }).strict()).min(1).max(64)
}).strict();
export type BiQueryJobRequest = z.infer<typeof biQueryJobRequestSchema>;

export const biQueryJobHandleSchema = z.string().uuid();
export const biQueryJobStateSchema = z.enum(["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "EXPIRED"]);
const count = z.number().int().nonnegative().safe();
const scalar = z.union([z.string().max(512), z.number().finite(), z.boolean(), z.null()]);
const dimensions = z.record(z.string().max(64), scalar).refine(value => Object.keys(value).length <= 24);

// Explicit projection: uncontracted errors, payloads and credentials never cross the BI boundary.
export const biQueryJobRowSchema = z.object({
  metricCode: z.string().regex(/^M\d{3}$/), metricName: z.string().max(256).optional(),
  pid: z.string().max(32).optional(), businessDate: z.iso.date().optional(), dimensions,
  value: z.number().finite().nullable(), numerator: z.number().finite().nullable(), denominator: z.number().finite().nullable(),
  unit: z.string().max(64), dataStatus: z.enum(["READY", "PROCESSING", "SOURCE_INCOMPLETE", "NOT_MATURE", "FAILED"]),
  metricVersion: z.string().max(128).optional(), ruleVersion: z.string().max(128),
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(), cutoffDate: z.iso.date().optional(), isComplete: z.boolean().optional(),
  mau: z.number().finite().nullable().optional(), observationDate: z.iso.date().optional(), isMature: z.boolean().optional(),
  retentionDay: count.optional(), uniqueUsers: z.number().finite().nullable().optional(),
  timeoutCount: count.optional(), lateCreditCount: count.optional(),
  firstCompleteBusinessDate: z.iso.date().nullable().optional(), dataCutoffDate: z.iso.date().nullable().optional(),
  historicalBackfillStart: z.iso.date().nullable().optional(), historicalBackfillEnd: z.iso.date().nullable().optional()
});
export const biQueryJobUnitResultSchema = z.object({
  rows: z.array(biQueryJobRowSchema).max(100_000),
  generatedAt: z.iso.datetime({ offset: true }),
  metricVersion: z.string().max(128).optional(), watermark: z.string().max(128).nullable().optional()
});
export const biQueryJobProgressSchema = z.object({
  handle: biQueryJobHandleSchema, status: biQueryJobStateSchema,
  completedUnits: count.optional(), totalUnits: count.optional(), attempts: count.optional(),
  createdAtMs: count.optional(), startedAtMs: count.nullable().optional(), finishedAtMs: count.nullable().optional(), expiresAtMs: count.optional(),
  errorCode: z.enum(["QUEUE_TIMEOUT", "DEADLINE_EXCEEDED", "LEASE_EXHAUSTED", "RESULT_TOO_LARGE", "RESULT_CAPACITY", "EXECUTION_FAILED", "UNKNOWN"]).optional()
});
export const biQueryJobCreatedSchema = z.object({ success: z.literal(true), data: z.object({ handle: biQueryJobHandleSchema, reused: z.boolean() }) });
export const biQueryJobStatusSchema = z.object({ success: z.literal(true), data: biQueryJobProgressSchema });
export const biQueryJobResultSchema = z.object({ success: z.literal(true), data: biQueryJobProgressSchema.extend({ results: z.array(biQueryJobUnitResultSchema).max(64).optional() }) });
