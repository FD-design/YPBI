import {selectReviewState} from './tools/qa-review-tools.mjs';
import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const baseUrl = process.env.YPBI_BASE_URL ?? "http://127.0.0.1:5173";
const INTERNAL_PRESENTATION_REFERENCE = /\b(?:DM|M)\d{3}\b|\bMD-\d+\b|\b01[AB]\b/i;
const metricDefinitions = JSON.parse(readFileSync(
  new URL("./server/v2/generated/metric-definitions.json", import.meta.url),
  "utf8"
));
const metricDefinitionsUi = JSON.parse(readFileSync(
  new URL("./src/v2/generated/metric-definitions-ui.json", import.meta.url),
  "utf8"
));
const analysisReadyMetricDefinitions = structuredClone(metricDefinitions);
const readyM016 = analysisReadyMetricDefinitions.items.find((item) => item.id === "M016");
if (!readyM016) throw new Error("QA 指标目录缺少 M016");
// This isolated successful-response fixture must be internally consistent.
// The real catalog and its stale mapping remain unchanged.
readyM016.ypbiMapping.status = "configured";
readyM016.ypbiMapping.authorityVersion = readyM016.authority.version;
readyM016.validation = {
  status: "passed",
  mappingVersion: readyM016.ypbiMapping.mappingVersion,
  authorityVersion: readyM016.authority.version,
  validatedAt: "2026-09-08T12:00:00+08:00",
  evidenceId: "qa-fixture-m016-validation"
};
readyM016.analysis = { status: "available", reasonCodes: [] };

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function refreshMetricDefinitionsHash(definitions) {
  const { contentSha256: _previous, ...snapshot } = definitions.snapshot;
  definitions.snapshot.contentSha256 = createHash("sha256").update(JSON.stringify(canonicalize({
    snapshot,
    categories: definitions.categories,
    items: definitions.items
  })), "utf8").digest("hex");
}

refreshMetricDefinitionsHash(analysisReadyMetricDefinitions);

function metricDefinitionUi(metricId) {
  const metricDefinition = metricDefinitionsUi.items.find((item) => item.id === metricId);
  if (!metricDefinition) throw new Error(`QA 指标界面口径投影缺少 ${metricId}`);
  return metricDefinition;
}

async function expectMetricDefinitionInteraction(page, scope, metricId) {
  const metricDefinition = metricDefinitionUi(metricId);
  const trigger = scope.getByRole("button", {
    name: `查看${metricDefinition.name}说明`,
    exact: true
  });
  await expect(trigger).toHaveCount(1);
  await trigger.evaluate((element) => element.scrollIntoView({ block: "center", inline: "center" }));

  await trigger.hover();
  const tooltipId = await trigger.getAttribute("aria-describedby");
  expect(tooltipId).toBeTruthy();
  const tooltip = page.locator(`[id="${tooltipId}"]`);
  await expect(tooltip).toContainText(metricDefinition.definition);

  await trigger.hover();
  await expect(tooltip).toBeVisible();
  await page.getByRole("heading", { name: "核心经营总览", exact: true }).hover();
  await expect(tooltip).toBeHidden();

  await page.keyboard.press("Tab"); await trigger.focus();
  await expect(trigger).toBeFocused();
  await expect(tooltip).toBeVisible();
  await trigger.press("Enter");
  const detail = page.getByRole("dialog", { name: `${metricDefinition.name} · 指标说明`, exact: true });
  await expect(detail).toContainText(metricDefinition.definition);
  await detail.getByRole("button", { name: "关闭详情", exact: true }).click();
  await expect(detail).toHaveCount(0);
}

async function expectInside(inner, outer, epsilon = 1) {
  const innerBox = await inner.boundingBox();
  const outerBox = await outer.boundingBox();
  expect(innerBox && outerBox).toBeTruthy();
  expect(innerBox.x).toBeGreaterThanOrEqual(outerBox.x - epsilon);
  expect(innerBox.y).toBeGreaterThanOrEqual(outerBox.y - epsilon);
  expect(innerBox.x + innerBox.width).toBeLessThanOrEqual(outerBox.x + outerBox.width + epsilon);
  expect(innerBox.y + innerBox.height).toBeLessThanOrEqual(outerBox.y + outerBox.height + epsilon);
}

async function expectChainPanelFlow(panel, expected) {
  const stages = panel.locator('[data-chain-part="stages"]');
  const relationships = panel.locator('[data-chain-part="relationships"]');
  const diagnostics = panel.locator('[data-chain-part="diagnostics"]');
  await expect(stages.locator(":scope > li")).toHaveCount(expected.stages);
  await expect(relationships.locator('[data-chain-item="relationship"]')).toHaveCount(expected.relationships);
  await expect(diagnostics.locator('[data-chain-item="diagnostic"]')).toHaveCount(expected.diagnostics);

  const stagesBox = await stages.boundingBox();
  const relationshipsBox = await relationships.boundingBox();
  expect(stagesBox && relationshipsBox).toBeTruthy();
  expect(relationshipsBox.y).toBeGreaterThanOrEqual(stagesBox.y + stagesBox.height - 1);
  await expectInside(stages, panel);
  await expectInside(relationships, panel);

  for (const item of await relationships.locator('[data-chain-item="relationship"]').all()) {
    expect(await item.evaluate((element) => getComputedStyle(element).position)).not.toBe("absolute");
    await expectInside(item, panel);
  }

  if (expected.diagnostics > 0) {
    const diagnosticsBox = await diagnostics.boundingBox();
    expect(diagnosticsBox).toBeTruthy();
    expect(diagnosticsBox.y).toBeGreaterThanOrEqual(relationshipsBox.y + relationshipsBox.height - 1);
    await expectInside(diagnostics, panel);
    for (const item of await diagnostics.locator('[data-chain-item="diagnostic"]').all()) {
      expect(await item.evaluate((element) => getComputedStyle(element).position)).not.toBe("absolute");
      await expectInside(item, panel);
    }
  }

  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
}

const CHAIN_TEST_CASES = [
  {
    key: "content",
    label: "内容消费",
    metrics: ["M016", "M026", "M035", "M081"],
    structure: { stages: 3, relationships: 1, diagnostics: 0 }
  },
  {
    key: "acquisition",
    label: "获客转化",
    metrics: ["M001", "M003", "M008", "M005", "M006", "M007"],
    structure: { stages: 3, relationships: 3, diagnostics: 0 }
  },
  {
    key: "payment",
    label: "支付链路",
    metrics: ["M084", "M086", "M090", "M070", "M071", "M072"],
    structure: { stages: 2, relationships: 1, diagnostics: 3 }
  }
];

const DETAIL_METRIC_IDS = [
  "M016", "M008", "M026", "M102", "M059", "M058",
  "M081", "M036", "M020", "M061", "M090"
];

test.use({
  viewport: { width: 1280, height: 800 },
  channel: "chrome"
});

function authenticatedSession(role = "maintainer", mustChangePassword = false, csrfToken = "c".repeat(43)) {
  return {
    success: true,
    data: {
      user: {
        subjectId: "00000000-0000-4000-8000-000000000001",
        username: "qa.user",
        displayName: "QA 用户",
        role,
        permissions: role === "maintainer"
          ? ["bi:read", "bi:data-source-maintenance:enter"]
          : ["bi:read"],
        pidScope: "all"
      },
      expiresAt: "2099-09-08T00:00:00.000Z",
      mustChangePassword,
      csrfToken
    }
  };
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/bi/v2/auth/session", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(authenticatedSession())
  }));
});

// These route fixtures exist only in browser QA. Production V2 code always calls
// the real read-only /api/bi/v2 endpoints and never imports data from this file.
const metric = {
  id: "M016",
  code: "daily_active_user_count",
  name: "日活跃用户数",
  definition: "当天打开并登录产品的去重用户数",
  unit: "人",
  valueType: "integer",
  authority: {
    document: "全站指标体系.md",
    version: readyM016.authority.version,
    validationStatus: "pending_validation",
    statusLabel: "技术称已实现（待验数）"
  },
  capabilities: {
    grains: ["day"],
    platformMode: "single_pid",
    dimensions: [],
    filters: [],
    comparisons: []
  }
};
const analysisReadyMetric = structuredClone(metric);
analysisReadyMetric.authority.validationStatus = "passed";
analysisReadyMetric.authority.statusLabel = "真实验数已通过";

