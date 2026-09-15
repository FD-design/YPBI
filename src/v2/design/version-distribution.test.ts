import { describe, expect, test } from "bun:test";
import { DEFAULT_VERSION_PERFORMANCE_VIEW, VERSION_OPTIONS, versionMetric, versionsForClient } from "./version-performance-model";
import {
  versionDisplayGroups, versionDistribution, versionDistributionByName, versionDistributionShare,
  versionMetricSummary, versionPerformanceSheets, versionRetentionRows,
  versionScopeMetricPoints, versionScopeMetricSummary
} from "./version-performance-fixtures";

const range = { start: "2026-09-02", end: "2026-09-08" };
const keys = VERSION_OPTIONS.map(item => item.key);

describe("版本名称与客户端投影", () => {
  test("同名与未知各占一行，实体键和所属客户端完整保留", () => {
    const groups = versionDisplayGroups();
    expect(groups).toHaveLength(new Set(VERSION_OPTIONS.map(item => item.name)).size);
    expect(groups.map(item => item.name)).toEqual(["6.8.0", "6.7.4", "6.7.2", "6.6.1", "6.6.0", "版本未知"]);
    expect(groups.find(item => item.name === "6.8.0")).toEqual({ name: "6.8.0", keys: ["android:6.8.0", "ios:6.8.0"], clients: { android: ["android:6.8.0"], ios: ["ios:6.8.0"] } });
    expect(groups.filter(item => item.name === "版本未知")).toHaveLength(1);
    expect(groups.find(item => item.name === "版本未知")?.keys).toEqual(["android:unknown", "ios:unknown"]);
    expect(new Set(groups.flatMap(group => group.keys))).toEqual(new Set(keys));
    expect(versionDisplayGroups(["ios:6.8.0", "ios:6.8.0", "bad:key"])).toEqual([{ name: "6.8.0", keys: ["ios:6.8.0"], clients: { android: [], ios: ["ios:6.8.0"] } }]);
    expect(versionDisplayGroups([])).toEqual([]);
  });

  test("总体UV独立跨端去重，分母使用覆盖客户端完整末日DAU", () => {
    const rows = versionDistributionByName(keys, range);
    const sameName = rows.find(row => row.name === "6.8.0")!;
    const overallDau = versionScopeMetricSummary(keys, "M016", { start: range.end, end: range.end });
    expect(sameName.overall.activeUsers).toBe(versionScopeMetricSummary(sameName.keys, "M016", { start: range.end, end: range.end }).value);
    expect(sameName.overall.activeUsers!).toBeLessThan(sameName.byClient.android.activeUsers! + sameName.byClient.ios.activeUsers!);
    expect(sameName.overall.activeDenominator).toBe(overallDau.value);
    expect(new Set(rows.map(row => row.overall.activeDenominator))).toEqual(new Set([overallDau.value]));
    expect(sameName.overall.launchDenominator).toBe(versionScopeMetricSummary(keys, "M091", range).value);
    expect(rows.reduce((total, row) => total + row.overall.launchShare!, 0)).toBeCloseTo(1, 10);
    expect(rows.reduce((total, row) => total + row.overall.activeShare!, 0)).toBeGreaterThan(1);
    for (const row of rows) expect(row.overall.activeShare).toBe(versionDistributionShare(row.overall.activeUsers, overallDau.value));
  });

  test("聚焦同名版本或单端实体后，分母仍为所覆盖客户端全版本", () => {
    const grouped = versionDistributionByName(["android:6.8.0", "ios:6.8.0"], range)[0];
    const all = versionDistributionByName(keys, range).find(row => row.name === "6.8.0")!;
    expect(grouped.overall).toEqual(all.overall);
    expect(grouped.overall.activeShare!).toBeLessThan(1);
    expect(grouped.overall.launchShare!).toBeLessThan(1);
    const androidKeys = versionsForClient("android").map(item => item.key);
    const android = versionDistributionByName(["android:6.8.0"], range)[0];
    expect(android.overall).toEqual(android.byClient.android);
    expect(android.overall.activeDenominator).toBe(versionScopeMetricSummary(androidKeys, "M016", { start: range.end, end: range.end }).value);
    expect(android.byClient.ios).toMatchObject({ state: "no_version", launches: null, activeUsers: null });
    expect(versionScopeMetricPoints(["android:6.8.0"], "M016", range, false, { client: "ios", audience: "overall" })).toEqual([]);
  });

  test("缺端、结果未返回、未产出和部分日期各有状态且不冒充总体", () => {
    const mixed = versionDistributionByName(keys, range, true);
    const shared = mixed.find(row => row.name === "6.8.0")!;
    expect(shared.overall).toMatchObject({ state: "no_record", activeUsers: null, activeDenominator: null, launches: null });
    expect(shared.byClient.ios).toMatchObject({ state: "no_record", activeUsers: null });
    expect(shared.byClient.android.state).toBe("available");
    expect(mixed.find(row => row.name === "6.7.2")?.byClient.ios.state).toBe("no_version");
    const androidOnly = versionDistributionByName(["android:6.8.0"], range, true)[0];
    expect(androidOnly.overall.state).toBe("available");
    const futureRange = { start: "2026-09-09", end: "2026-09-10" };
    expect(versionDistributionByName(keys, futureRange).every(row => row.overall.state === "not_produced" && row.overall.activeUsers === null)).toBe(true);
    const partial = versionDistributionByName(keys, { start: "2026-09-08", end: "2026-09-09" })[0].overall;
    expect(partial).toMatchObject({ state: "partial", dataDate: "2026-09-09", availableDays: 1, totalDays: 2, activeUsers: null, activeShare: null, launches: null, launchShare: null });
  });

  test("真实零占比和零分母保持不同，不用真假判断把零替成缺失", () => {
    expect(versionDistributionShare(0, 120)).toBe(0);
    expect(versionDistributionShare(null, 120)).toBeNull();
    expect(versionDistributionShare(0, 0)).toBeNull();
    expect(versionDistributionShare(0, null)).toBeNull();
    const zeroLaunches = versionMetricSummary("android:6.8.0", "M091", { start: "2026-07-01", end: "2026-07-01" }, false, "new");
    expect(zeroLaunches).toMatchObject({ state: "available", numerator: 0, value: 0 });
    expect(versionDistributionShare(zeroLaunches.value, 120)).toBe(0);
  });

  test("分布投影与原分端函数共享事实，原新老辅助函数保留兼容", () => {
    const grouped = versionDistributionByName(keys, range);
    for (const client of ["android", "ios"] as const) {
      for (const legacy of versionDistribution(client, range)) {
        const current = grouped.find(row => row.name === legacy.version)!.byClient[client];
        expect(current).toMatchObject({ launches: legacy.launches, activeUsers: legacy.activeUsers, activeDenominator: legacy.activeDenominator, launchShare: legacy.launchShare, activeShare: legacy.activeShare });
      }
    }
    const overall = versionMetricSummary("android:6.8.0", "M016", range);
    const registered = versionMetricSummary("android:6.8.0", "M016", range, false, "new");
    const existing = versionMetricSummary("android:6.8.0", "M016", range, false, "existing");
    expect(registered.value! + existing.value!).toBeLessThan(overall.value!);
  });

  test("完整导出独立于显隐与旧人群，保留总体、两端、两期和稳定键", () => {
    const sheets = versionPerformanceSheets(DEFAULT_VERSION_PERFORMANCE_VIEW, range, false, true);
    expect(versionPerformanceSheets({ ...DEFAULT_VERSION_PERFORMANCE_VIEW, display: "overall", audience: "new", search: "does not match" }, range, false, true)).toEqual(sheets);
    const distribution = sheets[0];
    expect(distribution.rows.slice(1)).toHaveLength(versionDisplayGroups().length * 3 * 2);
    expect(distribution.rows[0]).toContain("完整客户端范围启动次数");
    expect(distribution.rows[0]).toContain("独立同日活跃用户数");
    expect(distribution.rows.some(row => row[2] === "6.8.0" && row[3] === "总体" && row[4] === "android:6.8.0,ios:6.8.0")).toBe(true);
    expect(new Set(distribution.rows.slice(1).map(row => row[3]))).toEqual(new Set(["总体", "Android", "iOS"]));
    expect(sheets.slice(0, 3).flatMap(sheet => sheet.rows).some(row => row.some(cell => cell === "新用户" || cell === "老用户" || cell === "用户人群" || cell === "人群"))).toBe(false);
    for (const sheet of sheets) expect(sheet.rows.every(row => row.length === sheet.rows[0].length)).toBe(true);
    const missing = versionPerformanceSheets(DEFAULT_VERSION_PERFORMANCE_VIEW, range, true);
    expect(missing[0].rows.some(row => row[3] === "iOS" && row[5] === null && row[14] === "客户端结果未返回")).toBe(true);
    expect(missing[2].rows.some(row => row[4] === "iOS" && row[8] === null && row[10] === "客户端结果未返回")).toBe(true);
  });

  test("固定注册与存量指标及D0归属仍分别保留，跨端展示不改批次", () => {
    const sheets = versionPerformanceSheets(DEFAULT_VERSION_PERFORMANCE_VIEW, range);
    const core = sheets[1].rows.slice(1);
    const group = versionDisplayGroups().find(item => item.name === "6.8.0")!;
    for (const id of ["M020", "M024"] as const) {
      const row = core.find(item => item[2] === "6.8.0 · 总体" && item[3] === versionMetric(id).name)!;
      const summary = versionScopeMetricSummary(group.keys, id, range);
      expect(row[8]).toBe(summary.numerator);
      expect(row[10]).toBe(summary.denominator);
      expect(row[11]).toBe(summary.value === null ? null : summary.value * 100);
      expect(String(row[15])).toContain(id === "M020" ? "注册批次" : "注册满 2 天");
      expect(String(row[16])).toContain("跨版本、跨端");
    }
    const batchRows = versionRetentionRows(keys, range);
    expect(sheets[3].rows.slice(1)).toHaveLength(batchRows.length);
    expect(new Set(sheets[3].rows.slice(1).map(row => row[2]))).toEqual(new Set(VERSION_OPTIONS.map(item => item.label)));
    expect(sheets[3].rows.some(row => row.includes("次日观察未结束"))).toBe(true);
    expect(sheets[3].rows.every(row => row[11] === "整体活跃次日回访" || row[11] === "待指标登记")).toBe(true);
  });
});
