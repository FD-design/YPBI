import { diagnosticRatioInputs, DIAGNOSTIC_INPUTS_LABEL, isRegistrationRetentionMetric } from "./diagnostic-inputs";
export { isRegistrationRetentionMetric } from "./diagnostic-inputs";
export const REGISTRATION_COHORT_SCOPES = [
  { value: "overall", label: "总体" },
  { value: "android", label: "注册Android" },
  { value: "ios", label: "注册iOS" },
  { value: "natural", label: "自然新增" },
  { value: "internal", label: "内部导量" }
] as const;
export type RegistrationCohortScope = typeof REGISTRATION_COHORT_SCOPES[number]["value"];
export const REGISTRATION_RETENTION_WINDOWS = [["M020", 1], ["M021", 3], ["M022", 7], ["M023", 30]] as const;
export const isRegistrationCohortScope = (value: unknown): value is RegistrationCohortScope => REGISTRATION_COHORT_SCOPES.some(scope => scope.value === value);
export const registrationCohortScopeLabel = (scope: RegistrationCohortScope) => REGISTRATION_COHORT_SCOPES.find(item => item.value === scope)!.label;
export const registrationCohortMetricId = (id: string, scope: RegistrationCohortScope) => scope === "overall" ? id : `${id}.${scope}`;
export const REGISTRATION_DIAGNOSTIC_LABEL = DIAGNOSTIC_INPUTS_LABEL;
export function registrationCohortDiagnosticInputs(metricId: string, point: CohortPoint | undefined) {
  return isRegistrationRetentionMetric(metricId) ? diagnosticRatioInputs({ id: metricId, unit: "%", inputs: point?.inputs ?? [] }, point) : null;
}
export const isReadableRegistrationCohortPoint = (point: CohortPoint | undefined) => Boolean(point
  && (point.state === "available" || point.state === "zero_denominator")
  && (!point.sourceStatus || point.sourceStatus === "READY"));
export function readableRegistrationCohortSeries(series: CohortSeries): CohortSeries {
  if (!isRegistrationRetentionMetric(series.metric.id)) return series;
  return {...series,points:series.points.map(point => isReadableRegistrationCohortPoint(point) ? point : {
    ...point, value:null, inputs:registrationCohortDiagnosticInputs(series.metric.id, point) ? point.inputs : point.inputs.map(input=>({...input,value:null})),
    state:point.sourceStatus === "FAILED" ? "source_failure" : point.sourceStatus === "NOT_MATURE" ? "immature"
      : point.sourceStatus === "PROCESSING" || point.sourceStatus === "SOURCE_INCOMPLETE" ? "no_value" : point.state
  })};
}
export const registrationMetricScopeLabel = (id: string) => {
  const scope = id.split(".")[1] ?? "overall";
  return isRegistrationCohortScope(scope) ? registrationCohortScopeLabel(scope) : "总体";
};
import type { DailyDashboardSuccess } from "../../../../contracts/daily-dashboard";

type CohortSeries = DailyDashboardSuccess["data"]["series"][number];
type CohortPoint = CohortSeries["points"][number];
