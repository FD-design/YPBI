import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { acceptanceRegistry, verifyBIAcceptance } from "./bi-acceptance.mjs";
import { metricHeadingUnit } from "../src/components/metric-unit.ts";

const registry = await acceptanceRegistry();
const byKey = (report, key) => report.columns.find(column => column.key === key);

// Synthetic evidence exists only in memory. No production fixture or data store is written.
function evidence() {
  const query = { boardId: "5.2", pid: "fixture", dateRange: ["2020-01-01", "2020-01-01"] };
  const page = { environment: "test", query, columns: registry.map(column => ({
    key: column.key, name: column.name,
    text: column.kind === "ratio" ? "50.00%" : column.kind === "platformRatio" ? "1 : 1" : column.kind === "currency" ? "$1" : "1",
    printedUnit: metricHeadingUnit(column.name, column.unit) || null,
    state: "available", sourceStatus: "READY", formalValue: column.kind === "ratio" ? 0.5 : 1
  })) };
  const proxy = { environment: "test", http: 200, response: { success: true, data: {
    schemaVersion: "day-dashboard/v1", query: structuredClone(query), queryId: "fixture-only", fetchedAt: "2026-10-12T00:00:00.000Z",
    timezone: "Asia/Shanghai", validationStatus: "pending_validation", completeness: "unknown", watermark: null, sourceApiIds: ["fixture-source"],
    series: registry.map(column => ({ metric: {
      id: column.bffMetricId, name: column.name, unit: column.unit, definition: "内存测试证据", authorityVersion: "fixture-only",
      formula: null, referenceMetricId: column.metricId, sourceNote: null,
      inputs: [{ key: "count", name: "输入", unit: column.unit }]
    }, points: [{ date: "2020-01-01", state: "available", sourceStatus: "READY", value: column.kind === "ratio" ? 0.5 : 1,
      inputs: [{ key: "count", value: 1 }] }] }))
  } } };
  return { page, proxy };
}

function change(input, key, values) {
  const index = registry.findIndex(column => column.key === key);
  const series = input.proxy.response.data.series[index];
  Object.assign(series.metric, values.metric);
  Object.assign(series.points[0], values.point);
  Object.assign(input.page.columns[index], values.page);
}

function tablePage(page, platform = "内存测试平台\nPID fixture") {
  return { environment: page.environment, query: structuredClone(page.query),
    headers: ["状态", "业务平台", ...page.columns.map(column => `${column.name}\n待验数${column.printedUnit ? `\n（${column.printedUnit}）` : ""}`)],
    rows: [["部分", platform, ...page.columns.map(column => column.text)]] };
}

test("经营权威注册为93列且映射、键唯一", () => {
  assert.equal(registry.length, 93);
  assert.equal(new Set(registry.map(column => column.key)).size, 93);
  assert.equal(new Set(registry.map(column => column.bffMetricId)).size, 93);
  assert.equal(registry.filter(column => column.displayOnly).length, 2);
});

test("完整同范围证据通过一致性，始终不提升上游或生产验数", async () => {
  const report = await verifyBIAcceptance(evidence());
  assert.equal(report.summary.passed, 93);
  assert.equal(report.summary.hasMismatch, false);
  assert.equal(report.summary.formalReadyInProxy, 93);
  assert.equal(report.summary.upstreamPassedColumns, 0);
  assert.equal(report.summary.productionPassedColumns, 0);
  assert.equal(report.boundary.originalUpstream.status, "unverified");
});

test("删除、重复、未知列与顺序变化均产生明确结构差异", async () => {
  const missing = evidence(); missing.page.columns.pop();
  assert.equal((await verifyBIAcceptance(missing)).checks.pageStructure.missing.length, 1);
  const duplicate = evidence(); duplicate.page.columns[1] = structuredClone(duplicate.page.columns[0]);
  const duplicateResult = await verifyBIAcceptance(duplicate);
  assert.equal(duplicateResult.checks.pageStructure.status, "mismatch");
  assert.equal(duplicateResult.checks.pageStructure.duplicates.length, 1);
  const unknown = evidence(); unknown.page.columns[0].key = "unknown";
  assert.deepEqual((await verifyBIAcceptance(unknown)).checks.pageStructure.unknown, ["unknown"]);
  const order = evidence(); [order.page.columns[0], order.page.columns[1]] = [order.page.columns[1], order.page.columns[0]];
  assert.equal((await verifyBIAcceptance(order)).checks.pageStructure.status, "mismatch");
});

