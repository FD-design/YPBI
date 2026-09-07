# 配置驱动 BI 项目索引

> 本文件是所有修改的第一阅读入口。最后更新：2026-09-08。

## 项目概况

- 本地目录：`D:\CodexArtifacts\config-driven-bi-demo`
- VPS 目录：`/opt/config-driven-bi-demo`
- 访问地址：`http://187.77.129.207:5178`
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
| 看板与前端工作区 | 看板中心、分析中心、模板管理、数据字典、数据源维护及全部弹层统一使用 UI v1.5 稳定骨架；共享整合式 YPBI 字标、自定义业务选择器、单层任务表面、全屏 Portal 层级和稳定响应式 Shell | `src/main.tsx`、`src/app`、`src/theme`、`src/components`、`src/features` | [前端模块](./modules/frontend.md)、[UI 防回归规则](./UI-已确认问题与防回归规则.md) | 1280/1024/390px 页面、筛选、分类、弹层、sticky 和无位移回归通过 | 2026-08-28：全平台视觉与交互完整收口 |
| 卡片与模板配置 | 分析卡片创建与管理；独立模板编辑模式；卡片级平台范围；最多 16 项指标；完整预览、保存、发布、排序和宽度调整 | `src/main.tsx`、`contracts/card.ts` | [前端模块](./modules/frontend.md) | 可用 | 2026-07-27：补充卡片编辑返回入口 |
| 分析引擎 | 指标校验、查询编排、跨接口关联、日均/累计/加权计算、五分钟实时走势、查询状态事件、失败保留上次结果、短时有界缓存、图表转换、固定阶段量对比、留存、排行、趋势、热力、瀑布、贡献矩形和汇总桑基；尚无用户级真实漏斗 | `src/analytics`、`server/analytics` | [分析模块](./modules/analytics.md) | 现有聚合能力可用，真实漏斗待建设 | 2026-09-03：纠正阶段量与真实漏斗边界 |
| BI 后端 API | 查询、校验、就绪探测、下钻、渠道、内容、专项、元数据、工作区存储 | `server/app.ts`、`contracts` | [后端 API](./modules/backend-api.md) | 可用 | 2026-07-22：就绪探测与数据源参数保护 |
| 上游接口接入 | 30 个后台接口登记、双后台按 PID 路由、Token 安全热更新、Adapter 归一化、超时与错误映射 | `server/upstream` | [数据与平台](./modules/data-platform.md) | 30 个有效参数调用通过 | 2026-07-22：视频表现切换真实排行接口 |
| 平台注册表 | 20 个 HX 平台与 PID 映射 | `server/platforms/registry.ts` | [数据与平台](./modules/data-platform.md) | 可用 | 2026-07-15：正式平台表确认 |
| 工作区持久化 | 模板和卡片资产保存到 PostgreSQL；无数据库时使用磁盘文件并保留上一版本备份 | `server/persistence` | [后端 API](./modules/backend-api.md) | 可用 | 2026-07-23：修复服务重启后模板丢失 |
| 部署与运行 | systemd 管理 API/Web，Nginx 普通入口、Caddy HTTPS 管理入口、安全响应头与访问统计 | `deploy`、`package.json` | [部署运维](./modules/deployment.md) | VPS 运行中 | 2026-07-23：配置页安全登录与HTTP自动跳转 |
| 产品需求治理 | 用一份总 PRD 维护产品架构、看板、指标速览、分析、数据中心和全局规则；用一份调整方案维护当前实现差异、真实 API 能力与迁移事项 | `docs/requirements` | [需求入口](./requirements/README.md)、[产品需求文档](./requirements/BI-产品需求文档.md)、[现有平台调整方案](./requirements/BI-现有平台调整方案.md) | 总 PRD 1.63、调整方案 1.59；V1 产品架构与页面行为均已确认，官方看板只引用维护范围来源，个人来源加入时生成独立维护副本。实施采用同仓分层迁移：复用技术与真实数据接入底座，重做产品领域层；来源删除治理后置。最终分类映射、指标权威项及身份权限源按数据准入和实施依赖核对 | 2026-09-08：确认官方看板来源归属 |
| 文档治理与版本管理 | 修改前读索引，UI 任务额外读取已确认问题清单；修改后同步模块、问题护栏和时间线 | `AGENTS.md`、`.gitignore`、`docs` | 本文件、[UI 防回归规则](./UI-已确认问题与防回归规则.md)、[部署运维](./modules/deployment.md) | 强制执行 | 2026-08-28：UI 问题记录纳入项目完成门槛 |

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

- `/api/bi/workspace` 的读写尚未接入身份、对象归属、服务端权限和 `revision` 并发条件，公网访问者理论上可以读取或覆盖同一份工作区配置。
- 当前公网入口只有 HTTP，尚未配置 HTTPS。
- `src/main.tsx` 和 `src/styles.css` 体积较大，后续功能开发应按工作区逐步拆分。
- 已建立工作区 Shell 的 Playwright E2E；真实 API 成功态、权限矩阵和生产浏览器回归仍需在部署环境持续补齐。

## 时间线入口

完整记录见 [CHANGELOG.md](./CHANGELOG.md)。任何后续修改必须追加记录，并同步本索引对应模块的最后修改日期。
