const INTERNAL_METRIC_REFERENCE_PATTERN = /\b(?:DM|M)\d{3}\b/gi;
const INTERNAL_DOCUMENT_REFERENCE_PATTERN = /\bMD-\d+\b|\b01[AB]\b/gi;

// 技术协议词的业务释义；公式、指标关系与数值仍取自指标权威源。
const BUSINESS_TERMS: Record<string, string> = {
  "video_play_result.result_status=success": "视频首帧成功展示",
  "launch_result.result_status=success": "成功到达首个可操作业务页面",
  "recharge_credit_status_change.credit_status=success": "充值已成功到账",
  "author_interaction_result.action_id=follow_author": "关注作者操作生效",
  "effective_play_flag=true 且 effective_play_rule_version=effective_play_v1": "按当前有效观看规则完成至少一次观看",
  "session_effective_play_seq>=2": "完成至少两次有效观看",
  "play_trigger_type=user_click": "由用户主动点击触发的播放",
  "effective_play_flag=true": "达到有效观看标准的",
  "watch_duration_ms>=15000": "实际前台观看时长至少 15 秒",
  "0<video_duration_ms<15000": "视频时长大于 0 且不足 15 秒",
  "watch_end_reason=completed": "视频完整播放结束",
  "result_status=success": "结果成功",
  "video_watch_stay.watch_duration_ms": "实际前台观看时长",
  "video_play_start.event_id": "播放尝试标识",
  "first_frame_duration_ms": "首帧展示耗时",
  "watch_duration_ms": "实际前台观看时长",
  "video_duration_ms": "视频时长",
  "watch_end_reason": "播放结束原因",
  "effective_play_rule_version": "有效观看规则版本",
  "search_query_submit": "搜索提交记录",
  "search_query_result": "搜索结果记录",
  "search_id": "搜索标识",
  "video_play_start": "播放尝试",
  "video_play_result": "播放结果",
  "video_watch_stay": "观看时长记录",
  "video_content_click": "视频内容点击",
  "video_content_expose": "视频内容曝光",
  "video_interaction_result": "视频互动结果",
  "video_channel_tab_click": "视频分类切换",
  "ad_expose": "广告曝光",
  "ad_click": "广告点击",
  "ad_close_click": "广告关闭点击",
  "ad_load_result": "广告加载结果",
  "ad_display_end": "广告展示结束",
  "content_paywall_expose": "内容付费墙曝光",
  "content_paywall_action_click": "内容付费墙操作",
  "recharge_request_id": "支付提交标识",
  "recharge_submit_click": "支付提交记录",
  "recharge_page_view": "充值页访问",
  "recharge_credit_status_change": "充值到账状态",
  "payment_callback_process_result": "支付回调处理结果",
  "order_create_request_result": "下单请求结果",
  "launch_result": "启动结果",
  "app_launch": "应用启动",
  "launch_id": "启动标识",
  "launch_type": "启动类型",
  "page_load_result": "页面加载结果",
  "page_view": "页面访问",
  "landing_page_action_click": "落地页操作",
  "bottom_navigation_tab_click": "底部导航切换",
  "community_post_expose": "社区帖子曝光",
  "community_post_click": "社区帖子点击",
  "community_comment_submit": "社区评论提交",
  "author_interaction_result": "作者互动结果",
  "membership_upsell_expose": "会员引导曝光",
  "membership_upsell_click": "会员引导点击",
  "checkin_entry_expose": "签到入口曝光",
  "checkin_entry_click": "签到入口点击",
  "checkin_submit": "签到提交",
  "checkin_result": "签到结果",
  "task_action_click": "任务操作",
  "task_reward_result": "任务奖励结果",
  "benefit_claim_submit": "福利领取提交",
  "share_invite_bind_submit": "邀请绑定提交",
  "share_invite_bind_result": "邀请绑定结果",
  "share_invite_reward_result": "邀请奖励结果",
  "source_event_id": "来源记录标识",
  "event_id": "记录标识",
  "operation_id": "操作标识",
  "device_id": "设备标识",
  "user_id": "用户标识",
  "uid": "用户账号",
  "ip_hash": "匿名化 IP 标识",
  "Cohort": "同批用户",
  "Tab": "分类标签"
};
const TERM_PATTERN = new RegExp("(?<![a-zA-Z0-9_])(?:" + Object.keys(BUSINESS_TERMS).sort((a, b) => b.length - a.length).map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")(?![a-zA-Z0-9_])", "g");
export const BUSINESS_EXPLANATION_PENDING = "业务说明待补充，请联系指标维护者核对。";

