import type { V2MetricWatermark } from "../../contracts/bi-v2";

export interface MetricWatermarkSourceRegistration {
  metricId: string;
  sourceKind: V2MetricWatermark["sourceKind"];
  sourceApiId: string;
}

function registrationKey(registration: MetricWatermarkSourceRegistration) {
  return JSON.stringify([
    registration.metricId,
    registration.sourceKind,
    registration.sourceApiId
  ]);
}

export interface MetricWatermarkSourceRegistry {
  has(registration: MetricWatermarkSourceRegistration): boolean;
  list(): readonly MetricWatermarkSourceRegistration[];
}

export function createMetricWatermarkSourceRegistry(
  sourceRegistrations: readonly MetricWatermarkSourceRegistration[]
): MetricWatermarkSourceRegistry {
  const registrations = Object.freeze(sourceRegistrations.map((registration) => Object.freeze({ ...registration })));
  const registrationKeys = new Set(registrations.map(registrationKey));
  if (registrationKeys.size !== registrations.length) {
    throw new Error("可信数据水位来源登记存在重复项");
  }
  return Object.freeze({
    has: (registration: MetricWatermarkSourceRegistration) => registrationKeys.has(registrationKey(registration)),
    list: () => registrations
  });
}

// 当前没有已确认的生产水位来源。只有指标、来源类型与来源 API
// 三者均完成核对并获准接入后，才允许在此登记。
export const metricWatermarkSourceRegistry = createMetricWatermarkSourceRegistry([]);
