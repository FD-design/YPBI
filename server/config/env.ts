import { z } from "zod";
import { enabledSecondaryPlatformPids } from "../platforms/registry";

const emptyStringAsUndefined = (value: unknown) => (
  typeof value === "string" && value.trim() === "" ? undefined : value
);
const explicitBoolean = z.preprocess(
  emptyStringAsUndefined,
  z.enum(["true", "false"]).default("false").transform((value) => value === "true")
);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default("127.0.0.1"),
  UPSTREAM_API_BASE_URL: z.preprocess(emptyStringAsUndefined, z.url().optional()),
  UPSTREAM_X_TOKEN: z.preprocess(emptyStringAsUndefined, z.string().min(1).optional()),
  UPSTREAM_USER_NAME: z.preprocess(emptyStringAsUndefined, z.string().min(1).optional()),
  UPSTREAM_SECONDARY_API_BASE_URL: z.preprocess(emptyStringAsUndefined, z.url().optional()),
  UPSTREAM_SECONDARY_X_TOKEN: z.preprocess(emptyStringAsUndefined, z.string().min(1).optional()),
  UPSTREAM_SECONDARY_USER_NAME: z.preprocess(emptyStringAsUndefined, z.string().min(1).optional()),
  UPSTREAM_CREDENTIALS_FILE: z.string().default("./data/upstream-credentials.json"),
  WORKSPACE_FILE: z.string().default("./data/workspace.json"),
  TOKEN_MAINTENANCE_KEY: z.preprocess(emptyStringAsUndefined, z.string().min(12).optional()),
  BI_IDENTITY_MODE: z.preprocess(emptyStringAsUndefined, z.enum(["unavailable", "local"]).optional()),
  BI_AUTH_DATABASE_URL: z.preprocess(emptyStringAsUndefined, z.string().min(1).optional()),
  BI_AUTH_CSRF_SECRET: z.preprocess(emptyStringAsUndefined, z.string().min(32).optional()),
  BI_PUBLIC_ORIGIN: z.preprocess(emptyStringAsUndefined, z.url().optional()),
  BI_V2_CORE_OVERVIEW_QUERY_ENABLED: explicitBoolean,
  BI_DAILY_DASHBOARD_QUERY_ENABLED: explicitBoolean,
  BI_LOCAL_DASHBOARD_READING_ENABLED: explicitBoolean,
  DATABASE_URL: z.preprocess(emptyStringAsUndefined, z.string().min(1).optional()),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(10000),
  MAX_PLATFORM_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(4)
});

export type AppEnv = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`环境变量配置错误：${z.prettifyError(parsed.error)}`);
  }
  if (parsed.data.BI_LOCAL_DASHBOARD_READING_ENABLED && (parsed.data.NODE_ENV === "production" || parsed.data.HOST !== "127.0.0.1")) {
    throw new Error("本地真实看板读取仅允许非生产环境监听127.0.0.1时启用");
  }
  if (parsed.data.NODE_ENV === "production") {
    if (!parsed.data.UPSTREAM_API_BASE_URL) throw new Error("生产环境缺少 UPSTREAM_API_BASE_URL");
    if (!parsed.data.UPSTREAM_USER_NAME) throw new Error("生产环境缺少 UPSTREAM_USER_NAME");
    if (!parsed.data.TOKEN_MAINTENANCE_KEY) throw new Error("生产环境缺少 TOKEN_MAINTENANCE_KEY");
    for (const [label, value] of [
      ["主上游", parsed.data.UPSTREAM_API_BASE_URL],
      ["备用上游", parsed.data.UPSTREAM_SECONDARY_API_BASE_URL]
    ] as const) {
      if (!value) continue;
      const upstreamUrl = new URL(value);
      if (upstreamUrl.protocol !== "https:" || upstreamUrl.username || upstreamUrl.password) {
        throw new Error(`生产环境${label}地址必须使用无凭据的 HTTPS URL`);
      }
    }
    if (parsed.data.HOST !== "127.0.0.1" || parsed.data.PORT !== 3000) {
      throw new Error("生产环境 API 必须监听 127.0.0.1:3000，与反向代理契约一致");
    }
    if (parsed.data.BI_IDENTITY_MODE !== "local") {
      throw new Error("生产环境必须显式启用 BI_IDENTITY_MODE=local，禁止匿名或未配置身份运行");
    }
    if (!parsed.data.BI_AUTH_DATABASE_URL) {
      throw new Error("生产环境缺少 BI_AUTH_DATABASE_URL，无法启动普通用户身份服务");
    }
    if (!parsed.data.BI_AUTH_CSRF_SECRET) {
      throw new Error("生产环境缺少至少 32 字节的 BI_AUTH_CSRF_SECRET");
    }
    if (!parsed.data.BI_PUBLIC_ORIGIN) {
      throw new Error("生产环境缺少 BI_PUBLIC_ORIGIN，无法执行严格同源校验");
    }
    const publicUrl = new URL(parsed.data.BI_PUBLIC_ORIGIN);
    if (
      publicUrl.protocol !== "https:"
      || publicUrl.username
      || publicUrl.password
      || publicUrl.pathname !== "/"
      || publicUrl.search
      || publicUrl.hash
    ) {
      throw new Error("生产环境 BI_PUBLIC_ORIGIN 必须是无路径、无凭据的 HTTPS Origin");
    }
  }
  const secondaryEndpointConfigured = Boolean(parsed.data.UPSTREAM_SECONDARY_API_BASE_URL);
  const secondaryUserConfigured = Boolean(parsed.data.UPSTREAM_SECONDARY_USER_NAME);
  if (secondaryEndpointConfigured !== secondaryUserConfigured) {
    throw new Error("备用后台地址和用户名必须同时配置或同时省略");
  }
  if (parsed.data.UPSTREAM_SECONDARY_X_TOKEN && !secondaryEndpointConfigured) {
    throw new Error("备用后台 Token 不能脱离对应地址和用户名单独配置");
  }
  if (
    parsed.data.NODE_ENV === "production"
    && enabledSecondaryPlatformPids().length > 0
    && !secondaryEndpointConfigured
  ) {
    throw new Error("生产环境当前平台目录包含站2 PID，必须配置站2后台地址和用户名");
  }
  return parsed.data;
}
