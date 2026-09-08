# 部署与运维模块

## 源码仓库

- GitHub：`https://github.com/FD-design/YPBI`
- 仓库保存源码、测试、接口契约、部署脚本和项目文档。
- `.env.local`、运行时 Token、维护密码、`data/` 工作区、日志、部署压缩包和 QA 截图不进入仓库。
- VPS 发布必须继续保留生产 `.env.local`、`data/upstream-credentials.json` 和 `data/workspace.json`，不得用仓库内容覆盖。

## 环境

- VPS：`187.77.129.207`
- 项目目录：`/opt/config-driven-bi-demo`
- Web：`http://187.77.129.207:5178`
- HTTPS 管理入口：`https://187.77.129.207.nip.io`；Caddy 在 443 终止 TLS 并自动续签证书，域名 HTTP 入口如启用只用于自动跳转 HTTPS；`/api/*` 直连 `127.0.0.1:3000`，其余页面直连 `127.0.0.1:5179`。仓库目标配置为 `deploy/config-driven-bi-Caddyfile`。
- 公网 `5178` 由 Nginx 接入并记录真实访问 IP，再转发至仅监听本机 `127.0.0.1:5179` 的 Vite preview。
- API 与 Web 同源；Nginx 将 `/api/` 直接转发至 `127.0.0.1:3000`，不再绕经 Vite。Caddy 不得转发到 Nginx `:5178`，否则内层 HTTP 会把 HTTPS 协议覆盖为 `http`，管理接口将正确失败关闭。

## systemd 服务

| 服务 | 功能 |
|---|---|
| `config-driven-bi-api` | 以 `NODE_ENV=production` 运行 Bun/Fastify API；模板通过命令行环境覆盖 `.env.local` 中可能残留的开发值 |
| `config-driven-bi-web` | Vite preview 托管生产 `dist` |

## 访问统计

- Nginx 访问日志：`/var/log/nginx/config-driven-bi-access.log`
- Nginx 错误日志：`/var/log/nginx/config-driven-bi-error.log`
- Caddy HTTPS 访问日志：目标配置启用结构化 access log，由 `journalctl -u caddy` 查看；不得假设它会写入 Nginx 日志。
- 汇总命令：`/opt/config-driven-bi-demo/deploy/visitor-stats.sh`
- 统计口径：根页面 `GET /` 请求数作为页面打开次数；去重来源 IP 作为访问人数的近似值。
- 当前汇总脚本只统计 Nginx `:5178` 入口，不包含 Caddy HTTPS 入口；Nginx 文件日志按日轮转并保留 30 天。跨入口统一访问统计属于后续运维治理，不得把当前脚本结果解释成全站人数。
- IP 去重不等于精确用户数：同一网络下多人可能共用 IP，同一用户切换网络也可能产生多个 IP。

## 环境变量

- `UPSTREAM_API_BASE_URL`
- `UPSTREAM_X_TOKEN`
- `UPSTREAM_USER_NAME`
- `UPSTREAM_SECONDARY_API_BASE_URL`
- `UPSTREAM_SECONDARY_X_TOKEN`
- `UPSTREAM_SECONDARY_USER_NAME`
- `UPSTREAM_SECONDARY_PIDS`
- `UPSTREAM_CREDENTIALS_FILE`
- `WORKSPACE_FILE`：无 PostgreSQL 时的工作区持久化文件，生产默认 `/opt/config-driven-bi-demo/data/workspace.json`；文件 Store 是当前已确认的生产兼容模式，不强制为了 production 引入 PostgreSQL
- `TOKEN_MAINTENANCE_KEY`
- `DATABASE_URL`
- `REQUEST_TIMEOUT_MS`
- `MAX_PLATFORM_CONCURRENCY`

不得在文档、提交、截图或日志中写入实际密钥值。

## 反向代理安全契约

- API 的 production 监听地址固定为 `127.0.0.1:3000`，与两个目标代理 upstream 一致；地址或端口不一致时服务端拒绝启动。Caddy HTTPS 与 Nginx 遗留 HTTP 分别直连本机 API / Web，不形成双层代理。
- Fastify 只信任 `127.0.0.1`、`::1` 代理。不得改为 `trustProxy: true`、信任所有内网地址或按固定跳数信任。
- Caddy 对上游覆盖单一 `X-Forwarded-For={remote_host}` 和 `X-Forwarded-Proto=https`；Nginx 覆盖单一 `X-Forwarded-For=$remote_addr` 和 `X-Forwarded-Proto=$scheme`，不继承公网请求自带的伪造转发链。
- 生产 `/api/bi/admin/*` 对缺失协议头、非 `https`、复合协议值及非可信来源伪造均返回 `426`；对缺失、无效或复合 `X-Forwarded-For` 返回 `503 MAINTENANCE_PROXY_MISCONFIGURED`，避免错误代理配置把全部维护者合并成同一个本机 IP。开发和测试环境保留本机 HTTP 调试。
- 启用真实来源 IP 后，维护会话仍绑定用户 IP；网络出口变化会要求重新登录，这是安全取舍，不做前端绕过。

