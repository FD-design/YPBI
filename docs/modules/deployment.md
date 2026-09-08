# 部署与运维模块

> 当前状态（2026-09-08）：本页描述仓库中待发布的目标拓扑与操作门槛。自有账号、HTTPS-only 公网入口、代理白名单和最小权限 systemd 配置尚未安装到生产；当前线上状态必须在发布前只读核对，不能根据仓库文件推断。

## 1. 目标生产拓扑

```text
互联网用户
  └─ Caddy：公网 80 / 443、TLS、HTTP→HTTPS、静态 dist
       └─ /api/* → Nginx 127.0.0.1:5178
            └─ 路由白名单、登录/通用限流、真实 IP 归一化
                 └─ Fastify 127.0.0.1:3000
                      ├─ PostgreSQL 自有账号库
                      ├─ 遗留 workspace 文件或独立 PostgreSQL
                      └─ 上游业务后台 API
```

核心规则：

- Caddy 是唯一公网入口，只允许 80 / 443；80 只用于跳转 443。
- Caddy 直接从 `/opt/config-driven-bi-demo/dist` 提供静态页面和 SPA fallback，不再运行 Vite preview，也不再需要 `config-driven-bi-web` systemd 服务。
- Caddy 的 `/api/*` 先进入 loopback Nginx；Nginx 负责公网 API 白名单与限流，再转发到 loopback Fastify。Caddy 不直连 Fastify。
- Nginx `127.0.0.1:5178` 和 Fastify `127.0.0.1:3000` 不能对公网监听；旧 5179 Web 端口不再使用。
- 主机防火墙和云安全组必须只开放 80 / 443。3000、5178、5179 及 PostgreSQL 不得直接暴露公网。

目标公网地址为 `https://187.77.129.207.nip.io`。旧 `http://187.77.129.207:5178` 不是新版回退入口，发布后必须无法从公网访问。

## 2. 代理职责与安全契约

### 2.1 Caddy

仓库候选配置为 `deploy/config-driven-bi-Caddyfile`：

- 自动终止 TLS，并由站点地址处理 80 到 443 的跳转。
- 静态托管生产 `dist`，不存在的前端路径回退到 `index.html`。
- `/api/*` 反向代理到 `127.0.0.1:5178`。
- 覆盖单一 `X-Forwarded-For={remote_host}` 和 `X-Forwarded-Proto=https`，不信任客户端自带转发头。
- 日志过滤 query string，并显式删除 Referer、Cookie、Authorization 与 `X-CSRF-Token` 请求头，避免当前视图状态、会话或安全令牌进入代理日志。
- 设置 CSP、`nosniff`、`SAMEORIGIN`、Referrer Policy、Permissions Policy；HSTS 首次使用 1 天，只有 HTTPS-only、证书续期和回滚验证稳定后才可延长。

### 2.2 Nginx

仓库候选配置为 `deploy/config-driven-bi-nginx.conf`：

- 只监听 `127.0.0.1:5178`，只信任 loopback Caddy。
- 从 Caddy 的单一 XFF 还原真实客户端 IP，再用单一 XFF 和 `X-Forwarded-Proto=https` 转发 Fastify。
- 公网 API 白名单仅包含：
  - `/api/bi/v2/auth/login`
  - `/api/bi/v2/*`
  - `/api/bi/admin/auth/login`
  - `/api/bi/admin/*`
  - `/api/bi/health`
- 其他 `/api/*` 和 Nginx 根路径统一返回 404；因此旧匿名 API 和旧 workspace 读写不能从公网绕过 V2 身份。
- 通用 API 单 IP 速率为 10 请求/秒、burst 30。普通登录和改密另设单 IP 5 请求/分钟、burst 5，并共享全局密码计算限流 12 请求/分钟、burst 2；维护二次登录只使用单 IP 5 请求/分钟、burst 5。
- 限流统一返回 429 JSON：`V2_REQUEST_REJECTED`，包含 `requestId`；请求体上限 64 KiB。应用内 scrypt 再以 1 个执行、2 个排队作最终资源边界，队列满时返回可重试 503 与 `Retry-After: 5`，且不累计密码失败。
- API 响应统一 `Cache-Control: no-store`。访问日志使用 `$uri` 而非带参数的 `$request_uri`，不记录 Referer。