function enumerateBusinessDates(dateRange) {
  const businessDates = [];
  const cursor = new Date(`${dateRange[0]}T00:00:00Z`);
  const end = new Date(`${dateRange[1]}T00:00:00Z`);
  while (cursor <= end) {
    businessDates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return businessDates;
}

function trustedWatermark(dateRange, pid) {
  return {
    type: "complete_through_business_date",
    completeThrough: dateRange[1],
    timeZone: "Asia/Shanghai",
    pid,
    sourceApiId: "/api/admin/statistics/pDaySum",
    sourceKind: "upstream_explicit",
    observedAt: new Date(`${dateRange[1]}T16:10:00Z`).toISOString()
  };
}

function fetchedAfterWatermark(dateRange) {
  return new Date(`${dateRange[1]}T16:11:00Z`).toISOString();
}

const defaultPlatforms = [{ id: "HX-001", pid: "PH", name: "Pornhub", order: 1 }];

async function installCatalogFixtures(page, definitions = metricDefinitions, platforms = defaultPlatforms) {
  await page.route("**/api/bi/v2/catalog/metric-definitions", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ success: true, data: typeof definitions === "function" ? definitions() : definitions })
  }));
  await page.route("**/api/bi/v2/catalog/metrics", (route) => {
    const currentDefinitions = typeof definitions === "function" ? definitions() : definitions;
    const currentM016 = currentDefinitions.items.find((item) => item.id === "M016");
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        data: { items: [currentM016?.analysis.status === "available" ? analysisReadyMetric : metric] }
      })
    });
  });
  await page.route("**/api/bi/v2/catalog/platforms", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ success: true, data: { items: platforms } })
  }));
}

async function installSuccessfulReadFixtures(
  page,
  onQuery = () => {},
  definitions = analysisReadyMetricDefinitions,
  queryReadiness = { mappingVersion: "m016-pday-sum-v1", validationStatus: "passed" },
  platforms = defaultPlatforms
) {
  await installCatalogFixtures(page, definitions, platforms);
  await page.route("**/api/bi/v2/queries/metrics", async (route) => {
    const request = route.request().postDataJSON();
    onQuery(request);
    const businessDates = enumerateBusinessDates(request.dateRange);
    const unavailableDate = businessDates.at(-1);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        data: {
          metric: queryReadiness.validationStatus === "passed" ? analysisReadyMetric : metric,
          scope: { pid: request.pid, platformName: "Pornhub" },
          grain: "day",
          dateRange: request.dateRange,
          seriesStatus: "partial",
          points: businessDates.slice(0, -1).map((businessDate, index) => ({
            businessDate,
            value: index === 0 ? 0 : 100 + index,
            state: "available"
          })),
          unavailableDates: [{ businessDate: unavailableDate, state: "no_record" }]
        },
        meta: {
          queryId: "query-qa-success",
          sourceApiIds: ["/api/admin/statistics/pDaySum"],
          fetchedAt: fetchedAfterWatermark(request.dateRange),
          ...queryReadiness,
          watermark: queryReadiness.validationStatus === "passed" ? trustedWatermark(request.dateRange, request.pid) : null,
          warnings: ["QA fixture：验证真实 0 与缺失状态不会混淆。"]
        }
      })
    });
  });
}

test("M016 默认使用平台目录首项，未应用的草稿条件不会伪装成当前结果", async ({ page }) => {
  const queries = [];
  const platforms = [
    { id: "HX-003", pid: "TT", name: "TikTok", order: 1 },
    { id: "HX-001", pid: "PH", name: "Pornhub", order: 2 }
  ];
  await installSuccessfulReadFixtures(
    page,
    (query) => queries.push(query),
    analysisReadyMetricDefinitions,
    { mappingVersion: "m016-pday-sum-v1", validationStatus: "passed" },
    platforms
  );

  await page.goto(`${baseUrl}/analysis/metrics/M016`, { waitUntil: "domcontentloaded" });
  await expect.poll(() => new URL(page.url()).searchParams.get("pid")).toBe("TT");
  expect(queries).toHaveLength(1);
  expect(queries[0].pid).toBe("TT");

  const resultTable = page.getByRole("region", { name: "完整查询结果" });
  await resultTable.getByRole("button", { name: /^导出/ }).click();
  await expect(page.getByRole("dialog", { name: /^导出/ })).toContainText("正式导出服务尚未接入");
  await expect(page.getByRole("button", { name: "下载 XLSX", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");

  const appliedEnd = new URL(page.url()).searchParams.get("end");
  const appliedStart = new URL(page.url()).searchParams.get("start");
  expect(appliedEnd).toBeTruthy();
  expect(appliedStart).toBeTruthy();
  await page.getByRole("button", { name: /日期范围：/ }).click();
  await page.getByLabel("结束日期", { exact: true }).fill(appliedStart);
  await page.getByRole("button", { name: "确认日期", exact: true }).click();
  await expect(page.getByText("查询条件尚未应用", { exact: true })).toBeVisible();
  expect(queries).toHaveLength(1);
  expect(new URL(page.url()).searchParams.get("end")).toBe(appliedEnd);

  await page.getByRole("button", { name: "应用并查询" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("end")).toBe(appliedStart);
  await expect.poll(() => queries.length).toBe(2);
  await expect(page.getByText("查询条件尚未应用", { exact: true })).toHaveCount(0);
});

test("1280 完整目录不把待验数样板开放为正式分析，技术切片仍正确展示并保持 URL 历史", async ({ page }) => {
  const queries = [];
  let formalAnalysisReady = false;
  await installSuccessfulReadFixtures(
    page,
    (query) => queries.push(query),
    () => formalAnalysisReady ? analysisReadyMetricDefinitions : metricDefinitions
  );

  await page.goto(`${baseUrl}/data/metrics`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "指标中心", exact: true })).toBeVisible();
  await expect(page.locator("#metric-open-M016")).toBeVisible();
  await expect(page.locator('[data-page="metric-catalog"]')).not.toContainText(INTERNAL_PRESENTATION_REFERENCE);
  await page.screenshot({ path: "/private/tmp/ypbi-v2-metric-catalog-1280.png", fullPage: true });

  await page.locator("#metric-open-M016").click();
  const detail = page.getByRole("dialog", { name: "日活跃用户数" });
  await expect(detail).toBeVisible();
  await expect(detail).not.toContainText(INTERNAL_PRESENTATION_REFERENCE);
  await expect(detail.getByText("首个接入样板", { exact: true })).toBeVisible();
  await expect(detail.getByRole("button", { name: "暂不可分析" })).toBeDisabled();
  await expect.poll(async () => {
    const footer = await detail.locator(".v2-metric-detail__foot").boundingBox();
    return footer ? Math.ceil(footer.y + footer.height) : Number.POSITIVE_INFINITY;
  }).toBeLessThanOrEqual(800);
  await page.screenshot({ path: "/private/tmp/ypbi-v2-metric-detail-1280.png", fullPage: true });
  await detail.getByRole("button", { name: "关闭指标详情" }).click();
  await expect(detail).toBeHidden();
  await expect(page.locator("#metric-open-M016")).toBeFocused();

  const rowDetailTrigger = page.locator("tr", { has: page.locator("#metric-open-M016") }).getByRole("button", { name: "查看详情" });
  await rowDetailTrigger.click();
  await expect(detail).toBeVisible();
  await detail.getByRole("button", { name: "关闭指标详情" }).click();
  await expect(detail).toBeHidden();
  await expect(rowDetailTrigger).toBeFocused();

  await page.getByRole("button", { name: /周期派生指标/ }).last().click();
  await page.locator("#metric-open-DM001").click();
  const derivedDetail = page.getByRole("dialog", { name: "累计活跃人天" });
  await expect(derivedDetail).not.toContainText(INTERNAL_PRESENTATION_REFERENCE);
  const longSourceStatus = derivedDetail.getByText("基础指标技术称已实现（待验数），派生结果待验数", { exact: true });
  await expect(longSourceStatus).toBeVisible();
  await expect.poll(() => longSourceStatus.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect.poll(() => longSourceStatus.evaluate((element) => {
    const cell = element.parentElement;
    return Boolean(cell) && cell.scrollWidth <= cell.clientWidth;
  })).toBe(true);
  await derivedDetail.getByRole("button", { name: "关闭指标详情" }).click();

  await page.goto(`${baseUrl}/analysis/metrics/M016`, { waitUntil: "domcontentloaded" });
  await expect(page.getByText("错误代码：METRIC_NOT_READY")).toBeVisible();
  expect(queries).toHaveLength(0);

  // 受控 QA 在这里模拟完成当前映射版本的验数，证明正式页只有状态通过后才会查询。
  formalAnalysisReady = true;
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "日活跃用户数", exact: true })).toBeVisible();
  await expect(page.locator('[data-page="metric-analysis"]')).not.toContainText(INTERNAL_PRESENTATION_REFERENCE);
  await expect.poll(() => new URL(page.url()).searchParams.get("pid")).toBe("PH");
  await expect.poll(() => new URL(page.url()).searchParams.has("start")).toBe(true);
  await expect.poll(() => new URL(page.url()).searchParams.has("end")).toBe(true);
  expect(queries).toHaveLength(1);

  await expect(page.locator(".v2-result-surface .chart")).toHaveAttribute("role", "img");
  await expect(page.locator(".v2-result-surface canvas")).toBeVisible();
  const table = page.locator(".v2-result-table");
  await expect(table).toBeVisible();
  await expect(table.locator("tbody tr")).toHaveCount(7);
  await expect(table.getByRole("cell", { name: "0", exact: true })).toBeVisible();
  await expect(table.getByText("无记录", { exact: true })).toBeVisible();
  await expect(page.getByText(/Asia\/Shanghai/).first()).toBeVisible();
  await page.screenshot({ path: "/private/tmp/ypbi-v2-desktop-success.png", fullPage: true });

  const canonicalUrl = page.url();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(canonicalUrl);
  await expect(page.getByRole("heading", { name: "日活跃用户数", exact: true })).toBeVisible();
  expect(queries).toHaveLength(2);

  await page.goBack();
  await expect(page).toHaveURL(`${baseUrl}/data/metrics`);
  await expect(page.getByRole("heading", { name: "指标中心", exact: true })).toBeVisible();

  await page.goForward();
  await expect(page).toHaveURL(canonicalUrl);
  await expect(page.locator(".v2-result-table")).toBeVisible();
});

