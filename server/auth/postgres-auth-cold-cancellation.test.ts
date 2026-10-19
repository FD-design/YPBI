import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import postgres, { type Sql } from "postgres";
import { PostgresAuthRepository } from "./postgres-auth.repository";
import { resolveIdentity } from "../identity/resolve-identity";
import type { IdentityProvider } from "../identity/identity-provider";

// The installed PostgreSQL driver talks only to this in-memory wire stub.
// No TCP listener, external database, real session or credentials are used.
function message(type: string, body: Buffer = Buffer.alloc(0)) {
  const bytes = Buffer.alloc(body.length + 5);
  bytes[0] = type.charCodeAt(0);
  bytes.writeInt32BE(body.length + 4, 1);
  body.copy(bytes, 5);
  return bytes;
}
const ready = () => message("Z", Buffer.from("I"));
const integer = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeInt32BE(value); return bytes; };

interface MemoryWire {
  releaseStartup: boolean;
  sockets: MemorySocket[];
}

class MemorySocket extends EventEmitter {
  readyState = "open";
  destroyed = false;
  startupWritten = false;
  queryWrites = 0;

  constructor(private readonly wire: MemoryWire) { super(); }

  setKeepAlive() { return this; }

  write(chunk: Uint8Array, callback?: () => void) {
    const bytes = Buffer.from(chunk);
    if (!this.startupWritten) {
      this.startupWritten = true;
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
async function until(condition: () => boolean, message: string) {
  const deadline = Date.now() + 500;
  while (!condition() && Date.now() < deadline) await pause();
  if (!condition()) throw new Error(message);
}

async function withDatabase(
  options: { max?: number; holdStartup?: boolean; fetchTypes?: boolean },
  run: (sql: Sql, repository: PostgresAuthRepository, wire: MemoryWire) => Promise<void>
) {
  const wire: MemoryWire = { releaseStartup: !options.holdStartup, sockets: [] };
  const configuration = {
    host: "memory.invalid", database: "memory", user: "unit", max: options.max ?? 4,
    idle_timeout: 20, connect_timeout: 10, max_lifetime: null, fetch_types: options.fetchTypes ?? true,
    socket: () => { const socket = new MemorySocket(wire); wire.sockets.push(socket); return socket; }
  };
  const sql = postgres(configuration);
  try { await run(sql, new PostgresAuthRepository(sql), wire); }
  finally { await sql.end({ timeout: 0 }); }
}

const lookup = (repository: PostgresAuthRepository, signal?: AbortSignal) =>
  repository.findAuthenticatedSession("a".repeat(64), new Date("2026-10-19T00:00:00Z"), signal);

async function probe(repository: PostgresAuthRepository) {
  const controller = new AbortController();
  let settled = false;
  const result = lookup(repository, controller.signal).finally(() => { settled = true; });
  try {
    await until(() => settled, "取消后的身份查询未释放可用连接");
    expect(await result).toBeNull();
  } finally {
    if (!settled) controller.abort(new Error("test_probe_cleanup"));
    await result.catch(() => undefined);
  }
}

describe("PostgreSQL 身份查询冷连接取消", () => {
  test("健康单次及20并发查询后，身份池仍可继续查询", async () => {
    await withDatabase({}, async (_sql, repository, wire) => {
      expect(await lookup(repository)).toBeNull();
      const results = await Promise.all(Array.from({ length: 20 }, () => lookup(repository)));
      expect(results.every(value => value === null)).toBe(true);
      expect(wire.sockets.length).toBeLessThanOrEqual(4);
      await probe(repository);
    });
  });

  for (const [max, count] of [[1, 1], [4, 20]] as const) test(`冷握手${max}连接/${count}等待取消后，晚到连接不查身份且后续查询恢复`, async () => {
    await withDatabase({ max, holdStartup: true }, async (_sql, repository, wire) => {
      const controllers = Array.from({ length: count }, () => new AbortController());
      let settled = 0;
      const pending = controllers.map(controller => lookup(repository, controller.signal)
        .then(() => "fulfilled", () => "rejected").finally(() => { settled++; }));
      await until(() => wire.sockets.length === max && wire.sockets.every(socket => socket.startupWritten), "冷连接未启动");
      controllers.forEach(controller => controller.abort(new Error("test_identity_deadline")));
      await until(() => settled === count, "取消未及时结束调用方等待");
      expect(await Promise.all(pending)).toEqual(Array(count).fill("rejected"));
      wire.releaseStartup = true;
      wire.sockets.forEach(socket => socket.startupReady());
      await probe(repository);
      // One metadata fetch per connection, plus only the final healthy probe.
      expect(wire.sockets.reduce((sum, socket) => sum + socket.queryWrites, 0)).toBe(max + 1);
      expect(wire.sockets.length).toBe(max);
    });
  });

  test("ready连接被占用时取消排队者，晚到reservation只释放且不影响后续查询", async () => {
    await withDatabase({ max: 1 }, async (sql, repository, wire) => {
      const held = await sql.reserve();
      try {
        const before = wire.sockets.reduce((sum, socket) => sum + socket.queryWrites, 0);
        const controller = new AbortController();
        let settled = false;
        const waiting = lookup(repository, controller.signal).then(() => "fulfilled", () => "rejected")
          .finally(() => { settled = true; });
        await pause();
        controller.abort(new Error("test_acquire_cancelled"));
        await until(() => settled, "pool等待取消未及时返回");
        expect(await waiting).toBe("rejected");
        expect(wire.sockets.reduce((sum, socket) => sum + socket.queryWrites, 0)).toBe(before);
      } finally { held.release(); }
      await probe(repository);
      expect(wire.sockets.reduce((sum, socket) => sum + socket.queryWrites, 0)).toBe(2);
    });
  });

  test("身份自然deadline取消冷lookup后，后续身份解析恢复且期限保持生效", async () => {
    await withDatabase({ max: 1, holdStartup: true }, async (_sql, repository, wire) => {
      const provider: IdentityProvider = {
        resolve: async ({ signal }) => {
          await lookup(repository, signal);
          return { status: "unauthenticated" };
        }
      };
      const first = resolveIdentity(provider, { headers: {}, ip: "127.0.0.1" }, 20)
        .then(() => null, error => error as Error);
      await until(() => wire.sockets.length === 1 && wire.sockets[0].startupWritten, "冷连接未启动");
      expect((await first)?.message).toBe("identity_timeout");
      wire.releaseStartup = true;
      wire.sockets.forEach(socket => socket.startupReady());
      const recovered = await resolveIdentity(provider, { headers: {}, ip: "127.0.0.1" }, 200);
      expect(recovered).toEqual({ status: "unauthenticated" });
      expect(wire.sockets).toHaveLength(1);
      expect(wire.sockets[0].queryWrites).toBe(2);
    });
  });

  for (const fetchTypes of [false, true]) test(`预先取消不创建连接或身份SQL，fetch_types=${fetchTypes}`, async () => {
    await withDatabase({ fetchTypes }, async (_sql, repository, wire) => {
      const controller = new AbortController();
      controller.abort(new Error("test_pre_aborted"));
      await expect(lookup(repository, controller.signal)).rejects.toThrow();
      expect(wire.sockets).toHaveLength(0);
    });
  });
});
