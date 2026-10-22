import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import postgres, { type Sql } from "postgres";
import { PostgresAuthRepository } from "./postgres-auth.repository";
import { resolveIdentity } from "../identity/resolve-identity";
import type { IdentityProvider } from "../identity/identity-provider";

// Exercise the installed driver with in-memory PostgreSQL protocol messages.
// No listener, external database, real identity or credential is used.
function message(type: string, body = Buffer.alloc(0)) {
  const bytes = Buffer.alloc(body.length + 5);
  bytes[0] = type.charCodeAt(0);
  bytes.writeInt32BE(body.length + 4, 1);
  body.copy(bytes, 5);
  return bytes;
}
const integer = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeInt32BE(value); return bytes; };
const ready = () => message("Z", Buffer.from("I"));
const complete = () => message("C", Buffer.from("SELECT 0\0"));
const cancelled = () => message("E", Buffer.from("SERROR\0C57014\0Mmemory statement timeout\0\0"));

interface MemoryWire {
  holdIdentity: boolean;
  identityWrites: number;
  cancelPackets: number;
  sockets: MemorySocket[];
  delayedCancels: Array<() => void>;
}

class MemorySocket extends EventEmitter {
  readyState = "open";
  destroyed = false;
  startupWritten = false;
  identityStatement = false;
  activeIdentity = false;
  constructor(private readonly wire: MemoryWire, readonly backendId: number) { super(); }
  setKeepAlive() { return this; }
  write(chunk: Uint8Array, callback?: () => void) {
    const bytes = Buffer.from(chunk);
    if (!this.startupWritten) {
      this.startupWritten = true;
      if (bytes.readInt32BE(4) === 80877102) {
        this.wire.cancelPackets++;
        const target = this.wire.sockets.find(socket => socket.backendId === bytes.readInt32BE(8));
        this.wire.delayedCancels.push(() => {
          if (target?.activeIdentity) target.finish(true);
          this.end();
        });
      } else {
        queueMicrotask(() => !this.destroyed && this.emit("data", Buffer.concat([
          message("R", integer(0)), message("K", Buffer.concat([integer(this.backendId), integer(202)])), ready()
        ])));
      }
    } else {
      const responses: Buffer[] = [];
      for (let offset = 0; offset < bytes.length;) {
        const type = String.fromCharCode(bytes[offset]);
        const length = bytes.readInt32BE(offset + 1);
        if (type === "P") {
          this.identityStatement = bytes.subarray(offset + 5, offset + length + 1).includes(Buffer.from("bi_auth_sessions"));
          responses.push(message("1"));
        }
        if (type === "D") responses.push(message("t", Buffer.from([0, 0])), message("n"));
        if (type === "B") responses.push(message("2"));
        if (type === "E") {
          if (this.identityStatement) { this.wire.identityWrites++; this.activeIdentity = true; }
          if (!this.identityStatement || !this.wire.holdIdentity) responses.push(complete());
        }
        if (type === "S" && (!this.identityStatement || !this.wire.holdIdentity)) {
          this.activeIdentity = false;
          responses.push(ready());
        }
        if (type === "Q") responses.push(complete(), ready());
        if (type === "X") this.end();
        offset += length + 1;
      }
      if (responses.length) queueMicrotask(() => !this.destroyed && this.emit("data", Buffer.concat(responses)));
    }
    callback?.();
    return true;
  }
  finish(statementTimeout = false) {
    if (!this.activeIdentity) throw new Error("memory identity query not active");
    this.activeIdentity = false;
    this.emit("data", Buffer.concat([statementTimeout ? cancelled() : complete(), ready()]));
  }
  disconnect(code?: "ECONNRESET" | "EPIPE") {
    if (this.destroyed) return;
    this.activeIdentity = false;
    if (code) this.emit("error", Object.assign(new Error("memory transport failure"), { code }));
    this.destroyed = true;
    this.readyState = "closed";
    queueMicrotask(() => this.emit("close", Boolean(code)));
  }
  end() {
    if (!this.destroyed) {
      this.destroyed = true;
      this.readyState = "closed";
      queueMicrotask(() => this.emit("close", false));
    }
    return this;
  }
  destroy() { return this.end(); }
}

const pause = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(condition: () => boolean, label: string) {
  const deadline = Date.now() + 1_000;
  while (!condition() && Date.now() < deadline) await pause();
  if (!condition()) throw new Error(label);
}
const outcome = <T>(promise: Promise<T>) => promise.then(
  value => ({ status: "fulfilled" as const, value }),
  error => ({ status: "rejected" as const, error })
);
const lookup = (repository: PostgresAuthRepository, signal?: AbortSignal) =>
  repository.findAuthenticatedSession("a".repeat(64), new Date("2026-10-21T00:00:00Z"), signal);