test("未开放的指标深链保留内部路由键但错误页不展示指标编号", async ({ page }) => {
  await page.goto(`${baseUrl}/analysis/metrics/M999`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "指标分析", exact: true })).toBeVisible();
  await expect(page.getByText("该指标暂未开放分析", { exact: true })).toBeVisible();
  await expect(page.locator('[data-page="metric-analysis"]')).not.toContainText(INTERNAL_PRESENTATION_REFERENCE);
  await expect(page).toHaveURL(`${baseUrl}/analysis/metrics/M999`);
});

test("目录已通过但查询响应未绑定已验数映射时拒绝展示", async ({ page }) => {
  await installSuccessfulReadFixtures(
    page,
    () => {},
    analysisReadyMetricDefinitions,
    { mappingVersion: "m016-pday-sum-v1", validationStatus: "pending_validation" }
  );

  await page.goto(`${baseUrl}/analysis/metrics/M016`, { waitUntil: "domcontentloaded" });
  await expect(page.getByText("错误代码：METRIC_NOT_READY")).toBeVisible();
  await expect(page.locator(".v2-result-surface")).toHaveCount(0);
  await expect(page.locator(".v2-result-table")).toHaveCount(0);
});

test("1024 有记录但全无值时保留逐日状态，不画图也不补 0", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await installCatalogFixtures(page, analysisReadyMetricDefinitions);
  await page.route("**/api/bi/v2/queries/metrics", async (route) => {
    const request = route.request().postDataJSON();
    const businessDates = enumerateBusinessDates(request.dateRange);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        data: {
          metric: analysisReadyMetric,
          scope: { pid: request.pid, platformName: "Pornhub" },
          grain: request.grain,
          dateRange: request.dateRange,
          seriesStatus: "no_values",
          points: [],
          unavailableDates: businessDates.map((businessDate, index) => ({
            businessDate,
            state: index === 0 ? "no_value" : "no_record"
          }))
        },
        meta: {
          queryId: "query-qa-no-values",
          sourceApiIds: ["/api/admin/statistics/pDaySum"],
          fetchedAt: fetchedAfterWatermark(request.dateRange),
          mappingVersion: "m016-pday-sum-v1",
          validationStatus: "passed",
          watermark: trustedWatermark(request.dateRange, request.pid),
          warnings: ["QA fixture：有记录但指标值为空。"]
        }
      })
    });
  });

  await page.goto(`${baseUrl}/analysis/metrics/M016`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "有记录但无可用值" })).toBeVisible();
  await expect(page.locator(".v2-result-surface")).toHaveCount(0);
  await expect(page.locator(".v2-result-table tbody tr")).toHaveCount(7);
  await expect(page.locator(".v2-result-table tbody td.is-number")).toHaveText(["—", "—", "—", "—", "—", "—", "—"]);
  await expect(page.getByText("无值", { exact: true })).toBeVisible();
  await expect(page.getByText("无记录", { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: "/private/tmp/ypbi-v2-no-values-1024.png", fullPage: true });
});

test("查询回显与原请求不一致时拒绝结果并展示稳定错误码", async ({ page }) => {
  await installCatalogFixtures(page, analysisReadyMetricDefinitions);
  await page.route("**/api/bi/v2/queries/metrics", async (route) => {
    const request = route.request().postDataJSON();
    const businessDates = enumerateBusinessDates(request.dateRange);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        data: {
          metric: analysisReadyMetric,
          scope: { pid: "XH", platformName: "错误回显平台" },
          grain: request.grain,
          dateRange: request.dateRange,
          seriesStatus: "available",
          points: businessDates.map((businessDate, index) => ({ businessDate, value: index, state: "available" })),
          unavailableDates: []
        },
        meta: {
          queryId: "query-qa-echo-conflict",
          sourceApiIds: ["/api/admin/statistics/pDaySum"],
          fetchedAt: fetchedAfterWatermark(request.dateRange),
          mappingVersion: "m016-pday-sum-v1",
          validationStatus: "passed",
          watermark: trustedWatermark(request.dateRange, "XH"),
          warnings: ["QA fixture：服务端回显 PID 与请求不一致。"]
        }
      })
    });
  });

  await page.goto(`${baseUrl}/analysis/metrics/M016`, { waitUntil: "domcontentloaded" });
  await expect(page.getByText("错误代码：INVALID_V2_QUERY_RESPONSE")).toBeVisible();
  await expect(page.locator(".v2-result-surface")).toHaveCount(0);
  await expect(page.locator(".v2-result-table")).toHaveCount(0);
});

test("已验数响应缺少可信水位时前端拒绝展示业务值", async ({ page }) => {
  await installCatalogFixtures(page, analysisReadyMetricDefinitions);
  await page.route("**/api/bi/v2/queries/metrics", async (route) => {
    const request = route.request().postDataJSON();
    const businessDates = enumerateBusinessDates(request.dateRange);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        data: {
          metric: analysisReadyMetric,
          scope: { pid: request.pid, platformName: "Pornhub" },
          grain: request.grain,
          dateRange: request.dateRange,
          seriesStatus: "available",
          points: businessDates.map((businessDate, index) => ({ businessDate, value: 100 + index, state: "available" })),
          unavailableDates: []
        },
        meta: {
          queryId: "query-qa-missing-watermark",
          sourceApiIds: ["/api/admin/statistics/pDaySum"],
          fetchedAt: fetchedAfterWatermark(request.dateRange),
          mappingVersion: "m016-pday-sum-v1",
          validationStatus: "passed",
          watermark: null,
          warnings: []
        }
      })
    });
  });

  await page.goto(`${baseUrl}/analysis/metrics/M016`, { waitUntil: "domcontentloaded" });
  await expect(page.getByText("错误代码：INVALID_V2_RESPONSE")).toBeVisible();
  await expect(page.locator(".v2-result-surface")).toHaveCount(0);
  await expect(page.locator(".v2-result-table")).toHaveCount(0);
});

test("503 身份来源不可用时失败关闭并显示请求 ID", async ({ page }) => {
  await page.route("**/api/bi/v2/catalog/metric-definitions", (route) => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({
      success: false,
      error: {
        code: "IDENTITY_PROVIDER_UNAVAILABLE",
        message: "正式身份来源当前不可用",
        requestId: "req-qa-503"
      }
    })
  }));

  await page.goto(`${baseUrl}/data/metrics`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "身份能力暂不可用" })).toBeVisible();
  await expect(page.getByText("错误代码：IDENTITY_PROVIDER_UNAVAILABLE")).toBeVisible();
  await expect(page.getByText("请求 ID：req-qa-503")).toBeVisible();
  await expect(page.locator(".v2-table-surface")).toHaveCount(0);
  await page.screenshot({ path: "/private/tmp/ypbi-v2-identity-unavailable.png", fullPage: false });
});

test("指标目录内容与声明哈希不一致时拒绝渲染", async ({ page }) => {
  const forgedDefinitions = structuredClone(metricDefinitions);
  forgedDefinitions.items[0].name = "被篡改的指标名称";
  await page.route("**/api/bi/v2/catalog/metric-definitions", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ success: true, data: forgedDefinitions })
  }));

  await page.goto(`${baseUrl}/data/metrics`, { waitUntil: "domcontentloaded" });
  await expect(page.getByText("错误代码：INVALID_V2_RESPONSE")).toBeVisible();
  await expect(page.locator(".v2-table-surface")).toHaveCount(0);
  await expect(page.getByText("被篡改的指标名称")).toHaveCount(0);
});

