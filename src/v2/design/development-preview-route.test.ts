import assert from "node:assert/strict";
import { test } from "node:test";
import { previewBoardHref, previewBoardId, resolveDevelopmentPreview } from "./development-preview-route.ts";

const resolve = (search: string, pathname = "/dashboards/public", hash = "") => resolveDevelopmentPreview({ pathname, search, hash });
test("个人体验仅接受明确页面和本地对象参数，不扩展正式认证范围", () => {
  for (const path of ["/dashboards/mine", "/dashboards/metric-overviews", "/analysis/metrics", "/analysis/events", "/analysis/saved"]) {
    assert.equal(resolve("?design=personal-workspace", path), "personal-workspace");
    assert.equal(resolve("?design=personal-workspace&object=local-12345678-1234-1234-1234-123456789abc", path), "personal-workspace");
    assert.equal(resolve("?design=personal-workspace&role=maintainer", path), null);
    assert.equal(resolve("?design=personal-workspace&object=production-id", path), null);
    assert.equal(resolve("?design=personal-workspace", path, "#extra"), null);
  }
  assert.equal(resolve("?design=personal-workspace", "/admin/data-sources"), null);
  assert.equal(resolve("?design=personal-workspace", "/analysis/metrics/M016"), null);
});
test("两个既有核心入口进入同一看板工作台，图表页保持独立", () => {
  assert.equal(resolve("?design=core-overview"), "dashboard-center");
  assert.equal(resolve("?design=dashboard-center"), "dashboard-center");
  assert.equal(resolve("?design=v1-chart-states"), "v1-chart-states");
});
test("白名单内对象链接可还原选中看板", () => {
  for (const id of ["5.2", "5.5", "5.7", "5.8", "5.9", "5.10", "5.11", "5.12", "5.13", "5.14", "5.15"]) {
    const url = new URL(previewBoardHref(id), "http://localhost");
    assert.equal(resolve(url.search), "dashboard-center");
    assert.equal(previewBoardId(url.search), id);
  }
});
test("附加参数、重复参数、未知对象和非精确路径不进入开发身份", () => {
  for (const search of ["", "?design=dashboard-center&board=5.999", "?design=dashboard-center&board=5.3", "?design=dashboard-center&board=5.7&extra=1", "?design=dashboard-center&board=5.7&board=5.8", "?board=5.7&design=dashboard-center", "?design=core-overview&board=5.7"]) assert.equal(resolve(search), null);
  assert.equal(resolve("?design=dashboard-center", "/dashboards/public/"), null);
  assert.equal(resolve("?design=dashboard-center", "/dashboards/public", "#anything"), null);
});
