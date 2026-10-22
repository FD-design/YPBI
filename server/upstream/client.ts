import type { AppEnv } from "../config/env";
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { enabledPlatformsForSite, getEnabledPlatformByPid, type PlatformSiteId } from "../platforms/registry";
import { currentUpstreamRequestProfile } from "./request-profile";
import { RequestWorkQueue } from "./request-work-queue";
import { getUpstreamReadFailure, rememberUpstreamReadFailure, type UpstreamReadFailure } from "./read-failure";
import { captureUpstreamReadObserver, PhysicalReadTrace } from "./read-trace";
export { getUpstreamReadFailure } from "./read-failure";
import {
  queryJobCreateRequestSchema, queryJobTaskIdSchema,
  type QueryJobContext, type QueryJobOperation
} from "./query-jobs.contract";

export type CredentialSite = PlatformSiteId;
interface StoredCredential { token: string; userName?: string; updatedAt: string }
interface PersistedCredentials { primary?: StoredCredential; secondary?: StoredCredential }
interface CredentialProfile { baseUrl: string; token?: string; userName?: string }
function validUserName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}
interface PendingRead {
  promise: Promise<unknown>;
  signal: AbortSignal;
  addConsumer: (signal?: AbortSignal) => void;
  physicalRead?: PhysicalReadTrace;
}
interface ConsumerSignal {
  callbacks: Set<() => void>;
  listener: () => void;
}

export class UpstreamError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 502, readFailure?: UpstreamReadFailure) {
    super(message);
    if (readFailure) rememberUpstreamReadFailure(this, readFailure);
  }
}

export class QueryJobBusinessError extends UpstreamError {
  constructor(public readonly businessCode: number, public readonly httpStatus: number) {
    super("UPSTREAM_QUERY_JOB_REJECTED", "后台拒绝查询任务请求", [400, 404, 409, 500].includes(businessCode) ? businessCode : 502);
  }
}

export class UpstreamClient {
  private static readonly MAX_CACHE_ENTRIES = 500;
  private readonly responseCache = new Map<string, { expiresAt: number; value: unknown }>();
  private readonly inFlight = new Map<string, PendingRead>();
  private readonly consumerSignals = new WeakMap<AbortSignal, ConsumerSignal>();
  private readonly requestWorkQueue: RequestWorkQueue;
  private credentialUpdateQueue: Promise<void> = Promise.resolve();
  private credentials: PersistedCredentials = {};
  private nextPhysicalReadId = 0;

  constructor(
    private readonly env: AppEnv,
    private readonly fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = fetch,
    options: { maxActiveRequests?: number; maxQueuedRequests?: number } = {}
  ) {
    this.requestWorkQueue = new RequestWorkQueue({
      maxActive: options.maxActiveRequests,
      maxQueued: options.maxQueuedRequests,
      timeoutError: reason => new UpstreamError("UPSTREAM_TIMEOUT", "后台接口请求超时", 504, { origin: reason === "cancelled" ? "consumer_cancelled" : "queue_deadline" }),
      overflowError: () => new UpstreamError("UPSTREAM_RATE_LIMITED", "后台接口请求过于频繁", 429)
    });
    try {
      if (existsSync(env.UPSTREAM_CREDENTIALS_FILE)) this.credentials = JSON.parse(readFileSync(env.UPSTREAM_CREDENTIALS_FILE, "utf8")) as PersistedCredentials;
    } catch {
      this.credentials = {};
    }
  }

  private credentialForSite(site: CredentialSite) {
    const stored = this.credentials[site];
    const fallback = site === "primary"
      ? { token: this.env.UPSTREAM_X_TOKEN, userName: this.env.UPSTREAM_USER_NAME }
      : { token: this.env.UPSTREAM_SECONDARY_X_TOKEN, userName: this.env.UPSTREAM_SECONDARY_USER_NAME };
    return stored
      ? { token: stored.token, userName: Object.hasOwn(stored, "userName") ? stored.userName : fallback.userName, updatedAt: stored.updatedAt }
      : { ...fallback, updatedAt: null };
  }

