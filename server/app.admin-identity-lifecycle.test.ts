import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app";
import type { AppEnv } from "./config/env";
import type { IdentityProvider, IdentityResolution } from "./identity/identity-provider";

const openApps: FastifyInstance[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(app => app.close()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function createApp(identityProvider: IdentityProvider) {
  const directory = await mkdtemp(join(tmpdir(), "ypbi-admin-identity-lifecycle-"));
  directories.push(directory);
  const env: AppEnv = {
    NODE_ENV: "test", HOST: "127.0.0.1", PORT: 3000,
    UPSTREAM_CREDENTIALS_FILE: join(directory, "credentials.json"),
    WORKSPACE_FILE: join(directory, "workspace.json"),
    BI_V2_CORE_OVERVIEW_QUERY_ENABLED: false,
    BI_LOCAL_DASHBOARD_READING_ENABLED: false,
    BI_PRODUCTION_DASHBOARD_READING_ENABLED: false,
    BI_PRODUCTION_OPERATING_ASYNC_ENABLED: false,
    BI_TEST_DATA_PREVIEW_ENABLED: false,
    REQUEST_TIMEOUT_MS: 1_000, MAX_PLATFORM_CONCURRENCY: 1
  };
  const app = await buildApp(env, { identityProvider });
  openApps.push(app);
  return app;
}

const authenticated: IdentityResolution = {
  status: "authenticated",
  principal: {
    subjectId: "lifecycle-test-user", roles: ["maintainer"],
    permissions: ["bi:read", "bi:data-source-maintenance:enter"],
    pidScope: "all", securityVersion: "1"
  }
};

describe("管理身份请求生命周期", () => {
  for (const route of [
    { method: "GET", path: "/api/bi/admin/data-sources/status" },
    { method: "GET", path: "/api/bi/admin/data-sources/operating-evidence" },
    { method: "POST", path: "/api/bi/admin/auth/logout" }
  ]) {
    test(`${route.method} ${route.path} 身份等待中断连后停止响应及后续处理，迟到身份不授权`, async () => {
      const started = Promise.withResolvers<AbortSignal>();
      const completed = Promise.withResolvers<IdentityResolution>();
      const app = await createApp({ resolve: ({ signal }) => {
        started.resolve(signal);
        return completed.promise;
      } });
      let authorizedHandlerEntries = 0;
      app.addHook("preHandler", async request => {
        if (request.url === route.path) authorizedHandlerEntries++;
      });
      let response: ServerResponse | undefined;
      let writes: ReturnType<typeof spyOn> | undefined;
      app.server.on("request", (request, reply) => {
        if (request.url !== route.path) return;
        response = reply;
        writes = spyOn(reply, "writeHead");
      });
      const origin = await app.listen({ port: 0, host: "127.0.0.1" });
      const client = httpRequest(`${origin}${route.path}`, { method: route.method });
      client.on("error", () => {});
      client.end();
      const signal = await started.promise;
      const aborted = new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      client.destroy();
      await aborted;
      completed.resolve(authenticated);
      // Let the hook, reply thenable and Fastify's subsequent handler turn settle.
      await new Promise(resolve => setTimeout(resolve, 30));

      expect(response?.destroyed).toBe(true);
      expect(writes).toHaveBeenCalledTimes(0);
      expect(authorizedHandlerEntries).toBe(0);
      const health = await app.inject({ method: "GET", url: "/api/bi/health" });
      expect(health.statusCode).toBe(200);
      expect(health.json().data.status).toBe("ok");
      await app.inject({ method: route.method as "GET" | "POST", url: route.path });
      expect(authorizedHandlerEntries).toBe(1);
    });
  }

  test("连接仍在时身份拒绝保持503、401、403契约，且不会执行退出处理", async () => {
    const outcomes: Array<{ resolution: IdentityResolution | Error; status: number; code: string }> = [
      { resolution: new Error("synthetic private identity failure"), status: 503, code: "IDENTITY_PROVIDER_UNAVAILABLE" },
      { resolution: { status: "unavailable" }, status: 503, code: "IDENTITY_PROVIDER_UNAVAILABLE" },
      { resolution: { status: "unauthenticated" }, status: 401, code: "AUTHENTICATION_REQUIRED" },
      { resolution: { ...authenticated, principal: { ...authenticated.principal, permissions: [] } }, status: 403, code: "ADMIN_ACCESS_DENIED" }
    ];
    for (const outcome of outcomes) {
      const app = await createApp({ resolve: async () => {
        if (outcome.resolution instanceof Error) throw outcome.resolution;
        return outcome.resolution;
      } });
      const response = await app.inject({ method: "POST", url: "/api/bi/admin/auth/logout" });
      expect(response.statusCode).toBe(outcome.status);
      expect(response.json()).toMatchObject({ success: false, error: { code: outcome.code, requestId: expect.any(String) } });
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(response.body).not.toContain("synthetic private identity failure");
    }
  });
});
