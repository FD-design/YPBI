# 数据接口与平台模块

## 平台注册表

当前启用 20 个平台，来源为 HX 表和确认后的 PID：

| HX | 平台 | PID |
|---|---|---|
| HX-001 | Pornhub | PH |
| HX-003 | TikTok | TT |
| HX-021 | 小红书 | FBI |
| HX-009 | 色虎 | SH |
| HX-024 | PH·Prem | BZMH |
| HX-035 | 调教师 | TJS |
| HX-016 | 快播 | KB |
| HX-015 | 黄片网盘 | PD |
| HX-006 | 性欲社 | HJ |
| HX-004 | 抖阴Pro | DYP |
| HX-005 | 抖阴Plus | DYS |
| HX-026 | X-chat | YK |
| HX-049 | 白嫖社 | BPS |
| HX-050 | 好妻网 | HQW |
| HX-022 | 台姬店 | TJD |
| HX-051 | 魅魔vlog | MMV |
| HX-047 | 稚嫩学园 | AF |
| HX-018 | 铁粉空间 | TFKJ |
| HX-056 | 精日头条 | JRTT |
| HX-057 | 91淫妻 | YQ |

## 接口目录

- 共登记 30 个去重后台接口。
- 目录定义：`server/upstream/catalog.ts`。
- 每个接口记录内部 ID、业务域、真实路径、允许参数、响应结构和 BI 用途。
- SourceService 拒绝目录未声明的查询参数。

## Adapter

| Adapter | 主要能力 |
|---|---|
| OverviewAdapter | 日汇总、端别活跃与新增、来源新增、广告点击、新增付费和来源充值 |
| RealtimeAdapter | 实时时点、观影率、人均观影时长 |
| EventAdapter | 内容和支付汇总漏斗 |
| SearchAdapter | 热搜词排行 |
| VideoAdapter | 视频观看排行、点赞、收藏和收入 |
| RetentionAdapter | 新增和 D1 留存 |
| ChannelAdapter | 渠道明细和 A/B 落地页 |
| ContentAdapter | 分类观看、点击、点赞、收藏 |
| DetailAdapter | 用户和圈子明细 |
| SpecialAdapter | 导航、CNZZ、快照、资讯、问卷 |
| MetadataAdapter | 分类、标签和渠道管理元数据 |

## Token 与请求安全

- 上游当前不提供 Token 自动申请、续期或刷新能力；V1 使用受保护的人工轮换流程。维护者只在首次接入、失效或主动轮换时更新，普通 BI 查询由服务端自动使用已生效凭据。
- 主后台凭证从 `.env.local` 的 `UPSTREAM_API_BASE_URL`、`UPSTREAM_X_TOKEN`、`UPSTREAM_USER_NAME` 读取。
- 第二后台凭证从 `UPSTREAM_SECONDARY_API_BASE_URL`、`UPSTREAM_SECONDARY_X_TOKEN`、`UPSTREAM_SECONDARY_USER_NAME` 读取，三项必须成组配置。
- `UPSTREAM_SECONDARY_PIDS` 保存第二后台的平台 PID 白名单。客户端按请求中的 `pid` 自动选择后台、Token 和匹配用户名。
- 2026-07-21 使用 `pDaySum` 实测确认第二后台负责 `FBI、BZMH、TJS、BPS、HQW、TJD、MMV、AF、TFKJ、JRTT、YQ`；其余平台走主后台。`PH` 两侧均有数据，固定走主后台。
- 两个后台均通过 `x-token` 和 `name` 请求头认证，Token 与用户名必须来自同一登录会话。
- 前端“数据源维护”可只更新站1/站2 Token；地址、用户名和 PID 路由仍由 `.env.local` 管理，避免普通维护人员误改路由。
- 后端 `/api/bi/admin/data-sources/test` 已支持传入候选 Token 进行非保存验证；当前经典版 UI 只暴露“测试当前连接”和“验证并保存”，目标 V1 页面需补“仅验证新 Token”入口。
- 更新后的 Token 保存到 root-only 运行时凭证文件，优先级高于 `.env.local` 初始 Token；接口永不回传 Token 原文。
- Token 是不透明字符串，无法从本地解析过期时间。
- 上游 HTTP 401/403 及业务码 `2002` 会映射为认证失败或 IP 白名单限制。
- VPS 的 IPv6 出口为 `2a02:4780:5e:fe72::1`，未授权时上游会拒绝；生产请求优先使用已加入白名单的 IPv4。
- BI 只调用已登记接口；分析链路当前使用读取请求，不修改原后台数据。
- 文档和日志不得输出 Token。

## 三个已复验接口

1. `category.first` → `/api/admin/serverCfg/categories/getManyFirst`。必须传业务 `type`，例如 `novel`、`comic`、`snapshot`、`products`、`onlineFriendship`。2026-07-21 生产调用成功；没有匹配分类时返回空数组，BI 通用分类维度继续使用 `category.tree`。
2. `channel.byType` → `/api/admin/statistics/channel/channelStatByType`。参数包含 `pid`、`channel`、`cooperationType`、日期和分页；合作类型为 `CPC`、`CPA`、`CPT`、`CBD`。2026-07-21 生产调用成功并返回 20 行。
3. `overview.byRole` → `/api/admin/home/getAllByRole`。GET 参数为 `page`、`count`、`startDate`、`endDate`、`pid`。2026-07-21 使用匹配后台凭证和 IPv4 生产调用成功并返回 2 行，原 HTTP 500 已消失。

2026-07-21 已从浏览器 HAR 确认两组有效凭证，通过 VPS IPv4 验证 `pDaySum` 的 20 平台后台归属，并完成以上三个接口的生产复验。接口目录中的 30 个接口当前均可调用。

## pDaySum 扩展字段（2026-07-22）

- 端别：`androidLoginUserCount`、`iosLoginUserCount`、`androidNewUserCount`、`iosNewUserCount`。
- 来源：`channelRegisterCount`、`channelInternalRegisterCount`。
- 广告/入口点击：`totalClickedCount`、`totalClickedPerson`、`newUserTotalClickedCount`、`newUserTotalClickedPerson`。
- 新增付费：`newUserDiamondChargeAmt`、`newUserChargeUserCount`。
- 来源收入：`channelNewUserChargeAmt`、`channelInternalNewUserChargeAmt`。
- 收入统一归一化为 `revenue`，避免原 `diamondChargeAmount` 与指标注册表字段名不一致。

## 2026-07-22 全目录复验

- 28 个接口使用目录参数直接成功。
- `channel.abLanding` 补齐真实模板 A/B 参数后成功。
- 两个留存接口在“没有该平台当日数据”时归一化为真实空数组，不再作为接口故障。
- 结论：30 个目录接口在有效业务参数下均可调用；“可调用”不等于所有平台和日期都有业务数据。
