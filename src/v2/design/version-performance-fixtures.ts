import { shiftDate, type DateRangeValue } from "../../components/ui/date-range-model";
import type { WorkbookCell, WorkbookSheet } from "./preview-workbook";
import {
  VERSION_CLIENTS,
  VERSION_METRICS,
  VERSION_OPTIONS,
  type VersionAudience,
  type VersionClient,
  type VersionClientScope,
  type VersionMetricId,
  type VersionPerformanceView,
  versionClientLabel,
  versionMetric,
  versionMetricAudienceScope,
  versionMetricInputs,
  versionMetricSupportsAudience,
  versionOption,
  versionQueryKeys,
  versionQueryLabel,
  versionsForClient,
  versionsForScope
} from "./version-performance-model";

export const VERSION_FIXTURE_WATERMARK = "2026-09-08";

export type VersionPointState = "available" | "immature" | "not_produced" | "not_applicable";

export interface VersionMetricPoint {
  date: string;
  audience: VersionAudience;
  numerator: number | null;
  denominator: number | null;
  value: number | null;
  state: VersionPointState;
  stateLabel: string;
}

export interface VersionMetricSummary {
  metricId: VersionMetricId;
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  state: "available" | "partial" | "empty";
  stateLabel: string;
  availableDays: number;
  totalDays: number;
}

export interface VersionDistributionRow {
  key: string;
  client: VersionClient;
  clientLabel: string;
  version: string;
  label: string;
  launches: number;
  activeUsers: number;
  activeDenominator: number;
  launchShare: number;
  activeShare: number;
  dataDate: string;
  availableDays: number;
  totalDays: number;
  state: "available" | "partial";
}

export interface VersionDisplayGroup {
  name: string;
  keys: string[];
  clients: Record<VersionClient, string[]>;
}

export interface VersionDistributionValue {
  launches: number | null;
  launchDenominator: number | null;
  activeUsers: number | null;
  activeDenominator: number | null;
  launchShare: number | null;
  activeShare: number | null;
  dataDate: string;
  availableDays: number;
  totalDays: number;
  state: "available" | "partial" | "no_version" | "no_record" | "not_produced";
  stateLabel: string;
}

export interface VersionDistributionByNameRow extends VersionDisplayGroup {
  overall: VersionDistributionValue;
  byClient: Record<VersionClient, VersionDistributionValue>;
}

/** A display group retains every original client-version identity. */
export function versionDisplayGroups(keys: string[] = VERSION_OPTIONS.map(item => item.key)): VersionDisplayGroup[] {
  const allowed = new Set(keys), groups = new Map<string, VersionDisplayGroup>();
  for (const item of VERSION_OPTIONS) {
    if (!allowed.has(item.key)) continue;
    let group = groups.get(item.name);
    if (!group) {
      group = { name: item.name, keys: [], clients: { android: [], ios: [] } };
      groups.set(item.name, group);
    }
    group.keys.push(item.key);
    group.clients[item.client].push(item.key);
  }
  const unknownNames = new Set(VERSION_OPTIONS.filter(item => item.unknown).map(item => item.name));
  return [...groups.values()].sort((left, right) => Number(unknownNames.has(left.name)) - Number(unknownNames.has(right.name))
    || right.name.localeCompare(left.name, "zh-CN", { numeric: true }));
}

export interface VersionRetentionRow {
  key: string;
  label: string;
  date: string;
  registeredBase: number | null;
  registeredReturn: number | null;
  registeredRate: number | null;
  registeredState: string;
  existingBase: number | null;
  existingReturn: number | null;
  existingRate: number | null;
  existingState: string;
  overallState: "待指标登记";
}

interface Observation {
  launches: number;
  terminalLaunches: number;
  successfulLaunches: number;
  activeUsers: number;
  contentClicks: number;
  playAttempts: number;
  successfulStarts: number;
  viewingUsers: number;
  effectiveViews: number;
  registeredBase: number;
  registeredReturn: number;
  existingBase: number;
  existingReturn: number;
}

