import { expect, test } from "bun:test";
import { DEFAULT_PREVIEW_QUERY, parsePreviewQuery } from "./preview-query";
import { DEFAULT_ACQUISITION_VIEW } from "./acquisition-view-state";
import { DEFAULT_FUNCTION_VIEW } from "./function-preview-model";
import { DEFAULT_TOPIC_VIEW } from "./topic-preview-view";

test("所有看板首次进入不对比，不能由页面私有默认值覆盖", () => {
  expect(DEFAULT_PREVIEW_QUERY.compared).toBe(false);
  expect(DEFAULT_ACQUISITION_VIEW.filters.comparison).toBe("none");
  expect(DEFAULT_FUNCTION_VIEW.compared).toBe(false);
  expect(DEFAULT_TOPIC_VIEW.compared).toBe(false);
});
test("全局条件只接受实际支持的日期、业务范围与比较，不透传局部条件", () => {
  const month = { ...DEFAULT_PREVIEW_QUERY, range: { start: "2026-08-01", end: "2026-08-31" }, compared: true };
  expect(parsePreviewQuery(month)).toEqual(month);
  for (const invalid of [null, [], {}, { ...month, scope: "Android" }, { ...month, compared: "false" }, { ...month, keyword: "secret" }, { ...month, range: { ...month.range, draft: true } }, { ...month, range: { start: "2026-08-32", end: "2026-09-08" } }, { ...month, range: { start: "2025-01-01", end: "2026-09-08" } }, { ...month, range: { start: "2026-09-09", end: "2026-09-09" } }]) expect(parsePreviewQuery(invalid)).toBeNull();
  const copy = parsePreviewQuery(month)!;
  copy.range.start = "2026-07-01";
  expect(month.range.start).toBe("2026-08-01");
});
