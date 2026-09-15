import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FastifyInstance } from "fastify";
import type { AppEnv } from "./config/env";
import type { IdentityProvider } from "./identity/identity-provider";
import { buildApp } from "./app";

const openApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

const env: AppEnv = {
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: 3000,
  UPSTREAM_CREDENTIALS_FILE: join(tmpdir(), "ypbi-v2-error-test-credentials.json"),
  WORKSPACE_FILE: join(tmpdir(), "ypbi-v2-error-test-workspace.json"),
  BI_V2_CORE_OVERVIEW_QUERY_ENABLED: false,
  BI_LOCAL_DASHBOARD_READING_ENABLED: false,
  REQUEST_TIMEOUT_MS: 1_000,
  MAX_PLATFORM_CONCURRENCY: 1
};

const readerIdentity: IdentityProvider = {
  resolve: async () => ({
    status: "authenticated",
    principal: {
      subjectId: "test-user",
      roles: ["viewer"],
      permissions: ["bi:read"],
      pidScope: ["PH"]
    }
  })
};

const maintainerIdentity: IdentityProvider = {
  resolve: async () => ({
    status: "authenticated",
    principal: {
      subjectId: "test-maintainer",
      roles: ["maintainer"],
      permissions: ["bi:read", "bi:data-source-maintenance:enter"],
      pidScope: ["PH"]
    }
  })
};

describe("buildApp V2 error boundary", () => {
  test("核心经营总览开关开启但没有真实执行器时启动即失败关闭", async () => {
    await expect(buildApp(
      { ...env, BI_V2_CORE_OVERVIEW_QUERY_ENABLED: true },
      { identityProvider: readerIdentity }
    )).rejects.toThrow("必须注入核心经营总览真实查询执行器");
  });

  test("默认运行入口没有正式身份来源时必然失败关闭", async () => {
    const app = await buildApp(env);
    openApps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/bi/v2/catalog/metrics" });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("IDENTITY_PROVIDER_UNAVAILABLE");
  });

  test("未知异常只返回稳定 500 契约，不回传内部错误原文", async () => {
    const app = await buildApp({ ...env, BI_V2_CORE_OVERVIEW_QUERY_ENABLED: true }, {
      identityProvider: maintainerIdentity,
      v2CoreOverviewQueryService: { execute: async () => { throw Object.assign(new Error("secret raw upstream row"), { statusCode: 401 }); } }
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/bi/v2/queries/dashboards/core-overview",
      payload: { scope: { kind: "pids", pids: ["PH"] }, metricIds: ["M016"] }
    });

    expect(response.statusCode).toBe(500);
    const payload = response.json() as { success: boolean; error: { code: string; message: string; requestId: string } };
    expect(payload.success).toBe(false);
    expect(payload.error.code).toBe("INTERNAL_ERROR");
    expect(payload.error.message).toBe("BI 服务处理失败");
    expect(payload.error.requestId).toBeString();
    expect(response.body).not.toContain("secret raw upstream row");
  });

  test("坏 JSON 与不支持的 Content-Type 保留 4xx 且使用安全 V2 错误码", async () => {
    const app = await buildApp(env, { identityProvider: readerIdentity });
    openApps.push(app);

    const invalidJson = await app.inject({
      method: "POST",
      url: "/api/bi/v2/queries/metrics",
      headers: { "content-type": "application/json" },
      payload: "{invalid"
    });
    expect(invalidJson.statusCode).toBe(400);
    expect(invalidJson.json().error.code).toBe("INVALID_V2_REQUEST");

    const emptyJson = await app.inject({
      method: "POST",
      url: "/api/bi/v2/queries/metrics",
      headers: { "content-type": "application/json" },
      payload: ""
    });
    expect(emptyJson.statusCode).toBe(400);
    expect(emptyJson.json().error.code).toBe("INVALID_V2_REQUEST");

    const unsupportedType = await app.inject({
      method: "POST",
      url: "/api/bi/v2/queries/metrics",
      headers: { "content-type": "application/xml" },
      payload: "<query />"
    });
    expect(unsupportedType.statusCode).toBe(415);
    expect(unsupportedType.json().error.code).toBe("V2_UNSUPPORTED_MEDIA_TYPE");

    const tooLarge = await app.inject({
      method: "POST",
      url: "/api/bi/v2/queries/metrics",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ padding: "x".repeat(1_050_000) })
    });
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json().error.code).toBe("V2_REQUEST_TOO_LARGE");
  });

  test("V2 错误边界不改变遗留 API 的原有统一 500 错误响应", async () => {
    const app = await buildApp(env, { identityProvider: readerIdentity });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/bi/analytics/query",
      headers: { "content-type": "application/json" },
      payload: "{invalid"
    });

    expect(response.statusCode).toBe(500);
    const payload = response.json() as { success: boolean; error: { code: string; message: string } };
    expect(payload).toEqual({
      success: false,
      error: { code: "INTERNAL_ERROR", message: "BI 服务处理失败" }
    });
  });
});