const day = 86_400_000;
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

export function versionDates(range: DateRangeValue) {
  return Array.from({ length: Math.floor((Date.parse(range.end) - Date.parse(range.start)) / day) + 1 }, (_, index) => shiftDate(range.start, index));
}

interface VersionFact {
  user: number;
  client: VersionClient;
  key: string;
  audience: "new" | "existing" | "unclassified";
  launches: number;
  terminalLaunches: number;
  successfulLaunches: number;
  active: boolean;
  contentClicks: number;
  playAttempts: number;
  successfulStarts: number;
  viewing: boolean;
  effectiveViews: number;
  registeredBase: boolean;
  existingBase: boolean;
}

const factCache = new Map<string, VersionFact[]>();
const activeUserCache = new Map<string, Set<number>>();
const registrationAnchor = Math.floor(Date.parse(VERSION_FIXTURE_WATERMARK) / day);

function registrationOrdinal(user: number) {
  return user % 23 === 0 ? null : registrationAnchor - user % 45;
}

/** DEV-only user-grain facts. All-version totals are distinct queries, never sums or averages of displayed groups. */
function versionFacts(date: string) {
  const cached = factCache.get(date); if (cached) return cached;
  const ordinal = Math.floor(Date.parse(date) / day), facts: VersionFact[] = [];
  for (let user = 0; user < 2_400; user++) {
    const registeredAt = registrationOrdinal(user);
    const audience = registeredAt === null || ordinal < registeredAt ? "unclassified" : ordinal === registeredAt ? "new" : "existing";
    const clients: VersionClient[] = user % 13 === 0 ? ["android", "ios"] : [user % 3 === 0 ? "ios" : "android"];
    let cohortAssigned = false;
    for (const client of clients) {
      const choices = versionsForClient(client);
      const bucket = (user * 7 + ordinal + (client === "ios" ? 3 : 0)) % 100;
      const versionIndex = bucket < 58 ? 0 : bucket < 82 ? 1 : bucket < 95 ? 2 : 3;
      const keys = [choices[versionIndex].key, ...(user % 31 === 0 && versionIndex > 0 ? [choices[versionIndex - 1].key] : [])];
      keys.forEach((key, keyIndex) => {
        const activity = (user * 11 + ordinal + keyIndex * 5) % 10;
        const active = activity < 7;
        const launches = activity < 8 ? 1 + (user + ordinal + keyIndex) % 3 : 0;
        const terminalLaunches = Math.max(0, launches - ((user + ordinal) % 41 === 0 ? 1 : 0));
        const successfulLaunches = Math.max(0, terminalLaunches - ((user * 3 + ordinal + versionIndex) % 97 < 2 + versionIndex ? 1 : 0));
        const contentClicks = active ? (user * 5 + ordinal + versionIndex) % 4 : 0;
        const playAttempts = Math.max(0, contentClicks - ((user + ordinal) % 29 === 0 ? 1 : 0));
        const successfulStarts = Math.max(0, playAttempts - ((user * 7 + ordinal + versionIndex) % 53 === 0 ? 1 : 0));
        const viewing = active && (user * 3 + ordinal + versionIndex) % 10 < 8;
        const effectiveViews = Math.max(0, successfulStarts - ((user * 13 + ordinal + versionIndex) % 17 < 5 ? 1 : 0));
        // Retention cohorts freeze to the first active D0 client-version fact.
        // This anchor is unique even when one user uses multiple clients or versions.
        const cohortAnchor = active && !cohortAssigned;
        if (cohortAnchor) cohortAssigned = true;
        const registeredBase = cohortAnchor && registeredAt === ordinal;
        const existingBase = cohortAnchor && registeredAt !== null && ordinal - registeredAt >= 2;
        facts.push({ user, client, key, audience, launches, terminalLaunches, successfulLaunches, active, contentClicks, playAttempts, successfulStarts, viewing, effectiveViews,
          registeredBase, existingBase });
      });
    }
  }
  factCache.set(date, facts);
  return facts;
}

