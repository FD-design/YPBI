import { describe, expect, test } from "bun:test";
import Fastify from "fastify";

describe("HTTP 测试运行时响应生命周期", () => {
  for (const hook of ["onRequest", "preHandler"] as const) {
    test(`${hook} 拒绝中文请求后只发送一次响应且不执行后续处理`, async () => {
      const app = Fastify();
      let handlerCalls = 0;
      let responseCalls = 0;
      let errorCalls = 0;
      app.addHook(hook, async (_request, reply) => {
        await Promise.resolve();
        return reply.code(403).send({ message: "当前账号没有数据源维护权限" });
      });
      app.addHook("onResponse", async () => { responseCalls += 1; });
      app.addHook("onError", async () => { errorCalls += 1; });
      app.post("/denied", async () => {
        handlerCalls += 1;
        return { success: true };
      });

      try {
        const response = await app.inject({ method: "POST", url: "/denied", payload: {} });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(response.statusCode).toBe(403);
        expect(response.json<{ message: string }>()).toEqual({ message: "当前账号没有数据源维护权限" });
        expect(response.raw.res.writableEnded).toBe(true);
        expect(handlerCalls).toBe(0);
        expect(responseCalls).toBe(1);
        expect(errorCalls).toBe(0);
      } finally {
        await app.close();
      }
    });
  }
});
