import { UpstreamError } from "./client";

export function canIsolateBiV1Request(error: unknown) {
  return error instanceof UpstreamError && error.code === "BI_V1_RESPONSE_INVALID" || isBiV1MetricSelectionRejection(error);
}

export function isBiV1MetricSelectionRejection(error: unknown) {
  if (!(error instanceof UpstreamError)) return false;
  const rejected = error.code === "BI_V1_REQUEST_REJECTED" && [400, 422].includes(error.statusCode)
    || error.code === "UPSTREAM_INVALID_REQUEST" && error.statusCode === 422;
  // UpstreamClient normalizes business rejections to 422. Only an explicit
  // metric-selection error is isolatable; access and other parameter errors stop.
  return rejected && !/权限|鉴权|认证|登录|token|unauthorized|forbidden|permission|credential|authentication/i.test(error.message)
    && /指标|metric/i.test(error.message)
    && /未知|不支持|无效|非法|不存在|未开放|仅支持|只支持|unknown|unsupported|invalid|unrecognized|not supported|not found|not allowed|not available/i.test(error.message);
}