export function containsTechnicalExpression(value: string) {
  return /\b[a-z][a-z0-9]*_[a-z0-9_]+\b|\b(?:COUNT|DISTINCT|SELECT|WHERE)\b|=\s*(?:true|false|success)|\bD\d+\b/i.test(value);
}

function businessTerms(value: string) {
  const translated = value.replace(TERM_PATTERN, (term) => BUSINESS_TERMS[term])
    .replace(/COUNT\(DISTINCT ([^)]+)\)/g, "按$1去重后的次数")
    .replace(/D(\d+)/g, (_, day: string) => Number(day) === 0 ? "首日" : Number(day) === 1 ? "次日" : `第 ${day} 天`)
    .replace(/已产生终态/g, "已上报最终结果")
    .replace(/成熟窗口内/g, "结果等待窗口已结束的");
  return containsTechnicalExpression(translated) ? BUSINESS_EXPLANATION_PENDING : translated;
}

type MetricExplanationSource = {
  name: string;
  authority: { registeredFormula: string; recommendedDefinition?: string | null; definition: string };
};

export function metricBusinessExplanation(metric: MetricExplanationSource, names: ReadonlyMap<string, string>) {
  const description = formatMetricAuthorityText(metric.authority.recommendedDefinition || metric.authority.definition, names);
  let formula = formatMetricAuthorityText(metric.authority.registeredFormula, names);
  if (/率|分布/.test(metric.name) && formula.includes("÷") && !formula.includes("100%")) formula += " × 100%";
  // 当前规则版本的释义覆盖首帧门槛、短视频例外与统一规则版本。
  const effectiveRule = metric.authority.registeredFormula.includes("effective_play_flag=true") && (!metric.authority.registeredFormula.includes("effective_play_rule_version=") || metric.authority.registeredFormula.includes("effective_play_rule_version=effective_play_v1"))
    ? "有效观看：首帧成功展示，且实际前台观看至少 15 秒；不足 15 秒的视频（时长大于 0）须完整播放。仅统计同一有效观看规则下的记录。" : "";
  const calculation = [`${formula.includes("÷") ? "公式" : "统计方式"}：${formula}`, effectiveRule].filter(Boolean).join("\n");
  return { description, formula, calculation, text: [formula.includes("÷") ? description : "", calculation].filter(Boolean).join("\n") };
}

function normalizeReplacementSpacing(value: string) {
  return value
    .replace(/\s{2,}/g, " ")
    .replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, "$1")
    .trim();
}

/**
 * 指标编号是目录、查询和路由的内部稳定键；产品界面只展示业务名称。
 * 权威定义中若引用其他指标，则在展示出口解析为名称，不改写上游权威文本。
 */
export function formatMetricAuthorityText(value: string | null | undefined, metricNames: ReadonlyMap<string, string>) {
  if (!value) return "";
  const withMetricNames = value.replace(INTERNAL_METRIC_REFERENCE_PATTERN, (reference, offset: number, source: string) => {
    const metricName = metricNames.get(reference) ?? metricNames.get(reference.toUpperCase());
    if (!metricName) return "相关指标";
    const following = source.slice(offset + reference.length).trimStart();
    return following.startsWith(metricName) ? "" : metricName;
  });
  return normalizeReplacementSpacing(businessTerms(withMetricNames.replace(INTERNAL_DOCUMENT_REFERENCE_PATTERN, "相关能力")));
}

/** 防止服务端错误或告警文案把内部指标、文档编号透传到用户界面。 */
export function hideInternalReferenceCodes(value: string | null | undefined) {
  if (!value) return "";
  return normalizeReplacementSpacing(value
    .replace(INTERNAL_METRIC_REFERENCE_PATTERN, "相关指标")
    .replace(INTERNAL_DOCUMENT_REFERENCE_PATTERN, "相关能力"));
}

export function containsInternalReferenceCode(value: string) {
  INTERNAL_METRIC_REFERENCE_PATTERN.lastIndex = 0;
  INTERNAL_DOCUMENT_REFERENCE_PATTERN.lastIndex = 0;
  return INTERNAL_METRIC_REFERENCE_PATTERN.test(value) || INTERNAL_DOCUMENT_REFERENCE_PATTERN.test(value);
}
