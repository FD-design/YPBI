import { expect, test } from "bun:test";
import { liveResourceRetainsResult } from "./LiveDashboardContext";

test("只有刷新中或刷新失败保留的成功结果标为上次结果", () => {
  expect(liveResourceRetainsResult(undefined)).toBe(false);
  expect(liveResourceRetainsResult({ status: "loading" })).toBe(false);
  expect(liveResourceRetainsResult({ status: "failure", kind: "error", code: "UPSTREAM_TIMEOUT", message: "读取失败" })).toBe(false);
  expect(liveResourceRetainsResult({ status: "success", data: 0, refreshing: false, refreshError: null })).toBe(false);
  expect(liveResourceRetainsResult({ status: "success", data: 0, refreshing: true, refreshError: null })).toBe(true);
  expect(liveResourceRetainsResult({ status: "success", data: 0, refreshing: false, refreshError: { code: "UPSTREAM_TIMEOUT", message: "刷新失败" } })).toBe(true);
});
