# 部署与运维模块

### 原多平台 BI 代码审核交接（2026-09-16）

个人分支已上传并创建 [PR #1](https://github.com/FD-design/YPBI/pull/1)，目标为 `main`。PR 未合并，服务器未部署；2026-09-16 的审核修改已在同一分支实施，待复审。

- 提交范围为仓库根目录的原多平台 BI，目标基准为 `main`；包含源码、配置模板、测试、必要工程文档及最终接口清单。提交分支为 `review/liyujing-bi-source-20260916`，从 `origin/main`（`2b75e30`）建立独立工作区 `../YPBI-pr-20260916`，按已审查文件清单迁入当前 BI 实现；原分支 `review/liyujing-bi-improvements-20260916`、7 个本地提交和工作区文件保留。
- 本地验证：Bun 1.4.2 下类型检查、服务端构建、发布准入校验通过；`bun run test` 为 777 项通过、0 项失败；contracts 13 项、生成器与离线工具 67 项通过。生产构建及演示资源隔离检查通过，保留 ECharts 分块超过 500 kB 的非阻断提示。V2 浏览器回归分批完成 150 项；失败用例分别定位为日卡演示状态覆盖及旧展示断言，修复后原失败项与受影响相邻项均通过。真实接口模拟响应专项 55 项分批通过：初跑 54 项通过，1024 视口长日期用例停留加载态超过 5 秒；同版本、同阈值、无构建并发下，1280/1024/390 串行 3/3 通过。该次超时未稳定复现，不据此声明性能验收通过。本轮未执行真实账号登录、上游验数或生产黑盒检查。
- 日卡模型修复及新增回归已同步原工作区；旧卡片测试按当前 D−1 / D−7、缺失状态、独立表格与轻量诊断验收，保留日期、数值、颜色、计算依据与导出检查。接口模拟测试改用 PATH 中的 Bun，不依赖私有本地安装路径。
- 验证日志：`/private/tmp/ypbi-pr-final-{typecheck,test,server-build,build}.log`、`/private/tmp/ypbi-pr-release-admission.log`、`/private/tmp/ypbi-pr-clean-{contract,generators,browser}.log`。浏览器初跑 116 项通过后，依次在 `ypbi-pr-retest.log`、`ypbi-pr-remaining-browser.log`、`ypbi-pr-legacy-ui-retest.log`、`ypbi-pr-topics-versions.log`、`ypbi-pr-duration-retest.log` 中完成失败项及中断用例复验；专项记录为 `ypbi-pr-real-adapter-browser.log`、`ypbi-pr-long-range-retest.log`，均位于 `/private/tmp/`。测试使用隔离数据、依赖替身和独立的 5183 预览，不访问真实上游、不读取私有环境文件，原 5173/3000/55432 服务保持运行。
- `FD-design/YPBI` 的写入邀请已接受，已核实当前账号具备 `WRITE` 权限。仓库为公开仓库；本批交付范围为个人分支和以 main 为基准的 PR，不包含审核合并或服务器部署。
- 提交版界面证据：[核心卡片](../review-assets/20260916/core-overview.png)、[版本分布](../review-assets/20260916/version-distribution.png)。两张均为自有 BI 的隔离演示截图，不包含真实账号或生产数据。其他测试截图保留本地。
- 安全复核覆盖原 7 个提交的 243 个前后文件版本，以及当前 59 个已跟踪改动和 343 个未跟踪候选；未发现真实凭证、私钥或含密码连接串。按用户确认的 BI 工程范围，干净提交历史不包含 `product-demos/` 的 15 个第三方导出样例，也不包含竞品评审文件的本地改动。`outputs/` 仅纳入最终接口清单，其余 26 个旧版、预览和检查快照保留本地。提交版 PRD 移除外部样例下载入口，导出产品规则保留；独立 NewAV、私有环境文件、运行数据及凭据不纳入。
- 普通构建与`verify:release`只校验仓库内已提交的固定指标、事件和功能投影及其内容哈希、发布准入证明，不再依赖仓库外文档。维护权威源时仍分别执行`metrics:source:check`与`catalogs:source:check`，防止把“可复现构建”误作“可绕过权威源更新”。
- production 日看板使用`BI_DAILY_DASHBOARD_QUERY_ENABLED`，标准启动链创建真实上游读取服务并保留身份、PID、HTTPS和响应校验；旧`BI_LOCAL_DASHBOARD_READING_ENABLED`只用于loopback本地兼容。核心总览已有标准编排器，但当前9项正式映射、验数证据与可信水位仍未准入，不能开启为可用业务结果。
- 指定 Bun 1.4.2 的统一`verify:release`通过：包含仓库内投影、准入、核心总览、类型检查、前后端生产构建及781项完整测试；无失败项。

### 本地后端启动恢复（2026-09-15）

- 恢复前，前端 `5173` 和独立账号库 `55432` 正常监听，后端 `3000` 无监听；前端登录会话代理返回 500。本次表现为后端进程未运行，与 9 月 12 日进程存活但查库超时的情况不同，退出原因尚未确认。
- 按用户授权在项目目录运行 `data/local-runtime/node_modules/.bin/bun --env-file=.env.backend-local --watch server/index.ts`，使用现有 Bun 1.4.2 及私有配置，仅监听 `127.0.0.1:3000`。前端及数据库未重启，未更改账号、Token、配置或业务代码。
- 验证：后端 `/api/bi/health` 返回 200，前端 `/dashboards/public` 返回 200，前端代理 `/api/bi/v2/auth/session` 在无凭据请求下返回预期 401，均在 60ms 内响应。未代替用户执行真实账号登录或逐项指标验数。
- 本次恢复运行，未新增系统自启动或进程自动恢复机制，未部署生产。

> 当前状态（2026-09-12）：独立本地后端与账号库已启动，真实登录和维护流程可用，两站Token已由用户保存，日汇总20平台只读抽查通过。生产HTTPS入口、代理白名单和systemd配置尚未发布；本地可用不代表线上部署或指标验数通过。

### 本地登录超时运行恢复（2026-09-12）

- 旧本地 `3000` 进程为 PID `55216`、Bun `1.4.2`。健康检查、匿名会话和空请求体 POST 均在毫秒级返回；使用合成且格式合法的、不存在的测试会话值时，账号库查询超过 5 秒，既有 3 秒请求期限未能按时返回。
- 同期独立 PostgreSQL `select 1` 为 64ms，目标账号未锁定且无登录失败记录；现有证据不支持把问题归因于数据库整体不可用、进程休眠或特定客户端库缺陷。
- 恢复操作只重启本地 `3000` 后端，`55432` 账号库和 `5173` 前端均未重启。新进程为 PID `6840`，Bun 仍为 `1.4.2`；重启后无效会话查询 39ms 返回 401，现有账号真实登录 439ms 返回 200，平台目录返回 200，PH 真实日看板读取成功。
- 当前结论仅为旧运行实例的认证查库或请求期限执行异常，底层触发原因尚未确定；重启恢复不等于永久根治。本次未改代码、权限、数据库、Token、页面布局或产品规则，生产仍未部署。日常入口使用 `/dashboards/public`，带 `design` 参数的路径仅用于开发评审。
- Chrome 实际登录后 20 个平台均可选择；从 PH 切换至 TikTok 并应用后读取对应平台真实日值，刷新浏览器后账号会话、TikTok 与日期均保留，真实值继续可读。最终健康检查 200 为 3.5ms，查库会话 401 为 5.1ms。Bun `1.4.2` 下认证插件、数据库和 HTTP 响应生命周期 21 项定向测试共 95 次断言通过，覆盖超时取消与中文响应生命周期；本次无前后端代码修改，因此未重复执行类型检查和完整构建。

### 独立本地联调（2026-09-12）

- 2026-09-13 按用户授权重置独立维护密码，只更新本地私有配置中的校验值并重启 3000 后端。普通账号、权限、账号库、前端和两站 Token 未变；重启清除旧维护会话。密码与校验值不记录在文档，维护鉴权回归及前后端健康检查通过。
- 已启用本地`BI_LOCAL_DASHBOARD_READING_ENABLED=true`，已登录看板复用原版式读取部分真实日数据；正式M016/核心总览门禁未放宽。关闭该开关并重启本地后端即可回退为不可读取，不影响账号库、Token或线上旧BI。开关默认false，production及非loopback监听均拒绝true；DEV页面不进入生产构建，正式provider具备后退役该联调路径。
- 旧代理目标的新版会话接口返回404。本地`.env.local`现只负责把Vite5173代理到本机Fastify3000；后端配置独立保存在忽略的`.env.backend-local`，不读取线上旧BI配置。
- PostgreSQL17.10仅监听127.0.0.1:55432，独立集群位于`data/local-services/postgres`，使用SCRAM和非超级应用账号，现有账号migration已执行；未启用默认5432集群或系统自启动。Homebrew安装缺失的版本资源路径已通过两个精确符号链接补齐，无既有数据库被覆盖。
- 本地维护账号已按用户指定完成登录名与密码设置，账号、密码和密钥不写入文档。真实阅读者账号验证登录→改密→维护二次认证→两站表单→刷新；停用/重新启用撤销旧会话。运行目录0700、私有配置0600，测试账号测试后停用。
- 两站按用户提供地址取HTTPS origin并配置各自请求用户名；服务端使用`x-token`/`name`认证。用户已在维护页保存凭据，20平台日汇总真实抽查通过，检查过程不输出凭据或用户明细。readiness仍按当次探针结果返回，不代表指标已准入。
- 本地启动：先`bun server/scripts/local-services.ts start`，再`bun --env-file=.env.backend-local --watch server/index.ts`；前端沿用`npm run dev`。首次建立账号才使用`provision`，已有账号不会覆盖。关闭时停止本地后端，再执行`bun server/scripts/local-services.ts stop`，保留全部隔离数据。运行前按`.bun-version`选择已安装本地Bun。
- 集成回归使用`node tools/run-local-connection-test.mjs`，在终端无回显输入维护密码；脚本只允许独立55432账号库，密码不进入命令参数和日志。生产部署、对象迁移和正式查询开关均未改变；后端重启使维护二次会话失效，普通账号库保留。

### 本地自动回归运行时

`.bun-version` 固定当前本地验证版本，不自动升级生产运行时。当前项目隔离安装位于忽略目录 `data/local-runtime/node_modules/.bin`；无需修改系统 PATH、生产依赖或服务器配置即可执行：

```sh
PATH="$PWD/data/local-runtime/node_modules/.bin:$PATH" npm run verify:release
```

目录模型与开发路由的TypeScript测试统一使用项目Bun运行时，覆盖路由引用的全部模型；生成器测试继续使用Node。首次初始化执行`provision`并保存返回的一次性登录信息，日常`start`只启动已初始化的隔离账号库。

Bun 1.3.14 在本机的 Fastify 注入测试中存在中文响应结束状态兼容问题：返回拒绝响应后仍可能进入后续处理。最小复现与 [Bun 上游问题 #25632](https://github.com/oven-sh/bun/issues/25632) 一致；本机 1.4.2 已通过该反例。`server/http/response-lifecycle.test.ts` 固定检查拒绝后仅响应一次、后续处理零调用及结束状态。维护 Cookie 测试按 Cookie 名定位，兼容 HTTP 允许的单值与多值响应头，不修改实际 Cookie 或授权规则。生产发布前仍须验证目标主机运行时与真实网络链路，不能把注入测试通过当作部署通过。

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
| `BI_DAILY_DASHBOARD_QUERY_ENABLED` | production 日看板候选读取开关，只接受明确 `true` 或 `false`，默认 `false`；开启后仍必须通过登录、PID、HTTPS代理和上游响应校验 |
| `BI_LOCAL_DASHBOARD_READING_ENABLED` | 旧本地联调兼容开关；只允许非生产环境监听`127.0.0.1`时开启，新部署不使用 |
| `BI_V2_CORE_OVERVIEW_QUERY_ENABLED` | 核心经营总览首屏批量查询开关，只接受明确 `true` 或 `false`，默认 `false`。标准启动链已提供编排器；只有9项首屏指标及范围均具备当前映射、passed验数、正式provider与可信完整日水位后才能开放，否则查询返回`METRIC_NOT_READY` |

不得在仓库、Markdown、截图、浏览器存储、命令历史、工单或普通日志中填写真实数据库连接串、Token、密码、Cookie 或 CSRF secret。发布包必须排除 `.env.local` 和 `data/`。

首次部署由服务器安全配置提供两个上游的 HTTPS 地址、对应用户名及维护二次密码；平台、PID、启用状态和站点归属读取随版本发布的 `server/platforms/platform-catalog.v1.json`，不再配置 PID 环境变量。没有 Token 时应用仍以登录必需、业务数据源未配置的失败关闭状态启动。维护者完成普通登录与维护二次认证后，在页面验证并保存首个 Token。已经通过受控环境预置初始 Token 的部署也可直接启动，后续轮换仍写入受保护的凭据文件。修改平台目录须先校验稳定 ID、PID、顺序和站点归属，随版本发布并重启；当前 20 项不是固定产品上限，未来可由同一 Provider 接入正式上游目录。

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

### 内测迭代与本次交接

当前提交只进入个人分支与 PR，审核合并、服务器部署和业务开放分别执行。服务器配置模板、账号初始化、验证与回退步骤沿用本模块；服务器现状未核实前不执行安装、迁移或切流。

内测阶段建议采用“本地修改和验证 → PR 审核 → 发布固定版本 → 线上检查”，先维护一个供内部使用的线上环境。页面样式走相关页面回归；登录、权限、接口、指标口径与数据库改动完成对应安全或数据检查。需要多人提前验收或执行数据迁移时，再增加隔离测试环境；测试账号库和凭据与线上分开。不直接在服务器改源码，不跳过登录、HTTPS、数据缺失标记和版本回退。

| 交接项 | 当前情况 | 下一步与负责方 |
|---|---|---|
| BI 工程与最终接口清单 | 当前源文件已整理为个人分支，原项目和本地资料保留 | 执行代理完成测试、上传与 PR；负责人审核合并 |
| 构建权威源 | 校验依赖同级指标体系、埋点主文档及观察版 | 项目同事经既有协作渠道向构建环境提供，执行代理核对版本与生成结果 |
| 访问地址与部署目标 | 文档只有候选地址和目录，未核实目标主机现状 | 用户或部署负责人确认域名、服务器及授权的连接方式；不通过聊天提交密码 |
| 首批账号与数据范围 | 自有账号与服务端权限代码已具备，生产账号尚未创建 | 用户确认名单、角色和可访问平台；部署负责人在受控环境初始化并验证 |
| 服务器、数据库与 HTTPS | 仓库已含配置模板，未安装到目标主机 | 获得目标信息和授权后执行只读预检，再按本节备份、部署与回退步骤处理 |
| 真实取数上线 | 部分已接数据仅在本地受控读取；正式映射、水位和验数未全部就绪 | 数据负责人补齐正式能力；执行代理按获批范围接入和验证，保持生产准入限制 |
| 凭据 | 不随代码或交接文档传递 | 维护者在目标受控环境或维护页录入，执行代理只检查配置存在和连通结果 |
| 上线验收 | 本地回归与线上验收分开记录 | 执行代理完成技术检查；用户抽查登录、平台范围及核心指标，全部通过后公布内部入口 |

轻量流程参考 [GitHub flow](https://docs.github.com/en/get-started/using-github/github-flow)；合并与部署的区别见 [GitHub 部署说明](https://docs.github.com/en/pull-requests/concepts/deploying-code)。上述内测环境安排为建议，实际目标与访问范围待负责人确认。

### 7.1 发布前

1. 只读核对 VPS 当前端口、进程、Caddyfile、Nginx include、systemd unit、Bun 路径、文件 owner 和 PostgreSQL 连通性，确认当前线上事实。
2. 备份第 5 节列出的实际配置、运行数据和上一版应用；记录可恢复的 release 标识。
3. 在同时具备 YPBI 仓库与相邻权威《全站指标体系》源文件的候选工作区执行 `npm run verify:release`；它按当前脚本依次运行指标定义生成器测试、M016 离线验数工具测试、运行时发布准入测试、`validation:check`、类型检查、服务端构建、生产前端构建以及最后的完整 `npm test` / Bun 套件。`validation:check` 必须只读复核指标快照与 `server/v2/generated/metric-release-attestation.json`，服务启动还会再次核对证明固定的注册表、平台目录及所有结果态证据 / 比较产物，任一漂移都失败关闭。权威 Markdown 已变化而目录快照未更新时直接失败。涉及浏览器时再执行对应 Playwright。任何因权威源或运行环境缺失而未执行的检查必须明确记录，不能跳过或视为通过。
4. 验证构建产物为完整 `dist`，部署白名单排除 `.env.local`、`data/`、日志、截图和临时包。
5. 在隔离数据库或可恢复环境实际执行 auth migration，检查版本、校验和、重复运行、30 秒锁等待上限和失败恢复；再以阻塞查询验证 2.5 秒语句超时 / query cancel 后运行连接槽可继续服务，最后备份生产账号库。
6. 校验仓库候选：`caddy validate --config <候选 Caddyfile> --adapter caddyfile`、`nginx -t` 对应的候选 include，以及 systemd unit 语法。
7. M016 正式切流前另外核对可信数据水位：V2 公共契约已兼容 `watermark=null | 结构化对象`，内置服务端和浏览器已同步校验。当前生产 source 仍只返回 `null`，可信来源登记表也保持为空；必须先确认上游业务 API 的精确水位字段，或接入完成状态 API（上游或服务端加工），并按 `metricId + sourceKind + sourceApiId` 完整登记，再完成 Adapter 测试、M016 验数、默认日期能力和生产黑盒。上线顺序固定为“并集契约与消费端 → 水位来源登记及 Adapter → 验数与开放”；回滚先停止对象输出并恢复 `null`，正式查询安全返回 422，保留并集契约，不迁移数据库，也不得临时改用昨日或最大返回日期。
8. 核心经营总览开关保持 `false`，直到真实批量执行器、9 项首屏结果、默认筛选、至少一个下层诊断 / 明细区域及可追溯整板导出全部通过验收。首次启用前在候选环境验证正式整体与多 PID、部分失败、真实 0、无记录、未成熟、不等长对比、客户端中断、上游超时及畸形响应失败关闭；再将开关改为 `true` 并重启。未满足门槛时只允许继续使用开发样板，不把开关当作数据准入替代品。

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
- 核心经营总览出现批量执行器、数据准入或页面回归问题时，先把 `BI_V2_CORE_OVERVIEW_QUERY_ENABLED` 恢复为 `false` 并重启 API；路由安全返回 503，数据库、旧查询接口和其他页面不变。不得为维持九张卡而切回 Mock、旧聚合或本地跨 PID 合计。
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