### 2.3 Fastify

- production 必须监听 `127.0.0.1:3000`，否则环境校验直接拒绝启动。
- 只信任 `127.0.0.1` 和 `::1` 代理；不得改成 `trustProxy: true`、任意内网或固定跳数信任。
- production 的全部 `/api/bi/v2/*` 与 `/api/bi/admin/*` 都要求可信代理确认 HTTPS。协议不安全返回 `426 HTTPS_REQUIRED`；客户端 IP 缺失、无效或复合链返回 `503 AUTH_PROXY_MISCONFIGURED` 或维护命名空间对应错误。
- auth 登录、退出、改密和维护写请求还要与 `BI_PUBLIC_ORIGIN` 严格同源。普通退出 / 改密以及全部维护写请求均需当前普通会话 CSRF；缺失、错误或异源失败关闭。
- production 的 `PUT /api/bi/workspace` 即使从服务器本机直连也返回 `410 LEGACY_WORKSPACE_WRITE_DISABLED`。

## 3. 进程与系统权限

仓库只保留 `deploy/config-driven-bi-api.service`：

| 项目 | 当前目标值 |
|---|---|
| 工作目录 | `/opt/config-driven-bi-demo` |
| 运行时 | `/usr/local/bin/bun server/index.ts` |
| 环境 | `.env.local`，同时由 ExecStart 强制 `NODE_ENV=production` |
| 用户 / 组 | `ypbi:ypbi`，禁止 root 运行 |
| 监听 | `127.0.0.1:3000` |
| 可写目录 | 仅 `/opt/config-driven-bi-demo/data` |
| 加固 | `UMask=0077`、`NoNewPrivileges`、`PrivateTmp`、只读系统与 home、内核保护 |

发布前必须确认 `ypbi` 用户 / 组和 `/usr/local/bin/bun` 已存在，并核对该路径最终解析到 `ypbi` 在 `ProtectHome=true` 下仍可执行的位置，不能软链到 `/root` 或其他受保护 home。项目文件与 `dist` 对服务和 Caddy 可读，`data` 对 ypbi 可写。`.env.local` 建议仅 root 与 ypbi 组可读；不得让应用用户拥有 Caddy、Nginx、systemd 配置或代码发布目录的任意写权限。

## 4. 环境变量

实际值只保存在服务器受控环境，下面仅记录名称和作用。

### 4.1 生产启动必需

| 变量 | 规则 |
|---|---|
| `NODE_ENV` | 必须为 `production`；systemd ExecStart 再次强制 |
| `HOST` / `PORT` | 必须为 `127.0.0.1` / `3000` |
| `UPSTREAM_API_BASE_URL` | 主上游 HTTPS 地址 |
| `UPSTREAM_USER_NAME` | 主上游请求用户名；必须与维护页录入的 Token 来自同一上游登录会话 |
| `UPSTREAM_SECONDARY_API_BASE_URL`、`UPSTREAM_SECONDARY_USER_NAME` | 当前平台注册表跨两个后台，生产必须同时配置第二上游 HTTPS 地址与用户名 |
| `UPSTREAM_SECONDARY_PIDS` | 必须与当前平台注册表中的备用后台归属完整一致；启动时校验，防止错站查询 |
| `TOKEN_MAINTENANCE_KEY` | 数据源维护二次密码；生产必填，独立于普通账号密码 |
| `BI_IDENTITY_MODE` | 必须显式为 `local`，启用 YPBI 自有账号 |
| `BI_AUTH_DATABASE_URL` | 独立账号 PostgreSQL URL，敏感；不能与文档、日志或截图共享。不得用 URL query 参数覆盖 `statement_timeout`、`lock_timeout`、`options`、`search_path` 等账号库安全会话配置，否则启动失败 |
| `BI_AUTH_CSRF_SECRET` | 至少 32 字节的独立随机 secret，敏感；不能复用 Token 或维护密码 |
| `BI_PUBLIC_ORIGIN` | 唯一、无路径、无凭据的 HTTPS Origin；用于严格同源校验 |

