import { productionDataPreviewDefaults } from "../config/production-data-preview";
import { RETENTION_PLUS_API } from "./retention.adapter";
import { inspectTestPreviewDeniedResponse, type TestPreviewDeniedResponse } from "./test-preview-edge";

const wireTimeoutMs = 2000;
const maxWireBodyBytes = 8 * 1024;
const invalidWireToken = "ypbi-wire-check-invalid-fixture-v1";

type WireFetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type WireResponseFormat = "json" | "html" | "other";
type WireAuthDenialKind = "upstream_auth" | "upstream_ip_restricted";

export interface TestPreviewWireResult {
  readonly outcome: "response" | "network" | "timeout";
  readonly httpStatus?: number;
  readonly responseFormat?: WireResponseFormat;
  readonly businessCode?: 2002;
  readonly denialKind?: TestPreviewDeniedResponse["kind"];
  readonly cloudflareErrorCode?: number;
  readonly cloudflareRayId?: string;
}

export interface TestPreviewWireCheck {
  readonly bunVersion?: string;
  readonly proxyEnvironment: { readonly http: boolean; readonly https: boolean; readonly all: boolean };
  readonly legacy: TestPreviewWireResult;
  readonly current: TestPreviewWireResult;
}

export function testPreviewCredentialProbeUrl(baseUrl: string, pid: string, now = Date.now()): URL {
  const day = new Date(now + (8 - 24) * 60 * 60 * 1000).toISOString().slice(0, 10);
  const url = new URL(RETENTION_PLUS_API, baseUrl);
  url.search = new URLSearchParams({ pid, registerDate: day + " 00:00:00", registerEdDate: day + " 23:59:59" }).toString();
  return url;
}

function classifyResponseFormat(headers: Headers): WireResponseFormat {
  const mediaType = headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType === "application/json" || mediaType?.endsWith("+json")) return "json";
  if (mediaType === "text/html" || mediaType === "application/xhtml+xml") return "html";
  return "other";
}

function isAppErrorMessage(value: unknown): value is string {
  return typeof value === "string" && value.length <= 1024 && value.trim().length > 0;
}

function classifyAuthBusinessCode(payload: unknown): WireAuthDenialKind | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
  const error = payload as Record<string, unknown>;
  if (!Object.hasOwn(error, "code") || !Object.hasOwn(error, "err") || error.cloudflare_error === true
    || (error.code !== 2002 && error.code !== "2002")) return;
  const messages = typeof error.err === "string" ? [error.err] : error.err;
  if (!Array.isArray(messages) || !messages.length || messages.length > 8 || !messages.every(isAppErrorMessage)) return;
  return messages.some(message => /ip\s*限制/i.test(message)) ? "upstream_ip_restricted" : "upstream_auth";
}

async function readAuthDenialKind(response: Response, signal: AbortSignal): Promise<WireAuthDenialKind | undefined> {
  if (!response.body || response.bodyUsed || response.body.locked) return;
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  let finished = false;
  try {
    signal.addEventListener("abort", cancel, { once: true });
    const bytes = new Uint8Array(maxWireBodyBytes);
    let size = 0;
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (signal.aborted) return;
      if (done) {
        finished = true;
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
        return classifyAuthBusinessCode(JSON.parse(text) as unknown);
      }
      if (value.byteLength > bytes.byteLength - size) return;
      bytes.set(value, size);
      size += value.byteLength;
    }
  } catch {
    return undefined;
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!finished) cancel();
    reader.releaseLock();
  }
}

async function runWireRequest(fetcher: WireFetcher, url: string, headers: Record<string, string>): Promise<TestPreviewWireResult> {
  const controller = new AbortController();
  const { signal } = controller;
  let metadata: Pick<TestPreviewWireResult, "httpStatus" | "responseFormat"> | undefined;
  const timedOut = (): TestPreviewWireResult => ({ outcome: "timeout", ...metadata });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<TestPreviewWireResult>(resolve => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(timedOut());
    }, wireTimeoutMs);
  });

  const request = async (): Promise<TestPreviewWireResult> => {
    let response: Response | undefined;
    try {
      response = await fetcher(url, { method: "GET", headers, credentials: "omit", redirect: "error", signal });
      if (signal.aborted) return timedOut();
      if (response.redirected || (response.url && response.url !== url)
        || !Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
        return { outcome: "network" };
      }

      metadata = { httpStatus: response.status, responseFormat: classifyResponseFormat(response.headers) };
      const result = { outcome: "response", ...metadata } as const;
      if (response.status === 403) {
        const denial = await inspectTestPreviewDeniedResponse(response, signal);
        if (signal.aborted) return timedOut();
        return {
          ...result,
          denialKind: denial.kind,
          ...(denial.rayId ? { cloudflareRayId: denial.rayId } : {}),
          ...(denial.kind === "cloudflare_edge" ? { cloudflareErrorCode: denial.code }
            : denial.kind === "upstream_auth" || denial.kind === "upstream_ip_restricted" ? { businessCode: denial.code } : {})
        };
      }
      if (metadata.responseFormat !== "json") return result;
      const denialKind = await readAuthDenialKind(response, signal);
      if (signal.aborted) return timedOut();
      return denialKind === undefined ? result : { ...result, businessCode: 2002, denialKind };
    } catch {
      if (signal.aborted) return timedOut();
      return metadata ? { outcome: "response", ...metadata } : { outcome: "network" };
    } finally {
      if (response?.body && !response.bodyUsed && !response.body.locked) {
        void response.body.cancel().catch(() => undefined);
      }
    }
  };

  try {
    return await Promise.race([request(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function hasProxyEnvironment(name: "HTTP_PROXY" | "HTTPS_PROXY" | "ALL_PROXY") {
  return Object.hasOwn(process.env, name) || Object.hasOwn(process.env, name.toLowerCase());
}

/** Compare the legacy and current header policies on the same runtime using one non-secret fixture. */
export async function readDefaultTestPreviewWireCheck(
  fetcher: WireFetcher,
  userName: string,
  currentUserAgent: string
): Promise<TestPreviewWireCheck> {
  const url = testPreviewCredentialProbeUrl(productionDataPreviewDefaults.baseUrl, "PH").href;
  const legacyHeaders = { "x-token": invalidWireToken, name: userName };
  const legacy = await runWireRequest(fetcher, url, legacyHeaders);
  const current = await runWireRequest(fetcher, url, {
    ...legacyHeaders, "user-agent": currentUserAgent, accept: "application/json"
  });
  const version = process.versions.bun;
  const bunVersion = version && version.length <= 32 && /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.]+)?$/i.test(version) ? version : undefined;
  return {
    ...(bunVersion ? { bunVersion } : {}),
    proxyEnvironment: {
      http: hasProxyEnvironment("HTTP_PROXY"),
      https: hasProxyEnvironment("HTTPS_PROXY"),
      all: hasProxyEnvironment("ALL_PROXY")
    },
    legacy,
    current
  };
}
