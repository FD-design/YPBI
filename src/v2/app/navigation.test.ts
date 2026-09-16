import assert from "node:assert/strict";
import test from "node:test";
import {
  activeNavigationId,
  activeSecondaryNavigationId,
  defaultProductRoute,
  PRODUCT_NAVIGATION,
  productNavigationItems,
  productSecondaryNavigationItems,
  routeArea,
  routeTitle
} from "./navigation.ts";

const expectedLeafRoutes = [
  "/dashboards/public",
  "/dashboards/mine",
  "/dashboards/metric-overviews",
  "/analysis/metrics",
  "/analysis/events",
  "/analysis/funnels",
  "/analysis/saved",
  "/data/metrics",
  "/data/events",
  "/admin/data-sources",
  "/admin/accounts"
];

test("产品导航完整登记 11 个单义叶子路径，收藏归入公共概览", () => {
  const childRoutes = productSecondaryNavigationItems().map((item) => item.href);
  const parentLeafRoutes = productNavigationItems().filter((item) => !item.children?.length).map((item) => item.href);
  const actual = [...childRoutes, ...parentLeafRoutes];
  assert.deepEqual(new Set(actual).size, actual.length);
  assert.deepEqual([...actual].sort(), [...expectedLeafRoutes].sort());
  assert.equal(PRODUCT_NAVIGATION.length, 2);
  assert.equal(productSecondaryNavigationItems().filter((item) => item.implementationState === "reserved").length, 8);
});

test("路由标题、所属工作空间和选中项都从同一导航登记源解析", () => {
  assert.equal(routeArea("/dashboards/metric-overviews"), "看板中心");
  assert.equal(routeTitle("/dashboards/metric-overviews"), "指标速览");
  assert.equal(activeNavigationId("/dashboards/metric-overviews"), "dashboards");
  assert.equal(activeSecondaryNavigationId("/dashboards/metric-overviews"), "dashboard-metric-overviews");

  assert.equal(routeArea("/analysis/metrics/M016"), "分析中心");
  assert.equal(routeTitle("/analysis/metrics/M016"), "指标分析");
  assert.equal(activeSecondaryNavigationId("/analysis/metrics/M016"), "analysis-metrics");

  assert.equal(routeArea("/admin/data-sources"), "管理");
  assert.equal(routeTitle("/admin/data-sources"), "数据源维护");
});

test("一级语义路径确定性跳转到各模块默认页", () => {
  assert.equal(defaultProductRoute("/dashboards"), "/dashboards/public");
  assert.equal(defaultProductRoute("/analysis/"), "/analysis/metrics");
  assert.equal(defaultProductRoute("/data"), "/data/metrics");
  assert.equal(defaultProductRoute("/admin"), "/admin/data-sources");
  assert.equal(defaultProductRoute("/analysis/events"), null);
  assert.equal(defaultProductRoute("/dashboards/favorites"), "/dashboards/public");
});
