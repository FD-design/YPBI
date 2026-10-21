import { randomUUID } from "node:crypto";
import {
  operatingQueryDateRange, operatingQueryJobCreatedSchema, operatingQueryJobProgressSchema,
  operatingQueryJobRequestSchema, operatingQueryJobResultSchema,
  type OperatingQueryJobRequest
} from "../../contracts/operating-query-jobs";
import type { DailyDashboardSuccess } from "../../contracts/daily-dashboard";
import type { Principal } from "../identity/identity-provider";
import { currentUpstreamRequestProfile } from "../upstream/request-profile";
import { toBeijingDate } from "../upstream/date";
import { BiQueryJobError, type BiQueryJobService } from "./query-jobs.service";
import { dailyDashboardMatchesMapping, type DailyDashboardService, type OperatingModernSources } from "./daily-dashboard.service";
import { createOperatingQueryPlan, normalizeOperatingQueryResults, type OperatingQueryPlan } from "./operating-query-plan";

type Jobs = Pick<BiQueryJobService, "create" | "status" | "result">;
type Daily = Pick<DailyDashboardService, "executeOperating">;
type Progress = Awaited<ReturnType<Jobs["status"]>>["data"];
type Entry = {
  handle: string; jobHandle: string; scope: OperatingQueryJobRequest; plan: OperatingQueryPlan; createdAt: number;
  controller: AbortController; timer: ReturnType<typeof setTimeout>;
  resolveSources?: (sources: Map<string, OperatingModernSources>) => void; rejectSources?: (reason: unknown) => void;
  dashboards?: DailyDashboardSuccess[]; error?: unknown; modernResolved: boolean;
};
const MAX_BINDINGS = 64;
const BINDING_TTL_MS = 60 * 60_000;
const PROJECTION_WAIT_MS = 5 * 60_000 + 120_000 + 30_000;

function invalid(message = "经营任务结果未通过范围校验") {
  return new BiQueryJobError("QUERY_JOB_RESULT_INVALID", 502, message);
}
function requireTest() {
  if (currentUpstreamRequestProfile()?.environment !== "test") {
    throw new BiQueryJobError("QUERY_JOB_FORBIDDEN", 403, "经营异步查询仅在已验证的测试环境使用");
  }
}

/** Ephemeral server plans reference existing identity-bound jobs; browsers never supply source rows. */
export class OperatingQueryJobService {
  private readonly entries = new Map<string, Entry>();
  private creating = 0;
  constructor(private readonly jobs: Jobs, private readonly daily: Daily, private readonly now = Date.now) {}

  handles(handle: string) { return this.entries.has(handle); }

  private stop(entry: Entry, reason: unknown) {
    clearTimeout(entry.timer);
    entry.rejectSources?.(reason);
    entry.resolveSources = undefined;
    entry.rejectSources = undefined;
    entry.controller.abort(reason);
  }

  close() {
    for (const entry of this.entries.values()) this.stop(entry, invalid("经营查询进程已结束"));
    this.entries.clear();
  }

  private entry(handle: string) {
    const entry = this.entries.get(handle);
    if (!entry || this.now() - entry.createdAt >= BINDING_TTL_MS) {
      throw new BiQueryJobError("QUERY_JOB_NOT_FOUND", 404, "经营查询访问许可已失效，请重新查询");
    }
    return entry;
  }

