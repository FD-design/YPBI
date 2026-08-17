export type ResponseShape = "paged" | "array" | "object" | "json";

export interface ApiDefinition {
  id: string;
  domain: "overview" | "channel" | "video" | "circle" | "user" | "event" | "dictionary" | "search" | "snapshot" | "retention" | "other";
  path: string;
  params: readonly string[];
  responseShape: ResponseShape;
  biUsage: "analysis" | "dimension" | "management" | "restricted";
}

export const apiCatalog = [
  { id: "snapshot.list", domain: "snapshot", path: "/api/admin/snapshotManager/getMany", params: ["count", "endDate", "page", "startDate"], responseShape: "paged", biUsage: "analysis" },
  { id: "event.stats", domain: "event", path: "/api/admin/statistics/trackEventsReport/getEventStats", params: ["count", "mode", "page", "pid", "sumDateBegin", "sumDateEnd"], responseShape: "paged", biUsage: "analysis" },
  { id: "category.tree", domain: "dictionary", path: "/api/admin/serverCfg/categories/get", params: [], responseShape: "array", biUsage: "dimension" },
  { id: "category.first", domain: "dictionary", path: "/api/admin/serverCfg/categories/getManyFirst", params: ["count", "page", "pid", "type"], responseShape: "paged", biUsage: "dimension" },
  { id: "tag.attributes", domain: "dictionary", path: "/api/admin/serverCfg/tags/getAllAttr", params: ["pid"], responseShape: "paged", biUsage: "dimension" },
  { id: "tag.list", domain: "dictionary", path: "/api/admin/serverCfg/tags/getMany", params: ["type"], responseShape: "paged", biUsage: "dimension" },
  { id: "retention.average", domain: "retention", path: "/api/admin/statistics/averageReletionsStat/getAverageReletions", params: ["sumDateEnd", "sumDateStart"], responseShape: "json", biUsage: "restricted" },
  { id: "survey.stats", domain: "other", path: "/api/admin/statistics/commonSurveyStat", params: ["count", "endDate", "page", "pid", "startDate"], responseShape: "paged", biUsage: "analysis" },
  { id: "cnzz.stats", domain: "other", path: "/api/admin/statistics/cpGuardStat/cnzzstatQuery", params: ["count", "endTime", "page", "pid", "startTime"], responseShape: "paged", biUsage: "analysis" },
  { id: "navigation.stats", domain: "other", path: "/api/admin/statistics/navs", params: ["count", "page", "pid", "sumDateEnd", "sumDateStart"], responseShape: "paged", biUsage: "analysis" },
  { id: "news.stats", domain: "other", path: "/api/admin/statistics/newsStat", params: ["count", "page", "pid", "releaseDateEnd", "releaseDateStart"], responseShape: "paged", biUsage: "analysis" },
  { id: "retention.days", domain: "retention", path: "/api/admin/statistics/reletionsStat/getDays", params: ["pid", "registerDate", "registerEdDate"], responseShape: "json", biUsage: "restricted" },
  { id: "retention.daysPlus", domain: "retention", path: "/api/admin/statistics/reletionsStatPlus/getDays", params: ["pid", "registerDate", "registerEdDate"], responseShape: "json", biUsage: "restricted" },
  { id: "channel.pageTemplates", domain: "channel", path: "/api/admin/channelMgr/channelPage/getDlTmpList", params: ["pid"], responseShape: "object", biUsage: "management" },
  { id: "channel.partners", domain: "channel", path: "/api/admin/channelMgr/partner/getMany", params: ["pid"], responseShape: "paged", biUsage: "management" },
  { id: "channel.withdrawals", domain: "channel", path: "/api/admin/channelMgr/withdraw/get", params: ["count", "page", "state", "subBeginDate", "subEndDate"], responseShape: "paged", biUsage: "management" },
  { id: "channel.abLanding", domain: "channel", path: "/api/admin/statistics/channel/abLandPage", params: ["count", "page", "pid", "regNumMax", "regNumMin", "sumDateEnd", "sumDateStart", "templateA", "templateB"], responseShape: "paged", biUsage: "analysis" },
  { id: "channel.detail", domain: "channel", path: "/api/admin/statistics/channel/channelDetail", params: ["count", "createDateBegin", "createDateEnd", "isDiscount", "page", "pid", "sumDateBegin", "sumDateEnd"], responseShape: "paged", biUsage: "analysis" },
  { id: "channel.byType", domain: "channel", path: "/api/admin/statistics/channel/channelStatByType", params: ["channel", "cooperationType", "count", "page", "pid", "sumDateBegin", "sumDateEnd"], responseShape: "paged", biUsage: "analysis" },
  { id: "circle.list", domain: "circle", path: "/api/admin/statistics/todayCircles/getMany", params: ["count", "page", "sumDateBegin", "sumDateEnd"], responseShape: "paged", biUsage: "analysis" },
  { id: "circle.total", domain: "circle", path: "/api/admin/statistics/todayCircles/getManyTotalSum", params: ["count", "page", "sumDateBegin", "sumDateEnd"], responseShape: "paged", biUsage: "analysis" },
  { id: "search.hotWords", domain: "search", path: "/api/admin/statistics/hotSearchWords/getMany", params: ["count", "page", "pid"], responseShape: "paged", biUsage: "analysis" },
  { id: "video.list", domain: "video", path: "/api/admin/statistics/todayVideos/getMany", params: ["count", "page", "sumDateBegin", "sumDateEnd"], responseShape: "paged", biUsage: "analysis" },
  { id: "video.total", domain: "video", path: "/api/admin/statistics/todayVideos/getManyTotalSum", params: ["count", "page", "sumDateBegin", "sumDateEnd"], responseShape: "paged", biUsage: "analysis" },
  { id: "video.byCategory", domain: "video", path: "/api/admin/statistics/todayVideos/getVideoStatsByCategories", params: ["levelOneId", "pid", "sumDateBegin", "sumDateEnd"], responseShape: "object", biUsage: "analysis" },
  { id: "video.ranking", domain: "video", path: "/api/admin/statistics/videoWatchRanking", params: ["count", "page", "sumDateBegin", "sumDateEnd"], responseShape: "paged", biUsage: "analysis" },
  { id: "overview.byRole", domain: "overview", path: "/api/admin/home/getAllByRole", params: ["count", "endDate", "page", "pid", "startDate"], responseShape: "paged", biUsage: "analysis" },
  { id: "overview.realtime", domain: "overview", path: "/api/admin/home/pRealDayLine", params: ["endDate", "pid", "startDate"], responseShape: "array", biUsage: "analysis" },
  { id: "overview.daySum", domain: "overview", path: "/api/admin/statistics/pDaySum", params: ["count", "page", "pid", "sumDateEnd", "sumDateStart"], responseShape: "paged", biUsage: "analysis" },
  { id: "user.daily", domain: "user", path: "/api/admin/statistics/todayUsers/getMany", params: ["count", "page", "pid", "sumDateBegin", "sumDateEnd"], responseShape: "paged", biUsage: "analysis" }
] as const satisfies readonly ApiDefinition[];

export function getApiDefinition(id: string): ApiDefinition | undefined {
  return apiCatalog.find((definition) => definition.id === id);
}
