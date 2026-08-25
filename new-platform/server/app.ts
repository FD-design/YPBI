import cors from "@fastify/cors";
import Fastify from "fastify";
import { z } from "zod";
import type { PlatformEnv } from "./config";
import { NewavAdapter } from "./newav/adapter";
import { NewavClient, NewavError } from "./newav/client";
import { newavDatasets } from "./newav/catalog";
import { productRegistry } from "./products";

const querySchema = z.object({
  productId: z.literal("newav"),
  datasetId: z.enum(newavDatasets.map((item) => item.id) as [typeof newavDatasets[number]["id"], ...Array<typeof newavDatasets[number]["id"]>]),
  dateRange: z.tuple([z.iso.date(), z.iso.date()]),
  channelCode: z.string().trim().max(100).optional()
}).superRefine((value, context) => {
  if (value.dateRange[0] > value.dateRange[1]) context.addIssue({ code: "custom", path: ["dateRange"], message: "开始日期不能晚于结束日期" });
});

export async function buildApp(env: PlatformEnv) {
  const app = Fastify({ logger: env.NODE_ENV !== "test" });
  await app.register(cors, { origin: env.NODE_ENV === "production" ? false : true });
  const client = new NewavClient({ baseUrl: env.NEWAV_API_BASE_URL, token: env.NEWAV_ACCESS_TOKEN, timeoutMs: env.REQUEST_TIMEOUT_MS });
  const adapter = new NewavAdapter(client);

  app.get("/api/health", async () => ({ success: true, data: { status: "ok", products: productRegistry.length } }));
  app.get("/api/products", async () => ({ success: true, data: productRegistry }));
  app.get("/api/products/newav/status", async () => ({ success: true, data: client.status() }));
  app.post("/api/query", async (request, reply) => {
    const parsed = querySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ success: false, error: { code: "INVALID_QUERY", message: "查询参数不合法", details: parsed.error.issues } });
    try {
      return { success: true, data: await adapter.query(parsed.data) };
    } catch (error) {
      if (error instanceof NewavError) return reply.code(error.statusCode).send({ success: false, error: { code: error.code, message: error.message } });
      throw error;
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    reply.code(500).send({ success: false, error: { code: "INTERNAL_ERROR", message: "新 BI 服务处理失败" } });
  });
  return app;
}
