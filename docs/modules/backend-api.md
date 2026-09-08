# BI 后端 API 模块

## 2026-09-08 V2 只读指标纵向切片

首批目标产品 API 使用独立的 `/api/bi/v2` 路由命名空间，当前只开放 M016 单 PID × 业务日期日序列，不修改旧路由、旧工作区存储或数据库。路由命名空间分离不等于已经形成生产安全隔离：

| 方法 | 路径 | 当前契约 |
|---|---|---|
| GET | `/api/bi/v2/catalog/metrics` | 返回服务端运行目录中的 M016、权威版本 `v0.23-draft`、待验数状态及首批能力边界 |
| GET | `/api/bi/v2/catalog/platforms` | 返回当前运行平台目录与身份 `pidScope` 的交集；前端不固定数量 |
| POST | `/api/bi/v2/queries/metrics` | 接受 `metricId + pid + dateRange + grain=day`，返回 M016 日序列、逐日不可用状态、来源、查询 ID、抓取时间、未知水位及警告 |

- `contracts/bi-v2.ts` 是该批公共请求、响应和错误码的权威 contract；请求与成功 / 失败响应均有严格运行时 Schema，未知指标、粒度或 PID 在能力层拒绝，不回退旧查询。
- 当前运行平台目录仍由现有 `server/platforms/registry.ts` 的 20 项注册表提供，这是迁移期代码事实而非长期产品上限；后续接入正式目录源时只替换服务端 Provider，前端继续消费响应集合。
- `server/identity/identity-provider.ts` 定义框架无关的身份 port。尚未确认正式身份源时，默认 Provider 返回 `503 IDENTITY_PROVIDER_UNAVAILABLE`；正式 Provider 能区分 `401 AUTHENTICATION_REQUIRED`，PID 越权由服务端返回 `403 PID_ACCESS_DENIED`。没有开发态假用户、前端角色兜底或维护会话复用。
- `server/v2/m016-source.ts` 只把 `/api/admin/statistics/pDaySum` 的 `loginUserCount` 映射为 M016 候选值；不读取其他字段制造拆分。请求固定单 PID、`page=1`、`count=500` 和业务日起止时间；响应中的日期、PID、非负安全整数及可选 `total` 必须满足契约，截断分页、错误 PID、范围外日期、重复业务日和异常值全部失败关闭。`server/v2/metric-query.service.ts` 不聚合重复行、不修正异常整数、不把空值或未返回日期补成 0。
- 返回 `available / partial / no_values / no_records` 四种序列状态；逐日仅把真实数值（包括真实 `0`）标为 `available`，未返回行为 `no_record`，字段空值为 `no_value`。上游尚未提供正式成熟水位，因此 `watermark` 固定为 `null` 并附明确警告，不猜测成熟日期。
- 日志只允许记录非敏感的 request/query ID、指标 ID、结果状态和耗时。`server/v2/plugin.ts` 已从查询成功、拒绝和失败日志中移除 PID 与原始错误对象，只保留上述白名单字段；身份请求头、用户可见范围明文、筛选明文和结果数据不得记录。生产开放前仍须检查实际日志输出、框架默认日志及代理日志，证明没有敏感明文旁路。首批没有写接口、Schema、migration、保存、看板编辑或双写。

`buildApp` 支持注入 `IdentityProvider` 和查询执行器以做集成测试；当前 `server/index.ts` 未注入正式 Provider，运行入口使用失败关闭默认实现并返回 503。接入真实 Provider 或开放 V2 前，必须取得网关或功能开关确实阻止不可信网络访问的证据，并完成已登录允许、未登录拒绝、无 `bi:read` 权限拒绝、PID 越权拒绝及身份源不可用失败关闭的正反权限测试；未满足时不能正式开放。

查询请求使用严格 Schema，未知字段、反向日期和超过 366 个业务日的范围在执行上游前拒绝。上游认证、IP 限制、限流、超时和数据异常只映射到 V2 依赖错误，不冒充产品用户的 401/403，也不向浏览器回传上游原文；所有 V2 错误均携带稳定 request ID。根级遗留 handler 继续保持旧 `/api/bi/*` 未处理错误的 `500 INTERNAL_ERROR` 响应，V2 的统一错误处理封装在自身 Fastify plugin 内并覆盖为 V2 专属 4xx / 5xx 语义；二者已通过 SSR bundle 的 Fastify inject 对照核实。2026-09-08 本地类型检查和构建通过，系统 Chrome 的前端契约 fixture 回归通过；当前环境没有 Bun，因此本节对应的 V2 服务端测试文件仍是“已编写、未执行”。

