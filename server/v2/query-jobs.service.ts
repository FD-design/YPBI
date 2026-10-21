import { createHash, randomUUID } from "node:crypto";
import { biQueryJobRequestSchema, biQueryJobProgressSchema, biQueryJobUnitResultSchema, type BiQueryJobRequest } from "../../contracts/query-jobs";
import type { Principal } from "../identity/identity-provider";
import { getEnabledPlatformByPid } from "../platforms/registry";
import { biV1MetricCodeSchema, biV1MetricDimensionNameSchema, biV1MetricDimensionFilterSchema } from "../upstream/bi-v1.metrics-adapter";
import { monthlyQueryScopes } from "../../contracts/monthly-query-scope";
import { validateBiV1MonthlyMetadata } from "../upstream/bi-v1.monthly-adapter";
import { toBeijingDate } from "../upstream/date";
import { type QueryJobsClient, type QueryJobContext, type QueryJobStatus } from "../upstream/query-jobs";

export class BiQueryJobError extends Error {
  constructor(readonly code: "QUERY_JOB_INVALID" | "QUERY_JOB_FORBIDDEN" | "QUERY_JOB_NOT_FOUND" | "QUERY_JOB_CONTEXT_CHANGED" | "QUERY_JOB_CAPACITY" | "QUERY_JOB_RESULT_INVALID", readonly statusCode: number, message: string) { super(message); }
}
type Port = Pick<QueryJobsClient, "contextForPid" | "create" | "status" | "result">;
type Binding = { handle: string; principalKey: string; source: QueryJobContext; request: BiQueryJobRequest; taskId: string; createdAt: number; terminal: boolean };
type Created = { success: true; data: { handle: string; reused: boolean } };
type PendingOperation<T> = { promise: Promise<T>; controller: AbortController; consumers: Set<symbol>; done: boolean };
const MAX_BINDINGS = 512;
const METADATA_TTL = 60 * 60_000;
// Local admission reservation only; expiry does not declare an upstream task terminal.
const ACTIVE_BUDGET = 7 * 60_000;
const STATUS_RECHECK_TIMEOUT = 5_000;
function digest(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function principalKey(principal: Principal) {
  const pidScope = principal.pidScope === "all" ? "all" : [...new Set(principal.pidScope)].sort();
  return digest([principal.subjectId, principal.securityVersion ?? null, [...principal.roles].sort(), [...principal.permissions].sort(), pidScope]);
}
function invalid(): never { throw new BiQueryJobError("QUERY_JOB_RESULT_INVALID", 502, "查询任务结果与授权范围不一致"); }
function tokens(value: string | undefined) { return value ? [...new Set(value.split(","))].sort() : []; }
const isRetention = (code: string) => ["M020", "M021", "M022", "M023", "M115"].includes(code);
const isPlayback = (code: string) => ["M034", "M036", "M097"].includes(code);
const retentionDays = ["D1", "D3", "D7", "D30"];
const priorDate = (date: string) => new Date(Date.parse(date) - 86_400_000).toISOString().slice(0, 10);
function monthlyScope(query: BiQueryJobRequest["queries"][number]["query"], today: string) {
  const scopes = monthlyQueryScopes(query.startDate, priorDate(query.endDate), today);
  return scopes.length === 1 && scopes[0].queryStart === query.startDate && scopes[0].queryEnd === priorDate(query.endDate) ? scopes[0] : null;
}
function validDimensions(dimensions: readonly string[], filters: Record<string, unknown>, codes: string[]) {
  const allDimensions = [...new Set([...dimensions, ...Object.keys(filters)])];
  return allDimensions.every(key => key === "retentionDay" ? codes.every(code => code === "M115")
    : key === "videoType" ? codes.every(isPlayback) : biV1MetricDimensionNameSchema.safeParse(key).success)
    && (!codes.some(isPlayback) || allDimensions.every(key => key === "videoType"))
    && (filters.retentionDay === undefined || retentionDays.includes(filters.retentionDay as string))
    && (filters.videoType === undefined || typeof filters.videoType === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(filters.videoType))
    && biV1MetricDimensionFilterSchema.safeParse(Object.fromEntries(Object.entries(filters).filter(([key]) => key !== "retentionDay" && key !== "videoType"))).success
    && (!codes.includes("M115") || allDimensions.includes("retentionDay"));
}
function canonical(request: BiQueryJobRequest): BiQueryJobRequest {
  return { queries: request.queries.map(({ query }) => ({ query: {
    ...query, pid: tokens(query.pid).join(","), metricCodes: tokens(query.metricCodes).join(","),
    ...(query.dimensions ? { dimensions: tokens(query.dimensions).join(",") } : {}),
    ...(query.dimensionFilters ? { dimensionFilters: JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(query.dimensionFilters) as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))) } : {})
  } })) };
}
function authorize(principal: Principal, request: BiQueryJobRequest) {
  const pids = [...new Set(request.queries.flatMap(unit => tokens(unit.query.pid)))];
  const platforms = pids.map(pid => getEnabledPlatformByPid(pid));
  if (!principal.permissions.includes("bi:read") || platforms.some(item => !item)
    || pids.some(pid => principal.pidScope !== "all" && !principal.pidScope.includes(pid))) {
    throw new BiQueryJobError("QUERY_JOB_FORBIDDEN", 403, "当前账号无权访问任务查询范围");
  }
  if (new Set(platforms.map(item => item!.siteId)).size !== 1) {
    throw new BiQueryJobError("QUERY_JOB_INVALID", 400, "两站查询必须分别创建任务");
  }
  return pids[0];
}