function activeUsersOn(date: string) {
  const cached = activeUserCache.get(date); if (cached) return cached;
  const active = new Set(versionFacts(date).filter(fact => fact.active).map(fact => fact.user));
  activeUserCache.set(date, active);
  return active;
}

export interface VersionFactScope { client: VersionClientScope; audience: VersionAudience }
const queryCache = new Map<string, Observation>();

function queryObservation(keys: string[], date: string, scope: VersionFactScope): Observation {
  const stableKeys = [...new Set(keys)].sort(), cacheKey = `${date}|${stableKeys.join(",")}|${scope.client}|${scope.audience}`;
  const cached = queryCache.get(cacheKey); if (cached) return cached;
  const allowed = new Set(stableKeys), active = new Set<number>(), viewing = new Set<number>(), registeredBase = new Set<number>(), registeredReturn = new Set<number>(), existingBase = new Set<number>(), existingReturn = new Set<number>();
  let launches = 0, terminalLaunches = 0, successfulLaunches = 0, contentClicks = 0, playAttempts = 0, successfulStarts = 0, effectiveViews = 0;
  for (const fact of versionFacts(date)) {
    if (!allowed.has(fact.key) || (scope.client !== "overall" && fact.client !== scope.client) || (scope.audience !== "overall" && fact.audience !== scope.audience)) continue;
    launches += fact.launches; terminalLaunches += fact.terminalLaunches; successfulLaunches += fact.successfulLaunches;
    contentClicks += fact.contentClicks; playAttempts += fact.playAttempts; successfulStarts += fact.successfulStarts; effectiveViews += fact.effectiveViews;
    if (fact.active) active.add(fact.user);
    if (fact.viewing) viewing.add(fact.user);
    if (fact.registeredBase) registeredBase.add(fact.user);
    if (fact.existingBase) existingBase.add(fact.user);
  }
  // D1 return is read from the actual next-day active fact across every
  // client/version, while attribution remains frozen on the D0 anchor above.
  const d1Active = activeUsersOn(shiftDate(date, 1));
  for (const user of registeredBase) if (d1Active.has(user)) registeredReturn.add(user);
  for (const user of existingBase) if (d1Active.has(user)) existingReturn.add(user);
  const result = { launches, terminalLaunches, successfulLaunches, activeUsers: active.size, contentClicks, playAttempts, successfulStarts, viewingUsers: viewing.size, effectiveViews,
    registeredBase: registeredBase.size, registeredReturn: registeredReturn.size, existingBase: existingBase.size, existingReturn: existingReturn.size };
  queryCache.set(cacheKey, result);
  return result;
}

function inputs(id: VersionMetricId, row: Observation) {
  switch (id) {
    case "M091": return { numerator: row.launches, denominator: null };
    case "M080": return { numerator: row.successfulLaunches, denominator: row.terminalLaunches };
    case "M016": return { numerator: row.activeUsers, denominator: null };
    case "M083": return { numerator: row.playAttempts, denominator: row.contentClicks };
    case "M031": return { numerator: row.successfulStarts, denominator: row.playAttempts };
    case "M081": return { numerator: row.viewingUsers, denominator: row.activeUsers };
    case "M036": return { numerator: row.effectiveViews, denominator: row.successfulStarts };
    case "M020": return { numerator: row.registeredReturn, denominator: row.registeredBase };
    case "M024": return { numerator: row.existingReturn, denominator: row.existingBase };
  }
}

function d1Mature(date: string) {
  return shiftDate(date, 1) <= VERSION_FIXTURE_WATERMARK;
}

