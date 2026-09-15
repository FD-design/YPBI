import { expect, test } from "bun:test";
import { DEFAULT_NAVIGATION_VIEW, NAVIGATION_TABS, navigationBasis, navigationSnapshot, validNavigationView } from "./global-navigation-usage-model";
import { DEFAULT_FUNCTION_VIEW, functionCatalog, functionRows, parseFunctionView, sortFunctionRows } from "./function-preview-model";
import { USAGE_SCOPES } from "./usage-observation-fixtures";

const range = { start: "2026-09-02", end: "2026-09-08" };
test("导航隔离样本以同一成员点击事实生成用户、次数、活跃基数与比率", () => {
  const snapshot = navigationSnapshot(range, true), current = snapshot.periods[0];
  expect(functionCatalog.items).toHaveLength(50);
  expect(NAVIGATION_TABS.every(tab => !functionCatalog.items.some(page => page.id === tab.id))).toBe(true);
  for (const p of snapshot.periods) for (const row of [...p.summary, ...p.daily]) {
    expect(row.status).toBe("完整");
    expect(row.penetration).toBe(row.active ? row.users! / row.active : null);
    expect(row.frequency).toBe(row.users ? row.clicks! / row.users : null);
    expect(row.users!).toBeLessThanOrEqual(row.active!);
    expect(row.clicks!).toBeGreaterThanOrEqual(row.users!);
  }
  for (const tab of NAVIGATION_TABS) {
    const overall = current.summary.find(row => row.tabId === tab.id)!;
    const daily = current.daily.filter(row => row.tabId === tab.id);
    expect(overall.clicks).toBe(daily.reduce((sum, row) => sum + row.clicks!, 0));
    expect(overall.users!).toBeLessThan(daily.reduce((sum, row) => sum + row.users!, 0));
    const basis = navigationBasis(overall, "frequency", "演示周期")!;
    expect(basis.numerator.value).toBe(overall.clicks); expect(basis.denominator.value).toBe(overall.users);
  }
});

test("导航零、未配置、部分、查询失败分别投影，恢复不动其他Tab", () => {
  const snapshot = navigationSnapshot(range, true, true), rows = snapshot.periods[0].summary;
  expect(rows.map(row => row.status)).toEqual(["完整", "未配置", "部分数据", "查询失败", "完整"]);
  expect(rows[0].users).toBe(0); expect(rows[0].clicks).toBe(0); expect(rows[0].penetration).toBe(0); expect(rows[0].frequency).toBeNull();
  expect(rows[0].active!).toBeGreaterThan(0);
  expect(rows.slice(1, 4).every(row => row.users === null && row.frequency === null)).toBe(true);
  const partial = snapshot.periods[0].daily.filter(row => row.tabId === rows[2].tabId);
  expect(partial.slice(0, -1).every(row => row.status === "完整" && row.clicks !== null)).toBe(true);
  expect(partial.at(-1)!.status).toBe("未产出");
  expect(navigationSnapshot(range, false, true, [rows[3].tabId]).periods[0].summary.find(row => row.tabId === rows[3].tabId)!.status).toBe("完整");
  expect(snapshot.periods[1].summary.every(row => row.status === "完整")).toBe(true);
});

test("导航全部范围与逐日导出共享精确输入，不含成员标识或新指标ID", () => {
  for (const value of [range, { start: "2026-09-08", end: "2026-09-08" }, { start: "2026-08-01", end: "2026-08-31" }]) {
    const snapshot = navigationSnapshot(value, true, true), sheet = snapshot.sheets[0];
    expect(sheet.rows).toHaveLength(11);
    const source = snapshot.periods[0].summary;
    source.forEach((row, index) => {
      expect(sheet.rows[index + 1].slice(6)).toEqual([row.users, row.clicks, row.active, row.penetration === null ? null : row.penetration * 100, row.frequency, row.status]);
    });
    expect(snapshot.sheets[1].rows.length - 1).toBe(snapshot.periods.reduce((sum, p) => sum + p.daily.length, 0));
    expect(snapshot.sheets.map(sheet => sheet.name)).toEqual(["05_全局导航", "06_导航逐日"]);
    expect(JSON.stringify(snapshot.sheets)).not.toMatch(/member|Android|iOS|新用户|老用户|分组|客户端/);
  }
});

test("50功能旧深链保留，导航新深链严格校验且不占功能选择名额", () => {
  const legacy = { range, compared: true, mixed: false, selected: ["video_home"], days: 7, dimension: "平台" };
  expect(parseFunctionView(JSON.stringify(legacy))!.navigation).toEqual(DEFAULT_NAVIGATION_VIEW);
  const navigation = { selected: NAVIGATION_TABS[2].id, measure: "frequency" as const, dimension: "userType" as const };
  const canonical = { selected: navigation.selected, measure: "frequency" };
  expect(parseFunctionView(JSON.stringify({ ...legacy, navigation }))!.navigation).toEqual(canonical);
  for (const scope of USAGE_SCOPES) {
    const parsed = parseFunctionView(JSON.stringify({ ...legacy, structureScope: scope, navigation: { ...canonical, scope } }))!;
    expect(parsed.navigation).toEqual(canonical);
    expect(parsed.structureScope).toEqual(scope);
    expect(parsed.selected).toEqual(legacy.selected);
    expect(parsed.range).toEqual(range);
  }
  expect(validNavigationView(canonical)).toBe(true);
  expect(validNavigationView({ ...navigation, selected: "video_home" })).toBe(false);
  expect(validNavigationView({ ...navigation, measure: "unknown" })).toBe(false);
  expect(parseFunctionView(JSON.stringify({ ...legacy, navigation: { ...navigation, extra: true } }))).toBeNull();
  const rows = functionRows({ ...DEFAULT_FUNCTION_VIEW, mixed: true, compared: true });
  expect(sortFunctionRows(rows, "change").slice(-4).every(row => row.current === null)).toBe(true);
  expect(sortFunctionRows(rows, "value")).toHaveLength(50);
});

test("导航仅按Tab投影整体；逐日和周期保持独立去重且不携带客户端人群", () => {
  const snapshot = navigationSnapshot(range, true), current = snapshot.periods[0];
  expect(current.summary).toHaveLength(NAVIGATION_TABS.length);
  expect(current.daily).toHaveLength(NAVIGATION_TABS.length * 7);
  expect(JSON.stringify(snapshot.periods)).not.toMatch(/"scope"|"group"|"client"|"audience"/);
  for (const row of current.summary) {
    const daily = current.daily.filter(day => day.tabId === row.tabId);
    expect(daily.reduce((total, day) => total + day.clicks!, 0)).toBe(row.clicks);
    expect(row.users!).toBeLessThanOrEqual(daily.reduce((total, day) => total + day.users!, 0));
    expect(navigationBasis(row, "penetration", "所选范围")!.denominator.value).toBe(row.active);
  }
  expect(validNavigationView({ selected: null, measure: "users", scope: { client: "unlisted", audience: "new" } })).toBe(false);
  const zero = { ...current.summary[0], active: 0, users: 0, clicks: 0, penetration: null, frequency: null };
  expect(navigationBasis(zero, "penetration", "整体")!.result).toBe("—");
  expect(navigationBasis(zero, "frequency", "整体")!.denominator.value).toBe(0);
});
