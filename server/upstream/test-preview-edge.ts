const edgeDenialCodes = [1006, 1007, 1008, 1009, 1010, 1012, 1020, 1106] as const;
const cloudflareRayPattern = /^[0-9A-Fa-f]{16}-[A-Z]{3}$/;
const maxErrorBodyBytes = 8 * 1024;

type EdgeDenialCode = typeof edgeDenialCodes[number];

export interface TestPreviewEdgeRejection {
  readonly code: EdgeDenialCode;
  readonly rayId: string;
}

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

/** Recognize a fixed Cloudflare edge denial without retaining any error body. */
export async function readTestPreviewEdgeRejection(
  response: Response,
  signal: AbortSignal
): Promise<TestPreviewEdgeRejection | undefined> {
  if (signal.aborted || response.status !== 403 || response.headers.get("server")?.toLowerCase() !== "cloudflare") return;
  const rayId = response.headers.get("cf-ray");
  if (!rayId || !cloudflareRayPattern.test(rayId)) return;

  const headerCode = response.headers.get("cf-error-type");
  const codeFromHeader = edgeDenialCodes.find(code => String(code) === headerCode);
  if (codeFromHeader !== undefined) return { code: codeFromHeader, rayId };

  const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json" && mediaType !== "application/problem+json") return;
  if (!response.body || response.bodyUsed || response.body.locked) return;

  try {
    const payload = await readBoundedJson(response.body, signal);
    if (signal.aborted || !payload || typeof payload !== "object" || Array.isArray(payload)) return;
    const error = payload as { cloudflare_error?: unknown; error_code?: unknown; ray_id?: unknown };
    const code = edgeDenialCodes.find(candidate => candidate === error.error_code);
    if (code === undefined || error.cloudflare_error !== true || typeof error.ray_id !== "string"
      || error.ray_id.toLowerCase() !== rayId.slice(0, 16).toLowerCase()) return;
    return { code, rayId };
  } catch {
    return undefined;
  }
}
