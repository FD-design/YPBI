import type { DailyDashboardSuccess } from "../../../contracts/daily-dashboard";
import { OPERATING_METRIC_IDS } from "../../../contracts/operating-detail-projection";
import { operatingQueryDateRange, operatingQueryJobCreatedSchema, type OperatingQueryJobProgress } from "../../../contracts/operating-query-jobs";
import { OPERATING_QUERY_VALIDATION_PATH, operatingQueryValidationCapabilitiesSchema } from "../../../contracts/operating-query-validation";
import { AdminRequestError, type CredentialSite } from "./adminDataSources";
import { fetchDailyDashboard, parseResponse, readV2RequestDiagnostics, V2RequestError } from "./client";
import { currentDataEnvironmentPreference } from "./dataEnvironmentPreference";
import { createOperatingQueryJobRunner } from "./operating-query-jobs";
import { compareOperatingValidation, type OperatingValidationComparison } from "./operating-query-validation-comparison";
import type { BiQueryJobRuntime } from "./query-jobs";

export interface ValidationSafeError {
  code: string;
  requestId?: string;
  queryJobErrorCode?: string;
  upstreamBusinessCode?: number;
  upstreamHttpStatus?: number;
}
export interface OperatingValidationGroup {
  site: CredentialSite;
  pids: string[];
  state: "waiting" | "creating" | "running" | "complete" | "failed" | "cancelled";
  handle?: string;
  reused?: boolean;
  progress?: Readonly<OperatingQueryJobProgress>;
  error?: ValidationSafeError;
  createMs?: number;
  queryMs?: number;
  projectionMs?: number;
  asyncMs?: number;
  syncCompleted: number;
  syncFailed: number;
}
export interface OperatingValidationEvent {
  elapsedMs: number;
  operation: "capabilities" | "create" | "status" | "result" | "progress" | "sync" | "comparison" | "cancel";
  site?: CredentialSite;
  pid?: string;
  httpStatus?: number;
  startedElapsedMs?: number;
  responseHeadersMs?: number;
  durationMs?: number;
  reused?: boolean;
  progress?: Readonly<OperatingQueryJobProgress>;
  error?: ValidationSafeError;
}
export interface OperatingValidationReport {
  schemaVersion: "operating-validation/v1";
  evidenceSource: "BI代理已校验业务投影（非上游原始HTTP）";
  environment: "production";
  date: string;
  startedAt: string;
  finishedAt?: string;
  elapsedMs: number;
  status: "running" | "complete" | "failed" | "cancelled";
  stage: "capabilities" | "async" | "sync" | "comparison" | "finished";
  groups: OperatingValidationGroup[];
  candidate: DailyDashboardSuccess[];
  baseline: DailyDashboardSuccess[];
  events: OperatingValidationEvent[];
  comparison?: OperatingValidationComparison;
  error?: ValidationSafeError;
}

export function validationSafeError(error: unknown): ValidationSafeError {
  const fields = readV2RequestDiagnostics(error);
  return {
    code: fields.code && /^[A-Z][A-Z0-9_]{0,95}$/.test(fields.code) ? fields.code : "VALIDATION_REQUEST_FAILED",
    ...(fields.requestId && /^[A-Za-z0-9_.:-]{1,128}$/.test(fields.requestId) ? { requestId: fields.requestId } : {}),
    ...(fields.queryJobErrorCode ? { queryJobErrorCode: fields.queryJobErrorCode } : {}),
    ...(fields.upstreamBusinessCode !== undefined ? { upstreamBusinessCode: fields.upstreamBusinessCode } : {}),
    ...(fields.upstreamHttpStatus !== undefined ? { upstreamHttpStatus: fields.upstreamHttpStatus } : {})
  };
}

const JOB_PREFIX = "/api/bi/v2/queries/jobs";
const JOB_PATH = /^\/api\/bi\/v2\/queries\/jobs(?:\/[a-f0-9-]{36}(?:\/result)?)?$/i;
const ACCESS_ERRORS: Record<string, AdminRequestError["kind"]> = {
  MAINTENANCE_LOGIN_REQUIRED: "login_required", MAINTENANCE_DISABLED: "disabled",
  MAINTENANCE_PROXY_MISCONFIGURED: "proxy_misconfigured", MAINTENANCE_LOCKED: "locked", HTTPS_REQUIRED: "insecure"
};

