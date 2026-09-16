import cors from "@fastify/cors";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { isIP } from "node:net";
import type { BiAuthApiErrorCode } from "../contracts/bi-auth";
import { analyticsQuerySchema, MAX_METRICS_PER_QUERY } from "../contracts/analytics";
import { cardConfigSchema } from "../contracts/card";
import { validateAnalyticsQuery, validateCardConfig } from "./analytics/capability-validator";
import { metrics, funnelEvents } from "./analytics/registry";
import { QueryOrchestrator, QueryValidationError } from "./analytics/query-orchestrator";
import type { AppEnv } from "./config/env";
import { UpstreamClient, UpstreamError } from "./upstream/client";
import { OverviewAdapter } from "./upstream/overview.adapter";
import { EventAdapter } from "./upstream/event.adapter";
import { SearchAdapter } from "./upstream/search.adapter";
import { VideoAdapter } from "./upstream/video.adapter";
import { RealtimeAdapter } from "./upstream/realtime.adapter";
import { RetentionAdapter } from "./upstream/retention.adapter";
import { AcquisitionAdapter } from "./upstream/acquisition.adapter";
import { DetailAdapter, CIRCLE_LIST_API, USER_DAILY_API } from "./upstream/detail.adapter";
import { ChannelAdapter, CHANNEL_AB_API, CHANNEL_DETAIL_API } from "./upstream/channel.adapter";
import { z } from "zod";
import { apiCatalog } from "./upstream/catalog";
import { SourceQueryError, SourceService } from "./upstream/source.service";
import { platformRegistry } from "./platforms/registry";
import { createWorkspaceStore } from "./persistence/workspace.store";
import { SpecialAdapter } from "./upstream/special.adapter";
import { MetadataAdapter } from "./upstream/metadata.adapter";
import { ContentAdapter } from "./upstream/content.adapter";
import { MaintenanceAuth, type MaintenanceSecurityContext } from "./security/maintenance-auth";
import type { IdentityProvider, Principal } from "./identity/identity-provider";
import { UnavailableIdentityProvider } from "./identity/identity-provider";
import { resolveIdentity } from "./identity/resolve-identity";
import { bindClientRequestAbort } from "./http/client-request-abort";
import { PDaySumM016Source } from "./v2/m016-source";
import { V2MetricQueryService } from "./v2/metric-query.service";
import { DailyDashboardService, type DailyDashboardExecutor } from "./v2/daily-dashboard.service";
import { CoreOverviewQueryService } from "./v2/core-overview/core-overview-query.service";
import { getV2MetricDefinition } from "./v2/metric-definitions";
import {
  v2BiPlugin,
  type V2CoreOverviewQueryExecutor,
  type V2MetricQueryExecutor
} from "./v2/plugin";
import { biAuthPlugin, createPostgresAuthModule } from "./auth";
import { teamAccountPlugin } from './auth/team-plugin';
import type { BiAccountAdminService } from './auth/service';
import {
  LOCAL_BI_SESSION_COOKIE,
  PRODUCTION_BI_SESSION_COOKIE,
  readUniqueOpaqueCookie,
  type BiSessionCookieConfiguration
} from "./auth/cookies";
import { SessionIdentityProvider } from "./auth/session-identity-provider";
import type { BiAuthService } from "./auth/service";

export interface BuildAppDependencies {
  identityProvider?: IdentityProvider;
  authService?: BiAuthService;
  authHealthCheck?: () => Promise<void>;
  v2MetricQueryService?: V2MetricQueryExecutor;
  v2CoreOverviewQueryService?: V2CoreOverviewQueryExecutor;
  dailyDashboardService?: DailyDashboardExecutor;
}

function rawPath(request: FastifyRequest) {
  return request.url.split("?", 1)[0];
}

function isRouteInNamespace(request: FastifyRequest, namespace: string) {
  const matchedRoute = request.routeOptions.url ?? "";
  const requestPath = rawPath(request);
  return matchedRoute === namespace
    || matchedRoute.startsWith(`${namespace}/`)
    || requestPath === namespace
    || requestPath.startsWith(`${namespace}/`);
}

function requestOriginMatches(originHeader: string | string[] | undefined, expectedOrigin: string) {
  if (typeof originHeader !== "string") return false;
  try {
    return new URL(originHeader).origin === expectedOrigin && originHeader === new URL(originHeader).origin;
  } catch {
    return false;
  }
}