test("真实0保留可读；空值不补0", async () => {
  const zero = evidence();
  change(zero, "M016:overall", { point: { value: 0 }, page: { text: "0", formalValue: 0 } });
  assert.equal(byKey(await verifyBIAcceptance(zero), "M016:overall").status, "passed");
  const missing = evidence();
  change(missing, "M016:overall", { point: { state: "no_record", sourceStatus: undefined, value: null, inputs: [{ key: "count", value: null }] },
    page: { text: "当日未返回记录", state: "no_record", sourceStatus: null, formalValue: null } });
  const report = await verifyBIAcceptance(missing);
  assert.equal(byKey(report, "M016:overall").formalValue, null);
  assert.equal(byKey(report, "M016:overall").formalReady, false);
  assert.equal(byKey(report, "M016:overall").status, "known_limit");
  missing.page.columns[0].text = "0";
  assert.equal(byKey(await verifyBIAcceptance(missing), "M016:overall").status, "mismatch");
});

test("null与available矛盾由既有响应契约阻断", async () => {
  const input = evidence(); input.proxy.response.data.series[0].points[0].value = null;
  const report = await verifyBIAcceptance(input);
  assert.equal(report.checks.proxyContract.status, "mismatch");
  assert.equal(report.summary.formalReadyInProxy, 0);
});

test("SOURCE_INCOMPLETE诊断人数只生成标记参考值，正式值仍null", async () => {
  const input = evidence();
  change(input, "M020:Android", {
    metric: { inputs: [{ key: "retained", name: "返访", unit: "人" }, { key: "registered", name: "注册", unit: "人" }] },
    point: { state: "no_value", sourceStatus: "SOURCE_INCOMPLETE", value: null, inputs: [{ key: "retained", value: 1 }, { key: "registered", value: 2 }] },
    page: { text: "50.00% · 部分数据，仅供参考", state: "no_value", sourceStatus: "SOURCE_INCOMPLETE", formalValue: null }
  });
  const column = byKey(await verifyBIAcceptance(input), "M020:Android");
  assert.equal(column.status, "known_limit");
  assert.equal(column.formalValue, null);
  assert.equal(column.formalReady, false);
  assert.equal(column.referenceRatio, 0.5);
  assert.deepEqual(column.diagnosticInputs, { numerator: 1, denominator: 2 });
  input.page.columns.find(column => column.key === "M020:Android").text = "50.00%";
  assert.equal(byKey(await verifyBIAcceptance(input), "M020:Android").status, "mismatch");
});

test("诊断人数不合法、非READY正式值泄漏不能靠安全投影掩盖", async () => {
  const input = evidence();
  change(input, "M020:Android", {
    metric: { inputs: [{ key: "retained", name: "返访", unit: "人" }, { key: "registered", name: "注册", unit: "人" }] },
    point: { state: "no_value", sourceStatus: "SOURCE_INCOMPLETE", value: null, inputs: [{ key: "retained", value: 3 }, { key: "registered", value: 2 }] },
    page: { text: "数据接入中", state: "no_value", sourceStatus: "SOURCE_INCOMPLETE", formalValue: null }
  });
  assert.equal(byKey(await verifyBIAcceptance(input), "M020:Android").sourceState.status, "mismatch");
  change(input, "M020:Android", { point: { state: "available", value: 0.5 } });
  assert.equal(byKey(await verifyBIAcceptance(input), "M020:Android").sourceState.status, "mismatch");
});

test("比率只换算一次，合法超过100%不被截断", async () => {
  const input = evidence();
  change(input, "M006:overall", { point: { value: 2.5 }, page: { text: "250.00%", formalValue: 2.5 } });
  assert.equal(byKey(await verifyBIAcceptance(input), "M006:overall").status, "passed");
  input.page.columns.find(column => column.key === "M006:overall").text = "2.50%";
  assert.equal(byKey(await verifyBIAcceptance(input), "M006:overall").display.status, "mismatch");
});

test("合法零分母不可用，诊断参考也不能从零分母生成0", async () => {
  const input = evidence();
  change(input, "M006:overall", { point: { state: "zero_denominator", value: null, inputs: [{ key: "count", value: 0 }] },
    page: { text: "分母为0", state: "zero_denominator", sourceStatus: "READY", formalValue: null } });
  const result = byKey(await verifyBIAcceptance(input), "M006:overall");
  assert.equal(result.status, "known_limit");
  assert.equal(result.formalValue, null);
  assert.equal(result.formalReady, false);
  change(input, "M020:Android", {
    metric: { inputs: [{ key: "retained", name: "返访", unit: "人" }, { key: "registered", name: "注册", unit: "人" }] },
    point: { state: "no_value", sourceStatus: "SOURCE_INCOMPLETE", value: null, inputs: [{ key: "retained", value: 0 }, { key: "registered", value: 0 }] },
    page: { text: "来源不完整，仅供核对", state: "no_value", sourceStatus: "SOURCE_INCOMPLETE", formalValue: null }
  });
  const reference = byKey(await verifyBIAcceptance(input), "M020:Android");
  assert.equal(reference.status, "known_limit");
  assert.equal(reference.referenceRatio, null);
});

