import { expect, test } from "bun:test";
import { BI_V1_METRICS_API, biV1MetricKey, readBiV1MetricDays, type BiV1MetricQuery } from "./bi-v1.metrics-adapter";

const date = "2026-11-01";
const query = { pid: "PH", startDate: date, endDate: date, metricCodes: ["M115"], dimensions: ["retentionDay"] } satisfies BiV1MetricQuery;
const row = (retentionDay: string, value: number | null, denominator: number, dataStatus = "READY", ruleVersion = `retention-${retentionDay.toLowerCase()}-v1`) => ({
  metricCode: "M115", businessDate: date, dimensions: { pid: "PH", retentionDay }, value, numerator: value ?? 0, denominator,
  unit: "count", dataStatus, metricVersion: "bi-v1", ruleVersion
});
const envelope = (rows: unknown[]) => ({
  code: 200, msg: { metricVersion: "bi-v1", generatedAt: "2026-11-05T03:30:54.994850+00:00", watermark: null, rows }
});
const key = (retentionDay: string) => biV1MetricKey("M115", [retentionDay]);

test("M115 real cohort shape admits its count and retains distinct states per period", async () => {
  const { days } = await readBiV1MetricDays({ get: async (path, params) => {
    expect(path).toBe(BI_V1_METRICS_API);
    expect(params).toEqual({ pid: "PH", startDate: date, endDate: "2026-11-02", metricCodes: "M115", dimensions: "retentionDay",
      granularity: "day", includeIncomplete: "true" });
    return envelope([row("D30", null, 157491, "NOT_MATURE"), row("D3", null, 157491, "PROCESSING"),
      row("D1", 18663, 157491), row("D7", null, 157491, "NOT_MATURE")]);
  } }, query);
  const metrics = days[0].metrics;
  expect(metrics[key("D1")]).toMatchObject({ state: "available", dataStatus: "READY", value: 18663, numerator: 18663, denominator: 157491 });
  expect(metrics[key("D3")]).toMatchObject({ state: "no_value", dataStatus: "PROCESSING", value: null, numerator: null, denominator: null });
  for (const period of ["D7", "D30"]) {
    expect(metrics[key(period)]).toMatchObject({ state: "immature", dataStatus: "NOT_MATURE", value: null });
  }
});

test("M115 isolates wrong-version or impossible counts and keeps real zero, missing and blank-rule states", async () => {
  const { days } = await readBiV1MetricDays({ get: async () => envelope([
    row("D1", 0, 0, "READY", "retention-d0-D1-v1"),
    row("D3", 9, 8), row("D7", null, 6, "SOURCE_INCOMPLETE", ""), row("D30", 2, 6, "READY", "retention-d7-v1")
  ]) }, query);
  const metrics = days[0].metrics;
  expect(metrics[key("D1")]).toMatchObject({ state: "available", value: 0 });
  expect(metrics[key("D3")]).toMatchObject({ state: "invalid_value", value: null });
  expect(metrics[key("D7")]).toMatchObject({ state: "no_value", dataStatus: "SOURCE_INCOMPLETE", value: null });
  expect(metrics[key("D30")]).toMatchObject({ state: "invalid_value", value: null });
  const absent = await readBiV1MetricDays({ get: async () => envelope([row("D1", 0, 0)]) }, query);
  expect(absent.days[0].metrics[key("D7")]).toMatchObject({ state: "no_record", value: null });
});

test("retentionDay must be explicit and may only be queried for M115", async () => {
  const get = async () => { throw new Error("Invalid request must be rejected before reading"); };
  await expect(readBiV1MetricDays({ get }, { ...query, dimensions: [] })).rejects.toMatchObject({ code: "BI_V1_REQUEST_REJECTED" });
  await expect(readBiV1MetricDays({ get }, { ...query, metricCodes: ["M020", "M115"] })).rejects.toMatchObject({ code: "BI_V1_REQUEST_REJECTED" });
});
