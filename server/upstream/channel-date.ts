/** 旧渠道接口使用北京时间字符串，结束边界为所选末日的次日零点。 */
export function legacyChannelDateParams(dateRange: [string, string]) {
  const endExclusive = new Date(Date.parse(`${dateRange[1]}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return {
    sumDateBegin: `${dateRange[0]} 00:00:00`,
    sumDateEnd: `${endExclusive} 00:00:00`
  };
}
