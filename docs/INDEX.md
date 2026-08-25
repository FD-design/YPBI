# 配置驱动 BI 项目索引

> 本文件是所有修改的第一阅读入口。最后更新：2026-08-25。

## 项目概况

- 本地目录：`D:\CodexArtifacts\config-driven-bi-demo`
- VPS 目录：`/opt/config-driven-bi-demo`
- 访问地址：`http://187.77.129.207:5178`
- 技术栈：React 19、TypeScript、Vite、ECharts、Fastify、PostgreSQL、Bun
- GitHub 仓库：`https://github.com/FD-design/YPBI`
- 数据原则：正式看板只显示真实 API 数据；无数据和接口错误不使用 Mock 冒充。
- 平台原则：20 个有效平台；支持全部汇总、单平台、最多 8 个平台对比。

## 阅读顺序

1. 本索引
2. 本次涉及的模块文档
3. [变更时间线](./CHANGELOG.md)

## 模块索引

| 模块 | 当前功能 | 主要代码 | 详细文档 | 当前状态 | 最后修改 |
|---|---|---|---|---|---|
| 看板与前端工作区 | 看板中心、分析中心、模板管理、数据字典；统一多平台与自然月/等长/同期进度双周期筛选、指标级字段说明和真实数据图表 | `src/main.tsx`、`src/styles.css` | [前端模块](./modules/frontend.md) | 可用 | 2026-08-03：新增三种周期对比模式 |
| 卡片与模板配置 | 分析卡片创建与管理；独立模板编辑模式；卡片级平台范围；最多 16 项指标；完整预览、保存、发布、排序和宽度调整 | `src/main.tsx`、`contracts/card.ts` | [前端模块](./modules/frontend.md) | 可用 | 2026-07-27：补充卡片编辑返回入口 |
| 分析引擎 | 指标校验、查询编排、跨接口关联、日均/累计/加权计算、五分钟实时走势、查询状态事件、失败保留上次结果、短时有界缓存、图表转换、漏斗、留存、排行、趋势、热力、瀑布、贡献矩形和汇总桑基 | `src/analytics`、`server/analytics` | [分析模块](./modules/analytics.md) | 可用 | 2026-08-03：修复日 UV 跨天聚合并新增累计人天 |
| BI 后端 API | 查询、校验、就绪探测、下钻、渠道、内容、专项、元数据、工作区存储 | `server/app.ts`、`contracts` | [后端 API](./modules/backend-api.md) | 可用 | 2026-07-22：就绪探测与数据源参数保护 |
| 上游接口接入 | 30 个后台接口登记、双后台按 PID 路由、Token 安全热更新、Adapter 归一化、超时与错误映射 | `server/upstream` | [数据与平台](./modules/data-platform.md) | 30 个有效参数调用通过 | 2026-07-22：视频表现切换真实排行接口 |
| 平台注册表 | 20 个 HX 平台与 PID 映射 | `server/platforms/registry.ts` | [数据与平台](./modules/data-platform.md) | 可用 | 2026-07-15：正式平台表确认 |
| 独立产品 BI 平台 | 独立产品注册、数据源、卡片库、模板中心和看板；首个产品 NewAV，与原 PID/双 Token 数据源完全隔离 | `new-platform/src`、`new-platform/server` | [独立平台架构](./new-platform/architecture.md)、[NewAV API 清单](./new-platform/newav0-api-inventory.md) | 基础应用完成，等待生产 Token 复验 | 2026-08-25：完成独立应用与 12 个接口 Adapter |
| 工作区持久化 | 模板和卡片资产保存到 PostgreSQL；无数据库时使用磁盘文件并保留上一版本备份 | `server/persistence` | [后端 API](./modules/backend-api.md) | 可用 | 2026-07-23：修复服务重启后模板丢失 |
| 部署与运行 | systemd 管理 API/Web，Nginx 普通入口、Caddy HTTPS 管理入口、安全响应头与访问统计 | `deploy`、`package.json` | [部署运维](./modules/deployment.md) | VPS 运行中 | 2026-07-23：配置页安全登录与HTTP自动跳转 |
| 文档治理与版本管理 | 修改前读索引，修改后更新模块和时间线；源码通过 Git/GitHub 管理，运行密钥和生成产物不入库 | `AGENTS.md`、`.gitignore`、`docs` | 本文件、[部署运维](./modules/deployment.md) | 强制执行 | 2026-08-17：初始化 GitHub 仓库 |

## 当前分析模型

| 模型 ID | 中文名称 | 核心能力 | 多平台 |
|---|---|---|---|
| `business_overview` | 经营总览 | DAU、新增、端别结构、来源、广告、观影与付费 | 汇总/单平台/对比 |
| `platform_compare` | 平台对比 | 平台排行、趋势、散点对比 | 最多 8 平台 |
| `content_position` | 视频内容表现 | 视频排行、内容表、消费汇总漏斗 | 汇总/单平台/对比 |
| `search_demand` | 热搜词分析 | 搜索词排行和表格 | 汇总/单平台/对比 |
| `payment_conversion` | 支付汇总分析 | VIP 点击到支付成功汇总漏斗；新增付费、ARPU、ARPPU | 汇总/单平台/对比 |
| `member_operation` | 会员收入概览 | 收入、付费、新增付费质量；会员存量和档位字段待接口 | 受限 |
| `retention_quality` | 留存质量 | 新增及 D1/D3/D7/D30 留存 Cohort | 汇总/单平台/对比 |
| `usage_depth` | 使用深度 | DAU、观影率、人均观影时长 | 汇总/单平台/对比 |
| `acquisition_conversion` | 获客转化 | 访问、下载、新增注册及三段加权转化 | 汇总/单平台/对比 |
| `custom_table` | 自定义统计表 | 同接口组合端别、来源、广告、观看和付费指标 | 汇总/单平台/对比 |

## 已知待处理

- NewAV 已确认使用 Bearer Token；仍需配置有效 Token，复验 12 个接口原始响应、金额单位和服务端时区，详见 [NewAV API 清单](./new-platform/newav0-api-inventory.md)。

| 内部 ID | 真实接口 | 文档模块 | 状态 |
|---|---|---|---|
| `category.first` | `/api/admin/serverCfg/categories/getManyFirst` | 配置字典 | 已通过生产调用；必须传业务 `type`，无匹配分类时返回空数组 |
| `channel.byType` | `/api/admin/statistics/channel/channelStatByType` | 渠道统计/渠道管理 | 已通过生产调用；支持 `pid/channel` 和四种合作类型 |
| `overview.byRole` | `/api/admin/home/getAllByRole` | 首页/总览 | 已通过生产调用，不再返回上游 500 |

## 上线前风险

- `/api/bi/workspace` 的写入接口尚未接入认证，公网访问者理论上可以修改模板和卡片配置。
- 当前公网入口只有 HTTP，尚未配置 HTTPS。
- `src/main.tsx` 和 `src/styles.css` 体积较大，后续功能开发应按工作区逐步拆分。
- 当前有单元、集成和本轮浏览器回归，但尚未建立可持续运行的 Playwright E2E 测试文件。

## 时间线入口

完整记录见 [CHANGELOG.md](./CHANGELOG.md)。任何后续修改必须追加记录，并同步本索引对应模块的最后修改日期。
