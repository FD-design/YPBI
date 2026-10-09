import { expect, test } from "@playwright/test";

const base = process.env.YPBI_BASE_URL ?? "http://127.0.0.1:5197";
const metricIds = ["M084", "M086", "M090"];
const csrfToken = "a".repeat(43);

test.use({ channel: "chrome", viewport: { width: 1440, height: 1000 } });

function session() {
  return { success: true, data: { user: { subjectId: "00000000-0000-4000-8000-000000000001", username: "qa.user", displayName: "QA 用户", role: "analyst", permissions: ["bi:read", "bi:export"], pidScope: "all" }, expiresAt: "2099-01-01T00:00:00.000Z", mustChangePassword: false, csrfToken } };
}

const definitions = {
  M084: { name: "支付提交次数", unit: "次", formula: "有效支付提交请求数", inputs: [{ key: "paymentSubmitCount", name: "支付提交次数", unit: "次" }] },
  M086: { name: "充值到账订单数", unit: "单", formula: "正式到账成功终态订单数", inputs: [{ key: "creditedOrderCount", name: "充值到账订单数", unit: "单" }] },
  M090: { name: "支付提交-充值到账转化率", unit: "%", formula: "最终到账的支付提交请求数 ÷ 已结束观察窗口的支付提交请求数 × 100%", inputs: [{ key: "creditedSubmitCount", name: "最终到账的支付提交请求数", unit: "次" }, { key: "matureSubmitCount", name: "已结束观察窗口的支付提交请求数", unit: "次" }] }
};

function dates([start, end]) {
  const values = [];
  for (let cursor = Date.parse(start); cursor <= Date.parse(end); cursor += 86400000) values.push(new Date(cursor).toISOString().slice(0, 10));
  return values;
}

function reading(query, mode) {
  const state = (id) => {
    if (mode === "ready") return id === "M084" ? { state: "available", sourceStatus: "READY", value: 4, inputs: [4] }
      : id === "M086" ? { state: "available", sourceStatus: "READY", value: 3, inputs: [3] }
        : { state: "available", sourceStatus: "READY", value: .75, inputs: [3, 4] };
    if (mode === "zero") return id === "M090" ? { state: "zero_denominator", sourceStatus: "READY", value: null, inputs: [0, 0] }
      : { state: "available", sourceStatus: "READY", value: 0, inputs: [0] };
    if (mode === "failed" && id === "M084") return { state: "source_failure", sourceStatus: "FAILED", value: null, inputs: [null] };
    return id === "M084" ? { state: "no_value", sourceStatus: "PROCESSING", value: null, inputs: [null] }
      : id === "M086" ? { state: "no_value", sourceStatus: "SOURCE_INCOMPLETE", value: null, inputs: [null] }
        : { state: "immature", sourceStatus: "NOT_MATURE", value: null, inputs: [null, null] };
  };
  return { success: true, data: { schemaVersion: "day-dashboard/v2", query, queryId: `qa-${mode}`, fetchedAt: "2026-09-09T10:00:00.000Z", timezone: "Asia/Shanghai", validationStatus: "pending_validation", completeness: "unknown", watermark: null, sourceApiIds: ["/api/admin/bi/v1/metrics"], series: metricIds.map(id => {
    const definition = definitions[id];
    const points = dates(query.dateRange).map(date => {
      const current = state(id);
      return { date, state: current.state, sourceStatus: current.sourceStatus, value: current.value, inputs: definition.inputs.map((input, index) => ({ key: input.key, value: current.inputs[index] })) };
    });
    const complete = points.every(point => point.state === "available");
    return { metric: { id, name: definition.name, unit: definition.unit, definition: definition.name, authorityVersion: "v0.37-draft", formula: definition.formula, referenceMetricId: id, sourceNote: "bi-v1 支付域", inputs: definition.inputs }, points,
      periodStatistics: { aggregationVersion: "daily-statistics/v1", dateRange: query.dateRange, dayCount: points.length, state: complete ? "available" : "incomplete", values: complete ? [{ kind: "daily_average", value: points.reduce((sum, point) => sum + point.value, 0) / points.length }] : [], reason: complete ? null : "所选日期存在缺失或不可用日值" } };
  }) } };
}

test("正式支付链路不回退演示值，并完整呈现接口状态与真实零", async ({ page }) => {
  let mode = "pending";
  await page.route("**/api/bi/v2/auth/session", route => route.fulfill({ json: session() }));
  await page.route("**/api/bi/v2/data-environment", route => route.fulfill({ json: { success: true, data: { mode: "production", testAvailable: true, expiresAt: null, userName: null } } }));
  await page.route("**/api/bi/v2/catalog/platforms", route => route.fulfill({ json: { success: true, data: { items: [{ id: "HX-001", pid: "PH", name: "测试平台", order: 1 }] } } }));
  await page.route("**/api/bi/v2/catalog/readable-dashboards", route => route.fulfill({ json: { success: true, data: { enabled: true, categories: ["商业变现"], items: [{ id: "5.11", title: "支付链路与到账质量", category: "商业变现", metricIds, pendingMetricNames: [] }] } } }));
  await page.route("**/api/bi/v2/queries/dashboards/daily-reading", async route => route.fulfill({ json: reading(route.request().postDataJSON(), mode) }));

  await page.goto(`${base}/dashboards/public?board=5.11&pid=PH&start=2026-09-08&end=2026-09-08`);
  await expect(page.getByRole("heading", { name: "支付链路与到账质量", exact: true })).toBeVisible();
  await page.getByText("提交、下单、回调与到账指标", { exact: true }).click();
  const submit = page.getByRole("article", { name: "支付提交次数", exact: true });
  const credited = page.getByRole("article", { name: "充值到账订单数", exact: true });
  const conversion = page.getByRole("article", { name: "支付提交-充值到账转化率", exact: true });
  await expect(submit).toContainText("计算中");
  await expect(credited).toContainText("数据接入中");
  await expect(conversion).toContainText("待成熟");
  await expect(page.locator(".payment-business__advanced").filter({ hasText: "提交、下单、回调与到账指标" })).not.toContainText("演示数据");

  mode = "failed";
  await page.getByRole("button", { name: "刷新看板", exact: true }).click();
  await expect(submit).toContainText("数据异常");

  mode = "ready";
  await page.getByRole("button", { name: "刷新看板", exact: true }).click();
  await expect(submit).toContainText("4");
  await expect(credited).toContainText("3");
  await expect(conversion).toContainText("75.00");

  mode = "zero";
  await page.getByRole("button", { name: "刷新看板", exact: true }).click();
  await expect(submit).toContainText("0");
  await expect(credited).toContainText("0");
  await expect(conversion).toContainText("分母为0");
});