/** Preserve maintenance expiry handling without treating it as ordinary BI sign-out. */
async function checkMaintenanceAccess(response: Response) {
  if (response.ok) return;
  const body: unknown = await response.clone().json().catch(() => null);
  if (!body || typeof body !== "object" || !("error" in body)) return;
  const problem = (body as { error?: { code?: unknown; requestId?: unknown } }).error;
  if (!problem || typeof problem.code !== "string" || !Object.hasOwn(ACCESS_ERRORS, problem.code)) return;
  const safe = validationSafeError(problem);
  throw new AdminRequestError("维护会话或维护服务不可用，请重新检查维护入口", {
    kind: ACCESS_ERRORS[problem.code], code: safe.code, requestId: safe.requestId, status: response.status
  });
}

interface ValidationRuntime extends BiQueryJobRuntime {
  fetchDashboard?: typeof fetchDailyDashboard;
}

/** Two station jobs finish before synchronous reads; the existing runners own polling and the global read queue. */
export function createOperatingValidationRunner(runtime: ValidationRuntime = {}) {
  const fetcher = runtime.fetch ?? ((input, init) => fetch(input, init));
  const fetchDashboard = runtime.fetchDashboard ?? fetchDailyDashboard;
  const now = runtime.now ?? (() => performance.now());
  return async (date: string, csrfToken: string, options: {
    signal?: AbortSignal;
    onUpdate?: (report: OperatingValidationReport) => void;
    onMaintenanceError?: (error: AdminRequestError) => void;
  } = {}): Promise<OperatingValidationReport> => {
    const started = now(), controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    const report: OperatingValidationReport = { schemaVersion: "operating-validation/v1",
      evidenceSource: "BI代理已校验业务投影（非上游原始HTTP）", environment: "production", date,
      startedAt: new Date().toISOString(), elapsedMs: 0, status: "running", stage: "capabilities", groups: [], candidate: [], baseline: [], events: [] };
    const elapsed = () => Math.max(0, now() - started);
    const publish = () => {
      report.elapsedMs = elapsed();
      options.onUpdate?.({ ...report, groups: report.groups.map(group => ({ ...group })), candidate: [...report.candidate], baseline: [...report.baseline], events: [...report.events] });
    };
    const event = (item: Omit<OperatingValidationEvent, "elapsedMs">) => { report.events.push({ elapsedMs: elapsed(), ...item }); publish(); };
    const check = () => {
      controller.signal.throwIfAborted();
      if (currentDataEnvironmentPreference() !== "production") throw new V2RequestError("联调只允许正式数据", { kind: "error", code: "VALIDATION_PRODUCTION_REQUIRED", status: 409 });
    };
    const maintenanceFailure = (error: unknown) => {
      if (error instanceof AdminRequestError && Object.hasOwn(ACCESS_ERRORS, error.code)) {
        report.error = validationSafeError(error);
        controller.abort(error);
        options.onMaintenanceError?.(error);
      }
    };
    const exchange = async (path: string, init: RequestInit, operation: "capabilities" | "create" | "status" | "result", group?: OperatingValidationGroup) => {
      check();
      const headers = new Headers(init.headers);
      headers.set("x-ypbi-data-environment", "production");
      if (init.method === "POST") headers.set("x-csrf-token", csrfToken);
      const began = now();
      const response = await fetcher(path, { ...init, headers, cache: "no-store", credentials: "same-origin" });
      check();
      event({ operation, site: group?.site, httpStatus: response.status, startedElapsedMs: Math.max(0, began - started), responseHeadersMs: Math.max(0, now() - began) });
      await checkMaintenanceAccess(response);
      check();
      if (operation === "create" && group && response.ok) {
        const parsed = operatingQueryJobCreatedSchema.safeParse(await response.clone().json().catch(() => null));
        if (parsed.success && parsed.data.data.date === date && JSON.stringify(parsed.data.data.pids) === JSON.stringify(group.pids)) {
          group.handle = parsed.data.data.handle;
          group.reused = parsed.data.data.reused;
          group.createMs = Math.max(0, now() - began);
          event({ operation: "create", site: group.site, reused: group.reused, durationMs: group.createMs });
        }
      }
      return response;
    };
    try {
      check();
      publish();
      const capController = new AbortController();
      const capAbort = () => capController.abort(controller.signal.reason);
      controller.signal.addEventListener("abort", capAbort, { once: true });
      const timeout = setTimeout(() => capController.abort(), 15_000);
      let caps;
      try {
        const response = await exchange(`${OPERATING_QUERY_VALIDATION_PATH}/capabilities`, { method: "GET", headers: { accept: "application/json" }, signal: capController.signal }, "capabilities");
        caps = (await parseResponse(response, operatingQueryValidationCapabilitiesSchema, capController.signal)).data;
      } finally { clearTimeout(timeout); controller.signal.removeEventListener("abort", capAbort); }
      check();
      if (!caps.enabled || !caps.groups.length) throw new V2RequestError("联调范围未开放", { kind: "error", code: "VALIDATION_DISABLED", status: 409 });
      report.groups = caps.groups.map(group => ({ ...group, pids: [...group.pids], state: "waiting", syncCompleted: 0, syncFailed: 0 }));
      report.stage = "async"; publish();
      let groupIndex = 0;
      await Promise.all(Array.from({ length: Math.min(2, report.groups.length) }, async () => {
        for (;;) {
          check();
          const group = report.groups[groupIndex++];
          if (!group) return;
          const began = now();
          let queryCompletedAt: number | undefined;
          let activeOperation: "create" | "status" | "result" = "create";
          group.state = "creating"; publish();
          const runner = createOperatingQueryJobRunner({ ...runtime, fetch: (path, init) => {
            if (!JOB_PATH.test(path)) throw new V2RequestError("联调路径无效", { kind: "error", code: "VALIDATION_PATH_REJECTED", status: 400 });
            const operation = path === JOB_PREFIX ? "create" : path.endsWith("/result") ? "result" : "status";
            activeOperation = operation;
            return exchange(OPERATING_QUERY_VALIDATION_PATH + path.slice(JOB_PREFIX.length), init, operation, group);
          } });
          try {
            const dashboards = await runner({ kind: "operating-snapshot", pids: group.pids, date }, { signal: controller.signal, onProgress: progress => {
              check(); group.state = "running"; group.progress = progress;
              if (progress.status === "SUCCEEDED" && queryCompletedAt === undefined) {
                queryCompletedAt = now(); group.queryMs = Math.max(0, queryCompletedAt - began - (group.createMs ?? 0));
              }
              event({ operation: "progress", site: group.site, progress });
            } });
            check();
            report.candidate.push(...dashboards); group.state = "complete";
            group.projectionMs = queryCompletedAt === undefined ? undefined : Math.max(0, now() - queryCompletedAt);
          } catch (error) {
            maintenanceFailure(error);
            group.state = controller.signal.aborted ? "cancelled" : "failed";
            if (!controller.signal.aborted) {
              group.error = validationSafeError(error);
              event({ operation: activeOperation, site: group.site, error: group.error });
            } else if (report.error) group.error = { ...report.error };
            else delete group.error;
          } finally { group.asyncMs = Math.max(0, now() - began); publish(); }
        }
      }));
      check();
      report.stage = "sync"; publish();
      const work = report.groups.flatMap(group => group.pids.map(pid => ({ group, pid })));
      let pidIndex = 0;
      await Promise.all(Array.from({ length: Math.min(6, work.length) }, async () => {
        for (;;) {
          check();
          const item = work[pidIndex++];
          if (!item) return;
          const began = now();
          try {
            const result = await fetchDashboard({ boardId: "5.2", pid: item.pid, dateRange: operatingQueryDateRange(date), projection: "operating_snapshot" }, OPERATING_METRIC_IDS, controller.signal);
            check(); report.baseline.push(result); item.group.syncCompleted++;
            event({ operation: "sync", site: item.group.site, pid: item.pid, durationMs: Math.max(0, now() - began) });
          } catch (error) {
            maintenanceFailure(error);
            if (!controller.signal.aborted) {
              item.group.syncFailed++;
              event({ operation: "sync", site: item.group.site, pid: item.pid, durationMs: Math.max(0, now() - began), error: validationSafeError(error) });
            }
          }
        }
      }));
      check(); report.stage = "comparison";
      report.comparison = compareOperatingValidation(report.candidate, report.baseline, { pids: work.map(item => item.pid), date });
      report.status = "complete"; event({ operation: "comparison" });
    } catch (error) {
      maintenanceFailure(error);
      report.status = controller.signal.aborted && !report.error ? "cancelled" : "failed";
      report.error ??= report.status === "failed" ? validationSafeError(error) : undefined;
      if (report.status === "cancelled") event({ operation: "cancel" });
    } finally {
      options.signal?.removeEventListener("abort", abort);
      report.groups.forEach(group => { if (["waiting", "creating", "running"].includes(group.state)) group.state = "cancelled"; });
      report.stage = "finished"; report.finishedAt = new Date().toISOString(); publish();
    }
    return report;
  };
}

export const runOperatingValidation = createOperatingValidationRunner();
