import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { BI_V1_PLAYBACK_API } from "../upstream/bi-v1.adapter";
import { BI_V1_METRICS_API } from "../upstream/bi-v1.metrics-adapter";
import { UpstreamError, type UpstreamClient } from "../upstream/client";
import { createOperatingEvidenceCollector, OPERATING_EVIDENCE_MAX_BYTES, OPERATING_EVIDENCE_MAX_CALLS, OPERATING_EVIDENCE_MAX_ROWS_PER_CALL, type OperatingEvidenceBusinessRow } from "./operating-evidence-collector";

const params = () => ({ pid: "PH", startDate: "2026-10-05", endDate: "2026-10-13", granularity: "day", metricCodes: "M016", includeIncomplete: "true" });
const row = (extra: Record<string, unknown> = {}) => ({ metricCode: "M016", businessDate: "2026-10-12", dimensions: { pid: "PH" },
  value: null, numerator: 0, denominator: 0, unit: "count", dataStatus: "PROCESSING", metricVersion: "bi-v1", ruleVersion: "daily-active-v1", ...extra });
const envelope = (rows: unknown[] = [row()], extra: Record<string, unknown> = {}) => ({ code: 200,
  msg: { metricVersion: "bi-v1", generatedAt: "2026-10-15T08:00:00+08:00", watermark: "2026-10-12", rows }, ...extra });
async function capture(payload: unknown, request: Record<string, string> = params(), options: Parameters<typeof createOperatingEvidenceCollector>[1] = {}) {
  const collector = createOperatingEvidenceCollector({ get: async () => payload }, options);
  const actual = await collector.client.get(BI_V1_METRICS_API, request);
  return { collector, actual, snapshot: collector.finish(), response: collector.finish().calls[0].response! };
}
const business = (value: unknown) => value as OperatingEvidenceBusinessRow;

