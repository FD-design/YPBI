# BI 后端 API 模块

## 2026-09-23 bi-v1 指标渐进适配

`server/upstream/bi-v1.adapter.ts` 负责播放专用结果，`server/upstream/bi-v1.metrics-adapter.ts` 负责开发文档登记的通用指标结果；两者都复用现有请求级 Token、PID 和环境路由。M034、M036、M097 按 `videoType` 聚合，M036 使用同批分子分母重算，不平均分类或每日比率。

通用适配已登记当前页面存在直接对应关系的 M001、M003、M005、M006、M007、M016、M020～M023、M026、M060、M081、M112、M114。同名指标返回 READY 时成为该日权威值；SOURCE_INCOMPLETE、无记录或通用接口请求失败时继续使用原来已经接通的旧接口真值，避免新接口占位导致现有页面断数；PROCESSING、NOT_MATURE、FAILED 则按状态展示，不伪装成旧值。比率只使用同批总分子／总分母；通用映射只接受 PID 总体行，不在 BI 内相加未知维度，并严格校验日期、PID、单位、重复维度与安全数值。PID、日期或请求指标范围冲突继续拒绝整批；值级异常按指标和业务日隔离，非 READY 行即使错误携带数值也只采用状态、不消费该数值，合法兄弟指标继续返回。

开发文档虽登记首批26项，但当前测试后台实查只有 M034/M036/M097 已接事实表并返回 READY，其余23项仍为上游占位。本批不新增诊断路由或数据源维护功能。没有现成页面位置、正式维度契约或仍明确标记为演示的数据，不因 Token 切换自动变成真实数据；需要先登记页面映射后才展示。

测试 Token 不是单独给 `bi-v1` 使用。凡经 V2 查询编排进入 `UpstreamClient` 的请求，在测试数据模式下都由同一个请求级配置覆盖后台地址、用户名和 Token；开发修改测试后台旧接口后，已映射字段直接读取测试返回。正式模式仍按 PID 走正式站1/站2，测试和正式缓存不互相命中，也不相互回退。

## 团队账号管理（2026-09-16）

`GET/POST /api/bi/v2/team/accounts` 提供列表和创建，`PUT /api/bi/v2/team/accounts/:username` 按 action 调整角色、状态或重置密码。普通账号、未完成首次改密的账号和匿名请求均被服务端拒绝；写入强制 CSRF、生产同源校验和每管理员每分钟 12 次限流。列表每页 20 项，只返回公开账号摘要。

沿用 `reader` / `maintainer` 存储角色，已有 `analyst` 仅兼容读取、不开放新增。团队页禁止修改自身账号；降级或停用管理员时通过 PostgreSQL 事务咨询锁保护最后一名可用管理员。角色、状态或密码变化会原子更新凭据版本并撤销旧会话，不提供明文密码查询或账号物理删除接口。

## 2026-09-14 观影旧接口与金额单位

本地候选按用户确认新增 M101/M102/M098：播放发起次数严格校验同一业务日 288 个五分钟点后累计；总时长及人均时长取渠道独立日合计与同源人数，暂按秒换算，保留旧接口记录范围和待验数说明。金额统一人民币元，原值不缩放。纯金额及总时长复用完整日期的周期合计/均值；人均、ARPU、ARPPU不直接平均。

经批准，`sourceApiIds` 上限从 4 扩至 5，完整保留新增来源；旧 v1/v2 响应、URL、请求和权限兼容。原始时长与人数通过实名输入返回，浏览器不重算原始日聚合。字段单位、定义、来源说明进入卡片、详情和导出。暂定秒不是正式验数结论，正式指标及采集契约未变；实施与回退见调整方案 9.27。

## 2026-09-14 本地周期统计

本地日看板返回 `day-dashboard/v2`，逐系列附 `periodStatistics`（`daily-statistics/v1`）：完整查询范围、日数、可用状态、合计 / 日均及不可用原因。解析保留严格 v1 兼容，v1 不补统计。能力登记在 `daily-dashboard.service.ts` 的候选投影表；全部已结束日期均有有效日值才计算，0 参与，错范围或与同快照日点不符的执行器统计失败关闭。

日去重人数只提供日均；比率、人均、成熟批次、月活及未知币种金额不做普通日聚合。统计仍为待验数、未知完整性和空水位，权限、Token、查询字段与线上路径不变。验收记录见调整方案 9.25。

## 2026-09-12 本地受保护日看板读取

