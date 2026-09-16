import type { AppEnv } from "../config/env";
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { enabledPlatformsForSite, getEnabledPlatformByPid, type PlatformSiteId } from "../platforms/registry";

export type CredentialSite = PlatformSiteId;
interface PersistedCredentials { primary?: { token: string; updatedAt: string }; secondary?: { token: string; updatedAt: string } }

export class UpstreamError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 502) {
    super(message);
  }
}

export class UpstreamClient {
  private static readonly MAX_CACHE_ENTRIES = 500;
  private readonly responseCache = new Map<string, { expiresAt: number; value: unknown }>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private credentialUpdateQueue: Promise<void> = Promise.resolve();
  private credentials: PersistedCredentials = {};

  constructor(
    private readonly env: AppEnv,
    private readonly fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = fetch
  ) {
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
    const end = new Date();
    const start = new Date(end); start.setDate(end.getDate() - 1);
    const url = new URL("/api/admin/statistics/pDaySum", profile.baseUrl);
    const params = { page: "1", count: "1", pid: probePlatform.pid, sumDateStart: `${start.toISOString().slice(0, 10)} 00:00:00`, sumDateEnd: `${end.toISOString().slice(0, 10)} 23:59:59` };
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    await this.fetchJson(url, testToken, profile.userName);
    return { site, valid: true, checkedAt: new Date().toISOString() };
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

  async get(path: string, params: Record<string, string>, inboundToken?: string): Promise<unknown> {
    const profile = this.selectProfile(params.pid);
    const token = inboundToken || profile.token;
    if (!token) {
      throw new UpstreamError("UPSTREAM_NOT_CONFIGURED", "数据源 Token 尚未配置", 503);
    }
    const url = new URL(path, profile.baseUrl);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    const cacheKey = `${token}\u0000${url.toString()}`;
    const cached = this.responseCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    if (cached) this.responseCache.delete(cacheKey);
    const pending = this.inFlight.get(cacheKey);
    if (pending) return pending;

    const request = this.fetchJson(url, token, profile.userName).then((value) => {
      this.pruneResponseCache();
      this.responseCache.set(cacheKey, { expiresAt: Date.now() + 60_000, value });
      return value;
    }).finally(() => this.inFlight.delete(cacheKey));
    this.inFlight.set(cacheKey, request);
    return request;
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
    if (!pid) return this.profileForSite("primary");
    const platform = getEnabledPlatformByPid(pid);
    if (!platform) {
      throw new UpstreamError("UPSTREAM_PID_NOT_AVAILABLE", "所选业务 PID 不存在或已停用", 422);
    }
    return this.profileForSite(platform.siteId);
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

  private async fetchJson(url: URL, token?: string, userName?: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.env.REQUEST_TIMEOUT_MS);
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
      if (!response.ok) throw new UpstreamError("UPSTREAM_FAILED", `后台接口返回 ${response.status}`);
      const payload = await response.json();
      if (payload && typeof payload === "object") {
        const businessCode = String(Reflect.get(payload, "code") ?? "200");
        const rawMessage = Reflect.get(payload, "err");
        const message = Array.isArray(rawMessage) ? rawMessage.map(String).join("；") : String(rawMessage ?? "后台请求失败");
        if (businessCode === "2002") {
          if (/ip\s*限制|IP\s*限制/i.test(message)) throw new UpstreamError("UPSTREAM_IP_RESTRICTED", "服务器出口 IP 未加入后台白名单", 403);
          throw new UpstreamError("UPSTREAM_AUTH_FAILED", "后台登录状态无效，请更新 Token", 401);
        }
        if (businessCode !== "200" && /reletionsStat(?:Plus)?\/getDays/.test(url.pathname) && /没有该平台当日数据/.test(message)) {
          return { code: 200, data: [] };
        }
        if (businessCode !== "200") throw new UpstreamError("UPSTREAM_INVALID_REQUEST", message, 422);
      }
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
