import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const normalize = value => String(value ?? "").replace(/[\s·]+/gu, "");
const check = (status, reason, details = {}) => ({ status, reason, ...details });
let helperPromise;

// Bundle existing TS projections in memory. The verifier never starts the app or an adapter.
async function helpers() {
  helperPromise ??= build({
    stdin: { resolveDir: root, loader: "ts", contents: `
      export { DETAIL_COLUMNS, detailColumnKey } from "./src/v2/design/operating-detail-columns.ts";
      export { OPERATING_LIVE_IDS, operatingLiveColumns } from "./src/v2/design/operating-live-model.ts";
      export { operatingValueLabel } from "./src/v2/design/operating-detail-snapshot.ts";
      export { livePointStateLabel } from "./src/v2/features/dashboards/LiveDashboardContext.tsx";
      export { safeDiagnosticSeries, diagnosticRatioInputs, retentionReferenceRatio } from "./src/v2/features/dashboards/diagnostic-inputs.ts";
      export { isMonthlyMetric, liveMonthlySeriesRows } from "./src/v2/features/dashboards/live-monthly-reading.ts";
      export { metricHeadingUnit } from "./src/components/metric-unit.ts";
      export { dailyDashboardSuccessSchema, dailyDashboardMatchesQuery } from "./contracts/daily-dashboard.ts";
    ` },
    bundle: true, platform: "node", format: "esm", loader: { ".css": "empty" },
    write: false, logLevel: "silent"
  }).then(result => import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`));
  return helperPromise;
}

export async function acceptanceRegistry() {
  const h = await helpers();
  return h.DETAIL_COLUMNS.map((column, index) => ({
    order: index + 1, key: h.detailColumnKey(column), name: column.metric.name,
    metricId: column.metric.id, bffMetricId: h.OPERATING_LIVE_IDS[h.detailColumnKey(column)],
    kind: column.kind, unit: column.unit, displayOnly: Boolean(column.displayOnly)
  }));
}

function assertSanitized(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (normalizedKey.endsWith("token") || /csrf|xsrf|authentication|authorization/.test(normalizedKey)
      || /^(?:x|proxy)?(?:auth|credentials?|password|passwd|secret|apikey)$|^(?:set)?cookie$/.test(normalizedKey)) {
      throw new Error("输入包含凭据字段；请提供脱敏后的证据文件。");
    }
    if (typeof child === "string" && /\bBearer\s+\S+|[?&](?:token|password|apiKey)=\S+/i.test(child)) {
      throw new Error("输入包含疑似凭据值；请提供脱敏后的证据文件。");
    }
    assertSanitized(child);
  }
}

function pageSnapshot(page, registry) {
  const unavailable = reason => ({ columns: null, identity: check("unverified", reason) });
  if (!page) return unavailable("页面快照缺失");
  const declared = [page.query?.pid, page.pid].filter(pid => pid !== undefined);
  const pids = declared.filter(pid => typeof pid === "string" && pid.trim().length > 0);
  if (new Set(pids).size > 1) return { columns: null, identity: check("mismatch", "页面query.pid与顶层pid声明冲突") };
  if (!pids.length || pids.length !== declared.length) return unavailable("页面PID声明缺失或无法识别");
  const pid = pids[0];
  if (Array.isArray(page.columns) && !Array.isArray(page.rows)) {
    return { columns: page.columns, identity: check("passed", "columns快照使用已记录的页面PID声明", { pid }) };
  }
  if (!Array.isArray(page.headers) || !Array.isArray(page.rows)) return unavailable("页面快照形状未支持");
  if (page.rows.some(row => !Array.isArray(row))) return unavailable("表格行形状无法识别");
  const rows = page.rows.map(row => {
    const cell = typeof row[1] === "string" ? row[1].trim() : "";
    const matches = [...cell.matchAll(/(?:^|\s)PID(?:\s*[:：]\s*|\s+)([^\s]+)/g)];
    const unique = new Set(matches.map(match => match[1]));
    return { row, conflict: unique.size > 1, pid: unique.size === 1 && cell.endsWith(matches.at(-1)[0]) ? matches[0][1] : null };
  });
  if (rows.some(row => row.conflict)) return { columns: null, identity: check("mismatch", "实际表格行包含冲突的PID标识") };
  const target = rows.filter(row => row.pid === pid);
  if (!target.length && rows.length && rows.every(row => row.pid !== null)) {
    return { columns: null, identity: check("mismatch", "实际表格PID与页面声明不一致", { pid }) };
  }
  if (target.length !== 1 || rows.some(row => row.pid === null)) return unavailable("无法唯一确认目标表格行的PID身份");
  const selected = target[0].row;
  const length = Math.max(page.headers.length, selected.length) - 2;
  const columns = Array.from({ length }, (_, i) => {
    const header = normalize(page.headers[i + 2]);
    const afterStatus = header.split(/待验数|演示数据|真实数据/)[1];
    return {
      key: registry[i]?.key ?? `unknown:${i + 1}`,
      name: header.split(/待验数|演示数据|真实数据/)[0],
      text: selected[i + 2],
      printedUnit: afterStatus?.match(/^（(.+)）$/)?.[1] ?? null
    };
  });
  return { columns, identity: check("passed", "页面声明与唯一目标表格行的PID一致", { pid }) };
}

function structure(items, registry, kind) {
  if (!items) return check("unverified", `${kind}证据缺失或形状未支持`);
  const keys = items.map(item => item.key);
  const missing = registry.filter(item => !keys.includes(item.key)).map(item => item.key);
  const duplicates = [...new Set(keys.filter((key, index) => keys.indexOf(key) !== index))];
  const unknown = keys.filter(key => !registry.some(item => item.key === key));
  const orderOrName = items.flatMap((item, i) => registry[i] && (item.key !== registry[i].key || normalize(item.name) !== normalize(registry[i].name)) ? [i + 1] : []);
  return check(items.length === registry.length && !missing.length && !duplicates.length && !unknown.length && !orderOrName.length ? "passed" : "mismatch",
    `${kind}列数、唯一键、名称与顺序`, { expectedCount: registry.length, actualCount: items.length, missing, duplicates, unknown, orderOrName });
}

function queryOfPage(page) {
  if (page?.query) return page.query;
  return page?.pid && page?.date ? { boardId: page.boardId ?? "5.2", pid: page.pid, dateRange: page.dateRange ?? [page.date, page.date] } : null;
}

function scopeCheck(page, proxy, response) {
  if (!page || !proxy || !response) return check("unverified", "需要页面快照和原始BI代理响应两份证据");
  if (!["test", "production"].includes(page.environment) || !["test", "production"].includes(proxy.environment)) {
    return check("unverified", "两份证据均须明确请求时的测试／正式环境");
  }
  const query = queryOfPage(page);
  if (!query) return check("unverified", "页面未记录查询范围");
  if (page.environment !== proxy.environment || query.boardId !== response.data.query.boardId || query.pid !== response.data.query.pid
    || JSON.stringify(query.dateRange) !== JSON.stringify(response.data.query.dateRange)) return check("mismatch", "环境、看板、PID或完整查询日期范围不一致");
  if (query.boardId !== "5.2") return check("unverified", "当前工具只核验经营明细93列");
  if (page.release && proxy.release && page.release !== proxy.release) return check("mismatch", "两份证据记录的发布版本不同");
  if (page.captureId && proxy.captureId && page.captureId !== proxy.captureId) return check("mismatch", "两份证据来自不同采集批次");
  if (!Number.isInteger(proxy.http)) return check("unverified", "BI代理证据缺少HTTP状态");
  if (proxy.http !== 200) return check("mismatch", "BI代理HTTP状态不是200");
  return check("passed", "两份脱敏证据的查询范围与环境一致；不证明实际采集来源或上游口径正确");
}

function sourceCheck(series, point, h) {
  if (!series || !point) return check("unverified", "同指标、同日期原始点未返回");
  if (point.inputs.length !== series.metric.inputs.length || point.inputs.some((input, index) => input.key !== series.metric.inputs[index].key)) {
    return check("mismatch", "计算输入键与BI指标契约不一致");
  }
  if (point.sourceStatus && point.sourceStatus !== "READY") {
    if (point.value !== null) return check("mismatch", "非READY来源携带正式数值");
    const safe = h.safeDiagnosticSeries(series).points.find(item => item.date === point.date);
    if (safe.state !== point.state) return check("mismatch", "来源状态与点状态不一致");
    if (point.inputs.some(input => input.value !== null) && !h.diagnosticRatioInputs(series.metric, point)) {
      return check("mismatch", "不可读来源携带不符合诊断契约的输入");
    }
    return check("known_limit", `正式结果不可用：${point.sourceStatus}`);
  }
  return point.state === "available" ? check("passed", "正式数值状态可读；0保留为真实0") : check("known_limit", `正式结果不可用：${point.state}`);
}

/** Read-only consistency verification. No result here grants upstream or production acceptance. */
export async function verifyBIAcceptance({ page = null, proxy = null, checklist = null } = {}) {
  [page, proxy, checklist].forEach(assertSanitized);
  const h = await helpers(), registry = await acceptanceRegistry();
  const registryIntegrity = check(registry.length === 93 && new Set(registry.map(column => column.key)).size === 93
    && registry.every(column => column.bffMetricId) ? "passed" : "mismatch", "权威经营注册须包含93个唯一列键与映射", { actualCount: registry.length });
  const snapshot = pageSnapshot(page, registry), captured = snapshot.columns, pageIdentity = snapshot.identity;
  const pageStructure = structure(captured, registry, "页面");
  const checklistStructure = structure(checklist?.columns ?? null, registry, "派生清单");
  if (checklistStructure.status === "passed") {
    const mappingDrift = checklist.columns.flatMap((column, i) => column.bffMetricId !== registry[i].bffMetricId || column.metricId !== registry[i].metricId ? [column.key] : []);
    if (mappingDrift.length) Object.assign(checklistStructure, check("mismatch", "派生清单指标映射与权威注册不同", { mappingDrift }));
  }
  const rawResponse = proxy?.response;
  const parsed = rawResponse ? h.dailyDashboardSuccessSchema.safeParse(rawResponse) : null;
  const response = parsed?.success ? parsed.data : null;
  const proxyContract = !rawResponse ? check("unverified", "原始BI代理响应缺失；旧清单的testBaseline和matches不替代响应")
    : !response ? check("mismatch", "原始BI代理响应不符合既有日看板契约", { issuePaths: parsed.error.issues.map(issue => issue.path.join(".")) })
      : check("passed", "符合既有BI响应契约");
  const scope = scopeCheck(page, proxy, response);
  const duplicateSeries = response ? [...new Set(response.data.series.map(series => series.metric.id).filter((id, i, ids) => ids.indexOf(id) !== i))] : [];
  const duplicatePoints = response?.data.series.flatMap(series => series.points.filter((point, i, points) => points.findIndex(item => item.date === point.date) !== i).map(point => `${series.metric.id}:${point.date}`)) ?? [];
  const proxyUniqueness = !response ? check("unverified", "BI响应缺失或不合法")
    : check(duplicateSeries.length || duplicatePoints.length ? "mismatch" : "passed", "BI序列与日期点必须唯一", { duplicateSeries, duplicatePoints });
  const proxyQueryMatch = !response ? check("unverified", "BI响应缺失或不合法")
    : check(h.dailyDashboardMatchesQuery(response, response.data.query, response.data.series.map(series => series.metric.id)) ? "passed" : "mismatch",
      "响应日期点序、天数、输入键及统计范围须符合完整查询契约");
  const date = queryOfPage(page)?.dateRange?.[1];
  const live = response ? { query: response.data.query, metricIds: response.data.series.map(series => series.metric.id), state: { status: "success", data: response } } : null;
  const projected = h.operatingLiveColumns(live);
  const columns = registry.map((registered, i) => {
    const observation = captured?.[i];
    const unavailable = check("unverified", "需要完整且同范围的页面／BI代理原响应证据");
    const base = { ...registered, status: "unverified", display: unavailable, unit: unavailable, sourceState: unavailable,
      pageState: check("unverified", "当前页面未独立记录状态"), formalReady: false, upstreamAcceptance: "unverified" };
    if (registryIntegrity.status !== "passed" || pageIdentity.status !== "passed" || pageStructure.status !== "passed" || scope.status !== "passed" || proxyContract.status !== "passed"
      || proxyUniqueness.status !== "passed" || proxyQueryMatch.status !== "passed") return base;
    const series = response.data.series.find(series => series.metric.id === registered.bffMetricId);
    const points = series && h.safeDiagnosticSeries(series);
    const point = h.isMonthlyMetric(registered.bffMetricId)
      ? series && h.liveMonthlySeriesRows(series, response).find(row => row.scope.month === date.slice(0, 7))?.point
      : series?.points.find(point => point.date === date);
    const safePoint = points?.points.find(item => item.date === point?.date);
    const sourceState = sourceCheck(series, point, h);
    if (!point || !safePoint) return { ...base, sourceState };
    const reference = h.retentionReferenceRatio(series.metric, point);
    const evidence = { state: safePoint.state, label: h.livePointStateLabel(safePoint, series.metric), ...(reference ? { referenceRatio: reference } : {}) };
    const value = { current: safePoint.state === "available" ? safePoint.value : null, evidence: { current: evidence } };
    const expected = h.operatingValueLabel(value, projected[i]);
    const display = observation.text === undefined ? check("unverified", "页面单元格缺失")
      : check(normalize(expected) === normalize(observation.text) ? "passed" : "mismatch", "页面读数与共享投影比较", { expected, observed: observation.text });
    const expectedPrinted = h.metricHeadingUnit(registered.name, projected[i].unit) || null;
    const unit = Object.hasOwn(observation, "printedUnit")
      ? check(observation.printedUnit === expectedPrinted ? "passed" : "mismatch", "显式单位／单位省略规则与共享投影比较", { source: series.metric.unit, projected: projected[i].unit, expectedPrinted, observedPrinted: observation.printedUnit, printedUnitObserved: observation.printedUnit !== null })
      : check("unverified", "页面未记录单位；不把投影单位算成实见单位", { source: series.metric.unit, projected: projected[i].unit });
    const stateKeys = ["state", "sourceStatus", "formalValue"];
    const pageState = stateKeys.every(key => Object.hasOwn(observation, key))
      ? check(observation.state === point.state && observation.sourceStatus === (point.sourceStatus ?? null) && observation.formalValue === value.current ? "passed" : "mismatch", "独立页面状态与正式值比较")
      : base.pageState;
    const statuses = [display, unit, sourceState, pageState].map(result => result.status);
    const status = statuses.includes("mismatch") ? "mismatch" : display.status === "unverified" || unit.status === "unverified" ? "unverified"
      : sourceState.status === "known_limit" ? "known_limit" : sourceState.status;
    return { ...base, status, display, unit, sourceState, pageState,
      formalReady: sourceState.status === "passed" && point.state === "available" && point.sourceStatus === "READY",
      formalValue: value.current, diagnosticInputs: h.diagnosticRatioInputs(series.metric, point), referenceRatio: reference?.value ?? null };
  });
  const counts = Object.fromEntries(["passed", "mismatch", "known_limit", "unverified"].map(status => [status, columns.filter(column => column.status === status).length]));
  const checks = { registryIntegrity, pageIdentity, pageStructure, checklistStructure, proxyContract, proxyUniqueness, proxyQueryMatch, scope };
  const hasMismatch = counts.mismatch > 0 || Object.values(checks).some(result => result.status === "mismatch");
  return {
    schemaVersion: "ypbi-offline-bi-consistency/v1", checks, columns,
    summary: { expectedColumns: registry.length, ...counts, hasMismatch,
      consistencyStatus: hasMismatch ? "mismatch" : counts.unverified ? "unverified" : counts.known_limit ? "known_limit" : "passed",
      formalReadyInProxy: columns.filter(column => column.formalReady).length,
      upstreamPassedColumns: 0, productionPassedColumns: 0 },
    boundary: { statusMeaning: "passed仅表示所给脱敏证据的BI响应与页面共享投影一致；known_limit保留实际不可用状态",
      originalUpstream: check("unverified", "未核对原始上游HTTP、业务码、规则口径和实际生产历史"),
      attribution: "页面／BI代理差异只能定位一致性或证据配对问题；BI来源状态和任务READY不能据此认定后端缺口或正式验数通过",
      networkRequestsPerformed: 0, credentialsRead: false, databaseWrites: 0, recalculationsRun: 0, sourceFilesModified: false }
  };
}

const help = `用法：node tools/bi-acceptance.mjs --page <脱敏页面.json> [--proxy <脱敏BI响应.json>] [--checklist <派生清单.json>]
仅离线读取显式JSON文件，报告写stdout，不联网、不读取凭据、不修改业务数据。退出码：0一致性已核完（允许known_limit），1发现mismatch，2输入错误，3证据不足有unverified。
--page 支持已存headers/rows经营快照，或 {environment, query:{boardId,pid,dateRange}, columns:[{key,name,text,printedUnit,...}]}。
--proxy 为 {environment:"test"|"production", http:200, response:<完整BI代理日看板成功JSON>}；必须记录请求时环境。
页面可用{pid,date}代表经营单日查询；dateRange若存在须与BI响应完整范围一致。release/captureId若两侧提供须一致。
query.pid与顶层pid须一致；headers/rows须能识别唯一目标行的PID，冲突记mismatch、身份不足记unverified。多PID表仅选择已明确声明的目标行。
structured columns可记录state/sourceStatus/formalValue；未记录的状态核验为unverified。printedUnit:null代表已观察到省略单位，缺字段代表未观察。
93列与映射从src/v2注册派生；旧清单的testBaseline、matches和READY汇总不作为原始代理响应。
上游原始验数和生产历史验数恒为unverified；本工具不支持专题DOM文本提取或运行线上验数。
`;

async function main(args) {
  if (!args.length || args.includes("--help")) { process.stdout.write(help); return; }
  const inputs = {};
  for (let i = 0; i < args.length; i += 2) {
    const role = { "--page": "page", "--proxy": "proxy", "--checklist": "checklist" }[args[i]];
    if (!role || !args[i + 1] || args[i + 1].startsWith("--") || inputs[role]) throw new Error("参数不合法；使用 --help 查看接口。");
    inputs[role] = JSON.parse(await fs.readFile(path.resolve(args[i + 1]), "utf8"));
  }
  const result = await verifyBIAcceptance(inputs);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exitCode = result.summary.hasMismatch ? 1 : result.summary.unverified > 0 ? 3 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(() => { process.stderr.write("核验输入读取或解析失败；请检查文件、脱敏和 --help 接口。\n"); process.exitCode = 2; });
}
