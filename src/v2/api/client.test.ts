import { afterEach, describe, expect, test } from "bun:test";
import {
  CORE_OVERVIEW_CARD_SPECS,
  type CoreOverviewQuerySuccess
} from "../../../contracts/core-overview";
import {
  M016_METRIC_ID,
  v2ApiErrorSchema,
  v2MetricQuerySuccessSchema,
  type V2MetricQuery,
  type V2MetricQuerySuccess
} from "../../../contracts/bi-v2";
import { fetchDataEnvironment, parseResponse, queryCoreOverview, queryMetric, V2RequestError } from "./client";
import * as v2Client from "./client";
import { initializeDataEnvironmentPreference, setDataEnvironmentPreference } from "./dataEnvironmentPreference";
import { V2_AUTHENTICATION_REQUIRED_EVENT } from "./authEvents";

const request: V2MetricQuery = {
  metricId: M016_METRIC_ID,
  pid: "PH",
  dateRange: ["2026-09-01", "2026-09-03"],
  grain: "day"
};

const metric = {
  id: M016_METRIC_ID,
  code: "daily_active_user_count" as const,
  name: "日活跃用户数" as const,
  definition: "当天打开并登录产品的去重用户数",
  unit: "人" as const,
  valueType: "integer" as const,
  authority: {
    document: "全站指标体系.md" as const,
    version: "v0.23-draft",
    validationStatus: "pending_validation" as const,
    statusLabel: "技术称已实现（待验数）" as const
  },
  capabilities: {
    grains: ["day"] as ["day"],
    platformMode: "single_pid" as const,
    dimensions: [] as [],
    filters: [] as [],
    comparisons: [] as []
  }
};

function validResponse(): V2MetricQuerySuccess {
  return {
    success: true as const,
    data: {
      metric,
      scope: { pid: "PH", platformName: "Pornhub" },
      grain: "day" as const,
      dateRange: ["2026-09-01", "2026-09-03"] as [string, string],
      seriesStatus: "partial" as const,
      points: [
        { businessDate: "2026-09-01", value: 0, state: "available" as const },
        { businessDate: "2026-09-02", value: 101, state: "available" as const }
      ],
      unavailableDates: [{ businessDate: "2026-09-03", state: "no_record" as const }]
    },
    meta: {
      queryId: "query-test",
      sourceApiIds: ["P_DAY_SUM"],
      fetchedAt: "2026-09-08T00:00:00.000Z",
      mappingVersion: "m016-pday-sum-v1",
      validationStatus: "pending_validation" as const,
      watermark: null,
      warnings: ["仍待验数"]
    }
  };
}

function validWatermark() {
  return {
    type: "complete_through_business_date" as const,
    completeThrough: "2026-09-03",
    timeZone: "Asia/Shanghai" as const,
    pid: "PH",
    sourceApiId: "/api/admin/statistics/pDaySum",
    sourceKind: "upstream_explicit" as const,
    observedAt: "2026-09-04T00:10:00+08:00"
  };
}

function validFormalResponse(): V2MetricQuerySuccess {
  const response = validResponse();
  response.data.metric = {
    ...response.data.metric,
    authority: {
      ...response.data.metric.authority,
      validationStatus: "passed",
      statusLabel: "真实验数已通过"
    }
  };
  response.meta.validationStatus = "passed";
  response.meta.watermark = validWatermark();
  response.meta.sourceApiIds = ["/api/admin/statistics/pDaySum"];
  return response;
}

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
  setDataEnvironmentPreference("production");
});

function authenticationNotifications() {
  const target = new EventTarget();
  let count = 0;
  Object.defineProperty(globalThis, "window", { configurable: true, value: target });
  target.addEventListener(V2_AUTHENTICATION_REQUIRED_EVENT, () => count++);
  return () => count;
}
const authenticationProblem = { success: false, error: { code: "AUTHENTICATION_REQUIRED", message: "需要登录", requestId: "in-memory-auth" } };
const productionEnvironment = { success: true, data: { mode: "production", testAvailable: true, expiresAt: null, userName: null } };

