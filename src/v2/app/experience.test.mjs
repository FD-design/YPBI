import assert from "node:assert/strict";
import test from "node:test";
import { shouldUseV2Experience } from "./experience.ts";

test("生产环境全部地址默认进入受登录保护的 V2", () => {
  assert.equal(shouldUseV2Experience({ pathname: "/", search: "" }), true);
  assert.equal(shouldUseV2Experience({ pathname: "/", search: "?workspace=templates&ui=v13" }), true);
  assert.equal(shouldUseV2Experience({ pathname: "/unknown", search: "" }), true);
});

test("经典版只在开发环境通过根路径显式 query 进入", () => {
  assert.equal(shouldUseV2Experience({ pathname: "/", search: "?workspace=templates&ui=v13" }, { allowClassic: true }), false);
  assert.equal(shouldUseV2Experience({ pathname: "/", search: "" }, { allowClassic: true }), true);
  assert.equal(shouldUseV2Experience({ pathname: "/data/metrics", search: "?ui=v13" }, { allowClassic: true }), true);
});