  credentialStatus() {
    const status = (site: CredentialSite) => {
      const { token, userName, updatedAt } = this.credentialForSite(site);
      const configured = typeof token === "string" && token.length > 0 && validUserName(userName);
      return { site, configured, tokenHint: configured ? `••••${token.slice(-4)}` : "未配置", updatedAt, userName: validUserName(userName) ? userName : "" };
    };
    return [status("primary"), status("secondary")];
  }

  /** Tests a projected diagnostic string without exposing configured secrets. */
  isProtectedDiagnosticText(value: string): boolean {
    const profile = currentUpstreamRequestProfile();
    const protectedValues = [
      this.credentials.primary?.token, this.credentials.secondary?.token,
      this.credentials.primary?.userName, this.credentials.secondary?.userName,
      this.env.UPSTREAM_X_TOKEN, this.env.UPSTREAM_SECONDARY_X_TOKEN,
      this.env.TOKEN_MAINTENANCE_KEY, this.env.BI_AUTH_CSRF_SECRET,
      this.env.DATABASE_URL, this.env.BI_AUTH_DATABASE_URL,
      this.env.UPSTREAM_API_BASE_URL, this.env.UPSTREAM_SECONDARY_API_BASE_URL,
      this.env.UPSTREAM_TEST_API_BASE_URL, this.env.UPSTREAM_USER_NAME,
      this.env.UPSTREAM_SECONDARY_USER_NAME, this.env.UPSTREAM_TEST_USER_NAME,
      profile?.token, profile?.userName, profile?.baseUrl, profile?.cachePartition
    ];
    return protectedValues.some(secret => typeof secret === "string" && secret.length > 0 && value.includes(secret));
  }

  private candidateProfile(site: CredentialSite, token?: string, userName?: string) {
    const profile = this.profileForSite(site);
    const testToken = token ?? profile.token;
    if (typeof testToken !== "string" || !testToken) throw new UpstreamError("UPSTREAM_AUTH_FAILED", "Token 不能为空", 401);
    const testUserName = userName === undefined ? profile.userName : typeof userName === "string" ? userName.trim() : undefined;
    if (!validUserName(testUserName)) {
      if (userName !== undefined) throw new UpstreamError("INVALID_CREDENTIAL_INPUT", "后台用户名格式不合法", 400);
      throw new UpstreamError("UPSTREAM_NOT_CONFIGURED", "数据源用户名尚未配置", 503);
    }
    return Object.freeze({ baseUrl: profile.baseUrl, token: testToken, userName: testUserName });
  }

  async verifyCredential(site: CredentialSite, token?: string, userName?: string) {
    return this.verifySiteProfile(site, this.candidateProfile(site, token, userName));
  }

  private async verifySiteProfile(site: CredentialSite, profile: CredentialProfile) {
    const probePlatform = enabledPlatformsForSite(site)[0];
    if (!probePlatform) throw new UpstreamError("UPSTREAM_NOT_CONFIGURED", `站点 ${site} 当前没有可用业务 PID`, 503);
    await this.verifyProfile(profile, probePlatform.pid);
    return { site, valid: true, checkedAt: new Date().toISOString() };
  }

  async verifyPreviewCredential(token: string) {
    if (!this.env.BI_TEST_DATA_PREVIEW_ENABLED || !this.env.UPSTREAM_TEST_API_BASE_URL || !this.env.UPSTREAM_TEST_USER_NAME) {
      throw new UpstreamError("DATA_PREVIEW_DISABLED", "测试数据预览尚未启用", 503);
    }
    const probePids = [...new Set(
      (["primary", "secondary"] as const)
        .map((site) => enabledPlatformsForSite(site)[0]?.pid)
        .filter((pid): pid is string => Boolean(pid))
    )];
    if (!probePids.length) throw new UpstreamError("UPSTREAM_NOT_CONFIGURED", "当前没有可用于测试的业务 PID", 503);
    const profile = {
      baseUrl: this.env.UPSTREAM_TEST_API_BASE_URL,
      userName: this.env.UPSTREAM_TEST_USER_NAME,
      token
    };
    await Promise.all(probePids.map((pid) => this.verifyProfile(profile, pid)));
    return { valid: true as const, checkedAt: new Date().toISOString() };
  }