新增`GET /api/bi/v2/catalog/readable-dashboards`和`POST /api/bi/v2/queries/dashboards/daily-reading`，共同受现有真实会话、`bi:read`和有效PID范围保护，响应`no-store`。目录从PRD生成的官方看板快照派生；查询契约由`contracts/daily-dashboard.ts`统一定义，输入仅接受看板、单PID、1～366天日期区间。

`DailyDashboardService`从唯一候选表读取日汇总、注册留存增强、渠道V2、支付通道统计、签到概览及实时统计6类来源，80个投影按板分配，`dailyDashboardProjectionDocumentation()`派生核对表。校验分页总数、重复日期、错PID、越界日期、数值类型及结果映射；日汇总／留存整源冲突独立失败，渠道／支付／签到／实时统计逐日失败独立保留。真实0、无记录、字段缺失、异常值、分母为0、未成熟、来源失败分别返回，完整性未知、水位为空、验数状态为待验数。不返回上游原文或凭据，不改变正式指标准入与授权。

`BI_LOCAL_DASHBOARD_READING_ENABLED`默认关闭，只允许非生产、loopback运行。关闭后不执行上游日查询；production禁止启用。该独立路径不改变既有M016技术查询、正式核心总览准入或角色策略。无Schema变更、存量迁移或对象写API。实际UI覆盖见[数据支持清单](./data-platform.md#看板数据支持清单2026-09-12)。

## 2026-09-12 独立本地认证验证

本地启用独立PostgreSQL账号库及既有migration，旧业务数据未迁移。`qa-v2-local-connection.spec.ts`使用真实数据库验证普通阅读者的登录、首次改密、维护二次认证、刷新以及停用/重新启用后的旧会话撤销；不模拟接口成功。`PostgresAuthRepository`状态更新对同一参数统一显式`varchar`类型，消除PostgreSQL在赋值和CASE比较间的推导冲突；Schema和密码/凭据版本语义不变。

`permissionsByRole`统一授予三档已登录角色共享Token维护能力；受控技术验数仍额外要求维护者角色。服务端正例覆盖三档角色保存，负例覆盖无身份、无能力、未改密、无二次认证、CSRF和安全上下文变化。本地运行入口见部署模块；两站日汇总20平台真实抽查与分页修复见数据与平台模块，指标正式验数仍未完成。

> 当前状态（2026-09-12）：本页记录当前源码树中的真实实现。自有账号、V2 身份边界和新版公网收口已经完成本地代码与测试建设，但尚未部署到生产；不能把本文中的“已实现”理解为线上已经生效。指标目录同步v0.24-draft，旧M016映射过期待复核，查询门禁保持。

## 1. 模块边界

后端保留同仓模块化单体，当前分为四条边界：

1. `/api/bi/v2/auth/*`：YPBI 自有账号、会话和改密。
2. `/api/bi/v2/*`：需要普通账号身份和 `bi:read` 权限的目标产品只读 API；当前包含指标 / 平台目录、M016 技术查询，以及默认关闭且尚无真实执行器的核心经营总览首屏批量查询门禁。
3. `/api/bi/admin/*`：已登录用户进入数据源维护前的能力校验和二次认证。
4. 遗留 `/api/bi/*`：仍保留在 Fastify 内，供本机迁移核对；目标公网代理不再转发，生产环境的旧工作区写入还会由应用层返回 `410`。

身份、角色、PID 范围和错误语义由服务端执行。前端隐藏入口、URL 跳转限制和浏览器状态都不是授权依据。

## 2. YPBI 自有账号

### 2.1 PostgreSQL 与版本化 migration

普通账号使用独立的 `BI_AUTH_DATABASE_URL`，不复用遗留工作区的 `DATABASE_URL`。当前 migration 为 `server/persistence/migrations/001_auth_users_sessions.sql`，新增：

- `bi_auth_users`：账号、显示名、角色、参数化密码哈希、账号状态、首次改密、登录失败和 `credential_version`。
- `bi_auth_sessions`：用户、会话 Token 哈希、凭据版本、创建 / 过期 / 撤销时间。数据库不保存原始会话 Token。
- `bi_schema_migrations`：版本、名称、SHA-256 校验和与应用时间。

应用启动和账号 CLI 都会执行 migration runner。应用启动时先使用独立、单连接的维护池执行 migration，完成后关闭，再建立面向公网身份请求的运行池，二者不争用连接槽。runner 在同一个 PostgreSQL 事务连接内使用 `pg_try_advisory_xact_lock` 尝试取得 transaction-scoped advisory lock，最多等待 30 秒；单条 migration 语句最多 60 秒、数据库对象锁最多等待 10 秒、事务空闲最多 65 秒。超过任一边界均使启动失败，不永久挂住。`BI_AUTH_DATABASE_URL` 若通过 query 参数设置 `statement_timeout`、`lock_timeout`、`options`、`search_path` 等可覆盖安全上限或会话语义的参数，应用失败关闭，不静默采用。runner 按版本顺序执行缺失 migration；已经执行的版本若名称或校验和与仓库不一致，启动失败。已执行 migration 不允许修改，后续数据库变化必须新增更高版本的 additive migration。

当前 migration 只新增账号相关表和索引，不读取、改写或迁移旧工作区数据。没有 down migration；应用回滚时保留这些新增表，由旧版本忽略。

### 2.2 密码、锁定与账号状态

- 普通 BI 账号密码长度为 6～256 个字符；生产哈希使用带随机 salt 的 scrypt，参数为 `N=2^17、r=8、p=1`。该档位单次约需 128 MiB 内存，进程内统一限制为最多 1 个执行、2 个排队，超额快速返回 `503 AUTH_SERVICE_UNAVAILABLE` 与 `Retry-After: 5`；容量错误不能被记为密码错误或累计账号锁定。数据源维护密码仍至少 12 个字符，不随普通账号规则放宽。
- 账号不存在、密码错误、账号已停用和账号处于锁定期，对外统一返回 `401 INVALID_CREDENTIALS`，避免泄露账号是否存在。
- 同一有效账号在 15 分钟窗口内连续失败 5 次后锁定 15 分钟；登录成功会清除失败记录。
- 新建账号和管理员重置密码后，`must_change_password=true`。首次改密前 Principal 只有 `bi:account:change-password`，不能读取 BI 数据。
- 用户改密会在一个数据库事务中递增 `credential_version`、撤销该用户全部旧会话并为当前客户端签发新会话。
- CLI 重置密码会递增 `credential_version` 并撤销全部会话；实际发生的停用、重新启用或角色修改同样递增版本并撤销全部旧会话。重新启用还会清除登录失败与锁定状态，但保留密码、角色和首次改密要求。
- 当前没有自助注册、忘记密码、重新启用、修改角色或账号列表 API；这些能力不得由前端自行补造。

### 2.3 角色与权限

| 角色 | 当前权限 |
|---|---|
| `reader` | `bi:read`、`bi:export`、`bi:favorite:write`、`bi:view-link:create`、`bi:data-source-maintenance:enter` |
| `analyst` | reader 全部权限，加 `bi:analysis:write`、`bi:dashboard:write`、`bi:metric-overview:write` |
| `maintainer` | analyst 全部权限，加 `bi:official-dashboard:write`、`bi:maintenance-scope:write`；受控技术验数仍限定维护者 |

当前所有已登录 Principal 的 `pidScope` 固定为 `all`，含义是可访问服务端平台目录在当次请求中返回的全部有效 PID；账号表不保存 PID 数量或逐账号 PID 白名单。当前平台目录底层仍来自迁移期注册表，后续换成动态目录 Provider 时，认证模型和前端无需写死平台数量。

首次改密状态优先于角色权限：即使账号角色是 maintainer，完成首次改密前也只能调用改密能力。

## 3. 普通会话与 CSRF

- 登录签发 32 字节随机、不透明的服务端会话，默认有效期 12 小时；数据库只保存 SHA-256 Token 哈希。
- 生产 Cookie 固定为 `__Host-ypbi_session`，属性为 `Path=/; HttpOnly; Secure; SameSite=Strict`，不设置 Domain。
- 本地开发必须显式使用独立的 `ypbi_session` 非 Secure Cookie；不能为了本地 HTTP 调试降低生产 Cookie 属性。
- CSRF Token 由服务端使用独立 secret 对原始会话 Token 做 HMAC 派生，不进入数据库。登录、读取会话和成功改密响应会返回当前 CSRF Token；退出和改密请求必须通过 `X-CSRF-Token` 回传。
- 生产环境为 auth 插件配置唯一 `BI_PUBLIC_ORIGIN`。登录、退出和改密的 POST / PUT 请求必须携带与其完全一致的 Origin；缺失、带路径或跨源均返回 `403 ORIGIN_VALIDATION_FAILED`。
- 生产环境的全部数据源维护 POST / PUT 同时校验普通会话的 CSRF Token 和严格 Origin；维护密码与维护 Cookie 不能替代普通会话 CSRF。缺失或错误 CSRF 返回 `403 CSRF_VALIDATION_FAILED`，且不会执行维护操作。
- 普通退出立即撤销服务端会话并清除 Cookie。账号重置密码、实际停用、重新启用、角色变化、用户改密、会话过期或 `credential_version` 不一致都会使旧会话失效；同角色或同状态的幂等操作不无故踢下线。
- 普通退出和用户改密成功后，应用还会撤销同一 `subjectId` 的内存维护会话。
- 所有 auth 响应均设置 `Cache-Control: no-store`；日志不记录密码、Cookie、原始 Token、CSRF Token 或请求正文。

## 4. Auth API

`contracts/bi-auth.ts` 是以下请求、响应和错误码的运行时契约。成功的登录、会话读取和改密响应统一返回 `user、expiresAt、mustChangePassword、csrfToken`；`user` 包含 `subjectId、username、displayName、role、permissions、pidScope`。

| 方法 | 路径 | 请求与结果 | 主要拒绝 |
|---|---|---|---|
| POST | `/api/bi/v2/auth/login` | `username + password`；成功建立 12 小时会话 | 400 格式错误；401 凭据无效；403 Origin；429 代理限流；503 账号服务不可用 |
| GET | `/api/bi/v2/auth/session` | 返回当前完整会话数据；无效时清 Cookie | 401 未登录；503 账号服务不可用 |
| POST | `/api/bi/v2/auth/logout` | 需要会话、Origin 和 CSRF；成功返回 `loggedOut=true` | 401 会话失效；403 Origin / CSRF；503 撤销未完成 |
| PUT | `/api/bi/v2/auth/password` | `currentPassword + newPassword`，需要会话、Origin 和 CSRF；成功轮换会话 | 400 格式错误或当前密码错误；401 会话失效；403 Origin / CSRF；429 代理限流；503 容量、事务或依赖不可用 |

当前密码错误使用 `400 CURRENT_PASSWORD_INVALID`，不会被前端误判成登录失效。除 auth 业务码外，公网边界还统一使用 `426 HTTPS_REQUIRED`、`503 AUTH_PROXY_MISCONFIGURED` 和 `429 V2_REQUEST_REJECTED`。V2 错误响应均包含稳定 `requestId`，Nginx 限流响应使用同一 JSON envelope。

没有 `/register` 路由。

## 5. 数据源维护的二次认证

数据源维护不是另一套普通账号体系。每个 `/api/bi/admin/*` 请求都先解析普通 YPBI 会话，并同时要求：

1. 普通账号仍有效并完成首次改密；
2. 权限包含 `bi:data-source-maintenance:enter`，由`permissionsByRole`统一授予阅读者、分析者和维护者。

通过普通身份门禁后，用户还需使用`TOKEN_MAINTENANCE_KEY`完成二次认证。Token为两站各自的全站共享凭据，保存确认说明对所有查询生效。维护会话：

- 有效期 30 分钟，保存在当前 API 进程内存；API 重启后全部失效。
- 激活前分别验证站1、站2代表 PID；同一标签页重新验证后旧测试会话立即撤销，内存会话总量有固定上限。
- 同时绑定普通账号 `subjectId`、角色、权限、`credential_version` 和可信代理解析出的真实客户端 IP；任一安全上下文变化都要求重新认证。身份源无法提供安全版本时，维护功能失败关闭。
- 使用独立 `bi_maintenance_session` Cookie，限定 `Path=/api/bi/admin`，并设置 `HttpOnly、Secure、SameSite=Strict`。
- 维护密码连续错误 5 次后，当前来源 IP 锁定 15 分钟；公网登录还受 Nginx 单 IP 和全局限流。
- 普通账号退出或用户改密后，关联维护会话立即撤销。CLI 重置、停用、重新启用或修改角色会升级 `credential_version`；即使账号随后恢复 maintainer 权限，旧维护会话也不能复用。
- 生产环境每个维护写请求还必须携带当前普通账号会话对应的 CSRF Token，并通过 `BI_PUBLIC_ORIGIN` 严格同源校验；二次认证只增加敏感操作门槛，不削弱第一层会话保护。

维护密码可使用服务端支持的 `sha256:<hex>` 形式保存，但不能进入前端、仓库、文档、截图或日志。维护会话不代替普通账号，也不能用于访问 V2 数据 API。

### 维护 API

| 方法 | 路径 | 功能 |
|---|---|---|
| POST | `/api/bi/admin/auth/login` | maintainer 使用维护密码建立二次会话 |
| POST | `/api/bi/admin/auth/logout` | 清除当前二次会话 |
| GET | `/api/bi/admin/data-sources/status` | 返回站点配置状态、脱敏提示和更新时间，不返回 Token |
| POST | `/api/bi/admin/data-sources/test` | 使用当前或候选 Token 验证连接，不保存候选值 |
| PUT | `/api/bi/admin/data-sources/token` | 服务端先验证候选 Token，再原子替换运行凭据 |
| GET | `/api/bi/admin/data-preview/status` | 返回临时测试数据功能和当前会话状态，不返回 Token |
| POST | `/api/bi/admin/data-preview/activate` | 验证候选测试 Token，成功后建立绑定当前普通登录的30分钟内存会话 |
| POST | `/api/bi/admin/data-preview/deactivate` | 删除当前服务端测试会话并清除预览 Cookie |

候选验证失败不覆盖旧凭据。凭据文件使用 `0600`、独立临时文件和原子替换；两站并发更新在服务端串行化，成功后清上游缓存。当前探针只证明从指定站点目录中选出的首个启用 PID 与 `pDaySum` 可用，不等于该站全部 PID、接口和指标完成验数。

## 6. V2 只读 API

V2 业务路由每次请求都通过 `IdentityProvider` 解析服务端会话，并在 3 秒外层超时边界内运行时校验 Principal；`/api/bi/v2/auth/session`、退出和改密所复用的会话查询也使用独立 3 秒期限，并在客户端中断时立即取消。PostgreSQL 运行池固定最多 4 个连接，单条语句最多 2.5 秒、数据库锁最多等待 1 秒、事务空闲最多 5 秒；外层 AbortSignal 会调用底层 PostgreSQL query cancel。这样请求超时或客户端中断后不会只停止 HTTP 等待而让遗留查询继续耗尽鉴权连接。未登录返回 `401 AUTHENTICATION_REQUIRED`；业务身份存储不可用或超时返回 `503 IDENTITY_PROVIDER_UNAVAILABLE`，认证端点对应返回 `503 AUTH_SERVICE_UNAVAILABLE`；缺少 `bi:read` 返回 `403 BI_READ_ACCESS_DENIED`。

| 方法 | 路径 | 当前契约 |
|---|---|---|
| GET | `/api/bi/v2/catalog/metric-definitions` | 返回由权威 Markdown 生成并校验的完整指标定义、分类、源建设状态、YPBI 映射、验数和派生可分析状态；当前 97 个标准指标＋3 个周期派生指标 |
| GET | `/api/bi/v2/catalog/metrics` | 兼容首个技术查询切片；仅当 M016 映射已配置、能力可投影且绑定当前权威版本时返回 M016，否则安全返回空目录；不代表正式选择器已经开放该指标 |
| GET | `/api/bi/v2/catalog/platforms` | 返回服务端有效平台目录与 Principal PID 范围的交集 |
| GET | `/api/bi/v2/data-environment` | 返回当前请求明确选择的正式/测试数据环境；测试会话无效时返回409，不回退正式数据 |
| POST | `/api/bi/v2/queries/dashboards/daily-reading` | 返回指定看板、PID和日期范围的逐日结果；M034/M036/M097 读取播放事实，已登记同名指标在通用 bi-v1 READY 时优先展示，否则按状态或旧接口回退规则处理 |
| POST | `/api/bi/v2/queries/metrics` | 兼容 M016 受控验数与后续正式查询；接受 `metricId + pid + dateRange + grain=day`，返回单 PID 日序列、逐日数据状态、映射版本和验数状态；未验数时只有具备数据源维护权限的维护者可对“已配置且绑定当前权威版本”的映射执行，其他不可用映射均失败关闭 |
| POST | `/api/bi/v2/queries/dashboards/core-overview` | 核心经营总览 `core-overview/v1` 首屏只读批量契约；接受正式整体或一组 PID、最近共同完整周期或明确日期范围，以及固定 9 项指标的可选子集。当前 `BI_V2_CORE_OVERVIEW_QUERY_ENABLED=false` 且没有真实执行器，因此经过身份校验后返回 503，不提供业务值 |

完整指标目录由 `tools/generate-metric-definitions.mjs` 从 `全站指标体系.md` 与版本化 `server/v2/config/metric-mapping-registry.v1.json` 确定性生成。前者是指标定义权威源，后者是 YPBI 查询映射与验数证据的唯一登记源；运行快照带指标权威版本、接入登记版本、源文件和内容 SHA-256。注册表严格拒绝未知字段、重复指标、错绑映射版本或权威版本，以及没有带时区时间与证据 ID 的通过 / 失败 / 过期结果；非未开始的验数状态必须同时登记 `mappingVersion` 与 `authorityVersion`。对状态为 `configured` 的映射，生成器还会校验指标 ID、映射版本、来源接口和全部声明能力与当前已实现查询 Adapter 精确一致，避免注册表改了来源而执行器仍调用旧接口。`metrics:check`、服务端启动及浏览器响应都会拒绝结构、版本、Adapter 契约或哈希不一致。`npm run build` 已通过 `prebuild` 强制执行该检查，发布统一入口 `npm run verify:release` 还包含生成器测试、类型检查、服务端检查、生产构建和 Bun 测试；发布工作区缺少相邻权威源时不得跳过检查。源建设、查询映射和验数互相独立；只有当前权威版本、映射版本、Adapter 契约一致且验数通过时，派生 `analysis.status` 才能为可用。

`verify:release` 的当前确切顺序为：指标定义生成器测试 → M016 离线验数工具测试 → 运行时发布准入测试 → `validation:check` → `typecheck` → `build:server` → 生产 `build` → 完整 `npm test`。最后一步依赖 Bun；运行环境缺少 Bun 时必须报告统一发布校验未全量完成，不能用前置 Node 测试通过替代。

结果态验数还必须在注册表中通过 `evidenceSha256` 固定证据原文；证据再绑定平台目录 revision 与内容摘要、全部启用 PID、7～366 个连续完整业务日、候选 / 参考数据摘要、自动比较产物路径及其摘要和九项检查。生成器同时写出 `server/v2/generated/metric-release-attestation.json`；服务启动加载指标定义时重验指标快照、注册表、平台目录、结果态证据和比较产物的固定路径与 SHA-256，并拒绝符号链接、路径逃逸、未来验证时间和注册结果缺失。该 attestation 是仓库内一致性门禁，不是带外数字签名。

首批 M016 source 只把 `/api/admin/statistics/pDaySum` 的 `loginUserCount` 映射为候选值。它不聚合重复行、不补 0、不修正异常整数，也不把范围外日期、错误 PID、分页截断或空值包装成成功数据。结果保留 `available / partial / no_values / no_records`，并返回 `mappingVersion` 与 `validationStatus`；两者直接从完整指标目录的当前 M016 准入事实派生，不维护第二份手工状态。正式页面只接受“验数已通过、响应映射版本等于准入目录当前版本且具有可信数据水位”的结果。

V2 查询响应的公共 `watermark` 契约现为 `null | { type: "complete_through_business_date"; completeThrough; timeZone: "Asia/Shanghai"; pid; sourceApiId; sourceKind; observedAt }`。`sourceKind` 仅允许 `upstream_explicit`（本次正式业务 API 明确返回）和 `upstream_completion_api`（已登记的完成状态 API——上游或服务端加工——明确返回）。`server/v2/metric-watermark-source-registry.ts` 是可信水位来源的唯一代码登记源，只有 `metricId + sourceKind + sourceApiId` 三项完全匹配的来源才能被采用；当前生产登记为空。服务端严格校验结构、PID、登记三元组、查询结束日和取证时间：`passed + null` 或用户请求结束日晚于可信完整日属于可预期的能力 / 范围限制，返回 `422 METRIC_NOT_READY`；对象结构畸形、PID 冲突、来源种类或接口未登记、来源与当前指标不匹配、取证时间冲突等上游契约问题返回 `502 V2_METRIC_SOURCE_CONFLICT`。两类失败都不截断日期、不保留业务结果。Plugin 在出站前还会复核完整成功响应 Schema 及 `metricId / pid / grain / dateRange` 与原请求一致，避免执行器把错范围或半成品结果交给浏览器。当前 `pDaySum` 没有经确认的显式水位，也没有已登记的完成状态 API，因此 `PDaySumM016Source` 仍固定返回 `null`，M016 验数未开始且普通用户正式分析保持关闭；维护者只能在映射为 `configured`、绑定当前权威版本且验数为 `not_started/running` 时取得待验数技术响应。首次正式查询的默认日期还需后续只读水位能力或服务端 `latest_complete` 语义，不能从最大返回日期、查询时间或“昨日”推断。

查询范围最多 366 个业务日。上游 Token 失效、IP 限制、限流和超时只映射成 V2 依赖错误，不冒充产品用户的 401 / 403，也不向浏览器回传上游原文。

临时测试数据由请求头 `x-ypbi-data-environment: test` 显式选择。未携带或值为 `production` 的旧客户端行为不变；非法值返回 `400 INVALID_DATA_ENVIRONMENT`，服务未开放返回 `409 DATA_PREVIEW_DISABLED`，测试会话缺失、过期或安全绑定不匹配返回 `409 DATA_PREVIEW_SESSION_REQUIRED`。有效测试请求通过请求级异步上下文覆盖上游地址、用户名和 Token；权限、PID、指标准入、数据水位及出站契约仍按原链路执行。

核心经营总览批量契约由 `contracts/core-overview.ts` 唯一定义。请求默认选择 M016、M008、M026、M102、M059、M058、M081、M036、M020，并允许只带其中一部分用于单卡重试；指标始终按固定业务顺序返回。`official_overall` 只代表正式整体结果，不能由 PID 合并得到；`pids` 请求经权限校验后按当前服务端平台目录排序，每个 PID 都必须独立返回全部所选卡片或状态。技术载荷最多接受 256 个 PID，但产品数量不写死，实际范围仍由平台目录决定。

默认日期由真实执行器把 `latest_complete + 7 天 + previous_equal` 解析为 Asia/Shanghai 下的共同可信水位、当前范围和上一等长范围；明确日期请求可以没有对比或使用不等长对比。当前期与对比期趋势是两条独立序列，分别逐日完整回显，避免按位置配对导致非等长周期丢点。可用卡片必须返回实际统计范围、纳入日期、非负原始值、单位、币种、合法比较、趋势、当前权威版本、映射版本、`passed` 验数、登记来源与范围一致的可信水位；比例统一使用 0～1 原始值，真实 0 合法。不可用状态区分 `no_records / no_values / not_produced / immature / not_ready / unsupported / failed`，部分成功仍返回 HTTP 200 并由 `meta.partial` 与逐卡状态保持一致。

`server/v2/core-overview/core-overview-admission.ts` 与 `core-overview-period.ts` 是内部纯函数底座。前者由调用方显式注入当前指标定义解析器，直接采用快照已派生的 `analysis` 状态后再检查日粒度和范围能力，不重算准入事实；后者仅接受已通过契约和来源登记校验的指标×范围水位，取全部传入水位的最小完整日并解析周期。`available` 及带可信 provenance 的 `no_records / no_values / not_produced / immature` 均可参与计算；数组为空时抛出 `NO_TRUSTED_WATERMARK`，明确日期的当前期或对比期越过公共水位时也失败关闭。公共成功响应 Schema 已要求至少一张卡片提供合法 provenance，并直接校验 `commonCompleteThrough` 等于所有卡片可信水位最小值。正确执行器抛出的周期解析错误由路由映射为现有 `422 METRIC_NOT_READY`；执行器若错误返回全 `not_ready` / `failed` 的 200 成功体，会被 Schema 拒绝并返回 `502 CORE_OVERVIEW_SOURCE_CONFLICT`。当前仍未创建 provider / 真实 executor，也未改变生产开关。

路由先恢复身份，再检查开关、执行器、请求、PID 范围、执行结果 Schema、请求回显及当前指标准入。响应若缺卡、跨 PID 合并、日期越界、单位或币种冲突、对比算法错误、版本或水位失配，统一返回脱敏的 `502 CORE_OVERVIEW_SOURCE_CONFLICT`；单张上游查询失败应由真实执行器收敛为对应卡片 `failed`，不擦除其他成功卡。读取型 POST 不要求 CSRF，但仍要求会话、`bi:read`、HTTPS 和可信代理。开关只接受明确 `true/false`，默认关闭；若配置为 true 却未注入真实执行器，应用在启动时失败关闭。

当前 V2 没有保存分析、看板编辑、卡片编辑、导出任务或其他目标对象写 API。

## 7. 健康检查

| 路径 | 用途 | 公网状态 |
|---|---|---|
| `/api/bi/health` | 只证明 API 进程可响应及主上游地址是否配置，不证明 Token 或数据可用 | Nginx 白名单允许 |
| `/api/bi/ready` | 检查遗留工作区、主站与备用站各自的只读凭据探针和普通身份库；本地账号模式通过 `select 1` 检查 PostgreSQL | 仅供服务器本机发布检查，公网 Nginx 不转发 |

生产发布不能只看 `/health`。只有 `/ready` 的 `workspace、upstream、identity` 全为 true，且 `upstreamSites.primary、upstreamSites.secondary` 均为 true 才返回 200；任一依赖失败返回 503 degraded。两站 readiness 分别从服务端平台目录选择该站第一个启用 PID 执行 `pDaySum` 小查询，验证匹配 Token 和用户名，不代表全量 PID、接口或指标验收。

## 8. 遗留 API 的生产收口

遗留路由仍注册在 Fastify，以便同仓迁移和本机核对；它们不属于目标公网 API：

- 目标 Nginx 只允许 `/api/bi/v2/*`、`/api/bi/admin/*` 和 `/api/bi/health`，其他 `/api/*` 统一返回 404。
- 即使绕过 Nginx 从服务器本机直连 Fastify，production 的 `PUT /api/bi/workspace` 也返回 `410 LEGACY_WORKSPACE_WRITE_DISABLED`。
- `GET /api/bi/workspace`、旧平台 / 能力目录、旧 analytics、卡片校验、drilldown、channel、content、special、metadata 和通用 source 查询只保留为迁移期代码事实，不得重新加入公网白名单。
- 旧工作区在配置 `DATABASE_URL` 时使用其 PostgreSQL；未配置时使用 `WORKSPACE_FILE`，并保留原子写入与上一版本备份。该存储与 `BI_AUTH_DATABASE_URL` 完全分离。
- 本地 development / test 仍可写旧工作区用于既有测试和迁移核对；这不是生产写入能力。

禁止让旧匿名 API、旧 workspace PUT 或浏览器 `localStorage` 双状态绕过 V2 身份和目标对象模型。后续迁移只允许读取、核对和一次性搬迁，不双写。

## 9. 账号 CLI

账号只通过服务器侧交互式 CLI 维护：

```text
bun server/scripts/manage-bi-user.ts create --username <账号> [--display-name <姓名>] [--role <reader|analyst|maintainer>]
bun server/scripts/manage-bi-user.ts reset-password --username <账号>
bun server/scripts/manage-bi-user.ts disable --username <账号>
bun server/scripts/manage-bi-user.ts enable --username <账号>
bun server/scripts/manage-bi-user.ts set-role --username <账号> --role <reader|analyst|maintainer>
```

运行前必须在进程环境中安全提供 `BI_AUTH_DATABASE_URL`。create 和 reset-password 会在真实 TTY 中两次读取不回显密码；CLI 拒绝从命令参数、环境变量或管道接收密码。disable 和 enable 要求再次输入完整账号，set-role 要求输入“账号:新角色”，状态与角色命令不能通过管道自动确认。CLI 会先执行 migration，且不输出密码、哈希、会话或数据库连接串。

create 默认角色为 reader；创建和重置后的密码都要求用户首次登录立即修改。角色或启停状态真正变化时，操作使用 `credential_version` 乐观并发条件，在同一事务中升级认证版本并撤销该账号的全部普通会话；重新启用同时清除登录失败与锁定状态，但保留密码、角色和首次改密状态。重复设置相同角色或状态保持幂等且不撤销当前会话。当前 CLI 不支持批量导入或列举账号。

## 10. 主要代码与验证状态

- `contracts/bi-auth.ts`：账号请求、Principal、会话响应和稳定错误码。
- `server/auth`：密码、Cookie、会话、角色、Repository、IdentityProvider、数据库连接时限和 Fastify auth plugin。
- `server/persistence/migrations`：账号库有序 migration 与 runner。
- `server/scripts/manage-bi-user.ts`：安全交互式账号维护 CLI。
- `contracts/bi-v2.ts`、`server/identity`、`server/v2`：V2 只读目录和查询边界。
- `server/security/maintenance-auth.ts`：绑定普通账号与 IP 的维护二次会话。
- `server/app.ts`：生产 HTTPS / 可信代理门禁、维护角色门禁、遗留写入冻结和模块组装。

2026-09-09 当前本地复核：Bun 1.4.2 完整 `npm test` 为 363/363；`npm run verify:release` 全链通过，包括指标生成器 33/33、M016 离线验数 27/27、发布准入 4/4、导航 3/3、主题 4/4、卡片 / 页面模型 / tooltip 25/25、服务端准入 / 周期 14/14、查询控制器 10/10、公共合同 6/6，以及快照检查、类型检查、前后端构建和生产样板隔离扫描。新增运行时响应生命周期反例覆盖中文拒绝响应只发送一次且不进入后续处理；维护测试按名称校验单值 / 多值 Cookie。没有为测试修改业务认证、Cookie 或权限实现。

服务器 / 连接配置与真实联调已按用户要求后置。上述结果是受控测试与构建证据；没有连接真实 PostgreSQL、真实批量执行器或上游业务数据，也没有执行真实 migration 或在生产 Caddy / Nginx 拓扑完成黑盒验证。浏览器验证的当前结果见[前端模块](./frontend.md#验证状态)。

部署状态：未部署。生产开放门槛、备份、回滚和黑盒矩阵见[部署与运维模块](./deployment.md)。
