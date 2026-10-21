import type { OperatingReadNotice } from "./operating-read-progress";

const readTime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
});

export function OperatingReadProgress({ notice }: { notice: OperatingReadNotice }) {
  const { progress, retained } = notice;
  if (!progress && !retained) return null;
  const hasRange = retained?.firstReadAt && retained.lastReadAt && Date.parse(retained.firstReadAt) !== Date.parse(retained.lastReadAt);
  return <p className="core-review__operating-progress" role="status" aria-live="polite" aria-atomic="true">
    {progress && <span>{progress.query
      ? <>{progress.query.projecting ? "正在整理查询结果" : progress.query.queued ? "后台查询排队中" : "后台查询中"}
        {progress.query.known && ` · 查询单元已完成 ${progress.completed}/${progress.total}`}
        {progress.query.attempts > 1 && ` · 第 ${progress.query.attempts} 次执行`}</>
      : <>平台查询已结束 {progress.completed}/{progress.total}</>}</span>}
    {progress && retained && " · "}
    {retained && <span>{retained.count} 个平台保留上次结果 · {hasRange ? "读取时间范围" : "读取时间"}：{retained.firstReadAt
      ? <><time dateTime={retained.firstReadAt}>{readTime.format(new Date(retained.firstReadAt))}</time>{hasRange && <> 至 <time dateTime={retained.lastReadAt!}>{readTime.format(new Date(retained.lastReadAt!))}</time></>}（北京时间）{retained.unknownTimes > 0 && `；另 ${retained.unknownTimes} 个平台读取时间未提供`}</>
      : "未提供"}</span>}
  </p>;
}