  private async verifyProfile(profile: CredentialProfile, pid: string) {
    if (!profile.token) throw new UpstreamError("UPSTREAM_AUTH_FAILED", "Token 不能为空", 401);
    if (!validUserName(profile.userName)) throw new UpstreamError("UPSTREAM_NOT_CONFIGURED", "数据源用户名尚未配置", 503);
    const end = new Date();
    const start = new Date(end); start.setDate(end.getDate() - 1);
    const url = new URL("/api/admin/statistics/pDaySum", profile.baseUrl);
    const params = { page: "1", count: "1", pid, sumDateStart: `${start.toISOString().slice(0, 10)} 00:00:00`, sumDateEnd: `${end.toISOString().slice(0, 10)} 23:59:59` };
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    try { await this.fetchJson(url, profile.token, profile.userName); }
    catch (error) {
      if (error instanceof UpstreamError && error.code === "UPSTREAM_INVALID_REQUEST") {
        throw new UpstreamError(error.code, "后台拒绝凭据验证请求", error.statusCode);
      }
      throw error;
    }
  }

  updateCredential(site: CredentialSite, token: string, userName?: string) {
    const operation = this.credentialUpdateQueue.then(() => this.persistCredential(site, token, userName));
    this.credentialUpdateQueue = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  private async persistCredential(site: CredentialSite, token: string, userName?: string) {
    const profile = this.candidateProfile(site, token, userName);
    await this.verifySiteProfile(site, profile);
    const next: PersistedCredentials = { ...this.credentials, [site]: { userName: profile.userName, token: profile.token, updatedAt: new Date().toISOString() } };
    const file = this.env.UPSTREAM_CREDENTIALS_FILE;
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(next), { encoding: "utf8", mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, file);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    this.credentials = next;
    this.responseCache.clear();
    this.inFlight.clear();
    return this.credentialStatus().find((item) => item.site === site)!;
  }

  async get(path: string, params: Record<string, string>, inboundToken?: string, consumerSignal?: AbortSignal): Promise<unknown> {
    const observer = captureUpstreamReadObserver();
    let failed = false;
    try {
    if (consumerSignal?.aborted) throw new UpstreamError("UPSTREAM_TIMEOUT", "后台来源读取超时", 504, { origin: "consumer_cancelled" });
    const requestProfile = currentUpstreamRequestProfile();
    const profile = this.selectProfile(params.pid);
    const token = requestProfile?.token ?? inboundToken ?? profile.token;
    const userName = profile.userName;
    if (typeof token !== "string" || !token) {
      throw new UpstreamError("UPSTREAM_NOT_CONFIGURED", "数据源 Token 尚未配置", 503);
    }
    if (!validUserName(userName)) throw new UpstreamError("UPSTREAM_NOT_CONFIGURED", "数据源用户名尚未配置", 503);
    const url = new URL(path, profile.baseUrl);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    const partition = requestProfile?.cachePartition
      ?? `production:${createHash("sha256").update(`${userName ?? ""}\u0000${token}`).digest("hex")}`;
    const cacheKey = `${partition}\u0000${url.toString()}`;
    const cached = this.responseCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) { observer?.cacheHit(); return cached.value; }
    if (cached) this.responseCache.delete(cacheKey);
    const pending = this.inFlight.get(cacheKey);
    if (pending && !pending.signal.aborted) {
      observer?.physicalReused(pending.physicalRead);
      pending.addConsumer(consumerSignal);
      return await pending.promise;
    }

    const requestController = new AbortController();
    const consumers = new Map<AbortSignal, () => void>();
    let hasUncancelledConsumer = false;
    const releaseConsumers = () => {
      for (const unsubscribe of consumers.values()) unsubscribe();
      consumers.clear();
    };
    const addConsumer = (signal?: AbortSignal) => {
      if (!signal) { hasUncancelledConsumer = true; return; }
      if (consumers.has(signal)) return;
      const cancel = () => {
        consumers.delete(signal);
        if (!hasUncancelledConsumer && consumers.size === 0) requestController.abort();
      };
      consumers.set(signal, this.watchConsumer(signal, cancel));
    };
    addConsumer(consumerSignal);

    const physicalRead = observer ? new PhysicalReadTrace(++this.nextPhysicalReadId) : undefined;
    if (physicalRead) observer?.physicalCreated(physicalRead);
    const request = this.requestWorkQueue.run(
      remainingMs => {
        physicalRead?.markStarted();
        return this.fetchJson(url, token, userName, remainingMs, requestController.signal, undefined, physicalRead);
      },
      this.env.REQUEST_TIMEOUT_MS,
      requestController.signal
    ).then((value) => {
      physicalRead?.markSettled();
      if (this.inFlight.get(cacheKey) !== entry || requestController.signal.aborted) return value;
      this.pruneResponseCache();
      this.responseCache.set(cacheKey, { expiresAt: Date.now() + 60_000, value });
      return value;
    }, error => {
      physicalRead?.markSettled({ code: error instanceof UpstreamError ? error.code : undefined, failure: getUpstreamReadFailure(error) });
      throw error;
    }).finally(() => {
      releaseConsumers();
      if (this.inFlight.get(cacheKey) === entry) this.inFlight.delete(cacheKey);
    });
    const entry: PendingRead = { promise: request, signal: requestController.signal, addConsumer, physicalRead };
    this.inFlight.set(cacheKey, entry);
    return await request;
    } catch (error) {
      failed = true;
      observer?.settle({ code: error instanceof UpstreamError ? error.code : undefined, failure: getUpstreamReadFailure(error) });
      throw error;
    } finally {
      if (!failed) observer?.settle();
    }
  }

