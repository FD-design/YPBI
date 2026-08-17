import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default("127.0.0.1"),
  UPSTREAM_API_BASE_URL: z.url().optional(),
  UPSTREAM_X_TOKEN: z.string().min(1).optional(),
  UPSTREAM_USER_NAME: z.string().min(1).optional(),
  UPSTREAM_SECONDARY_API_BASE_URL: z.url().optional(),
  UPSTREAM_SECONDARY_X_TOKEN: z.string().min(1).optional(),
  UPSTREAM_SECONDARY_USER_NAME: z.string().min(1).optional(),
  UPSTREAM_SECONDARY_PIDS: z.string().default(""),
    UPSTREAM_CREDENTIALS_FILE: z.string().default("./data/upstream-credentials.json"),
    WORKSPACE_FILE: z.string().default("./data/workspace.json"),
  TOKEN_MAINTENANCE_KEY: z.string().min(12).optional(),
  DATABASE_URL: z.string().min(1).optional(),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(10000),
  MAX_PLATFORM_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(4)
});

export type AppEnv = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`环境变量配置错误：${z.prettifyError(parsed.error)}`);
  }
  if (parsed.data.NODE_ENV === "production") {
    if (!parsed.data.UPSTREAM_API_BASE_URL) throw new Error("生产环境缺少 UPSTREAM_API_BASE_URL");
    if (!parsed.data.UPSTREAM_X_TOKEN) throw new Error("生产环境缺少 UPSTREAM_X_TOKEN");
    if (!parsed.data.DATABASE_URL) throw new Error("生产环境缺少 DATABASE_URL");
  }
  const secondaryValues = [
    parsed.data.UPSTREAM_SECONDARY_API_BASE_URL,
    parsed.data.UPSTREAM_SECONDARY_X_TOKEN,
    parsed.data.UPSTREAM_SECONDARY_USER_NAME
  ];
  if (secondaryValues.some(Boolean) && !secondaryValues.every(Boolean)) {
    throw new Error("备用后台地址、Token 和用户名必须同时配置");
  }
  return parsed.data;
}
