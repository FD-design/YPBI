import { describe, expect, test } from "bun:test";
import type { Sql } from "postgres";
import { PostgresAuthRepository } from "./postgres-auth.repository";
import { IdentityReadAdmission } from "./identity-read-admission";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

function database(max: number) {
  const calls: Array<{ token: unknown; result: ReturnType<typeof deferred<never[]>> }> = [];
  const sql = {
    options: { max },
    unsafe: (_query: string, values: unknown[]) => {
      const result = deferred<never[]>();
      calls.push({ token: values[0], result });
      return result.promise;
    }
  } as unknown as Sql;
  return { calls, repository: new PostgresAuthRepository(sql) };
}

const lookup = (repository: PostgresAuthRepository, token: string, signal?: AbortSignal) =>
  repository.findAuthenticatedSession(token, new Date("2026-10-22T00:00:00Z"), signal);
const outcome = <T>(pending: Promise<T>) => pending.then(
  value => ({ status: "fulfilled" as const, value }),
  error => ({ status: "rejected" as const, error })
);
const pause = () => new Promise<void>(resolve => setImmediate(resolve));

describe("身份读取提交准入", () => {
  for (const max of [1, 2, 4]) test(`按实际${max}连接容量提交，等待取消不执行SQL且不会占用下一批名额`, async () => {
    const { calls, repository } = database(max);
    const controllers = Array.from({ length: 20 }, () => new AbortController());
    const cancelled = controllers.map((controller, index) => outcome(lookup(repository, `${index}`, controller.signal)));
    expect(calls).toHaveLength(max);
    controllers.forEach(controller => controller.abort(new Error("memory cancelled batch")));
    await pause();
    expect(calls).toHaveLength(max);
    const next = lookup(repository, "healthy");
    expect(calls).toHaveLength(max);
    calls.slice().forEach(call => call.result.resolve([]));
    expect((await Promise.all(cancelled)).every(result => result.status === "rejected")).toBe(true);
    expect(calls.map(call => call.token)).toEqual([...Array.from({ length: max }, (_, index) => `${index}`), "healthy"]);
    calls.at(-1)!.result.resolve([]);
    expect(await next).toBeNull();
  });

  test("FIFO按等待顺序执行，移除队中及队尾取消不跳过存活请求", async () => {
    const { calls, repository } = database(1);
    const controllers = Array.from({ length: 6 }, () => new AbortController());
    const pending = controllers.map((controller, index) => outcome(lookup(repository, `${index}`, controller.signal)));
    controllers[2].abort(new Error("memory middle cancelled"));
    controllers[5].abort(new Error("memory tail cancelled"));
    for (const token of ["0", "1", "3", "4"]) {
      expect(calls.at(-1)?.token).toBe(token);
      calls.at(-1)!.result.resolve([]);
      await pause();
    }
    expect(calls.map(call => call.token)).toEqual(["0", "1", "3", "4"]);
    expect((await Promise.all(pending)).map(result => result.status))
      .toEqual(["fulfilled", "fulfilled", "rejected", "fulfilled", "fulfilled", "rejected"]);
  });

  test("归还与取消在同一轮发生时跳过未提交请求，后续请求不泄漏名额", async () => {
    const { calls, repository } = database(1);
    const first = lookup(repository, "first");
    const controller = new AbortController();
    const skipped = outcome(lookup(repository, "skipped", controller.signal));
    const third = lookup(repository, "third");
    calls[0].result.resolve([]);
    controller.abort(new Error("memory cancelled before handoff"));
    await first;
    expect((await skipped).status).toBe("rejected");
    expect(calls.map(call => call.token)).toEqual(["first", "third"]);
    calls[1].result.resolve([]);
    expect(await third).toBeNull();
  });

  test("在途取消仍等待SQL失败结算才释放，保留原数据库错误", async () => {
    const { calls, repository } = database(1);
    const controller = new AbortController();
    const first = outcome(lookup(repository, "first", controller.signal));
    controller.abort(new Error("memory request deadline"));
    const second = lookup(repository, "second");
    expect(calls).toHaveLength(1);
    const failure = Object.assign(new Error("memory statement timeout"), { code: "57014" });
    calls[0].result.reject(failure);
    expect(await first).toEqual({ status: "rejected", error: failure });
    expect(calls.map(call => call.token)).toEqual(["first", "second"]);
    calls[1].result.resolve([]);
    expect(await second).toBeNull();
  });

  test("不同repository的等待及取消互相隔离，同token后续仍重新读取数据库", async () => {
    const firstDatabase = database(1);
    const secondDatabase = database(2);
    const first = lookup(firstDatabase.repository, "same-token");
    const controller = new AbortController();
    const cancelled = outcome(lookup(firstDatabase.repository, "waiting", controller.signal));
    const independent = lookup(secondDatabase.repository, "same-token");
    expect(firstDatabase.calls).toHaveLength(1);
    expect(secondDatabase.calls).toHaveLength(1);
    controller.abort(new Error("memory separate repository"));
    secondDatabase.calls[0].result.resolve([]);
    expect(await independent).toBeNull();
    expect((await cancelled).status).toBe("rejected");
    firstDatabase.calls[0].result.resolve([]);
    expect(await first).toBeNull();
    const again = lookup(firstDatabase.repository, "same-token");
    expect(firstDatabase.calls).toHaveLength(2);
    firstDatabase.calls[1].result.resolve([]);
    expect(await again).toBeNull();
  });

  test("同步提交异常也归还名额", async () => {
    const admission = new IdentityReadAdmission(1);
    const failure = new Error("memory synchronous submission failure");
    const failed = outcome(admission.run<null>(() => { throw failure; }));
    const recovered = admission.run(async () => "healthy");
    expect(await failed).toEqual({ status: "rejected", error: failure });
    expect(await recovered).toBe("healthy");
  });

  test("无效连接池容量失败关闭", () => {
    for (const capacity of [0, -1, 1.5, NaN, Infinity]) {
      expect(() => new IdentityReadAdmission(capacity)).toThrow("有效数据库连接池容量");
    }
  });
});
