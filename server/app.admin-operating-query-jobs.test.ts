import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, InjectOptions } from "fastify";
import { buildApp } from "./app";
import type { BiAuthService } from "./auth/service";
import type { AppEnv } from "./config/env";
import type { IdentityResolution, Principal } from "./identity/identity-provider";
import type { QueryJobCreateRequest } from "./upstream/query-jobs";
import { OPERATING_METRIC_IDS } from "../contracts/operating-detail-projection";
import { operatingQueryJobCreatedSchema, operatingQueryJobStatusSchema, operatingQueryJobResultSchema } from "../contracts/operating-query-jobs";
import { OPERATING_QUERY_VALIDATION_PATH as path, operatingQueryValidationCapabilitiesSchema } from "../contracts/operating-query-validation";
import { platformRegistry } from "./platforms/registry";

const origin = "https://bi.example.test";
const password = "fake-maintenance-password-2026";
const session = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const csrf = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const ordinaryCookie = `__Host-ypbi_session=${session}`;
const primaryToken = "fake-primary-token-0001";
const secondaryToken = "fake-secondary-token-0002";
const principal: Principal = { subjectId: "fake-maintainer", roles: ["maintainer"], permissions: ["bi:read", "bi:data-source-maintenance:enter"], pidScope: "all", securityVersion: "1" };
const query = { kind: "operating-snapshot", pids: ["PH"], date: "2026-10-17" };
const unknownHandle = "11111111-1111-4111-8111-111111111111";
const apps: FastifyInstance[] = [];
const directories: string[] = [];
const originalFetch = globalThis.fetch;

