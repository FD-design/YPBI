import { describe, expect, test } from "bun:test";
import { aggregateBiV1Playback, queryBiV1Playback } from "./bi-v1.adapter";

const row = (metricCode: "M034" | "M036" | "M097", videoType: string, value: number | null, numerator: number, denominator: number) => ({
  metricCode,
  businessDate: "2026-09-21",
  dimensions: { pid: "PH", videoType },
  value,
  numerator,
  denominator,
  unit: metricCode === "M036" ? "ratio" as const : "count" as const,
  dataStatus: "READY" as const,
  metricVersion: "bi-v1" as const,
  ruleVersion: "effective_play_v2"
});

const message = (rows: ReturnType<typeof row>[]) => ({
  metricVersion: "bi-v1" as const,
  generatedAt: "2026-09-22T10:00:00+08:00",
  watermark: "2026-09-22 10:00:00.000",
  rows
});

describe("bi-v1 adapter", () => {
  test("按视频类型汇总计数并用总分子总分母计算有效观影率", () => {
    const result = aggregateBiV1Playback(message([
      row("M034", "default", 27, 27, 0), row("M036", "default", 27 / 89, 27, 89), row("M097", "default", 89, 89, 0),
      row("M034", "long_video", 6, 6, 0), row("M036", "long_video", 6 / 9, 6, 9), row("M097", "long_video", 9, 9, 0)
    ]), { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-21" });

    expect(result[0].metrics.M034.value).toBe(33);
    expect(result[0].metrics.M097.value).toBe(98);
    expect(result[0].metrics.M036).toMatchObject({ value: 33 / 98, numerator: 33, denominator: 98, state: "available" });
  });

  test("缺日保持无记录，未接通状态不转换为0", () => {
    const result = aggregateBiV1Playback({ ...message([]), rows: [{
      metricCode: "M034", dimensions: { pid: "PH" }, value: null, numerator: 0, denominator: 0,
      unit: "count", dataStatus: "SOURCE_INCOMPLETE", metricVersion: "bi-v1", ruleVersion: ""
    }, {
      metricCode: "M036", dimensions: { pid: "PH" }, value: null, numerator: 0, denominator: 0,
      unit: "ratio", dataStatus: "SOURCE_INCOMPLETE", metricVersion: "bi-v1", ruleVersion: ""
    }, {
      metricCode: "M097", dimensions: { pid: "PH" }, value: null, numerator: 0, denominator: 0,
      unit: "count", dataStatus: "SOURCE_INCOMPLETE", metricVersion: "bi-v1", ruleVersion: ""
    }] }, { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-22" });
    expect(result).toHaveLength(2);
    expect(result.every((day) => day.metrics.M034.value === null && day.metrics.M034.dataStatus === "SOURCE_INCOMPLETE")).toBe(true);
  });

  test("业务 code 非200即使HTTP成功也拒绝", async () => {
    const client = { get: async () => ({ code: 400, err: "当前账号没有 TT 权限" }) };
    await expect(queryBiV1Playback(client as never, { pid: "TT", startDate: "2026-09-21", endDate: "2026-09-21" })).rejects.toMatchObject({ code: "BI_V1_REQUEST_REJECTED" });
  });

  test("PID回显、重复维度和分子分母冲突均失败关闭", () => {
    const valid = [
      row("M034", "default", 1, 1, 0), row("M036", "default", 0.5, 1, 2), row("M097", "default", 2, 2, 0)
    ];
    expect(() => aggregateBiV1Playback({ ...message(valid), rows: [...valid, valid[0]] }, { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-21" })).toThrow();
    expect(() => aggregateBiV1Playback(message(valid.map((item) => ({ ...item, dimensions: { ...item.dimensions, pid: "TT" } }))), { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-21" })).toThrow();
    expect(() => aggregateBiV1Playback(message(valid.map((item) => item.metricCode === "M036" ? { ...item, numerator: 2 } : item)), { pid: "PH", startDate: "2026-09-21", endDate: "2026-09-21" })).toThrow();
  });
});
