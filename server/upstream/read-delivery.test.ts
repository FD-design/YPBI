import { expect, test } from "bun:test";
import { currentReadDeliveryExpiryScope, deliverUpstreamRead, runWithReadDeliveryBoundary } from "./read-delivery";
import { readBiV1MetricDays } from "./bi-v1.metrics-adapter";
import { UpstreamError } from "./client";

test("无context及未指定策略的交付边界保持source范围", async () => {
  expect(currentReadDeliveryExpiryScope()).toBe("source");
  const value = { value: 0 };
  expect(await deliverUpstreamRead(async () => value)).toBe(value);
  let calls = 0;
  await runWithReadDeliveryBoundary(async start => { calls++; return start(); }, async () => {
    expect(currentReadDeliveryExpiryScope()).toBe("source");
    expect(await deliverUpstreamRead(async () => value)).toBe(value);
  });
  expect(calls).toBe(1);
  expect(currentReadDeliveryExpiryScope()).toBe("source");
});

test("unit策略随私有交付context传递，嵌套source边界和外部调用互不污染", async () => {
  const run = <T>(start: () => Promise<T>) => start();
  await runWithReadDeliveryBoundary(run, async () => {
    expect(currentReadDeliveryExpiryScope()).toBe("unit");
    await deliverUpstreamRead(async () => {
      await Promise.resolve();
      expect(currentReadDeliveryExpiryScope()).toBe("unit");
    });
    await runWithReadDeliveryBoundary(run, async () => {
      expect(currentReadDeliveryExpiryScope()).toBe("source");
    });
    expect(currentReadDeliveryExpiryScope()).toBe("unit");
  }, { expiryScope: "unit" });
  expect(currentReadDeliveryExpiryScope()).toBe("source");
});

for (const origin of ["fatal", "consumer_cancelled"] as const) test(`unit策略保留${origin}首个原错并停止未启动恢复项`, async () => {
  const failure = origin === "fatal"
    ? new UpstreamError("UPSTREAM_AUTH_FAILED", "synthetic auth rejection", 401)
    : new UpstreamError("UPSTREAM_TIMEOUT", "后台来源读取已取消", 504, { origin });
  const calls: string[] = [];
  const signals: AbortSignal[] = [];
  await expect(runWithReadDeliveryBoundary(start => start(), () => readBiV1MetricDays({ get: async (_path, params, _token, signal) => {
    calls.push(params.metricCodes);
    if (params.metricCodes.includes(",")) return { code: 400, err: "unsupported metrics" };
    if (signal) signals.push(signal);
    if (params.metricCodes === "M008") throw failure;
    return { code: 200, msg: { metricVersion: "bi-v1", generatedAt: "2026-10-27T00:00:00Z", watermark: null, rows: [] } };
  } }, { pid: "PH", startDate: "2020-01-01", endDate: "2020-01-01", metricCodes: ["M008", "M113", "M112", "M060", "M114"] }),
  { expiryScope: "unit" })).rejects.toBe(failure);
  expect(calls).toEqual(["M008,M113,M112,M060,M114", "M008"]);
  expect(signals).toHaveLength(1);
  expect(signals.every(signal => signal.aborted)).toBe(true);
});