interface Observed { url: URL; method: string; token: string | null; userName: string | null; body?: QueryJobCreateRequest }

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  globalThis.fetch = originalFetch;
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function harness(options: { env?: Partial<AppEnv>; principal?: Principal; status?: "RUNNING" | "SUCCEEDED" | "FAILED" | "EXPIRED"; failure?: () => Response } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "ypbi-admin-operating-jobs-")); directories.push(directory);
  const observed: Observed[] = [];
  const jobs = new Map<string, { request: QueryJobCreateRequest; hostname: string }>();
  let resolution: IdentityResolution = { status: "authenticated", principal: options.principal ?? principal };
  let sequence = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (!["primary.example.test", "secondary.example.test", "preview.example.test"].includes(url.hostname)) throw new Error("Unexpected fixture origin");
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) as QueryJobCreateRequest : undefined;
    observed.push({ url, method: init?.method ?? "GET", token: headers.get("x-token"), userName: headers.get("name"), ...(body ? { body } : {}) });
    if (url.pathname.startsWith("/api/admin/bi/v1/queryJobs")) {
      if (options.failure) return options.failure();
      if (init?.method === "POST") {
        const taskId = (++sequence).toString(16).padStart(32, "0");
        jobs.set(taskId, { request: body!, hostname: url.hostname });
        return Response.json({ code: 200, msg: { taskId, reused: false } });
      }
      const taskId = url.pathname.split("/")[6];
      const job = jobs.get(taskId);
      if (!job || job.hostname !== url.hostname) throw new Error("Unbound fixture task");
      const status = options.status ?? "SUCCEEDED";
      return Response.json({ code: 200, msg: { taskId, status, totalUnits: job.request.queries.length,
        completedUnits: status === "SUCCEEDED" ? job.request.queries.length : 0,
        ...(["FAILED", "EXPIRED"].includes(status) ? { errorCode: "EXECUTION_FAILED" } : {}),
        ...(status === "SUCCEEDED" && url.pathname.endsWith("/result") ? { results: job.request.queries.map(() => ({ generatedAt: new Date().toISOString(), rows: [] })) } : {}) } });
    }
    return Response.json({ code: 200, msg: { pageData: [], totalCount: 0 } });
  }) as typeof fetch;
  const env: AppEnv = {
    NODE_ENV: "production", HOST: "127.0.0.1", PORT: 3000,
    UPSTREAM_API_BASE_URL: "https://primary.example.test", UPSTREAM_X_TOKEN: primaryToken, UPSTREAM_USER_NAME: "fake-primary-user",
    UPSTREAM_SECONDARY_API_BASE_URL: "https://secondary.example.test", UPSTREAM_SECONDARY_X_TOKEN: secondaryToken, UPSTREAM_SECONDARY_USER_NAME: "fake-secondary-user",
    UPSTREAM_CREDENTIALS_FILE: join(directory, "credentials.json"), WORKSPACE_FILE: join(directory, "workspace.json"),
    TOKEN_MAINTENANCE_KEY: password, BI_PUBLIC_ORIGIN: origin,
    BI_V2_CORE_OVERVIEW_QUERY_ENABLED: false, BI_LOCAL_DASHBOARD_READING_ENABLED: false,
    BI_PRODUCTION_DASHBOARD_READING_ENABLED: true, BI_PRODUCTION_OPERATING_ASYNC_ENABLED: false, BI_TEST_DATA_PREVIEW_ENABLED: false,
    REQUEST_TIMEOUT_MS: 1_000, MAX_PLATFORM_CONCURRENCY: 1, ...options.env
  };
  const app = await buildApp(env, { identityProvider: { resolve: async () => resolution },
    authService: { csrfMatches: (value: string, token: string | undefined) => value === session && token === csrf } as BiAuthService });
  apps.push(app);
  const request = (method: "GET" | "POST" | "PUT" | "HEAD", url: string, payload?: InjectOptions["payload"], overrides: Record<string, string | undefined> = {}) => {
    const headers = Object.fromEntries(Object.entries({ "x-forwarded-proto": "https", "x-forwarded-for": "192.0.2.11", origin,
      cookie: ordinaryCookie, "x-csrf-token": csrf, "x-ypbi-data-environment": "production", ...overrides }).filter((entry): entry is [string, string] => entry[1] !== undefined));
    return app.inject({ method, url, payload, remoteAddress: "127.0.0.1", headers });
  };
  const login = async () => {
    const result = await request("POST", "/api/bi/admin/auth/login", { password }); expect(result.statusCode).toBe(200);
    const setCookie = result.headers["set-cookie"];
    const cookie = (Array.isArray(setCookie) ? setCookie : [setCookie]).find(value => value?.startsWith("bi_maintenance_session="))!;
    expect(cookie).toContain("Path=/api/bi/admin;"); expect(cookie).toContain("HttpOnly; Secure; SameSite=Strict");
    return `${ordinaryCookie}; ${cookie.split(";", 1)[0]}`;
  };
  return { app, request, login, observed, env, setResolution: (value: IdentityResolution) => { resolution = value; } };
}

const operations = [
  ["GET", `${path}/capabilities`], ["POST", path], ["GET", `${path}/${unknownHandle}`], ["GET", `${path}/${unknownHandle}/result`]
] as const;

