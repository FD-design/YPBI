import assert from "node:assert/strict";
import test from "node:test";
import { shouldUseV2Experience } from "./experience.ts";

test("根路径继续默认进入经典版，仅显式 next 切换 V2", () => {
  assert.equal(shouldUseV2Experience({ pathname: "/", search: "" }), false);
  assert.equal(shouldUseV2Experience({ pathname: "/", search: "?workspace=templates&ui=v13" }), false);
  assert.equal(shouldUseV2Experience({ pathname: "/", search: "?experience=next" }), true);
});

test("已登记的语义产品路径自动进入 V2，近似前缀不误判", () => {
  for (const pathname of ["/dashboards/public", "/analysis/metrics/M016", "/data/metrics", "/admin/data-sources"]) {
    assert.equal(shouldUseV2Experience({ pathname, search: "" }), true, pathname);
  }
  assert.equal(shouldUseV2Experience({ pathname: "/database", search: "" }), false);
  assert.equal(shouldUseV2Experience({ pathname: "/analysis-old", search: "" }), false);
});
