import { describe, expect, test } from "bun:test";
import { aggregateBiV1MetricDays, biV1MetricCodeSchema, biV1MetricKey, queryBiV1Metrics, readBiV1MetricDays, type BiV1MetricCode, type BiV1MetricDataStatus, type BiV1MetricDimensionFilters, type BiV1MetricUnit } from "./bi-v1.metrics-adapter";
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

describe("SOURCE_INCOMPLETE 比率诊断输入", () => {
  const date = "2020-01-01";
  const query = { pid: "PH", startDate: date, endDate: date, metricCodes: ["M020"] as const,
    dimensionFilters: { clientPlatform: "android" as const }, dimensions: ["clientPlatform"] as const };
  const incomplete = (overrides: Record<string, unknown> = {}) => ({
    ...makeRow("M020", "ratio", null, 1, 2, { clientPlatform: "android" }, "SOURCE_INCOMPLETE"),
    businessDate: date, ruleVersion: "retention-d0-D1-v1", ...overrides
  });
  const read = async (rows: ReturnType<typeof incomplete>[]) => readBiV1MetricDays({ get: async () => ({
    code: 200, msg: { ...message([]), rows }
  }) }, query);

  test("同日同范围的历史留存输入仅用于诊断，正式数值与计算输入保持不可用", async () => {
    for (const [filters, numerator, denominator] of [
      [{ clientPlatform: "android" }, 1, 2], [{ clientPlatform: "ios" }, 1, 1],
      [{ sourceType: "natural" }, 1, 2], [{ sourceType: "internal_channel" }, 1, 1]
    ] as const) {
      const result = await readBiV1MetricDays({ get: async () => ({ code: 200, msg: { ...message([]), rows: [
        incomplete({ dimensions: { pid: "PH", ...filters }, numerator, denominator })
      ] } }) }, { ...query, dimensionFilters: filters, dimensions: Object.keys(filters) as (keyof BiV1MetricDimensionFilters)[] });
      expect(result.days[0].metrics[biV1MetricKey("M020", filters)]).toEqual({ state: "no_value", dataStatus: "SOURCE_INCOMPLETE",
        value: null, numerator: null, denominator: null, unit: null, diagnosticInputs: { numerator, denominator } });
    }
  });

  test("独立新日期 READY 2/3 仍按原规则准入，不生成诊断输入", async () => {
    const result = await readBiV1MetricDays({ get: async () => ({ code: 200, msg: { ...message([]), rows: [
      incomplete({ businessDate: "2020-02-20", dataStatus: "READY", value: 2 / 3, numerator: 2, denominator: 3 })
    ] } }) }, { ...query, startDate: "2020-02-20", endDate: "2020-02-20" });
    expect(result.days[0].metrics["M020|android"]).toEqual({ state: "available", dataStatus: "READY", value: 2 / 3, numerator: 2, denominator: 3, unit: "ratio" });
  });

  test("缺失、非法人数或错误单位不成为诊断输入，也不补零", async () => {
    for (const overrides of [
      { numerator: null }, { denominator: undefined }, { numerator: -1 }, { numerator: 1.5 },
      { denominator: Number.MAX_SAFE_INTEGER + 1 }, { numerator: 3, denominator: 2 },
      { numerator: 1, denominator: 0 }, { unit: "count" }
    ]) {
      const result = await read([incomplete(overrides)]);
      expect(result.days[0].metrics["M020|android"]).toMatchObject({ value: null, numerator: null, denominator: null });
      expect(result.days[0].metrics["M020|android"].diagnosticInputs).toBeUndefined();
    }
    const zero = (await read([incomplete({ numerator: 0, denominator: 0 })])).days[0].metrics["M020|android"];
    expect(zero).toMatchObject({ state: "no_value", dataStatus: "SOURCE_INCOMPLETE", value: null, diagnosticInputs: { numerator: 0, denominator: 0 } });
  });

  test("未命中维度、重复行及无日期状态都不提供诊断输入", async () => {
    for (const rows of [
      [incomplete({ dimensions: { pid: "PH", clientPlatform: "ios" } })],
      [incomplete({ dimensions: { pid: "PH", clientPlatform: "android", sourceType: "natural" } })],
      [incomplete(), incomplete()], [incomplete({ businessDate: undefined })]
    ]) {
      const point = (await read(rows)).days[0].metrics["M020|android"];
      expect(point.diagnosticInputs).toBeUndefined();
      expect(point).toMatchObject({ value: null, numerator: null, denominator: null });
    }
    await expect(read([incomplete({ dimensions: { pid: "OTHER", clientPlatform: "android" } })])).rejects.toMatchObject({ code: "BI_V1_SCOPE_CONFLICT" });
  });

  test("仅来源不完整的比率保留输入，其他状态及次数人均不扩大准入", () => {
    for (const status of ["PROCESSING", "NOT_MATURE", "FAILED"] as const) {
      const point = aggregateBiV1MetricDays(message([makeRow("M020", "ratio", .5, 1, 2, {}, status)]), {
        pid: "PH", startDate: "2026-09-21", endDate: "2026-09-21", metricCodes: ["M020"]
      })[0].metrics.M020;
      expect(point.diagnosticInputs).toBeUndefined();
      expect(point.value).toBeNull();
    }
    const points = aggregateBiV1MetricDays(message([
      makeRow("M006", "ratio", 15, 15, 100, {}, "SOURCE_INCOMPLETE"),
      makeRow("M103", "ratio", null, 2, 3, {}, "SOURCE_INCOMPLETE"),
      makeRow("M110", "count_per_user", null, 2, 3, {}, "SOURCE_INCOMPLETE")
    ]), { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-21", metricCodes: ["M006", "M103", "M110"] })[0].metrics;
    expect(points.M006.diagnosticInputs).toEqual({ numerator: 15, denominator: 100 });
    expect(points.M103.diagnosticInputs).toEqual({ numerator: 2, denominator: 3 });
    expect(points.M110.diagnosticInputs).toBeUndefined();
    for (const point of Object.values(points)) expect(point).toMatchObject({ state: "no_value", value: null, numerator: null, denominator: null });
  });

  test("诊断输入遵守同一规则版本准入，旧版和缺版仅保留来源状态", () => {
    for (const ruleVersion of ["effective_play_v3", "effective_play_v2", "", undefined]) {
      const row = { ...makeRow("M036", "ratio", null, 2, 3, { clientPlatform: "android" }, "SOURCE_INCOMPLETE"), ruleVersion };
      // Exercise the projection branch directly, including absent internal metadata.
      const point = aggregateBiV1MetricDays(message([row as ReturnType<typeof makeRow>]), {
        pid: "PH", startDate: "2026-09-21", endDate: "2026-09-21", metricCodes: ["M036"],
        dimensionFilters: { clientPlatform: "android" }, dimensions: ["clientPlatform"],
        expectedRuleVersions: { M036: "effective_play_v3" }
      })[0].metrics["M036|android"];
      expect(point).toMatchObject({ state: "no_value", dataStatus: "SOURCE_INCOMPLETE", value: null, numerator: null, denominator: null });
      expect(point.diagnosticInputs).toEqual(ruleVersion === "effective_play_v3" ? { numerator: 2, denominator: 3 } : undefined);
    }
  });
});

describe("bi-v1 留存总体与分组状态隔离", () => {
  const codes = ["M020", "M021", "M022", "M023"] as const;
  const scopes: BiV1MetricDimensionFilters[] = [
    { clientPlatform: "android" }, { clientPlatform: "ios" },
    { sourceType: "natural" }, { sourceType: "internal_channel" }
  ];
  for (const filters of scopes) {
    const scopeName = JSON.stringify(filters);
    const query = {
      pid: "PH", startDate: "2026-09-21", endDate: "2026-09-22", metricCodes: codes,
      dimensions: Object.keys(filters) as (keyof BiV1MetricDimensionFilters)[], dimensionFilters: filters
    };

    test(`${scopeName} 四周期 READY 日记录不被总体或同组无日期 SOURCE_INCOMPLETE 覆盖`, async () => {
      const result = await readBiV1MetricDays({ get: async (path, params) => {
        expect(path).toBe("/api/admin/bi/v1/metrics");
        expect(params).toEqual({ pid: "PH", startDate: "2026-09-21", endDate: "2026-09-23",
          granularity: "day", metricCodes: codes.join(","), includeIncomplete: "true",
          dimensions: Object.keys(filters).join(","), dimensionFilters: scopeName });
        return { code: 200, msg: { ...message([]), rows: codes.flatMap(code => [
          { ...makeRow(code, "ratio", null, 0, 0, {}, "SOURCE_INCOMPLETE"), businessDate: undefined },
          makeRow(code, "ratio", null, 0, 0, {}, "SOURCE_INCOMPLETE"),
          { ...makeRow(code, "ratio", null, 0, 0, filters, "SOURCE_INCOMPLETE"), businessDate: undefined },
          makeRow(code, "ratio", 0.8, 8, 10, filters)
        ]) } };
      } }, query);
      for (const code of codes) {
        const key = biV1MetricKey(code, filters);
        expect(result.days[0].metrics[key]).toEqual({ state: "available", dataStatus: "READY", value: 0.8, numerator: 8, denominator: 10, unit: "ratio" });
        expect(result.days[1].metrics[key]).toEqual({ state: "no_value", dataStatus: "SOURCE_INCOMPLETE", value: null, numerator: null, denominator: null, unit: null });
        expect(result.days[0].metrics[code]).toBeUndefined();
      }
    });

    test(`${scopeName} 总体 SOURCE_INCOMPLETE 不能伪装成该分组的源状态`, async () => {
      const result = await readBiV1MetricDays({ get: async () => ({ code: 200, msg: { ...message([]),
        rows: codes.map(code => ({ ...makeRow(code, "ratio", null, 0, 0, {}, "SOURCE_INCOMPLETE"), businessDate: undefined }))
      } }) }, query);
      for (const day of result.days) for (const code of codes) {
        expect(day.metrics[biV1MetricKey(code, filters)]).toEqual({ state: "source_failure", dataStatus: null, value: null, numerator: null, denominator: null, unit: null });
      }
    });
  }
});

describe("bi-v1 金额、时长与同群付费率", () => {
  const query = { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-21", metricCodes: ["M058", "M061", "M064", "M102"] as const };
  const rows = [
    makeRow("M058", "currency", 162.02, 162.02, 0),
    makeRow("M061", "ratio", 5 / 6, 5, 6),
    makeRow("M064", "ratio", 1, 3, 3),
    makeRow("M102", "seconds", 64, 64, 0)
  ];

  test("四项正式指标由实际请求返回，金额为人民币元、时长为秒且保持来源元数据", async () => {
    let calls = 0;
    const payload = message(rows);
    const result = await readBiV1MetricDays({ get: async (path, params) => {
      calls++;
      expect(path).toBe("/api/admin/bi/v1/metrics");
      expect(params).toEqual({ pid: "PH", startDate: "2026-09-21", endDate: "2026-09-22", granularity: "day", metricCodes: "M058,M061,M064,M102", includeIncomplete: "true" });
      return { code: 200, msg: payload };
    } }, query);
    expect(calls).toBe(1);
    expect(result.message).toEqual(payload);
    for (const row of rows) {
      expect(biV1MetricCodeSchema.safeParse(row.metricCode).success).toBe(true);
      expect(result.days[0].metrics[row.metricCode]).toEqual({ state: "available", dataStatus: "READY", value: row.value, numerator: row.numerator, denominator: row.denominator, unit: row.unit });
    }
  });

  test("总体、新用户、自然与内部导量金额按精确请求切片读取，不拼成总体", async () => {
    const slices: { filters?: BiV1MetricDimensionFilters; dimensions: Record<string, unknown>; value: number }[] = [
      { dimensions: {}, value: 162.02 },
      { filters: { userCohort: "new" }, dimensions: { userType: "new" }, value: 141.02 },
      { filters: { sourceType: "natural" }, dimensions: { acquisitionType: "natural" }, value: 138.02 },
      { filters: { sourceType: "internal_channel" }, dimensions: { acquisitionType: "internal" }, value: 24 }
    ];
    const calls: string[] = [];
    for (const slice of slices) {
      const result = await readBiV1MetricDays({ get: async (_path, params) => {
        calls.push(params.dimensionFilters ?? "{}");
        const selected = slices.find(candidate => JSON.stringify(candidate.filters ?? {}) === (params.dimensionFilters ?? "{}"));
        expect(selected).toBeDefined();
        return { code: 200, msg: message([makeRow("M058", "currency", selected!.value, selected!.value, 0, selected!.dimensions)]) };
      } }, { ...query, metricCodes: ["M058"], ...(slice.filters ? { dimensionFilters: slice.filters } : {}) });
      const key = biV1MetricKey("M058", slice.filters ?? {});
      expect(result.days[0].metrics[key]).toMatchObject({ state: "available", value: slice.value, numerator: slice.value, denominator: 0, unit: "currency" });
      expect(Object.keys(result.days[0].metrics)).toEqual([key]);
    }
    expect(calls).toEqual(["{}", '{"userCohort":"new"}', '{"sourceType":"natural"}', '{"sourceType":"internal_channel"}']);
  });

  for (const [code, unit] of [["M058", "currency"], ["M102", "seconds"]] as const) {
    for (const value of [0, 0.01, 64.125, Number.MAX_SAFE_INTEGER]) {
      test(`${code} 接受非负安全标量 ${value}，零分母不解释为比率`, async () => {
        const result = await readBiV1MetricDays({ get: async () => ({ code: 200, msg: message([makeRow(code, unit, value, value, 0)]) }) }, { ...query, metricCodes: [code] });
        expect(result.days[0].metrics[code]).toEqual({ state: "available", dataStatus: "READY", value, numerator: value, denominator: 0, unit });
      });
    }

    for (const [label, value, numerator, denominator] of [
      ["缺少数值", null, 0, 0],
      ["分子不一致", 64.125, 64, 0],
      ["分母不为零", 64, 64, 1],
      ["数值不安全", 2 ** 53, 2 ** 53, 0],
      ["分子不安全", 1, 2 ** 53, 0],
      ["负数", -1, -1, 0],
      ["非有限数值", Infinity, Infinity, 0],
      ["非数值", NaN, NaN, 0]
    ] as const) {
      test(`${code} ${label}独立无效，同批正常指标继续可用`, () => {
        const result = aggregateBiV1MetricDays(message([makeRow(code, unit, value, numerator, denominator), makeRow("M016", "count", 6, 6, 0)]), { ...query, metricCodes: [code, "M016"] });
        expect(result[0].metrics[code]).toEqual({ state: "invalid_value", dataStatus: null, value: null, numerator: null, denominator: null, unit: null });
        expect(result[0].metrics.M016).toMatchObject({ state: "available", value: 6, unit: "count" });
      });
    }
  }

  for (const row of rows) {
    for (const unit of ["count", "ratio", "count_per_user", "seconds", "currency"] as const) {
      if (unit === row.unit) continue;
      test(`${row.metricCode} 单位漂移至 ${unit} 独立无效`, async () => {
        const result = await readBiV1MetricDays({ get: async () => ({ code: 200, msg: message([{ ...row, unit }, makeRow("M016", "count", 6, 6, 0)]) }) }, { ...query, metricCodes: [row.metricCode, "M016"] });
        expect(result.days[0].metrics[row.metricCode]).toMatchObject({ state: "invalid_value", dataStatus: null, value: null });
        expect(result.days[0].metrics.M016).toMatchObject({ state: "available", value: 6 });
      });
    }

    for (const [dataStatus, state] of [["PROCESSING", "no_value"], ["NOT_MATURE", "immature"], ["SOURCE_INCOMPLETE", "no_value"], ["FAILED", "source_failure"]] as const) {
      test(`${row.metricCode} ${dataStatus} 不消费所携带的错误业务值，缺日保留缺失`, async () => {
        for (const value of [null, 999]) {
          const result = await readBiV1MetricDays({ get: async () => ({ code: 200, msg: message([{ ...row, dataStatus, value }, makeRow("M016", "count", 6, 6, 0)]) }) }, { ...query, endDate: "2026-09-22", metricCodes: [row.metricCode, "M016"] });
          expect(result.days[0].metrics[row.metricCode]).toEqual({ state, dataStatus, value: null, numerator: null, denominator: null, unit: null,
            ...(dataStatus === "SOURCE_INCOMPLETE" && row.unit === "ratio" ? { diagnosticInputs: { numerator: row.numerator, denominator: row.denominator } } : {}) });
          expect(result.days[1].metrics[row.metricCode]).toMatchObject({ state: "no_record", dataStatus: null, value: null });
          expect(result.days[0].metrics.M016).toMatchObject({ state: "available", value: 6 });
        }
      });
    }
  }

  test("新增标量不放宽计数与比率的安全整数约束，不允许其他指标使用标量单位", () => {
    for (const row of [
      makeRow("M016", "count", 1.5, 1.5, 0),
      makeRow("M016", "count", 2 ** 53, 2 ** 53, 0),
      makeRow("M016", "currency", 6, 6, 0),
      makeRow("M016", "seconds", 6, 6, 0),
      makeRow("M081", "ratio", .5, 1.5, 3),
      makeRow("M081", "ratio", 1 / 1.5, 1, 1.5),
      makeRow("M110", "count_per_user", .5, 1.5, 3)
    ]) {
      const result = aggregateBiV1MetricDays(message([rows[0], rows[3], row]), { ...query, metricCodes: ["M058", "M102", row.metricCode] });
      expect(result[0].metrics[row.metricCode]).toMatchObject({ state: "invalid_value", value: null });
      expect(result[0].metrics.M058).toMatchObject({ state: "available", value: 162.02 });
      expect(result[0].metrics.M102).toMatchObject({ state: "available", value: 64 });
    }
  });

  for (const invalid of [{ value: "162.02" }, { numerator: null }, { denominator: null }, { unit: "cents" }, { value: Infinity }, { value: -1 }] as const) {
    test(`金额结构错误隔离后其他新增指标仍可读：${JSON.stringify(invalid)}`, async () => {
      const calls: string[] = [];
      const result = await readBiV1MetricDays({ get: async (_path, params) => {
        calls.push(params.metricCodes);
        return { code: 200, msg: { ...message([]), rows: rows.map(row => row.metricCode === "M058" ? { ...row, ...invalid } : row).filter(row => params.metricCodes.split(",").includes(row.metricCode)) } };
      } }, query);
      expect(calls).toEqual(["M058,M061,M064,M102", ...query.metricCodes]);
      expect(result.message).toBeNull();
      expect(result.days[0].metrics.M058).toMatchObject({ state: "source_failure", dataStatus: null, value: null });
      expect(result.days[0].metrics.M061).toMatchObject({ state: "available", value: 5 / 6, numerator: 5, denominator: 6 });
      expect(result.days[0].metrics.M064).toMatchObject({ state: "available", value: 1, numerator: 3, denominator: 3 });
      expect(result.days[0].metrics.M102).toMatchObject({ state: "available", value: 64, unit: "seconds" });
    });
  }

  test("金额和时长的越界PID或日期先于值错误拒绝，不进入指标隔离", async () => {
    for (const row of [rows[0], rows[3]]) {
      for (const scope of [{ dimensions: { pid: "OTHER" } }, { businessDate: "2026-09-20" }, { businessDate: "2026-09-22" }]) {
        let calls = 0;
        await expect(readBiV1MetricDays({ get: async () => {
          calls++;
          return { code: 200, msg: { ...message([]), rows: [{ ...row, ...scope, numerator: null }] } };
        } }, query)).rejects.toMatchObject({ code: "BI_V1_SCOPE_CONFLICT" });
        expect(calls).toBe(1);
      }
    }
  });

  test("金额和时长额外交叉维度不覆盖精确筛选结果，也不把筛选结果当成总体", async () => {
    const scalarRows = [rows[0], rows[3]];
    const client = { get: async () => ({ code: 200, msg: { ...message([]), rows: scalarRows.flatMap(row => [
      { ...row, dimensions: { pid: "PH", userType: "new" } },
      { ...row, value: null, numerator: null, dimensions: { pid: "PH", userType: "new", clientPlatform: "ios" } }
    ]) } }) };
    const selected = await readBiV1MetricDays(client, { ...query, metricCodes: ["M058", "M102"], dimensionFilters: { userCohort: "new" } });
    expect(selected.days[0].metrics[biV1MetricKey("M058", ["new"])]).toMatchObject({ state: "available", value: 162.02 });
    expect(selected.days[0].metrics[biV1MetricKey("M102", ["new"])]).toMatchObject({ state: "available", value: 64 });
    const overall = await readBiV1MetricDays(client, { ...query, metricCodes: ["M058", "M102"] });
    expect(overall.days[0].metrics.M058).toMatchObject({ state: "source_failure", value: null });
    expect(overall.days[0].metrics.M102).toMatchObject({ state: "source_failure", value: null });
  });
});

describe("bi-v1 付费与广告独立人数", () => {
  test("M059/M094使用count计数并保留独立新用户范围", async () => {
    const rows = [makeRow("M059", "count", 3, 3, 0, { userCohort: "new" }), makeRow("M094", "count", 2, 2, 0, { userCohort: "new" })];
    const result = await readBiV1MetricDays({ get: async (_path, params) => {
      expect(params.metricCodes).toBe("M059,M094");
      expect(JSON.parse(params.dimensionFilters)).toEqual({ userCohort: "new" });
      return { code: 200, msg: message(rows) };
    } }, { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-21", metricCodes: ["M059", "M094"], dimensionFilters: { userCohort: "new" }, dimensions: ["userCohort"] });
    expect(result.days[0].metrics[biV1MetricKey("M059", ["new"])])
      .toMatchObject({ state: "available", dataStatus: "READY", value: 3, numerator: 3, denominator: 0, unit: "count" });
    expect(result.days[0].metrics[biV1MetricKey("M094", ["new"])])
      .toMatchObject({ state: "available", dataStatus: "READY", value: 2, numerator: 2, denominator: 0, unit: "count" });
    expect(result.days[0].metrics.M059).toBeUndefined();
    expect(result.days[0].metrics.M094).toBeUndefined();
  });
});

describe("bi-v1 私有规则版本准入", () => {
  const expectedRuleVersions = { M058: "paid-order-value-v1", M102: "foreground-watch-duration-v1" };
  const query = { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-22", metricCodes: ["M058", "M102"] as const, expectedRuleVersions };

  for (const [code, unit] of [["M058", "currency"], ["M102", "seconds"]] as const) {
    for (const ruleVersion of ["", "other-rule-v1", `${expectedRuleVersions[code]}-next`]) {
      test(`${code} READY规则 ${JSON.stringify(ruleVersion)} 单日拒绝，不混入已准入的前日或相邻指标`, async () => {
        const other = code === "M058" ? "M102" : "M058";
        const rows = [
          { ...makeRow(code, unit, 64, 64, 0), ruleVersion: expectedRuleVersions[code] },
          { ...makeRow(code, unit, 128, 128, 0), businessDate: "2026-09-22", ruleVersion },
          { ...makeRow(other, other === "M058" ? "currency" : "seconds", 20, 20, 0), businessDate: "2026-09-22", ruleVersion: expectedRuleVersions[other] }
        ];
        const result = await readBiV1MetricDays({ get: async (_path, params) => {
          expect(params).toEqual({ pid: "PH", startDate: "2026-09-21", endDate: "2026-09-23", granularity: "day", metricCodes: "M058,M102", includeIncomplete: "true" });
          return { code: 200, msg: message(rows) };
        } }, query);
        expect(result.days[0].metrics[code]).toMatchObject({ state: "available", value: 64 });
        expect(result.days[1].metrics[code]).toEqual({ state: "invalid_value", dataStatus: null, value: null, numerator: null, denominator: null, unit: null });
        expect(result.days[1].metrics[other]).toMatchObject({ state: "available", value: 20 });
        expect(result.message?.rows.map(row => row.ruleVersion)).toEqual(rows.map(row => row.ruleVersion));
      });
    }

    for (const [dataStatus, state] of [["PROCESSING", "no_value"], ["NOT_MATURE", "immature"], ["SOURCE_INCOMPLETE", "no_value"], ["FAILED", "source_failure"]] as const) {
      test(`${code} ${dataStatus}仍由来源状态决定，不要求未就绪行提供已准入规则`, () => {
        const result = aggregateBiV1MetricDays(message([{ ...makeRow(code, unit, 999, 1, 0, {}, dataStatus), ruleVersion: "" }]), { ...query, metricCodes: [code] });
        expect(result[0].metrics[code]).toEqual({ state, dataStatus, value: null, numerator: null, denominator: null, unit: null });
      });
    }
  }

  test("字段错误拆单恢复仍保留规则准入，原始规则不同的标量不会恢复成可用值", async () => {
    const calls: string[] = [];
    const rows = [
      { ...makeRow("M058", "currency", 162.02, 162.02, 0), ruleVersion: "paid-order-value-v2" },
      { ...makeRow("M102", "seconds", 64, 64, 0), ruleVersion: expectedRuleVersions.M102 },
      { ...makeRow("M016", "count", 6, 6, 0), numerator: null }
    ];
    const result = await readBiV1MetricDays({ get: async (_path, params) => {
      calls.push(params.metricCodes);
      expect(Object.keys(params)).not.toContain("expectedRuleVersions");
      return { code: 200, msg: { ...message([]), rows: rows.filter(row => params.metricCodes.split(",").includes(row.metricCode)) } };
    } }, { ...query, metricCodes: ["M058", "M102", "M016"] });
    expect(calls).toEqual(["M058,M102,M016", "M058", "M102", "M016"]);
    expect(result.days[0].metrics.M058).toMatchObject({ state: "invalid_value", value: null });
    expect(result.days[0].metrics.M102).toMatchObject({ state: "available", value: 64 });
    expect(result.days[0].metrics.M016).toMatchObject({ state: "source_failure", value: null });
  });

  test("未声明规则约束的原指标继续按现有契约解析，不比较不同指标的规则字串", async () => {
    const rows = [
      { ...makeRow("M058", "currency", 162.02, 162.02, 0), ruleVersion: expectedRuleVersions.M058 },
      { ...makeRow("M016", "count", 6, 6, 0), ruleVersion: "active-user-v3" }
    ];
    const result = await readBiV1MetricDays({ get: async () => ({ code: 200, msg: message(rows) }) }, { ...query, metricCodes: ["M058", "M016"] });
    expect(result.days[0].metrics.M058).toMatchObject({ state: "available", value: 162.02 });
    expect(result.days[0].metrics.M016).toMatchObject({ state: "available", value: 6 });
  });

  test("非法本地规则配置在联网前拒绝", async () => {
    for (const rules of [{ M058: "" }, { M999: "rule-v1" }, { M058: 123 }, { M058: "x".repeat(129) }]) {
      let calls = 0;
      await expect(queryBiV1Metrics({ get: async () => { calls++; return {}; } }, { ...query, expectedRuleVersions: rules as never })).rejects.toMatchObject({ code: "BI_V1_REQUEST_REJECTED" });
      expect(calls).toBe(0);
    }
  });
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
    const result = await readBiV1MetricDays({ get: async (_path, params) => {
      calls++;
      const filters = JSON.parse(params.dimensionFilters);
      expect(filters).toEqual({ userCohort: "new" });
      return { code: 200, msg: message([
        makeRow("M110", "count_per_user", 2 / 3, 2, 3, { userType: filters.userCohort }),
        makeRow("M113", "count", 4, 4, 0, filters),
        makeRow("M114", "ratio", .5, 2, 4, filters)
      ]) };
    } }, { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-21", metricCodes: ["M110", "M113", "M114"], dimensionFilters: { userCohort: "new" } });
    expect(calls).toBe(1);
    expect(result.message).not.toBeNull();
    expect(result.days[0].metrics[biV1MetricKey("M110", ["new"])]).toMatchObject({
      state: "available", dataStatus: "READY", value: 2 / 3, numerator: 2, denominator: 3, unit: "count_per_user"
    });
    expect(result.days[0].metrics[biV1MetricKey("M113", ["new"])]).toMatchObject({ state: "available", value: 4, unit: "count" });
    expect(result.days[0].metrics[biV1MetricKey("M114", ["new"])]).toMatchObject({ state: "available", value: .5, unit: "ratio" });
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
      const result = await readBiV1MetricDays({ get: async (_path, params) => {
        expect(params.dimensions).toBe("paymentMethod");
        return { code: 200, msg: message([
        ...["ali_pay", "wx_pay", "usdt_pay", "unknown"].map((value, index) => makeRow("M113", "count", index + 1, index + 1, 0, { [field]: value }))
      ]) }; } }, { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-21", metricCodes: ["M113"], dimensions: ["paymentMethod"] });
      expect(result.days[0].metrics.M113).toBeUndefined();
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
    const payload = { ...message([]), rows: [
      makeRow("M113", "count", 12, 12, 0),
      makeRow("M113", "count", 4, 4, 0, { paymentMethod: "wx_pay" }),
      makeRow("M113", "count", 2, 2, 0, { paymentMethod: "unknown" }),
      makeRow("M016", "count", 10, 10, 0),
      ...isolatedDimensions.map(dimensions => ({ ...makeRow("M113", "count", null, 0, 0, dimensions, "FAILED"), businessDate: undefined }))
    ] };
    const query = { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-22", metricCodes: ["M113", "M016"] as const };
    const result = aggregateBiV1MetricDays(payload, query);
    const grouped = aggregateBiV1MetricDays(payload, { ...query, dimensions: ["paymentMethod"] });
    expect(result[0].metrics.M113).toMatchObject({ state: "available", value: 12 });
    expect(grouped[0].metrics[biV1MetricKey("M113", ["wechat"])]).toMatchObject({ state: "available", value: 4 });
    expect(grouped[0].metrics[biV1MetricKey("M113", ["unknown"])]).toMatchObject({ state: "available", value: 2 });
    expect(result[0].metrics.M016).toMatchObject({ state: "available", value: 10 });
    expect(result[1].metrics.M113).toMatchObject({ state: "source_failure", dataStatus: null, value: null });
    for (const dimensions of isolatedDimensions) {
      const key = biV1MetricKey("M113", dimensions);
      expect(key.startsWith("M113|unmapped:")).toBe(true);
      for (const day of result) expect(day.metrics[key]).toBeUndefined();
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
    expect(result[0].metrics.M003).toMatchObject({ state: "source_failure", dataStatus: null, value: null });
    expect(result[0].metrics[biV1MetricKey("M003", { channel: "a" })]).toBeUndefined();
    expect(result[0].metrics[biV1MetricKey("M003", { channel: "b" })]).toBeUndefined();
  });

  test("总体与交叉维度独立返回，字段名别名不改变业务切片", () => {
    const payload = message([
      makeRow("M016", "count", 10, 10, 0),
      makeRow("M016", "count", 4, 4, 0, { clientPlatform: "Android", userType: "old_user" }),
      makeRow("M016", "count", 3, 3, 0, { platform: "iOS", audience: "老用户" }),
      makeRow("M020", "ratio", .6, 6, 10, { d0Platform: "Android" }),
      makeRow("M113", "count", 2, 2, 0, { payment_method: "ali_pay" })
    ]);
    const query = { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-21", metricCodes: ["M016", "M020", "M113"] as const };
    const result = aggregateBiV1MetricDays(payload, query);
    const cross = aggregateBiV1MetricDays(payload, { ...query, dimensions: ["clientPlatform", "userCohort"] });
    const platform = aggregateBiV1MetricDays(payload, { ...query, dimensions: ["clientPlatform"] });
    const payment = aggregateBiV1MetricDays(payload, { ...query, dimensions: ["paymentMethod"] });
    expect(result[0].metrics.M016).toMatchObject({ state: "available", value: 10 });
    expect(cross[0].metrics[biV1MetricKey("M016", ["android", "old"])]).toMatchObject({ state: "available", value: 4 });
    expect(cross[0].metrics[biV1MetricKey("M016", ["ios", "old"])]).toMatchObject({ state: "available", value: 3 });
    expect(platform[0].metrics[biV1MetricKey("M020", ["android"])]).toMatchObject({ state: "available", value: .6, numerator: 6, denominator: 10 });
    expect(payment[0].metrics[biV1MetricKey("M113", ["alipay"])]).toMatchObject({ state: "available", value: 2 });
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
    const query = {
      pid: "PH", startDate: "2026-09-21", endDate: "2026-09-21", metricCodes: ["M016", "M113"]
    } as const;
    const result = aggregateBiV1MetricDays(message(rows), query);
    const platform = aggregateBiV1MetricDays(message(rows), { ...query, dimensionFilters: { clientPlatform: "android" } });
    const cohort = aggregateBiV1MetricDays(message(rows), { ...query, dimensionFilters: { userCohort: "old" } });
    const payment = aggregateBiV1MetricDays(message(rows), { ...query, dimensionFilters: { paymentMethod: "ali_pay" } });
    expect(result[0].metrics.M016).toMatchObject({ state: "available", value: 20 });
    expect(platform[0].metrics[biV1MetricKey("M016", ["android"])]).toMatchObject({ state: "available", value: 8 });
    expect(cohort[0].metrics[biV1MetricKey("M016", ["old"])]).toMatchObject({ state: "available", value: 4 });
    expect(result[0].metrics[biV1MetricKey("M016", ["android", "old"])]).toBeUndefined();
    expect(payment[0].metrics[biV1MetricKey("M113", ["alipay"])]).toMatchObject({ state: "available", value: 9 });
    for (const row of rows.filter(row => biV1MetricKey(row.metricCode, row.dimensions).includes("unmapped:")))
      expect(result[0].metrics[biV1MetricKey(row.metricCode, row.dimensions)]).toBeUndefined();
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
      expect(dimensionOnly[0].metrics.M016).toMatchObject({ state: "source_failure", value: null });
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
    const payload = { ...message([]), rows: [
      globalRow({ channel: "android" }, "FAILED"),
      globalRow({ videoType: "android" }, "SOURCE_INCOMPLETE"),
      globalRow({ channel: "" }, "PROCESSING"),
      makeRow("M016", "count", 10, 10, 0),
      makeRow("M016", "count", 4, 4, 0, { clientPlatform: "android" }),
      makeRow("M016", "count", 3, 3, 0, { clientPlatform: "ios" }),
      makeRow("M016", "count", 3, 3, 0, { platform: "iOS" })
    ] };
    const query = { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-22", metricCodes: ["M016"] as const };
    const result = aggregateBiV1MetricDays(payload, query);
    const platform = aggregateBiV1MetricDays(payload, { ...query, dimensions: ["clientPlatform"] });
    expect(result[0].metrics.M016).toMatchObject({ state: "available", value: 10 });
    expect(platform[0].metrics[biV1MetricKey("M016", ["android"])]).toMatchObject({ state: "available", value: 4 });
    expect(platform[0].metrics[biV1MetricKey("M016", ["ios"])]).toMatchObject({ state: "invalid_value", value: null });
    for (const day of result) {
      expect(day.metrics[biV1MetricKey("M016", { channel: "android" })]).toBeUndefined();
      expect(day.metrics[biV1MetricKey("M016", { videoType: "android" })]).toBeUndefined();
    }
    expect(result[1].metrics.M016).toMatchObject({ state: "source_failure", dataStatus: null, value: null });
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
    const count = makeRow("M003", "count", 1, 1, 0);
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

describe("bi-v1 显式维度请求", () => {
  const query = { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-21", metricCodes: ["M016"] as const };

  for (const [filter, alias] of [
    [{ clientPlatform: "android" }, { platform: "Android" }],
    [{ clientPlatform: "ios" }, { registerPlatform: "iOS" }],
    [{ clientPlatform: "web" }, { d0Platform: "web" }],
    [{ userCohort: "new" }, { userType: "new_user" }],
    [{ userCohort: "old" }, { audience: "老用户" }],
    [{ sourceType: "natural" }, { acquisitionType: "organic" }],
    [{ sourceType: "internal_channel" }, { acquisitionType: "internal_traffic" }],
    [{ paymentMethod: "ali_pay" }, { payment_method: "支付宝" }],
    [{ paymentMethod: "wx_pay" }, { payment_method: "wechat" }],
    [{ paymentMethod: "usdt_pay" }, { payment_method: "usdt" }],
    [{ paymentMethod: "unknown" }, { payment_method: "unknown" }],
    [{ clientPlatform: "android", userCohort: "old" }, { audience: "android_old_user" }]
  ] as const) {
    test(`正式筛选 ${JSON.stringify(filter)} 作为 JSON 发送，返回别名仅命中对应切片`, async () => {
      const result = await readBiV1MetricDays({ get: async (_path, params) => {
        expect(params.dimensionFilters).toBe(JSON.stringify(filter));
        expect(params.dimensions).toBeUndefined();
        expect(params.granularity).toBe("day");
        const requestedFilters = JSON.parse(params.dimensionFilters);
        const rows = JSON.stringify(requestedFilters) === JSON.stringify(filter)
          ? [makeRow("M016", "count", 7, 7, 0, alias)] : [];
        return { code: 200, msg: message(rows) };
      } }, { ...query, dimensionFilters: filter });
      expect(result.days[0].metrics[biV1MetricKey("M016", filter)]).toMatchObject({ state: "available", value: 7 });
      expect(result.days[0].metrics.M016).toBeUndefined();
    });
  }

  test("同一上游夹具按实际筛选分别返回新老用户，未筛选不会暗带新用户", async () => {
    const calls: string[] = [];
    const client = { get: async (_path: string, params: Record<string, string>) => {
      const filters = JSON.parse(params.dimensionFilters ?? "{}");
      calls.push(filters.userCohort ?? "overall");
      return { code: 200, msg: message(filters.userCohort === "new"
        ? [makeRow("M110", "count_per_user", 2 / 3, 2, 3, filters)]
        : filters.userCohort === "old"
          ? [makeRow("M110", "count_per_user", 3 / 4, 3, 4, filters)]
          : [makeRow("M110", "count_per_user", null, 0, 0, {}, "SOURCE_INCOMPLETE")]) };
    } };
    for (const userCohort of ["new", "old"] as const) {
      const result = await readBiV1MetricDays(client, { ...query, metricCodes: ["M110"], dimensionFilters: { userCohort } });
      expect(result.days[0].metrics[biV1MetricKey("M110", [userCohort])]).toMatchObject({
        state: "available", value: userCohort === "new" ? 2 / 3 : 3 / 4
      });
    }
    const overall = await readBiV1MetricDays(client, { ...query, metricCodes: ["M110"] });
    expect(overall.days[0].metrics.M110).toMatchObject({ state: "no_value", dataStatus: "SOURCE_INCOMPLETE", value: null });
    expect(calls).toEqual(["new", "old", "overall"]);
  });

  test("过滤键缺失、错值或额外交叉维度仅隔离不匹配行，保留同日精确结果", async () => {
    const result = await readBiV1MetricDays({ get: async (_path, params) => {
      expect(JSON.parse(params.dimensionFilters)).toEqual({ userCohort: "new" });
      return { code: 200, msg: message([
        makeRow("M110", "count_per_user", 2 / 3, 2, 3, { userCohort: "new" }),
        makeRow("M110", "count_per_user", 10, 10, 1),
        makeRow("M110", "count_per_user", 10, 10, 1, { userCohort: "old" }),
        makeRow("M110", "count_per_user", 10, 10, 1, { userCohort: "new", clientPlatform: "android" }),
        makeRow("M110", "count_per_user", 10, 10, 1, { userCohort: "new", channel: "x" }),
        makeRow("M016", "count", 8, 8, 0)
      ]) };
    } }, { ...query, metricCodes: ["M110", "M016"], dimensionFilters: { userCohort: "new" } });
    expect(result.message?.rows).toHaveLength(1);
    expect(result.message?.dimensionConflicts).toHaveLength(5);
    expect(result.days[0].metrics[biV1MetricKey("M110", ["new"])]).toMatchObject({ state: "available", value: 2 / 3 });
    expect(result.days[0].metrics[biV1MetricKey("M016", ["new"])]).toEqual({ state: "source_failure", dataStatus: null, value: null, numerator: null, denominator: null, unit: null });
    expect(result.days[0].metrics.M110).toBeUndefined();
    expect(result.days[0].metrics.M016).toBeUndefined();
  });

  test("多余交叉行值结构错误不清空同指标精确结果，跨PID仍先拒绝", async () => {
    for (const pid of ["PH", "OTHER"]) {
      let calls = 0;
      const promise = readBiV1MetricDays({ get: async (_path, params) => {
        calls++;
        const filters = JSON.parse(params.dimensionFilters);
        return { code: 200, msg: { ...message([]), rows: [
          makeRow("M016", "count", 4, 4, 0, filters),
          { ...makeRow("M016", "count", 2, 2, 0, { pid, ...filters, clientPlatform: "android" }), numerator: null, unit: null }
        ] } };
      } }, { ...query, dimensionFilters: { userCohort: "new" } });
      if (pid === "OTHER") await expect(promise).rejects.toMatchObject({ code: "BI_V1_SCOPE_CONFLICT" });
      else expect((await promise).days[0].metrics[biV1MetricKey("M016", ["new"])]).toMatchObject({ state: "available", value: 4 });
      expect(calls).toBe(1);
    }
  });

  test("默认和显式空分组都只读取pid总体，单维响应不会变成总体", async () => {
    for (const dimensions of [undefined, []] as const) {
      const result = await readBiV1MetricDays({ get: async (_path, params) => {
        expect(params.dimensions).toBeUndefined();
        expect(params.dimensionFilters).toBeUndefined();
        return { code: 200, msg: message([makeRow("M016", "count", 3, 3, 0, { clientPlatform: "android" })]) };
      } }, { ...query, dimensions });
      expect(result.days[0].metrics.M016).toMatchObject({ state: "source_failure", dataStatus: null, value: null });
      expect(Object.keys(result.days[0].metrics)).toEqual(["M016"]);
    }
  });

  for (const dataStatus of ["READY", "FAILED", "SOURCE_INCOMPLETE", "NOT_MATURE"] as const) {
    test(`无日期总体 ${dataStatus} 不冒充所请求的新用户状态`, async () => {
      const result = await readBiV1MetricDays({ get: async () => ({ code: 200, msg: {
        ...message([]), rows: [{ ...makeRow("M016", "count", dataStatus === "READY" ? 8 : null, 8, 0, {}, dataStatus), businessDate: undefined }]
      } }) }, { ...query, endDate: "2026-09-22", dimensionFilters: { userCohort: "new" } });
      for (const day of result.days) {
        expect(day.metrics[biV1MetricKey("M016", ["new"])]).toMatchObject({ state: "source_failure", dataStatus: null, value: null });
        expect(day.metrics.M016).toBeUndefined();
      }
    });
  }

  test("分组字段和筛选字段组成精确范围，不产生总体或把各组求和", async () => {
    const result = await readBiV1MetricDays({ get: async (_path, params) => {
      const filters = JSON.parse(params.dimensionFilters);
      expect(filters).toEqual({ userCohort: "old" });
      expect(params.dimensions).toBe("clientPlatform");
      return { code: 200, msg: message([
        makeRow("M016", "count", 4, 4, 0, { ...filters, clientPlatform: "android" }),
        makeRow("M016", "count", 3, 3, 0, { ...filters, clientPlatform: "ios" }),
        makeRow("M016", "count", 100, 100, 0, filters),
        makeRow("M016", "count", 200, 200, 0)
      ]) };
    } }, { ...query, dimensionFilters: { userCohort: "old" }, dimensions: ["clientPlatform"] });
    expect(result.days[0].metrics[biV1MetricKey("M016", ["android", "old"])]).toMatchObject({ value: 4 });
    expect(result.days[0].metrics[biV1MetricKey("M016", ["ios", "old"])]).toMatchObject({ value: 3 });
    expect(result.days[0].metrics.M016).toBeUndefined();
    expect(result.days[0].metrics[biV1MetricKey("M016", ["old"])]).toBeUndefined();
  });

  test("同族重复别名一致时去重，冲突时不命中筛选结果", async () => {
    for (const [platform, state] of [["Android", "available"], ["ios", "source_failure"]] as const) {
      const result = await readBiV1MetricDays({ get: async () => ({ code: 200, msg: message([
        makeRow("M016", "count", 4, 4, 0, { clientPlatform: "android", platform })
      ]) }) }, { ...query, dimensionFilters: { clientPlatform: "android" } });
      expect(result.days[0].metrics[biV1MetricKey("M016", ["android"])]).toMatchObject({ state, value: state === "available" ? 4 : null });
    }
  });

  test("按指标恢复保留筛选、PID和日期，失败项只写本次切片", async () => {
    const calls: Record<string, string>[] = [];
    const result = await readBiV1MetricDays({ get: async (_path, params) => {
      calls.push(params);
      const filters = JSON.parse(params.dimensionFilters);
      if (params.metricCodes.includes("M008")) return { code: 400, err: "不支持指标 M008" };
      return { code: 200, msg: message([makeRow("M016", "count", 0, 0, 0, filters)]) };
    } }, { ...query, metricCodes: ["M008", "M016"], dimensionFilters: { userCohort: "new" } });
    expect(calls).toHaveLength(3);
    for (const params of calls) expect(params).toMatchObject({ pid: "PH", startDate: "2026-09-21", endDate: "2026-09-22", dimensionFilters: '{"userCohort":"new"}' });
    expect(result.days[0].metrics[biV1MetricKey("M008", ["new"])]).toMatchObject({ state: "source_failure", dataStatus: null, value: null });
    expect(result.days[0].metrics[biV1MetricKey("M016", ["new"])]).toMatchObject({ state: "available", value: 0 });
    expect(result.days[0].metrics.M008).toBeUndefined();
  });

  test("筛选无记录保持缺失，多日期状态只来自精确维度行", async () => {
    const result = await readBiV1MetricDays({ get: async (_path, params) => ({ code: 200, msg: {
      ...message([]), rows: [{ ...makeRow("M016", "count", null, 0, 0, JSON.parse(params.dimensionFilters), "SOURCE_INCOMPLETE"), businessDate: undefined }]
    } }) }, { ...query, metricCodes: ["M016", "M008"], endDate: "2026-09-22", dimensionFilters: { userCohort: "new" } });
    for (const day of result.days) {
      expect(day.metrics[biV1MetricKey("M016", ["new"])]).toMatchObject({ state: "no_value", dataStatus: "SOURCE_INCOMPLETE", value: null });
      expect(day.metrics[biV1MetricKey("M008", ["new"])]).toMatchObject({ state: "no_record", dataStatus: null, value: null });
    }
  });

  test("未匹配维度行仍必须通过PID与日期检查，值错误不掩盖范围问题", async () => {
    for (const overrides of [
      { dimensions: { pid: "OTHER", userCohort: "old" } },
      { businessDate: "2026-09-20", dimensions: { pid: "PH", userCohort: "old" } }
    ]) await expect(readBiV1MetricDays({ get: async () => ({ code: 200, msg: {
      ...message([]), rows: [{ ...makeRow("M016", "count", 3, 3, 0), ...overrides, numerator: null }]
    } }) }, { ...query, dimensionFilters: { userCohort: "new" } })).rejects.toMatchObject({ code: "BI_V1_SCOPE_CONFLICT" });
  });

  test("无效筛选在联网前拒绝，未声明的留存维度不擅自支持", async () => {
    let calls = 0;
    for (const filter of [{ clientPlatform: "old" }, { paymentMethod: "alipay" }, { channel: "android" }, { retentionDay: "D1" }]) {
      await expect(queryBiV1Metrics({ get: async () => { calls++; return { code: 200, msg: message([]) }; } }, {
        ...query, dimensionFilters: filter as unknown as BiV1MetricDimensionFilters
      })).rejects.toMatchObject({ code: "BI_V1_REQUEST_REJECTED", statusCode: 422 });
    }
    expect(calls).toBe(0);
  });

  test("summary 传排他区间并保留无日期总体，日聚合拒绝汇总", async () => {
    const summaryQuery = { ...query, metricCodes: ["M018"] as const, startDate: "2026-09-01", endDate: "2026-09-30", granularity: "summary" as const, dimensions: [] };
    const result = await queryBiV1Metrics({ get: async (_path, params) => {
      expect(params).toMatchObject({ granularity: "summary", startDate: "2026-09-01", endDate: "2026-10-01" });
      expect(params.dimensions).toBeUndefined();
      return { code: 200, msg: { ...message([]), rows: [{ ...makeRow("M018", "count", 3, 3, 0), businessDate: undefined }] } };
    } }, summaryQuery);
    expect(result.rows[0]).toMatchObject({ metricCode: "M018", value: 3 });
    expect(() => aggregateBiV1MetricDays(result, summaryQuery)).toThrow("汇总结果不能按日聚合");
  });

  test("M101 通用计数保留来源规则，忽略上游伪造的本地校验元数据", async () => {
    const result = await readBiV1MetricDays({ get: async (_path, params) => {
      expect(params.metricCodes).toBe("M101");
      return { code: 200, msg: { ...message([
        { ...makeRow("M101", "count", 3, 3, 0), ruleVersion: "legacy-content-view-count-v1" }
      ]), dimensionConflicts: [{ metricCode: "M101" }] } };
    } }, { ...query, metricCodes: ["M101"] });
    expect(result.message?.rows[0].ruleVersion).toBe("legacy-content-view-count-v1");
    expect(result.message?.dimensionConflicts).toBeUndefined();
    expect(result.days[0].metrics.M101).toMatchObject({ state: "available", value: 3 });
  });
});