  queryJobContext(authorizedPid: string): QueryJobContext {
    const platform = getEnabledPlatformByPid(authorizedPid);
    if (!platform) throw new UpstreamError("UPSTREAM_PID_NOT_AVAILABLE", "所选业务 PID 不存在或已停用", 422);
    const requestProfile = currentUpstreamRequestProfile();
    const profile = this.selectProfile(authorizedPid);
    if (!profile.token || !validUserName(profile.userName)) throw new UpstreamError("UPSTREAM_NOT_CONFIGURED", "数据源账号尚未完整配置", 503);
    const environment = requestProfile?.environment ?? "production";
    const accountRef = createHash("sha256").update(JSON.stringify([new URL(profile.baseUrl).origin, profile.userName])).digest("hex");
    const sourceRef = createHash("sha256").update(JSON.stringify([accountRef, environment, platform.siteId, profile.token, requestProfile?.cachePartition ?? null])).digest("hex");
    return Object.freeze({ routingPid: authorizedPid, siteId: platform.siteId, environment, accountRef, sourceRef });
  }

  /** Fixed read-only query-job operations, with no metric cache, in-flight reuse or automatic retry. */
  async requestQueryJob(context: QueryJobContext, operation: QueryJobOperation, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new UpstreamError("UPSTREAM_TIMEOUT", "后台来源读取超时", 504);
    const current = this.queryJobContext(context.routingPid);
    if (current.siteId !== context.siteId || current.environment !== context.environment
      || current.accountRef !== context.accountRef || current.sourceRef !== context.sourceRef) {
      throw new UpstreamError("UPSTREAM_QUERY_JOB_CONTEXT_CHANGED", "查询任务数据源上下文已变化", 409);
    }
    let path = "/api/admin/bi/v1/queryJobs";
    let body: string | undefined;
    if (operation.kind === "create") {
      const parsed = queryJobCreateRequestSchema.safeParse(operation.body);
      if (!parsed.success) throw new UpstreamError("UPSTREAM_INVALID_REQUEST", "查询任务参数不符合契约", 400);
      if (parsed.data.queries.some(unit => unit.query.pid.split(",").some(pid => getEnabledPlatformByPid(pid)?.siteId !== context.siteId))) {
        throw new UpstreamError("UPSTREAM_INVALID_REQUEST", "查询任务 PID 必须属于绑定站点", 400);
      }
      body = JSON.stringify(parsed.data);
    } else if (operation.kind === "status" || operation.kind === "result") {
      if (!queryJobTaskIdSchema.safeParse(operation.taskId).success) throw new UpstreamError("UPSTREAM_INVALID_REQUEST", "查询任务编号无效", 400);
      path += `/${encodeURIComponent(operation.taskId)}${operation.kind === "result" ? "/result" : ""}`;
    } else {
      throw new UpstreamError("UPSTREAM_INVALID_REQUEST", "查询任务操作无效", 400);
    }
    const profile = this.selectProfile(context.routingPid);
    const url = new URL(path, profile.baseUrl);
    return this.requestWorkQueue.run(
      remainingMs => this.fetchJson(url, profile.token, profile.userName, remainingMs, signal, { queryJob: true, body }),
      this.env.REQUEST_TIMEOUT_MS,
      signal
    );
  }

