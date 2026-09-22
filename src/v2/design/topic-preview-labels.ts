export const topicLabels = (registered: boolean) => registered
  ? { date: "注册日期", people: "注册用户数", table: "注册留存明细" }
  : { date: "首次有效观看日期", people: "首次有效观看用户数", table: "有效观影留存明细" };

export const retentionDayLabel = (days: number) => days === 1 ? "次日" : `第 ${days} 天`;