## 前端维护 Token

- 上游暂不支持 Token 自动申请或刷新；V1 由授权维护者在失效或轮换时人工更新，普通查询无需重复输入。
- 一级导航“数据源维护”提供站1和站2两个 Token 更新栏、当前连接测试和验证并保存；服务端已支持候选 Token 非保存验证，当前经典版 UI 尚待补对应入口。
- 页面先校验 `TOKEN_MAINTENANCE_KEY`；验证成功后由服务端签发 30 分钟维护会话 Cookie，使用 `HttpOnly`、`Secure`、`SameSite=Strict` 且限定 `/api/bi/admin` 路径，浏览器脚本与存储不保存维护密码或会话值。
- 运行时 Token 写入 `UPSTREAM_CREDENTIALS_FILE`，生产路径为 `/opt/config-driven-bi-demo/data/upstream-credentials.json`，权限 `0600`，该文件不参与代码部署。
- 维护密码的 VPS 本机备份为 `/root/bi-maintenance-password.txt`，权限 `0600`；只通过受控渠道交给维护人员。
- 站1使用 `PH`、站2使用 `FBI` 调用 `pDaySum` 验证；成功后才覆盖旧 Token。

## 上游网络

- Bun `fetch` 不遵循 Node 的 `setDefaultResultOrder("ipv4first")`，仅设置 DNS 顺序仍可能走未授权 IPv6。
- VPS `/etc/hosts` 在 `config-driven-bi upstream` 标记区固定两个上游域名的 IPv4，以确保命中后台白名单；修改前的备份为 `/etc/hosts.bi-backup-20260721-2340`。
- Cloudflare IPv4 发生变化时，重新通过 `getent ahostsv4 <域名>` 获取地址，更新标记区并回归 `/api/bi/sources/overview.daySum/query`。

## 发布检查

1. `bun test`
2. `bun run typecheck`
3. `bun run build`
4. 涉及响应式关键流程时运行 `bun run test:e2e`
5. 部署时保留 VPS 上的 `.env.local`、凭证文件和工作区文件；确认 production 的 `HOST=127.0.0.1`、`PORT=3000`
6. 先只读执行 `systemctl cat caddy`、`systemctl cat config-driven-bi-api`、`systemctl cat config-driven-bi-web` 和 `nginx -T`，确定各服务实际读取的配置路径；备份实际配置与数据，不根据文件名猜测安装位置
7. 先对仓库候选执行 `caddy validate --config /opt/config-driven-bi-demo/deploy/config-driven-bi-Caddyfile --adapter caddyfile`；再把 Caddy、Nginx 和 systemd 候选安装到第 6 步确认的实际路径，并对安装后的 Caddyfile 再次 `caddy validate`、对安装后的 Nginx 配置执行 `nginx -t`
8. 执行 `systemctl daemon-reload`，先重启 API/Web，再 reload Caddy/Nginx；检查服务均为 `active`。任一检查失败，恢复第 6 步备份并再次校验，不降级安全门禁
9. 黑盒验证 HTTPS 管理请求正常；`http://<IP>:5178` 的管理 API 返回 426，域名 HTTP 如开放则只重定向 HTTPS；后端直连的缺协议头、缺客户端 IP、编码路径和伪造头均拒绝；同一来源会话有效、不同来源会话拒绝且登录锁定互不误伤
10. 使用可轮换测试凭证验证候选仅检测、失败保旧和成功生效；不得用生产 Token 写入测试或日志
11. 验证核心页面、普通 API、Caddy/Nginx 两类访问日志和回退入口后，更新模块文档、索引和时间线

## 当前性能

- 上游相同 GET 请求支持并发合并。
- 成功响应内存缓存 60 秒。
- 2026-07-22 实测首屏 DOM 约 765ms，经营总览全部真实卡片冷加载约 8.1 秒；实际时间受 20 平台上游接口影响。

## 最近发布