  async create(principal: Principal, raw: unknown, signal?: AbortSignal) {
    requireTest(); signal?.throwIfAborted();
    const parsed = operatingQueryJobRequestSchema.safeParse(raw);
    if (!parsed.success) throw new BiQueryJobError("QUERY_JOB_INVALID", 400, "经营任务参数不合法");
    for (const [handle, entry] of this.entries) if (this.now() - entry.createdAt >= BINDING_TTL_MS) {
      this.stop(entry, invalid("经营查询访问许可已失效")); this.entries.delete(handle);
    }
    if (this.entries.size + this.creating >= MAX_BINDINGS) throw new BiQueryJobError("QUERY_JOB_CAPACITY", 429, "经营查询访问记录已满，请稍后重试");
    const scope = parsed.data;
    const plan = createOperatingQueryPlan(scope.pids, operatingQueryDateRange(scope.date), toBeijingDate(new Date(this.now()).toISOString()));
    this.creating++;
    try {
      const created = await this.jobs.create(principal, plan.request, signal);
      signal?.throwIfAborted();
      const existing = [...this.entries.values()].find(entry => entry.jobHandle === created.data.handle && JSON.stringify(entry.scope) === JSON.stringify(scope));
      if (existing) return operatingQueryJobCreatedSchema.parse({ success: true, data: { ...scope, handle: existing.handle, reused: created.data.reused } });
      let resolveSources!: Entry["resolveSources"], rejectSources!: Entry["rejectSources"];
      const sources = new Promise<Map<string, OperatingModernSources>>((resolve, reject) => { resolveSources = resolve; rejectSources = reject; });
      void sources.catch(() => undefined);
      const controller = new AbortController();
      const handle = randomUUID();
      const entry: Entry = { handle, jobHandle: created.data.handle, scope, plan, createdAt: this.now(), controller,
        resolveSources, rejectSources, modernResolved: false,
        timer: setTimeout(() => { entry.error = invalid("经营查询本地等待已结束，请重新查询"); this.stop(entry, entry.error); }, PROJECTION_WAIT_MS) };
      entry.timer.unref?.();
      this.entries.set(handle, entry);
      // Legacy consumers start inside this request's test profile and await only server-validated modern sources.
      void Promise.all(scope.pids.map(pid => Promise.resolve().then(() => this.daily.executeOperating({ boardId: "5.2", projection: "operating_snapshot", pid, dateRange: plan.dateRange }, sources.then(values => {
        const source = values.get(pid); if (!source) throw invalid(); return source;
      }), controller.signal)))).then(dashboards => {
        if (controller.signal.aborted) return;
        if (dashboards.some(dashboard => !dailyDashboardMatchesMapping(dashboard))) throw invalid();
        entry.dashboards = dashboards;
        clearTimeout(entry.timer);
      }).catch(error => { entry.error = error; this.stop(entry, error); });
      return operatingQueryJobCreatedSchema.parse({ success: true, data: { ...scope, handle, reused: created.data.reused } });
    } finally { this.creating--; }
  }

  private progress(entry: Entry, progress: Progress) {
    const phase = progress.status !== "SUCCEEDED" ? "query" : entry.dashboards ? "complete" : "projection";
    const { results: _results, ...metadata } = progress as Progress & { results?: unknown };
    return operatingQueryJobProgressSchema.parse({ ...metadata, ...entry.scope, handle: entry.handle, phase });
  }

  async status(principal: Principal, handle: string, signal?: AbortSignal) {
    requireTest(); signal?.throwIfAborted();
    const entry = this.entry(handle);
    const response = await this.jobs.status(principal, entry.jobHandle, signal);
    signal?.throwIfAborted();
    if (["FAILED", "EXPIRED"].includes(response.data.status)) this.stop(entry, invalid("后台经营任务已结束"));
    if (response.data.status === "SUCCEEDED" && entry.error) throw entry.error;
    return { success: true as const, data: this.progress(entry, response.data) };
  }

  async result(principal: Principal, handle: string, signal?: AbortSignal) {
    requireTest(); signal?.throwIfAborted();
    const entry = this.entry(handle);
    const response = await this.jobs.result(principal, entry.jobHandle, signal);
    signal?.throwIfAborted();
    if (response.data.status !== "SUCCEEDED") {
      if (["FAILED", "EXPIRED"].includes(response.data.status)) this.stop(entry, invalid("后台经营任务已结束"));
      return operatingQueryJobResultSchema.parse({ success: true, data: this.progress(entry, response.data) });
    }
    if (entry.error) throw entry.error;
    if (!entry.modernResolved) {
      if (!("results" in response.data)) throw invalid();
      try {
        const sources = normalizeOperatingQueryResults(entry.plan, response.data.results);
        entry.resolveSources?.(sources); entry.modernResolved = true;
        entry.resolveSources = undefined; entry.rejectSources = undefined;
      } catch (error) { entry.error = error; this.stop(entry, error); throw error; }
    }
    return operatingQueryJobResultSchema.parse({ success: true, data: { ...this.progress(entry, response.data),
      ...(entry.dashboards ? { dashboards: entry.dashboards } : {}) } });
  }
}
