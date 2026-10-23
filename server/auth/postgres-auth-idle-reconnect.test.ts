import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import postgres, { type Sql } from "postgres";
import { PostgresAuthRepository } from "./postgres-auth.repository";
import { resolveIdentity } from "../identity/resolve-identity";
import type { IdentityProvider } from "../identity/identity-provider";

// Exercise the installed driver's real idle timer through an in-memory wire.
// No external database, TCP listener, session or credentials are used.
function message(type: string, body: Buffer = Buffer.alloc(0)) {
  const bytes = Buffer.alloc(body.length + 5);
  bytes[0] = type.charCodeAt(0);
  bytes.writeInt32BE(body.length + 4, 1);
  body.copy(bytes, 5);
  return bytes;
}
const ready = () => message("Z", Buffer.from("I"));
const integer = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeInt32BE(value); return bytes; };

interface IdleWire {
  releaseStartup: boolean;
  sockets: IdleSocket[];
  cancelPackets: number;
}

class IdleSocket extends EventEmitter {
  readyState = "open";
  destroyed = false;
  startupWritten = false;
  queryWrites = 0;
  driverTerminated = false;

  constructor(private readonly wire: IdleWire) { super(); }

  setKeepAlive() { return this; }

  write(chunk: Uint8Array, callback?: () => void) {
    const bytes = Buffer.from(chunk);
    if (!this.startupWritten) {
      this.startupWritten = true;
      if (bytes.readInt32BE(4) === 80877102) {
        this.wire.cancelPackets++;
        this.end();
        return true;
      }
      if (this.wire.releaseStartup) queueMicrotask(() => this.startupReady());
    } else {
      const responses: Buffer[] = [];
      for (let offset = 0; offset < bytes.length;) {
        const type = String.fromCharCode(bytes[offset]);
        const length = bytes.readInt32BE(offset + 1);
        if (type === "P") { this.queryWrites++; responses.push(message("1")); }
        if (type === "D") responses.push(message("t", Buffer.from([0, 0])), message("n"));
        if (type === "B") responses.push(message("2"));
        if (type === "E") responses.push(message("C", Buffer.from("SELECT 0\0")));
        if (type === "S") responses.push(ready());
        if (type === "Q") { this.queryWrites++; responses.push(message("C", Buffer.from("SELECT 0\0")), ready()); }
        if (type === "X") this.end();
        offset += length + 1;
      }
      if (responses.length) queueMicrotask(() => !this.destroyed && this.emit("data", Buffer.concat(responses)));
    }
    callback?.();
    return true;
  }

  startupReady() {
    if (!this.startupWritten || this.destroyed) return;
    this.emit("data", Buffer.concat([
      message("R", integer(0)), message("K", Buffer.concat([integer(1), integer(2)])), ready()
    ]));
  }

  end(chunk?: Uint8Array) {
    if (chunk?.[0] === "X".charCodeAt(0)) this.driverTerminated = true;
    if (!this.destroyed) {
      this.destroyed = true;
      this.readyState = "closed";
      queueMicrotask(() => this.emit("close", false));
    }
    return this;
  }

  destroy() { return this.end(); }
}

const pause = (ms = 0) => new Promise<void>(resolve => ms ? setTimeout(resolve, ms) : setImmediate(resolve));
async function until(condition: () => boolean, detail: string, timeoutMs = 500) {
  const deadline = performance.now() + timeoutMs;
  while (!condition() && performance.now() < deadline) await pause(timeoutMs > 1_000 ? 10 : 0);
  if (!condition()) throw new Error(detail);
}

async function withIdleDatabase(
  run: (sql: Sql, repository: PostgresAuthRepository, wire: IdleWire) => Promise<void>
) {
  const wire: IdleWire = { releaseStartup: true, sockets: [], cancelPackets: 0 };
  const configuration = {
    host: "memory.invalid", database: "memory", user: "unit", max: 4,
    idle_timeout: 20, connect_timeout: 10, max_lifetime: null, fetch_types: true,
    socket: () => { const socket = new IdleSocket(wire); wire.sockets.push(socket); return socket; }
  };
  const sql = postgres(configuration);
  try { await run(sql, new PostgresAuthRepository(sql), wire); }
  finally { await sql.end({ timeout: 0 }); }
}

const lookup = (repository: PostgresAuthRepository, signal?: AbortSignal) =>
  repository.findAuthenticatedSession("a".repeat(64), new Date("2026-10-19T00:00:00Z"), signal);

describe("PostgreSQL 身份池真实20秒idle关闭后重连", () => {
  test("4连接idle关闭后20请求取消，迟到读取自然结算且后续20健康身份请求未滞留", async () => {
    await withIdleDatabase(async (sql, repository, wire) => {
      expect(sql.options.idle_timeout).toBe(20);
      expect((await Promise.all(Array.from({ length: 20 }, () => lookup(repository)))).every(value => value === null)).toBe(true);
      expect(wire.sockets).toHaveLength(4);
      const original = [...wire.sockets];
      const idleStarted = performance.now();
      await until(() => original.every(socket => socket.destroyed), "驱动真实20秒idle未关闭全部连接", 23_000);
      expect(performance.now() - idleStarted).toBeGreaterThanOrEqual(19_500);
      expect(original.every(socket => socket.driverTerminated)).toBe(true);
      const beforeReconnect = original.reduce((sum, socket) => sum + socket.queryWrites, 0);
      expect(beforeReconnect).toBe(24);

      wire.releaseStartup = false;
      let storageSettled = 0;
      const provider: IdentityProvider = { resolve: async ({ signal }) => {
        await lookup(repository, signal).finally(() => { storageSettled++; });
        return { status: "unauthenticated" };
      } };
      const controllers = Array.from({ length: 20 }, () => new AbortController());
      const cancelled = controllers.map(controller => resolveIdentity(provider, {
        headers: {}, ip: "127.0.0.1", signal: controller.signal
      }).then(() => "fulfilled", () => "rejected"));
      await until(() => wire.sockets.length === 8 && wire.sockets.slice(4).every(socket => socket.startupWritten), "idle关闭后未重建4条握手连接");
      controllers.forEach(controller => controller.abort(new Error("test_idle_reconnect_cancelled")));
      expect(await Promise.all(cancelled)).toEqual(Array(20).fill("rejected"));
      expect(storageSettled).toBe(16);

      const healthyStarted = performance.now();
      const healthy = Promise.all(Array.from({ length: 20 }, () => resolveIdentity(provider, {
        headers: {}, ip: "127.0.0.1"
      })));
      wire.releaseStartup = true;
      wire.sockets.slice(4).forEach(socket => socket.startupReady());
      expect(await healthy).toEqual(Array.from({ length: 20 }, () => ({ status: "unauthenticated" })));
      expect(performance.now() - healthyStarted).toBeLessThan(3_000);
      expect(storageSettled).toBe(40);
      expect(wire.sockets).toHaveLength(8);
      expect(wire.sockets.reduce((sum, socket) => sum + socket.queryWrites, 0) - beforeReconnect).toBe(28);
      expect(wire.cancelPackets).toBe(0);
      expect(await lookup(repository)).toBeNull();
    });
  }, 30_000);
});