### 4.2 按能力配置

| 变量 | 规则 |
|---|---|
| `UPSTREAM_X_TOKEN` | 可选的主上游初始 Token，敏感；允许省略并在维护页首次录入，运行时保存值优先 |
| `UPSTREAM_SECONDARY_X_TOKEN` | 可选的第二上游初始 Token，敏感；不能脱离对应地址和用户名单独配置，运行时保存值优先 |
| `UPSTREAM_CREDENTIALS_FILE` | 运行时人工轮换凭据文件，生产放在受保护的 `data` 下 |
| `WORKSPACE_FILE` | 遗留工作区文件；未配置旧 `DATABASE_URL` 时使用 |
| `DATABASE_URL` | 仅供遗留 workspace PostgreSQL；与账号库分离，可不配置 |
| `REQUEST_TIMEOUT_MS` | 上游超时，允许 1～60 秒 |
| `MAX_PLATFORM_CONCURRENCY` | 上游平台并发，允许 1～8 |

不得在仓库、Markdown、截图、浏览器存储、命令历史、工单或普通日志中填写真实数据库连接串、Token、密码、Cookie 或 CSRF secret。发布包必须排除 `.env.local` 和 `data/`。

首次部署由服务器安全配置提供两个上游的 HTTPS 地址、对应用户名、当前平台注册表匹配的 PID 路由及维护二次密码；没有 Token 时应用仍以登录必需、业务数据源未配置的失败关闭状态启动。维护者完成普通登录与维护二次认证后，在页面验证并保存首个 Token。已经通过受控环境预置初始 Token 的部署也可直接启动，后续轮换仍写入受保护的凭据文件。当前静态平台注册表迁移为动态目录后，路由校验应改为读取同一动态权威源，不继续维护固定平台数量。

## 5. 数据与备份

需要独立保护四类运行数据：

1. 自有账号 PostgreSQL：`bi_auth_users`、`bi_auth_sessions` 和 `bi_schema_migrations`。首次发布前创建专用数据库与非超级用户；当前应用会在启动时执行 migration，因此该数据库用户需要对专用 schema 执行当前 DDL 和 DML 的权限。
2. `data/upstream-credentials.json`：上游运行 Token，由 `ypbi` 服务账号持有且权限为 `0600`；备份与发布过程必须保留 owner/group 和权限，发布包不得覆盖。
3. `data/workspace.json` 及 `.backup`：只用于遗留迁移核对；生产写 API 已冻结，但发布仍不得删除。
4. `.env.local`：连接串与 secrets，不进入 Git，不与代码包一起替换。

发布前备份实际生效的 Caddy、Nginx、systemd 配置、当前应用版本、`dist`、`.env.local`、`data/` 和账号数据库。先确认真实安装路径再备份，不能根据仓库文件名猜测 VPS 路径。

账号 migration 使用版本、校验和及有界事务 try-lock：独立单连接维护池最多等待 migration 锁 30 秒，单条语句最多 60 秒、数据库对象锁最多 10 秒，超时会阻止应用完成启动并释放维护池。公网身份运行池与之分离，最多 4 个连接，单条语句 2.5 秒、锁等待 1 秒；业务身份解析与认证端点的会话查询均设置 3 秒请求期限，客户端中断或期限到达时通过 AbortSignal 取消底层 query。当前第 1 版 migration 只做 additive 建表 / 索引。正常应用回滚不删除这些表；只有经过单独确认的数据恢复流程才允许还原数据库快照。

## 6. 首次账号初始化与日常维护

生产切流前至少创建一名可登录的 maintainer，并按实际人员创建 reader / analyst。CLI 必须从项目目录、在真实 TTY 中运行，并在进程环境中安全提供 `BI_AUTH_DATABASE_URL`：

