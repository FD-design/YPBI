import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { z } from "zod";
import type { DailyDashboardQuery, DailyDashboardSuccess } from "../../../contracts/daily-dashboard";
import { V2_AUTHENTICATION_REQUIRED_EVENT } from "./authEvents";
import { fetchDailyDashboard, fetchDataEnvironment } from "./client";
import { reportInvalidResponse, type InvalidResponsePhase } from "./response-format-diagnostics";

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const query: DailyDashboardQuery = { boardId: "5.2", pid: "PH", dateRange: ["2026-10-12", "2026-10-12"] };
const productionEnvironment = { success: true, data: { mode: "production", testAvailable: true, expiresAt: null, userName: null } };
const secret = "fixture-secret-token-cookie-password";
let warnings: unknown[][];
let warningSpy: ReturnType<typeof spyOn<typeof console, "warn">>;

beforeEach(() => {
  warnings = [];
  warningSpy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => { warnings.push(args); });
});
afterEach(() => {
  warningSpy.mockRestore();
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

function diagnostic() {
  expect(warnings).toHaveLength(1);
  expect(warnings[0][0]).toBe("[BI_RESPONSE_INVALID]");
  expect(warnings[0]).toHaveLength(2);
  return JSON.parse(String(warnings[0][1]));
}
function mockResponse(response: () => Response) {
  globalThis.fetch = Object.assign(async () => response(), { preconnect: originalFetch.preconnect });
}
function responseFixture(): DailyDashboardSuccess {
  return { success: true, data: { schemaVersion: "day-dashboard/v1", query: structuredClone(query), queryId: "fixture-query",
    fetchedAt: "2026-10-14T00:00:00.000Z", timezone: "Asia/Shanghai", validationStatus: "pending_validation",
    completeness: "unknown", watermark: null, sourceApiIds: ["/fixture-source"],
    series: [{ metric: { id: "M001", name: "访问次数", unit: "次", definition: "有效页面浏览次数", authorityVersion: "fixture",
      formula: null, referenceMetricId: "M001", sourceNote: null, inputs: [{ key: "count", name: "访问次数", unit: "次" }] },
      points: [{ date: query.dateRange[0], state: "available", value: 0, inputs: [{ key: "count", value: 0 }] }] }] } };
}

describe("响应格式诊断安全边界", () => {
  test("只记录固定字段路径、数组位置和问题代码，忽略动态键、值和消息", () => {
    const parsed = z.record(z.string(), z.string().min(4)).safeParse({ [secret]: "x" });
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("Expected invalid fixture");
    const customIssue = { code: "custom", path: ["data", "series", 2, "points", 0, "value"], message: secret };
    reportInvalidResponse(200, "success_schema", [
      ...parsed.error.issues,
      customIssue,
      { code: secret, path: ["https://fixture.invalid/?token=" + secret, Symbol(secret), -1, Infinity] }
    ]);
    expect(diagnostic()).toEqual({ status: 200, phase: "success_schema", issues: [
      { path: ["*"], code: "too_small" },
      { path: ["data", "series", 2, "points", 0, "value"], code: "custom" },
      { path: ["*", "*", "*", "*"], code: "unknown_issue" }
    ] });
    expect(JSON.stringify(warnings)).not.toContain(secret);
    expect(JSON.stringify(warnings)).not.toContain("https://");
  });

  test("问题数量与路径深度有固定上限", () => {
    reportInvalidResponse(502, "error_schema", Array.from({ length: 30 }, () => ({
      code: "invalid_type", path: Array.from({ length: 100 }, (_, index) => index % 2 ? secret : "data")
    })));
    const result = diagnostic();
    expect(result.issues).toHaveLength(5);
    expect(result.issues.every((issue: { path: unknown[] }) => issue.path.length === 12)).toBe(true);
    expect(JSON.stringify(warnings)).not.toContain(secret);
  });

  test("运行时非法阶段和值不会进入日志", () => {
    reportInvalidResponse(200, secret as InvalidResponsePhase);
    expect(warnings).toHaveLength(0);
    reportInvalidResponse(NaN, "json_parse");
    expect(diagnostic()).toEqual({ status: 0, phase: "json_parse" });
  });

  test("诊断读取或输出异常独立隔离", () => {
    const issue = { code: "custom", get path(): PropertyKey[] { throw new Error(secret); } };
    expect(() => reportInvalidResponse(502, "error_schema", [issue])).not.toThrow();
    warningSpy.mockImplementation(() => { throw new Error(secret); });
    expect(() => reportInvalidResponse(504, "json_parse")).not.toThrow();
  });
});

describe("实际客户端拒绝阶段", () => {
  for (const status of [200, 502, 504]) test(`非JSON HTTP${status}记录解析阶段且保持原失败`, async () => {
    mockResponse(() => new Response("<html>" + secret + "</html>", { status }));
    await expect(fetchDataEnvironment()).rejects.toMatchObject({
      code: "INVALID_V2_RESPONSE", status, kind: "error", message: "数据服务返回了无法识别的内容"
    });
    expect(diagnostic()).toEqual({ status, phase: "json_parse" });
    expect(JSON.stringify(warnings)).not.toContain(secret);
  });

  test("成功响应Schema拒绝只记录安全位置", async () => {
    mockResponse(() => Response.json({ ...productionEnvironment, data: { ...productionEnvironment.data, [secret]: secret } }));
    await expect(fetchDataEnvironment()).rejects.toMatchObject({ code: "INVALID_V2_RESPONSE", status: 200 });
    expect(diagnostic()).toEqual({ status: 200, phase: "success_schema", issues: [{ path: ["data"], code: "unrecognized_keys" }] });
    expect(JSON.stringify(warnings)).not.toContain(secret);
  });

  test("错误响应Schema拒绝不记录原错误内容", async () => {
    mockResponse(() => Response.json({ success: false, error: { code: secret, message: secret, requestId: secret, [secret]: secret } }, { status: 503 }));
    await expect(fetchDataEnvironment()).rejects.toMatchObject({ code: "INVALID_V2_RESPONSE", status: 503 });
    const result = diagnostic();
    expect(result.status).toBe(503);
    expect(result.phase).toBe("error_schema");
    expect(result.issues).toEqual([
      { path: ["error", "code"], code: "invalid_value" },
      { path: ["error"], code: "unrecognized_keys" }
    ]);
    expect(JSON.stringify(warnings)).not.toContain(secret);
  });

  test("经营响应回显拒绝只记录固定阶段，不记录查询或返回值", async () => {
    const payload = responseFixture();
    payload.data.query.pid = "fixture-private-pid";
    payload.data.queryId = secret;
    mockResponse(() => Response.json(payload));
    await expect(fetchDailyDashboard(query, ["M001"])).rejects.toMatchObject({ code: "INVALID_V2_RESPONSE", status: 200 });
    expect(diagnostic()).toEqual({ status: 200, phase: "query_match" });
    expect(JSON.stringify(warnings)).not.toContain(secret);
    expect(JSON.stringify(warnings)).not.toContain(payload.data.query.pid);
    expect(JSON.stringify(warnings)).not.toContain(query.pid);
  });

  test("日志输出失败仍保留原请求拒绝", async () => {
    warningSpy.mockImplementation(() => { throw new Error(secret); });
    mockResponse(() => new Response("{", { status: 502 }));
    await expect(fetchDataEnvironment()).rejects.toMatchObject({ code: "INVALID_V2_RESPONSE", status: 502 });
  });

  test("合法结果和规范错误响应保持原解析且不产生日志", async () => {
    mockResponse(() => Response.json(responseFixture()));
    expect((await fetchDailyDashboard(query, ["M001"])).data.series[0].points[0].value).toBe(0);
    mockResponse(() => Response.json({ success: false, error: { code: "V2_UPSTREAM_TIMEOUT", message: "来源超时", requestId: "fixture-request" } }, { status: 504 }));
    await expect(fetchDataEnvironment()).rejects.toMatchObject({ code: "V2_UPSTREAM_TIMEOUT", status: 504, requestId: "fixture-request" });
    expect(warnings).toHaveLength(0);
  });

  for (const status of [200, 401]) test(`HTTP${status}取消后的异常JSON不产生日志`, async () => {
    let finish!: (payload: unknown) => void;
    const response = new Response("", { status });
    response.json = () => new Promise(resolve => { finish = resolve; });
    mockResponse(() => response);
    const controller = new AbortController();
    const pending = fetchDataEnvironment(controller.signal);
    await Promise.resolve();
    controller.abort();
    finish({ [secret]: secret });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(warnings).toHaveLength(0);
  });

  test("取消后的JSON解析拒绝不产生日志", async () => {
    let fail!: (error: unknown) => void;
    const response = new Response("", { status: 502 });
    response.json = () => new Promise((_resolve, reject) => { fail = reject; });
    mockResponse(() => response);
    const controller = new AbortController();
    const pending = fetchDataEnvironment(controller.signal);
    await Promise.resolve();
    controller.abort();
    fail(new SyntaxError(secret));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(warnings).toHaveLength(0);
  });

  test("401在JSON仍等待时立即通知，格式诊断不改变认证失效时序", async () => {
    const target = new EventTarget();
    Object.defineProperty(globalThis, "window", { configurable: true, value: target });
    let notifications = 0;
    target.addEventListener(V2_AUTHENTICATION_REQUIRED_EVENT, () => notifications++);
    let fail!: (error: unknown) => void;
    const response = new Response("", { status: 401 });
    response.json = () => new Promise((_resolve, reject) => { fail = reject; });
    mockResponse(() => response);
    const pending = fetchDataEnvironment();
    await Promise.resolve();
    expect(notifications).toBe(1);
    expect(warnings).toHaveLength(0);
    fail(new SyntaxError(secret));
    await expect(pending).rejects.toMatchObject({ code: "INVALID_V2_RESPONSE", status: 401 });
    expect(diagnostic()).toEqual({ status: 401, phase: "json_parse" });
    expect(notifications).toBe(1);
  });
});