async function withDatabase(max: number, run: (repository: PostgresAuthRepository, wire: MemoryWire, sql: Sql) => Promise<void>) {
  const wire: MemoryWire = { holdIdentity: true, identityWrites: 0, cancelPackets: 0, sockets: [], delayedCancels: [] };
  const configuration = {
    host: "memory.invalid", port: 1, database: "memory", user: "unit", password: "memory-only", ssl: false,
    max, idle_timeout: 20, connect_timeout: 10, max_lifetime: null, fetch_types: true,
    socket: () => { const socket = new MemorySocket(wire, wire.sockets.length + 1); wire.sockets.push(socket); return socket; }
  };
  const sql = postgres(configuration);
  try { await run(new PostgresAuthRepository(sql), wire, sql); }
  finally {
    wire.delayedCancels.forEach(cancel => cancel());
    await sql.end({ timeout: 0 });
    wire.sockets.forEach(socket => socket.end());
  }
}

describe("PostgreSQL 身份查询取消与连接复用", () => {
  for (const code of [undefined, "ECONNRESET", "EPIPE"] as const) {
    for (const cancelFirst of [false, true]) {
      test(`${code ?? "CONNECTION_CLOSED"}关闭${cancelFirst ? "已取消" : "在途"}身份连接后，后续多次查询使用新连接恢复`, async () => {
        await withDatabase(1, async (repository, wire) => {
          const controller = new AbortController();
          const first = outcome(lookup(repository, controller.signal));
          await until(() => wire.identityWrites === 1, "身份SELECT未开始");
          if (cancelFirst) controller.abort(new Error("memory client disconnected"));
          wire.sockets[0].disconnect(code);
          const failed = await first;
          expect(failed.status).toBe("rejected");
          if (failed.status === "rejected") expect(failed.error.code).toBe(code ?? "CONNECTION_CLOSED");
          wire.holdIdentity = false;
          const recovered = await Promise.all(Array.from({ length: 20 }, () => lookup(repository)));
          expect(recovered.every(value => value === null)).toBe(true);
          expect(await lookup(repository)).toBeNull();
          expect(wire.sockets).toHaveLength(2);
          expect(wire.sockets[0].destroyed).toBe(true);
          expect(wire.identityWrites).toBe(22);
          expect(wire.cancelPackets).toBe(0);
        });
      });
    }
  }

  test("4连接中单一连接断开时其他查询正常，排队请求和后续查询继续恢复", async () => {
    await withDatabase(4, async (repository, wire) => {
      const initial = Array.from({ length: 4 }, () => outcome(lookup(repository)));
      await until(() => wire.identityWrites === 4, "4条身份SELECT未占满池");
      const queued = Promise.all(Array.from({ length: 20 }, () => lookup(repository)));
      await pause();
      expect(wire.identityWrites).toBe(4);
      wire.holdIdentity = false;
      wire.sockets[0].disconnect("ECONNRESET");
      wire.sockets.slice(1).forEach(socket => socket.finish());
      const settled = await Promise.all(initial);
      expect(settled.filter(result => result.status === "rejected")).toHaveLength(1);
      expect(settled.filter(result => result.status === "fulfilled")).toHaveLength(3);
      expect((await queued).every(value => value === null)).toBe(true);
      expect((await Promise.all(Array.from({ length: 20 }, () => lookup(repository)))).every(value => value === null)).toBe(true);
      expect(wire.sockets.filter(socket => !socket.destroyed)).toHaveLength(4);
      expect(wire.identityWrites).toBe(44);
      expect(wire.cancelPackets).toBe(0);
    });
  });

  test("客户端取消不发送协议cancel，驱动等待原SELECT结算且不影响下一健康身份查询", async () => {
    await withDatabase(1, async (repository, wire) => {
      const controller = new AbortController();
      let firstSettled = false;
      const first = outcome(lookup(repository, controller.signal)).finally(() => { firstSettled = true; });
      await until(() => wire.identityWrites === 1, "身份SELECT未开始");
      controller.abort(new Error("memory request disconnected"));
      await pause();
      expect(wire.cancelPackets).toBe(0);
      expect(firstSettled).toBe(false);
      const next = outcome(lookup(repository, new AbortController().signal));
      await pause();
      expect(wire.identityWrites).toBe(1);
      wire.sockets[0].finish();
      expect((await first).status).toBe("rejected");
      await until(() => wire.identityWrites === 2, "下一身份查询未取得已归还连接");
      wire.sockets[0].finish();
      expect(await next).toEqual({ status: "fulfilled", value: null });
      expect(wire.cancelPackets).toBe(0);
      expect(wire.sockets).toHaveLength(1);
    });
  });

  test("已取消SELECT等待数据库57014结算后，后续查询恢复且不新增取消连接", async () => {
    await withDatabase(1, async (repository, wire) => {
      const controller = new AbortController();
      const first = outcome(lookup(repository, controller.signal));
      await until(() => wire.identityWrites === 1, "身份SELECT未开始");
      controller.abort(new Error("memory request deadline"));
      wire.sockets[0].finish(true);
      const result = await first;
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.error.code).toBe("57014");
      wire.holdIdentity = false;
      expect(await lookup(repository)).toBeNull();
      expect(wire.cancelPackets).toBe(0);
      expect(wire.sockets).toHaveLength(1);
    });
  });

  test("4连接20次读取取消后仅4条在途SQL结算，后续查询可复用连接池", async () => {
    await withDatabase(4, async (repository, wire) => {
      const controllers = Array.from({ length: 20 }, () => new AbortController());
      let settled = 0;
      const pending = controllers.map(controller => outcome(lookup(repository, controller.signal)).finally(() => { settled++; }));
      await until(() => wire.identityWrites === 4, "4条身份SELECT未占满池");
      controllers.forEach(controller => controller.abort(new Error("memory cancelled batch")));
      await pause();
      expect(settled).toBe(16);
      expect(wire.identityWrites).toBe(4);
      expect(wire.cancelPackets).toBe(0);
      wire.holdIdentity = false;
      wire.sockets.filter(socket => socket.activeIdentity).forEach(socket => socket.finish(true));
      expect((await Promise.all(pending)).every(result => result.status === "rejected")).toBe(true);
      const recovered = await Promise.all(Array.from({ length: 20 }, () => lookup(repository)));
      expect(recovered.every(value => value === null)).toBe(true);
      expect(wire.identityWrites).toBe(24);
      expect(wire.cancelPackets).toBe(0);
      expect(wire.sockets).toHaveLength(4);
    });
  });

  test("取消积压不提交多余SQL，下一健康身份查询在原3秒期限内恢复", async () => {
    await withDatabase(4, async (repository, wire) => {
      let storageSettled = 0;
      const provider: IdentityProvider = { resolve: async ({ signal }) => {
        await lookup(repository, signal).finally(() => { storageSettled++; });
        return { status: "unauthenticated" };
      } };
      const controllers = Array.from({ length: 20 }, () => new AbortController());
      const cancelledRequests = controllers.map(controller => outcome(resolveIdentity(provider, {
        headers: {}, ip: "127.0.0.1", signal: controller.signal
      })));
      await until(() => wire.identityWrites === 4, "首批4条身份SELECT未开始");
      controllers.forEach(controller => controller.abort(new Error("memory cancelled batch")));
      expect((await Promise.all(cancelledRequests)).every(result => result.status === "rejected")).toBe(true);
      // Each statement settles well within the existing 2.5s database limit.
      const tick = setInterval(() => {
        wire.sockets.filter(socket => socket.activeIdentity).forEach(socket => socket.finish());
      }, 1_200);
      try {
        await expect(resolveIdentity(provider, { headers: {}, ip: "127.0.0.1" }))
          .resolves.toEqual({ status: "unauthenticated" });
        expect(storageSettled).toBe(21);
        expect(wire.identityWrites).toBe(5);
        expect(wire.sockets).toHaveLength(4);
        expect(wire.cancelPackets).toBe(0);
      } finally {
        clearInterval(tick);
        wire.holdIdentity = false;
        wire.sockets.filter(socket => socket.activeIdentity).forEach(socket => socket.finish());
      }
    });
  });

  test("外层deadline及时失败关闭，已提交SELECT由驱动结算且迟到结果不授予身份", async () => {
    await withDatabase(1, async (repository, wire) => {
      const provider: IdentityProvider = { resolve: async ({ signal }) => {
        await lookup(repository, signal);
        return { status: "unauthenticated" };
      } };
      const first = outcome(resolveIdentity(provider, { headers: {}, ip: "127.0.0.1" }, 20));
      await until(() => wire.identityWrites === 1, "身份SELECT未开始");
      const failed = await first;
      expect(failed.status).toBe("rejected");
      if (failed.status === "rejected") expect(failed.error.message).toBe("identity_timeout");
      expect(wire.sockets[0].activeIdentity).toBe(true);
      expect(wire.cancelPackets).toBe(0);
      const next = outcome(resolveIdentity(provider, { headers: {}, ip: "127.0.0.1" }, 500));
      await pause();
      expect(wire.identityWrites).toBe(1);
      wire.holdIdentity = false;
      wire.sockets[0].finish();
      expect(await next).toEqual({ status: "fulfilled", value: { status: "unauthenticated" } });
      expect(wire.sockets).toHaveLength(1);
      expect(wire.cancelPackets).toBe(0);
    });
  });
});