```text
bun server/scripts/manage-bi-user.ts create --username <账号> [--display-name <姓名>] [--role <reader|analyst|maintainer>]
bun server/scripts/manage-bi-user.ts reset-password --username <账号>
bun server/scripts/manage-bi-user.ts disable --username <账号>
bun server/scripts/manage-bi-user.ts enable --username <账号>
bun server/scripts/manage-bi-user.ts set-role --username <账号> --role <reader|analyst|maintainer>
```

create 和 reset-password 会交互读取并二次确认密码，不回显，也不接受命令行、环境变量或管道传入密码。disable 和 enable 要求再次输入完整账号，set-role 要求输入“账号:新角色”；状态与角色命令不接受管道自动确认。五种命令都会先执行缺失 migration。重置，以及实际发生的停用、启用或角色变化，都会升级账号认证版本并撤销全部旧普通会话；重复设置相同状态或角色不做变更，也不踢下线。

初始密码只通过受控渠道交付给对应用户。首次登录必须改密，完成前账号只有改密权限。重新启用会清除登录失败与锁定状态，但保留密码、角色和首次改密状态。当前无自助注册、批量导入和账号列举命令；运维不得直接编辑数据库绕过业务约束。

## 7. 发布流程

### 7.1 发布前

1. 只读核对 VPS 当前端口、进程、Caddyfile、Nginx include、systemd unit、Bun 路径、文件 owner 和 PostgreSQL 连通性，确认当前线上事实。
2. 备份第 5 节列出的实际配置、运行数据和上一版应用；记录可恢复的 release 标识。
3. 在候选代码执行 `npm run typecheck`、`npm run build:server`、`npm run build` 和 `npm test`；涉及浏览器时再执行对应 Playwright。任何因环境缺失未运行的检查必须明确记录，不能视为通过。
4. 验证构建产物为完整 `dist`，部署白名单排除 `.env.local`、`data/`、日志、截图和临时包。
5. 在隔离数据库或可恢复环境实际执行 auth migration，检查版本、校验和、重复运行、30 秒锁等待上限和失败恢复；再以阻塞查询验证 2.5 秒语句超时 / query cancel 后运行连接槽可继续服务，最后备份生产账号库。
6. 校验仓库候选：`caddy validate --config <候选 Caddyfile> --adapter caddyfile`、`nginx -t` 对应的候选 include，以及 systemd unit 语法。

### 7.2 安装与切流

1. 部署代码与 `dist`，保留服务器 `.env.local` 和全部 `data/`。
2. 安装或更新 loopback Nginx、Caddy 和 API systemd unit；删除旧 Web preview unit 前先停止并禁用，确认 5179 不再监听。
3. 设置 `ypbi:ypbi`、目录读写权限和 `.env.local` 权限；确认 production 必需变量齐全，但不输出其值。
4. 使用 CLI 创建首名 maintainer 和所需账号；验证初始密码强制改密。
5. `systemctl daemon-reload` 后启动 / 重启 API，并从服务器本机直连 `127.0.0.1:3000/api/bi/ready`。已有保留凭据或安全预置初始 Token 时，必须确认 workspace、upstream、identity 以及 `upstreamSites.primary、upstreamSites.secondary` 全部为 true 后再继续。无初始 Token 的首次接入只允许 upstream=false 且两个 upstreamSites 为 false，workspace 与 identity 必须为 true，同时 `/health` 正常；此时业务查询保持 503 失败关闭。
6. 安装后的 Caddyfile 再次 validate，安装后的 Nginx 再次 `nginx -t`；先 reload Nginx，再 reload Caddy。无初始 Token 分支只创建并验证首名 maintainer，不向其他用户宣布业务可用；维护者完成普通登录、强制改密和维护二次认证后，在维护页录入并验证 Token。
7. 再次本机请求 `/api/bi/ready`，必须确认 workspace、upstream、identity 及两个 upstreamSites 全部为 true；随后确认云安全组和主机防火墙只对公网开放 80 / 443，并执行完整生产黑盒矩阵。
8. 完整 readiness 与黑盒全部通过后才宣布业务切流完成；否则进入第 8 节回滚，不通过临时放宽匿名 API、Origin、CSRF、代理头或 Cookie 安全属性救火。

