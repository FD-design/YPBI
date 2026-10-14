import type { AppEnv } from "../config/env";
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { enabledPlatformsForSite, getEnabledPlatformByPid, type PlatformSiteId } from "../platforms/registry";
import { currentUpstreamRequestProfile } from "./request-profile";
import { RequestWorkQueue } from "./request-work-queue";

export type CredentialSite = PlatformSiteId;
interface PersistedCredentials { primary?: { token: string; updatedAt: string }; secondary?: { token: string; updatedAt: string } }
interface PendingRead {
  promise: Promise<unknown>;
  queueSignal: AbortSignal;
  addConsumer: (signal?: AbortSignal) => void;
}
interface QueuedConsumerSignal {
  callbacks: Set<() => void>;
  listener: () => void;
}

export class UpstreamError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 502) {
    super(message);
  }
}

export class UpstreamClient {
  private static readonly MAX_CACHE_ENTRIES = 500;
  private readonly responseCache = new Map<string, { expiresAt: number; value: unknown }>();
  private readonly inFlight = new Map<string, PendingRead>();
  private readonly queuedConsumerSignals = new WeakMap<AbortSignal, QueuedConsumerSignal>();
  private readonly requestWorkQueue: RequestWorkQueue;
  private credentialUpdateQueue: Promise<void> = Promise.resolve();
  private credentials: PersistedCredentials = {};

  constructor(
    private readonly env: AppEnv,
    private readonly fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = fetch,
    options: { maxActiveRequests?: number; maxQueuedRequests?: number } = {}
  ) {
    this.requestWorkQueue = new RequestWorkQueue({
      maxActive: options.maxActiveRequests,
      maxQueued: options.maxQueuedRequests,
      timeoutError: () => new UpstreamError("UPSTREAM_TIMEOUT", "后台接口请求超时", 504),
      overflowError: () => new UpstreamError("UPSTREAM_RATE_LIMITED", "后台接口请求过于频繁", 429)
    });
    try {
      if (existsSync(env.UPSTREAM_CREDENTIALS_FILE)) this.credentials = JSON.parse(readFileSync(env.UPSTREAM_CREDENTIALS_FILE, "utf8")) as PersistedCredentials;
    } catch {
      this.credentials = {};
    }
  }

  credentialStatus() {
    const status = (site: CredentialSite, fallback?: string, userName?: string) => {
      const stored = this.credentials[site];
      const token = stored?.token ?? fallback ?? "";
      return { site, configured: Boolean(token), tokenHint: token ? `••••${token.slice(-4)}` : "未配置", updatedAt: stored?.updatedAt ?? null, userName: userName ?? "" };
    };
    return [status("primary", this.env.UPSTREAM_X_TOKEN, this.env.UPSTREAM_USER_NAME), status("secondary", this.env.UPSTREAM_SECONDARY_X_TOKEN, this.env.UPSTREAM_SECONDARY_USER_NAME)];
  }

