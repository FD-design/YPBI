# 配置驱动 BI 项目索引

> 本文件是所有修改的第一阅读入口。最后更新：2026-09-08。

## 项目概况

- 本地目录：`/Users/liyujing/claude code test/YPBI`
- VPS 目录：`/opt/config-driven-bi-demo`
- 目标公网地址：`https://187.77.129.207.nip.io`（候选域名，尚未部署；正式入口必须使用 HTTPS 并先登录，不提供匿名 BI）
- 技术栈：React 19、TypeScript、Vite、ECharts、Fastify、PostgreSQL、Bun
- GitHub 仓库：`https://github.com/FD-design/YPBI`
- 数据原则：正式看板只显示真实 API 数据；无数据和接口错误不使用 Mock 冒充。
- 当前代码注册表在本次核对时包含 20 个有效平台；支持全部汇总、单平台、最多 8 个平台作为独立对比系列。目标产品不写死平台数量，平台目录和查询范围动态返回，并完整保留当次可获取的全部有效平台。

## 阅读顺序

1. 本索引
2. 产品需求实现或验收任务先读 [需求文档索引](./requirements/README.md)及其链接的具体需求
3. UI/交互任务先读 [UI 已确认问题与防回归规则](./UI-已确认问题与防回归规则.md)
4. 本次涉及的模块文档
5. [变更时间线](./CHANGELOG.md)

## 模块索引

| 模块 | 当前功能 | 主要代码 | 详细文档 | 当前状态 | 最后修改 |
|---|---|---|---|---|---|
| 看板与前端工作区 | production 只加载 V2 Product Shell；已开放自有账号登录 / 强制改密 / 退出、指标中心、M016 单 PID 日趋势和受保护的数据源维护，其余目标路径只显示未开放状态；经典版只保留开发迁移核对 | `src/main.tsx`、`src/legacyApp.tsx`、`src/v2`、`src/theme`、`src/components` | [前端模块](./modules/frontend.md)、[UI 防回归规则](./UI-已确认问题与防回归规则.md) | 本地代码完成；V2 系统 Chrome 28/28，仍待真实 PostgreSQL 身份联调、M016 验数和生产部署黑盒 | 2026-09-08：完成 V1 自有账号与生产前端门禁 |
| 卡片与模板配置 | 遗留经典版曾提供分析卡片创建与管理、模板编辑、发布、排序和宽度调整；仅用于迁移核对，不代表目标产品能力 | `src/legacyApp.tsx`、`contracts/card.ts` | [前端模块](./modules/frontend.md) | 遗留本地可用；公网 V2 不开放，待按总 PRD 迁移后退役 | 2026-09-08：明确遗留能力边界 |
| 分析引擎 | V2 以独立 M016 source / query service 保留真实 0、无记录、空值、部分数据与未知水位；旧聚合、阶段量、固定 PID 和高级图表仅作迁移事实 | `server/v2`、`src/v2`、`src/analytics`、`server/analytics` | [分析模块](./modules/analytics.md) | V2 的 M016 单 PID 日序列本地代码完成但待真实验数；遗留分析不代表目标 V1 准入 | 2026-09-08：完成 V2 M016 本地切片与状态回归 |
| BI 后端 API | 自有账号、服务端会话、CSRF、三档角色和统一动态 `pidScope=all` 已接入受保护的 `/api/bi/v2`；身份查询与 migration 均有数据库侧有界超时；production 固定监听 `127.0.0.1:3000`，管理 API 采用普通维护者身份与独立维护密码双层保护；遗留 workspace 写入冻结 | `server/app.ts`、`contracts/bi-auth.ts`、`contracts/bi-v2.ts`、`server/auth`、`server/identity`、`server/v2` | [后端 API](./modules/backend-api.md) | 本地实现完成并失败关闭；真实 PostgreSQL 超时释放 / migration、三档角色、Cookie / Origin / 限流 / 503、生产日志、M016 验数、Bun 套件和公网黑盒未完成 | 2026-09-08：收口 V1 身份数据库超时与维护 CSRF |
| 上游接口接入 | 30 个后台接口登记、双后台按 PID 路由、Token 安全热更新、Adapter 归一化、超时与错误映射 | `server/upstream` | [数据与平台](./modules/data-platform.md) | 2026-07-21 曾完成 30 接口复验；不代表当前凭证或全量数据健康，待逐站重新验证 | 2026-09-08：补并发凭证写入安全与当前状态边界 |
| 平台注册表 | 20 个 HX 平台与 PID 映射 | `server/platforms/registry.ts` | [数据与平台](./modules/data-platform.md) | 可用 | 2026-07-15：正式平台表确认 |
| 工作区持久化 | 遗留经典版模板和卡片资产可保存到 PostgreSQL 或磁盘；目标 V2 尚未实现 Owner、revision 和对象级写入 | `server/persistence` | [后端 API](./modules/backend-api.md) | 遗留本地可用，仅迁移核对；公网 V2 写入已冻结，待新模型迁移后退役 | 2026-09-08：明确遗留保存不可作为 V1 正式能力 |
| 部署与运行 | Caddy 作为唯一公网 80/443 入口并直接提供生产 `dist`，loopback Nginx 执行 API 白名单与限流，Fastify 仅监听 `127.0.0.1:3000`，systemd 使用专用最小权限账号 | `deploy`、`package.json` | [部署运维](./modules/deployment.md) | 仓库候选配置完成；当前 VPS 尚未按新拓扑部署，Caddy / Nginx / systemd 语法和真实公网黑盒待在目标主机验证 | 2026-09-08：形成公网 HTTPS、限流与遗留 API 隔离候选配置 |
| 产品需求治理 | 用一份总 PRD 维护产品架构、看板、指标速览、分析、数据中心和全局规则；用一份调整方案维护当前实现差异、真实 API 能力、架构风险与迁移事项 | `docs/requirements` | [需求入口](./requirements/README.md)、[产品需求文档](./requirements/BI-产品需求文档.md)、[现有平台调整方案](./requirements/BI-现有平台调整方案.md) | 总 PRD 1.69、调整方案 1.69；自有账号、全部动态 PID、人工 Token 维护和公网安全边界均已固化并形成本地候选实现；真实数据库、M016 验数、动态路由状态、Bun 测试和生产部署验证未完成 | 2026-09-08：同步身份、人工凭据与公网边界安全收口 |
| 文档治理与版本管理 | 长期工程规则覆盖权威源、影响面、模块边界、高风险确认、迁移可靠性、可观测性、分级验证与交付；UI 任务额外读取已确认问题清单 | `AGENTS.md`、`.gitignore`、`docs` | 本文件、[现有平台调整方案](./requirements/BI-现有平台调整方案.md)、[UI 防回归规则](./UI-已确认问题与防回归规则.md)、[部署运维](./modules/deployment.md) | 强制执行；不为单个功能重复建文档 | 2026-09-08：长期工程规则与架构风险纳入完成门槛 |