## 8. 回滚策略

代码、`dist`、Caddy、Nginx 和 systemd 作为一个 release 回滚，但安全边界不能回滚：

- 恢复上一版代码和配置前先停止接流，完成 `caddy validate`、`nginx -t` 和 API 本机 health / ready 后再恢复流量。
- auth 第 1 版 migration 为 additive；普通应用回滚保留账号表和 migration 记录，不执行 DROP、不修改已执行 migration。旧代码会忽略这些表。
- 不恢复公网旧匿名 `/api/bi/*` 或 workspace PUT。若旧前端依赖这些接口，安全做法是保持维护页 / 停服并前滚修复，而不是重新暴露匿名数据与写入。
- 不自动回滚 `.env.local`、上游 Token、workspace 或账号库到更旧内容；只有确认对应数据本身损坏并取得授权后，才从发布前备份恢复。
- 回滚应用会使内存中的维护二次会话失效，维护者重新认证即可；PostgreSQL 普通会话是否继续有效取决于回滚版本是否支持该会话，不能以恢复匿名模式兜底。
- HSTS 生效后浏览器会继续要求 HTTPS，因此回滚必须维持可用证书和 443，不能回到 HTTP-only。

## 9. 生产黑盒验收门槛

以下检查必须在真实 `Caddy → Nginx → Fastify` 拓扑执行并保存脱敏结果：

| 范围 | 必测项 | 通过标准 |
|---|---|---|
| 端口与 TLS | 从外网扫描 80、443、3000、5178、5179；访问 HTTP 与 HTTPS | 只有 80 / 443 可达；80 跳转 443；证书有效；3000 / 5178 / 5179 均不可达 |
| 静态页面 | 根路径和至少一个 V2 深链直接打开、刷新 | Caddy 返回同版 `dist`；SPA 深链不 404；不出现 Vite preview |
| 公网白名单 | 请求旧 workspace、platforms、analytics 和其他遗留 API | Nginx 统一 404；`/api/bi/health` 可用；`/api/bi/ready` 公网不可用 |
| 首次无 Token 引导 | 本机检查探针并从公网完成 maintainer 登录、强制改密、维护二次认证和首个 Token 验证保存 | 引导前仅允许 `upstream=false`，业务查询 503 且无匿名上游请求；workspace 与 identity 必须为 true；保存后进入完整 readiness |
| readiness | 服务器本机请求 Fastify `/api/bi/ready` | 正式开放业务前 `workspace、upstream、identity、upstreamSites.primary、upstreamSites.secondary` 全为 true；账号库或任一上游不可用时为 503 |
| 身份库超时恢复 | 在隔离账号库制造阻塞身份查询与 migration 锁竞争，再解除阻塞 | 身份请求在有界时间返回 503；底层 query 被取消且连接槽可继续服务；migration 最多等待 30 秒后失败退出，不挂死进程 |
| 普通登录 | 错误密码、正确初始密码、首次改密、刷新和退出 | 错误信息不暴露账号；初始账号只能改密；改密后角色权限恢复；刷新会话恢复；退出后旧会话 401 |
| Cookie / CSRF / Origin | 检查 Set-Cookie；缺失或跨源 Origin；缺失/错误 CSRF | 生产 Cookie 为 `__Host-...; HttpOnly; Secure; SameSite=Strict; Path=/`；非法写请求 403，用户输入不丢失 |
| 会话一致性 | 两端登录后改密或 CLI 重置；API 重启；会话到期 | 改密 / 重置使全部旧普通会话失效；配置和 CSRF secret 不变时，普通数据库会话可在支持该版本的 API 重启后恢复；到期后 401 |
| 角色与 PID | reader、analyst、maintainer 正反用例；读取平台目录 | 服务端按权限拒绝；所有完成改密的角色可读取当次动态返回的全部有效 PID；不按固定数量验收 |
| 维护二次认证 | reader 访问、maintainer 登录、错误锁定、不同账号 / IP / 安全版本复用、普通退出 / 改密 / CLI 账号变更 | 非 maintainer 在密码校验前即 403；二次会话只对同 subjectId + 角色权限 + credential_version + IP 有效；普通安全状态变化后失效，缺安全版本时失败关闭 |
| Token 维护 | 用可轮换测试凭据执行当前测试、候选仅验证、失败保存、成功保存 | 候选失败不覆盖旧值；成功原子生效并脱敏；页面、响应和日志无原始 Token |
| 代理失败关闭 | 在服务器本机绕过正确代理头、伪造复合 XFF / 协议、请求编码与未知安全路径 | V2 / admin 返回稳定 426 / 503 / 4xx，不因未知或编码路径绕过门禁 |
| 限流与密码资源 | 分别触发普通登录 / 改密的单 IP 与共享全局阈值、维护登录单 IP 阈值；绕过代理直接并发 10～20 个错误登录和改密 | 代理 429 使用合法 JSON envelope、`V2_REQUEST_REJECTED` 和 requestId；应用最多 1 个 scrypt 执行、2 个排队，超额 503 且 `Retry-After: 5`，不误累计登录失败；记录峰值 RSS、health 与停止攻击后的恢复 |
| 旧写入双保险 | 从本机直连 Fastify production `PUT /api/bi/workspace` | 返回 `410 LEGACY_WORKSPACE_WRITE_DISABLED`，文件和数据库均未变化 |
| 日志脱敏 | 核对 Caddy、Nginx、API 和 systemd 日志 | 无 query string、Referer、Authorization、密码、连接串、Token、Cookie、CSRF 或筛选敏感明文；错误可凭 requestId 定位 |