/** Ephemeral access bindings; a restart loses bindings and fails closed, never reconstructs from a client task ID. */
export class BiQueryJobService {
  private readonly bindings = new Map<string, Binding>();
  private readonly pending = new Map<string, PendingOperation<Created>>();
  private readonly statusChecks = new Map<string, PendingOperation<QueryJobStatus["msg"]["status"] | undefined>>();
  private readonly creatingByAccount = new Map<string, number>();
  constructor(private readonly client: Port, private readonly now = Date.now) {}

  private async waitForPending<T>(pending: PendingOperation<T>, signal?: AbortSignal): Promise<T> {
    const consumer = Symbol();
    pending.consumers.add(consumer);
    let onAbort: (() => void) | undefined;
    try {
      signal?.throwIfAborted();
      const aborted = new Promise<never>((_resolve, reject) => {
        if (signal) { onAbort = () => reject(signal.reason); signal.addEventListener("abort", onAbort, { once: true }); }
      });
      const result = await Promise.race([pending.promise, aborted]);
      signal?.throwIfAborted();
      return result;
    } finally {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      pending.consumers.delete(consumer);
      if (!pending.done && !pending.consumers.size) pending.controller.abort(new Error("query_job_consumers_cancelled"));
    }
  }

  private activeBindings(accountRef: string) {
    return [...this.bindings.values()].filter(binding => binding.source.accountRef === accountRef && !binding.terminal
      && this.now() - binding.createdAt < ACTIVE_BUDGET);
  }

  private accountUsage(accountRef: string) {
    return new Set(this.activeBindings(accountRef).map(binding => binding.taskId)).size + (this.creatingByAccount.get(accountRef) ?? 0);
  }

  private sourceMatches(source: QueryJobContext) {
    try { return JSON.stringify(this.client.contextForPid(source.routingPid)) === JSON.stringify(source); }
    catch { return false; }
  }

