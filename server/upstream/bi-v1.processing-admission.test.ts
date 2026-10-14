import { describe, expect, test } from "bun:test";
import {
  aggregateBiV1MetricDays,
  biV1MetricKey,
  type BiV1MetricDataStatus,
  type BiV1MetricMessage,
  type BiV1MetricQuery
} from "./bi-v1.metrics-adapter";

const query: BiV1MetricQuery = {
  pid: "PH",
  startDate: "2026-10-05",
  endDate: "2026-10-12",
  metricCodes: ["M016"],
  dimensions: ["clientPlatform", "userCohort"],
  dimensionFilters: { clientPlatform: "android", userCohort: "old" }
};
const metricKey = biV1MetricKey("M016", query.dimensionFilters!);
const observationDates = ["2026-10-05", "2026-10-11", "2026-10-12"];

function row(businessDate: string | undefined, dataStatus: BiV1MetricDataStatus, value: number | null): BiV1MetricMessage["rows"][number] {
  return {
    metricCode: "M016",
    ...(businessDate ? { businessDate } : {}),
    dimensions: { pid: query.pid, ...query.dimensionFilters },
    value,
    numerator: value ?? 0,
    denominator: 0,
    unit: "count",
    dataStatus,
    metricVersion: "bi-v1",
    ruleVersion: "active-user-fixture-v1"
  };
}

function aggregate(rows: BiV1MetricMessage["rows"]) {
  return aggregateBiV1MetricDays({
    metricVersion: "bi-v1",
    generatedAt: "2026-10-14T00:00:00+08:00",
    watermark: null,
    rows
  }, query);
}

describe("日活跃用户数 M016 的计算中与逐日结果准入", () => {
  test("同范围 PROCESSING 保留缺日状态，逐日 READY 独立展示", () => {
    const days = aggregate([
      row(undefined, "PROCESSING", null),
      row(query.endDate, "READY", 100)
    ]);
    expect(days).toHaveLength(8);
    expect(days.find(day => day.date === query.endDate)!.metrics[metricKey]).toEqual({
      dataStatus: "READY", state: "available", value: 100, numerator: 100, denominator: 0, unit: "count"
    });
    for (const day of days.filter(day => day.date !== query.endDate)) {
      expect(day.metrics[metricKey]).toEqual({
        dataStatus: "PROCESSING", state: "no_value", value: null, numerator: null, denominator: null, unit: null
      });
    }
  });

  test("非观察日 PROCESSING 按本日保留，当日、昨日与上周同日 READY 独立展示", () => {
    const values = [50, 90, 100];
    const days = aggregate([
      ...observationDates.map((date, index) => row(date, "READY", values[index])),
      row("2026-10-08", "PROCESSING", null)
    ]);
    const observations = observationDates.map(date => days.find(day => day.date === date)!.metrics[metricKey]);
    expect(observations).toEqual(values.map(value => ({
      dataStatus: "READY", state: "available", value, numerator: value, denominator: 0, unit: "count"
    })));
    expect(days.find(day => day.date === "2026-10-08")!.metrics[metricKey]).toEqual({
      dataStatus: "PROCESSING", state: "no_value", value: null, numerator: null, denominator: null, unit: null
    });
  });

  test("PROCESSING 附带的 999 只保留来源状态，正式数值与分子分母保持空值", () => {
    const days = aggregate([row(query.endDate, "PROCESSING", 999)]);
    expect(days.find(day => day.date === query.endDate)!.metrics[metricKey]).toEqual({
      dataStatus: "PROCESSING", state: "no_value", value: null, numerator: null, denominator: null, unit: null
    });
    for (const day of days.filter(day => day.date !== query.endDate)) {
      expect(day.metrics[metricKey]).toEqual({
        dataStatus: null, state: "no_record", value: null, numerator: null, denominator: null, unit: null
      });
    }
  });
});