  async verifyCredential(site: CredentialSite, token?: string) {
    const profile = this.profileForSite(site);
    const testToken = token ?? profile.token;
    if (!testToken) throw new UpstreamError("UPSTREAM_AUTH_FAILED", "Token 不能为空", 401);
    const probePlatform = enabledPlatformsForSite(site)[0];
    if (!probePlatform) throw new UpstreamError("UPSTREAM_NOT_CONFIGURED", `站点 ${site} 当前没有可用业务 PID`, 503);
    await this.verifyProfile({ ...profile, token: testToken }, probePlatform.pid);
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

  private async verifyProfile(profile: { baseUrl: string; token?: string; userName?: string }, pid: string) {
    if (!profile.token) throw new UpstreamError("UPSTREAM_AUTH_FAILED", "Token 不能为空", 401);
    const end = new Date();
    const start = new Date(end); start.setDate(end.getDate() - 1);
    const url = new URL("/api/admin/statistics/pDaySum", profile.baseUrl);
    const params = { page: "1", count: "1", pid, sumDateStart: `${start.toISOString().slice(0, 10)} 00:00:00`, sumDateEnd: `${end.toISOString().slice(0, 10)} 23:59:59` };
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    await this.fetchJson(url, profile.token, profile.userName);
  }

  updateCredential(site: CredentialSite, token: string) {
    const operation = this.credentialUpdateQueue.then(() => this.persistCredential(site, token));
    this.credentialUpdateQueue = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  private async persistCredential(site: CredentialSite, token: string) {
    await this.verifyCredential(site, token);
    const next: PersistedCredentials = { ...this.credentials, [site]: { token, updatedAt: new Date().toISOString() } };
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
    if (consumerSignal?.aborted) throw new UpstreamError("UPSTREAM_TIMEOUT", "后台来源读取超时", 504);
    const requestProfile = currentUpstreamRequestProfile();
    const profile = this.selectProfile(params.pid);
    const token = requestProfile?.token ?? inboundToken ?? profile.token;
    const userName = profile.userName;
    if (!token) {
      throw new UpstreamError("UPSTREAM_NOT_CONFIGURED", "数据源 Token 尚未配置", 503);
    }
    const url = new URL(path, profile.baseUrl);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    const partition = requestProfile?.cachePartition
      ?? `production:${createHash("sha256").update(`${userName ?? ""}\u0000${token}`).digest("hex")}`;
    const cacheKey = `${partition}\u0000${url.toString()}`;
    const cached = this.responseCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    if (cached) this.responseCache.delete(cacheKey);
    const pending = this.inFlight.get(cacheKey);
    if (pending && !pending.queueSignal.aborted) {
      pending.addConsumer(consumerSignal);
      return pending.promise;
    }

    const queueController = new AbortController();
    const consumers = new Map<AbortSignal, () => void>();
    let started = false, hasUncancelledConsumer = false;
    const releaseConsumers = () => {
      for (const unsubscribe of consumers.values()) unsubscribe();
      consumers.clear();
    };
    const addConsumer = (signal?: AbortSignal) => {
      if (started) return;
      if (!signal) { hasUncancelledConsumer = true; return; }
      if (consumers.has(signal)) return;
      const cancel = () => {
        consumers.delete(signal);
        if (!started && !hasUncancelledConsumer && consumers.size === 0) queueController.abort();
      };
      consumers.set(signal, this.watchQueuedConsumer(signal, cancel));
    };
    addConsumer(consumerSignal);

    const request = this.requestWorkQueue.run(
      remainingMs => {
        started = true;
        releaseConsumers();
        return this.fetchJson(url, token, userName, remainingMs);
      },
      this.env.REQUEST_TIMEOUT_MS,
      queueController.signal
    ).then((value) => {
      if (this.inFlight.get(cacheKey) !== entry) return value;
      this.pruneResponseCache();
      this.responseCache.set(cacheKey, { expiresAt: Date.now() + 60_000, value });
      return value;
    }).finally(() => {
      releaseConsumers();
      if (this.inFlight.get(cacheKey) === entry) this.inFlight.delete(cacheKey);
    });
    const entry: PendingRead = { promise: request, queueSignal: queueController.signal, addConsumer };
    this.inFlight.set(cacheKey, entry);
    return request;
  }

  private watchQueuedConsumer(signal: AbortSignal, onAbort: () => void) {
    let observed = this.queuedConsumerSignals.get(signal);
    if (!observed) {
      const callbacks = new Set<() => void>();
      const listener = () => {
        signal.removeEventListener("abort", listener);
        this.queuedConsumerSignals.delete(signal);
        const cancelled = [...callbacks];
        callbacks.clear();
        for (const cancel of cancelled) cancel();
      };
      observed = { callbacks, listener };
      this.queuedConsumerSignals.set(signal, observed);
      signal.addEventListener("abort", listener, { once: true });
    }
    observed.callbacks.add(onAbort);
    const registration = observed;
    return () => {
      registration.callbacks.delete(onAbort);
      if (registration.callbacks.size === 0 && this.queuedConsumerSignals.get(signal) === registration) {
        signal.removeEventListener("abort", registration.listener);
        this.queuedConsumerSignals.delete(signal);
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
    if (site === "secondary") {
      if (!this.env.UPSTREAM_SECONDARY_API_BASE_URL || !this.env.UPSTREAM_SECONDARY_USER_NAME) {
        throw new UpstreamError("UPSTREAM_NOT_CONFIGURED", "站2尚未完整配置后台地址和用户名", 503);
      }
      return { baseUrl: this.env.UPSTREAM_SECONDARY_API_BASE_URL, token: this.credentials.secondary?.token ?? this.env.UPSTREAM_SECONDARY_X_TOKEN, userName: this.env.UPSTREAM_SECONDARY_USER_NAME };
    }
    if (!this.env.UPSTREAM_API_BASE_URL) throw new UpstreamError("UPSTREAM_NOT_CONFIGURED", "站1尚未配置后台地址", 503);
    return { baseUrl: this.env.UPSTREAM_API_BASE_URL, token: this.credentials.primary?.token ?? this.env.UPSTREAM_X_TOKEN, userName: this.env.UPSTREAM_USER_NAME };
  }

  private async fetchJson(url: URL, token?: string, userName?: string, timeoutMs = this.env.REQUEST_TIMEOUT_MS): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = {};
      if (token) headers["x-token"] = token;
      if (userName) headers.name = userName;
      const response = await this.fetcher(url, {
        headers,
        signal: controller.signal
      });
      if (response.status === 401 || response.status === 403) throw new UpstreamError("UPSTREAM_AUTH_FAILED", "后台登录状态无效", response.status);
      if (response.status === 429) throw new UpstreamError("UPSTREAM_RATE_LIMITED", "后台接口请求过于频繁", 429);
      if (!response.ok && ![400, 422].includes(response.status)) throw new UpstreamError("UPSTREAM_FAILED", `后台接口返回 ${response.status}`);
      const payload = await response.json().catch((error: unknown) => {
        if (!response.ok && error instanceof SyntaxError) throw new UpstreamError("UPSTREAM_FAILED", `后台接口返回 ${response.status}`);
        throw error;
      });
      const rawCode = payload && typeof payload === "object" ? Reflect.get(payload, "code") : undefined;
      const businessCode = String(rawCode ?? "200");
      const rawMessage = payload && typeof payload === "object" ? Reflect.get(payload, "err") : undefined;
      const message = Array.isArray(rawMessage) ? rawMessage.map(String).join("；") : String(rawMessage ?? "后台请求失败");
      if (businessCode === "2002") {
        if (/ip\s*限制|IP\s*限制/i.test(message)) throw new UpstreamError("UPSTREAM_IP_RESTRICTED", "服务器出口 IP 未加入后台白名单", 403);
        throw new UpstreamError("UPSTREAM_AUTH_FAILED", "后台登录状态无效，请更新 Token", 401);
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
      if (error instanceof UpstreamError) throw error;
      if (error instanceof Error && error.name === "AbortError") throw new UpstreamError("UPSTREAM_TIMEOUT", "后台接口请求超时", 504);
      throw new UpstreamError("UPSTREAM_NETWORK_ERROR", "无法连接后台接口");
    } finally {
      clearTimeout(timer);
    }
  }
}