- 2026-07-23：修复无 PostgreSQL 时模板随 API 重启丢失，增加磁盘持久化、原子写入、上一版本备份和浏览器本地合并恢复。

- 2026-07-22：发布运营日报扩展指标、四组经营卡片及 `pDaySum` 字段归一化修复。
- 2026-07-22：发布真实聚合图表能力、模型级服务端校验和卡片资产迁移修复。
- 发布后 API、Web、Nginx 均为 `active`，`/api/bi/ready` 的工作区和上游依赖均通过。
- 当前生产前端资源：`assets/index-DDsviq_x.js`。

## 公网入口保护

- Nginx 的 HTTP `:5178` 入口对 `/api/` 按来源 IP 限制为每秒 10 个请求，突发上限 30；Caddy HTTPS 入口不继承该 Nginx 限流。数据源登录另有服务端连续失败锁定，其他 HTTPS API 的统一限流后续随正式身份/网关建设补齐。
- Nginx 和目标 Caddy 配置均将 API 响应覆盖为 `Cache-Control: no-store`；管理命名空间还由 Fastify 自身设置同一响应头。
- 页面和 API 均设置 CSP、`X-Content-Type-Options: nosniff`、`X-Frame-Options: SAMEORIGIN` 和 Referrer Policy。
- 生产就绪检查使用 `/api/bi/ready`，同时验证工作区存储和上游读取。

## 上线前风险

- 已为数据源维护建立 HTTPS 管理入口；原 IP:5178 普通访问尚未强制跳转 HTTPS。
- 原 IP:5178 地址仍为 HTTP，只用于普通看板访问；Token 维护接口会返回 `426 HTTPS_REQUIRED`。维护人员必须使用 HTTPS 管理入口。
- 仓库已固定可信 loopback 代理、生产 HTTPS 失败关闭、production 启动方式和 Caddy/Nginx 目标配置，但本批尚未部署；上线前仍须将 VPS 实际 Caddyfile 与仓库模板逐项对照并完成上述黑盒矩阵。
- 本次代理收紧不迁移 Token 或工作区数据；API 重启会清除最长 30 分钟的内存维护会话，维护者重新登录即可。若上线后 HTTPS 被误判，应优先恢复 Caddy 直连和转发头，不得以恢复“缺头放行”作为长期回滚。
- 工作区 PUT 接口尚未接入认证，正式开放前必须增加登录校验或至少限制可信网络。
- 已建立本地浏览器 E2E，但尚未接入 CI 或生产发布流水线自动执行。

## 2026-07-22 Token 运维记录

- 站1与站2 Token 已在 VPS 环境文件中更新，未写入代码、文档或前端资源。
- 更新时创建的旧凭证临时备份已在验证成功后删除，VPS 不额外保留过期 Token 副本。
- 更新后 `/api/bi/ready` 返回 `200 ready`，主数据源 `PH` 与备用数据源 `TJD` 单平台查询通过。
- 20 平台经营查询返回 20 个平台、0 个失败、0 条告警；内容排行请求无平台失败，当前有 7 个平台返回排行记录。

## 2026-07-23 维护密码更新

- 维护密码已重新生成并以 `sha256:<hex>` 形式写入 VPS 环境配置，未在代码和文档中保存明文。
- API 重启后，正确密码登录、鉴权状态读取和错误密码拒绝均验证通过。
## 2026-07-23 配置页密码鉴权

- 普通 HTTP 看板保留“数据源维护”入口，点击后自动跳转同一系统的 HTTPS 配置页，不再要求维护人员手动查找管理地址。
- HTTPS 配置页通过独立维护密码登录；密码仅用于登录请求，后续操作使用30分钟服务端会话。
- 会话 Cookie 设置 `HttpOnly`、`Secure`、`SameSite=Strict`，路径限制为 `/api/bi/admin`，退出后立即失效。
- 连续输错5次锁定当前 IP 15分钟；服务重启会清空全部维护会话。
- `TOKEN_MAINTENANCE_KEY` 支持 `sha256:<hex>` 密码哈希，正式密码不写入前端、项目代码、文档或日志。
- Token 保存前仍会调用真实后台验证；失败时保留当前有效 Token。
# 2026-07-27 部署排除规则修正

- 部署包使用文件白名单，顶层 `data/` 不加入归档，不再使用会误排除 `src/data/` 的宽泛 `--exclude=data`。
- `.env.local`、VPS Token 凭证和 `/opt/config-driven-bi-demo/data/workspace.json` 继续保留，不随代码部署覆盖。
