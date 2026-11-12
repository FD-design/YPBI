import { isIP } from "node:net";
import { productionDataPreviewDefaults } from "../config/production-data-preview";

const traceUrl = new URL("/cdn-cgi/trace", productionDataPreviewDefaults.baseUrl);
const traceTimeoutMs = 1500;
const maxTraceBodyBytes = 2048;

type TraceFetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface TestPreviewEgress {
  readonly address: string;
  readonly family: 4 | 6;
}

async function readBoundedTrace(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<string | undefined> {
  const reader = body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  let finished = false;
  try {
    signal.addEventListener("abort", cancel, { once: true });
    const bytes = new Uint8Array(maxTraceBodyBytes);
    let size = 0;
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (signal.aborted) return;
      if (done) {
        finished = true;
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
      }
      if (value.byteLength > bytes.byteLength - size) return;
      bytes.set(value, size);
      size += value.byteLength;
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!finished) cancel();
    reader.releaseLock();
  }
}

function parseTrace(text: string): TestPreviewEgress | undefined {
  const lines = text.split(/\r?\n/);
  const hosts = lines.filter(line => line.startsWith("h="));
  const addresses = lines.filter(line => line.startsWith("ip="));
  if (hosts.length !== 1 || hosts[0].slice(2) !== traceUrl.hostname || addresses.length !== 1) return;

  const address = addresses[0].slice(3);
  if (!/^[0-9A-Fa-f:.]+$/.test(address)) return;
  const family = isIP(address);
  if (family === 4 || family === 6) return { address, family };
}

async function fetchTrace(
  fetcher: TraceFetcher,
  userAgent: string | undefined,
  signal: AbortSignal
): Promise<TestPreviewEgress | undefined> {
  let response: Response | undefined;
  try {
    const headers = new Headers({ accept: "text/plain" });
    if (userAgent) headers.set("user-agent", userAgent);
    response = await fetcher(traceUrl.href, {
      method: "GET",
      headers,
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal
    });
    if (signal.aborted || response.status !== 200 || response.redirected
      || (response.url && response.url !== traceUrl.href) || response.headers.get("server")?.toLowerCase() !== "cloudflare") return;
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (mediaType !== "text/plain" || !response.body || response.bodyUsed || response.body.locked) return;

    const body = await readBoundedTrace(response.body, signal);
    if (!signal.aborted && body !== undefined) return parseTrace(body);
  } catch {
    return undefined;
  } finally {
    if (response?.body && !response.bodyUsed && !response.body.locked) {
      void response.body.cancel().catch(() => undefined);
    }
  }
}

/** Measure the server address observed by Cloudflare at the default test API host. */
export async function readDefaultTestPreviewEgress(
  fetcher: TraceFetcher,
  userAgent?: string
): Promise<TestPreviewEgress | undefined> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>(resolve => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(undefined);
    }, traceTimeoutMs);
  });
  try {
    return await Promise.race([fetchTrace(fetcher, userAgent, controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
