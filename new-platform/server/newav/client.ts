export interface NewavClientConfig {
  baseUrl?: string;
  token?: string;
  timeoutMs: number;
}

export class NewavError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 502) {
    super(message);
  }
}

export class NewavClient {
  private static readonly MAX_CACHE_ENTRIES = 200;
  private readonly cache = new Map<string, { expiresAt: number; value: unknown }>();
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(
    private readonly config: NewavClientConfig,
    private readonly fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = fetch
  ) {}

  configured() {
    return Boolean(this.config.baseUrl && this.config.token);
  }

  status() {
    const token = this.config.token ?? "";
    return { productId: "newav", configured: this.configured(), baseUrl: this.config.baseUrl ?? "", tokenHint: token ? `••••${token.slice(-4)}` : "未配置" };
  }

  async request(method: "GET" | "POST", path: string, params: Record<string, string> = {}, body?: unknown): Promise<unknown> {
    if (!this.config.baseUrl) throw new NewavError("NEWAV_NOT_CONFIGURED", "NewAV 后台地址尚未配置", 503);
    if (!this.config.token) throw new NewavError("NEWAV_NOT_CONFIGURED", "NewAV Token 尚未配置", 503);
    const url = new URL(`/api/v1${path}`, this.config.baseUrl);
    Object.entries(params).forEach(([key, value]) => value !== "" && url.searchParams.set(key, value));
    const cacheKey = `${method}\u0000${url}\u0000${body === undefined ? "" : JSON.stringify(body)}`;
    const cached = this.cache.get(cacheKey);
    if (cached?.expiresAt && cached.expiresAt > Date.now()) return cached.value;
    if (cached) this.cache.delete(cacheKey);
    const existing = this.pending.get(cacheKey);
    if (existing) return existing;
    const request = this.fetchJson(method, url, body).then((value) => {
      this.pruneCache();
      this.cache.set(cacheKey, { expiresAt: Date.now() + 45_000, value });
      return value;
    }).finally(() => this.pending.delete(cacheKey));
    this.pending.set(cacheKey, request);
    return request;
  }

  private async fetchJson(method: "GET" | "POST", url: URL, body?: unknown) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await this.fetcher(url, {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.config.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" })
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
      if (response.status === 401 || response.status === 403) throw new NewavError("NEWAV_AUTH_FAILED", "NewAV 登录状态无效，请更新 Token", response.status);
      if (response.status === 429) throw new NewavError("NEWAV_RATE_LIMITED", "NewAV 请求过于频繁", 429);
      if (!response.ok) throw new NewavError("NEWAV_UPSTREAM_FAILED", `NewAV 接口返回 ${response.status}`);
      return await response.json();
    } catch (error) {
      if (error instanceof NewavError) throw error;
      if (error instanceof Error && error.name === "AbortError") throw new NewavError("NEWAV_TIMEOUT", "NewAV 接口请求超时", 504);
      throw new NewavError("NEWAV_NETWORK_ERROR", "无法连接 NewAV 后台");
    } finally {
      clearTimeout(timer);
    }
  }

  private pruneCache(now = Date.now()) {
    for (const [key, item] of this.cache) if (item.expiresAt <= now) this.cache.delete(key);
    while (this.cache.size >= NewavClient.MAX_CACHE_ENTRIES) {
      const key = this.cache.keys().next().value;
      if (typeof key !== "string") break;
      this.cache.delete(key);
    }
  }
}
