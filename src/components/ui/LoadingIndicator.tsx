import "./loading-indicator.css";

/** 装饰性等待反馈，状态名称由所属区域提供，不表达完成百分比。 */
export function LoadingIndicator() {
  return <svg className="ui-loading-indicator" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" opacity=".16" />
    <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="18 57" strokeLinecap="round" />
  </svg>;
}
