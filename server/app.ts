import cors from "@fastify/cors";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { analyticsQuerySchema, MAX_METRICS_PER_QUERY } from "../contracts/analytics";
import { cardConfigSchema } from "../contracts/card";
import { validateAnalyticsQuery, validateCardConfig } from "./analytics/capability-validator";
import { metrics, funnelEvents } from "./analytics/registry";
import { QueryOrchestrator, QueryValidationError } from "./analytics/query-orchestrator";
import type { AppEnv } from "./config/env";
import { UpstreamClient, UpstreamError } from "./upstream/client";
import { OverviewAdapter, P_DAY_SUM_API } from "./upstream/overview.adapter";
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
import { MaintenanceAuth } from "./security/maintenance-auth";
import type { IdentityProvider } from "./identity/identity-provider";
import { UnavailableIdentityProvider } from "./identity/identity-provider";
import { PDaySumM016Source } from "./v2/m016-source";
import { V2MetricQueryService } from "./v2/metric-query.service";
import { v2BiPlugin, type V2MetricQueryExecutor } from "./v2/plugin";

export interface BuildAppDependencies {
  identityProvider?: IdentityProvider;
  v2MetricQueryService?: V2MetricQueryExecutor;
}

export async function buildApp(env: AppEnv, dependencies: BuildAppDependencies = {}) {
  const app = Fastify({ logger: env.NODE_ENV !== "test" });
  await app.register(cors, { origin: env.NODE_ENV === "production" ? false : true });
  const upstream = new UpstreamClient(env);
  const sources = new SourceService(upstream);
  const details = new DetailAdapter(upstream);
  const channels = new ChannelAdapter(upstream);
  const workspaceStore = await createWorkspaceStore(env.DATABASE_URL, env.WORKSPACE_FILE);
  const special = new SpecialAdapter(upstream);
  const metadata = new MetadataAdapter(upstream);
  const content = new ContentAdapter(upstream);
  const maintenanceAuth = new MaintenanceAuth(env.TOKEN_MAINTENANCE_KEY);
  const identityProvider = dependencies.identityProvider ?? new UnavailableIdentityProvider();
  const v2MetricQueryService = dependencies.v2MetricQueryService ?? new V2MetricQueryService(new PDaySumM016Source(upstream));
  app.addHook("onClose", async () => workspaceStore.close());
  const overviewAdapter = new OverviewAdapter(upstream);
  const orchestrator = new QueryOrchestrator(overviewAdapter, new EventAdapter(upstream), new SearchAdapter(upstream), new VideoAdapter(upstream), new RealtimeAdapter(upstream), new RetentionAdapter(upstream), new AcquisitionAdapter(special, overviewAdapter), env.MAX_PLATFORM_CONCURRENCY);

  app.get("/api/bi/health", async () => ({ success: true, data: { status: "ok", mode: env.UPSTREAM_API_BASE_URL ? "real" : "unconfigured" } }));
  const requireSecureTransport = (request: FastifyRequest, reply: FastifyReply) => {
    const forwardedProtocol = request.headers["x-forwarded-proto"];
    if (env.NODE_ENV !== "test" && forwardedProtocol && forwardedProtocol !== "https") return reply.code(426).send({ success: false, error: { code: "HTTPS_REQUIRED", message: "Token 维护仅允许通过 HTTPS 使用" } });
    return null;
  };
  const requireMaintenanceSession = (request: FastifyRequest, reply: FastifyReply) => {
    const insecure = requireSecureTransport(request, reply); if (insecure) return insecure;
    if (!maintenanceAuth.enabled()) return reply.code(503).send({ success: false, error: { code: "MAINTENANCE_DISABLED", message: "数据源维护功能尚未启用" } });
    if (!maintenanceAuth.authenticate(request.ip, request.headers.cookie)) return reply.code(401).send({ success: false, error: { code: "MAINTENANCE_LOGIN_REQUIRED", message: "维护登录已失效，请重新登录" } });
    return null;
  };
  const credentialSchema = z.object({ site: z.enum(["primary", "secondary"]), token: z.string().trim().min(16).max(4096).optional() });
  app.post("/api/bi/admin/auth/login", async (request, reply) => {
    const insecure = requireSecureTransport(request, reply); if (insecure) return insecure;
    const parsed = z.object({ password: z.string().min(12).max(256) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ success: false, error: { code: "INVALID_MAINTENANCE_PASSWORD", message: "维护密码格式不合法" } });
    try {
      const session = maintenanceAuth.login(request.ip, parsed.data.password);
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
    const parsed = credentialSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ success: false, error: { code: "INVALID_CREDENTIAL_INPUT", message: "站点或 Token 格式不合法" } });
    try { return { success: true, data: await upstream.verifyCredential(parsed.data.site, parsed.data.token) }; }
    catch (error) { if (error instanceof UpstreamError) return reply.code(error.statusCode).send({ success: false, error: { code: error.code, message: error.message } }); throw error; }
  });
  app.put("/api/bi/admin/data-sources/token", async (request, reply) => {
    const denied = requireMaintenanceSession(request, reply); if (denied) return denied;
    const parsed = credentialSchema.extend({ token: z.string().trim().min(16).max(4096) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ success: false, error: { code: "INVALID_CREDENTIAL_INPUT", message: "站点或 Token 格式不合法" } });
    try { return { success: true, data: await upstream.updateCredential(parsed.data.site, parsed.data.token) }; }
    catch (error) { if (error instanceof UpstreamError) return reply.code(error.statusCode).send({ success: false, error: { code: error.code, message: error.message } }); throw error; }
  });
  app.get("/api/bi/ready", async (_request, reply) => {
    const dependencies = { workspace: false, upstream: false };
    try {
      await workspaceStore.get();
      dependencies.workspace = true;
    } catch {
      dependencies.workspace = false;
    }
    try {
      const end = new Date();
      const start = new Date(end);
      start.setDate(end.getDate() - 1);
      await upstream.get(P_DAY_SUM_API, {
        page: "1",
        count: "1",
        pid: "PH",
        sumDateStart: `${start.toISOString().slice(0, 10)} 00:00:00`,
        sumDateEnd: `${end.toISOString().slice(0, 10)} 23:59:59`
      });
      dependencies.upstream = true;
    } catch {
      dependencies.upstream = false;
    }
    const ready = dependencies.workspace && dependencies.upstream;
    return reply.code(ready ? 200 : 503).send({ success: ready, data: { status: ready ? "ready" : "degraded", dependencies } });
  });
  app.get("/api/bi/capabilities", async () => ({
    success: true,
    data: { metrics: Object.values(metrics), funnelEvents, maxPlatforms: 8, maxMetrics: MAX_METRICS_PER_QUERY }
  }));
  app.get("/api/bi/sources", async () => ({ success: true, data: apiCatalog }));
  app.get("/api/bi/platforms", async () => ({ success: true, data: platformRegistry.filter((platform) => platform.enabled) }));
  const workspaceSchema = z.object({ schemaVersion: z.literal(1), templates: z.array(z.json()).max(500), cardAssets: z.array(z.json()).max(2000) });
  app.get("/api/bi/workspace", async () => ({ success: true, data: await workspaceStore.get() }));
  app.put("/api/bi/workspace", async (request, reply) => {
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

  await app.register(v2BiPlugin, {
    prefix: "/api/bi/v2",
    identityProvider,
    metricQueryService: v2MetricQueryService
  });

  return app;
}
