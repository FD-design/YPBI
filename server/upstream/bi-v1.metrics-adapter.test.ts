import { describe, expect, test } from "bun:test";
import { aggregateBiV1MetricDays, biV1MetricCodeSchema, biV1MetricKey, queryBiV1Metrics, readBiV1MetricDays, type BiV1MetricCode, type BiV1MetricDataStatus, type BiV1MetricUnit } from "./bi-v1.metrics-adapter";
import { UpstreamError } from "./client";

const makeRow = (metricCode: BiV1MetricCode, unit: BiV1MetricUnit, value: number | null, numerator: number, denominator: number, dimensions: Record<string, unknown> = {}, dataStatus: BiV1MetricDataStatus = "READY") => ({
  metricCode,
  businessDate: "2026-09-21",
  dimensions: { pid: "PH", ...dimensions },
  value,
  numerator,
  denominator,
  unit,
  dataStatus,
  metricVersion: "bi-v1" as const,
  ruleVersion: "rule-v1"
});

const message = (rows: ReturnType<typeof makeRow>[]) => ({
  metricVersion: "bi-v1" as const,
  generatedAt: "2026-09-22T10:00:00+08:00",
  watermark: "2026-09-22 10:00:00.000",
  rows
});

describe("bi-v1 批量请求有界隔离", () => {
  const query = { pid: "PH", startDate: "2020-01-01", endDate: "2020-01-01", metricCodes: ["M008", "M113", "M112", "M060", "M114"] as const };
  const dated = (row: ReturnType<typeof makeRow>) => ({ ...row, businessDate: query.startDate });
  const paymentRows = [
    dated(makeRow("M113", "count", 4, 4, 0)), dated(makeRow("M112", "count", 4, 4, 0)),
    dated(makeRow("M060", "count", 4, 4, 0)), dated(makeRow("M114", "ratio", 1, 4, 4))
  ];

  for (const rejection of ["400", "422", "client"] as const) {
    test(`不支持的指标被${rejection}拒绝后保留支付4/4，失败项不成为真零或无记录`, async () => {
      const calls: Record<string, string>[] = [];
      let inFlight = 0, maxInFlight = 0;
      const client = { get: async (path: string, params: Record<string, string>) => {
        expect(path).toBe("/api/admin/bi/v1/metrics");
        calls.push(params);
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        await Promise.resolve();
        inFlight--;
        if (params.metricCodes.includes("M008")) {
          if (rejection === "client") throw new UpstreamError("UPSTREAM_INVALID_REQUEST", "不支持的指标编码 M008", 422);
          return { code: Number(rejection), err: "Unsupported metricCodes: M008" };
        }
        return { code: 200, msg: message(paymentRows.filter(row => params.metricCodes.split(",").includes(row.metricCode))) };
      } };
      const result = await readBiV1MetricDays(client, query);
      expect(result.message).toBeNull();
      expect(calls.map(call => call.metricCodes)).toEqual(["M008,M113,M112,M060,M114", ...query.metricCodes]);
      expect(maxInFlight).toBe(1);
      for (const call of calls) expect(call).toMatchObject({ pid: "PH", startDate: "2020-01-01", endDate: "2020-01-02", granularity: "day", includeIncomplete: "true" });
      const metrics = result.days[0].metrics;
      expect(metrics.M008).toEqual({ state: "source_failure", dataStatus: null, value: null, numerator: null, denominator: null, unit: null });
      for (const code of ["M113", "M112", "M060"]) expect(metrics[code]).toMatchObject({ state: "available", dataStatus: "READY", value: 4 });
      expect(metrics.M114).toMatchObject({ state: "available", value: 1, numerator: 4, denominator: 4 });
    });
  }

  test("正常批量只请求一次并原样保留上游消息", async () => {
    const payload = message(paymentRows);
    let calls = 0;
    const result = await readBiV1MetricDays({ get: async () => { calls++; return { code: 200, msg: payload }; } }, { ...query, metricCodes: ["M113", "M112", "M060", "M114"] });
    expect(calls).toBe(1);
    expect(result.message).toEqual(payload);
    expect(result.days[0].metrics.M114).toMatchObject({ value: 1, dataStatus: "READY" });
  });

  for (const invalidField of ["numerator", "denominator", "unit"] as const) {
    test(`${invalidField}结构错误只隔离对应指标且不放宽字段契约`, async () => {
      let calls = 0;
      const rows = [
        { ...dated(makeRow("M008", "count", null, 0, 0, {}, "SOURCE_INCOMPLETE")), [invalidField]: null },
        ...paymentRows
      ];
      const result = await readBiV1MetricDays({ get: async (_path, params) => {
        calls++;
        return { code: 200, msg: { ...message([]), rows: rows.filter(row => params.metricCodes.split(",").includes(row.metricCode)) } };
      } }, query);
      expect(calls).toBe(query.metricCodes.length + 1);
      expect(result.days[0].metrics.M008).toMatchObject({ state: "source_failure", dataStatus: null, value: null, numerator: null, denominator: null });
      expect(result.days[0].metrics.M114).toMatchObject({ state: "available", value: 1, numerator: 4, denominator: 4 });
    });
  }

  test("隔离后的真实零、空记录与未就绪状态各自保留，失败覆盖查询内每一天", async () => {
    const rangeQuery = { ...query, endDate: "2020-01-02", metricCodes: ["M008", "M016", "M026", "M020", "M021", "M022"] as const };
    const rows = [
      dated(makeRow("M016", "count", 0, 0, 0)),
      { ...dated(makeRow("M020", "ratio", null, 0, 0, {}, "NOT_MATURE")), businessDate: undefined },
      { ...dated(makeRow("M021", "ratio", null, 0, 0, {}, "SOURCE_INCOMPLETE")), businessDate: undefined },
      { ...dated(makeRow("M022", "ratio", null, 0, 0, {}, "FAILED")), businessDate: undefined }
    ];
    const result = await readBiV1MetricDays({ get: async (_path, params) => params.metricCodes.includes("M008")
      ? { code: 400, err: "未知指标 M008" }
      : { code: 200, msg: { ...message([]), rows: rows.filter(row => params.metricCodes === row.metricCode) } }
    }, rangeQuery);
    expect(result.days[0].metrics.M016).toMatchObject({ state: "available", value: 0 });
    expect(result.days[1].metrics.M016).toMatchObject({ state: "no_record", value: null });
    for (const day of result.days) {
      expect(day.metrics.M008).toMatchObject({ state: "source_failure", dataStatus: null, value: null });
      expect(day.metrics.M026).toMatchObject({ state: "no_record", dataStatus: null, value: null });
      expect(day.metrics.M020).toMatchObject({ state: "immature", dataStatus: "NOT_MATURE", value: null });
      expect(day.metrics.M021).toMatchObject({ state: "no_value", dataStatus: "SOURCE_INCOMPLETE", value: null });
      expect(day.metrics.M022).toMatchObject({ state: "source_failure", dataStatus: "FAILED", value: null });
    }
  });

  test("所有指标失败时请求数不超过去重后的登记指标数加一，单指标不重复请求", async () => {
    let calls = 0;
    const client = { get: async () => { calls++; return { code: 400, err: "未知指标" }; } };
    const codes = biV1MetricCodeSchema.options;
    const result = await readBiV1MetricDays(client, { ...query, metricCodes: [...codes, ...codes] });
    expect(calls).toBe(codes.length + 1);
    expect(Object.keys(result.days[0].metrics)).toHaveLength(codes.length);
    expect(Object.values(result.days[0].metrics).every(point => point.state === "source_failure" && point.value === null)).toBe(true);
    calls = 0;
    const single = await readBiV1MetricDays(client, { ...query, metricCodes: ["M008", "M008"] });
    expect(calls).toBe(1);
    expect(single.days[0].metrics.M008.state).toBe("source_failure");
  });

  for (const error of [
    new UpstreamError("UPSTREAM_AUTH_FAILED", "后台登录状态无效", 401),
    new UpstreamError("UPSTREAM_AUTH_FAILED", "后台登录状态无效", 403),
    new UpstreamError("UPSTREAM_IP_RESTRICTED", "服务器出口 IP 未加入后台白名单", 403),
    new UpstreamError("UPSTREAM_TIMEOUT", "后台接口请求超时", 504),
    new UpstreamError("UPSTREAM_NETWORK_ERROR", "无法连接后台接口", 502),
    new UpstreamError("UPSTREAM_RATE_LIMITED", "后台接口请求过于频繁", 429),
    new UpstreamError("UPSTREAM_INVALID_REQUEST", "当前账号没有 PID 权限", 422),
    new UpstreamError("UPSTREAM_INVALID_REQUEST", "指标查询没有权限，token 无效", 422),
    new UpstreamError("UPSTREAM_INVALID_REQUEST", "endDate 必须晚于 startDate", 422),
    new UpstreamError("UPSTREAM_FAILED", "后台接口返回 500", 502)
  ]) {
    test(`${error.code}/${error.statusCode}/${error.message}立即停止，不触发单项重试`, async () => {
      let calls = 0;
      await expect(readBiV1MetricDays({ get: async () => { calls++; throw error; } }, query)).rejects.toBe(error);
      expect(calls).toBe(1);
    });
  }

  for (const code of [401, 403, 500, 2002]) {
    test(`响应体业务码${code}不按指标参数错误重试`, async () => {
      let calls = 0;
      await expect(readBiV1MetricDays({ get: async () => { calls++; return { code, err: "metric query unavailable" }; } }, query)).rejects.toMatchObject({ code: "BI_V1_REQUEST_REJECTED" });
      expect(calls).toBe(1);
    });
  }

  for (const row of [
    { ...paymentRows[0], dimensions: { pid: "OTHER" } },
    { ...paymentRows[0], businessDate: "2019-12-31" },
    { ...paymentRows[0], businessDate: "2020-01-02" },
    { ...paymentRows[0], dimensions: { pid: "OTHER" }, businessDate: "invalid-date" },
    { ...paymentRows[0], dimensions: { pid: "OTHER" }, metricCode: null },
    { ...paymentRows[0], metricCode: "M999" }
  ]) {
    test(`范围冲突即使伴随空分子仍整批拒绝：${JSON.stringify(row.dimensions)}/${row.businessDate}/${row.metricCode}`, async () => {
      let calls = 0;
      await expect(readBiV1MetricDays({ get: async () => {
        calls++;
        return { code: 200, msg: { ...message([]), rows: [{ ...row, numerator: null }, ...paymentRows] } };
      } }, query)).rejects.toMatchObject({ code: "BI_V1_SCOPE_CONFLICT" });
      expect(calls).toBe(1);
    });
  }

  test("单项恢复过程中遇到范围冲突或鉴权失败立即停止后续请求", async () => {
    for (const failure of ["scope", "auth"] as const) {
      const calls: string[] = [];
      await expect(readBiV1MetricDays({ get: async (_path, params) => {
        calls.push(params.metricCodes);
        if (params.metricCodes.includes("M008")) return { code: 400, err: "未知指标 M008" };
        if (failure === "auth") throw new UpstreamError("UPSTREAM_AUTH_FAILED", "后台登录状态无效", 401);
        return { code: 200, msg: message(paymentRows) };
      } }, query)).rejects.toMatchObject({ code: failure === "auth" ? "UPSTREAM_AUTH_FAILED" : "BI_V1_SCOPE_CONFLICT" });
      expect(calls).toEqual(["M008,M113,M112,M060,M114", "M008", "M113"]);
    }
  });
});