### 当前主要代码

- `contracts/bi-v2.ts`：V2 只读指标目录、查询和错误协议。
- `server/identity/identity-provider.ts`：普通产品身份 port 与失败关闭默认实现。
- `server/v2`：V2 目录、M016 上游 port/adapter、查询服务和 Fastify plugin。

## 遗留 `/api/bi/*` 当前事实（仅迁移与回退核对）

本节及其全部子章节仅记录旧 API 和旧前端仍可执行的遗留事实，不是 V2 请求协议、目标产品能力或迁移验收标准。迁移顺序、只读窗口和退役条件以[现有平台调整方案](../requirements/BI-现有平台调整方案.md)为准；不得依据本节继续扩展 V1。

遗留 `/api/bi/ready` 只检查旧工作区存储和旧上游读取链路，不检查 V2 IdentityProvider、V2 目录、`bi:read` 或 PID 范围；它返回就绪不能证明 V2 身份或查询已具备生产开放条件。

### 2026-07-23 工作区持久化修复

- 已确认 VPS 未配置 PostgreSQL，旧实现退化为内存 Store，API 服务重启会清空模板和卡片。
- 无 `DATABASE_URL` 时改用 `WORKSPACE_FILE`，默认路径为 `./data/workspace.json`。
- 每次覆盖前保留 `workspace.json.backup`，主文件和备份权限均为 `0600`。
- 文件采用临时文件写入后原子替换，避免进程中断留下半份 JSON。
- 前端同步增加浏览器 `localStorage` 备份，并按 `updatedAt` 合并远端与本地模板；远端缺少的本地自定义模板不会再被直接删除。
- 部署包持续排除 `data/`，后续发布和服务重启均不会覆盖工作区文件。

上述文件工作区与浏览器 `localStorage` 合并属于遗留灾备和双状态机制。V2 禁止读取、写入或自动合并这些数据；它不构成 offline 能力，也不是跨会话草稿恢复。迁移期只允许按调整方案白名单只读盘点和搬迁旧资产，禁止继续写回或双写，迁移完成后退役。

### 2026-07-23 通用获客查询

`POST /api/bi/analytics/query` 新增 `modelId=acquisition_conversion`。支持维度 `date/platform`，支持指标 `visits/downloads/newUsers/visitDownloadRate/downloadRegisterRate/visitRegisterRate`，并在 `meta.warnings` 返回空数据和口径不可比提示。

### 公共与工作区

| 方法 | 路径 | 功能 |
|---|---|---|
| GET | `/api/bi/health` | 服务健康和真实接口配置状态 |
| GET | `/api/bi/ready` | 深度检查工作区存储和上游读取链路；依赖异常时返回 503 |
| GET | `/api/bi/capabilities` | 分析类型、指标和事件能力 |
| GET | `/api/bi/sources` | 30 个上游接口目录 |
| GET | `/api/bi/platforms` | 20 个有效平台 |
| GET | `/api/bi/workspace` | 获取模板和卡片资产 |
| PUT | `/api/bi/workspace` | 保存版本化工作区 |

### 数据源维护（需要 HTTPS 维护会话）

| 方法 | 路径 | 功能 |
|---|---|---|
| POST | `/api/bi/admin/auth/login` | 通过维护密码建立 30 分钟、绑定来源 IP 的 HttpOnly/Secure/SameSite 会话 |
| POST | `/api/bi/admin/auth/logout` | 清除当前维护会话 |
| GET | `/api/bi/admin/data-sources/status` | 返回站1/站2配置状态、脱敏尾号和更新时间，不返回 Token |
| POST | `/api/bi/admin/data-sources/test` | 使用当前或待更新 Token 请求对应后台验证连接 |
| PUT | `/api/bi/admin/data-sources/token` | 验证成功后原子写入运行时凭证并立即生效 |

