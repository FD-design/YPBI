import { z } from "zod";
import { UPSTREAM_READ_ERROR_CODES, UPSTREAM_READ_FAILURE_ORIGINS } from "../upstream/read-failure";
import { SOURCE_IDS, GROUP_IDS } from "../upstream/read-trace";

const sourceIds = [...SOURCE_IDS, "unknown"] as const;
const groupIds = [...GROUP_IDS, "unknown"] as const;
const errorCodes = [...UPSTREAM_READ_ERROR_CODES, "unknown"] as const;
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const duration = z.number().min(0).max(Number.MAX_SAFE_INTEGER);
const httpStatus = z.number().int().min(100).max(599);
const outcome = {
  result: z.enum(["pending", "success", "failure"]),
  code: z.enum(errorCodes).optional(),
  origin: z.enum(UPSTREAM_READ_FAILURE_ORIGINS).optional(),
  upstreamHttpStatus: httpStatus.optional(),
  upstreamBusinessCode: count.optional()
};
const logicalRead = z.object({
  id: count.min(1), sourceId: z.enum(sourceIds), groupId: z.enum(groupIds),
  mode: z.enum(["unassigned", "cache", "created", "reused", "no_physical"]),
  physicalId: count.min(1).optional(), pending: z.boolean(), completed: z.boolean(), durationMs: duration,
  ...outcome
});
const physicalRead = z.object({
  id: count.min(1), pending: z.boolean(), completed: z.boolean(), started: z.boolean(),
  headersReceived: z.boolean(), bodyReceived: z.boolean(), durationMs: duration, queueWaitMs: duration,
  httpWaitMs: duration.optional(), headersWaitMs: duration.optional(), bodyWaitMs: duration.optional(),
  ...outcome
});
const boundaryFailure = z.object({ id: count.min(1), sourceId: z.enum(sourceIds), groupId: z.enum(groupIds), ...outcome });
const countMap = (keys: readonly string[]) => z.object(Object.fromEntries(keys.map(key => [key, count.optional()])));
const numericCodeCounts = (http: boolean) => z.record(z.string(), count).transform(values => Object.fromEntries(
  Object.entries(values).filter(([key]) => /^(0|[1-9]\d*)$/.test(key) && Number.isSafeInteger(Number(key))
    && (http ? Number(key) >= 100 && Number(key) <= 599 : Number(key) >= 0))
));
const summary = z.object({
  logicalReadCount: count, successfulLogicalReadCount: count, failedLogicalReadCount: count, pendingLogicalReadCount: count,
  physicalCreatedCount: count, physicalReusedCount: count, cacheHitCount: count, noPhysicalCount: count,
  physicalReadCount: count, completedPhysicalReadCount: count, pendingPhysicalReadCount: count,
  queueWaitMs: duration.optional(), httpWaitMs: duration.optional(), headersWaitMs: duration.optional(), bodyWaitMs: duration.optional(),
  errorCodeCounts: countMap(errorCodes), failureOriginCounts: countMap(UPSTREAM_READ_FAILURE_ORIGINS),
  upstreamHttpStatusCounts: numericCodeCounts(true), upstreamBusinessCodeCounts: numericCodeCounts(false)
});
const traceSchema = z.object({
  completed: z.boolean(),
  logicalReads: z.array(logicalRead).max(256), physicalReads: z.array(physicalRead).max(256),
  boundaryFailures: z.array(boundaryFailure).max(256), summary,
  bySource: z.object(Object.fromEntries(sourceIds.map(id => [id, summary.optional()]))),
  byGroup: z.object(Object.fromEntries(groupIds.map(id => [id, summary.optional()]))),
  truncated: z.object({ logicalReads: count, physicalReads: count, boundaryFailures: count })
});
type SafeSummary = z.infer<typeof summary>;
type SafePhysical = z.infer<typeof physicalRead>;

function physicalTimings(read: SafePhysical): SafePhysical {
  const { httpWaitMs, headersWaitMs, bodyWaitMs, ...base } = read;
  return { ...base,
    ...(read.started && httpWaitMs !== undefined ? { httpWaitMs } : {}),
    ...(read.started && headersWaitMs !== undefined ? { headersWaitMs } : {}),
    ...(read.headersReceived && bodyWaitMs !== undefined ? { bodyWaitMs } : {})
  };
}
function summaryTimings(value: SafeSummary, physical: readonly SafePhysical[]): SafeSummary {
  const { queueWaitMs, httpWaitMs, headersWaitMs, bodyWaitMs, ...base } = value;
  return { ...base,
    ...(physical.length && queueWaitMs !== undefined ? { queueWaitMs } : {}),
    ...(physical.some(read => read.started) && httpWaitMs !== undefined ? { httpWaitMs } : {}),
    ...(physical.some(read => read.started) && headersWaitMs !== undefined ? { headersWaitMs } : {}),
    ...(physical.some(read => read.headersReceived) && bodyWaitMs !== undefined ? { bodyWaitMs } : {})
  };
}
function freezeTree<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeTree);
    Object.freeze(value);
  }
  return value;
}

/** Copies only bounded trace measurements. Request data and log envelopes are excluded. */
export function projectOperatingEvidenceReadDiagnostics(input: unknown) {
  try {
    const parsed = traceSchema.safeParse(input);
    if (!parsed.success) return undefined;
    const trace = parsed.data;
    const physicalReads = trace.physicalReads.map(physicalTimings);
    const groupSummary = (values: Record<string, SafeSummary | undefined>, dimension: "sourceId" | "groupId") => Object.fromEntries(
      Object.entries(values).flatMap(([key, value]) => {
        if (!value) return [];
        const physicalIds = new Set(trace.logicalReads.filter(read => read[dimension] === key).map(read => read.physicalId));
        return [[key, summaryTimings(value, physicalReads.filter(read => physicalIds.has(read.id)))]];
      })
    );
    return freezeTree({
      schemaVersion: "operating-evidence-safe-read-trace/v1" as const,
      boundary: { kind: "upstream-read-trace-safe-projection" as const, rawHttp: false as const, rawBody: false as const, metricAcceptanceGranted: false as const },
      trace: { ...trace, physicalReads, summary: summaryTimings(trace.summary, physicalReads),
        bySource: groupSummary(trace.bySource, "sourceId"), byGroup: groupSummary(trace.byGroup, "groupId") }
    });
  } catch { return undefined; }
}

export function createOperatingEvidenceReadDiagnostics() {
  let captured: ReturnType<typeof projectOperatingEvidenceReadDiagnostics>;
  return {
    logger: { info(fields: unknown, message: string) {
      if (message !== "daily dashboard read trace completed" || captured) return;
      try {
        if (fields && typeof fields === "object") captured = projectOperatingEvidenceReadDiagnostics(Reflect.get(fields, "readTrace"));
      } catch { /* Diagnostics remain optional when collection fails. */ }
    } },
    snapshot: () => captured
  };
}