/** All values are deterministic DEV fixtures. `mixed` exposes states without filling missing values with zero. */
export function versionMetricPoints(key: string, id: VersionMetricId, range: DateRangeValue, mixed = false, audience: VersionAudience = "overall"): VersionMetricPoint[] {
  const item = versionOption(key);
  if (!item || (mixed && item.client === "ios")) return [];
  return versionDates(range).map((date, index) => {
    const metric = versionMetric(id);
    if (!versionMetricSupportsAudience(id) && audience !== "overall") return { date, audience, numerator: null, denominator: null, value: null, state: "not_applicable", stateLabel: versionMetricAudienceScope(id) };
    if (date > VERSION_FIXTURE_WATERMARK) return { date, audience, numerator: null, denominator: null, value: null, state: "not_produced", stateLabel: "晚于演示数据截至日" };
    if (metric.kind === "retention" && !d1Mature(date)) return { date, audience, numerator: null, denominator: null, value: null, state: "immature", stateLabel: "次日观察未结束" };
    if (mixed && id === "M031" && index === 1) return { date, audience, numerator: null, denominator: null, value: null, state: "not_produced", stateLabel: "当日结果未产出" };
    const values = inputs(id, queryObservation([key], date, { client: item.client, audience }));
    const value = metric.kind === "ratio" || metric.kind === "retention"
      ? values.denominator ? values.numerator / values.denominator : null
      : values.numerator;
    return { date, audience, ...values, value, state: "available", stateLabel: "完整" };
  });
}

/** Direct result for an explicit set of client-version entities. */
export function versionScopeMetricPoints(keys: string[], id: VersionMetricId, range: DateRangeValue, mixed = false, scope: VersionFactScope = { client: "overall", audience: "overall" }): VersionMetricPoint[] {
  const validKeys = [...new Set(keys)].filter(key => {
    const item = versionOption(key);
    return item && (scope.client === "overall" || item.client === scope.client);
  });
  if (!validKeys.length || (mixed && validKeys.some(key => versionOption(key)?.client === "ios") && scope.client !== "android")) return [];
  return versionDates(range).map((date, index) => {
    const metric = versionMetric(id);
    if (!versionMetricSupportsAudience(id) && scope.audience !== "overall") return { date, audience: scope.audience, numerator: null, denominator: null, value: null, state: "not_applicable", stateLabel: versionMetricAudienceScope(id) };
    if (date > VERSION_FIXTURE_WATERMARK) return { date, audience: scope.audience, numerator: null, denominator: null, value: null, state: "not_produced", stateLabel: "晚于演示数据截至日" };
    if (metric.kind === "retention" && !d1Mature(date)) return { date, audience: scope.audience, numerator: null, denominator: null, value: null, state: "immature", stateLabel: "次日观察未结束" };
    if (mixed && id === "M031" && index === 1) return { date, audience: scope.audience, numerator: null, denominator: null, value: null, state: "not_produced", stateLabel: "当日结果未产出" };
    const values = inputs(id, queryObservation(validKeys, date, scope));
    const value = metric.kind === "ratio" || metric.kind === "retention"
      ? values.denominator ? values.numerator / values.denominator : null
      : values.numerator;
    return { date, audience: scope.audience, ...values, value, state: "available", stateLabel: "完整" };
  });
}

export function versionMetricSummary(key: string, id: VersionMetricId, range: DateRangeValue, mixed = false, audience: VersionAudience = "overall"): VersionMetricSummary {
  return summarizeVersionPoints(id, versionMetricPoints(key, id, range, mixed, audience));
}

