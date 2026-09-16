import { describe, expect, test } from "bun:test";
import { DEFAULT_VERSION_PERFORMANCE_VIEW, VERSION_AUDIENCES, VERSION_METRICS, VERSION_OPTIONS, changeVersionClient, parseVersionPerformanceView, searchVersionOptions, versionMetric, versionMetricAudienceScope, versionMetricInputs, versionMetricSupportsAudience, versionOption, versionsForScope, type VersionOption } from "./version-performance-model";
import { VERSION_FIXTURE_WATERMARK, allVersionKeysAreClientScoped, versionDistribution, versionMetricPoints, versionMetricSummary, versionPerformanceSheets, versionRetentionRows, versionScopeMetricPoints, versionScopeMetricSummary } from "./version-performance-fixtures";
import { focusVersionGroup, versionQueryKeys, versionQueryLabel } from "./version-performance-model";

const range = { start: "2026-09-02", end: "2026-09-08" };

describe("版本表现演示模型", () => {
  test("版本实体由客户端与版本名共同确定，全部范围保留两端目录且平台切换清理不兼容比较", () => {
    expect(allVersionKeysAreClientScoped()).toBe(true);
    expect(versionOption("android:6.8.0")?.key).not.toBe(versionOption("ios:6.8.0")?.key);
    expect(DEFAULT_VERSION_PERFORMANCE_VIEW.client).toBe("overall");
    expect(DEFAULT_VERSION_PERFORMANCE_VIEW).toMatchObject({ versionRange: "all", display: "groups" });
    expect(versionsForScope("overall").map(item => item.key)).toEqual(VERSION_OPTIONS.map(item => item.key));
    const changed = changeVersionClient({ ...DEFAULT_VERSION_PERFORMANCE_VIEW, comparison: "android:6.7.2" }, "ios");
    expect(changed.version.startsWith("ios:")).toBe(true);
    expect(changed.comparison).toBe("none");
    expect(VERSION_OPTIONS.filter(item => item.unknown).map(item => item.client).sort()).toEqual(["android", "ios"]);
  });

  test("视图白名单拒绝未知版本、跨端比较、自身比较与额外字段", () => {
    expect(parseVersionPerformanceView(DEFAULT_VERSION_PERFORMANCE_VIEW)).toEqual(DEFAULT_VERSION_PERFORMANCE_VIEW);
    const { audience: _legacyAudience, search: _legacySearch, versionRange: _legacyRange, display: _legacyDisplay, ...legacyView } = DEFAULT_VERSION_PERFORMANCE_VIEW;
    expect(parseVersionPerformanceView(legacyView)).toEqual({ ...DEFAULT_VERSION_PERFORMANCE_VIEW, versionRange: "focused" });
    const { search: _search, ...audienceView } = { ...DEFAULT_VERSION_PERFORMANCE_VIEW, audience: "new" as const };
    expect(parseVersionPerformanceView(audienceView)).toEqual({ ...DEFAULT_VERSION_PERFORMANCE_VIEW, audience: "overall" });
    expect(parseVersionPerformanceView({ ...DEFAULT_VERSION_PERFORMANCE_VIEW, metric: "M020", audience: "new" })).toMatchObject({ metric: "M020", audience: "overall" });
    for (const invalid of [
      { ...DEFAULT_VERSION_PERFORMANCE_VIEW, comparison: "garbage" },
      { ...DEFAULT_VERSION_PERFORMANCE_VIEW, comparison: "ios:6.8.0" },
      { ...DEFAULT_VERSION_PERFORMANCE_VIEW, comparison: DEFAULT_VERSION_PERFORMANCE_VIEW.version },
      { ...DEFAULT_VERSION_PERFORMANCE_VIEW, audience: "garbage" },
      { ...DEFAULT_VERSION_PERFORMANCE_VIEW, extra: true }
    ]) expect(parseVersionPerformanceView(invalid)).toBeNull();
  });

  test("同名版本聚焦保留两端实体，旧链接维持精确版本且清除旧人群条件", () => {
    const grouped = focusVersionGroup(DEFAULT_VERSION_PERFORMANCE_VIEW, "6.8.0", "ios");
    expect(grouped).toMatchObject({ versionGroup: "6.8.0", focusClient: "ios", versionRange: "focused", audience: "overall" });
    expect(versionQueryKeys(grouped)).toEqual(["android:6.8.0", "ios:6.8.0"]);
    expect(versionQueryLabel(grouped)).toBe("6.8.0 · Android / iOS");
    expect(parseVersionPerformanceView(grouped)).toEqual(grouped);
    const legacy = parseVersionPerformanceView({ ...DEFAULT_VERSION_PERFORMANCE_VIEW, versionRange: "focused", audience: "existing", version: "ios:6.8.0" })!;
    expect(legacy.audience).toBe("overall");
    expect(versionQueryKeys(legacy)).toEqual(["ios:6.8.0"]);
    expect(versionQueryLabel(legacy)).toBe("iOS · 6.8.0");
    expect(focusVersionGroup(grouped, "6.7.2", "ios")).toEqual(grouped);
    expect(parseVersionPerformanceView({ ...grouped, versionGroup: "6.7.2" })).toBeNull();
    expect(parseVersionPerformanceView({ ...grouped, versionGroup: "unknown release" })).toBeNull();
    expect(parseVersionPerformanceView({ ...grouped, focusClient: "web" })).toBeNull();
    expect(parseVersionPerformanceView({ ...grouped, versionRange: "all" })).toBeNull();
  });

  test("指标名称与公式来自权威投影，M024单独保留存量与冻结规则", () => {
    expect(VERSION_METRICS.map(item => item.id)).toEqual(["M091", "M080", "M016", "M083", "M031", "M081", "M036", "M020", "M024"]);
    expect(versionMetric("M031").definition).toContain("结果等待窗口已结束");
    expect(versionMetric("M024").attribution).toContain("注册满 2 天");
    expect(versionMetricInputs("M031")).toEqual({ numerator: "视频首帧成功展示的播放尝试数", denominator: "结果等待窗口已结束的有效播放尝试次数" });
    expect(versionMetricInputs("M091")).toEqual({ numerator: versionMetric("M091").name, denominator: "—" });
    expect(VERSION_METRICS.some(item => item.name.includes("整体活跃"))).toBe(false);
  });

  test("新老用户是同指标交叉维度，启动保留未分类且固定留存不机械拆分", () => {
    expect(VERSION_AUDIENCES.map(item => item.id)).toEqual(["overall", "new", "existing"]);
    expect(versionMetricSupportsAudience("M016")).toBe(true);
    expect(versionMetricSupportsAudience("M020")).toBe(false);
    expect(versionMetricAudienceScope("M020")).toContain("注册批次");
    expect(versionMetricAudienceScope("M024")).toContain("注册满 2 天");

    const activeOverall = versionMetricSummary("android:6.8.0", "M016", range, false, "overall");
    const activeNew = versionMetricSummary("android:6.8.0", "M016", range, false, "new");
    const activeExisting = versionMetricSummary("android:6.8.0", "M016", range, false, "existing");
    expect(activeNew.value! + activeExisting.value!).toBeLessThan(activeOverall.value!);

    const launchesOverall = versionMetricSummary("android:6.8.0", "M091", range, false, "overall");
    const launchesNew = versionMetricSummary("android:6.8.0", "M091", range, false, "new");
    const launchesExisting = versionMetricSummary("android:6.8.0", "M091", range, false, "existing");
    expect(launchesNew.value! + launchesExisting.value!).toBeLessThan(launchesOverall.value!);
    const newStartupPoints = versionMetricPoints("android:6.8.0", "M080", range, false, "new");
    const newStartup = versionMetricSummary("android:6.8.0", "M080", range, false, "new");
    expect(newStartup).toMatchObject({ state: "available", availableDays: 7, totalDays: 7 });
    expect(newStartup.numerator).toBe(newStartupPoints.reduce((total, point) => total + (point.numerator ?? 0), 0));
    expect(newStartup.denominator).toBe(newStartupPoints.reduce((total, point) => total + (point.denominator ?? 0), 0));
    for (const audience of ["overall", "new", "existing"] as const) {
      const startup = versionMetricSummary("android:6.8.0", "M080", range, false, audience);
      if (startup.value !== null) expect(startup.value).toBeLessThanOrEqual(1);
      if (startup.numerator !== null && startup.denominator !== null) expect(startup.numerator).toBeLessThanOrEqual(startup.denominator);
    }

    expect(versionMetricPoints("android:6.8.0", "M020", range, false, "new").every(point => point.state === "not_applicable" && point.value === null)).toBe(true);
    expect(versionMetricSummary("android:6.8.0", "M024", range, false, "existing")).toMatchObject({ state: "empty", value: null });

  });

  test("版本分布保留未知版本；启动构成闭合，版本使用人数采用独立同端DAU分母", () => {
    const rows = versionDistribution("android", range);
    expect(rows.some(row => row.version === "版本未知")).toBe(true);
    expect(rows.reduce((total, row) => total + row.launchShare, 0)).toBeCloseTo(1, 10);
    expect(rows.reduce((total, row) => total + row.activeShare, 0)).toBeGreaterThan(1);
    expect(new Set(rows.map(row => row.activeDenominator)).size).toBe(1);
    expect(rows.every(row => row.activeShare <= 1 && row.activeShare === row.activeUsers / row.activeDenominator)).toBe(true);
    const dailyTotal = rows.reduce((total, row) => total + versionMetricPoints(row.key, "M016", range).reduce((sum, point) => sum + (point.value ?? 0), 0), 0);
    expect(rows.reduce((total, row) => total + row.activeUsers, 0)).toBeLessThan(dailyTotal);

    const overallRows = versionDistribution("overall", range);
    expect(overallRows).toHaveLength(VERSION_OPTIONS.length);
    expect(overallRows.filter(row => row.version === "6.8.0").map(row => row.key).sort()).toEqual(["android:6.8.0", "ios:6.8.0"]);
    for (const client of ["android", "ios"] as const) {
      expect(overallRows.filter(row => row.client === client).reduce((total, row) => total + row.launchShare, 0)).toBeCloseTo(1, 10);
    }
  });

  test("全部版本总体与四个交叉分组都从同源事实独立读取，不由版本或人群结果相加", () => {
    const keys = VERSION_OPTIONS.map(item => item.key);
    const overall = versionScopeMetricSummary(keys, "M016", range, false, { client: "overall", audience: "overall" });
    const exactSum = VERSION_OPTIONS.reduce((total, item) => total + (versionMetricSummary(item.key, "M016", range).value ?? 0), 0);
    expect(overall.value).toBeLessThan(exactSum);
    for (const client of ["android", "ios"] as const) for (const audience of ["new", "existing"] as const) {
      const summary = versionScopeMetricSummary(keys, "M081", range, false, { client, audience });
      expect(summary.value).not.toBeNull();
      expect(summary.numerator!).toBeLessThanOrEqual(summary.denominator!);
    }
    expect(versionScopeMetricSummary(keys, "M020", range, false, { client: "android", audience: "new" })).toMatchObject({ value: null, state: "empty" });
  });

  test("高基数版本搜索保持客户端联合键且不裁剪原集合", () => {
    const many: VersionOption[] = Array.from({ length: 120 }, (_, index) => {
      const client = index % 2 === 0 ? "android" as const : "ios" as const;
      const name = `6.${Math.floor(index / 10)}.${index}`;
      return { key: `${client}:${name}`, client, name, label: `${client === "android" ? "Android" : "iOS"} · ${name}` };
    });
    expect(searchVersionOptions("overall", "", many)).toHaveLength(120);
    const ios = searchVersionOptions("ios", "6.1.", many);
    expect(ios.length).toBeGreaterThan(0);
    expect(ios.every(item => item.client === "ios" && item.key.startsWith("ios:"))).toBe(true);
    expect(new Set(many.map(item => item.key)).size).toBe(120);
  });

  test("演示截至日后的结果保持未产出，跨截至区间只标记部分可用", () => {
    const future = { start: "2026-09-09", end: "2026-09-10" };
    expect(versionDistribution("android", future)).toEqual([]);
    expect(versionMetricPoints("android:6.8.0", "M080", future).every(point => point.state === "not_produced" && point.value === null)).toBe(true);
    const partialRows = versionDistribution("android", { start: "2026-09-08", end: "2026-09-09" });
    expect(partialRows[0]).toMatchObject({ dataDate: VERSION_FIXTURE_WATERMARK, availableDays: 1, totalDays: 2, state: "partial" });
    expect(versionMetricSummary("android:6.8.0", "M091", { start: "2026-09-08", end: "2026-09-09" })).toMatchObject({ state: "partial", value: null });
  });

  test("D1留存各用自身首日基数，最新批次未成熟且跨端回访规则不改D0归属", () => {
    const rows = versionRetentionRows(["android:6.8.0"], range);
    expect(rows.at(-1)?.date).toBe(VERSION_FIXTURE_WATERMARK);
    expect(rows.at(-1)?.registeredRate).toBeNull();
    expect(rows.at(-1)?.registeredState).toContain("观察未结束");
    expect(rows[0].registeredBase).not.toBe(rows[0].existingBase);
    expect(versionMetric("M020").attribution).toContain("跨版本、跨端");
    expect(versionMetric("M024").attribution).toContain("跨版本、跨端");
    const summary = versionMetricSummary("android:6.8.0", "M020", range);
    expect(summary.state).toBe("partial");
    expect(summary.availableDays).toBe(6);
    expect(summary.totalDays).toBe(7);
  });

  test("注册日与存量资格只建立一次，D1回访从实际次日活跃事实读取并保持归属守恒", () => {
    const keys = VERSION_OPTIONS.map(item => item.key);
    let registeredAcrossDays = 0;
    for (const date of ["2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06", "2026-09-07"]) {
      const oneDay = { start: date, end: date };
      for (const id of ["M020", "M024"] as const) {
        const overall = versionScopeMetricPoints(keys, id, oneDay)[0];
        const exact = VERSION_OPTIONS.map(item => versionMetricPoints(item.key, id, oneDay)[0]);
        expect(exact.reduce((total, point) => total + (point.denominator ?? 0), 0)).toBe(overall.denominator);
        expect(exact.reduce((total, point) => total + (point.numerator ?? 0), 0)).toBe(overall.numerator);
        expect(overall.numerator!).toBeLessThanOrEqual(overall.denominator!);
      }
      registeredAcrossDays += versionScopeMetricPoints(keys, "M020", oneDay)[0].denominator ?? 0;
    }
    // Each synthetic identity has one fixed registration day; no weekly
    // reclassification can make it enter the registration cohort again.
    expect(registeredAcrossDays).toBeLessThanOrEqual(2_400);
  });

  test("空结果与未成熟不补0，整体活跃次日回访只输出待登记说明", () => {
    expect(versionDistribution("ios", range, true)).toEqual([]);
    expect(versionMetricSummary("ios:6.8.0", "M080", range, true)).toMatchObject({ state: "empty", value: null });
    const sheets = versionPerformanceSheets({ ...DEFAULT_VERSION_PERFORMANCE_VIEW, panel: "version", audience: "new" }, range, false, true);
    expect(sheets.map(sheet => sheet.name)).toEqual(["01_版本分布", "02_核心表现", "03_变化趋势", "04_D1批次核对"]);
    expect(sheets[0].rows.some(row => row[0] === "上一等长周期")).toBe(true);
    expect(sheets[1].rows.some(row => row[0] === "上一等长周期")).toBe(true);
    expect(sheets[1].rows[0]).toContain("分子指标");
    expect(sheets[1].rows[0]).toContain("分母指标");
    expect(sheets[1].rows[0]).toContain("客户端");
    expect(sheets[1].rows[0]).toContain("指标批次范围");
    expect(sheets.slice(0, 3).some(sheet => sheet.rows[0].some(cell => String(cell).includes("人群")))).toBe(false);
    expect(sheets[1].rows.some(row => row.includes("视频首帧成功展示的播放尝试数"))).toBe(true);
    const activeRows = sheets[1].rows.filter(row => row[3] === versionMetric("M016").name && row[0] === "当前期");
    const names = [...new Set(VERSION_OPTIONS.map(item => item.name))];
    expect(activeRows).toHaveLength(names.length * 3);
    for (const name of names) expect(activeRows.filter(row => String(row[2]).startsWith(`${name} · `)).map(row => row[4])).toEqual(["总体", "Android", "iOS"]);
    const registrationRows = sheets[1].rows.filter(row => row[3] === versionMetric("M020").name && row[0] === "当前期");
    expect(registrationRows).toHaveLength(names.length * 3);
    expect(registrationRows.every(row => String(row[15]).includes("注册批次"))).toBe(true);
    expect(sheets[2].rows.some(row => row[0] === "上一等长周期")).toBe(true);
    expect(sheets[2].rows.some(row => row[3] === versionMetric("M016").name && row[4] === "Android")).toBe(true);
    expect(sheets[2].rows.some(row => row[3] === versionMetric("M020").name && String(row[11]).includes("注册批次"))).toBe(true);
    expect(sheets[3].rows.some(row => row[0] === "上一等长周期")).toBe(true);
    const target = sheets[1].rows.find(row => row.includes("整体活跃次日回访率"));
    expect(target?.[8]).toBeNull();
    expect(target).toContain("未生成正式数值");
    expect(sheets[3].rows.some(row => row.includes("次日观察未结束"))).toBe(true);

    const legacySheets = versionPerformanceSheets({ ...DEFAULT_VERSION_PERFORMANCE_VIEW, client: "android", versionRange: "focused" }, range);
    const legacyActiveRows = legacySheets[1].rows.filter(row => row[3] === versionMetric("M016").name && row[0] === "当前期");
    expect(new Set(legacyActiveRows.map(row => row[2]))).toEqual(new Set(names.flatMap(name => ["总体", "Android", "iOS"].map(client => `${name} · ${client}`))));
    expect(new Set(legacySheets[3].rows.slice(1).map(row => row[2]))).toEqual(new Set(VERSION_OPTIONS.map(item => item.label)));

    const comparisonSheets = versionPerformanceSheets({ ...DEFAULT_VERSION_PERFORMANCE_VIEW, versionRange: "focused", comparison: "android:6.7.2" }, range);
    const comparisonTrendRows = comparisonSheets[2].rows.filter(row => String(row[2]).includes("Android · 6.7.2 · 精确对比版本"));
    expect(new Set(comparisonTrendRows.filter(row => row[3] === versionMetric("M080").name).map(row => row[4]))).toEqual(new Set(["Android"]));
    expect(new Set(comparisonTrendRows.filter(row => row[3] === versionMetric("M020").name).map(row => row[11]))).toEqual(new Set([versionMetricAudienceScope("M020")]));
  });
});