describe("V2安全请求诊断", () => {
  const rejection = { code: "QUERY_JOB_UPSTREAM_REJECTED", message: "固定拒绝提示", requestId: "qa-job-rejected" };

  test("解析保留BI HTTP400与上游HTTP200及业务400的独立含义", async () => {
    const response = Response.json({ success: false, error: { ...rejection, upstreamBusinessCode: 400, upstreamHttpStatus: 200 } }, { status: 400 });
    const failure = await parseResponse(response, v2MetricQuerySuccessSchema).catch(error => error);
    expect(failure).toBeInstanceOf(V2RequestError);
    expect(failure).toMatchObject({ status: 400, code: rejection.code, requestId: rejection.requestId, upstreamBusinessCode: 400, upstreamHttpStatus: 200 });
  });

  test("缺省诊断不从BI状态或错误文本制造上游数值", async () => {
    const response = Response.json({ success: false, error: { ...rejection, message: "HTTP200 code400" } }, { status: 400 });
    const failure = await parseResponse(response, v2MetricQuerySuccessSchema).catch(error => error);
    expect(failure.upstreamBusinessCode).toBeUndefined();
    expect(failure.upstreamHttpStatus).toBeUndefined();
    expect(v2Client.readV2RequestDiagnostics(failure)).toEqual({ code: rejection.code, requestId: rejection.requestId });
  });

  test("非法数值类型或范围使整个错误响应失败关闭", async () => {
    for (const invalid of [
      { upstreamBusinessCode: "400" }, { upstreamBusinessCode: 400.5 }, { upstreamBusinessCode: null },
      { upstreamHttpStatus: "200" }, { upstreamHttpStatus: 200.5 }, { upstreamHttpStatus: 99 }, { upstreamHttpStatus: 600 }, { upstreamHttpStatus: null }
    ]) {
      const failure = await parseResponse(Response.json({ success: false, error: { ...rejection, ...invalid } }, { status: 400 }), v2MetricQuerySuccessSchema).catch(error => error);
      expect(failure).toMatchObject({ code: "INVALID_V2_RESPONSE", status: 400 });
      expect(failure.upstreamBusinessCode).toBeUndefined();
      expect(failure.upstreamHttpStatus).toBeUndefined();
    }
  });

  test("白名单仅返回四项诊断，保留合法0业务码和HTTP边界且不改写来源", () => {
    for (const upstreamHttpStatus of [100, 200, 599]) {
      const source = Object.freeze({ code: rejection.code, requestId: rejection.requestId, upstreamBusinessCode: 0, upstreamHttpStatus,
        message: "fake-secret-error-message", token: "fake-secret-token", status: 400, extra: "ignored" });
      expect(v2Client.readV2RequestDiagnostics(source)).toEqual({ code: rejection.code, requestId: rejection.requestId, upstreamBusinessCode: 0, upstreamHttpStatus });
      expect(source.message).toBe("fake-secret-error-message");
    }
  });

  test("白名单不转型，不接空字符串、非有限整数或非法HTTP状态", () => {
    for (const value of [undefined, null, "400", "", true, {}, [], new Number(400), NaN, Infinity, -Infinity, 400.5]) {
      expect(v2Client.readV2RequestDiagnostics({ upstreamBusinessCode: value, upstreamHttpStatus: value })).toEqual({});
    }
    for (const value of [0, 99, 600, -200]) expect(v2Client.readV2RequestDiagnostics({ upstreamHttpStatus: value })).toEqual({});
    for (const value of [undefined, null, "", " \n\t ", 400, true, {}, []]) {
      expect(v2Client.readV2RequestDiagnostics({ code: value, requestId: value, message: "ignored" })).toEqual({});
    }
    for (const value of [undefined, null, "error", 400, true, []]) expect(v2Client.readV2RequestDiagnostics(value)).toEqual({});
    expect(v2Client.readV2RequestDiagnostics({ code: "QUERY_JOB_UPSTREAM_REJECTED", upstreamBusinessCode: 400, upstreamHttpStatus: "200" }))
      .toEqual({ code: "QUERY_JOB_UPSTREAM_REJECTED", upstreamBusinessCode: 400 });
  });
});