function summarizeVersionPoints(id: VersionMetricId, points: VersionMetricPoint[]): VersionMetricSummary {
  const metric = versionMetric(id);
  // A produced ratio point with a zero denominator is not a missing fact. It
  // contributes zero inputs to the weighted period result; only genuinely
  // unproduced/immature points make the period incomplete.
  const produced = points.filter(point => point.state === "available");
  if (!points.length || !produced.length) return { metricId: id, value: null, numerator: null, denominator: null, state: "empty", stateLabel: points[0]?.state === "not_applicable" ? points[0].stateLabel : "没有可展示的数据", availableDays: 0, totalDays: points.length };
  const incomplete = produced.length !== points.length;
  if (incomplete && metric.kind !== "retention") return { metricId: id, value: null, numerator: null, denominator: null, state: "partial", stateLabel: `${produced.length}/${points.length} 日可用，未生成区间结果`, availableDays: produced.length, totalDays: points.length };
  if (metric.kind === "daily_count") {
    const latest = points.at(-1)!;
    return { metricId: id, value: latest.value, numerator: latest.numerator, denominator: null, state: latest.state === "available" ? "available" : "partial", stateLabel: latest.state === "available" ? `末日日值 · ${latest.date}` : latest.stateLabel, availableDays: produced.length, totalDays: points.length };
  }
  const numerator = sum(produced.map(point => point.numerator ?? 0));
  const denominator = metric.kind === "count" ? null : sum(produced.map(point => point.denominator ?? 0));
  const value = metric.kind === "count" ? numerator : denominator ? numerator / denominator : null;
  if (denominator === 0) return { metricId: id, value: null, numerator, denominator, state: incomplete ? "partial" : "empty", stateLabel: incomplete ? `${produced.length}/${points.length} 个成熟批次，当前分母为0` : "当前分母为0", availableDays: produced.length, totalDays: points.length };
  return { metricId: id, value, numerator, denominator, state: incomplete ? "partial" : "available", stateLabel: incomplete ? `${produced.length}/${points.length} 个成熟批次` : "完整", availableDays: produced.length, totalDays: points.length };
}

export function versionScopeMetricSummary(keys: string[], id: VersionMetricId, range: DateRangeValue, mixed = false, scope: VersionFactScope = { client: "overall", audience: "overall" }) {
  return summarizeVersionPoints(id, versionScopeMetricPoints(keys, id, range, mixed, scope));
}

function versionClientDistribution(client: VersionClient, range: DateRangeValue, mixed = false, audience: VersionAudience = "overall"): VersionDistributionRow[] {
  if (mixed && client === "ios") return [];
  const requestedDates = versionDates(range);
  const availableDates = requestedDates.filter(date => date <= VERSION_FIXTURE_WATERMARK);
  if (!availableDates.length) return [];
  const observations = versionsForClient(client).map(item => ({ item, daily: availableDates.map(date => queryObservation([item.key], date, { client, audience })) }));
  const totalLaunches = sum(observations.flatMap(row => row.daily.map(item => item.launches)));
  // A user can use more than one app version on the same day. Each version's
  // active users therefore uses the independent same-client DAU as denominator;
  // version rates are not a mutually exclusive composition and need not sum to 100%.
  const sameClientDau = queryObservation(versionsForClient(client).map(item => item.key), availableDates.at(-1)!, { client, audience }).activeUsers;
  return observations.map(({ item, daily }) => {
    const launches = sum(daily.map(row => row.launches));
    const activeUsers = daily.at(-1)!.activeUsers;
    return {
      key: item.key,
      client,
      clientLabel: versionClientLabel(client),
      version: item.name,
      label: item.label,
      launches,
      activeUsers,
      activeDenominator: sameClientDau,
      launchShare: launches / totalLaunches,
      activeShare: activeUsers / sameClientDau,
      dataDate: availableDates.at(-1)!,
      availableDays: availableDates.length,
      totalDays: requestedDates.length,
      state: availableDates.length === requestedDates.length ? "available" : "partial"
    };
  });
}

/** "overall" lists both client-scoped version sets; it never creates a cross-client total. */
export function versionDistribution(client: VersionClientScope, range: DateRangeValue, mixed = false, audience: VersionAudience = "overall"): VersionDistributionRow[] {
  return (client === "overall" ? VERSION_CLIENTS.map(item => item.id) : [client])
    .flatMap(item => versionClientDistribution(item, range, mixed, audience));
}

