import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app";
import type { AppEnv } from "./config/env";
import type { IdentityProvider, IdentityResolution } from "./identity/identity-provider";
import { markIdentityLookupPhase, recordIdentityStorageFailure } from "./identity/identity-lookup-diagnostics";

const apps: FastifyInstance[] = [], directories: string[] = [];
const restoreLoggers: Array<() => void> = [];
const privateValues = ["private-cookie-value", "private-upstream-token", "private-account-name", "private-identity-error", "private-query-value"];
const authenticated: IdentityResolution = { status: "authenticated", principal: {
  subjectId: privateValues[2], roles: ["maintainer"], permissions: ["bi:read", "bi:data-source-maintenance:enter"], pidScope: "all", securityVersion: "1"
} };

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  restoreLoggers.splice(0).forEach(restore => restore());
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture(identityProvider: IdentityProvider) {
  const directory = await mkdtemp(join(tmpdir(), "ypbi-admin-identity-diagnostics-"));
  directories.push(directory);
  const env: AppEnv = { NODE_ENV: "test", HOST: "127.0.0.1", PORT: 3000,
    UPSTREAM_CREDENTIALS_FILE: join(directory, "credentials.json"), WORKSPACE_FILE: join(directory, "workspace.json"),
    BI_V2_CORE_OVERVIEW_QUERY_ENABLED: false, BI_LOCAL_DASHBOARD_READING_ENABLED: false,
    BI_PRODUCTION_DASHBOARD_READING_ENABLED: false, BI_PRODUCTION_OPERATING_ASYNC_ENABLED: false,
    BI_TEST_DATA_PREVIEW_ENABLED: false, REQUEST_TIMEOUT_MS: 1_000, MAX_PLATFORM_CONCURRENCY: 1 };
  const app = await buildApp(env, { identityProvider });
  apps.push(app);
  const logs: Array<{ level: string; args: unknown[] }> = [];
  app.addHook("onRequest", async request => {
    for (const level of ["error", "warn"] as const) {
      const logger = spyOn(request.log, level).mockImplementation((...args: unknown[]) => { logs.push({ level, args }); });
      restoreLoggers.push(() => logger.mockRestore());
    }
  });
  return { app, logs, request: () => app.inject({ method: "POST", url: `/api/bi/admin/auth/logout?query=${privateValues[4]}`,
    headers: { cookie: `private=${privateValues[0]}`, "x-token": privateValues[1], name: privateValues[2] } }) };
}

function assertSafe(logs: unknown, body: string) {
  const serialized = JSON.stringify(logs);
  for (const value of privateValues) {
    expect(serialized).not.toContain(value);
    expect(body).not.toContain(value);
  }
  expect(body).not.toContain("identityLookup");
  expect(body).not.toContain("storageFailureCode");
}

describe("管理入口身份失败的安全阶段诊断", () => {
  for (const [name, resolution, expectedStatus, expectedCode] of [
    ["认证成功", authenticated, 200, null],
    ["未登录", { status: "unauthenticated" }, 401, "AUTHENTICATION_REQUIRED"],
    ["权限拒绝", { ...authenticated, principal: { ...authenticated.principal, permissions: [] } }, 403, "ADMIN_ACCESS_DENIED"]
  ] as const) test(`${name}保持原响应，不记录身份失败或凭据`, async () => {
    const current = await fixture({ resolve: async () => resolution });
    const response = await current.request();
    expect(response.statusCode).toBe(expectedStatus);
    if (expectedCode) expect(response.json().error.code).toBe(expectedCode);
    else expect(response.json<{ success: boolean; data: { loggedOut: boolean } }>()).toEqual({ success: true, data: { loggedOut: true } });
    expect(current.logs).toEqual([]);
    assertSafe(current.logs, response.body);
  });

  for (const mode of ["unavailable", "storage", "unknown"] as const) test(`${mode}仅记录既有固定消息和白名单阶段`, async () => {
    const current = await fixture({ resolve: async ({ signal }) => {
      markIdentityLookupPhase(signal, "query");
      if (mode === "unavailable") return { status: "unavailable", reason: privateValues[3] };
      if (mode === "storage") recordIdentityStorageFailure(signal, { code: "ECONNRESET", message: privateValues[3] });
      throw new Error(privateValues[3]);
    } });
    const response = await current.request();
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("IDENTITY_PROVIDER_UNAVAILABLE");
    expect(current.logs).toHaveLength(1);
    const [fields, message] = current.logs[0].args;
    expect(message).toBe("BI user session lookup failed");
    expect(Object.keys(fields as object).sort()).toEqual(["identityLookup", "outcome", "requestId"]);
    expect(fields).toMatchObject({ requestId: response.json().error.requestId, outcome: "session_failed", identityLookup: {
      failureCode: mode === "storage" ? "storage_unavailable" : "unknown", phase: "query", deadlineMs: 3_000,
      elapsedMs: expect.any(Number), phaseElapsedMs: expect.any(Number), deadlineOverrunMs: expect.any(Number),
      ...(mode === "storage" ? { storageFailureCode: "connection_unavailable" } : {})
    } });
    assertSafe(current.logs, response.body);
  });

  test("原3秒deadline保持，超时只记录真实阶段，不输出任意错误", async () => {
    const current = await fixture({ resolve: ({ signal }) => new Promise((_resolve, reject) => {
      markIdentityLookupPhase(signal, "acquire");
      signal.addEventListener("abort", () => reject(new Error(privateValues[3])), { once: true });
    }) });
    const response = await current.request();
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("IDENTITY_PROVIDER_UNAVAILABLE");
    expect(current.logs).toHaveLength(1);
    expect(current.logs[0].args[0]).toMatchObject({ requestId: response.json().error.requestId, outcome: "session_failed",
      identityLookup: { failureCode: "deadline_exceeded", phase: "acquire", deadlineMs: 3_000 } });
    expect(current.logs[0].args[1]).toBe("BI user session lookup failed");
    assertSafe(current.logs, response.body);
  });
});