test("桌面产品导航按任务展开，保留页不伪装成已上线能力", async ({ page }) => {
  await page.route("**/api/bi/v2/catalog/platforms",route=>route.fulfill({json:{success:true,data:{items:defaultPlatforms}}}));
  await page.route("**/api/bi/v2/catalog/readable-dashboards",route=>route.fulfill({json:{success:true,data:{enabled:false,categories:[],items:[{id:"5.2",title:"核心经营总览",category:null,metricIds:[],pendingMetricNames:[]}]}}}));
  await page.goto(`${baseUrl}/dashboards/public`, { waitUntil: "domcontentloaded" });
  const logo = page.getByRole("link", { name: "YPBI 指标中心" }).locator("img.v2-brand-logo");
  await expect(logo).toBeVisible();
  expect(await logo.evaluate((image) => image.complete && image.naturalWidth > image.naturalHeight)).toBe(true);
  const navigation = page.getByRole("navigation", { name: "产品主导航" });
  await expect(navigation.getByRole("button")).toHaveCount(3);
  for (const [area, labels] of [
    ["看板中心", ["公共概览", "我的概览", "指标速览"]],
    ["分析中心", ["指标分析", "事件分析", "漏斗分析", "已保存的分析"]],
    ["数据中心", ["指标中心", "事件中心"]]
  ]) {
    await navigation.getByRole("button", { name: area, exact: true }).hover();
    for (const label of labels) await expect(navigation.getByRole("link", { name: label, exact: true })).toBeVisible();
    await expect(page).toHaveURL(`${baseUrl}/dashboards/public`);
  }
  await expect(page.locator(".dashboard-workbench")).toBeVisible();
  await expect(page.getByRole("heading",{name:"当前环境未开启真实看板读取",exact:true})).toBeVisible();
  await expect(page.locator(".dashboard-workbench__content .dashboard-metric-card")).toHaveCount(0);
  await navigation.getByRole("button", { name: "分析中心", exact: true }).hover();
  await navigation.getByRole("link", { name: "事件分析", exact: true }).click();
  await expect(page).toHaveURL(`${baseUrl}/analysis/events`);
  await expect(navigation.getByRole("button", { name: "分析中心", exact: true })).toHaveClass("is-active");
  await expect(page.getByRole("heading", { name: "事件分析", exact: true })).toBeVisible();
  await navigation.getByRole("button", { name: "分析中心", exact: true }).hover();
  await expect(navigation.getByRole("link", { name: "事件分析", exact: true })).toHaveAttribute("aria-current", "page");
  await page.goBack();
  await expect(page).toHaveURL(`${baseUrl}/dashboards/public`);
  await navigation.getByRole("button", { name: "看板中心", exact: true }).hover();
  await expect(navigation.getByRole("link", { name: "公共概览", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(navigation.getByRole("link", { name: "我的收藏", exact: true })).toHaveCount(0);
  await page.goto(`${baseUrl}/dashboards/favorites`);
  await expect(page).toHaveURL(`${baseUrl}/dashboards/public`);
});

test("核心经营总览设计样板独立验证 1280、1024、390 与组合异常态", async ({ page }) => {
  const businessRequests = [];
  const authenticationRequests = [];
  page.on("request", (request) => {
    if (/\/api\/bi\/v2\/(?:catalog|queries)\//.test(request.url())) businessRequests.push(request.url());
    if (request.url().includes("/api/bi/v2/auth/session")) authenticationRequests.push(request.url());
  });

  await page.goto(`${baseUrl}/dashboards/public?design=core-overview`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "核心经营总览", exact: true })).toBeVisible();
  await expect(page.getByText("固定演示数据，不是正式业务结果，也不接入生产查询。", { exact: true })).toHaveCount(0);
  await page.getByRole('button',{name:/账号菜单/}).click();
  await page.getByRole('menuitem',{name:'体验工具',exact:true}).click();
  await expect(page.getByText("固定演示数据，不是正式业务结果，也不接入生产查询。", { exact: true })).toBeVisible();
  const chartExperienceLink = page.getByRole("link", { name: "查看完整图表体验", exact: true });
  await expect(chartExperienceLink).toBeVisible();
  await expect(chartExperienceLink).toHaveAttribute("href", "/dashboards/public?design=v1-chart-states");
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:/^对比周期：/}).click();
  await page.getByRole('option',{name:'上一等长周期',exact:true}).click();
  await page.getByRole('button',{name:'应用',exact:true}).click();
  for (const internalCode of ["01A", "01B", "02", "03", "M016", "M080", "MD-06"]) {
    await expect(page.getByRole("main").getByText(internalCode, { exact: true })).toHaveCount(0);
  }
  const metricCards = page.locator(".dashboard-metric-card:not(.is-value)");
  await expect(metricCards).toHaveCount(9);
  await expect(page.locator(".core-review__page-head .core-review__filter-bar")).toHaveCount(1);
  const titleBox = await page.locator(".core-review__page-head h1").boundingBox();
  const toolbarBox = await page.locator(".core-review__filter-bar").boundingBox();
  expect(titleBox && toolbarBox).toBeTruthy();
  expect(toolbarBox.x).toBeGreaterThan(titleBox.x);
  const toolbarSurface = await page.locator(".core-review__filter-bar").evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, borderTopWidth: style.borderTopWidth, boxShadow: style.boxShadow };
  });
  expect(toolbarSurface).toEqual({ background: "rgba(0, 0, 0, 0)", borderTopWidth: "0px", boxShadow: "none" });
  await expect(metricCards.locator(":scope > footer")).toHaveCount(0);
  await expect(metricCards.first().locator("header p")).toContainText("数据至 09-08");
  await expect(metricCards.first().locator("header p")).not.toContainText("已验数");
  await expect(metricCards.first().getByText("演示数据", { exact: true })).toBeVisible();
  await expect(metricCards.first().locator(".dashboard-mini-trend__point.is-current")).toHaveCount(7);
  await expect(metricCards.first().locator(".dashboard-mini-trend__point.is-paired")).toHaveCount(0);
  await expect(metricCards.first().locator(".dashboard-mini-trend__point.is-comparison")).toHaveCount(7);
  await expect.poll(async () => (await metricCards.first().locator(".dashboard-mini-trend__canvas").boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(80);
  const dateLabels = metricCards.first().locator(".dashboard-mini-trend__x-axis span");
  await expect(dateLabels.first()).toHaveText("09-02");
  await expect(dateLabels.last()).toHaveText("09-08");
  expect(await dateLabels.count()).toBeGreaterThanOrEqual(2);
  expect(await dateLabels.count()).toBeLessThanOrEqual(7);
  const labelBounds = await dateLabels.evaluateAll(elements => elements.map(element => {
    const { left, right } = element.getBoundingClientRect(); return { left, right };
  }));
  for (let index = 1; index < labelBounds.length; index++) expect(labelBounds[index].left).toBeGreaterThanOrEqual(labelBounds[index - 1].right - 1);
  await expect(metricCards.nth(1).locator(".dashboard-mini-trend.is-line svg path.is-current")).toHaveCount(1);
  await expect(metricCards.nth(1).locator(".dashboard-mini-trend svg rect")).toHaveCount(0);
  const markerPointerEvents = await metricCards.nth(1).locator(".dashboard-mini-trend__point").first().evaluate((element) => getComputedStyle(element, "::before").pointerEvents);
  expect(markerPointerEvents).toBe("none");
  expect(businessRequests).toEqual([]);
  expect(authenticationRequests).toEqual([]);

  const first = await metricCards.nth(0).boundingBox();
  const second = await metricCards.nth(1).boundingBox();
  const third = await metricCards.nth(2).boundingBox();
  const fourth = await metricCards.nth(3).boundingBox();
  expect(first && second && third && fourth).toBeTruthy();
  expect(Math.abs(first.y - second.y)).toBeLessThan(2);
  expect(Math.abs(first.y - third.y)).toBeLessThan(2);
  expect(fourth.y).toBeGreaterThan(first.y + 100);

  const scopeTrigger = page.getByRole("button", { name: "业务范围：大盘整体" });
  await scopeTrigger.focus();
  await page.keyboard.press("ArrowDown");
  const scopeListbox = page.getByRole("listbox", { name: "业务范围" });
  await expect(scopeListbox).toBeVisible();
  await expect(scopeListbox.getByRole("option", { name: /^XH · XHamster/ })).toBeDisabled();
  await page.keyboard.press("x");
  await expect(scopeListbox.getByRole("option", { name: /^大盘整体/ })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(scopeTrigger).toBeFocused();

  const dateTrigger = page.getByRole("button", { name: /日期范围：/ });
  await dateTrigger.click();
  const dateDialog = page.getByRole("dialog", { name: "选择日期范围" });
  await expect(dateDialog).toBeVisible();
  for (const shortcut of ["过去 7 天", "过去 30 天", "本月"]) {
    await expect(dateDialog.getByRole("button", { name: shortcut, exact: true })).toBeVisible();
  }
  await dateDialog.getByRole("button", { name: "2026.09.03", exact: true }).click();
  await expect(dateDialog.getByText("已选开始日期 2026.09.03，请选择结束日期", { exact: true })).toBeVisible();
  await dateDialog.getByRole("button", { name: "2026.09.05", exact: true }).click();
  await dateDialog.getByRole("button", { name: "确认日期", exact: true }).click();
  await expect(dateTrigger).toHaveText(/2026\.09\.03 — 2026\.09\.05/);
  await expect(page.getByText("条件已修改，点击“应用”后更新结果", { exact: true })).toBeVisible();
  await expect(page.locator(".core-review__detail-actions time")).toHaveText("数据日 2026-09-08");
  await page.getByRole("button", { name: "应用", exact: true }).click();
  await expect(page.locator(".core-review__detail-actions time")).toHaveText("数据日 2026-09-05");
  await dateTrigger.click();
  await dateDialog.getByRole("button", { name: "过去 7 天", exact: true }).click();
  await dateDialog.getByRole("button", { name: "确认日期", exact: true }).click();
  await page.getByRole("button", { name: "应用", exact: true }).click();
  await expect(page.locator(".core-review__detail-actions time")).toHaveText("数据日 2026-09-08");

  const trendPoint = metricCards.first().locator(".dashboard-mini-trend__point").last();
  await trendPoint.hover();
  const trendTooltip = page.locator(".ui-hint-panel");
  await expect(trendTooltip).toBeVisible();
  await expect(trendTooltip).toContainText("当前 2026-09-08");
  await expect(trendTooltip).toContainText("对比 2026-09-01");
  await expect(trendTooltip).not.toContainText("第 7 日");
  await expect(trendTooltip).not.toContainText("单位：");
  const effectiveViewCard = metricCards.filter({ has: page.getByRole("link", { name: "有效观影率", exact: true }) });
  const effectiveViewHint = effectiveViewCard.getByRole("button", { name: "查看有效观影率说明", exact: true });
  await effectiveViewHint.hover();
  await expect(page.locator(".ui-hint-panel")).toContainText("有效观看次数 ÷ 起播次数");
  await effectiveViewHint.focus();
  await expect(page.locator(".ui-hint-panel")).toBeVisible();

  const comparisonTrigger = page.getByRole("button", { name: /对比周期：/ });
  await comparisonTrigger.click();
  await page.getByRole("option", { name: /^不对比/ }).click();
  await page.getByRole("button", { name: "应用", exact: true }).click();
  await expect(metricCards.locator(".dashboard-metric-card__comparison")).toHaveCount(0);
  await expect(metricCards.locator(".is-compare")).toHaveCount(0);
  await expect(metricCards.locator(".dashboard-mini-trend__point.is-comparison")).toHaveCount(0);
  await expect(metricCards.first().locator(".dashboard-mini-trend__legend")).toBeHidden();
  await comparisonTrigger.click();
  await page.getByRole("option", { name: "上一等长周期", exact: true }).click();
  await page.getByRole("button", { name: "应用", exact: true }).click();

  const comparisonRegion = page.getByRole("region", { name: "业务平台经营指标横向比较表" });
  const detailRows = comparisonRegion.locator("tbody tr");
  await expect(detailRows.first().locator("td").nth(1)).toContainText("Pornhub");
  await expect(detailRows.first().locator("td").nth(1)).toContainText("PID PH");
  const activeSortHeader = comparisonRegion.locator('thead th[data-column-key="M016:overall"]');
  await expect(activeSortHeader).toHaveAttribute("aria-sort", "descending");
  await activeSortHeader.getByRole("button", { name: "按日活跃用户数升序排列", exact: true }).click();
  await expect(activeSortHeader).toHaveAttribute("aria-sort", "ascending");
  await expect(detailRows.first().locator("td").nth(1)).toContainText("XNXX");
  await activeSortHeader.getByRole("button", { name: "按日活跃用户数降序排列", exact: true }).click();
  const descriptionTrigger = page.getByRole("button", { name: "查看看板说明" });
  await descriptionTrigger.click();
  await expect(page.getByRole("dialog", { name: "看板说明" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "看板说明" })).toBeHidden();
  await expect(descriptionTrigger).toBeFocused();
  await page.screenshot({ path: "/private/tmp/ypbi-core-overview-review-1280-normal.png", fullPage: true });

  await selectReviewState(page, '组合异常态');
  await expect(metricCards).toHaveCount(9);
  await expect(page.locator('[data-page="core-overview-design-fixture"]')).not.toContainText("真实 0");
  await expect(page.getByText("正在加载", { exact: true }).first()).toBeVisible();
  const partialCard = metricCards.filter({ hasText: "付费用户数" });
  await expect(partialCard.locator(".dashboard-metric-card__unavailable").getByText("有记录但无值", { exact: true })).toBeVisible();
  await expect(partialCard.locator(".dashboard-metric-card__value strong")).toHaveCount(0);
  await expect(partialCard.getByRole("button", { name: "较前一天 不可比", exact: true })).toBeVisible();
  await expect(partialCard.getByRole("button", { name: "较上周同日 不可比", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "重试此卡" })).toHaveCount(1);
  await expect(page.getByText("刷新失败，保留旧值", { exact: true }).first()).toBeVisible();
  await expect(page.locator(".dashboard-metric-card__unavailable").getByText("当前范围无记录", { exact: true })).toBeVisible();
  await expect(page.locator(".dashboard-metric-card__unavailable").getByText("等待数据成熟", { exact: true })).toBeVisible();
  await expect(page.locator(".dashboard-metric-card__unavailable").getByText("单卡查询失败", { exact: true })).toBeVisible();
  await expect(page.getByText("5/9 项展示结果", { exact: true })).toBeVisible();
  const zeroCard = metricCards.filter({ hasText: "观影总时长" });
  await expect(zeroCard.locator(".dashboard-metric-card__value strong")).toHaveText("0");
  await expect(zeroCard.locator(":scope > footer")).toHaveCount(0);
  await expect(zeroCard.getByRole("button", { name: "较前一天 不可比", exact: true })).toBeVisible();
  await expect(zeroCard.getByRole("button", { name: "较上周同日 -100.00%", exact: true })).toBeVisible();
  await expect(zeroCard.getByRole("button", { name: /当前期第 7 日，当前 2026-09-08 · 0 小时，对比 2026-09-01/ })).toBeVisible();
  await expect(partialCard.getByRole("button", { name: /当前期第 7 日，当前 2026-09-08 · 有记录但无值，对比 2026-09-01 · 2,600 人，差值 不可比/ })).toBeVisible();
  await page.screenshot({ path: "/private/tmp/ypbi-core-overview-review-1280.png", fullPage: true });

  await page.setViewportSize({ width: 1024, height: 900 });
  const controlsAt1024 = await Promise.all([
    page.getByRole("button", { name: /业务范围：/ }).boundingBox(),
    page.getByRole("button", { name: /日期范围：/ }).boundingBox(),
    page.getByRole("button", { name: /对比周期：/ }).boundingBox(),
    page.getByRole("button", { name: "应用", exact: true }).boundingBox()
  ]);
  expect(controlsAt1024.every(Boolean)).toBe(true);
  expect(Math.max(...controlsAt1024.map((box) => box.y)) - Math.min(...controlsAt1024.map((box) => box.y))).toBeLessThan(2);
  const firstAt1024 = await metricCards.nth(0).boundingBox();
  const secondAt1024 = await metricCards.nth(1).boundingBox();
  const thirdAt1024 = await metricCards.nth(2).boundingBox();
  expect(firstAt1024 && secondAt1024 && thirdAt1024).toBeTruthy();
  expect(Math.abs(firstAt1024.y - secondAt1024.y)).toBeLessThan(2);
  expect(thirdAt1024.y).toBeGreaterThan(firstAt1024.y + 100);
  await page.screenshot({ path: "/private/tmp/ypbi-core-overview-review-1024.png", fullPage: false });

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileNavigation = page.locator("#v2-primary-navigation");
  await expect(mobileNavigation).toHaveAttribute("aria-hidden", "true");
  await expect.poll(async () => (await mobileNavigation.boundingBox())?.x ?? 0).toBeLessThan(-250);
  const firstAt390 = await metricCards.nth(0).boundingBox();
  const secondAt390 = await metricCards.nth(1).boundingBox();
  expect(firstAt390 && secondAt390).toBeTruthy();
  expect(secondAt390.y).toBeGreaterThan(firstAt390.y + 150);
  await expect(dateTrigger).toBeVisible();
  for (const action of ["复制当前视图链接", "导出核心经营总览", "刷新看板"]) {
    await expect(page.getByRole("button", { name: action, exact: true })).toBeVisible();
  }
  const copyAction = page.getByRole("button", { name: "复制当前视图链接", exact: true });
  await copyAction.hover();
  await expect(copyAction.getByRole("tooltip")).toBeVisible();
  await page.screenshot({ path: "/private/tmp/ypbi-core-overview-review-390-clean.png", fullPage: false });
  await expect(comparisonRegion.getByRole("table")).toBeVisible();
  expect(await comparisonRegion.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "/private/tmp/ypbi-core-overview-review-390.png", fullPage: false });
});