## 当前代码分析模型（现状，不代表目标产品分类）

下表记录现有代码能力。内容、搜索、支付、获客等对象在目标架构中属于业务主题或数据能力模型，不再作为“事件分析、漏斗分析”等分析类型的同层分类。

| 模型 ID | 中文名称 | 核心能力 | 多平台 |
|---|---|---|---|
| `business_overview` | 经营总览 | DAU、新增、端别结构、来源、广告、观影与付费 | 汇总/单平台/对比 |
| `platform_compare` | 平台对比 | 平台排行、趋势、散点对比 | 最多 8 平台 |
| `content_position` | 视频内容表现 | 视频排行、内容表、消费阶段量对比（非用户级真实漏斗） | 汇总/单平台/对比 |
| `search_demand` | 热搜词分析 | 搜索词排行和表格 | 汇总/单平台/对比 |
| `payment_conversion` | 支付汇总分析 | VIP 点击到支付成功阶段量对比（非用户级真实漏斗）；新增付费、ARPU、ARPPU | 汇总/单平台/对比 |
| `member_operation` | 会员收入概览 | 收入、付费、新增付费质量；会员存量和档位字段待接口 | 受限 |
| `retention_quality` | 留存质量 | 新增及 D1/D3/D7/D30 留存 Cohort | 汇总/单平台/对比 |
| `usage_depth` | 使用深度 | DAU、观影率、人均观影时长 | 汇总/单平台/对比 |
| `acquisition_conversion` | 获客转化 | 访问、下载、新增注册及三段加权转化 | 汇总/单平台/对比 |
| `custom_table` | 自定义统计表 | 同接口组合端别、来源、广告、观看和付费指标 | 汇总/单平台/对比 |

## 已知待处理

| 内部 ID | 真实接口 | 文档模块 | 状态 |
|---|---|---|---|
| `category.first` | `/api/admin/serverCfg/categories/getManyFirst` | 配置字典 | 已通过生产调用；必须传业务 `type`，无匹配分类时返回空数组 |
| `channel.byType` | `/api/admin/statistics/channel/channelStatByType` | 渠道统计/渠道管理 | 已通过生产调用；支持 `pid/channel` 和四种合作类型 |
| `overview.byRole` | `/api/admin/home/getAllByRole` | 首页/总览 | 已通过生产调用，不再返回上游 500 |

## 上线前风险

- 目标业务对象的 Owner、`revision` 和个人保存尚未实现；production 已冻结旧 `/api/bi/workspace` 写入，公网代理也必须阻断全部遗留 API，不能把旧整包工作区作为正式保存能力。
- 新公网拓扑、自有账号数据库和首个维护者尚未部署；正式开放前必须只暴露 80/443，并在真实反代下验证登录、首次改密、退出、角色、全部动态 PID、Cookie / Origin / CSRF、429、503 和可信客户端 IP。
- `src/legacyApp.tsx` 和 `src/styles.css` 体积较大；目标功能已从轻量 `src/main.tsx` 分流到 `src/v2`，后续只随迁移切片继续拆分旧实现。
- 已建立 Product Shell 与认证的 Playwright E2E；本地受控 fixture 不替代真实数据库、真实 API、权限正反例和生产浏览器回归。

## 时间线入口

完整记录见 [CHANGELOG.md](./CHANGELOG.md)。任何后续修改必须追加记录，并同步本索引对应模块的最后修改日期。