  /** Capacity probes retain the original source binding and never treat an unreadable task as finished. */
  private async recheck(binding: Binding, signal?: AbortSignal): Promise<QueryJobStatus["msg"]["status"] | undefined> {
    signal?.throwIfAborted();
    if (!this.sourceMatches(binding.source)) return undefined;
    const key = digest([binding.source, binding.taskId]);
    const waiting = this.statusChecks.get(key);
    if (waiting && !waiting.controller.signal.aborted) return this.waitForPending(waiting, signal);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("query_job_status_recheck_timeout")), STATUS_RECHECK_TIMEOUT);
    let onAbort: (() => void) | undefined;
    const operation = (async () => {
      try {
        const aborted = new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(controller.signal.reason);
          controller.signal.addEventListener("abort", onAbort, { once: true });
        });
        const response = await Promise.race([this.client.status(binding.source, binding.taskId, controller.signal), aborted]);
        controller.signal.throwIfAborted();
        if (!this.sourceMatches(binding.source)) return undefined;
        return this.progress(binding, response.msg).status;
      } catch { return undefined; }
    })();
    const pending: PendingOperation<QueryJobStatus["msg"]["status"] | undefined> = {
      controller, consumers: new Set(), done: false, promise: operation.finally(() => {
        clearTimeout(timer);
        if (onAbort) controller.signal.removeEventListener("abort", onAbort);
        pending.done = true;
        if (this.statusChecks.get(key) === pending) this.statusChecks.delete(key);
      })
    };
    this.statusChecks.set(key, pending);
    return this.waitForPending(pending, signal);
  }

  private async reconcileCapacity(accountRef: string, signal: AbortSignal) {
    const tasks = new Map<string, Binding>();
    for (const binding of this.activeBindings(accountRef)) {
      if (this.sourceMatches(binding.source) && !tasks.has(binding.taskId)) tasks.set(binding.taskId, binding);
    }
    await Promise.all([...tasks.values()].slice(0, 2).map(binding => this.recheck(binding, signal)));
    signal.throwIfAborted();
  }

  async create(principal: Principal, raw: unknown, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const parsed = biQueryJobRequestSchema.safeParse(raw);
    if (!parsed.success || Buffer.byteLength(JSON.stringify(raw)) > 60 * 1024) throw new BiQueryJobError("QUERY_JOB_INVALID", 400, "查询任务参数或大小不合法");
    const request = canonical(parsed.data);
    for (const { query } of request.queries) {
      const codes = tokens(query.metricCodes);
      const filter = query.dimensionFilters ? JSON.parse(query.dimensionFilters) as Record<string, unknown> : {};
      if (!validDimensions(tokens(query.dimensions), filter, codes)) throw new BiQueryJobError("QUERY_JOB_INVALID", 400, "任务维度或筛选尚未接入");
      if (tokens(query.metricCodes).some(code => !biV1MetricCodeSchema.safeParse(code).success)) throw new BiQueryJobError("QUERY_JOB_INVALID", 400, "任务包含未登记的指标");
      if (query.granularity === "cohort_day" && codes.some(code => !isRetention(code))) throw new BiQueryJobError("QUERY_JOB_INVALID", 400, "注册批次粒度仅适用于留存指标");
      if (tokens(query.metricCodes).includes("M018") && (query.metricCodes !== "M018" || query.granularity !== "summary" || !query.startDate.endsWith("-01"))) throw new BiQueryJobError("QUERY_JOB_INVALID", 400, "月活须独立使用自然月查询");
      if (codes.includes("M018") && !monthlyScope(query, toBeijingDate(new Date(this.now()).toISOString()))) throw new BiQueryJobError("QUERY_JOB_INVALID", 400, "月活查询必须匹配独立自然月与统计截止日");
    }
    const routingPid = authorize(principal, request);
    const source = this.client.contextForPid(routingPid);
    const key = digest([principalKey(principal), source, request]);
    const waiting = this.pending.get(key);
    if (waiting && !waiting.controller.signal.aborted) return this.waitForPending(waiting, signal);
    const now = this.now();
    for (const [handle, binding] of this.bindings) if (now - binding.createdAt >= METADATA_TTL) this.bindings.delete(handle);
    if (this.bindings.size + this.pending.size >= MAX_BINDINGS) throw new BiQueryJobError("QUERY_JOB_CAPACITY", 429, "查询任务访问记录已满，请稍后重试");
    const controller = new AbortController();
    let reserved = false;
    const operation = (async () => {
      const existing = this.activeBindings(source.accountRef).find(binding => digest([binding.principalKey, binding.source, binding.request]) === key);
      if (existing) {
        const status = await this.recheck(existing, controller.signal);
        controller.signal.throwIfAborted();
        this.access(principal, existing.handle);
        if (!existing.terminal && this.now() - existing.createdAt < ACTIVE_BUDGET) {
          if (status === "QUEUED" || status === "RUNNING") return { success: true as const, data: { handle: existing.handle, reused: true } };
          throw new BiQueryJobError("QUERY_JOB_CAPACITY", 429, "已有查询任务状态暂未确认，请稍后重试");
        }
      }
      if (this.accountUsage(source.accountRef) >= 2) await this.reconcileCapacity(source.accountRef, controller.signal);
      controller.signal.throwIfAborted();
      if (!this.sourceMatches(source)) throw new BiQueryJobError("QUERY_JOB_CONTEXT_CHANGED", 409, "数据源或会话已变化，请重新查询");
      if (this.accountUsage(source.accountRef) >= 2) throw new BiQueryJobError("QUERY_JOB_CAPACITY", 429, "该数据源账号已有查询任务，请等待原任务结束");
      this.creatingByAccount.set(source.accountRef, (this.creatingByAccount.get(source.accountRef) ?? 0) + 1);
      reserved = true;
      const created = await this.client.create(source, request, controller.signal);
      controller.signal.throwIfAborted();
      if (JSON.stringify(this.client.contextForPid(routingPid)) !== JSON.stringify(source)) throw new BiQueryJobError("QUERY_JOB_CONTEXT_CHANGED", 409, "数据源或会话已变化，请重新查询");
      const handle = randomUUID();
      this.bindings.set(handle, { handle, principalKey: principalKey(principal), source, request, taskId: created.msg.taskId, createdAt: now, terminal: false });
      return { success: true as const, data: { handle, reused: created.msg.reused } };
    })();
    const pending: PendingOperation<Created> = { controller, consumers: new Set(), done: false, promise: operation.finally(() => {
      pending.done = true;
      if (this.pending.get(key) === pending) this.pending.delete(key);
      if (reserved) {
        const left = (this.creatingByAccount.get(source.accountRef) ?? 1) - 1;
        if (left) this.creatingByAccount.set(source.accountRef, left); else this.creatingByAccount.delete(source.accountRef);
      }
    }) };
    this.pending.set(key, pending);
    return this.waitForPending(pending, signal);
  }

  private access(principal: Principal, handle: string) {
    const binding = this.bindings.get(handle);
    if (!binding || this.now() - binding.createdAt >= METADATA_TTL || binding.principalKey !== principalKey(principal)) throw new BiQueryJobError("QUERY_JOB_NOT_FOUND", 404, "查询任务不存在或当前访问许可已失效");
    authorize(principal, binding.request);
    const current = this.client.contextForPid(binding.source.routingPid);
    if (JSON.stringify(current) !== JSON.stringify(binding.source)) throw new BiQueryJobError("QUERY_JOB_CONTEXT_CHANGED", 409, "数据源或会话已变化，请在当前环境重新查询");
    return binding;
  }
  private progress(binding: Binding, message: QueryJobStatus["msg"]) {
    if (message.taskId !== binding.taskId || message.totalUnits !== undefined && message.totalUnits !== binding.request.queries.length
      || message.completedUnits !== undefined && message.completedUnits > binding.request.queries.length) return invalid();
    const data = biQueryJobProgressSchema.safeParse({ ...message, handle: binding.handle,
      ...(message.errorCode ? { errorCode: ["QUEUE_TIMEOUT", "DEADLINE_EXCEEDED", "LEASE_EXHAUSTED", "RESULT_TOO_LARGE", "RESULT_CAPACITY", "EXECUTION_FAILED"].includes(message.errorCode) ? message.errorCode : "UNKNOWN" } : {}) });
    if (!data.success) return invalid();
    if (["SUCCEEDED", "FAILED", "EXPIRED"].includes(data.data.status)) {
      for (const other of this.bindings.values()) if (other.source.accountRef === binding.source.accountRef && other.taskId === binding.taskId) other.terminal = true;
    }
    return data.data;
  }
  async status(principal: Principal, handle: string, signal?: AbortSignal) {
    const binding = this.access(principal, handle);
    const result = await this.client.status(binding.source, binding.taskId, signal);
    signal?.throwIfAborted();
    this.access(principal, handle);
    return { success: true as const, data: this.progress(binding, result.msg) };
  }
  async result(principal: Principal, handle: string, signal?: AbortSignal) {
    const binding = this.access(principal, handle);
    const result = await this.client.result(binding.source, binding.taskId, binding.request.queries.length, signal);
    signal?.throwIfAborted();
    this.access(principal, handle);
    const progress = this.progress(binding, result.msg);
    if (result.msg.status !== "SUCCEEDED") return { success: true as const, data: progress };
    const results = result.msg.results.map((unit, index) => {
      const parsed = biQueryJobUnitResultSchema.safeParse(unit);
      if (!parsed.success) return invalid();
      const query = binding.request.queries[index]?.query;
      if (!query) return invalid();
      const requestedPids = tokens(query.pid), codes = tokens(query.metricCodes);
      const filter = query.dimensionFilters ? JSON.parse(query.dimensionFilters) as Record<string, unknown> : {};
      const requestedDimensions = new Set([...tokens(query.dimensions), ...Object.keys(filter), "pid"]);
      const coverageKeys = new Set<string>();
      for (const coverage of parsed.data.sourceCoverage ?? []) {
        if (!codes.includes(coverage.metricCode) || !requestedPids.includes(coverage.pid)
          || coverage.businessDate < query.startDate || coverage.businessDate >= query.endDate) return invalid();
        const identity = digest([coverage.metricCode, coverage.pid, coverage.businessDate]);
        if (coverageKeys.has(identity)) return invalid();
        coverageKeys.add(identity);
      }
      const seen = new Set<string>();
      for (const row of parsed.data.rows) {
        const pid = row.dimensions.pid;
        if (row.metricVersion !== "bi-v1" || typeof pid !== "string" || !requestedPids.includes(pid)
          || row.pid !== undefined && row.pid !== pid || !codes.includes(row.metricCode)) return invalid();
        if (row.businessDate !== undefined ? row.businessDate < query.startDate || row.businessDate >= query.endDate : query.granularity !== "summary" && row.dataStatus === "READY") return invalid();
        if (Object.keys(row.dimensions).some(key => !requestedDimensions.has(key))
          || [...requestedDimensions].some(key => !(key in row.dimensions))
          || Object.entries(filter).some(([key, value]) => row.dimensions[key] !== value)) return invalid();
        if (!validDimensions(Object.keys(row.dimensions).filter(key => key !== "pid"), Object.fromEntries(Object.entries(row.dimensions).filter(([key]) => key !== "pid")), [row.metricCode])) return invalid();
        if (row.metricCode === "M018") {
          const today = toBeijingDate(new Date(binding.createdAt).toISOString()), scope = monthlyScope(query, today);
          if (!scope) return invalid();
          try { validateBiV1MonthlyMetadata(row, scope, today); } catch { return invalid(); }
        } else if ([row.month, row.cutoffDate, row.isComplete, row.mau].some(value => value !== undefined)) return invalid();
        const identity = digest([row.metricCode, row.businessDate ?? null, Object.entries(row.dimensions).sort(([a], [b]) => a.localeCompare(b))]);
        if (seen.has(identity)) return invalid();
        seen.add(identity);
      }
      return parsed.data;
    });
    if (results.length !== binding.request.queries.length) return invalid();
    return { success: true as const, data: { ...progress, results } };
  }
}