test("全局涨跌在两体验页的卡片、质量、表格与深色提示中保持统一", async ({ page }) => {
  await page.goto(`${baseUrl}/dashboards/public?design=core-overview`);
  await expect(page.getByRole("heading", { name: "核心经营总览", exact: true })).toBeVisible();
  await page.getByRole('button',{name:/^对比周期：/}).click();
  await page.getByRole('option',{name:'上一等长周期',exact:true}).click();
  await page.getByRole('button',{name:'应用',exact:true}).click();
  const tokenColor = async (name) => page.evaluate((token) => {
    const hex = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
    return `rgb(${hex.slice(1).match(/../g).map((part) => parseInt(part, 16)).join(", ")})`;
  }, name);
  const up = await tokenColor("--color-change-up");
  const down = await tokenColor("--color-change-down");
  const darkUp = await tokenColor("--color-change-up-on-emphasis");
  const cards = page.locator(".dashboard-metric-card:not(.is-value)");
  const summary = cards.locator(".dashboard-metric-card__comparison [data-change-direction]");
  await expect(cards.getByRole("button", { name: /^较前一天/ })).toHaveCount(8);
  await expect(cards.getByRole("button", { name: /^较上周同日/ })).toHaveCount(8);
  await expect(summary).toHaveCount(17);
  for (const element of await summary.all()) {
    const direction = await element.getAttribute("data-change-direction");
    await expect(element).toHaveCSS("color", direction === "up" ? up : down);
    await expect(element).toHaveText(direction === "up" ? /^[+↑]/ : /^[-−↓]/);
  }
  await page.getByRole("button", { name: /^经营明细变化参考：/ }).click();
  await page.getByRole("option", { name: "较昨日", exact: true }).click();
  for (const section of [".core-review__quality", ".core-review__comparison-table"]) {
    const items = page.locator(`${section} [data-change-direction="up"], ${section} [data-change-direction="down"]`);
    expect(await items.count()).toBeGreaterThan(0);
    for (const item of await items.all()) {
      const direction = await item.getAttribute("data-change-direction");
      await expect(item).toHaveCSS("color", direction === "up" ? up : down);
    }
  }
  await page.keyboard.press("Tab");
  for (const series of ["current", "comparison"]) {
    const point = cards.first().locator(`.dashboard-mini-trend__point.is-${series}`).last();
    await point.focus();
    const delta = page.locator(".ui-hint-panel").locator('[data-change-direction="up"]');
    await expect(delta).toBeVisible();
    await expect(delta).toHaveCSS("color", darkUp);
  }
  await selectReviewState(page, '组合异常态');
  const zero = cards.filter({ has: page.getByRole("link", { name: "观影总时长", exact: true }) });
  await expect(zero.locator('.dashboard-metric-card__comparison [data-change-direction="down"]')).toHaveCSS("color", down);
  await selectReviewState(page, '正常态');
  await page.screenshot({ path: "/private/tmp/ypbi-direction-colors-1280.png", fullPage: false });

  await page.goto(`${baseUrl}/dashboards/public?design=v1-chart-states`);
  await expect(page.getByRole("heading", { name: "V1 图表与状态体验", exact: true })).toBeVisible();
  const gallery = page.locator(".v1-gallery");
  await expect(gallery.locator('.v1-gallery__kpi-grid .dashboard-metric-card')).toHaveCount(11);
  await expect(gallery.locator('.v1-gallery__kpi-grid .dashboard-metric-card__comparison')).toHaveCount(0);
  await expect(gallery.locator('[data-chart-kind="kpi-detailed"] .dashboard-metric-card__comparison [data-change-direction="up"]')).toHaveCSS("color", up);
  const comparisonPanel = gallery.locator('[data-chart-kind="line-comparison"]');
  await comparisonPanel.getByRole("button", { name: "查看同口径数据表", exact: true }).click();
  const comparisonTable = page.getByRole("dialog", { name: "当前期与对比期同口径数据表", exact: true });
  for (const direction of ["up", "down"]) {
    const cell = comparisonTable.locator(`td [data-change-direction="${direction}"]`).first();
    await expect(cell).toBeVisible();
    await expect(cell).toHaveCSS("color", direction === "up" ? up : down);
  }
  await expect(comparisonTable.locator('td [data-change-direction="unavailable"]')).toHaveText("不可比");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Tab");
  await comparisonPanel.getByRole("button", { name: /查看 2026-09-05 当前期/ }).focus();
  await expect(comparisonPanel.getByRole("tooltip").locator('[data-change-direction="up"]')).toHaveCSS("color", darkUp);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(gallery.locator('[data-chart-kind="kpi-detailed"] .dashboard-metric-card__comparison [data-change-direction="up"]')).toHaveCSS("color", up);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("核心经营总览关键链路以三项可键盘切换的 Tab 承载全部权威指标", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(`${baseUrl}/dashboards/public?design=core-overview`, { waitUntil: "domcontentloaded" });

  const chainSection = page.locator('section[aria-labelledby="core-key-chains"]');
  const tabList = chainSection.getByRole("tablist", { name: "关键业务链路", exact: true });
  await expect(tabList).toBeVisible();
  await expect(tabList.getByRole("tab")).toHaveCount(3);
  await expect(chainSection).not.toContainText(INTERNAL_PRESENTATION_REFERENCE);

  for (const [index, chain] of CHAIN_TEST_CASES.entries()) {
    const tab = tabList.getByRole("tab", { name: chain.label, exact: true });
    const panel = chainSection.locator(`#core-chain-panel-${chain.key}`);
    await expect(tab).toHaveAttribute("aria-controls", `core-chain-panel-${chain.key}`);
    await expect(panel).toHaveAttribute("role", "tabpanel");
    await expect(panel).toHaveAttribute("aria-labelledby", `core-chain-tab-${chain.key}`);
    await expect(tab).toHaveAttribute("aria-selected", index === 0 ? "true" : "false");
    if (index === 0) await expect(panel).toBeVisible();
    else await expect(panel).toBeHidden();
  }

  const contentTab = tabList.getByRole("tab", { name: "内容消费", exact: true });
  const acquisitionTab = tabList.getByRole("tab", { name: "获客转化", exact: true });
  const paymentTab = tabList.getByRole("tab", { name: "支付链路", exact: true });
  await contentTab.focus();
  await contentTab.press("ArrowRight");
  await expect(acquisitionTab).toBeFocused();
  await expect(acquisitionTab).toHaveAttribute("aria-selected", "true");
  await acquisitionTab.press("ArrowRight");
  await expect(paymentTab).toBeFocused();
  await expect(paymentTab).toHaveAttribute("aria-selected", "true");
  await paymentTab.press("ArrowRight");
  await expect(contentTab).toBeFocused();
  await expect(contentTab).toHaveAttribute("aria-selected", "true");
  await contentTab.press("ArrowLeft");
  await expect(paymentTab).toBeFocused();
  await expect(paymentTab).toHaveAttribute("aria-selected", "true");
  await paymentTab.press("Home");
  await expect(contentTab).toBeFocused();
  await contentTab.press("End");
  await expect(paymentTab).toBeFocused();

  for (const chain of CHAIN_TEST_CASES) {
    const tab = tabList.getByRole("tab", { name: chain.label, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    const panel = chainSection.locator(`#core-chain-panel-${chain.key}`);
    await expect(panel).toBeVisible();
    await expectChainPanelFlow(panel, chain.structure);
    for (const metricId of chain.metrics) {
      await expectMetricDefinitionInteraction(page, panel, metricId);
    }
  }

  const paymentPanel = chainSection.locator("#core-chain-panel-payment");
  await expect(paymentPanel).not.toContainText("付费用户");
  await expect(paymentPanel).not.toContainText("到账订单/用户");
  await expect(paymentPanel.getByText("1.08", { exact: true })).toHaveCount(0);
});

test("核心经营总览质量区与经营明细表头统一提供权威释义且不干扰排序", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(`${baseUrl}/dashboards/public?design=core-overview`, { waitUntil: "domcontentloaded" });

  const quality = page.getByRole("complementary", { name: "关键质量与数据状态", exact: true });
  for (const metricId of ["M080", "M031"]) {
    await expectMetricDefinitionInteraction(page, quality, metricId);
  }

  const comparisonRegion = page.getByRole("region", { name: "业务平台经营指标横向比较表", exact: true });
  const detailRows = comparisonRegion.locator("tbody tr");
  await expect(detailRows.first().locator("td").nth(1)).toContainText("Pornhub");

  for (const metricId of DETAIL_METRIC_IDS) {
    const metricDefinition = metricDefinitionUi(metricId);
    const definitionTrigger = comparisonRegion.getByRole("button", {
      name: `查看${metricDefinition.name}说明`,
      exact: true
    });
    const header = definitionTrigger.locator("xpath=ancestor::th");
    await expect(header).toHaveCount(1);
    await expect(header.getByRole("button")).toHaveCount(2);
    const sortBefore = await header.getAttribute("aria-sort");
    const firstPidBefore = await detailRows.first().locator("td").nth(1).innerText();

    await expectMetricDefinitionInteraction(page, comparisonRegion, metricId);

    await expect(header).toHaveAttribute("aria-sort", sortBefore);
    expect(await detailRows.first().locator("td").nth(1).innerText()).toBe(firstPidBefore);
    await expect(header.getByRole("button", {
      name: new RegExp(`^按${metricDefinition.name}(?:升序|降序)排列$`)
    })).toHaveCount(1);
  }

  const activeMetric = metricDefinitionUi("M016");
  const activeDefinitionTrigger = comparisonRegion.getByRole("button", {
    name: `查看${activeMetric.name}说明`,
    exact: true
  });
  const activeHeader = activeDefinitionTrigger.locator("xpath=ancestor::th");
  await expect(activeHeader).toHaveAttribute("aria-sort", "descending");
  await activeHeader.getByRole("button", { name: `按${activeMetric.name}升序排列`, exact: true }).click();
  await expect(activeHeader).toHaveAttribute("aria-sort", "ascending");
  await expect(detailRows.first().locator("td").nth(1)).toContainText("XNXX");
});

test("核心经营总览三条链路在 390 视口保持正常流且不制造页面横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/dashboards/public?design=core-overview`, { waitUntil: "domcontentloaded" });

  const chainSection = page.locator('section[aria-labelledby="core-key-chains"]');
  const tabList = chainSection.getByRole("tablist", { name: "关键业务链路", exact: true });
  await tabList.scrollIntoViewIfNeeded();
  expect(await tabList.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  for (const tab of await tabList.getByRole("tab").all()) {
    await expect.poll(async () => (await tab.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  }

  for (const chain of CHAIN_TEST_CASES) {
    await tabList.getByRole("tab", { name: chain.label, exact: true }).click();
    const panel = chainSection.locator(`#core-chain-panel-${chain.key}`);
    await expect(panel).toBeVisible();
    await expectChainPanelFlow(panel, chain.structure);
    const panelBox = await panel.boundingBox();
    expect(panelBox).toBeTruthy();
    expect(panelBox.x).toBeGreaterThanOrEqual(-1);
    expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(391);
    for (const part of await panel.locator("[data-chain-part]").all()) {
      const partBox = await part.boundingBox();
      expect(partBox).toBeTruthy();
      expect(partBox.x).toBeGreaterThanOrEqual(panelBox.x - 1);
      expect(partBox.x + partBox.width).toBeLessThanOrEqual(panelBox.x + panelBox.width + 1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  }
});

test("V1 图表与状态体验页只在精确开发地址开放并覆盖类型、状态与 390 响应式", async ({ page }) => {
  const protectedRequests = [];
  page.on("request", (request) => {
    if (/\/api\/bi\/v2\/(?:auth\/session|catalog|queries)/.test(request.url())) protectedRequests.push(request.url());
  });

  await page.goto(`${baseUrl}/dashboards/public?design=v1-chart-states`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "V1 图表与状态体验", exact: true })).toBeVisible();
  await expect(page.getByText("固定视觉样例，不接 API、不保存、不代表真实业务结果。", { exact: true })).toBeVisible();
  expect(protectedRequests).toEqual([]);

  for (const kind of [
    "kpi-compact", "kpi-detailed", "line-single", "line-comparison", "line-multi", "line-multi-pid",
    "bar-time", "bar-comparison", "bar-horizontal-ranking", "bar-stacked", "pie", "donut",
    "table-aggregate", "table-crosstab", "funnel-real", "cohort-matrix", "latency-distribution"
  ]) {
    await expect(page.locator(`[data-chart-kind="${kind}"]`)).toHaveCount(1);
  }
  await expect(page.locator('.chart[role="img"]')).toHaveCount(26);
  const landingStages = page.locator('[data-chart-kind="landing-stage-comparison"]');
  await expect(landingStages.locator('.acquisition-visuals__stages > section')).toHaveCount(3);
  await expect(landingStages.locator('.acquisition-visuals__relations > section')).toHaveCount(3);
  await expect(landingStages.getByRole("button", { name: "计算依据", exact: true })).toHaveCount(3);
  await expect(landingStages.getByRole("button", { name: "查看趋势与数据", exact: true })).toHaveCount(6);
  await expect(landingStages.locator('.chart')).toHaveCount(0);
  await expect(page.locator('.chart[role="img"]').first()).toHaveAttribute("aria-label", "日活跃用户数逐日折线趋势");
  await expect(page.locator('[data-page="v1-chart-states-fixture"]')).not.toContainText(INTERNAL_PRESENTATION_REFERENCE);
  await expect(page.getByText(/权威源尚未确认稳定分位输出/)).toBeVisible();
  await page.getByRole("button", { name: "专用分析 3", exact: true }).click();
  await expect(page.locator('[data-chart-kind="funnel-real"]')).toBeInViewport();
  expect(new URL(page.url()).hash).toBe("");
  await expect(page.getByRole("heading", { name: "V1 图表与状态体验", exact: true })).toBeVisible();
  expect(protectedRequests).toEqual([]);

  const comparisonChart = page.locator('[data-chart-kind="line-comparison"] .chart');
  await comparisonChart.scrollIntoViewIfNeeded();
  const accessibleComparisonPoint = page.getByRole("button", { name: "查看 2026-09-05 当前期与 2026-08-29 对比期数据" });
  await accessibleComparisonPoint.hover();
  await expect(page.getByText(/当前期 2026-09-05 · 176,540 人/)).toBeVisible();
  await expect(page.getByText(/对比期 2026-08-29 · 171,320 人/)).toBeVisible();
  await expect(page.getByText(/较对比期 \+5,220 人/)).toBeVisible();
  await accessibleComparisonPoint.focus();
  await expect(page.getByRole("tooltip", { name: /当前期 2026-09-05/ })).toBeVisible();

  const metricHint = page.getByRole("region", { name: "纯数值卡", exact: true }).getByRole("button", { name: "查看活跃用户观影率说明" });
  await metricHint.hover();
  await expect(page.locator(".ui-hint-panel").filter({ hasText: "观影用户" })).toBeVisible();

  const pidLegend = page.getByRole("group", { name: "当前目录全部业务 PID" });
  const pidOptions = pidLegend.getByRole("button");
  await expect(pidOptions.first()).toBeVisible();
  expect(await pidOptions.count()).toBeLessThan(20);
  for (const name of ["TikTok", "小红书", "色虎", "PH·Prem", "调教师"]) {
    await page.getByPlaceholder("搜索业务名称或 PID").fill(name);
    await pidOptions.first().click();
  }
  await expect(page.getByText("已突出 5 / 5 项", { exact: true })).toBeVisible();
  await page.getByPlaceholder("搜索业务名称或 PID").fill("TikTok");
  await expect(pidLegend.getByRole("button")).toHaveCount(1);
  await page.getByRole("button", { name: "查看全部 PID 同口径数据表", exact: true }).click();
  await expect(page.getByRole("dialog").locator('tbody tr')).toHaveCount(20);
  await page.keyboard.press("Escape");
  await page.screenshot({ path: "/private/tmp/ypbi-v1-chart-states-1280.png", fullPage: true });

  const firstSnapshot = page.getByRole("button", { name: "查看同口径数据表", exact: true }).first();
  await firstSnapshot.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "日活跃用户数逐日数据", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(firstSnapshot).toBeFocused();

  await page.setViewportSize({ width: 1024, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1024);
  const firstLineAt1024 = await page.locator('[data-chart-kind="line-single"]').boundingBox();
  const secondLineAt1024 = await page.locator('[data-chart-kind="line-comparison"]').boundingBox();
  expect(firstLineAt1024 && secondLineAt1024).toBeTruthy();
  expect(secondLineAt1024.y).toBeGreaterThan(firstLineAt1024.y + 100);
  await page.screenshot({ path: "/private/tmp/ypbi-v1-chart-states-1024.png", fullPage: false });

  await page.getByRole("button", { name: "状态与边界", exact: true }).click();
  await expect(page.locator('[data-chart-kind="state-boundaries"]')).toBeVisible();
  await expect(page.locator("[data-state-example]")).toHaveCount(11);
  await expect(page.locator('[data-state-example="zero"]')).toContainText("真实 0");
  await expect(page.locator('[data-state-example="immature"]')).toContainText("未成熟");
  await expect(page.locator('[data-state-example="not-produced"]')).toContainText("未产出");
  await expect(page.locator('[data-state-example="refresh-failed"]')).toContainText("刷新失败");
  await expect(page.locator('[data-chart-kind="line-single"]')).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByRole("button", { name: "图表全集", exact: true }).click();
  const aggregateTableRegion = page.getByRole("region", { name: "平台经营聚合结果" });
  await expect(aggregateTableRegion).toBeVisible();
  expect(await aggregateTableRegion.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "/private/tmp/ypbi-v1-chart-states-390.png", fullPage: false });
  expect(protectedRequests).toEqual([]);
});

test("设计评审身份只绑定精确开发地址，离开后立即恢复真实会话检查", async ({ page }) => {
  let authenticationRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/bi/v2/auth/session")) authenticationRequests += 1;
  });

  await page.goto(`${baseUrl}/dashboards/public?design=core-overview`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "核心经营总览", exact: true })).toBeVisible();
  expect(authenticationRequests).toBe(0);

  await page.getByRole("link", { name: "YPBI 指标中心" }).click();
  await expect(page).toHaveURL(`${baseUrl}/data/metrics?design=catalog-center`);
  expect(authenticationRequests).toBe(0);
  await page.getByRole('link',{name:'连接真实数据',exact:true}).click();
  await expect(page).toHaveURL(`${baseUrl}/admin/data-sources`);
  await expect.poll(() => authenticationRequests).toBe(1);
  await expect(page.getByRole("heading", { name: "核心经营总览", exact: true })).toHaveCount(0);

  for (const nonExactUrl of [
    `${baseUrl}/dashboards/public?design=core-overview&extra=1`,
    `${baseUrl}/dashboards/public/?design=core-overview`,
    `${baseUrl}/dashboards/public?design=core-overview#unexpected`,
    `${baseUrl}/dashboards/public?design=v1-chart-states&extra=1`,
    `${baseUrl}/dashboards/public/?design=v1-chart-states`,
    `${baseUrl}/dashboards/public?design=v1-chart-states#unexpected`,
    `${baseUrl}/dashboards/public?design=other`
  ]) {
    const beforeNavigation = authenticationRequests;
    await page.goto(nonExactUrl, { waitUntil: "domcontentloaded" });
    await expect.poll(() => authenticationRequests).toBe(beforeNavigation + 1);
    await expect(page.getByRole("heading", { name: "核心经营总览", exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "V1 图表与状态体验", exact: true })).toHaveCount(0);
  }
});