test("金额使用实际BI元单位，人均小额精度复用现有规则", async () => {
  const input = evidence();
  change(input, "M058:overall", { metric: { unit: "元" }, point: { value: 162.02 }, page: { text: "162.02", printedUnit: "元", formalValue: 162.02 } });
  const column = byKey(await verifyBIAcceptance(input), "M058:overall");
  assert.equal(column.status, "passed");
  assert.equal(column.unit.source, "元");
  assert.equal(column.unit.projected, "元");
  input.page.columns.find(column => column.key === "M058:overall").printedUnit = "USD";
  assert.equal(byKey(await verifyBIAcceptance(input), "M058:overall").unit.status, "mismatch");
  change(input, "M067:overall", { metric: { unit: "元/人" }, point: { value: 0.004 }, page: { text: "0.004", printedUnit: "元/人", formalValue: 0.004 } });
  assert.equal(byKey(await verifyBIAcceptance(input), "M067:overall").status, "passed");
});

test("时长遵循BI实际单位，已归一小时不重复除3600，秒不伪装小时", async () => {
  const input = evidence();
  change(input, "M102:overall", { metric: { unit: "小时" }, point: { value: 64 / 3600 }, page: { text: "0.01778", printedUnit: "小时", formalValue: 64 / 3600 } });
  assert.equal(byKey(await verifyBIAcceptance(input), "M102:overall").status, "passed");
  change(input, "M102:overall", { metric: { unit: "秒" }, point: { value: 64 }, page: { text: "64", printedUnit: "秒", formalValue: 64 } });
  assert.equal(byKey(await verifyBIAcceptance(input), "M102:overall").status, "passed");
  input.page.columns.find(column => column.key === "M102:overall").printedUnit = "小时";
  assert.equal(byKey(await verifyBIAcceptance(input), "M102:overall").unit.status, "mismatch");
});

test("页面无响应、响应无页面、旧matches/READY清单均不取得读数通过", async () => {
  const input = evidence();
  const pageOnly = await verifyBIAcceptance({ page: input.page });
  assert.equal(pageOnly.checks.pageStructure.status, "passed");
  assert.equal(pageOnly.summary.unverified, 93);
  assert.equal(pageOnly.summary.consistencyStatus, "unverified");
  assert.equal((await verifyBIAcceptance({ proxy: input.proxy })).summary.unverified, 93);
  const checklist = { columns: registry.map(column => ({ ...column, testBaseline: { matches: true, formalReady: true } })) };
  const report = await verifyBIAcceptance({ page: input.page, checklist });
  assert.equal(report.checks.checklistStructure.status, "passed");
  assert.equal(report.summary.passed, 0);
  assert.equal(report.summary.formalReadyInProxy, 0);
});

test("同环境、PID、完整日期与版本不匹配阻断所有读数配对", async () => {
  for (const mutate of [
    input => { input.proxy.environment = "production"; },
    input => { input.proxy.response.data.query.pid = "other"; },
    input => { input.page.query.dateRange = ["2019-12-25", "2020-01-01"]; },
    input => { input.page.release = "one"; input.proxy.release = "two"; },
    input => { input.page.captureId = "one"; input.proxy.captureId = "two"; }
  ]) {
    const input = evidence(); mutate(input);
    const report = await verifyBIAcceptance(input);
    assert.equal(report.checks.scope.status, "mismatch");
    assert.equal(report.summary.unverified, 93);
  }
});

test("环境或HTTP身份缺失不从任务READY推断", async () => {
  const input = evidence(); delete input.proxy.environment; input.proxy.taskStatus = "READY";
  assert.equal((await verifyBIAcceptance(input)).checks.scope.status, "unverified");
  input.proxy.environment = "test"; delete input.proxy.http;
  assert.equal((await verifyBIAcceptance(input)).checks.scope.status, "unverified");
});

