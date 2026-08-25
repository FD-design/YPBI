# NewAV API 接口清单

> 采集日期：2026-08-25。来源：Codex 内置浏览器已登录页面、前端脚本 `index-CMOB1MaT.js` 与渠道日报渲染结果。本文不记录 Token、Cookie 或登录密码。

## 基本信息

- 后台地址：`https://newav0.com`
- API 前缀：`/api/v1`
- 管理接口前缀：`/api/v1/admin`
- 鉴权：前端请求携带 `Authorization`；具体令牌格式和刷新机制尚未通过原始请求头复验。
- 当前分支：`feature/new-platform`

## 统计接口

| 内部建议 ID | 方法 | 路径 | 参数 | 页面/用途 | 验证状态 |
|---|---|---|---|---|---|
| `newav.overview` | GET | `/admin/analytics/overview` | 无 | 数据看板总览 | 前端定义确认 |
| `newav.operations` | GET | `/admin/analytics/operations` | `date` | 单日运营数据 | 前端定义确认 |
| `newav.intraday` | GET | `/admin/analytics/intraday` | `date` | 日内时段趋势 | 前端定义确认 |
| `newav.period` | GET | `/admin/analytics/period` | `from`、`to` | 周期数据，前端超时 120 秒 | 前端定义确认 |
| `newav.daily` | GET | `/admin/analytics/daily` | `date` | 单日汇总 | 前端定义确认 |
| `newav.pvTrend` | GET | `/admin/analytics/pv-trend` | `days`，默认 30 | PV 趋势 | 前端定义确认 |
| `newav.aggregate` | POST | `/admin/analytics/aggregate` | Query：`date` | 聚合统计 | 前端定义确认 |
| `newav.regSources` | GET | `/admin/analytics/reg-sources` | `from`、`to` | 注册来源 | 前端定义确认 |
| `newav.renewal` | GET | `/admin/analytics/renewal` | `days`、`grace`；页面默认 90、7 | 续费分析 | 前端定义确认 |
| `newav.adStats` | GET | `/admin/analytics/ad-stats` | 筛选对象，字段待原始请求复验 | 广告点击统计 | 前端定义确认 |
| `newav.channelsDaily` | GET | `/admin/analytics/channels-daily` | `from`、`to`、可选 `code` | 渠道每日数据 | 页面数据已验证 |
| `newav.channelsMetrics` | GET | `/admin/analytics/channels-metrics` | `from`、`to` | 渠道质量统计 | 前端定义确认 |

所有表中路径均相对于 `/api/v1`。

## 渠道每日数据

`channels-daily` 按“渠道 × 自然日”返回 `totals` 和 `rows`。页面支持日期区间和单渠道筛选。

| 字段 | 中文指标 | 周期展示 | 口径说明 |
|---|---|---|---|
| `date` | 统计日期 | 维度 | 北京时间自然日待接口复验 |
| `code` | 渠道号 | 维度 | 渠道唯一编码 |
| `name` | 渠道名称 | 维度 | 渠道显示名称 |
| `visitors` | 访客数 | 累计 | 页面定义为当天渠道访客 |
| `registNew` | 新增用户 | 累计 | 当天注册用户 |
| `active` | 活跃用户 | 累计人天 | 当天该渠道用户有访问 |
| `activeNew` | 新用户活跃 | 累计人天 | 当天注册且当天活跃 |
| `activeOld` | 老用户回访 | 累计人天 | 活跃且非当天注册 |
| `viewers` | 观影人数 | 累计人天 | 当天发生观影的用户 |
| `viewersNew` | 新观影 | 累计人天 | 当天新增用户中的观影用户 |
| `ipTotal` | 访问 IP | 累计 | 页面展示为访问 IP 次数，需复验是否可重复 |
| `ipUniq` | 独立 IP | 累计人天 | 页面按日去重，跨日不可当周期去重用户 |
| `adClick` | 广告点击 | 累计 | 广告点击次数 |
| `rechargeNew` | 新增充值 | 累计金额 | 页面以人民币元展示 |
| `vipBuyers` | VIP 购买 | 累计 | VIP 购买人数/次数需原始响应复验 |
| `convRate` | 注册转化 | 加权比例 | `sum(registNew) / sum(visitors)`，不能平均每日百分比 |

页面实测查询区间为 `2026-08-19` 至 `2026-08-25`，能够返回多渠道逐日数据和周期合计。

## 渠道质量指标

`channels-metrics` 使用 `from`、`to` 查询，返回 `rows`、`defaultHost` 和 `config`。已从前端确认以下字段：

| 字段 | 中文指标 | 算法/说明 |
|---|---|---|
| `visits` | 访问次数 | 页面说明按 IP 计算，具体重复规则待复验 |
| `visitors` / `ipUniq` | 访问人数 | 独立 IP 去重 |
| `register` | 注册人数 | 周期注册人数 |
| `regRate` | 转化率 | `register / visitors` |
| `pcUv`、`androidUv`、`iosUv`、`otherUv` | 设备分布 | 独立 IP 按 UA 分类 |
| `validLogin` | 有效登录 | 观看至少 1 部视频的登录用户 |
| `oldLogin` | 老用户登录 | 非当日注册的登录用户 |
| `cardBuy` | 会员卡购买 | 在线支付购买 VIP 的人数 |
| `cardExchange` | 会员卡兑换 | 积分兑换 VIP 的人数 |
| `recharge` | 总充值金额 | 周期累计金额 |
| `adUsers` | 广告点击人数 | 按人去重 |
| `adClicks` | 广告点击次数 | 全部广告累计点击，不排重 |
| `playOk` | 播放成功次数 | 播放器真实出画面次数 |
| `playErr` | 播放错误次数 | 播放报错或加载失败次数 |
| `retentionD1` | 次留 | 次日回访人数 / 注册人数 |
| `retentionD3` | 3 留 | 第 3 日回访人数 / 注册人数 |
| `retentionD7` | 7 留 | 第 7 日回访人数 / 注册人数 |

## 接入边界

- 当前已确认路径、方法、前端参数及页面展示字段，尚未取得原始 JSON 响应体和请求头样本。
- 接入前仍需复验 `Authorization` 格式、登录/刷新接口、错误码、分页结构、金额单位和服务器时区。
- DAU、活跃、观看等日 UV 跨日期默认按“日均”展示；需要累计规模时使用“累计人天”，不得描述为周期去重人数。
- 比例统一使用 `sum(分子) / sum(分母)`；自然月比较允许天数不同，累计值比较需同时显示周期天数。
- 新平台接口不得加入原平台 PID 注册表或复用原平台双 Token 路由，应建立独立数据源配置和 Adapter。