  private watchConsumer(signal: AbortSignal, onAbort: () => void) {
    let observed = this.consumerSignals.get(signal);
    if (!observed) {
      const callbacks = new Set<() => void>();
      const listener = () => {
        signal.removeEventListener("abort", listener);
        this.consumerSignals.delete(signal);
        const cancelled = [...callbacks];
        callbacks.clear();
        for (const cancel of cancelled) cancel();
      };
      observed = { callbacks, listener };
      this.consumerSignals.set(signal, observed);
      signal.addEventListener("abort", listener, { once: true });
    }
    observed.callbacks.add(onAbort);
    const registration = observed;
    return () => {
      registration.callbacks.delete(onAbort);
      if (registration.callbacks.size === 0 && this.consumerSignals.get(signal) === registration) {
        signal.removeEventListener("abort", registration.listener);
        this.consumerSignals.delete(signal);
      }
    };
  }

  private pruneResponseCache(now = Date.now()) {
    for (const [key, entry] of this.responseCache) {
      if (entry.expiresAt <= now) this.responseCache.delete(key);
    }
    while (this.responseCache.size >= UpstreamClient.MAX_CACHE_ENTRIES) {
      const oldestKey = this.responseCache.keys().next().value;
      if (typeof oldestKey !== "string") break;
      this.responseCache.delete(oldestKey);
    }
  }

  private selectProfile(pid?: string) {
    const platform = pid ? getEnabledPlatformByPid(pid) : undefined;
    if (pid && !platform) throw new UpstreamError("UPSTREAM_PID_NOT_AVAILABLE", "所选业务 PID 不存在或已停用", 422);
    const requestProfile = currentUpstreamRequestProfile();
    if (requestProfile) return requestProfile;
    return this.profileForSite(platform?.siteId ?? "primary");
  }

  private profileForSite(site: CredentialSite) {
    const { token, userName } = this.credentialForSite(site);
    if (site === "secondary") {
      if (!this.env.UPSTREAM_SECONDARY_API_BASE_URL) {
        throw new UpstreamError("UPSTREAM_NOT_CONFIGURED", "站2尚未完整配置后台地址和用户名", 503);
      }
      return { baseUrl: this.env.UPSTREAM_SECONDARY_API_BASE_URL, token, userName };
    }
    if (!this.env.UPSTREAM_API_BASE_URL) throw new UpstreamError("UPSTREAM_NOT_CONFIGURED", "站1尚未配置后台地址", 503);
    return { baseUrl: this.env.UPSTREAM_API_BASE_URL, token, userName };
  }