test("缺序列／点为unverified，重复序列／点阻断配对", async () => {
  const missing = evidence(); missing.proxy.response.data.series.shift();
  assert.equal(byKey(await verifyBIAcceptance(missing), "M016:overall").status, "unverified");
  const wrongDate = evidence(); wrongDate.proxy.response.data.series[0].points[0].date = "2020-01-02";
  assert.equal(byKey(await verifyBIAcceptance(wrongDate), "M016:overall").status, "unverified");
  const duplicate = evidence(); duplicate.proxy.response.data.series.push(structuredClone(duplicate.proxy.response.data.series[0]));
  assert.equal((await verifyBIAcceptance(duplicate)).checks.proxyUniqueness.status, "mismatch");
  const points = evidence(); points.proxy.response.data.series[0].points.push(structuredClone(points.proxy.response.data.series[0].points[0]));
  assert.equal((await verifyBIAcceptance(points)).checks.proxyUniqueness.status, "mismatch");
});

test("同声明8日但仅末日点不能通过，完整逐日证据才可比较末日", async () => {
  const input = evidence();
  input.page.query.dateRange = ["2019-12-25", "2020-01-01"];
  input.proxy.response.data.query.dateRange = ["2019-12-25", "2020-01-01"];
  const incomplete = await verifyBIAcceptance(input);
  assert.equal(incomplete.checks.scope.status, "passed");
  assert.equal(incomplete.checks.proxyQueryMatch.status, "mismatch");
  assert.equal(incomplete.summary.passed, 0);
  assert.equal(incomplete.summary.unverified, 93);
  for (const series of input.proxy.response.data.series) {
    const point = series.points[0];
    series.points = Array.from({ length: 8 }, (_, i) => ({ ...structuredClone(point), date: new Date(Date.parse("2019-12-25") + i * 86400000).toISOString().slice(0, 10) }));
  }
  assert.equal((await verifyBIAcceptance(input)).checks.proxyQueryMatch.status, "passed");
  [input.proxy.response.data.series[0].points[0], input.proxy.response.data.series[0].points[1]] = [input.proxy.response.data.series[0].points[1], input.proxy.response.data.series[0].points[0]];
  assert.equal((await verifyBIAcceptance(input)).checks.proxyQueryMatch.status, "mismatch");
});

test("未记录单位与页面状态保留未验证，观察到单位省略和没采集不同", async () => {
  const input = evidence();
  delete input.page.columns[0].printedUnit;
  delete input.page.columns[1].state;
  const report = await verifyBIAcceptance(input);
  assert.equal(report.columns[0].unit.status, "unverified");
  assert.equal(report.columns[0].status, "unverified");
  assert.equal(report.columns[1].pageState.status, "unverified");
  assert.equal(report.columns[1].unit.status, "passed");
  assert.equal(report.columns[1].unit.printedUnitObserved, false);
});

test("headers/rows既有快照形状可复查结构，不自动配对清单旧基线", async () => {
  const input = evidence();
  const page = { environment: "test", pid: "fixture", date: "2020-01-01",
    headers: ["状态", "业务平台", ...input.page.columns.map(column => `${column.name}\n待验数${column.printedUnit ? `\n（${column.printedUnit}）` : ""}`)],
    rows: [["部分", "内存测试平台\nPID fixture", ...input.page.columns.map(column => column.text)]] };
  const checklist = { columns: registry.map(column => ({ ...column, testBaseline: { matches: true, formalReady: true } })) };
  const report = await verifyBIAcceptance({ page, checklist });
  assert.equal(report.checks.pageStructure.status, "passed");
  assert.equal(report.checks.checklistStructure.status, "passed");
  assert.equal(report.summary.unverified, 93);
  assert.equal(report.summary.hasMismatch, false);
  assert.equal((await verifyBIAcceptance({ page, proxy: input.proxy })).summary.passed, 93);
});

test("query.pid与实际表格PID冲突不能得到93项通过", async () => {
  const input = evidence(); input.page = tablePage(input.page, "另一内存平台\nPID other");
  const report = await verifyBIAcceptance(input);
  assert.equal(report.summary.hasMismatch, true);
  assert.equal(report.checks.pageIdentity.status, "mismatch");
  assert.equal(report.summary.passed, 0);
  assert.equal(report.summary.unverified, 93);
});

test("顶层pid与query.pid声明矛盾始终阻断，columns形状及缺代理证据也不绕过", async () => {
  const input = evidence(); input.page.pid = "other";
  for (const proxy of [input.proxy, null]) {
    const report = await verifyBIAcceptance({ page: input.page, proxy });
    assert.equal(report.summary.hasMismatch, true);
    assert.equal(report.checks.pageIdentity.status, "mismatch");
    assert.equal(report.summary.passed, 0);
  }
  input.page = tablePage(input.page); input.page.pid = "other";
  const table = await verifyBIAcceptance(input);
  assert.equal(table.checks.pageIdentity.status, "mismatch");
});