describe("维护保护的正式经营异步验收", () => {
  test("capabilities按授权平台同站分组，普通正式目录与三步仍关闭", async () => {
    const h = await harness(); const cookie = await h.login();
    const response = await h.request("GET", `${path}/capabilities`, undefined, { cookie });
    expect(response.statusCode).toBe(200);
    const capabilities = operatingQueryValidationCapabilitiesSchema.parse(response.json());
    expect(capabilities.data.environment).toBe("production"); expect(capabilities.data.enabled).toBe(true);
    expect(capabilities.data.groups.flatMap(group => group.pids).sort()).toEqual(platformRegistry.filter(item => item.enabled).map(item => item.pid).sort());
    for (const group of capabilities.data.groups) {
      expect(group.pids.length).toBeLessThanOrEqual(20);
      expect(group.pids.every(pid => platformRegistry.some(item => item.pid === pid && item.siteId === group.site && item.enabled))).toBe(true);
    }
    const catalog = (await h.request("GET", "/api/bi/v2/catalog/readable-dashboards")).json().data;
    expect(catalog.operatingAsyncEnabled).toBe(false); expect(catalog.operatingAsyncPidGroups).toBeUndefined();
    for (const [method, suffix] of [["POST", ""], ["GET", `/${unknownHandle}`], ["GET", `/${unknownHandle}/result`]] as const) {
      const result = await h.request(method, `/api/bi/v2/queries/jobs${suffix}`, method === "POST" ? query : undefined, { cookie });
      expect(result.statusCode).toBe(422); expect(result.json().error.code).toBe("QUERY_JOBS_DISABLED");
    }
    expect(h.observed).toHaveLength(0); expect(existsSync(h.env.UPSTREAM_CREDENTIALS_FILE)).toBe(false);
  });

  for (const [pid, hostname, token, userName] of [["PH", "primary.example.test", primaryToken, "fake-primary-user"], ["FBI", "secondary.example.test", secondaryToken, "fake-secondary-user"]]) {
    test(`${pid}维护三步复用正式来源与完整93列`, async () => {
      const h = await harness(); const cookie = await h.login();
      const created = await h.request("POST", path, { ...query, pids: [pid] }, { cookie });
      expect(created.statusCode).toBe(200); const handle = operatingQueryJobCreatedSchema.parse(created.json()).data.handle;
      const status = await h.request("GET", `${path}/${handle}`, undefined, { cookie });
      expect(status.statusCode).toBe(200); expect(operatingQueryJobStatusSchema.parse(status.json()).data.status).toBe("SUCCEEDED");
      let result = await h.request("GET", `${path}/${handle}/result`, undefined, { cookie });
      for (let attempt = 0; attempt < 5 && result.statusCode === 200 && result.json().data.phase !== "complete"; attempt++) {
        await new Promise<void>(resolve => setImmediate(resolve));
        result = await h.request("GET", `${path}/${handle}/result`, undefined, { cookie });
      }
      expect(result.statusCode).toBe(200); const data = operatingQueryJobResultSchema.parse(result.json()).data;
      expect(data.phase).toBe("complete"); expect(data.dashboards![0].data.series.map(series => series.metric.id)).toEqual([...OPERATING_METRIC_IDS]);
      expect(h.observed.every(item => item.url.hostname === hostname && item.token === token && item.userName === userName)).toBe(true);
      expect(h.observed.some(item => item.method === "POST" && item.body?.queries.every(unit => unit.query.pid === pid))).toBe(true);
      expect(result.body).not.toContain(token); expect(result.body).not.toContain(userName);
      expect(result.body).not.toContain("taskId"); expect(result.body).not.toContain("sourceRef");
      expect(existsSync(h.env.UPSTREAM_CREDENTIALS_FILE)).toBe(false);
    });
  }

  test("正式日读取关闭时capabilities关闭且三步零上游", async () => {
    const h = await harness({ env: { BI_PRODUCTION_DASHBOARD_READING_ENABLED: false } }); const cookie = await h.login();
    const response = await h.request("GET", `${path}/capabilities`, undefined, { cookie });
    expect(response.statusCode).toBe(200); expect(response.json().data).toEqual({ environment: "production", enabled: false, groups: [] });
    for (const [method, url] of operations.slice(1)) {
      const result = await h.request(method, url, method === "POST" ? query : undefined, { cookie });
      expect(result.statusCode).toBe(422); expect(result.json().error.code).toBe("QUERY_JOBS_DISABLED");
    }
    expect(h.observed).toHaveLength(0);
  });

  for (const [state, expected] of [["unauthenticated", 401], ["unavailable", 503]] as const) test(`普通身份${state}时四入口均拒绝`, async () => {
    const h = await harness(); const cookie = await h.login(); h.setResolution({ status: state });
    for (const [method, url] of operations) expect((await h.request(method, url, method === "POST" ? query : undefined, { cookie })).statusCode).toBe(expected);
    expect(h.observed).toHaveLength(0);
  });

  test("四入口缺维护会话均拒绝", async () => {
    const h = await harness();
    for (const [method, url] of operations) {
      const result = await h.request(method, url, method === "POST" ? query : undefined);
      expect(result.statusCode).toBe(401); expect(result.json().error.code).toBe("MAINTENANCE_LOGIN_REQUIRED");
    }
    expect(h.observed).toHaveLength(0);
  });

  test("缺维护权限或BI读取权限均不进入服务", async () => {
    const h = await harness({ principal: { ...principal, permissions: ["bi:data-source-maintenance:enter"] } }); const cookie = await h.login();
    for (const [method, url] of operations) expect((await h.request(method, url, method === "POST" ? query : undefined, { cookie })).statusCode).toBe(403);
    h.setResolution({ status: "authenticated", principal: { ...principal, permissions: ["bi:read"] } });
    expect((await h.request("GET", `${path}/capabilities`, undefined, { cookie })).json().error.code).toBe("ADMIN_ACCESS_DENIED");
    expect(h.observed).toHaveLength(0);
  });

  for (const header of [undefined, "test", "invalid", "production,test"]) test(`显式正式环境必填且不接受${String(header)}`, async () => {
    const h = await harness(); const cookie = await h.login();
    for (const [method, url] of operations) {
      const result = await h.request(method, url, method === "POST" ? query : undefined, { cookie, "x-ypbi-data-environment": header });
      expect(result.statusCode).toBe(400); expect(result.json().error.code).toBe("INVALID_DATA_ENVIRONMENT");
    }
    expect(h.observed).toHaveLength(0);
  });

  test("错误环境头别名不能使test意图回退正式", async () => {
    const h = await harness(); const cookie = await h.login();
    for (const value of ["test", "invalid", "production,test"]) {
      expect((await h.request("POST", path, query, { cookie, "x-bi-data-environment": value })).statusCode).toBe(400);
    }
    expect(h.observed).toHaveLength(0);
  });

  test("有效测试会话共存时显式正式验收仍使用本站正式来源", async () => {
    const h = await harness({ status: "RUNNING", env: { BI_TEST_DATA_PREVIEW_ENABLED: true,
      UPSTREAM_TEST_API_BASE_URL: "https://preview.example.test", UPSTREAM_TEST_USER_NAME: "fake-preview-user" } });
    const cookie = await h.login();
    const preview = await h.request("POST", "/api/bi/admin/data-preview/activate", { token: "fake-preview-session-token" }, { cookie });
    expect(preview.statusCode).toBe(200);
    const setCookie = preview.headers["set-cookie"];
    const previewCookie = (Array.isArray(setCookie) ? setCookie : [setCookie]).find(value => value?.startsWith("ypbi_data_preview="))!.split(";", 1)[0];
    const cookies = `${cookie}; ${previewCookie}`;
    expect(h.observed.every(item => item.url.hostname === "preview.example.test")).toBe(true);
    h.observed.splice(0);
    const created = await h.request("POST", path, query, { cookie: cookies });
    expect(created.statusCode).toBe(200);
    expect(h.observed.every(item => item.url.hostname === "primary.example.test" && item.token === primaryToken && item.userName === "fake-primary-user")).toBe(true);
    const count = h.observed.length;
    expect((await h.request("POST", path, query, { cookie: cookies, "x-ypbi-data-environment": "test" })).statusCode).toBe(400);
    expect(h.observed).toHaveLength(count);
  });

  test("HEAD与非法句柄不触发任务查询", async () => {
    const h = await harness(); const cookie = await h.login();
    for (const suffix of ["/capabilities", `/${unknownHandle}`, `/${unknownHandle}/result`]) {
      expect((await h.request("HEAD", `${path}${suffix}`, undefined, { cookie })).statusCode).toBe(404);
    }
    for (const suffix of ["", "/result"]) {
      const response = await h.request("GET", `${path}/invalid-handle${suffix}`, undefined, { cookie });
      expect(response.statusCode).toBe(400); expect(response.json().error.code).toBe("QUERY_JOB_INVALID");
    }
    expect(h.observed).toHaveLength(0);
  });

  test("非法JSON和超大请求只返回安全任务错误", async () => {
    const h = await harness(); const cookie = await h.login();
    for (const [body, status] of [[`{"pids": ${primaryToken}}`, 400], [JSON.stringify({ reflected: primaryToken.repeat(5000) }), 413]] as const) {
      const result = await h.request("POST", path, body, { cookie, "content-type": "application/json" });
      expect(result.statusCode).toBe(status); expect(result.json().error.code).toBe("QUERY_JOB_INVALID");
      expect(result.body).not.toContain(primaryToken); expect(h.observed).toHaveLength(0);
    }
  });

  test("capabilities限定PID，越权及跨站任务和自定义指标零来源", async () => {
    const h = await harness({ principal: { ...principal, pidScope: ["PH", "FBI"] } }); const cookie = await h.login();
    const capabilities = (await h.request("GET", `${path}/capabilities`, undefined, { cookie })).json().data;
    expect(capabilities.groups).toEqual([{ site: "primary", pids: ["PH"] }, { site: "secondary", pids: ["FBI"] }]);
    for (const [body, status] of [[{ ...query, pids: ["PH", "FBI"] }, 400], [{ ...query, pids: ["TJD"] }, 403], [{ ...query, queries: [] }, 400], [{ ...query, rows: [] }, 400]] as const) {
      expect((await h.request("POST", path, body, { cookie })).statusCode).toBe(status);
    }
    expect(h.observed).toHaveLength(0);
  });

  for (const [headers, status, code] of [
    [{ "x-csrf-token": undefined }, 403, "CSRF_VALIDATION_FAILED"], [{ "x-csrf-token": "bad" }, 403, "CSRF_VALIDATION_FAILED"],
    [{ origin: "https://untrusted.example.test" }, 403, "MAINTENANCE_ORIGIN_REJECTED"],
    [{ "x-forwarded-proto": "http" }, 426, "HTTPS_REQUIRED"], [{ "x-forwarded-for": undefined }, 503, "MAINTENANCE_PROXY_MISCONFIGURED"]
  ] as const) test(`生产POST继续执行${code}保护${JSON.stringify(headers)}`, async () => {
    const h = await harness(); const cookie = await h.login();
    const response = await h.request("POST", path, query, { cookie, ...headers });
    expect(response.statusCode).toBe(status); expect(response.json().error.code).toBe(code); expect(h.observed).toHaveLength(0);
  });

  for (const change of ["subject", "roles", "securityVersion", "ip", "logout"]) test(`${change}变化使维护许可失效`, async () => {
    const h = await harness(); const cookie = await h.login();
    if (change === "logout") expect((await h.request("POST", "/api/bi/admin/auth/logout", undefined, { cookie })).statusCode).toBe(200);
    else if (change !== "ip") h.setResolution({ status: "authenticated", principal: { ...principal, ...(change === "subject" ? { subjectId: "other-user" } : change === "roles" ? { roles: ["viewer"] } : { securityVersion: "2" }) } });
    const result = await h.request("POST", path, query, { cookie, ...(change === "ip" ? { "x-forwarded-for": "192.0.2.12" } : {}) });
    expect(result.statusCode).toBe(401); expect(result.json().error.code).toBe("MAINTENANCE_LOGIN_REQUIRED"); expect(h.observed).toHaveLength(0);
  });

  test("另一用户重新维护登录后不能读取原用户句柄", async () => {
    const h = await harness({ status: "RUNNING" }); const cookie = await h.login();
    const created = await h.request("POST", path, query, { cookie }); expect(created.statusCode).toBe(200);
    h.setResolution({ status: "authenticated", principal: { ...principal, subjectId: "other-maintainer" } }); const otherCookie = await h.login();
    const count = h.observed.length;
    for (const suffix of ["", "/result"]) expect((await h.request("GET", `${path}/${created.json().data.handle}${suffix}`, undefined, { cookie: otherCookie })).statusCode).toBe(404);
    expect(h.observed).toHaveLength(count);
  });

  test("公开与维护入口共享同账号两槽容量", async () => {
    const h = await harness({ status: "RUNNING", env: { BI_PRODUCTION_OPERATING_ASYNC_ENABLED: true } }); const cookie = await h.login();
    const first = await h.request("POST", path, query, { cookie }); expect(first.statusCode).toBe(200);
    const reused = await h.request("POST", path, query, { cookie });
    expect(reused.statusCode).toBe(200); expect(reused.json().data.handle).toBe(first.json().data.handle); expect(reused.json().data.reused).toBe(true);
    expect((await h.request("POST", "/api/bi/v2/queries/jobs", { ...query, date: "2026-10-16" })).statusCode).toBe(200);
    const third = await h.request("POST", path, { ...query, date: "2026-10-15" }, { cookie });
    expect(third.statusCode).toBe(429); expect(third.json().error.code).toBe("QUERY_JOB_CAPACITY");
    expect(h.observed.filter(item => item.method === "POST")).toHaveLength(2);
  });

  for (const status of ["FAILED", "EXPIRED"] as const) test(`${status}终态安全错误码保持且不补发同步`, async () => {
    const h = await harness({ status }); const cookie = await h.login();
    const created = await h.request("POST", path, query, { cookie }); expect(created.statusCode).toBe(200);
    await new Promise<void>(resolve => setImmediate(resolve));
    const handle = created.json().data.handle;
    for (const suffix of ["", "/result"]) {
      const response = await h.request("GET", `${path}/${handle}${suffix}`, undefined, { cookie });
      expect(response.statusCode).toBe(200); expect(response.json().data).toMatchObject({ status, errorCode: "EXECUTION_FAILED", phase: "query" });
      expect(response.body).not.toContain(primaryToken); expect(response.body).not.toContain("taskId");
    }
    expect(h.observed.filter(item => item.method === "POST")).toHaveLength(1);
    expect(h.observed.every(item => !/bi\/v1\/(metrics|playback)/.test(item.url.pathname))).toBe(true);
  });

  test("凭据A-B-A后旧句柄失效而另一站继续有效", async () => {
    const h = await harness({ status: "RUNNING" }); const cookie = await h.login();
    const first = await h.request("POST", path, query, { cookie }); expect(first.statusCode).toBe(200);
    const other = await h.request("POST", path, { ...query, pids: ["FBI"] }, { cookie }); expect(other.statusCode).toBe(200);
    for (const token of ["fake-rotated-primary-token", primaryToken]) expect((await h.request("PUT", "/api/bi/admin/data-sources/token", { site: "primary", token }, { cookie })).statusCode).toBe(200);
    const count = h.observed.length;
    for (const suffix of ["", "/result"]) {
      const response = await h.request("GET", `${path}/${first.json().data.handle}${suffix}`, undefined, { cookie });
      expect(response.statusCode).toBe(409); expect(response.json().error.code).toBe("QUERY_JOB_CONTEXT_CHANGED");
    }
    expect(h.observed).toHaveLength(count);
    expect((await h.request("GET", `${path}/${other.json().data.handle}`, undefined, { cookie })).statusCode).toBe(200);
  });

  test("上游拒绝只投影安全数字诊断，不回显原文", async () => {
    const reflected = `${primaryToken} fake-primary-user sensitive-error`;
    const h = await harness({ failure: () => Response.json({ code: 400, err: reflected }) }); const cookie = await h.login();
    const response = await h.request("POST", path, query, { cookie });
    expect(response.statusCode).toBe(400); expect(response.json().error).toMatchObject({ code: "QUERY_JOB_UPSTREAM_REJECTED", upstreamBusinessCode: 400, upstreamHttpStatus: 200 });
    expect(response.body).not.toContain(reflected); expect(response.body).not.toContain(primaryToken); expect(response.body).not.toContain("fake-primary-user");
  });

  for (const [httpStatus, code, status] of [[401, "V2_UPSTREAM_UNAVAILABLE", 503], [429, "V2_UPSTREAM_RATE_LIMITED", 503], [500, "V2_UPSTREAM_FAILED", 502]] as const) {
    test(`上游HTTP${httpStatus}只返回固定安全错误`, async () => {
      const h = await harness({ failure: () => new Response(`${primaryToken} fake-primary-user`, { status: httpStatus }) }); const cookie = await h.login();
      const result = await h.request("POST", path, query, { cookie });
      expect(result.statusCode).toBe(status); expect(result.json().error.code).toBe(code);
      expect(result.body).not.toContain(primaryToken); expect(result.body).not.toContain("fake-primary-user");
    });
  }
});
