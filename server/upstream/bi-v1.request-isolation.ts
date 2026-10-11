import { UpstreamError } from "./client";

const metricCodes = String.raw`M\d{3}(?:\s*[,，、]\s*M\d{3})*`;
const selectedCodes = String.raw`(?:\s*[:：]?\s*${metricCodes})?`;
const englishSelector = String.raw`(?:metrics?|metric\s*codes?)`;
const chineseSelector = String.raw`指标(?:编码|代码)?`;
const sentenceEnd = String.raw`[.!。！]?`;
const selectionRejections = [
  new RegExp(String.raw`^(?:unknown|unsupported|invalid|unrecognized)\s+${englishSelector}${selectedCodes}${sentenceEnd}$`, "i"),
  new RegExp(String.raw`^${englishSelector}${selectedCodes}\s+(?:(?:is|are)\s+)?(?:unknown|unsupported|invalid|unrecognized|not\s+supported|not\s+found|not\s+available)${sentenceEnd}$`, "i"),
  new RegExp(String.raw`^(?:未知|不支持(?:的)?|无效(?:的)?|非法(?:的)?|不存在(?:的)?|未开放(?:的)?)${chineseSelector}${selectedCodes}${sentenceEnd}$`, "i"),
  new RegExp(String.raw`^${chineseSelector}${selectedCodes}\s*(?:未知|不支持|无效|非法|不存在|未开放)${sentenceEnd}$`, "i")
];
const selectionGuidance = /^(?:请调整指标编码|请检查指标编码)[。！]?$/;

export function canIsolateBiV1Request(error: unknown) {
  return error instanceof UpstreamError && error.code === "BI_V1_RESPONSE_INVALID" || isBiV1MetricSelectionRejection(error);
}

export function isBiV1MetricSelectionRejection(error: unknown) {
  if (!(error instanceof UpstreamError)) return false;
  const rejected = error.code === "BI_V1_REQUEST_REJECTED" && [400, 422].includes(error.statusCode)
    || error.code === "UPSTREAM_INVALID_REQUEST" && error.statusCode === 422;
  if (!rejected) return false;
  // Every clause must name a metric-selection rejection or its correction prompt.
  const clauses = error.message.split(/[;；\r\n]+/).map(clause => clause.trim()).filter(Boolean);
  let selectionRejected = false;
  for (const clause of clauses) {
    if (selectionRejections.some(pattern => pattern.test(clause))) selectionRejected = true;
    else if (!selectionGuidance.test(clause)) return false;
  }
  return selectionRejected;
}