test("无法确认目标行身份不通过，其他可识别PID行不能代替目标行", async () => {
  for (const platform of ["内存测试平台", "内存测试平台 PID"]) {
    const input = evidence(); input.page = tablePage(input.page, platform);
    const report = await verifyBIAcceptance(input);
    assert.equal(report.summary.unverified, 93);
    assert.equal(report.checks.pageIdentity.status, "unverified");
    assert.equal(report.summary.passed, 0);
  }
  const input = evidence(); input.page = tablePage(input.page);
  input.page.rows.push(["部分", "身份未采集", ...input.page.rows[0].slice(2)]);
  input.page.pid = "fixture";
  const report = await verifyBIAcceptance(input);
  assert.equal(report.checks.pageIdentity.status, "unverified");
  assert.equal(report.summary.passed, 0);
});

test("实际行内PID声明矛盾和坏行形状不被跳过", async () => {
  const input = evidence(); input.page = tablePage(input.page, "内存平台 PID fixture\nPID other");
  const conflict = await verifyBIAcceptance(input);
  assert.equal(conflict.checks.pageIdentity.status, "mismatch");
  assert.equal(conflict.summary.passed, 0);
  input.page = tablePage(evidence().page);
  input.page.rows.push("坏行");
  const malformed = await verifyBIAcceptance(input);
  assert.equal(malformed.checks.pageIdentity.status, "unverified");
  assert.equal(malformed.summary.passed, 0);
});

test("PID标记须独立出现，APID和SPID或尾部附文不能确认行身份", async () => {
  for (const platform of ["内存平台 APID fixture", "内存平台 SPID fixture", "内存平台 PID fixture 其他文字"]) {
    const input = evidence(); input.page = tablePage(input.page, platform);
    const report = await verifyBIAcceptance(input);
    assert.equal(report.checks.pageIdentity.status, "unverified", platform);
    assert.equal(report.summary.passed, 0, platform);
  }
});

test("PID三种标准写法支持独立标记和唯一目标行", async () => {
  for (const marker of ["PID fixture", "PID:fixture", "PID：fixture"]) {
    for (const prefix of ["", "内存平台\n"]) {
      const input = evidence(); input.page = tablePage(input.page, prefix + marker);
      const report = await verifyBIAcceptance(input);
      assert.equal(report.checks.pageIdentity.status, "passed", prefix + marker);
      assert.equal(report.summary.passed, 93, prefix + marker);
    }
  }
});

test("多PID表只核验可唯一确认的目标行，重复目标行不按首行推断", async () => {
  const input = evidence(); input.page = tablePage(input.page);
  const other = ["部分", "另一个内存平台 PID other", ...registry.map(() => "999")];
  input.page.rows.unshift(other);
  const report = await verifyBIAcceptance(input);
  assert.equal(report.checks.pageIdentity.status, "passed");
  assert.equal(report.summary.passed, 93);
  input.page.rows.push(structuredClone(input.page.rows[1]));
  const ambiguous = await verifyBIAcceptance(input);
  assert.equal(ambiguous.checks.pageIdentity.status, "unverified");
  assert.equal(ambiguous.summary.passed, 0);
});

test("脱敏输入不接受凭据且错误不回显秘密", async () => {
  const input = evidence(); input.proxy.authorization = "fixture-secret";
  await assert.rejects(verifyBIAcceptance(input), error => !error.message.includes("fixture-secret") && /凭据/.test(error.message));
});

test("归一化拒绝实际x-token、csrf、authentication与credential头", async () => {
  for (const key of ["x-token", "X_CSRF_TOKEN", "x.csrf.token", "Authentication", "Proxy-Authorization", "X-Credential", "id_token", "api_key"]) {
    const input = evidence(); input.proxy.headers = { [key]: "fixture-secret" };
    await assert.rejects(verifyBIAcceptance(input), error => !error.message.includes("fixture-secret") && /凭据/.test(error.message));
  }
});

test("CLI帮助和输入错误明确区分退出码", () => {
  const cli = fileURLToPath(new URL("./bi-acceptance.mjs", import.meta.url));
  const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /3证据不足有unverified/);
  const invalid = spawnSync(process.execPath, [cli, "--network"], { encoding: "utf8" });
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /核验输入读取或解析失败/);
});
