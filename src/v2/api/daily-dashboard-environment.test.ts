import { afterEach, describe, expect, test } from "bun:test";
import { dailyDashboardSuccessSchema, type DailyDashboardQuery, type DailyDashboardSuccess } from "../../../contracts/daily-dashboard";
import { fetchDailyDashboard } from "./client";
import { dailyDashboardEnvironment, dataEnvironmentLabel, recordDailyDashboardEnvironment } from "./daily-dashboard-environment";
import { currentDataEnvironmentPreference, setDataEnvironmentPreference } from "./dataEnvironmentPreference";

const originalFetch = globalThis.fetch;
const originalPreference = currentDataEnvironmentPreference();
const query: DailyDashboardQuery = { boardId: "5.7", pid: "PH", dateRange: ["2020-01-01", "2020-01-01"] };
function responseFixture(): DailyDashboardSuccess {
  return { success: true, data: { schemaVersion: "day-dashboard/v1", query: structuredClone(query), queryId: "environment-fixture",
    fetchedAt: "2026-10-12T04:00:00.000Z", timezone: "Asia/Shanghai", validationStatus: "pending_validation",
    completeness: "unknown", watermark: null, sourceApiIds: ["/api/admin/statistics/pDaySum"],
    series: [{ metric: { id: "M001", name: "落地页访问次数", unit: "次", definition: "有效页面浏览次数", authorityVersion: "fixture",
      formula: null, referenceMetricId: "M001", sourceNote: null, inputs: [{ key: "totalVistCount", name: "落地页访问次数", unit: "次" }] },
      points: [{ date: query.dateRange[0], state: "available", value: 0, inputs: [{ key: "totalVistCount", value: 0 }] }] }] } };
}
const jsonResponse = (payload = responseFixture()) => new Response(JSON.stringify(payload), {
  status: 200, headers: { "content-type": "application/json" }
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setDataEnvironmentPreference(originalPreference);
});