  private async fetchJson(url: URL, token?: string, userName?: string, timeoutMs = this.env.REQUEST_TIMEOUT_MS, signal?: AbortSignal,
    operation?: { queryJob: true; body?: string }, physicalRead?: PhysicalReadTrace): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onConsumerAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", onConsumerAbort, { once: true });
    let upstreamHttpStatus: number | undefined;
    let upstreamBusinessCode: number | undefined;
    let businessAuthenticationRejected = false;
    try {
      const headers: Record<string, string> = {};
      if (token) headers["x-token"] = token;
      if (userName) headers.name = userName;
      if (operation?.body !== undefined) headers["content-type"] = "application/json";
      const response = await this.fetcher(url, {
        headers,
        signal: controller.signal,
        ...(operation ? { method: operation.body === undefined ? "GET" : "POST", body: operation.body, cache: "no-store" as const, redirect: "error" as const } : {})
      });
      upstreamHttpStatus = response.status;
      physicalRead?.markHeaders(response.status);
      if (response.status === 401 || response.status === 403) throw new UpstreamError("UPSTREAM_AUTH_FAILED", "后台登录状态无效", response.status);
      if (response.status === 429) throw new UpstreamError("UPSTREAM_RATE_LIMITED", "后台接口请求过于频繁", 429);
      if (!response.ok && !(operation ? [400, 404, 409, 500] : [400, 422]).includes(response.status)) throw new UpstreamError("UPSTREAM_FAILED", `后台接口返回 ${response.status}`);
      const payload = await response.json().catch((error: unknown) => {
        if (!response.ok && error instanceof SyntaxError) throw new UpstreamError("UPSTREAM_FAILED", `后台接口返回 ${response.status}`);
        throw error;
      });
      physicalRead?.markBody();
      const hasCode = payload !== null && typeof payload === "object" && Object.hasOwn(payload, "code");
      const rawCode = hasCode ? Reflect.get(payload, "code") : undefined;
      if (typeof rawCode === "number" && Number.isSafeInteger(rawCode) && rawCode >= 0) upstreamBusinessCode = rawCode;
      if (hasCode && typeof rawCode !== "number" && typeof rawCode !== "string") {
        throw new UpstreamError("UPSTREAM_FAILED", response.ok ? "后台业务状态格式无效" : `后台接口返回 ${response.status}`);
      }
      const businessCode = hasCode ? String(rawCode) : "200";
      if (operation && (!hasCode || typeof rawCode !== "number" || !Number.isSafeInteger(rawCode))) {
        throw new UpstreamError("UPSTREAM_INVALID_RESPONSE", "查询任务业务状态格式无效", 502);
      }
      const rawMessage = payload && typeof payload === "object" ? Reflect.get(payload, "err") : undefined;
      const message = Array.isArray(rawMessage) ? rawMessage.map(String).join("；") : String(rawMessage ?? "后台请求失败");
      if (businessCode === "2002") {
        businessAuthenticationRejected = true;
        if (/ip\s*限制|IP\s*限制/i.test(message)) throw new UpstreamError("UPSTREAM_IP_RESTRICTED", "服务器出口 IP 未加入后台白名单", 403);
        throw new UpstreamError("UPSTREAM_AUTH_FAILED", "后台登录状态无效，请更新 Token", 401);
      }
      if (operation) {
        if (rawCode !== 200) throw new QueryJobBusinessError(rawCode as number, response.status);
        if (!response.ok) throw new UpstreamError("UPSTREAM_FAILED", `后台接口返回 ${response.status}`);
        return payload;
      }
      if (!response.ok) {
        const validMessage = typeof rawMessage === "string" ? rawMessage.trim().length > 0
          : Array.isArray(rawMessage) && rawMessage.length > 0 && rawMessage.every(value => typeof value === "string" && value.trim().length > 0);
        if (![400, 422].includes(rawCode) || !validMessage) throw new UpstreamError("UPSTREAM_FAILED", `后台接口返回 ${response.status}`);
      }
      if (response.ok && businessCode !== "200" && /reletionsStat(?:Plus)?\/getDays/.test(url.pathname) && /没有该平台当日数据/.test(message)) {
        return { code: 200, data: [] };
      }
      if (businessCode !== "200") throw new UpstreamError("UPSTREAM_INVALID_REQUEST", message, 422);
      return payload;
    } catch (error) {
      if (error instanceof UpstreamError) {
        if (!getUpstreamReadFailure(error)) rememberUpstreamReadFailure(error, {
          origin: error instanceof QueryJobBusinessError || error.code === "UPSTREAM_INVALID_REQUEST" || businessAuthenticationRejected
            ? "business" : error.code === "UPSTREAM_INVALID_RESPONSE" ? "validation" : "http",
          upstreamHttpStatus, upstreamBusinessCode
        });
        throw error;
      }
      if (error instanceof Error && error.name === "AbortError") throw new UpstreamError("UPSTREAM_TIMEOUT", "后台接口请求超时", 504, {
        origin: signal?.aborted ? "consumer_cancelled" : "http_deadline", upstreamHttpStatus, upstreamBusinessCode
      });
      throw new UpstreamError("UPSTREAM_NETWORK_ERROR", "无法连接后台接口", 502, {
        origin: error instanceof SyntaxError && upstreamHttpStatus !== undefined ? "validation" : "network", upstreamHttpStatus, upstreamBusinessCode
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onConsumerAbort);
    }
  }
}
