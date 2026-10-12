import type { DailyDashboardSuccess } from "../../../contracts/daily-dashboard";
import type { DataEnvironmentMode } from "./dataEnvironmentPreference";

// Private request provenance. No response contract or authentication data is retained.
const environments = new WeakMap<DailyDashboardSuccess, DataEnvironmentMode>();

export function recordDailyDashboardEnvironment(result: DailyDashboardSuccess, mode: DataEnvironmentMode) {
  environments.set(result, mode);
  return result;
}

export function dailyDashboardEnvironment(result: DailyDashboardSuccess | null | undefined) {
  return result ? environments.get(result) : undefined;
}

export function dataEnvironmentLabel(mode: DataEnvironmentMode | undefined) {
  return mode === "test" ? "测试数据" : mode === "production" ? "正式数据" : "环境未确认";
}
