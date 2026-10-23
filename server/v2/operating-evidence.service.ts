import type { DailyDashboardQuery } from "../../contracts/daily-dashboard";
import { dailyDashboardQuerySchema, dailyDashboardV2SuccessSchema, dailyDashboardMatchesQuery } from "../../contracts/daily-dashboard";
import { OPERATING_METRIC_IDS } from "../../contracts/operating-detail-projection";
import { OPERATING_EVIDENCE_BOUNDARY, OPERATING_EVIDENCE_VERSION, type OperatingEvidenceQuery } from "../../contracts/operating-evidence";
import { UpstreamError, type UpstreamClient } from "../upstream/client";
import { toBeijingDate } from "../upstream/date";
import { dailyDashboardCatalog, dailyDashboardMatchesMapping, DailyDashboardService } from "./daily-dashboard.service";
import { createOperatingEvidenceCollector } from "./operating-evidence-collector";
import { createOperatingEvidenceReadDiagnostics } from "./operating-evidence-read-diagnostics";

/** Runs the authoritative reader without changing its requests or projection. */
export async function readOperatingEvidence(
  client: Pick<UpstreamClient, "get" | "isProtectedDiagnosticText">,
  input: OperatingEvidenceQuery,
  options: { sourceReadTimeoutMs: number; signal: AbortSignal; now?: () => Date }
) {
  const now = options.now ?? (() => new Date());
  const date = new Date(`${input.date}T00:00:00Z`);
  const first = new Date(date.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
  if (input.date > toBeijingDate(now().toISOString())) throw new UpstreamError("INVALID_OPERATING_EVIDENCE_QUERY", "取证日期不能晚于当前业务日", 400);
  const query: DailyDashboardQuery = input.view === "snapshot"
    ? { boardId: "5.2", pid: input.pid, dateRange: [first, input.date], projection: "operating_snapshot" }
    : { boardId: "5.2", pid: input.pid, dateRange: [input.date, input.date] };
  if (!dailyDashboardQuerySchema.safeParse(query).success) {
    throw new UpstreamError("INVALID_OPERATING_EVIDENCE_QUERY", "取证日期范围不合法", 400);
  }
  const collector = createOperatingEvidenceCollector(client, { isProtectedText: value => client.isProtectedDiagnosticText(value) });
  const diagnostics = input.view === "snapshot" ? createOperatingEvidenceReadDiagnostics() : undefined;
  try {
    const result = dailyDashboardV2SuccessSchema.parse(await new DailyDashboardService(collector.client, now, diagnostics?.logger, {
      sourceReadTimeoutMs: options.sourceReadTimeoutMs, readTraceEnabled: Boolean(diagnostics)
    }).execute(query, options.signal));
    const expected = query.projection ? OPERATING_METRIC_IDS : dailyDashboardCatalog(true).data.items.find(item => item.id === "5.2")!.metricIds;
    if (!dailyDashboardMatchesQuery(result, query, expected) || !dailyDashboardMatchesMapping(result)) {
      throw new UpstreamError("OPERATING_EVIDENCE_CONFLICT", "取证投影范围校验失败", 502);
    }
    const readDiagnostics = diagnostics?.snapshot();
    return {
      schemaVersion: OPERATING_EVIDENCE_VERSION,
      environment: input.environment,
      query,
      observedAt: now().toISOString(),
      boundary: OPERATING_EVIDENCE_BOUNDARY,
      ...collector.finish(),
      ...(readDiagnostics ? { readDiagnostics } : {}),
      projection: result
    };
  } catch (error) {
    collector.finish();
    throw error;
  }
}