/** Shares preserve a produced zero numerator; unavailable or zero denominators have no ratio. */
export function versionDistributionShare(value: number | null, denominator: number | null) {
  return value === null || denominator === null || denominator === 0 ? null : value / denominator;
}

function versionDistributionValue(keys: string[], denominatorKeys: string[], range: DateRangeValue, mixed: boolean, client: VersionClientScope): VersionDistributionValue {
  const dates = versionDates(range), availableDays = dates.filter(date => date <= VERSION_FIXTURE_WATERMARK).length;
  const empty = (state: VersionDistributionValue["state"], stateLabel: string): VersionDistributionValue => ({
    launches: null, launchDenominator: null, activeUsers: null, activeDenominator: null, launchShare: null, activeShare: null,
    dataDate: range.end, availableDays: 0, totalDays: dates.length, state, stateLabel
  });
  if (!keys.length) return empty("no_version", "该端无此版本");
  if (mixed && denominatorKeys.some(key => versionOption(key)?.client === "ios")) {
    return empty("no_record", client === "overall" ? "客户端结果未完整返回，总体不可用" : "客户端结果未返回");
  }
  if (!availableDays) return empty("not_produced", "所选日期结果未产出");
  const scope = { client, audience: "overall" as const };
  const latestDay = { start: range.end, end: range.end };
  const launches = versionScopeMetricSummary(keys, "M091", range, mixed, scope).value;
  const launchDenominator = versionScopeMetricSummary(denominatorKeys, "M091", range, mixed, scope).value;
  const activeUsers = versionScopeMetricSummary(keys, "M016", latestDay, mixed, scope).value;
  const activeDenominator = versionScopeMetricSummary(denominatorKeys, "M016", latestDay, mixed, scope).value;
  return {
    launches, launchDenominator, activeUsers, activeDenominator,
    launchShare: versionDistributionShare(launches, launchDenominator),
    activeShare: versionDistributionShare(activeUsers, activeDenominator),
    dataDate: range.end, availableDays, totalDays: dates.length,
    state: availableDays === dates.length ? "available" : "partial",
    stateLabel: availableDays === dates.length ? "完整" : `${availableDays}/${dates.length} 日可用，所选末日未产出`
  };
}

/** Overall counts query original facts independently; visibility and version focus never shrink denominators. */
export function versionDistributionByName(keys: string[], range: DateRangeValue, mixed = false): VersionDistributionByNameRow[] {
  const groups = versionDisplayGroups(keys);
  const coveredClients = new Set(groups.flatMap(group => group.keys.map(key => versionOption(key)!.client)));
  const denominatorKeys = VERSION_OPTIONS.filter(item => coveredClients.has(item.client)).map(item => item.key);
  return groups.map(group => ({
    ...group,
    overall: versionDistributionValue(group.keys, denominatorKeys, range, mixed, "overall"),
    byClient: {
      android: versionDistributionValue(group.clients.android, denominatorKeys.filter(key => versionOption(key)!.client === "android"), range, mixed, "android"),
      ios: versionDistributionValue(group.clients.ios, denominatorKeys.filter(key => versionOption(key)!.client === "ios"), range, mixed, "ios")
    }
  }));
}

export function versionRetentionRows(keys: string[], range: DateRangeValue, mixed = false): VersionRetentionRow[] {
  return keys.flatMap(key => {
    const item = versionOption(key);
    if (!item) return [];
    const registered = versionMetricPoints(key, "M020", range, mixed);
    const existing = versionMetricPoints(key, "M024", range, mixed);
    return registered.map((point, index) => {
      const old = existing[index];
      return {
        key, label: item.label, date: point.date,
        registeredBase: point.denominator,
        registeredReturn: point.numerator,
        registeredRate: point.value,
        registeredState: point.stateLabel,
        existingBase: old?.denominator ?? null,
        existingReturn: old?.numerator ?? null,
        existingRate: old?.value ?? null,
        existingState: old?.stateLabel ?? "没有可展示的数据",
        overallState: "待指标登记"
      };
    });
  });
}

