import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  NEWAV_API_BASE_URL: z.url().default("https://newav0.com"),
  NEWAV_ACCESS_TOKEN: z.string().min(1).optional(),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(30000)
});

export type PlatformEnv = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.safeParse(source);
  if (!parsed.success) throw new Error(`新 BI 环境变量配置错误：${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
