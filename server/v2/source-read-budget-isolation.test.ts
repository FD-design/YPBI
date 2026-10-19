import { describe, expect, spyOn, test } from "bun:test";
import { readBiV1MetricDays } from "../upstream/bi-v1.metrics-adapter";
import { UpstreamError } from "../upstream/client";
import { SourceReadBudget } from "./source-read-budget";

const row = { metricCode: "M008", businessDate: "2020-01-01", dimensions: { pid: "PH" },
  value: 1, numerator: 1, denominator: 0, unit: "count", dataStatus: "READY", metricVersion: "bi-v1", ruleVersion: "rule-v1" };
const registration = { code: 200, msg: { metricVersion: "bi-v1", generatedAt: "2020-01-02T00:00:00Z", watermark: null, rows: [row] } };

describe("来源预算与指标拆单恢复边界", () => {
  for (const mode of ["async_rejection", "sync_throw"] as const)
    for (const position of ["last", "middle"] as const)
      test(`${position}单指标${mode}晚于墙钟deadline时不返回partial或继续拆单`, async () => {
        let now = 100;
        const clock = spyOn(performance, "now").mockImplementation(() => now);
        const budget = new SourceReadBudget(10);
        const calls: string[] = [];
        const physicalTimeout = new UpstreamError("UPSTREAM_TIMEOUT", "后台接口请求超时", 504);
        const client = { get: (_path: string, params: Record<string, string>) => {
          calls.push(params.metricCodes);
          return budget.read<unknown>(() => {
            if (params.metricCodes.includes(",")) return Promise.resolve({ code: 400, err: "不支持的指标编码 M058" });
            if (params.metricCodes === "M008") return Promise.resolve(registration);
            now = 111;
            if (mode === "sync_throw") throw physicalTimeout;
            return Promise.reject(physicalTimeout);
          });
        } };
        const metricCodes = position === "last" ? ["M008", "M058"] as const : ["M008", "M058", "M020"] as const;
        try {
          await expect(readBiV1MetricDays(client, { pid: "PH", startDate: "2020-01-01", endDate: "2020-01-01", metricCodes }))
            .rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT", message: "后台来源读取超时" });
          expect(calls).toEqual([metricCodes.join(","), "M008", "M058"]);
          expect(budget.expired).toBe(true);
        } finally { budget.dispose(); clock.mockRestore(); }
      });

  test("预算内单指标物理超时仍保留同批真实READY兄弟", async () => {
    let now = 100;
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    const budget = new SourceReadBudget(10);
    const client = { get: (_path: string, params: Record<string, string>) => budget.read<unknown>(() => {
      if (params.metricCodes.includes(",")) return Promise.resolve({ code: 400, err: "不支持的指标编码 M058" });
      if (params.metricCodes === "M008") return Promise.resolve(registration);
      now = 109;
      return Promise.reject(new UpstreamError("UPSTREAM_TIMEOUT", "后台接口请求超时", 504));
    }) };
    try {
      const result = await readBiV1MetricDays(client, { pid: "PH", startDate: "2020-01-01", endDate: "2020-01-01", metricCodes: ["M008", "M058"] });
      expect(result.days[0].metrics.M008).toMatchObject({ state: "available", dataStatus: "READY", value: 1 });
      expect(result.days[0].metrics.M058).toMatchObject({ state: "source_failure", dataStatus: null, value: null });
      expect(budget.expired).toBe(false);
    } finally { budget.dispose(); clock.mockRestore(); }
  });
});