describe("V2读取取消边界", () => {
  test("响应刚兑现后取消不发送全局认证失效事件", async () => {
    const notifications = authenticationNotifications();
    globalThis.fetch = async () => Response.json(authenticationProblem, { status: 401 });
    const controller = new AbortController();
    const pending = fetchDataEnvironment(controller.signal);
    controller.abort();
    const failure = await pending.catch(error => error);
    expect(notifications()).toBe(0);
    expect(failure.name).toBe("AbortError");
  });

  for (const status of [200, 401]) test(`HTTP${status}的JSON读取过程中取消保留取消结果`, async () => {
    const notifications = authenticationNotifications();
    let finish!: (value: unknown) => void;
    let reading = false;
    const response = new Response("", { status });
    response.json = () => { reading = true; return new Promise(resolve => { finish = resolve; }); };
    globalThis.fetch = async () => response;
    const controller = new AbortController();
    const pending = fetchDataEnvironment(controller.signal);
    await Promise.resolve();
    expect(reading).toBe(true);
    controller.abort();
    finish(status === 401 ? authenticationProblem : productionEnvironment);
    const failure = await pending.catch(error => error);
    expect(notifications()).toBe(status === 401 ? 1 : 0);
    expect(failure.name).toBe("AbortError");
  });

  test("未取消401的JSON仍在等待时立即通知，完成后保持失败关闭", async () => {
    const notifications = authenticationNotifications();
    let finish!: (value: unknown) => void;
    const response = new Response("", { status: 401 });
    response.json = () => new Promise(resolve => { finish = resolve; });
    globalThis.fetch = async () => response;
    const pending = fetchDataEnvironment();
    await Promise.resolve();
    const notificationsWhilePending = notifications();
    finish(authenticationProblem);
    await expect(pending).rejects.toMatchObject({ status: 401, code: "AUTHENTICATION_REQUIRED" });
    expect(notificationsWhilePending).toBe(1);
    expect(notifications()).toBe(1);
  });

  test("JSON读取拒绝时已取消的请求不归为响应结构错误", async () => {
    let fail!: (error: unknown) => void;
    const response = new Response("", { status: 200 });
    response.json = () => new Promise((_resolve, reject) => { fail = reject; });
    globalThis.fetch = async () => response;
    const controller = new AbortController();
    const pending = fetchDataEnvironment(controller.signal);
    await Promise.resolve();
    controller.abort();
    fail(new SyntaxError("in-memory invalid JSON"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  for (const validBody of [true, false]) test(`未取消的401${validBody ? "合法" : "异常"}响应继续通知并失败关闭`, async () => {
    const notifications = authenticationNotifications();
    globalThis.fetch = async () => validBody ? Response.json(authenticationProblem, { status: 401 }) : new Response("{", { status: 401 });
    await expect(fetchDataEnvironment()).rejects.toMatchObject({ status: 401, code: validBody ? "AUTHENTICATION_REQUIRED" : "INVALID_V2_RESPONSE" });
    expect(notifications()).toBe(1);
  });

  test("正常403与结构错误保持原分类且不发送认证失效事件", async () => {
    const notifications = authenticationNotifications();
    globalThis.fetch = async () => Response.json({ success: false, error: { code: "BI_READ_ACCESS_DENIED", message: "无读取权限", requestId: "in-memory-denied" } }, { status: 403 });
    await expect(fetchDataEnvironment()).rejects.toMatchObject({ status: 403, code: "BI_READ_ACCESS_DENIED", kind: "forbidden", requestId: "in-memory-denied" });
    globalThis.fetch = async () => Response.json({ success: true, data: { mode: "unexpected" } });
    await expect(fetchDataEnvironment()).rejects.toMatchObject({ status: 200, code: "INVALID_V2_RESPONSE" });
    expect(notifications()).toBe(0);
  });
});

describe("V2 运行时响应契约", () => {
  test("接受逐日完整覆盖，并保留真实 0 与无记录", () => {
    expect(v2MetricQuerySuccessSchema.safeParse(validResponse()).success).toBe(true);
  });

  test("已验数正式响应只接受覆盖当前 PID 与日期范围的接口水位", () => {
    const response = validFormalResponse();
    expect(v2MetricQuerySuccessSchema.safeParse(response).success).toBe(true);

    for (const mutate of [
      (candidate: ReturnType<typeof validResponse>) => { candidate.meta.watermark = null; },
      (candidate: ReturnType<typeof validResponse>) => { candidate.meta.watermark = { ...validWatermark(), pid: "TT" }; },
      (candidate: ReturnType<typeof validResponse>) => { candidate.meta.sourceApiIds = ["/api/admin/statistics/other"]; },
      (candidate: ReturnType<typeof validResponse>) => { candidate.meta.watermark = { ...validWatermark(), completeThrough: "2026-09-02", observedAt: "2026-09-03T00:10:00+08:00" }; },
      (candidate: ReturnType<typeof validResponse>) => { candidate.meta.watermark = { ...validWatermark(), timeZone: "UTC" as "Asia/Shanghai" }; }
    ]) {
      const candidate = structuredClone(response);
      mutate(candidate);
      expect(v2MetricQuerySuccessSchema.safeParse(candidate).success).toBe(false);
    }
  });

  test("水位拒绝未知字段、过早取证和明显晚于查询完成时间", () => {
    const unknownField = validFormalResponse();
    unknownField.meta.watermark = {
      ...validWatermark(),
      inferredFromMaxDate: true
    } as ReturnType<typeof validWatermark>;
    expect(v2MetricQuerySuccessSchema.safeParse(unknownField).success).toBe(false);

    const observedBeforeDayEnd = validFormalResponse();
    observedBeforeDayEnd.meta.watermark = {
      ...validWatermark(),
      observedAt: "2026-09-03T23:59:59+08:00"
    };
    expect(v2MetricQuerySuccessSchema.safeParse(observedBeforeDayEnd).success).toBe(false);

    const observedAfterFetch = validFormalResponse();
    observedAfterFetch.meta.watermark = {
      ...validWatermark(),
      observedAt: "2026-09-08T00:06:00Z"
    };
    expect(v2MetricQuerySuccessSchema.safeParse(observedAfterFetch).success).toBe(false);
  });

  test("拒绝日期缺口、重复日期、负数及状态不一致", () => {
    const missing = validResponse();
    missing.data.points.splice(1, 1);
    expect(v2MetricQuerySuccessSchema.safeParse(missing).success).toBe(false);

    const duplicate = validResponse();
    duplicate.data.unavailableDates[0].businessDate = "2026-09-02";
    expect(v2MetricQuerySuccessSchema.safeParse(duplicate).success).toBe(false);

    const negative = validResponse();
    negative.data.points[0].value = -1;
    expect(v2MetricQuerySuccessSchema.safeParse(negative).success).toBe(false);

    const inconsistent = validResponse();
    inconsistent.data.seriesStatus = "available" as "partial";
    expect(v2MetricQuerySuccessSchema.safeParse(inconsistent).success).toBe(false);
  });

  test("错误响应必须使用闭合错误码并携带非空 requestId", () => {
    expect(v2ApiErrorSchema.safeParse({
      success: false,
      error: { code: "IDENTITY_PROVIDER_UNAVAILABLE", message: "暂不可用", requestId: "req-1" }
    }).success).toBe(true);
    expect(v2ApiErrorSchema.safeParse({
      success: false,
      error: { code: "UNKNOWN", message: "暂不可用", requestId: "" }
    }).success).toBe(false);
  });
});

describe("V2 客户端回显校验", () => {
  test("所有 V2 查询显式携带当前数据环境且浏览器不保存测试 Token", async () => {
    let environmentHeader: string | null = null;
    initializeDataEnvironmentPreference("client-test-user");
    setDataEnvironmentPreference("test");
    globalThis.fetch = (async (_input, init) => {
      environmentHeader = new Headers(init?.headers).get("x-ypbi-data-environment");
      return new Response(JSON.stringify({ success: true, data: { mode: "test", testAvailable: true, expiresAt: "2026-09-08T01:00:00.000Z", userName: "test-user" } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    await fetchDataEnvironment();

    expect(environmentHeader).toBe("test");
  });

  test("拒绝与原请求 PID 不一致的查询响应", async () => {
    const response = validResponse();
    response.data.scope.pid = "XH";
    globalThis.fetch = async () => new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" }
    });

    try {
      await queryMetric(request);
      throw new Error("expected queryMetric to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(V2RequestError);
      expect((error as V2RequestError).code).toBe("INVALID_V2_QUERY_RESPONSE");
    }
  });

  test("解析合法错误响应并保留 requestId", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      success: false,
      error: { code: "V2_UPSTREAM_TIMEOUT", message: "指标数据源响应超时", requestId: "req-timeout" }
    }), {
      status: 504,
      headers: { "content-type": "application/json" }
    });

    try {
      await queryMetric(request);
      throw new Error("expected queryMetric to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(V2RequestError);
      expect((error as V2RequestError).requestId).toBe("req-timeout");
    }
  });
});

function coreOverviewTrustedPartialResponse(): CoreOverviewQuerySuccess {
  const metricIds = ["M016", "M020"] as const;
  return {
    success: true,
    data: {
      dashboard: { id: "core-overview", contractVersion: "core-overview/v1" },
      requestedScope: { kind: "pids", pids: ["PH", "TT"] },
      requestedMetricIds: [...metricIds],
      period: {
        mode: "latest_complete",
        grain: "day",
        timeZone: "Asia/Shanghai",
        currentRange: ["2026-09-01", "2026-09-07"],
        comparisonRange: ["2026-08-25", "2026-08-31"],
        commonCompleteThrough: "2026-09-07"
      },
      scopeResults: ["PH", "TT"].map((pid) => ({
        scope: { kind: "pid" as const, pid },
        cards: metricIds.map((metricId) => ({
          ...CORE_OVERVIEW_CARD_SPECS.find((candidate) => candidate.metricId === metricId)!,
          result: metricId === "M016"
            ? {
                status: "no_records" as const,
                message: "可信水位内没有业务记录",
                retryable: false,
                provenance: {
                  authorityVersion: "v-test",
                  mappingVersion: "mapping-test",
                  validationStatus: "passed" as const,
                  sourceIds: ["service:core-overview-client-test"],
                  fetchedAt: "2026-09-08T00:05:00+08:00",
                  watermark: {
                    type: "complete_through_business_date" as const,
                    completeThrough: "2026-09-07",
                    timeZone: "Asia/Shanghai" as const,
                    scope: { kind: "pid" as const, pid },
                    evidence: [{
                      sourceId: "service:core-overview-client-test",
                      sourceKind: "upstream_completion_api" as const,
                      observedAt: "2026-09-08T00:01:00+08:00"
                    }]
                  }
                }
              }
            : {
                status: "not_ready" as const,
                reasonCode: "validation_not_passed",
                message: "当前映射或验数尚未完成",
                retryable: false
              }
        }))
      }))
    },
    meta: {
      queryId: "core-overview-client-test",
      fetchedAt: "2026-09-08T00:05:00+08:00",
      partial: true,
      warnings: []
    }
  };
}

describe("核心经营总览客户端契约", () => {
  test("发送固定顺序的指标子集，并接受服务端按目录归一后的逐 PID 结果", async () => {
    let sentBody: unknown;
    globalThis.fetch = async (_input, init) => {
      sentBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(coreOverviewTrustedPartialResponse()), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    const result = await queryCoreOverview({
      scope: { kind: "pids", pids: ["TT", "PH"] },
      metricIds: ["M020", "M016"]
    });
    expect(sentBody).toMatchObject({ metricIds: ["M016", "M020"] });
    expect(result.data.scopeResults.map((item) => item.scope)).toEqual([
      { kind: "pid", pid: "PH" },
      { kind: "pid", pid: "TT" }
    ]);
  });

  test("本地拒绝重复 PID，且不会发出网络请求", async () => {
    let fetchCount = 0;
    globalThis.fetch = async () => {
      fetchCount += 1;
      throw new Error("must not fetch");
    };
    await expect(queryCoreOverview({
      scope: { kind: "pids", pids: ["PH", "PH"] }
    })).rejects.toMatchObject({ code: "INVALID_CORE_OVERVIEW_QUERY", status: 400 });
    expect(fetchCount).toBe(0);
  });

  test("拒绝被压缩成跨 PID 合计或缺卡的成功响应", async () => {
    const collapsed = coreOverviewTrustedPartialResponse();
    collapsed.data.scopeResults.splice(1, 1);
    globalThis.fetch = async () => new Response(JSON.stringify(collapsed), {
      status: 200,
      headers: { "content-type": "application/json" }
    });

    await expect(queryCoreOverview({
      scope: { kind: "pids", pids: ["PH", "TT"] },
      metricIds: ["M016", "M020"]
    })).rejects.toMatchObject({ code: "INVALID_V2_RESPONSE" });
  });

  test("拒绝全卡未就绪的假成功，服务端 422 则保留既有未就绪语义", async () => {
    const fakeSuccess = coreOverviewTrustedPartialResponse();
    fakeSuccess.data.scopeResults.forEach((scopeResult) => {
      scopeResult.cards = scopeResult.cards.map((card) => ({
        ...card,
        result: {
          status: "not_ready" as const,
          reasonCode: "NO_TRUSTED_WATERMARK",
          message: "没有可信水位",
          retryable: false
        }
      }));
    });
    globalThis.fetch = async () => new Response(JSON.stringify(fakeSuccess), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
    await expect(queryCoreOverview({
      scope: { kind: "pids", pids: ["PH", "TT"] },
      metricIds: ["M016", "M020"]
    })).rejects.toMatchObject({ code: "INVALID_V2_RESPONSE" });

    globalThis.fetch = async () => new Response(JSON.stringify({
      success: false,
      error: { code: "METRIC_NOT_READY", message: "暂无共同可信水位", requestId: "req-core-not-ready" }
    }), {
      status: 422,
      headers: { "content-type": "application/json" }
    });
    await expect(queryCoreOverview({
      scope: { kind: "pids", pids: ["PH", "TT"] },
      metricIds: ["M016", "M020"]
    })).rejects.toMatchObject({
      code: "METRIC_NOT_READY",
      status: 422,
      requestId: "req-core-not-ready"
    });
  });
});
