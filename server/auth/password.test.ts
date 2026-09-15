import { describe, expect, test } from "bun:test";
import {
  hashPassword,
  PasswordKdfGate,
  PasswordWorkCapacityError,
  verifyPassword,
  type ScryptParameters
} from "./password";

const testScryptParameters: ScryptParameters = {
  N: 2 ** 10,
  r: 8,
  p: 1,
  keyLength: 32,
  saltLength: 16,
  maxmem: 4 * 1024 * 1024
};

describe("BI password hashing", () => {
  test("使用带参数和随机 salt 的 scrypt 哈希", async () => {
    const first = await hashPassword("Correct-password-2026", testScryptParameters);
    const second = await hashPassword("Correct-password-2026", testScryptParameters);

    expect(first).toStartWith("$scrypt$N=1024,r=8,p=1$");
    expect(first).not.toBe(second);
    expect(await verifyPassword("Correct-password-2026", first)).toBe(true);
    expect(await verifyPassword("Wrong-password-2026", first)).toBe(false);
  });

  test("畸形或不受控的哈希参数失败关闭", async () => {
    expect(await verifyPassword("Correct-password-2026", "not-a-password-hash")).toBe(false);
    expect(await verifyPassword(
      "Correct-password-2026",
      "$scrypt$N=999999,r=8,p=1$YWJjZGVmZ2hpamtsbW5vcA$YWJjZGVmZ2hpamtsbW5vcA"
    )).toBe(false);
  });

  test("密码安全计算限制执行数和排队数，满载时快速拒绝且异常后释放容量", async () => {
    const gate = new PasswordKdfGate(1, 2);
    let releaseFirst!: () => void;
    let active = 0;
    let maximumObserved = 0;
    const work = (value: number, blocked = false) => gate.run(async () => {
      active += 1;
      maximumObserved = Math.max(maximumObserved, active);
      try {
        if (blocked) await new Promise<void>((resolve) => { releaseFirst = resolve; });
        return value;
      } finally {
        active -= 1;
      }
    });

    const first = work(1, true);
    await Promise.resolve();
    const second = work(2);
    const third = work(3);
    await expect(work(4)).rejects.toBeInstanceOf(PasswordWorkCapacityError);
    expect(maximumObserved).toBe(1);

    releaseFirst();
    expect(await Promise.all([first, second, third])).toEqual([1, 2, 3]);
    expect(maximumObserved).toBe(1);
    await expect(gate.run(async () => { throw new Error("expected failure"); })).rejects.toThrow("expected failure");
    expect(await gate.run(async () => 5)).toBe(5);
  });

  test("容量异常不会被密码校验吞成错误密码", async () => {
    const encoded = await hashPassword(
      "Correct-password-2026",
      testScryptParameters,
      new PasswordKdfGate(1, 2)
    );
    const fullGate = new PasswordKdfGate(1, 2);
    let release!: () => void;
    const active = fullGate.run(() => new Promise<void>((resolve) => { release = resolve; }));
    await Promise.resolve();
    const queuedOne = fullGate.run(async () => undefined);
    const queuedTwo = fullGate.run(async () => undefined);

    await expect(verifyPassword("Correct-password-2026", encoded, fullGate))
      .rejects.toBeInstanceOf(PasswordWorkCapacityError);

    release();
    await Promise.all([active, queuedOne, queuedTwo]);
  });

  test("运行时 KDF 故障向上游报告服务不可用而不是伪装成错误密码", async () => {
    const encoded = await hashPassword(
      "Correct-password-2026",
      testScryptParameters,
      new PasswordKdfGate(1, 2)
    );
    class FailingGate extends PasswordKdfGate {
      override run<T>(): Promise<T> {
        return Promise.reject(new Error("test_kdf_runtime_failure"));
      }
    }

    await expect(verifyPassword("Correct-password-2026", encoded, new FailingGate()))
      .rejects.toThrow("test_kdf_runtime_failure");
  });
});
