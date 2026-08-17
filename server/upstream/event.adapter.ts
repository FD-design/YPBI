import type { AnalyticsQuery } from "../../contracts/analytics";
import type { UpstreamClient } from "./client";
import { eventStatsRowSchema, pagedUpstreamResponseSchema } from "./schemas";

export const EVENT_STATS_API = "/api/admin/statistics/trackEventsReport/getEventStats";

const eventFields: Record<string, string> = {
  app_start: "appStart",
  active_user: "activeUser",
  registry_user: "registryUser",
  video_click: "videoClick",
  video_play: "videoPlay",
  video_play_end: "videoPlayEnd",
  vip_click: "vipClick",
  pre_pay: "prePay",
  success_pay: "successPay"
};

const eventNames: Record<string, string> = {
  app_start: "启动应用",
  active_user: "活跃用户",
  registry_user: "注册用户",
  video_click: "视频点击",
  video_play: "开始播放",
  video_play_end: "播放完成",
  vip_click: "会员入口点击",
  pre_pay: "拉起支付",
  success_pay: "支付成功"
};

export interface FunnelRow {
  eventId: string;
  name: string;
  value: number;
  conversion: number;
  stepConversion: number;
  dropoff: number;
}

export class EventAdapter {
  constructor(private readonly client: UpstreamClient) {}

  async queryFunnel(query: AnalyticsQuery, platformId: string): Promise<FunnelRow[]> {
    const payload = await this.client.get(EVENT_STATS_API, {
      mode: "summary",
      pid: platformId,
      sumDateBegin: `${query.dateRange[0]} 00:00:00`,
      sumDateEnd: `${query.dateRange[1]} 23:59:59`,
      page: "1",
      count: "100"
    });
    const envelope = pagedUpstreamResponseSchema.parse(payload);
    const source = eventStatsRowSchema.parse(envelope.msg.pageData[0] ?? {});
    const values = query.eventIds.map((eventId) => {
      const field = eventFields[eventId];
      if (!field) throw new Error(`未映射事件：${eventId}`);
      const value = Reflect.get(source, field) as number | null;
      return { eventId, name: eventNames[eventId] ?? eventId, value: value ?? 0 };
    });
    const first = values[0]?.value ?? 0;
    return values.map((item, index) => {
      const previous = values[index - 1]?.value ?? item.value;
      return {
        ...item,
        conversion: first > 0 ? item.value / first : 0,
        stepConversion: previous > 0 ? item.value / previous : 0,
        dropoff: Math.max(0, previous - item.value)
      };
    });
  }
}