describe("operating evidence private collector", () => {
  test("payload对象、参数、Token及AbortSignal原样透传，不修改或冻结原始业务值", async () => {
    const payload = envelope(), request = params(), controller = new AbortController();
    const before = JSON.stringify(payload);
    let received: Parameters<UpstreamClient["get"]> | undefined;
    const collector = createOperatingEvidenceCollector({ get: async (...args) => { received = args; return payload; } });
    expect(await collector.client.get(BI_V1_METRICS_API, request, "not-exported-token", controller.signal)).toBe(payload);
    collector.finish();
    expect(received).toEqual([BI_V1_METRICS_API, request, "not-exported-token", controller.signal]);
    expect(received?.[1]).toBe(request);
    expect(JSON.stringify(payload)).toBe(before);
    expect(Object.isFrozen(payload)).toBe(false);
    expect(Object.isFrozen(payload.msg.rows[0])).toBe(false);
  });

  test("只采集metrics与playback，其他来源get保持成功透传", async () => {
    const payload = envelope();
    const collector = createOperatingEvidenceCollector({ get: async () => payload });
    expect(await collector.client.get("/api/admin/statistics/pDaySum", params())).toBe(payload);
    await collector.client.get(BI_V1_PLAYBACK_API, { ...params(), metricCodes: "M034,M036,M097", dimensions: "videoType" });
    const snapshot = collector.finish();
    expect(snapshot.calls).toHaveLength(1);
    expect(snapshot.calls[0]).toMatchObject({ source: "playback", path: BI_V1_PLAYBACK_API, sequence: 1,
      transportEvidence: "client_business_projection", httpStatus: null, cacheHit: null, state: "fulfilled" });
  });

  test("缺日期范围行与目标日行分别保留，顺序及重复行不合并", async () => {
    const undated = row(); delete (undated as Partial<typeof undated>).businessDate;
    const { response } = await capture(envelope([undated, row(), row()]));
    expect(response.rowCount).toBe(3);
    expect(response.rows.map(item => business(item).dateScope)).toEqual(["undated", "dated", "dated"]);
    expect(response.rows.map(item => item.rowIndex)).toEqual([0, 1, 2]);
    expect(business(response.rows[0])).not.toHaveProperty("businessDate");
    expect(business(response.rows[0]).fieldState.businessDate).toEqual({ state: "missing", kind: "missing" });
    expect(business(response.rows[1]).businessDate).toBe("2026-10-12");
  });

  test("月活summary保留真实自然月范围和缺日期行，不补每日日期", async () => {
    const summary = row({ metricCode: "M018" }); delete (summary as Partial<typeof summary>).businessDate;
    const { response, snapshot } = await capture(envelope([summary]), { ...params(), startDate: "2026-10-01", endDate: "2026-10-15", granularity: "summary", metricCodes: "M018" });
    expect(snapshot.calls[0].params).toMatchObject({ startDate: "2026-10-01", endDate: "2026-10-15", granularity: "summary" });
    expect(response.rows[0]).toMatchObject({ scope: "in_scope", dateScope: "undated", metricCode: "M018" });
  });

  test("null、非法字符串、非法类型与缺失日期分别保留固定类型诊断", async () => {
    const missing = row(); delete (missing as Partial<typeof missing>).businessDate;
    const { response } = await capture(envelope([row({ businessDate: null }), row({ businessDate: "private-date" }), row({ businessDate: 123 }), missing]));
    expect(response.rows[0]).toMatchObject({ scope: "scope_conflict", reason: "date_invalid", identityState: { businessDate: { state: "null", kind: "null" } } });
    expect(response.rows[1]).toMatchObject({ reason: "date_invalid", identityState: { businessDate: { state: "invalid", kind: "string", sha256: expect.any(String) } } });
    expect(response.rows[2]).toMatchObject({ reason: "date_invalid", identityState: { businessDate: { kind: "number" } } });
    expect(response.rows[3]).toMatchObject({ scope: "in_scope", dateScope: "undated" });
    expect(JSON.stringify(response)).not.toContain("private-date");
  });

  test("其他PID行不输出PID、数值、状态或hash，只保留固定冲突分类", async () => {
    const { response } = await capture(envelope([row({ dimensions: { pid: "OTHER_PRIVATE_PID" }, value: 987654321 })]));
    expect(response.rows).toEqual([{ rowIndex: 0, scope: "scope_conflict", reason: "pid_mismatch" }]);
    expect(JSON.stringify(response)).not.toContain("OTHER_PRIVATE_PID");
    expect(JSON.stringify(response)).not.toContain("987654321");
  });

  test("startDate包含、endDate不包含，越界行不返回业务值", async () => {
    const { response } = await capture(envelope([row({ businessDate: "2026-10-05", value: 1 }), row({ businessDate: "2026-10-13", value: 2 }), row({ businessDate: "2026-10-04", value: 3 })]));
    expect(response.rows[0]).toMatchObject({ scope: "in_scope", value: 1 });
    expect(response.rows.slice(1)).toEqual([{ rowIndex: 1, scope: "scope_conflict", reason: "date_out_of_range" }, { rowIndex: 2, scope: "scope_conflict", reason: "date_out_of_range" }]);
  });

  test("缺失/非法PID只返回固定identityState，业务字段不泄漏", async () => {
    const { response } = await capture(envelope([row({ dimensions: {} }), row({ dimensions: { pid: "private pid!" } }), row({ dimensions: { pid: null } })]));
    expect(response.rows[0]).toMatchObject({ reason: "pid_missing", identityState: { pid: { state: "missing" } } });
    expect(response.rows[1]).toMatchObject({ reason: "pid_invalid", identityState: { pid: { kind: "string", sha256: expect.any(String) } } });
    expect(response.rows[2]).toMatchObject({ reason: "pid_invalid", identityState: { pid: { kind: "null" } } });
    for (const item of response.rows) expect(item).not.toHaveProperty("value");
    expect(JSON.stringify(response)).not.toContain("private pid!");
  });

  test("无合法请求PID或日期范围时整行保持关闭", async () => {
    for (const request of [{ ...params(), pid: "private pid" }, { ...params(), startDate: "2026-10-13" }, { ...params(), endDate: "not-a-date" }]) {
      const { response } = await capture(envelope(), request);
      expect(response.rows).toEqual([{ rowIndex: 0, scope: "scope_conflict", reason: "request_scope_invalid" }]);
    }
  });

  test("metricCode缺失、非法和已登记但未请求时不输出值", async () => {
    const missing = row(); delete (missing as Partial<typeof missing>).metricCode;
    const { response } = await capture(envelope([missing, row({ metricCode: "private metric" }), row({ metricCode: "M018" })]));
    expect(response.rows.map(item => "reason" in item ? item.reason : "")).toEqual(["metric_code_missing", "metric_code_invalid", "metric_code_out_of_scope"]);
    expect(JSON.stringify(response)).not.toContain("private metric");
    for (const item of response.rows) expect(item).not.toHaveProperty("value");
  });

  test("row不是对象时只记录类型，不回显原始内容", async () => {
    const { response } = await capture(envelope([null, "private-row", ["private-array"], 9]));
    expect(response.rows.map(item => "identityState" in item ? item.identityState?.row?.kind : "")).toEqual(["null", "string", "array", "number"]);
    expect(JSON.stringify(response)).not.toContain("private-row");
    expect(JSON.stringify(response)).not.toContain("private-array");
  });

  test("未知envelope/msg/row/dimension字段不返回名称或值，保留省略数量", async () => {
    const payload = envelope([row({ privateRowKey: "private-row-value", dimensions: { pid: "PH", privateDimensionKey: "private-dimension-value" } })], { err: "private-err", privateEnvelopeKey: "private-envelope-value" });
    Object.assign(payload.msg, { privateMessageKey: "private-msg-value" });
    const { response } = await capture(payload);
    expect(response.omittedFieldCount).toBe(2);
    expect(response.omittedMsgFieldCount).toBe(1);
    expect(business(response.rows[0]).omittedFieldCount).toBe(1);
    expect(business(response.rows[0]).dimensions.omittedFieldCount).toBe(1);
    const serialized = JSON.stringify(response);
    for (const text of ["private", '"err"']) expect(serialized).not.toContain(text);
  });

  test("标准维度合法值保留，未知值仅返回固定字段状态及hash", async () => {
    const { response } = await capture(envelope([row({ dimensions: { pid: "PH", clientPlatform: "android", userCohort: "old", sourceType: "internal_channel", paymentMethod: "ali_pay", videoType: "long_video" } }),
      row({ dimensions: { pid: "PH", clientPlatform: "private-platform", userCohort: "private-cohort", sourceType: { private: true }, paymentMethod: ["private"], videoType: "private-video" } })]));
    expect(business(response.rows[0]).dimensions).toMatchObject({ pid: "PH", clientPlatform: "android", userCohort: "old", sourceType: "internal_channel", paymentMethod: "ali_pay", videoType: "long_video" });
    expect(business(response.rows[1]).dimensions).not.toHaveProperty("clientPlatform");
    expect(business(response.rows[1]).dimensions.fieldState.videoType).toMatchObject({ state: "invalid", kind: "string", sha256: expect.any(String) });
    expect(JSON.stringify(response)).not.toContain("private");
  });

  test("有限数值和null原样保留，不做数值修复、非READY归零或字符串转数字", async () => {
    const { response } = await capture(envelope([row({ value: -1.25, numerator: 3.5, denominator: null }), row({ value: "123", numerator: Infinity, denominator: NaN })]));
    expect(response.rows[0]).toMatchObject({ value: -1.25, numerator: 3.5, denominator: null, dataStatus: "PROCESSING" });
    expect(response.rows[1]).not.toHaveProperty("value");
    expect(business(response.rows[1]).fieldState).toMatchObject({ value: { kind: "string", state: "invalid" }, numerator: { kind: "number", state: "invalid" }, denominator: { kind: "number", state: "invalid" } });
  });

  test("正式unit/dataStatus/metricVersion与合理规则版本保留，非法值不回显", async () => {
    const { response } = await capture(envelope([row({ unit: "ratio", dataStatus: "SOURCE_INCOMPLETE", ruleVersion: "paid-order-value-v1" }), row({ unit: "private-unit", dataStatus: "private-status", metricVersion: "private-version", ruleVersion: "private rule with spaces" })]));
    expect(response.rows[0]).toMatchObject({ unit: "ratio", dataStatus: "SOURCE_INCOMPLETE", metricVersion: "bi-v1", ruleVersion: "paid-order-value-v1" });
    expect(response.rows[1]).not.toHaveProperty("unit");
    expect(response.rows[1]).not.toHaveProperty("ruleVersion");
    expect(JSON.stringify(response)).not.toContain("private");
  });

  test("watermark仅保留ISO日期/时间或null，其他文本仅kind/hash", async () => {
    for (const watermark of ["2026-10-12", "2026-10-12T00:00:00Z", null]) {
      const payload = envelope(); (payload.msg as { watermark: unknown }).watermark = watermark;
      expect((await capture(payload)).response.watermark).toBe(watermark);
    }
    const payload = envelope(); payload.msg.watermark = "private-watermark";
    const { response } = await capture(payload);
    expect(response).not.toHaveProperty("watermark");
    expect(response.fieldState.watermark).toMatchObject({ state: "invalid", kind: "string", sha256: expect.any(String) });
    expect(JSON.stringify(response)).not.toContain("private-watermark");
  });

  test("generatedAt必须是合法ISO时间，不伪造缺失code或元数据", async () => {
    const payload = { msg: { generatedAt: "private-generated-at", rows: [] } };
    const { response } = await capture(payload);
    expect(response).not.toHaveProperty("code");
    expect(response).not.toHaveProperty("generatedAt");
    expect(response.fieldState.code).toMatchObject({ state: "missing" });
    expect(response.fieldState.generatedAt).toMatchObject({ state: "invalid", kind: "string" });
  });

  test("实际数值业务码和字符串200原样保留，任意错误文本不回显", async () => {
    expect((await capture(envelope([], { code: "200" }))).response.code).toBe("200");
    expect((await capture(envelope([], { code: 422 }))).response.code).toBe(422);
    const { response } = await capture({ code: "private-business-error", err: "private-error" });
    expect(response).not.toHaveProperty("code");
    expect(JSON.stringify(response)).not.toContain("private");
  });

  test("缺rows、非数组rows和空数组分别标记，不冒充完整空结果", async () => {
    for (const rows of [undefined, null, "private-rows", {}]) {
      const { response } = await capture({ code: 200, msg: { rows } });
      expect(response.rowCount).toBeNull();
      expect(response.omittedRows).toBeNull();
      expect(response.fieldState.rows.state).not.toBe("valid");
    }
    expect((await capture(envelope([]))).response).toMatchObject({ rowCount: 0, retainedRowCount: 0, omittedRows: 0, truncated: false });
  });

  test("参数仅返回固定格式/枚举，维度筛选解析为白名单对象", async () => {
    const request = { ...params(), dimensions: "clientPlatform,userCohort", dimensionFilters: '{"clientPlatform":"android","userCohort":"new"}', privateQueryKey: "private-query-value" };
    const { snapshot } = await capture(envelope(), request);
    expect(snapshot.calls[0].params).toMatchObject({ dimensions: "clientPlatform,userCohort", dimensionFilters: { clientPlatform: "android", userCohort: "new" }, omittedFieldCount: 1 });
    expect(JSON.stringify(snapshot)).not.toContain("privateQueryKey");
    expect(JSON.stringify(snapshot)).not.toContain("private-query-value");
  });

  test("非法/未知参数或筛选字段不返回名称、值或原始JSON", async () => {
    const request = { ...params(), granularity: "private-granularity", metricCodes: "M016,private-code", dimensions: "private-dimension", dimensionFilters: '{"private-field":"private-filter"}', includeIncomplete: "private-bool" };
    const { snapshot } = await capture(envelope(), request);
    expect(snapshot.calls[0].params).not.toHaveProperty("dimensionFilters");
    expect(snapshot.calls[0].params).not.toHaveProperty("metricCodes");
    expect(JSON.stringify(snapshot)).not.toContain("private");
  });

  test("protected guard覆盖规则版本、合法枚举、已知版本和参数内筛选值", async () => {
    const { snapshot, response } = await capture(envelope([row({ ruleVersion: "secret-token-v1", dimensions: { pid: "PH", userCohort: "new" } })]),
      { ...params(), dimensionFilters: '{"userCohort":"new"}' }, { isProtectedText: value => ["secret-token-v1", "new", "bi-v1"].includes(value) });
    expect(response).not.toHaveProperty("metricVersion");
    expect(business(response.rows[0])).not.toHaveProperty("ruleVersion");
    expect(business(response.rows[0]).dimensions).not.toHaveProperty("userCohort");
    expect(snapshot.calls[0].params).not.toHaveProperty("dimensionFilters");
    expect(snapshot.calls[0].params.fieldState.dimensionFilters).toEqual({ state: "protected", kind: "string" });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("secret-token-v1");
    expect(serialized).not.toContain(createHash("sha256").update("string\u0000secret-token-v1").digest("hex"));
    expect(business(response.rows[0]).fieldState.ruleVersion).toEqual({ state: "protected", kind: "string" });
    expect(serialized).not.toContain('"bi-v1"');
    expect(serialized).not.toContain('"new"');
  });

  test("protected guard覆盖PID、日期、metricCode、generatedAt与watermark", async () => {
    for (const secret of ["PH", "2026-10-12", "M016", "2026-10-15T08:00:00+08:00"]) {
      const { snapshot } = await capture(envelope(), params(), { isProtectedText: value => value.includes(secret) });
      expect(JSON.stringify(snapshot)).not.toContain(`"${secret}"`);
    }
  });

  test("protected guard自身失败则关闭字符串输出，保持原get成功", async () => {
    const payload = envelope();
    const { actual, snapshot } = await capture(payload, params(), { isProtectedText: () => { throw new Error("private-guard-error"); } });
    expect(actual).toBe(payload);
    expect(JSON.stringify(snapshot)).not.toContain("daily-active-v1");
    expect(JSON.stringify(snapshot)).not.toContain("private-guard-error");
  });

  test("畸形row/envelope/msg/rows中的配置敏感文本也不输出hash", async () => {
    const secret = "configured-low-entropy-secret";
    const digest = createHash("sha256").update(`string\u0000${secret}`).digest("hex");
    for (const payload of [secret, { msg: secret }, { msg: { rows: secret } }, envelope([secret])]) {
      const { snapshot } = await capture(payload, params(), { isProtectedText: value => value === secret });
      const serialized = JSON.stringify(snapshot);
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain(digest);
      expect(serialized).toContain('"protected"');
    }
  });

  test("整批及相同scope的单指标隔离重读都保留独立序号，不能去重覆盖", async () => {
    let attempt = 0;
    const collector = createOperatingEvidenceCollector({ get: async () => envelope([row({ numerator: ++attempt })]) });
    await collector.client.get(BI_V1_METRICS_API, { ...params(), metricCodes: "M016,M018" });
    await collector.client.get(BI_V1_METRICS_API, params());
    await collector.client.get(BI_V1_METRICS_API, params());
    const calls = collector.finish().calls;
    expect(calls.map(call => call.sequence)).toEqual([1, 2, 3]);
    expect(calls.map(call => business(call.response!.rows[0]).numerator)).toEqual([1, 2, 3]);
  });

  test("序号按调用发起顺序固定，不受完成顺序影响", async () => {
    let resolveFirst!: (value: unknown) => void;
    const collector = createOperatingEvidenceCollector({ get: async (_path, query) => query.metricCodes === "M016" ? new Promise(resolve => { resolveFirst = resolve; }) : envelope([row({ metricCode: "M018" })]) });
    const first = collector.client.get(BI_V1_METRICS_API, params());
    await collector.client.get(BI_V1_METRICS_API, { ...params(), metricCodes: "M018" });
    resolveFirst(envelope()); await first;
    expect(collector.finish().calls.map(call => [call.sequence, call.params.metricCodes])).toEqual([[1, "M016"], [2, "M018"]]);
  });

  test("上游错误同一对象重抛，输出仅既有固定code且不回message/stack/原err", async () => {
    const error = new UpstreamError("UPSTREAM_AUTH_FAILED", "private-token Cookie=private-cookie https://private.example", 401);
    const collector = createOperatingEvidenceCollector({ get: async () => { throw error; } });
    let caught: unknown;
    try { await collector.client.get(BI_V1_METRICS_API, params()); } catch (failure) { caught = failure; }
    expect(caught).toBe(error);
    expect(collector.finish().calls[0]).toMatchObject({ state: "rejected", errorCode: "UPSTREAM_AUTH_FAILED", response: null, httpStatus: null });
    const serialized = JSON.stringify(collector.finish());
    for (const text of ["private", "Cookie", "message", "stack", "https://"]) expect(serialized).not.toContain(text);
  });

  test("未知错误码映射unknown，不泄漏自定义错误码", async () => {
    const error = new UpstreamError("private-error-code", "private-message");
    const collector = createOperatingEvidenceCollector({ get: async () => { throw error; } });
    await expect(collector.client.get(BI_V1_METRICS_API, params())).rejects.toBe(error);
    expect(collector.finish().calls[0].errorCode).toBe("unknown");
    expect(JSON.stringify(collector.finish())).not.toContain("private");
  });

  test("finish冻结pending快照，迟到成功及后续get不改变输出或取消共享上游", async () => {
    let resolve!: (value: unknown) => void;
    const controller = new AbortController();
    const collector = createOperatingEvidenceCollector({ get: async () => new Promise(done => { resolve = done; }) });
    const pending = collector.client.get(BI_V1_METRICS_API, params(), undefined, controller.signal);
    const snapshot = collector.finish(), before = JSON.stringify(snapshot);
    expect(snapshot.calls[0].state).toBe("pending");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.calls[0].params.fieldState.pid)).toBe(true);
    expect(controller.signal.aborted).toBe(false);
    const payload = envelope(); resolve(payload);
    expect(await pending).toBe(payload);
    expect(collector.finish()).toBe(snapshot);
    expect(JSON.stringify(snapshot)).toBe(before);
    expect(Object.isFrozen(payload)).toBe(false);
  });

  test("finish后迟到拒绝仍抛原错误，不修改pending或产生新记录", async () => {
    let reject!: (reason: unknown) => void;
    const error = new UpstreamError("UPSTREAM_TIMEOUT", "private-timeout");
    let requestCount = 0;
    const collector = createOperatingEvidenceCollector({ get: async () => ++requestCount === 1 ? new Promise((_resolve, fail) => { reject = fail; }) : envelope() });
    const pending = collector.client.get(BI_V1_METRICS_API, params());
    const snapshot = collector.finish(); reject(error);
    await expect(pending).rejects.toBe(error);
    await collector.client.get(BI_V1_METRICS_API, params());
    expect(snapshot.calls).toHaveLength(1);
    expect(snapshot.calls[0]).toMatchObject({ state: "pending", errorCode: null, response: null });
  });

  test("最多160个逻辑调用，多余调用仍真实执行并显式计数", async () => {
    let reads = 0;
    const collector = createOperatingEvidenceCollector({ get: async () => { reads++; return envelope([]); } });
    for (let index = 0; index < OPERATING_EVIDENCE_MAX_CALLS + 3; index++) await collector.client.get(BI_V1_METRICS_API, params());
    const snapshot = collector.finish();
    expect(reads).toBe(163);
    expect(snapshot.calls).toHaveLength(160);
    expect(snapshot.omittedCallCount).toBe(3);
  });

  test("每call最多3000行，原rowCount及省略数完整标记", async () => {
    const { response } = await capture(envelope(Array.from({ length: OPERATING_EVIDENCE_MAX_ROWS_PER_CALL + 2 }, () => row({ dimensions: { pid: "OTHER" } }))));
    expect(response).toMatchObject({ rowCount: 3002, retainedRowCount: 3000, omittedRows: 2, truncated: true, truncationReasons: ["row_limit"] });
    expect(response.rows.at(-1)?.rowIndex).toBe(2999);
  });

  test("总UTF8输出受2MiB限制，跨call触发省略且不截断原始payload", async () => {
    const payload = envelope(Array.from({ length: 3_000 }, () => row({ ruleVersion: "r".repeat(127) + "1" })));
    const collector = createOperatingEvidenceCollector({ get: async () => payload });
    for (let index = 0; index < OPERATING_EVIDENCE_MAX_CALLS; index++) expect(await collector.client.get(BI_V1_METRICS_API, params())).toBe(payload);
    const snapshot = collector.finish();
    expect(Buffer.byteLength(JSON.stringify(snapshot), "utf8")).toBeLessThanOrEqual(OPERATING_EVIDENCE_MAX_BYTES);
    expect(snapshot.calls.some(call => call.response?.truncationReasons.includes("response_bytes"))).toBe(true);
    for (const call of snapshot.calls) expect(call.response!.retainedRowCount + call.response!.omittedRows!).toBe(3000);
    expect(payload.msg.rows).toHaveLength(3000);
  });

  test("未知字段getter不执行，observer自身异常不改变原get成功", async () => {
    const payload = envelope();
    Object.defineProperty(payload, "privateGetter", { enumerable: true, get() { throw new Error("private-getter"); } });
    const { actual, response } = await capture(payload);
    expect(actual).toBe(payload);
    expect(response.omittedFieldCount).toBe(1);
    expect(JSON.stringify(response)).not.toContain("privateGetter");
  });
});