至少还要覆盖一个上游超时、一个账号库不可用和一个保存结果未确认的恢复链路。生产黑盒、真实 PostgreSQL migration、真实上游测试凭据和发布后观察未完成前，不得把本地测试标记为已上线。

## 10. 日志、观察与当前限制

- Caddy 结构化访问日志由 `journalctl -u caddy` 查看；query 已过滤，Referer、Cookie、Authorization 与 `X-CSRF-Token` 请求头均显式删除。
- Nginx 日志为 `/var/log/nginx/config-driven-bi-access.log` 与 `/var/log/nginx/config-driven-bi-error.log`；访问日志不含 query 和 Referer。error log 是否会在目标 Nginx 版本及错误级别下包含完整 request line，必须在生产黑盒中用带假 query 的失败请求实测后才可验收。
- API 通过 `journalctl -u config-driven-bi-api` 查看；结构化请求日志只记录方法、无 query 路径、来源地址及白名单业务字段。
- `deploy/visitor-stats.sh` 已明确退役并返回失败；不能继续用 IP 去重当作登录用户数或产品访问人数。
- 当前只有日志和 `/health`、`/ready` 探针，尚无独立指标监控或告警平台。上线观察期需人工核对登录成功 / 拒绝、5xx、延迟、PostgreSQL 连通和上游错误，再决定是否补自动告警。
- 当前通用查询限流按来源 IP 执行，尚无账号级或跨 IP 全局查询配额。V1 小规模内部账号先通过上游延迟、错误率和单账号异常访问日志观察容量；若公网真实用量表明可跨 IP 放大上游压力，再以独立批次增加账号级配额，不在本批预建复杂限流系统。

## 11. 当前部署状态

仓库已经包含自有账号、PostgreSQL migration、生产身份强制、严格 Origin / CSRF、维护二次认证、Caddy 静态托管、loopback Nginx 白名单 / 限流和最小权限 API unit 的候选实现。

这些内容尚未部署：尚未在生产创建或迁移账号库，尚未创建首名 YPBI 账号，尚未替换生产 Caddy / Nginx / systemd，尚未关闭旧公网端口，也尚未完成本页黑盒矩阵。发布前必须先读取 VPS 当前事实、备份并按第 7～9 节执行；旧文档中的历史 active 状态或旧前端资源名不能作为本批部署证据。