function maintenanceSecurityContext(principal: Principal): MaintenanceSecurityContext | null {
  if (!principal.securityVersion) return null;
  return {
    subjectId: principal.subjectId,
    roles: principal.roles,
    permissions: principal.permissions,
    securityVersion: principal.securityVersion
  };
}

export async function buildApp(env: AppEnv, dependencies: BuildAppDependencies = {}) {
  const app = Fastify({
    logger: env.NODE_ENV === "test" ? false : {
      serializers: {
        req(request: { method?: string; url?: string; remoteAddress?: string }) {
          return {
            method: request.method,
            path: request.url?.split("?", 1)[0],
            remoteAddress: request.remoteAddress
          };
        }
      }
    },
    // The production API only accepts traffic from local Caddy/Nginx. Trusting
    // loopback (rather than every proxy or a hop count) makes request.ip and
    // request.protocol safe to use for maintenance-session security.
    trustProxy: ["127.0.0.1", "::1"]
  });
  await app.register(cors, { origin: env.NODE_ENV === "production" ? false : true });
  const expectedPublicOrigin = env.BI_PUBLIC_ORIGIN
    ? new URL(env.BI_PUBLIC_ORIGIN).origin
    : undefined;
  app.addHook("onRequest", async (request, reply) => {
    // Fastify may match percent-encoded static path segments. Use the canonical
    // matched route for security decisions, while retaining the raw-prefix check
    // so unknown admin paths also receive the no-store/error boundary.
    const isMaintenanceRequest = isRouteInNamespace(request, "/api/bi/admin");
    const isV2Request = isRouteInNamespace(request, "/api/bi/v2");
    if (!isMaintenanceRequest && !isV2Request) return;

    reply.header("cache-control", "no-store");
    if (env.NODE_ENV !== "production") return;

    const forwardedProtocol = request.headers["x-forwarded-proto"];
    const isTrustedHttps = typeof forwardedProtocol === "string"
      && forwardedProtocol.trim().toLowerCase() === "https"
      && request.protocol.toLowerCase() === "https";

    if (!isTrustedHttps) {
      return reply.code(426).send({
        success: false,
        error: {
          code: "HTTPS_REQUIRED",
          message: isMaintenanceRequest ? "数据源维护仅允许通过 HTTPS 使用" : "新版 BI 仅允许通过 HTTPS 使用",
          ...(isV2Request ? { requestId: request.id } : {})
        }
      });
    }

    const forwardedFor = request.headers["x-forwarded-for"];
    const clientIp = typeof forwardedFor === "string" && !forwardedFor.includes(",")
      ? forwardedFor.trim()
      : "";
    const hasTrustedClientIp = isIP(clientIp) !== 0 && request.ip === clientIp;

    if (!hasTrustedClientIp) {
      return reply.code(503).send({
        success: false,
        error: {
          code: isMaintenanceRequest ? "MAINTENANCE_PROXY_MISCONFIGURED" : "AUTH_PROXY_MISCONFIGURED",
          message: isMaintenanceRequest ? "数据源维护代理配置不完整" : "BI 访问代理配置不完整",
          ...(isV2Request ? { requestId: request.id } : {})
        }
      });
    }

    if (
      isMaintenanceRequest
      && ["POST", "PUT", "PATCH", "DELETE"].includes(request.method)
      && (!expectedPublicOrigin || !requestOriginMatches(request.headers.origin, expectedPublicOrigin))
    ) {
      return reply.code(expectedPublicOrigin ? 403 : 503).send({
        success: false,
        error: {
          code: expectedPublicOrigin ? "MAINTENANCE_ORIGIN_REJECTED" : "MAINTENANCE_PROXY_MISCONFIGURED",
          message: expectedPublicOrigin ? "请求来源校验失败，请从 BI 页面重试" : "数据源维护代理配置不完整"
        }
      });
    }
  });
  const upstream = new UpstreamClient(env);
  const dailyDashboardReadingEnabled = env.BI_DAILY_DASHBOARD_QUERY_ENABLED
    || env.BI_LOCAL_DASHBOARD_READING_ENABLED;
  const sources = new SourceService(upstream);
  const details = new DetailAdapter(upstream);
  const channels = new ChannelAdapter(upstream);
  const workspaceStore = await createWorkspaceStore(env.DATABASE_URL, env.WORKSPACE_FILE);
  const special = new SpecialAdapter(upstream);
  const metadata = new MetadataAdapter(upstream);
  const content = new ContentAdapter(upstream);
  const maintenanceAuth = new MaintenanceAuth(env.TOKEN_MAINTENANCE_KEY);
  const sessionCookie: BiSessionCookieConfiguration = env.NODE_ENV === "production"
    ? PRODUCTION_BI_SESSION_COOKIE
    : LOCAL_BI_SESSION_COOKIE;
  let authService = dependencies.authService;
  let accountAdminService: BiAccountAdminService | undefined;
  let identityProvider = dependencies.identityProvider;
  let authHealthCheck = dependencies.authHealthCheck;
  let closeAuthModule: (() => Promise<void>) | undefined;
  if (!authService && !identityProvider && env.BI_IDENTITY_MODE === "local") {
    if (!env.BI_AUTH_DATABASE_URL || !env.BI_AUTH_CSRF_SECRET) {
      throw new Error("BI_IDENTITY_MODE=local 时必须配置 BI_AUTH_DATABASE_URL 与 BI_AUTH_CSRF_SECRET");
    }
    const authModule = await createPostgresAuthModule(env.BI_AUTH_DATABASE_URL, {
      csrfSecret: env.BI_AUTH_CSRF_SECRET,
      sessionCookie
    });
    authService = authModule.authService;
    accountAdminService = authModule.accountAdminService;
    identityProvider = authModule.identityProvider;
    authHealthCheck = authModule.health;
    closeAuthModule = authModule.close;
  }
  if (authService && !identityProvider) identityProvider = new SessionIdentityProvider(authService, sessionCookie);
  identityProvider ??= new UnavailableIdentityProvider();
  const v2MetricQueryService = dependencies.v2MetricQueryService ?? new V2MetricQueryService(new PDaySumM016Source(upstream));
  app.addHook("onClose", async () => {
    await workspaceStore.close();
    await closeAuthModule?.();
  });
  const overviewAdapter = new OverviewAdapter(upstream);
  const orchestrator = new QueryOrchestrator(overviewAdapter, new EventAdapter(upstream), new SearchAdapter(upstream), new VideoAdapter(upstream), new RealtimeAdapter(upstream), new RetentionAdapter(upstream), new AcquisitionAdapter(special, overviewAdapter), env.MAX_PLATFORM_CONCURRENCY);

  const adminPrincipals = new WeakMap<FastifyRequest, Principal>();
  app.addHook("preHandler", async (request, reply) => {
    if (!isRouteInNamespace(request, "/api/bi/admin")) return;
    let resolution;
    const clientAbortController = new AbortController();
    const unbindClientAbort = bindClientRequestAbort(
      request.raw,
      reply.raw,
      clientAbortController,
      "admin_identity_request_aborted"
    );
    try {
      resolution = await resolveIdentity(identityProvider, {
        headers: request.headers,
        ip: request.ip,
        signal: clientAbortController.signal
      });
    } catch {
      request.log.error({ requestId: request.id, outcome: "admin_identity_failed" }, "admin identity resolution failed");
      return reply.code(503).send({
        success: false,
        error: { code: "IDENTITY_PROVIDER_UNAVAILABLE", message: "登录服务当前不可用", requestId: request.id }
      });
    } finally {
      unbindClientAbort();
    }
    if (resolution.status === "unavailable") {
      return reply.code(503).send({
        success: false,
        error: { code: "IDENTITY_PROVIDER_UNAVAILABLE", message: "登录服务当前不可用", requestId: request.id }
      });
    }
    if (resolution.status === "unauthenticated") {
      return reply.code(401).send({
        success: false,
        error: { code: "AUTHENTICATION_REQUIRED", message: "请先登录后再进入管理中心", requestId: request.id }
      });
    }
    if (
      !resolution.principal.permissions.includes("bi:data-source-maintenance:enter")
    ) {
      return reply.code(403).send({
        success: false,
        error: { code: "ADMIN_ACCESS_DENIED", message: "当前账号没有数据源维护权限", requestId: request.id }
      });
    }
    if (env.NODE_ENV === "production" && ["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
      const rawCookie = request.headers.cookie;
      const cookieHeader = Array.isArray(rawCookie) ? rawCookie.join(";") : rawCookie;
      const sessionToken = readUniqueOpaqueCookie(cookieHeader, sessionCookie.name);
      const csrfHeader = Array.isArray(request.headers["x-csrf-token"])
        ? undefined
        : request.headers["x-csrf-token"];
      if (!authService || !sessionToken || !authService.csrfMatches(sessionToken, csrfHeader)) {
        return reply.code(403).send({
          success: false,
          error: {
            code: "CSRF_VALIDATION_FAILED",
            message: "安全校验失败，请刷新页面后重试",
            requestId: request.id
          }
        });
      }
    }
    adminPrincipals.set(request, resolution.principal);
  });

  app.get("/api/bi/health", async () => ({ success: true, data: { status: "ok", mode: env.UPSTREAM_API_BASE_URL ? "real" : "unconfigured" } }));
  const requireMaintenanceSession = (request: FastifyRequest, reply: FastifyReply) => {
    const principal = adminPrincipals.get(request);
    if (!principal) return reply.code(503).send({ success: false, error: { code: "IDENTITY_PROVIDER_UNAVAILABLE", message: "登录服务当前不可用", requestId: request.id } });
    const securityContext = maintenanceSecurityContext(principal);
    if (!securityContext) return reply.code(503).send({ success: false, error: { code: "IDENTITY_PROVIDER_UNAVAILABLE", message: "账号安全状态当前不可用", requestId: request.id } });
    if (!maintenanceAuth.enabled()) return reply.code(503).send({ success: false, error: { code: "MAINTENANCE_DISABLED", message: "数据源维护功能尚未启用" } });
    if (!maintenanceAuth.authenticate(request.ip, securityContext, request.headers.cookie)) return reply.code(401).send({ success: false, error: { code: "MAINTENANCE_LOGIN_REQUIRED", message: "维护登录已失效，请重新登录" } });
    return null;
  };
  const credentialSchema = z.object({ site: z.enum(["primary", "secondary"]), token: z.string().trim().min(16).max(4096).optional() });
  app.post("/api/bi/admin/auth/login", async (request, reply) => {
    const principal = adminPrincipals.get(request)!;
    const securityContext = maintenanceSecurityContext(principal);
    if (!securityContext) return reply.code(503).send({ success: false, error: { code: "IDENTITY_PROVIDER_UNAVAILABLE", message: "账号安全状态当前不可用", requestId: request.id } });
    const parsed = z.object({ password: z.string().min(12).max(256) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ success: false, error: { code: "INVALID_MAINTENANCE_PASSWORD", message: "维护密码格式不合法" } });
    try {
      const session = maintenanceAuth.login(request.ip, securityContext, parsed.data.password);
      reply.header("set-cookie", maintenanceAuth.sessionCookie(session.token));
      reply.header("cache-control", "no-store");
      return { success: true, data: { expiresAt: new Date(session.expiresAt).toISOString() } };
    } catch (error) {
      const message = error instanceof Error ? error.message : "维护密码验证失败";
      const status = message.includes("尚未启用") ? 503 : message.includes("过多") ? 429 : 401;
      return reply.code(status).send({ success: false, error: { code: status === 429 ? "MAINTENANCE_LOCKED" : "INVALID_MAINTENANCE_PASSWORD", message } });
    }
  });
  app.post("/api/bi/admin/auth/logout", async (request, reply) => {
    maintenanceAuth.logout(request.headers.cookie);
    reply.header("set-cookie", maintenanceAuth.clearCookie());
    reply.header("cache-control", "no-store");
    return { success: true, data: { loggedOut: true } };
  });
  app.get("/api/bi/admin/data-sources/status", async (request, reply) => {
    const denied = requireMaintenanceSession(request, reply); if (denied) return denied;
    reply.header("cache-control", "no-store");
    return { success: true, data: upstream.credentialStatus() };
  });
  app.post("/api/bi/admin/data-sources/test", async (request, reply) => {
    const denied = requireMaintenanceSession(request, reply); if (denied) return denied;
    reply.header("cache-control", "no-store");
    const parsed = credentialSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ success: false, error: { code: "INVALID_CREDENTIAL_INPUT", message: "站点或 Token 格式不合法" } });
    try { return { success: true, data: await upstream.verifyCredential(parsed.data.site, parsed.data.token) }; }
    catch (error) { if (error instanceof UpstreamError) return reply.code(error.statusCode).send({ success: false, error: { code: error.code, message: error.message } }); throw error; }
  });
  app.put("/api/bi/admin/data-sources/token", async (request, reply) => {
    const denied = requireMaintenanceSession(request, reply); if (denied) return denied;
    reply.header("cache-control", "no-store");
    const parsed = credentialSchema.extend({ token: z.string().trim().min(16).max(4096) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ success: false, error: { code: "INVALID_CREDENTIAL_INPUT", message: "站点或 Token 格式不合法" } });
    try { return { success: true, data: await upstream.updateCredential(parsed.data.site, parsed.data.token) }; }
    catch (error) { if (error instanceof UpstreamError) return reply.code(error.statusCode).send({ success: false, error: { code: error.code, message: error.message } }); throw error; }
  });
  app.get("/api/bi/ready", async (_request, reply) => {
    const readiness = {
      workspace: false,
      upstream: false,
      upstreamSites: { primary: false, secondary: false },
      identity: false
    };
    try {
      await workspaceStore.get();
      readiness.workspace = true;
    } catch {
      readiness.workspace = false;
    }
    const [primaryUpstream, secondaryUpstream] = await Promise.allSettled([
      upstream.verifyCredential("primary"),
      upstream.verifyCredential("secondary")
    ]);
    readiness.upstreamSites.primary = primaryUpstream.status === "fulfilled";
    readiness.upstreamSites.secondary = secondaryUpstream.status === "fulfilled";
    readiness.upstream = readiness.upstreamSites.primary && readiness.upstreamSites.secondary;
    try {
      if (authHealthCheck) await authHealthCheck();
      readiness.identity = Boolean(authService || dependencies.identityProvider);
    } catch {
      readiness.identity = false;
    }
    const ready = readiness.workspace && readiness.upstream && readiness.identity;
    return reply.code(ready ? 200 : 503).send({ success: ready, data: { status: ready ? "ready" : "degraded", dependencies: readiness } });
  });
  app.get("/api/bi/capabilities", async () => ({
    success: true,
    data: { metrics: Object.values(metrics), funnelEvents, maxPlatforms: 8, maxMetrics: MAX_METRICS_PER_QUERY }
  }));
  app.get("/api/bi/sources", async () => ({ success: true, data: apiCatalog }));
  app.get("/api/bi/platforms", async () => ({
    success: true,
    data: platformRegistry
      .filter((platform) => platform.enabled)
      .map(({ hxId, name, pid, upstreamSite, enabled, order }) => ({ hxId, name, pid, upstreamSite, enabled, order }))
  }));
  const workspaceSchema = z.object({ schemaVersion: z.literal(1), templates: z.array(z.json()).max(500), cardAssets: z.array(z.json()).max(2000) });
  app.get("/api/bi/workspace", async () => ({ success: true, data: await workspaceStore.get() }));
  app.put("/api/bi/workspace", async (request, reply) => {
    if (env.NODE_ENV === "production") {
      return reply.code(410).send({
        success: false,
        error: { code: "LEGACY_WORKSPACE_WRITE_DISABLED", message: "遗留工作区写入已冻结" }
      });
    }
    const parsed = workspaceSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ success: false, error: { code: "INVALID_WORKSPACE", message: "看板工作区配置不合法", details: parsed.error.issues } });
    return { success: true, data: await workspaceStore.put(parsed.data) };
  });
  const detailQuerySchema = z.object({ platformId: z.string().min(1), dateRange: z.tuple([z.iso.date(), z.iso.date()]), page: z.number().int().min(1).default(1), pageSize: z.number().int().min(1).max(100).default(20) });
  app.post("/api/bi/drilldown/users", async (request, reply) => {
    const parsed = detailQuerySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ success: false, error: { code: "INVALID_DETAIL_QUERY", message: "用户明细查询参数不合法", details: parsed.error.issues } });
    return { success: true, data: { rows: await details.users(parsed.data), sourceApiId: USER_DAILY_API, warnings: ["watchedTime 原始单位待后台确认，暂不换算"] } };
  });
  app.post("/api/bi/drilldown/circles", async (request, reply) => {
    const parsed = detailQuerySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ success: false, error: { code: "INVALID_DETAIL_QUERY", message: "圈子明细查询参数不合法", details: parsed.error.issues } });
    return { success: true, data: { rows: await details.circles(parsed.data), sourceApiId: CIRCLE_LIST_API, warnings: ["圈子接口不接受 pid，结果按返回行 pid 二次过滤"] } };
  });
  app.post("/api/bi/channels/detail", async (request, reply) => {
    const parsed = detailQuerySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ success: false, error: { code: "INVALID_CHANNEL_QUERY", message: "渠道明细查询参数不合法", details: parsed.error.issues } });
    return { success: true, data: { ...await channels.details(parsed.data), sourceApiId: CHANNEL_DETAIL_API, warnings: [] } };
  });
  app.post("/api/bi/channels/ab-landing", async (request, reply) => {
    const parsed = detailQuerySchema.extend({ templateA: z.string().optional(), templateB: z.string().optional() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ success: false, error: { code: "INVALID_CHANNEL_AB_QUERY", message: "落地页对比查询参数不合法", details: parsed.error.issues } });
    return { success: true, data: { ...await channels.abLanding(parsed.data), sourceApiId: CHANNEL_AB_API, warnings: ["接口无数据时保持真实空态，不生成演示结果"] } };
  });
  const specialHandlers = { navigation: special.navigation.bind(special), snapshots: special.snapshots.bind(special), cnzz: special.cnzz.bind(special), news: special.news.bind(special), surveys: special.surveys.bind(special) };
  app.post<{ Params: { domain: string } }>("/api/bi/special/:domain", async (request, reply) => {
    const handler = specialHandlers[request.params.domain as keyof typeof specialHandlers];
    if (!handler) return reply.code(404).send({ success: false, error: { code: "UNKNOWN_SPECIAL_DOMAIN", message: "专项分析领域不存在" } });
    const parsed = detailQuerySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ success: false, error: { code: "INVALID_SPECIAL_QUERY", message: "专项分析查询参数不合法", details: parsed.error.issues } });
    const result = await handler(parsed.data);
    return { success: true, data: { ...result, warnings: result.rows.length ? [] : ["当前 API 在所选平台和时间范围内返回空数据，未生成 Mock 数据"] } };
  });
  const metadataQuerySchema = z.object({ platformId: z.string().min(1).default("PH") });
  app.post<{ Params: { domain: string } }>("/api/bi/metadata/:domain", async (request, reply) => {
    const parsed = metadataQuerySchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ success: false, error: { code: "INVALID_METADATA_QUERY", message: "元数据查询参数不合法" } });
    const handlers = { categories: () => metadata.categories(), tags: () => metadata.tags(parsed.data.platformId), partners: () => metadata.partners(parsed.data.platformId), "landing-templates": () => metadata.landingTemplates(parsed.data.platformId), withdrawals: () => metadata.withdrawals() };
    const handler = handlers[request.params.domain as keyof typeof handlers];
    if (!handler) return reply.code(404).send({ success: false, error: { code: "UNKNOWN_METADATA_DOMAIN", message: "元数据领域不存在" } });
    return { success: true, data: await handler() };
  });
  app.post<{ Params: { domain: string } }>("/api/bi/content/:domain", async (request, reply) => {
    const parsed = detailQuerySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ success: false, error: { code: "INVALID_CONTENT_QUERY", message: "内容分析查询参数不合法" } });
    const handlers = { categories: () => content.categories(parsed.data), "video-totals": () => content.videoTotals(parsed.data), "video-ranking": () => content.videoRanking(parsed.data), "circle-totals": () => content.circleTotals(parsed.data) };
    const handler = handlers[request.params.domain as keyof typeof handlers];
    if (!handler) return reply.code(404).send({ success: false, error: { code: "UNKNOWN_CONTENT_DOMAIN", message: "内容分析领域不存在" } });
    return { success: true, data: await handler() };
  });
  app.post<{ Params: { id: string } }>("/api/bi/sources/:id/query", async (request, reply) => {
    try {
      return { success: true, data: await sources.query(request.params.id, (request.body ?? {}) as Record<string, unknown>) };
    } catch (error) {
      if (error instanceof SourceQueryError) return reply.code(error.code === "UNKNOWN_SOURCE" ? 404 : 400).send({ success: false, error: { code: error.code, message: error.message, details: error.details } });
      if (error instanceof UpstreamError) return reply.code(error.statusCode).send({ success: false, error: { code: error.code, message: error.message } });
      throw error;
    }
  });

  app.post("/api/bi/analytics/validate", async (request, reply) => {
    const parsed = analyticsQuerySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ success: false, error: { code: "INVALID_QUERY", message: "查询配置不合法", details: parsed.error.issues } });
    const result = validateAnalyticsQuery(parsed.data);
    return reply.code(result.valid ? 200 : 422).send({ success: result.valid, data: result.valid ? result : undefined, error: result.valid ? undefined : { code: "UNSUPPORTED_COMBINATION", message: "当前字段组合不受已有 API 支持", details: result.issues } });
  });

  app.post("/api/bi/analytics/query", async (request, reply) => {
    const parsed = analyticsQuerySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ success: false, error: { code: "INVALID_QUERY", message: "查询配置不合法", details: parsed.error.issues } });
    try {
      return { success: true, data: await orchestrator.execute(parsed.data) };
    } catch (error) {
      if (error instanceof QueryValidationError) return reply.code(422).send({ success: false, error: { code: "UNSUPPORTED_COMBINATION", message: error.message, details: error.issues } });
      if (error instanceof UpstreamError) return reply.code(error.statusCode).send({ success: false, error: { code: error.code, message: error.message } });
      throw error;
    }
  });

  app.post("/api/bi/cards/validate", async (request, reply) => {
    const parsed = cardConfigSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ success: false, error: { code: "INVALID_CARD", message: "卡片配置不合法", details: parsed.error.issues } });
    const result = validateCardConfig(parsed.data);
    return reply.code(result.valid ? 200 : 422).send({ success: result.valid, data: result.valid ? result : undefined, error: result.valid ? undefined : { code: "UNSUPPORTED_COMBINATION", message: "卡片超出 API 能力范围", details: result.issues } });
  });

  // Preserve the legacy /api/bi/* error contract exactly. The V2 plugin owns
  // a more specific encapsulated handler for its routes. This must be set
  // before awaiting plugin registration, because awaiting boots Fastify and
  // freezes the already-declared legacy route contexts.
  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    reply.code(500).send({ success: false, error: { code: "INTERNAL_ERROR", message: "BI 服务处理失败" } });
  });

  if (authService) {
    if (accountAdminService) await app.register(teamAccountPlugin, {
      prefix: '/api/bi/v2/team/accounts', authService, accounts: accountAdminService,
      sessionCookie, expectedOrigin: expectedPublicOrigin
    });
    await app.register(biAuthPlugin, {
      prefix: "/api/bi/v2/auth",
      authService,
      sessionCookie,
      expectedOrigin: expectedPublicOrigin,
      onSecurityContextChanged: async (subjectId) => {
        maintenanceAuth.revokeSubject(subjectId);
      }
    });
  } else {
    await app.register(async (authApp) => {
      authApp.addHook("onRequest", async (_request, reply) => {
        reply.header("cache-control", "no-store");
      });
      const unavailable = (request: FastifyRequest, reply: FastifyReply) => reply.code(503).send({
        success: false,
        error: {
          code: "AUTH_SERVICE_UNAVAILABLE" satisfies BiAuthApiErrorCode,
          message: "登录服务尚未配置",
          requestId: request.id
        }
      });
      authApp.get("/session", unavailable);
      authApp.post("/login", unavailable);
      authApp.post("/logout", unavailable);
      authApp.put("/password", unavailable);
    }, { prefix: "/api/bi/v2/auth" });
  }

  await app.register(v2BiPlugin, {
    prefix: "/api/bi/v2",
    identityProvider,
    metricQueryService: v2MetricQueryService,
    dailyDashboardService: dailyDashboardReadingEnabled
      ? dependencies.dailyDashboardService ?? new DailyDashboardService(upstream)
      : undefined,
    coreOverviewQueryEnabled: env.BI_V2_CORE_OVERVIEW_QUERY_ENABLED,
    coreOverviewQueryService: dependencies.v2CoreOverviewQueryService ?? new CoreOverviewQueryService(getV2MetricDefinition)
  });

  return app;
}
