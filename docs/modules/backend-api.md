# BI 后端 API 模块

> 当前状态（2026-09-08）：本页记录当前源码树中的真实实现。自有账号、V2 身份边界和新版公网收口已经完成本地代码与测试建设，但尚未部署到生产；不能把本文中的“已实现”理解为线上已经生效。

## 1. 模块边界

后端保留同仓模块化单体，当前分为四条边界：

1. `/api/bi/v2/auth/*`：YPBI 自有账号、会话和改密。
2. `/api/bi/v2/*`：需要普通账号身份和 `bi:read` 权限的目标产品只读 API；首批只开放指标 / 平台目录与 M016 查询。
3. `/api/bi/admin/*`：维护者进入数据源维护前的角色校验和二次认证。
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

- 密码长度为 12～256 个字符；生产哈希使用带随机 salt 的 scrypt，参数为 `N=2^17、r=8、p=1`。该档位单次约需 128 MiB 内存，进程内统一限制为最多 1 个执行、2 个排队，超额快速返回 `503 AUTH_SERVICE_UNAVAILABLE` 与 `Retry-After: 5`；容量错误不能被记为密码错误或累计账号锁定。
- 账号不存在、密码错误、账号已停用和账号处于锁定期，对外统一返回 `401 INVALID_CREDENTIALS`，避免泄露账号是否存在。
- 同一有效账号在 15 分钟窗口内连续失败 5 次后锁定 15 分钟；登录成功会清除失败记录。
- 新建账号和管理员重置密码后，`must_change_password=true`。首次改密前 Principal 只有 `bi:account:change-password`，不能读取 BI 数据。
- 用户改密会在一个数据库事务中递增 `credential_version`、撤销该用户全部旧会话并为当前客户端签发新会话。
- CLI 重置密码会递增 `credential_version` 并撤销全部会话；实际发生的停用、重新启用或角色修改同样递增版本并撤销全部旧会话。重新启用还会清除登录失败与锁定状态，但保留密码、角色和首次改密要求。
- 当前没有自助注册、忘记密码、重新启用、修改角色或账号列表 API；这些能力不得由前端自行补造。

### 2.3 角色与权限

| 角色 | 当前权限 |
|---|---|
| `reader` | `bi:read`、`bi:export`、`bi:favorite:write`、`bi:view-link:create` |
| `analyst` | reader 全部权限，加 `bi:analysis:write`、`bi:dashboard:write`、`bi:metric-overview:write` |
| `maintainer` | analyst 全部权限，加 `bi:official-dashboard:write`、`bi:maintenance-scope:write`、`bi:data-source-maintenance:enter` |

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

1. 普通账号仍有效；
2. 角色为 `maintainer`；
3. 权限包含 `bi:data-source-maintenance:enter`。

通过角色门禁后，维护者还需使用 `TOKEN_MAINTENANCE_KEY` 完成二次认证。维护会话：

- 有效期 30 分钟，保存在当前 API 进程内存；API 重启后全部失效。
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

候选验证失败不覆盖旧凭据。凭据文件使用 `0600`、独立临时文件和原子替换；两站并发更新在服务端串行化，成功后清上游缓存。当前探针只证明指定站点、固定验证 PID 和 `pDaySum` 可用，不等于该站全部 PID、接口和指标完成验数。

## 6. V2 只读 API

V2 业务路由每次请求都通过 `IdentityProvider` 解析服务端会话，并在 3 秒外层超时边界内运行时校验 Principal；`/api/bi/v2/auth/session`、退出和改密所复用的会话查询也使用独立 3 秒期限，并在客户端中断时立即取消。PostgreSQL 运行池固定最多 4 个连接，单条语句最多 2.5 秒、数据库锁最多等待 1 秒、事务空闲最多 5 秒；外层 AbortSignal 会调用底层 PostgreSQL query cancel。这样请求超时或客户端中断后不会只停止 HTTP 等待而让遗留查询继续耗尽鉴权连接。未登录返回 `401 AUTHENTICATION_REQUIRED`；业务身份存储不可用或超时返回 `503 IDENTITY_PROVIDER_UNAVAILABLE`，认证端点对应返回 `503 AUTH_SERVICE_UNAVAILABLE`；缺少 `bi:read` 返回 `403 BI_READ_ACCESS_DENIED`。

| 方法 | 路径 | 当前契约 |
|---|---|---|
| GET | `/api/bi/v2/catalog/metrics` | 返回运行目录中的 M016、权威版本 `v0.23-draft` 与待验数状态 |
| GET | `/api/bi/v2/catalog/platforms` | 返回服务端有效平台目录与 Principal PID 范围的交集 |
| POST | `/api/bi/v2/queries/metrics` | 接受 `metricId + pid + dateRange + grain=day`，返回 M016 单 PID 日序列和逐日数据状态 |

首批 M016 source 只把 `/api/admin/statistics/pDaySum` 的 `loginUserCount` 映射为候选值。它不聚合重复行、不补 0、不修正异常整数，也不把范围外日期、错误 PID、分页截断或空值包装成成功数据。结果保留 `available / partial / no_values / no_records`，`watermark` 在上游未提供正式成熟水位前为 `null`。

查询范围最多 366 个业务日。上游 Token 失效、IP 限制、限流和超时只映射成 V2 依赖错误，不冒充产品用户的 401 / 403，也不向浏览器回传上游原文。

当前 V2 没有保存分析、看板编辑、卡片编辑、导出任务或其他目标对象写 API。

## 7. 健康检查

| 路径 | 用途 | 公网状态 |
|---|---|---|
| `/api/bi/health` | 只证明 API 进程可响应及主上游地址是否配置，不证明 Token 或数据可用 | Nginx 白名单允许 |
| `/api/bi/ready` | 检查遗留工作区、主站与备用站各自的只读凭据探针和普通身份库；本地账号模式通过 `select 1` 检查 PostgreSQL | 仅供服务器本机发布检查，公网 Nginx 不转发 |

生产发布不能只看 `/health`。只有 `/ready` 的 `workspace、upstream、identity` 全为 true，且 `upstreamSites.primary、upstreamSites.secondary` 均为 true 才返回 200；任一依赖失败返回 503 degraded。当前两站 readiness 分别以 PH 与 FBI 的 `pDaySum` 小查询验证匹配 Token 和用户名，不代表全量 PID、接口或指标验收。

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

截至 2026-09-08，本地 `npm run build:server`、`npm run typecheck`、认证运行时 smoke、语义路由 Node 测试 2/2 和 V2 Playwright 28/28 已通过；账号、Cookie、CSRF、锁定、角色、全部 PID、会话撤销、migration 有界锁等待、身份 query cancel、维护绑定和代理边界均已有测试文件。当前执行环境没有 Bun，Bun 测试套件未运行；没有连接真实 PostgreSQL 验证语句超时后连接槽释放，也没有执行真实 migration 或在生产 Caddy / Nginx 拓扑完成黑盒验证。

部署状态：未部署。生产开放门槛、备份、回滚和黑盒矩阵见[部署与运维模块](./deployment.md)。