test("390 分组选择器支持完整键盘导航并把焦点还给触发器", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installCatalogFixtures(page);
  await page.goto(`${baseUrl}/data/metrics`, { waitUntil: "domcontentloaded" });

  const trigger = page.locator(".v2-category-mobile .ui-menu-select__trigger");
  await expect(trigger).toHaveAttribute("aria-label", "指标业务分类：全部指标");
  await trigger.focus();
  await page.keyboard.press("ArrowDown");
  const listbox = page.getByRole("listbox", { name: "指标业务分类" });
  await expect(listbox).toBeVisible();
  const options = listbox.getByRole("option");
  await expect(options.first()).toBeFocused();

  await page.keyboard.press("End");
  const lastOption = options.last();
  await expect(lastOption).toBeFocused();
  const selectedLabel = await lastOption.getAttribute("data-option-label");
  expect(selectedLabel).toBeTruthy();
  await page.keyboard.press("Enter");
  await expect(listbox).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-label", `指标业务分类：${selectedLabel}`);

  await page.keyboard.press("ArrowUp");
  await expect(listbox).toBeVisible();
  await expect(listbox.getByRole("option").last()).toBeFocused();
  await page.keyboard.press("Home");
  await expect(listbox.getByRole("option").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(listbox).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("390 移动导航使用 modal dialog、恢复焦点且不横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let formalAnalysisReady = false;
  await installSuccessfulReadFixtures(
    page,
    () => {},
    () => formalAnalysisReady ? analysisReadyMetricDefinitions : metricDefinitions
  );
  await page.goto(`${baseUrl}/data/metrics`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "指标中心", exact: true })).toBeVisible();
  const mobileBrandLogo = page.getByRole("link", { name: "YPBI 指标中心" }).locator("img.v2-brand-logo");
  await expect(mobileBrandLogo).toBeVisible();
  await expect.poll(async () => (await mobileBrandLogo.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(21);
  await expect(page.locator(".v2-table-surface")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const mobileCategory = page.getByRole("button", { name: "指标业务分类：全部指标" });
  await expect(mobileCategory).toBeVisible();
  await expect.poll(async () => (await mobileCategory.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  await mobileCategory.click();
  const categoryListbox = page.getByRole("listbox", { name: "指标业务分类" });
  await expect(categoryListbox.getByText("用户生命周期", { exact: true })).toBeVisible();
  await categoryListbox.getByRole("option", { name: /活跃规模/ }).click();
  await expect(page.getByRole("button", { name: "指标业务分类：活跃规模" })).toBeVisible();
  await expect(page.locator("#metric-open-M016")).toBeVisible();
  await page.screenshot({ path: "/private/tmp/ypbi-v2-metric-catalog-390.png", fullPage: false });

  await page.locator("#metric-open-M016").click();
  const metricDetail = page.getByRole("dialog", { name: "日活跃用户数" });
  await expect(metricDetail).toBeVisible();
  await expect(metricDetail.getByText("数据源状态", { exact: true })).toBeVisible();
  await expect(metricDetail.getByText("YPBI 接入", { exact: true })).toBeVisible();
  await expect(metricDetail.getByText("验数 / 可用性", { exact: true })).toBeVisible();
  await page.keyboard.press("Tab");
  const detailBody = metricDetail.getByRole("region", { name: "指标详情内容" });
  await expect(detailBody).toBeFocused();
  await page.keyboard.press("PageDown");
  await expect.poll(() => detailBody.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect.poll(async () => {
    const footer = await metricDetail.locator(".v2-metric-detail__foot").boundingBox();
    return footer ? Math.ceil(footer.y + footer.height) : Number.POSITIVE_INFINITY;
  }).toBeLessThanOrEqual(844);
  await expect(metricDetail.getByRole("button", { name: "暂不可分析" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "/private/tmp/ypbi-v2-metric-detail-390.png", fullPage: false });
  await metricDetail.getByRole("button", { name: "关闭指标详情" }).click();
  await expect(metricDetail).toBeHidden();
  await expect(page.locator("#metric-open-M016")).toBeFocused();

  formalAnalysisReady = true;
  await page.goto(`${baseUrl}/analysis/metrics/M016`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "日活跃用户数", exact: true })).toBeVisible();
  await expect(page.locator(".v2-result-table")).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 220));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(220);
  await expect.poll(async () => (await page.locator(".v2-topbar").boundingBox())?.y ?? -1).toBe(0);

  const navigation = page.locator("#v2-primary-navigation");
  await expect(navigation).toHaveAttribute("aria-hidden", "true");
  await expect(navigation).toHaveAttribute("inert", "");
  const openButton = page.getByRole("button", { name: "打开主导航" });
  await openButton.click();

  const dialog = page.getByRole("dialog", { name: "产品导航" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(dialog.getByRole("button", { name: "关闭主导航" })).toBeFocused();
  expect(await page.evaluate(() => document.body.dataset.scrollLocked)).toBe("true");
  await expect.poll(async () => (await dialog.boundingBox())?.x).toBe(0);
  await expect.poll(async () => (await dialog.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(290);
  await expect(dialog.getByRole("list", { name: "看板中心页面" })).toBeVisible();
  await expect(dialog.getByRole("list", { name: "分析中心页面" })).toBeVisible();
  await expect(dialog.getByRole("list", { name: "数据中心页面" })).toBeVisible();
  await expect.poll(async () => (await dialog.getByRole("link", { name: /^指标速览/ }).boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: "/private/tmp/ypbi-v2-mobile-navigation.png", fullPage: false });

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(openButton).toBeFocused();
  expect(await page.evaluate(() => document.body.dataset.scrollLocked)).toBeUndefined();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
