# 部署与运维模块

## 源码仓库

- GitHub：`https://github.com/FD-design/YPBI`
- 仓库保存源码、测试、接口契约、部署脚本和项目文档。
- `.env.local`、运行时 Token、维护密码、`data/` 工作区、日志、部署压缩包和 QA 截图不进入仓库。
- VPS 发布必须继续保留生产 `.env.local`、`data/upstream-credentials.json` 和 `data/workspace.json`，不得用仓库内容覆盖。

## 环境

### NewAV 独立 BI

- 公网入口：`https://newav-bi.187.77.129.207.nip.io`
- 部署目录：`/opt/newav-bi`
- API：`newav-bi-api.service`，仅监听 `127.0.0.1:3200`
- Web：由 Caddy 直接读取 `/opt/newav-bi/dist`，不占用原 BI 的 `3000`、`5179` 服务。
- 运行凭证：`/opt/newav-bi/.env.local`，权限 `0600`，不进入部署包和 Git。
- 工作区：`/opt/newav-bi/data/newav-workspace-v4.json`，后续发布不得覆盖 `data/`。
- 首次部署：2026-08-26。线上页面与 API 验证通过；Caddy、NewAV API 和原 BI 两项服务均为 `active`。

- VPS：`187.77.129.207`
- 项目目录：`/opt/config-driven-bi-demo`
- Web：`http://187.77.129.207:5178`
- HTTPS 管理入口：`https://187.77.129.207.nip.io`；Caddy 仅监听 443 并自动续签证书，反向代理现有 API 和 Web 服务。
- 公网 `5178` 由 Nginx 接入并记录真实访问 IP，再转发至仅监听本机 `127.0.0.1:5179` 的 Vite preview。
- API 与 Web 同源；Nginx 将 `/api/` 直接转发至 `127.0.0.1:3000`，不再绕经 Vite。

## systemd 服务

| 服务 | 功能 |
|---|---|
| `config-driven-bi-api` | Bun 运行 Fastify API |
| `config-driven-bi-web` | Vite preview 托管生产 `dist` |

## 访问统计

- Nginx 访问日志：`/var/log/nginx/config-driven-bi-access.log`
- Nginx 错误日志：`/var/log/nginx/config-driven-bi-error.log`
- 汇总命令：`/opt/config-driven-bi-demo/deploy/visitor-stats.sh`
- 统计口径：根页面 `GET /` 请求数作为页面打开次数；去重来源 IP 作为访问人数的近似值。
- 日志按日轮转并保留 30 天；统计只能从 Nginx 接入启用后开始，历史访问人数无法从原 Vite 日志补回。
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
- `WORKSPACE_FILE`：无 PostgreSQL 时的工作区持久化文件，生产默认 `/opt/config-driven-bi-demo/data/workspace.json`
- `TOKEN_MAINTENANCE_KEY`
- `DATABASE_URL`
- `REQUEST_TIMEOUT_MS`
- `MAX_PLATFORM_CONCURRENCY`

不得在文档、提交、截图或日志中写入实际密钥值。

## 前端维护 Token

- 一级导航“数据源维护”提供站1和站2两个 Token 更新栏。
- 页面先校验 `TOKEN_MAINTENANCE_KEY`；维护密码只保存在当前标签页 `sessionStorage`，退出或关闭标签页后清除。
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
5. 部署时保留 VPS 上的 `.env.local`
6. 重启两个 systemd 服务和 Nginx
7. 检查服务状态为 `active`
8. 使用公网地址验证核心页面、API、访问日志和失败请求
9. 更新模块文档、索引和时间线

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

- `/api/` 按来源 IP 限制为每秒 10 个请求，突发上限 30。
- API 响应设置 `Cache-Control: no-store`。
- 页面和 API 均设置 CSP、`X-Content-Type-Options: nosniff`、`X-Frame-Options: SAMEORIGIN` 和 Referrer Policy。
- 生产就绪检查使用 `/api/bi/ready`，同时验证工作区存储和上游读取。

## 上线前风险

- 已为数据源维护建立 HTTPS 管理入口；原 IP:5178 普通访问尚未强制跳转 HTTPS。
- 原 IP:5178 地址仍为 HTTP，只用于普通看板访问；Token 维护接口会返回 `426 HTTPS_REQUIRED`。维护人员必须使用 HTTPS 管理入口。
- 工作区 PUT 接口尚未接入认证，正式开放前必须增加登录校验或至少限制可信网络。
- 尚未建立持续执行的浏览器 E2E 测试套件。

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
