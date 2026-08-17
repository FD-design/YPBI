# BI 后端 API 模块

## 2026-07-23 工作区持久化修复

- 已确认 VPS 未配置 PostgreSQL，旧实现退化为内存 Store，API 服务重启会清空模板和卡片。
- 无 `DATABASE_URL` 时改用 `WORKSPACE_FILE`，默认路径为 `./data/workspace.json`。
- 每次覆盖前保留 `workspace.json.backup`，主文件和备份权限均为 `0600`。
- 文件采用临时文件写入后原子替换，避免进程中断留下半份 JSON。
- 前端同步增加浏览器 `localStorage` 备份，并按 `updatedAt` 合并远端与本地模板；远端缺少的本地自定义模板不会再被直接删除。
- 部署包持续排除 `data/`，后续发布和服务重启均不会覆盖工作区文件。

## 2026-07-23 通用获客查询

`POST /api/bi/analytics/query` 新增 `modelId=acquisition_conversion`。支持维度 `date/platform`，支持指标 `visits/downloads/newUsers/visitDownloadRate/downloadRegisterRate/visitRegisterRate`，并在 `meta.warnings` 返回空数据和口径不可比提示。

## 公共与工作区

| 方法 | 路径 | 功能 |
|---|---|---|
| GET | `/api/bi/health` | 服务健康和真实接口配置状态 |
| GET | `/api/bi/ready` | 深度检查工作区存储和上游读取链路；依赖异常时返回 503 |
| GET | `/api/bi/capabilities` | 分析类型、指标和事件能力 |
| GET | `/api/bi/sources` | 30 个上游接口目录 |
| GET | `/api/bi/platforms` | 20 个有效平台 |
| GET | `/api/bi/workspace` | 获取模板和卡片资产 |
| PUT | `/api/bi/workspace` | 保存版本化工作区 |

## 数据源维护（需要 `x-maintenance-key`）

| 方法 | 路径 | 功能 |
|---|---|---|
| GET | `/api/bi/admin/data-sources/status` | 返回站1/站2配置状态、脱敏尾号和更新时间，不返回 Token |
| POST | `/api/bi/admin/data-sources/test` | 使用当前或待更新 Token 请求对应后台验证连接 |
| PUT | `/api/bi/admin/data-sources/token` | 验证成功后原子写入运行时凭证并立即生效 |

- 维护密码连续错误 5 次后，当前来源 IP 锁定 15 分钟。
- 新 Token 验证失败时不写入文件、不清理旧凭证。
- 成功更新后清理上游响应缓存，后续请求立即使用新 Token，无需重启 API。

## 分析与校验

| 方法 | 路径 | 功能 |
|---|---|---|
| POST | `/api/bi/analytics/validate` | 校验查询组合 |
| POST | `/api/bi/analytics/query` | 执行真实分析查询 |
| POST | `/api/bi/cards/validate` | 校验卡片配置 |
| POST | `/api/bi/sources/:id/query` | 按目录白名单查询单个上游接口 |

## 业务分析

| 方法 | 路径 | 功能 |
|---|---|---|
| POST | `/api/bi/drilldown/users` | 用户明细下钻 |
| POST | `/api/bi/drilldown/circles` | 圈子明细下钻 |
| POST | `/api/bi/channels/detail` | 渠道明细 |
| POST | `/api/bi/channels/ab-landing` | 渠道 A/B 落地页 |
| POST | `/api/bi/content/:domain` | 分类内容统计 |
| POST | `/api/bi/special/:domain` | 导航、CNZZ、快照、资讯、问卷 |
| POST | `/api/bi/metadata/:domain` | 分类、标签、合作方、提现、落地页模板 |

## 错误约定

- `401/403`：上游 Token 无效。
- 后台可能以 HTTP 200 返回业务码 `2002`：重新登录映射为 `401`，IP 白名单限制映射为 `403`，不得继续交给响应 Schema 解析成内部 500。
- `429`：上游限流。
- `502`：上游接口失败或无法连接。
- `504`：上游请求超时。
- `422`：查询配置或字段组合不受支持。
- 服务端不返回 Token、Cookie 或上游敏感响应头。
- API 进程优先解析 IPv4，避免后台域名同时提供 IPv4/IPv6 时命中未授权的 IPv6 出口。
- 上游以 HTTP 200 返回的业务参数错误映射为 `422 UPSTREAM_INVALID_REQUEST`，不转换成内部 500。
- 通用数据源入口只允许目录声明的参数；`count` 限制为 1-100，`page` 限制为 1-10000，单个参数长度不超过 128。

## 工作区存储

- PostgreSQL 可用时持久化模板和卡片资产。
- 测试可显式使用内存 Store；未配置数据库时使用磁盘文件 Store。
- Schema 当前版本为 `1`。
- 保存前限制模板和卡片数量，并校验 JSON 结构。

## 主要代码

- `server/app.ts`：路由和错误映射。
- `server/persistence/workspace.store.ts`：工作区存储。
- `contracts/analytics.ts`、`contracts/card.ts`：协议。
- `server/config/env.ts`：环境变量校验。