export function displayVersionMetric(id: VersionMetricId, value: number | null, withUnit = true) {
  if (value === null) return "—";
  const metric = versionMetric(id);
  if (metric.unit === "%") return `${(value * 100).toFixed(2)}%`;
  return `${Math.round(value).toLocaleString("zh-CN")}${withUnit ? ` ${metric.unit}` : ""}`;
}

const exportedValue = (id: VersionMetricId, value: number | null): WorkbookCell => value === null ? null : versionMetric(id).unit === "%" ? value * 100 : value;

export function versionPerformanceSheets(view: VersionPerformanceView, range: DateRangeValue, mixed = false, compared = false): WorkbookSheet[] {
  // Full reconciliation tables always keep the whole client-version directory.
  // The selected query range below remains independent and can still be exact.
  const scopeKeys = versionsForScope("overall").map(item => item.key);
  const queryKeys = versionQueryKeys(view);
  const comparisonKey = view.versionRange === "focused" && view.comparison !== "none" ? view.comparison : null;
  const periods = [{ label: "当前期", range }, ...(compared ? [{ label: "上一等长周期", range: { start: shiftDate(range.start, -versionDates(range).length), end: shiftDate(range.start, -1) } }] : [])];
  const distributionRows: WorkbookCell[][] = periods.flatMap(period => versionDistributionByName(scopeKeys, period.range, mixed).flatMap(row => {
    const scopes = [{ label: "总体", keys: row.keys, value: row.overall }, ...VERSION_CLIENTS.map(client => ({ label: client.label, keys: row.clients[client.id], value: row.byClient[client.id] }))];
    return scopes.map(({ label, keys, value }) => [period.label, `${period.range.start} 至 ${period.range.end}`, row.name, label, keys.join(","), value.launches, value.launchDenominator, value.launchShare === null ? null : value.launchShare * 100, value.activeUsers, value.activeDenominator, value.activeShare === null ? null : value.activeShare * 100, value.dataDate, `${value.availableDays}/${value.totalDays}`, "各版本与端别人数可重叠，不可相加", value.stateLabel]);
  }));
  const coreRows: WorkbookCell[][] = periods.flatMap(period => versionDisplayGroups(scopeKeys).flatMap(group => VERSION_METRICS.flatMap(metric => {
    const scopes = [{ label: "总体", keys: group.keys, client: "overall" as const }, ...VERSION_CLIENTS.map(client => ({ label: client.label, keys: group.clients[client.id], client: client.id }))];
    const inputNames = versionMetricInputs(metric.id);
    return scopes.map(scope => {
      const summary = versionScopeMetricSummary(scope.keys, metric.id, period.range, mixed, { client: scope.client, audience: "overall" });
      return [period.label, `${period.range.start} 至 ${period.range.end}`, `${group.name} · ${scope.label}`, metric.name, scope.label, scope.keys.join(","), metric.kind === "daily_count" ? "所选结束日日值" : metric.kind === "count" ? "所选范围累计" : metric.kind === "retention" ? "成熟D0批次加权" : "所选范围按输入加权", inputNames.numerator, summary.numerator, inputNames.denominator, summary.denominator, exportedValue(metric.id, summary.value), metric.unit, `${summary.availableDays}/${summary.totalDays}`, scope.keys.length ? summary.stateLabel : "该端无此版本", metric.kind === "retention" ? versionMetricAudienceScope(metric.id) : "—", metric.attribution];
    });
  })));
  coreRows.push(["当前期", `${range.start} 至 ${range.end}`, versionQueryLabel(view), "整体活跃次日回访率", "总体", queryKeys.join(","), "待指标登记", null, null, null, null, null, "%", null, "未生成正式数值", "D0 版本归属与分母登记后再接入", "待登记"]);
  const queryName = versionQueryLabel(view);
  const trendRows: WorkbookCell[][] = periods.flatMap(period => VERSION_METRICS.flatMap(metric => {
    const scopes: { label: string; keys: string[]; client: VersionClientScope }[] = [
      { label: `${queryName} · 总体`, keys: queryKeys, client: "overall" },
      ...VERSION_CLIENTS.map(client => ({
        label: `${queryName} · ${client.label}`,
        keys: queryKeys.filter(key => versionOption(key)?.client === client.id),
        client: client.id
      }))
    ];
    if (comparisonKey) {
      const comparison = versionOption(comparisonKey)!;
      scopes.push({
        label: `${comparison.label} · 精确对比版本`,
        keys: [comparisonKey],
        client: comparison.client
      });
    }
    return scopes.flatMap(scope => {
      const points = versionScopeMetricPoints(scope.keys, metric.id, period.range, mixed, { client: scope.client, audience: "overall" });
      const clientLabel = scope.client === "overall" ? "总体" : versionClientLabel(scope.client);
      const batchScope = metric.kind === "retention" ? versionMetricAudienceScope(metric.id) : "—";
      return points.length
        ? points.map(point => [period.label, point.date, scope.label, metric.name, clientLabel, scope.keys.join(","), point.numerator, point.denominator, exportedValue(metric.id, point.value), metric.unit, point.stateLabel, batchScope, metric.attribution])
        : versionDates(period.range).map(date => [period.label, date, scope.label, metric.name, clientLabel, scope.keys.join(","), null, null, null, metric.unit, scope.keys.length ? "客户端结果未返回" : "该端无此版本", batchScope, metric.attribution]);
    });
  }));
  const retentionRows = periods.flatMap(period => versionRetentionRows(scopeKeys, period.range, mixed).map(row => ({ ...row, period: period.label })));
  return [
    { name: "01_版本分布", rows: [["周期", "日期范围", "版本", "客户端", "版本稳定键", "启动次数（范围累计）", "完整客户端范围启动次数", "启动次数占比（%）", "日活跃用户数", "独立同日活跃用户数", "版本使用率（%）", "日活数据日", "可用日期", "人数汇总限制", "状态"], ...distributionRows] },
    { name: "02_核心表现", rows: [["周期", "日期范围", "版本与客户端", "指标", "客户端", "版本稳定键", "汇总方式", "分子指标", "分子值", "分母指标", "分母值", "结果", "单位", "可用日期或批次", "状态", "指标批次范围", "版本归属"], ...coreRows] },
    { name: "03_变化趋势", rows: [["周期", "日期", "版本与客户端", "指标", "客户端", "版本稳定键", "分子", "分母", "结果", "单位", "状态", "指标批次范围", "版本归属"], ...trendRows] },
    { name: "04_D1批次核对", rows: [["周期", "D0日期", "客户端与版本", "首日注册用户数", "次日登录注册用户数", "注册D1留存率（%）", "注册D1状态", "首日存量活跃用户数", "次日复访存量用户数", "存量次日复访率（%）", "存量复访状态", "整体活跃次日回访"], ...retentionRows.map(row => [row.period, row.date, row.label, row.registeredBase, row.registeredReturn, row.registeredRate === null ? null : row.registeredRate * 100, row.registeredState, row.existingBase, row.existingReturn, row.existingRate === null ? null : row.existingRate * 100, row.existingState, row.overallState])] }
  ];
}

export function allVersionKeysAreClientScoped() {
  return VERSION_OPTIONS.every(item => item.key.startsWith(`${item.client}:`)) && new Set(VERSION_OPTIONS.map(item => item.key)).size === VERSION_OPTIONS.length;
}