describe("bi-v1 通用指标适配", () => {
  test("M110 正式次/人单位通过批量解析并保留 2/3，同批计数和比率正常返回", async () => {
    let calls = 0;
    const result = await readBiV1MetricDays({ get: async () => {
      calls++;
      return { code: 200, msg: message([
        makeRow("M110", "count_per_user", 2 / 3, 2, 3, { userType: "new" }),
        makeRow("M113", "count", 4, 4, 0),
        makeRow("M114", "ratio", .5, 2, 4)
      ]) };
    } }, { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-21", metricCodes: ["M110", "M113", "M114"] });
    expect(calls).toBe(1);
    expect(result.message).not.toBeNull();
    expect(result.days[0].metrics[biV1MetricKey("M110", ["new"])]).toMatchObject({
      state: "available", dataStatus: "READY", value: 2 / 3, numerator: 2, denominator: 3, unit: "count_per_user"
    });
    expect(result.days[0].metrics.M113).toMatchObject({ state: "available", value: 4, unit: "count" });
    expect(result.days[0].metrics.M114).toMatchObject({ state: "available", value: .5, unit: "ratio" });
  });

  for (const [label, value, numerator, denominator, state] of [
    ["每人次数大于1", 2.5, 5, 2, "available"],
    ["真实零", 0, 0, 3, "available"],
    ["零分母", null, 0, 0, "zero_denominator"],
    ["分子非零且零分母", null, 2, 0, "zero_denominator"],
    ["非零分母但值为空", null, 2, 3, "invalid_value"],
    ["零分母却返回零", 0, 0, 0, "invalid_value"],
    ["数值与分子分母不一致", .5, 2, 3, "invalid_value"],
    ["分子不是整数", .5, 1.5, 3, "invalid_value"],
    ["分母不是整数", 2 / 3.5, 2, 3.5, "invalid_value"],
    ["分子不是安全整数", 2 ** 53, 2 ** 53, 1, "invalid_value"],
    ["分母不是安全整数", 1 / 2 ** 53, 1, 2 ** 53, "invalid_value"]
  ] as const) {
    test(`M110 次/人边界：${label}，异常与相邻指标隔离`, () => {
      const result = aggregateBiV1MetricDays(message([
        makeRow("M110", "count_per_user", value, numerator, denominator),
        makeRow("M016", "count", 10, 10, 0)
      ]), { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-21", metricCodes: ["M110", "M016"] });
      expect(result[0].metrics.M110).toMatchObject({ state, value: state === "available" ? value : null });
      if (state !== "invalid_value") expect(result[0].metrics.M110).toMatchObject({ numerator, denominator, unit: "count_per_user" });
      expect(result[0].metrics.M016).toMatchObject({ state: "available", value: 10 });
    });
  }

  for (const [dataStatus, state] of [
    ["PROCESSING", "no_value"], ["NOT_MATURE", "immature"],
    ["SOURCE_INCOMPLETE", "no_value"], ["FAILED", "source_failure"]
  ] as const) {
    test(`M110 ${dataStatus} 的空值与业务值均以状态为准，缺日不补零`, async () => {
      for (const value of [null, 999]) {
        const result = await readBiV1MetricDays({ get: async () => ({ code: 200, msg: message([
          makeRow("M110", "count_per_user", value, 2, 3, {}, dataStatus),
          makeRow("M016", "count", 10, 10, 0)
        ]) }) }, { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-22", metricCodes: ["M110", "M016"] });
        expect(result.days[0].metrics.M110).toEqual({ state, dataStatus, value: null, numerator: null, denominator: null, unit: null });
        expect(result.days[1].metrics.M110).toMatchObject({ state: "no_record", dataStatus: null, value: null });
        expect(result.days[0].metrics.M016).toMatchObject({ state: "available", value: 10 });
      }
    });
  }

  for (const field of ["paymentMethod", "payment_method"] as const) {
    test(`${field} 接受正式支付值与旧别名，unknown 独立保留`, async () => {
      const result = await readBiV1MetricDays({ get: async () => ({ code: 200, msg: message([
        makeRow("M113", "count", 20, 20, 0),
        ...["ali_pay", "wx_pay", "usdt_pay", "unknown"].map((value, index) => makeRow("M113", "count", index + 1, index + 1, 0, { [field]: value }))
      ]) }) }, { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-21", metricCodes: ["M113"] });
      expect(result.days[0].metrics.M113).toMatchObject({ state: "available", value: 20 });
      for (const [index, value] of ["alipay", "wechat", "usdt", "unknown"].entries()) {
        expect(result.days[0].metrics[biV1MetricKey("M113", [value])]).toMatchObject({ state: "available", value: index + 1 });
      }
      for (const [alias, canonical] of [
        ["alipay", "alipay"], ["ali_pay", "alipay"], ["支付宝", "alipay"],
        ["wechat", "wechat"], ["wechat_pay", "wechat"], ["wx", "wechat"], ["微信", "wechat"], ["wx_pay", "wechat"],
        ["usdt", "usdt"], ["usdt_pay", "usdt"]
      ]) expect(biV1MetricKey("M113", { [field]: alias })).toBe(biV1MetricKey("M113", [canonical]));
    });
  }

  test("支付未知字段、非法值与冲突别名不污染总体、有效方式或相邻指标", () => {
    const isolatedDimensions = [
      { channel: "wx_pay" }, { channel: "usdt_pay" }, { channel: "unknown" },
      { paymentMethod: "unsupported_pay" }, { paymentMethod: "" }, { paymentMethod: null },
      { paymentMethod: ["wx_pay"] }, { paymentMethod: "wx_pay", channel: "unknown" },
      { paymentMethod: "wx_pay", payment_method: "ali_pay" }
    ];
    const result = aggregateBiV1MetricDays({ ...message([]), rows: [
      makeRow("M113", "count", 12, 12, 0),
      makeRow("M113", "count", 4, 4, 0, { paymentMethod: "wx_pay" }),
      makeRow("M113", "count", 2, 2, 0, { paymentMethod: "unknown" }),
      makeRow("M016", "count", 10, 10, 0),
      ...isolatedDimensions.map(dimensions => ({ ...makeRow("M113", "count", null, 0, 0, dimensions, "FAILED"), businessDate: undefined }))
    ] }, { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-22", metricCodes: ["M113", "M016"] });
    expect(result[0].metrics.M113).toMatchObject({ state: "available", value: 12 });
    expect(result[0].metrics[biV1MetricKey("M113", ["wechat"])]).toMatchObject({ state: "available", value: 4 });
    expect(result[0].metrics[biV1MetricKey("M113", ["unknown"])]).toMatchObject({ state: "available", value: 2 });
    expect(result[0].metrics.M016).toMatchObject({ state: "available", value: 10 });
    expect(result[1].metrics.M113).toMatchObject({ state: "no_record", value: null });
    for (const dimensions of isolatedDimensions) {
      const key = biV1MetricKey("M113", dimensions);
      expect(key.startsWith("M113|unmapped:")).toBe(true);
      for (const day of result) expect(day.metrics[key]).toMatchObject({ state: "source_failure", dataStatus: "FAILED", value: null });
    }
    expect(biV1MetricKey("M113", { paymentMethod: "wx_pay", payment_method: "wechat" })).toBe(biV1MetricKey("M113", ["wechat"]));
  });

  test("只消费可直接映射的总体计数与同批比率", () => {
    const result = aggregateBiV1MetricDays(message([
      makeRow("M003", "count", 20, 20, 0),
      makeRow("M005", "ratio", 20 / 60, 20, 60),
      makeRow("M103", "ratio", 3 / 5, 3, 5)
    ]), { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-21", metricCodes: ["M003", "M005", "M103"] });
    expect(result[0].metrics.M003).toMatchObject({ state: "available", value: 20, numerator: 20, denominator: 0, unit: "count" });
    expect(result[0].metrics.M005).toMatchObject({ state: "available", value: 20 / 60, numerator: 20, denominator: 60, unit: "ratio" });
    expect(result[0].metrics.M103).toMatchObject({ state: "available", value: 3 / 5, numerator: 3, denominator: 5, unit: "ratio" });
  });

  test("未知维度行不在 BI 内擅自求和", () => {
    const result = aggregateBiV1MetricDays(message([
      makeRow("M003", "count", 12, 12, 0, { channel: "a" }),
      makeRow("M003", "count", 8, 8, 0, { channel: "b" })
    ]), { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-21", metricCodes: ["M003"] });
    expect(result[0].metrics.M003).toMatchObject({ state: "invalid_value", dataStatus: null, value: null });
    expect(result[0].metrics[biV1MetricKey("M003", { channel: "a" })]).toMatchObject({ state: "available", value: 12 });
    expect(result[0].metrics[biV1MetricKey("M003", { channel: "b" })]).toMatchObject({ state: "available", value: 8 });
  });

  test("总体与交叉维度独立返回，字段名别名不改变业务切片", () => {
    const result = aggregateBiV1MetricDays(message([
      makeRow("M016", "count", 10, 10, 0),
      makeRow("M016", "count", 4, 4, 0, { clientPlatform: "Android", userType: "old_user" }),
      makeRow("M016", "count", 3, 3, 0, { platform: "iOS", audience: "老用户" }),
      makeRow("M020", "ratio", .6, 6, 10, { d0Platform: "Android" }),
      makeRow("M113", "count", 2, 2, 0, { payment_method: "ali_pay" })
    ]), { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-21", metricCodes: ["M016", "M020", "M113"] });
    expect(result[0].metrics.M016).toMatchObject({ state: "available", value: 10 });
    expect(result[0].metrics[biV1MetricKey("M016", ["android", "old"])]).toMatchObject({ state: "available", value: 4 });
    expect(result[0].metrics[biV1MetricKey("M016", ["ios", "old"])]).toMatchObject({ state: "available", value: 3 });
    expect(result[0].metrics[biV1MetricKey("M020", ["android"])]).toMatchObject({ state: "available", value: .6, numerator: 6, denominator: 10 });
    expect(result[0].metrics[biV1MetricKey("M113", ["alipay"])]).toMatchObject({ state: "available", value: 2 });
  });

  test("只把对应字段的合法值映射为已登记切片，未知字段与错配值独立保留", () => {
    const rows = [
      makeRow("M016", "count", 20, 20, 0),
      makeRow("M016", "count", 8, 8, 0, { clientPlatform: "android" }),
      makeRow("M016", "count", 6, 6, 0, { channel: "android" }),
      makeRow("M016", "count", 5, 5, 0, { videoType: "android" }),
      makeRow("M016", "count", 4, 4, 0, { userType: "old" }),
      makeRow("M016", "count", 3, 3, 0, { clientPlatform: "old" }),
      makeRow("M016", "count", 2, 2, 0, { channel: "android+old" }),
      makeRow("M016", "count", 1, 1, 0, { clientPlatform: "android", channel: "old" }),
      makeRow("M113", "count", 9, 9, 0, { payment_method: "alipay" }),
      makeRow("M113", "count", 7, 7, 0, { channel: "alipay" })
    ];
    const result = aggregateBiV1MetricDays(message(rows), {
      pid: "PH", startDate: "2026-09-21", endDate: "2026-09-21", metricCodes: ["M016", "M113"]
    });
    expect(result[0].metrics.M016).toMatchObject({ state: "available", value: 20 });
    expect(result[0].metrics[biV1MetricKey("M016", ["android"])]).toMatchObject({ state: "available", value: 8 });
    expect(result[0].metrics[biV1MetricKey("M016", ["old"])]).toMatchObject({ state: "available", value: 4 });
    expect(result[0].metrics[biV1MetricKey("M016", ["android", "old"])]).toBeUndefined();
    expect(result[0].metrics[biV1MetricKey("M113", ["alipay"])]).toMatchObject({ state: "available", value: 9 });
    for (const row of rows) {
      expect(result[0].metrics[biV1MetricKey(row.metricCode, row.dimensions)]).toMatchObject({ state: "available", value: row.value });
    }
  });

  test("空值和非字符串维度不变成总体，也不通过字符串转换命中业务切片", () => {
    const dimensions: Record<string, unknown>[] = [
      { channel: "" }, { channel: null }, { clientPlatform: " " }, { clientPlatform: null },
      { clientPlatform: ["android"] }, { clientPlatform: "unknown" },
      { clientPlatform: "android", channel: "" }
    ];
    for (const dimension of dimensions) {
      const result = aggregateBiV1MetricDays(message([
        makeRow("M016", "count", 12, 12, 0),
        makeRow("M016", "count", 3, 3, 0, dimension)
      ]), { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-21", metricCodes: ["M016"] });
      expect(result[0].metrics.M016).toMatchObject({ state: "available", value: 12 });
      expect(result[0].metrics[biV1MetricKey("M016", ["android"])]).toBeUndefined();
      const dimensionOnly = aggregateBiV1MetricDays(message([
        makeRow("M016", "count", 3, 3, 0, dimension)
      ]), { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-21", metricCodes: ["M016"] });
      expect(dimensionOnly[0].metrics.M016).toMatchObject({ state: "invalid_value", value: null });
    }
  });

  test("字段别名、合法值别名与维度顺序继续匹配同一切片", () => {
    expect(biV1MetricKey("M016", { userCohort: "老用户", platform: "Android" }))
      .toBe(biV1MetricKey("M016", { clientPlatform: "android", userType: "old_user" }));
    expect(biV1MetricKey("M008", { registerPlatform: "iOS" })).toBe(biV1MetricKey("M008", ["ios"]));
    expect(biV1MetricKey("M008", { sourceType: "organic" })).toBe(biV1MetricKey("M008", ["natural"]));
    expect(biV1MetricKey("M020", { acquisitionType: "internal_channel" })).toBe(biV1MetricKey("M020", ["internal"]));
    expect(biV1MetricKey("M016", { audience: "android_old_user" })).toBe(biV1MetricKey("M016", ["android", "old"]));
    expect(biV1MetricKey("M016", { channel: "old", clientPlatform: "android" }))
      .toBe(biV1MetricKey("M016", { clientPlatform: "android", channel: "old" }));
  });

  test("同值未知维度的全局状态不污染已登记切片，重复别名只隔离相应切片", () => {
    const globalRow = (dimensions: Record<string, unknown>, dataStatus: BiV1MetricDataStatus) => ({
      ...makeRow("M016", "count", null, 0, 0, dimensions, dataStatus), businessDate: undefined
    });
    const result = aggregateBiV1MetricDays({ ...message([]), rows: [
      globalRow({ channel: "android" }, "FAILED"),
      globalRow({ videoType: "android" }, "SOURCE_INCOMPLETE"),
      globalRow({ channel: "" }, "PROCESSING"),
      makeRow("M016", "count", 10, 10, 0),
      makeRow("M016", "count", 4, 4, 0, { clientPlatform: "android" }),
      makeRow("M016", "count", 3, 3, 0, { clientPlatform: "ios" }),
      makeRow("M016", "count", 3, 3, 0, { platform: "iOS" })
    ] }, { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-22", metricCodes: ["M016"] });
    expect(result[0].metrics.M016).toMatchObject({ state: "available", value: 10 });
    expect(result[0].metrics[biV1MetricKey("M016", ["android"])]).toMatchObject({ state: "available", value: 4 });
    expect(result[0].metrics[biV1MetricKey("M016", ["ios"])]).toMatchObject({ state: "invalid_value", value: null });
    for (const day of result) {
      expect(day.metrics[biV1MetricKey("M016", { channel: "android" })]).toMatchObject({ state: "source_failure", dataStatus: "FAILED", value: null });
      expect(day.metrics[biV1MetricKey("M016", { videoType: "android" })]).toMatchObject({ state: "no_value", dataStatus: "SOURCE_INCOMPLETE", value: null });
    }
    expect(result[1].metrics.M016).toMatchObject({ state: "no_record", dataStatus: null, value: null });
    expect(result[1].metrics[biV1MetricKey("M016", ["android"])]).toBeUndefined();
  });

  test("SOURCE_INCOMPLETE 和缺日保持状态，不补0", () => {
    const result = aggregateBiV1MetricDays({ ...message([]), rows: [{
      metricCode: "M016" as const,
      dimensions: { pid: "PH" },
      value: null,
      numerator: 0,
      denominator: 0,
      unit: "count" as const,
      dataStatus: "SOURCE_INCOMPLETE" as const,
      metricVersion: "bi-v1" as const,
      ruleVersion: ""
    }] }, { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-22", metricCodes: ["M016", "M026"] });
    expect(result[0].metrics.M016).toMatchObject({ state: "no_value", value: null, dataStatus: "SOURCE_INCOMPLETE" });
    expect(result[1].metrics.M016).toMatchObject({ state: "no_value", value: null, dataStatus: "SOURCE_INCOMPLETE" });
    expect(result[0].metrics.M026).toMatchObject({ state: "no_record", value: null, dataStatus: null });
  });

  test("请求使用排他结束日期并拒绝范围外指标", async () => {
    let params: Record<string, string> = {};
    const client = { get: async (_path: string, query: Record<string, string>) => {
      params = query;
      return { code: 200, msg: message([makeRow("M003", "count", 1, 1, 0)]) };
    } };
    await expect(queryBiV1Metrics(client as never, { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-21", metricCodes: ["M016"] })).rejects.toMatchObject({ code: "BI_V1_SCOPE_CONFLICT" });
    expect(params.endDate).toBe("2026-09-22");
    expect(params.metricCodes).toBe("M016");
  });

  test("异常指标按指标隔离，不影响同批正常指标", () => {
    const count = makeRow("M003", "count", 1, 1, 0, { channel: "a" });
    const duplicate = aggregateBiV1MetricDays(message([count, count, makeRow("M016", "count", 2, 2, 0)]), { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-21", metricCodes: ["M003", "M016"] });
    expect(duplicate[0].metrics.M003).toMatchObject({ state: "invalid_value", dataStatus: null, value: null });
    expect(duplicate[0].metrics.M016).toMatchObject({ state: "available", value: 2 });

    const badValues = aggregateBiV1MetricDays(message([
      { ...makeRow("M003", "count", 1, 1, 0), value: 1.5, numerator: 1.5 },
      makeRow("M005", "ratio", .5, 1, 3),
      makeRow("M016", "count", 2, 2, 0)
    ]), { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-21", metricCodes: ["M003", "M005", "M016"] });
    expect(badValues[0].metrics.M003?.state).toBe("invalid_value");
    expect(badValues[0].metrics.M005?.state).toBe("invalid_value");
    expect(badValues[0].metrics.M016).toMatchObject({ state: "available", value: 2 });
  });

  test("未就绪指标携带错误业务值时只忽略该值，正常兄弟指标继续返回", async () => {
    const payload = message([
      makeRow("M001", "count", 120, 120, 0),
      makeRow("M006", "ratio", 15, 15, 100, {}, "SOURCE_INCOMPLETE")
    ]);
    const client = { get: async () => ({ code: 200, msg: payload }) };
    const query = { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-21", metricCodes: ["M001", "M006"] as const };
    const result = aggregateBiV1MetricDays(await queryBiV1Metrics(client as never, query), query);
    expect(result[0].metrics.M001).toMatchObject({ state: "available", value: 120, dataStatus: "READY" });
    expect(result[0].metrics.M006).toMatchObject({ state: "no_value", value: null, dataStatus: "SOURCE_INCOMPLETE" });
  });
});
