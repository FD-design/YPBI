import { newavDatasets } from "./newav/catalog";

export const productRegistry = [
  {
    id: "newav",
    name: "NewAV",
    description: "视频内容、渠道增长、广告和会员收入分析",
    status: "active",
    datasets: newavDatasets
  }
] as const;