- 维护密码连续错误 5 次后，当前来源 IP 锁定 15 分钟。
- 新 Token 被服务端明确判定验证失败时不写入文件、不清理旧凭证；若客户端在保存请求后断网、超时或收到畸形响应，客户端必须将结果标为“未确认”并重新核对，不能仅凭缺少成功响应断言旧凭证仍在。
- 成功更新后清理上游响应缓存，后续请求立即使用新 Token，无需重启 API。站1与站2的并发更新在服务端串行执行，合并时读取最新内存状态，避免相互覆盖。
- 凭证写入使用每次请求独立的临时文件、`0600` 权限和原子替换；成功或失败均清理临时文件。状态、测试和保存响应均禁止缓存，任何响应都不返回 Token 原文。
- 当前探针只验证一个站点的配置用户名、Token、固定 PID 和 `pDaySum` 接口，不代表该站全部 PID、接口或指标已经验数。动态 PID 范围、跨会话最近成功检测和审计历史仍未进入当前响应。
- 管理 API 的未登录、未启用、登录 Cookie、候选仅验证、保存失败保旧、成功脱敏和退出失效集成测试已编写；当前环境缺少 Bun，尚未实际执行。现有生产校验在 `x-forwarded-proto` 缺失时仍会放行，Fastify 也尚未按可信代理取得真实客户端 IP；正式开放前必须确认代理拓扑后改为缺失 / 非 HTTPS 均拒绝，并只信任明确代理来源，再做黑盒验证。未验证前不得把本地通过视为生产安全。

### 分析与校验

| 方法 | 路径 | 功能 |
|---|---|---|
| POST | `/api/bi/analytics/validate` | 校验查询组合 |
| POST | `/api/bi/analytics/query` | 执行真实分析查询 |
| POST | `/api/bi/cards/validate` | 校验卡片配置 |
| POST | `/api/bi/sources/:id/query` | 按目录白名单查询单个上游接口 |

### 业务分析

| 方法 | 路径 | 功能 |
|---|---|---|
| POST | `/api/bi/drilldown/users` | 用户明细下钻 |
| POST | `/api/bi/drilldown/circles` | 圈子明细下钻 |
| POST | `/api/bi/channels/detail` | 渠道明细 |
| POST | `/api/bi/channels/ab-landing` | 渠道 A/B 落地页 |
| POST | `/api/bi/content/:domain` | 分类内容统计 |
| POST | `/api/bi/special/:domain` | 导航、CNZZ、快照、资讯、问卷 |
| POST | `/api/bi/metadata/:domain` | 分类、标签、合作方、提现、落地页模板 |

### 遗留 API 错误约定

- 旧 `/api/bi/*` 上游读取层将上游 Token 无效映射为 `401/403`；该约定不得套用到 V2 产品身份和 PID 授权。V2 仅使用 `contracts/bi-v2.ts` 定义的 `401 AUTHENTICATION_REQUIRED`、`403 PID_ACCESS_DENIED`、`503 IDENTITY_PROVIDER_UNAVAILABLE` 等语义。
- 后台可能以 HTTP 200 返回业务码 `2002`：重新登录映射为 `401`，IP 白名单限制映射为 `403`，不得继续交给响应 Schema 解析成内部 500。
- `429`：上游限流。
- `502`：上游接口失败或无法连接。
- `504`：上游请求超时。
- `422`：查询配置或字段组合不受支持。
- 服务端不返回 Token、Cookie 或上游敏感响应头。
- API 进程优先解析 IPv4，避免后台域名同时提供 IPv4/IPv6 时命中未授权的 IPv6 出口。
- 上游以 HTTP 200 返回的业务参数错误映射为 `422 UPSTREAM_INVALID_REQUEST`，不转换成内部 500。
- 通用数据源入口只允许目录声明的参数；`count` 限制为 1-100，`page` 限制为 1-10000，单个参数长度不超过 128。

### 遗留工作区存储

- PostgreSQL 可用时持久化模板和卡片资产。
- 测试可显式使用内存 Store；未配置数据库时使用磁盘文件 Store。
- Schema 当前版本为 `1`。
- 保存前限制模板和卡片数量，并校验 JSON 结构。

### 遗留主要代码

- `server/app.ts`：路由和错误映射。
- `server/persistence/workspace.store.ts`：工作区存储。
- `contracts/analytics.ts`、`contracts/card.ts`：协议。
- `server/config/env.ts`：环境变量校验。
