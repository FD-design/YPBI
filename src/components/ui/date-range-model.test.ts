import { test, expect } from "bun:test";
import { monthCells, quickDateRanges, rangeError, shiftMonth } from "./date-range-model";
test("日期快捷项保留自然周期、数据截止日与能力限制", () => {
  const items = quickDateRanges({ today: "2026-09-10", maxDate: "2026-09-08", maxDays: 366 });
  expect(items).toHaveLength(14);
  expect(items.find(x => x.label === "今天")?.reason).toContain("2026-09-08");
  expect(items.find(x => x.label === "本周")).toMatchObject({ start: "2026-09-07", end: "2026-09-08", reason: null });
  expect(items.find(x => x.label === "上月")).toMatchObject({ start: "2026-08-01", end: "2026-08-31" });
  expect(items.find(x => x.label === "过去 7 天")).toMatchObject({ start: "2026-09-02", end: "2026-09-08" });
  expect(quickDateRanges({ today: "2026-01-01", maxDate: "2025-12-30" }).find(x => x.label === "本年")?.reason).toBe("当前周期暂无可查询日期");
});
test("闰年、跨年、单日、超限及无效日期按唯一规则校验", () => {
  const limits = { today: "2026-09-10", maxDate: "2026-09-08", minDate: "2024-01-01", maxDays: 366 };
  expect(rangeError({ start: "2024-02-29", end: "2024-02-29" }, limits)).toBe(null);
  expect(rangeError({ start: "2025-02-29", end: "2025-03-01" }, limits)).not.toBe(null);
  expect(rangeError({ start: "2025-01-01", end: "2026-09-01" }, limits)).toContain("366");
  expect(rangeError({ start: "2023-12-31", end: "2024-01-01" }, limits)).toContain("最早");
  expect(rangeError({ start: "2026-09-08", end: "2026-09-07" }, limits)).toContain("不能晚于");
  expect(shiftMonth("2026-01-31", -1)).toBe("2025-12-01");
  expect(monthCells("2024-02-01")).toContain("2024-02-29");
});
