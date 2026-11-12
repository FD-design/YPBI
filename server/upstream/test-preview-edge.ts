const edgeDenialCodes = [1006, 1007, 1008, 1009, 1010, 1012, 1020, 1106] as const;
const cloudflareRayPattern = /^[0-9A-Fa-f]{16}-[A-Z]{3}$/;
const maxErrorBodyBytes = 8 * 1024;
const errorBodyTimeoutMs = 500;
const maxAppErrorMessages = 8;
const maxAppErrorMessageLength = 1024;

type EdgeDenialCode = typeof edgeDenialCodes[number];

export type TestPreviewDeniedResponse =
  | { readonly kind: "cloudflare_edge"; readonly code: EdgeDenialCode; readonly rayId: string }
  | { readonly kind: "upstream_auth" | "upstream_ip_restricted"; readonly code: 2002; readonly rayId?: string }
  | { readonly kind: "unclassified"; readonly rayId?: string };

async function readBoundedJson(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<unknown> {
  const reader = body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  let finished = false;
  try {
    signal.addEventListener("abort", cancel, { once: true });
    const bytes = new Uint8Array(maxErrorBodyBytes);
    let size = 0;
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (signal.aborted) return;
      if (done) {
        finished = true;
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
        return JSON.parse(text) as unknown;
      }
      if (size + value.byteLength > bytes.byteLength) return;
      bytes.set(value, size);
      size += value.byteLength;
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!finished) cancel();
    reader.releaseLock();
  }
}

function readCloudflareRayId(headers: Headers) {
  if (headers.get("server")?.toLowerCase() !== "cloudflare") return;
  const rayId = headers.get("cf-ray");
  if (rayId && cloudflareRayPattern.test(rayId)) return rayId;
}

function isAppErrorMessage(value: unknown): value is string {
  return typeof value === "string" && value.length <= maxAppErrorMessageLength && value.trim().length > 0;
}

/** Project fixed provenance for this response without retaining the body. */
export async function inspectTestPreviewDeniedResponse(
  response: Response,
  signal: AbortSignal
): Promise<TestPreviewDeniedResponse> {
  if (signal.aborted || response.status !== 403) return { kind: "unclassified" };
  const rayId = readCloudflareRayId(response.headers);
  const correlation = rayId ? { rayId } : {};
  const unclassified = { kind: "unclassified", ...correlation } as const;

  const headerCode = response.headers.get("cf-error-type");
  const codeFromHeader = edgeDenialCodes.find(code => String(code) === headerCode);
  if (rayId && codeFromHeader !== undefined) return { kind: "cloudflare_edge", code: codeFromHeader, rayId };

  const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json" && mediaType !== "application/problem+json") return unclassified;
  if (!response.body || response.bodyUsed || response.body.locked) return unclassified;

  try {
    const readSignal = AbortSignal.any([signal, AbortSignal.timeout(errorBodyTimeoutMs)]);
    const payload = await readBoundedJson(response.body, readSignal);
    if (readSignal.aborted || !payload || typeof payload !== "object" || Array.isArray(payload)) return unclassified;
    const error = payload as Record<string, unknown>;
    if (error.cloudflare_error === true) {
      const code = edgeDenialCodes.find(candidate => candidate === error.error_code);
      if (code !== undefined && rayId && typeof error.ray_id === "string"
        && error.ray_id.toLowerCase() === rayId.slice(0, 16).toLowerCase()) {
        return { kind: "cloudflare_edge", code, rayId };
      }
      return unclassified;
    }

    if (!Object.hasOwn(error, "code") || !Object.hasOwn(error, "err") || (error.code !== 2002 && error.code !== "2002")) {
      return unclassified;
    }
    const messages = typeof error.err === "string" ? [error.err] : error.err;
    if (!Array.isArray(messages) || !messages.length || messages.length > maxAppErrorMessages
      || !messages.every(isAppErrorMessage)) return unclassified;

    const kind = messages.some(message => /ip\s*限制/i.test(message)) ? "upstream_ip_restricted" : "upstream_auth";
    return { kind, code: 2002, ...correlation };
  } catch {
    return unclassified;
  }
}