describe("日看板请求环境快照", () => {
  test("实际测试请求延迟返回时，切回正式偏好不会改写结果环境", async () => {
    setDataEnvironmentPreference("test");
    let observedHeaders: Headers | undefined;
    let observedBody: unknown;
    let resolveResponse!: (response: Response) => void;
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe("/api/bi/v2/queries/dashboards/daily-reading");
      expect(init?.method).toBe("POST");
      observedHeaders = new Headers(init?.headers);
      observedBody = JSON.parse(String(init?.body));
      return new Promise<Response>(resolve => { resolveResponse = resolve; });
    }) as typeof fetch;

    const pending = fetchDailyDashboard(query, ["M001"]);
    await Promise.resolve();
    expect(observedHeaders?.get("x-ypbi-data-environment")).toBe("test");
    expect(observedBody).toEqual(query);
    setDataEnvironmentPreference("production");
    resolveResponse(jsonResponse());
    const result = await pending;

    expect(currentDataEnvironmentPreference()).toBe("production");
    expect(dailyDashboardEnvironment(result)).toBe("test");
    expect(dataEnvironmentLabel(dailyDashboardEnvironment(result))).toBe("测试数据");
    expect(result.data.series[0].points[0].value).toBe(0);
  });

  test("正式请求快照来自实际请求头，之后切到测试偏好仍保持正式", async () => {
    setDataEnvironmentPreference("production");
    let observedHeaders: Headers | undefined;
    globalThis.fetch = (async (_input, init) => {
      observedHeaders = new Headers(init?.headers);
      setDataEnvironmentPreference("test");
      return jsonResponse();
    }) as typeof fetch;
    const result = await fetchDailyDashboard(query, ["M001"]);
    expect(observedHeaders?.get("x-ypbi-data-environment")).toBe("production");
    expect(currentDataEnvironmentPreference()).toBe("test");
    expect(dailyDashboardEnvironment(result)).toBe("production");
    expect(dataEnvironmentLabel(dailyDashboardEnvironment(result))).toBe("正式数据");
  });

  test("不同环境的排队请求绑定各自入队时的环境，后续偏好不改写来源", async () => {
    const pending: Array<{ environment: string | null; resolve: (response: Response) => void }> = [];
    globalThis.fetch = (async (_input, init) => new Promise<Response>(resolve => {
      pending.push({ environment: new Headers(init?.headers).get("x-ypbi-data-environment"), resolve });
    })) as typeof fetch;
    setDataEnvironmentPreference("test");
    const testRequest = fetchDailyDashboard(query, ["M001"]);
    setDataEnvironmentPreference("production");
    const productionRequest = fetchDailyDashboard(query, ["M001"]);
    await Promise.resolve();
    expect(pending.map(request => request.environment)).toEqual(["test"]);
    setDataEnvironmentPreference("test");
    pending[0].resolve(jsonResponse());
    const testResult = await testRequest;
    await Promise.resolve();
    expect(pending.map(request => request.environment)).toEqual(["test", "production"]);
    pending[1].resolve(jsonResponse());
    const production = await productionRequest;
    expect(dailyDashboardEnvironment(production)).toBe("production");
    expect(dailyDashboardEnvironment(testResult)).toBe("test");
    expect(production).not.toBe(testResult);
  });

  test("只有严格契约和原查询校验通过的结果能成为可导出快照", async () => {
    setDataEnvironmentPreference("test");
    const invalid = responseFixture();
    invalid.data.query.pid = "OTHER";
    globalThis.fetch = (async () => jsonResponse(invalid)) as typeof fetch;
    await expect(fetchDailyDashboard(query, ["M001"])).rejects.toMatchObject({ code: "INVALID_V2_RESPONSE" });
    expect(dailyDashboardEnvironment(invalid)).toBeUndefined();
    globalThis.fetch = (async () => jsonResponse()) as typeof fetch;
    await expect(fetchDailyDashboard(query, ["M003"])).rejects.toMatchObject({ code: "INVALID_V2_RESPONSE" });
  });
});

describe("环境来源仅作私有元数据", () => {
  test("未知、缺失和序列化副本均不默认正式，也不从当前偏好推断", () => {
    setDataEnvironmentPreference("production");
    const unknown = responseFixture();
    expect(dailyDashboardEnvironment(unknown)).toBeUndefined();
    expect(dailyDashboardEnvironment(null)).toBeUndefined();
    expect(dailyDashboardEnvironment(undefined)).toBeUndefined();
    expect(dataEnvironmentLabel(dailyDashboardEnvironment(unknown))).toBe("环境未确认");
    recordDailyDashboardEnvironment(unknown, "test");
    expect(dailyDashboardEnvironment(unknown)).toBe("test");
    expect(dailyDashboardEnvironment(structuredClone(unknown))).toBeUndefined();
    expect(dataEnvironmentLabel(dailyDashboardEnvironment(JSON.parse(JSON.stringify(unknown))))).toBe("环境未确认");
  });

  test("WeakMap不向公共响应增加环境或认证字段，冻结结果仍能记录快照", () => {
    const result = responseFixture(), serialized = JSON.stringify(result);
    Object.freeze(result);
    expect(recordDailyDashboardEnvironment(result, "test")).toBe(result);
    expect(dailyDashboardEnvironment(result)).toBe("test");
    expect(JSON.stringify(result)).toBe(serialized);
    expect(Reflect.ownKeys(result)).toEqual(["success", "data"]);
    expect(dailyDashboardSuccessSchema.safeParse(result).success).toBe(true);
    expect(dailyDashboardSuccessSchema.safeParse({ ...result, dataEnvironment: "test" }).success).toBe(false);
    expect(dailyDashboardSuccessSchema.safeParse({ ...result, data: { ...result.data, dataEnvironment: "test" } }).success).toBe(false);
    expect(serialized).not.toMatch(/(?:authorization|cookie|token|password|credential)/i);
  });
});
