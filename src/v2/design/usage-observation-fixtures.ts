import type { DateRangeValue } from "../../components/ui/date-range-model";
import { demoDates, validDemoRange } from "./extended-board-model";

// Isolated membership observations. No identities leave this projection or enter an export.
export const USAGE_CLIENTS = [
  { value: "overall", label: "总体" }, { value: "android", label: "Android" },
  { value: "ios", label: "iOS" }, { value: "web", label: "Web" }, { value: "unknown", label: "未识别客户端" },
] as const;
export const USAGE_AUDIENCES = [
  { value: "overall", label: "总体" }, { value: "new", label: "新用户" }, { value: "existing", label: "老用户" },
] as const;
export type UsageScope = { client: typeof USAGE_CLIENTS[number]["value"]; audience: typeof USAGE_AUDIENCES[number]["value"] };
export const OVERALL_USAGE_SCOPE: UsageScope = { client: "overall", audience: "overall" };
export const usageScopeKey = (scope: UsageScope) => `${scope.client}:${scope.audience}`;
export const usageScopeLabel = (scope: UsageScope) => `${USAGE_CLIENTS.find(item => item.value === scope.client)!.label} · ${USAGE_AUDIENCES.find(item => item.value === scope.audience)!.label}`;
export const USAGE_SCOPES: UsageScope[] = USAGE_CLIENTS.flatMap(client => USAGE_AUDIENCES.map(audience => ({ client: client.value, audience: audience.value })));
export function validUsageScope(value: unknown): value is UsageScope {
  if (!value || typeof value !== "object") return false;
  const scope = value as UsageScope;
  return Object.keys(scope).sort().join() === "audience,client" && USAGE_CLIENTS.some(item => item.value === scope.client) && USAGE_AUDIENCES.some(item => item.value === scope.audience);
}
export type UsageCounts = { users: number; active: number; clicks: number };
export type UsageObservation = UsageCounts & { scope: UsageScope };
export type UsageObservationDay = UsageObservation & { date: string };
export type UsageObservations = { summary: UsageObservation[]; daily: UsageObservationDay[]; acquisition: (UsageCounts & { name: string })[] };
type Accumulator = { users: Set<number>; active: Set<number>; clicks: number };
const accumulator = (): Accumulator => ({ users: new Set(), active: new Set(), clicks: 0 });
const counts = (value: Accumulator): UsageCounts => ({ users: value.users.size, active: value.active.size, clicks: value.clicks });
const cache = new Map<string, UsageObservations>();

/** Overall, margins and joint cells observe the same facts, with independent interval distinct sets. */
export function usageObservations(range: DateRangeValue, subject: number, zero = false): UsageObservations {
  if (!validDemoRange(range)) throw new Error("使用样例日期无效");
  const cacheKey = `${range.start}|${range.end}|${subject}|${zero}`;
  const cached = cache.get(cacheKey); if (cached) return cached;
  const summary = new Map(USAGE_SCOPES.map(scope => [usageScopeKey(scope), accumulator()]));
  const acquisition = ["自然新增", "内部导量", "未归因"].map(name => ({ name, value: accumulator() }));
  const daily: UsageObservationDay[] = [];
  for (const date of demoDates(range)) {
    const day = Math.floor(Date.parse(date) / 86400000);
    const observed = new Map(USAGE_SCOPES.map(scope => [usageScopeKey(scope), accumulator()]));
    const observe = (member: number, age: number) => {
      if (age !== 0 && (member + day) % 10 >= (member < 120 ? 8 : 4)) return;
      const client = member % 17 === 0 ? "unknown" : (["android", "ios", "web"] as const)[member % 3];
      // A genuine empty subgroup in the mixed example, distinct from zero use among active people.
      if (zero && client === "unknown") return;
      const audience = age === 0 ? "new" : "existing";
      const clicks = zero ? 0 : (member * (subject % 13 + 3) + day) % 29 < 4 + subject % 20 ? 1 + (member + day + subject) % 5 : 0;
      const keys = ["overall:overall", `${client}:overall`, `overall:${audience}`, `${client}:${audience}`];
      const targets = [...keys.flatMap(key => [observed.get(key)!, summary.get(key)!]), acquisition[member % 3].value];
      for (const target of targets) { target.active.add(member); if (clicks) target.users.add(member); target.clicks += clicks; }
    };
    for (let member = 0; member < 120; member++) observe(member, 365);
    for (let age = 0; age < 28; age++) for (let slot = 0; slot < 8; slot++) observe(1_000_000 + (day - age) * 8 + slot, age);
    for (const scope of USAGE_SCOPES) daily.push({ date, scope, ...counts(observed.get(usageScopeKey(scope))!) });
  }
  const result = { summary: USAGE_SCOPES.map(scope => ({ scope, ...counts(summary.get(usageScopeKey(scope))!) })), daily, acquisition: acquisition.map(row => ({ name: row.name, ...counts(row.value) })) };
  if (cache.size >= 160) cache.delete(cache.keys().next().value!);
  cache.set(cacheKey, result);
  return result;
}
