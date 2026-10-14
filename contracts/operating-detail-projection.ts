export const OPERATING_LIVE_IDS: Readonly<Record<string, string>> = {
  "M102:overall":"M102",
  "M097:overall":"M097", "M034:overall":"M034", "M103:overall":"M103", "M036:overall":"M036",
  "M018:overall":"M018",
  "M016:新用户":"M016.new", "M016:Android老用户":"M016.androidOld", "M016:iOS老用户":"M016.iosOld",
  "M026:老用户":"M026.old", "M026:Android老用户":"M026.androidOld", "M026:iOS老用户":"M026.iosOld",
  "M081:新用户":"M081.new", "M081:老用户":"M081.old", "M081:Android老用户":"M081.androidOld", "M081:iOS老用户":"M081.iosOld",
  "M112:overall":"M112", "M060:overall":"M060", "M114:overall":"M114",
  "M084:overall":"M084", "M086:overall":"M086", "M113:overall":"M113", "M090:overall":"M090",
  "M112:支付宝":"M112.alipay", "M113:支付宝":"M113.alipay", "M060:支付宝":"M060.alipay", "M114:支付宝":"M114.alipay",
  "M112:微信":"M112.wechat", "M113:微信":"M113.wechat", "M060:微信":"M060.wechat", "M114:微信":"M114.wechat",
  "M112:USDT":"M112.usdt", "M113:USDT":"M113.usdt", "M060:USDT":"M060.usdt", "M114:USDT":"M114.usdt",
  "M002:overall":"M002", "M003:overall":"M003", "M095:overall":"M095", "M005:overall":"M005", "M099:overall":"M099", "M006:overall":"M006", "M007:overall":"M007",
  "M008:自然新增":"M008.nature", "M008:内部导量":"M008.internal", "M058:自然新增":"M058.nature", "M058:内部导量":"M058.internal",
  "M020:overall":"M020", "M020:Android":"M020.android", "M020:iOS":"M020.ios", "M020:自然新增":"M020.natural", "M020:内部导量":"M020.internal",
  "M021:overall":"M021", "M022:overall":"M022", "M023:overall":"M023", "M115:overall:D1":"M115.d1", "M115:overall:D3":"M115.d3", "M115:overall:D7":"M115.d7", "M115:overall:D30":"M115.d30",
  "M016:overall":"M016", "M016:Android":"M016.android", "M016:iOS":"M016.ios", "M016:老用户":"M016.old",
  "display:M016:overall":"display:M016", "M008:overall":"M008", "M008:Android":"M008.android", "M008:iOS":"M008.ios", "display:M008:overall":"display:M008",
  "M026:overall":"M026", "M026:Android":"M026.android", "M026:iOS":"M026.ios", "M026:新用户":"M026.new",
  "M081:overall":"M081", "M081:Android":"M081.android", "M081:iOS":"M081.ios",
  "M055:overall":"M055.ads", "M055:新用户":"M055.new", "M094:overall":"M094.ads", "M094:新用户":"M094.new",
  "M110:overall":"M110", "M110:新用户":"M110.new", "M111:overall":"M111", "M111:新用户":"M111.new", "M058:overall":"M058", "M058:新用户":"M058.new",
  "M059:overall":"M059", "M059:新用户":"M059.new", "M061:overall":"M061", "M064:overall":"M064",
  "M087:overall":"M087", "M088:overall":"M088", "M067:overall":"M067", "M067:新用户":"M067.new", "M001:overall":"M001"
};

/** The operating table and its read-only snapshot share the same 93 projections. */
export const OPERATING_METRIC_IDS: readonly string[] = Object.freeze(Object.values(OPERATING_LIVE_IDS));

export const OPERATING_SNAPSHOT_STATISTICS_REASON = "经营快照仅提供当日及比较日，不提供连续区间统计";

/** Snapshot observations are ordered for existing comparison and export readers. */
export function operatingSnapshotDates(dateRange: readonly [string, string]): string[] {
  const end = Date.parse(dateRange[1]);
  return [-7, -1, 0].map(offset => new Date(end + offset * 86_400_000).toISOString().slice(0, 10));
}

