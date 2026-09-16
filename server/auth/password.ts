import { randomBytes, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";
import { BI_PASSWORD_MAX_LENGTH, BI_PASSWORD_MIN_LENGTH } from "../../contracts/bi-auth";

interface PendingPasswordWork {
  work: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

export class PasswordWorkCapacityError extends Error {
  readonly code = "PASSWORD_KDF_CAPACITY_EXCEEDED";

  constructor() {
    super("密码安全计算繁忙，请稍后重试");
    this.name = "PasswordWorkCapacityError";
  }
}

/**
 * scrypt intentionally consumes substantial memory. Keep the public API from
 * turning that fixed cost into unbounded process memory or an unbounded queue.
 */
export class PasswordKdfGate {
  private active = 0;
  private readonly queue: PendingPasswordWork[] = [];

  constructor(
    private readonly maximumActive = 1,
    private readonly maximumQueued = 2
  ) {
    if (!Number.isInteger(maximumActive) || maximumActive < 1 || maximumActive > 16) {
      throw new Error("密码安全计算并发上限不合法");
    }
    if (!Number.isInteger(maximumQueued) || maximumQueued < 0 || maximumQueued > 1_000) {
      throw new Error("密码安全计算排队上限不合法");
    }
  }

  run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.maximumActive && this.queue.length >= this.maximumQueued) {
      return Promise.reject(new PasswordWorkCapacityError());
    }
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        work,
        resolve: (value) => resolve(value as T),
        reject
      });
      this.drain();
    });
  }

  private drain() {
    while (this.active < this.maximumActive && this.queue.length > 0) {
      const pending = this.queue.shift()!;
      this.active += 1;
      void Promise.resolve()
        .then(pending.work)
        .then(pending.resolve, pending.reject)
        .finally(() => {
          this.active -= 1;
          this.drain();
        });
    }
  }
}

const productionPasswordKdfGate = new PasswordKdfGate(1, 2);

export interface ScryptParameters {
  N: number;
  r: number;
  p: number;
  keyLength: number;
  saltLength: number;
  maxmem: number;
}

export const productionScryptParameters: Readonly<ScryptParameters> = {
  N: 2 ** 17,
  r: 8,
  p: 1,
  keyLength: 64,
  saltLength: 16,
  maxmem: 256 * 1024 * 1024
};

const encodedHashPattern = /^\$scrypt\$N=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;

function assertParameters(parameters: ScryptParameters) {
  const isPowerOfTwo = parameters.N > 1 && (parameters.N & (parameters.N - 1)) === 0;
  if (!isPowerOfTwo || parameters.N < 2 ** 10 || parameters.N > 2 ** 20) throw new Error("scrypt N 参数不合法");
  if (!Number.isInteger(parameters.r) || parameters.r < 1 || parameters.r > 32) throw new Error("scrypt r 参数不合法");
  if (!Number.isInteger(parameters.p) || parameters.p < 1 || parameters.p > 16) throw new Error("scrypt p 参数不合法");
  if (!Number.isInteger(parameters.keyLength) || parameters.keyLength < 32 || parameters.keyLength > 128) throw new Error("scrypt 输出长度不合法");
  if (!Number.isInteger(parameters.saltLength) || parameters.saltLength < 16 || parameters.saltLength > 64) throw new Error("scrypt salt 长度不合法");
  const requiredMemory = 128 * parameters.N * parameters.r + 1024 * 1024;
  if (!Number.isInteger(parameters.maxmem) || parameters.maxmem < requiredMemory || parameters.maxmem > 512 * 1024 * 1024) {
    throw new Error("scrypt 内存参数不合法");
  }
}

function passwordBytes(password: string) {
  const bytes = Buffer.byteLength(password, "utf8");
  if (password.length < BI_PASSWORD_MIN_LENGTH || password.length > BI_PASSWORD_MAX_LENGTH || bytes > 1024) {
    throw new Error(`密码长度必须为 ${BI_PASSWORD_MIN_LENGTH}～${BI_PASSWORD_MAX_LENGTH} 个字符`);
  }
  return password;
}

function deriveKey(
  password: string,
  salt: Buffer,
  keyLength: number,
  parameters: ScryptParameters,
  gate: PasswordKdfGate
) {
  return gate.run(() => new Promise<Buffer>((resolve, reject) => {
    nodeScrypt(password, salt, keyLength, {
      N: parameters.N,
      r: parameters.r,
      p: parameters.p,
      maxmem: parameters.maxmem
    }, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  }));
}

export async function hashPassword(
  password: string,
  parameters: ScryptParameters = productionScryptParameters,
  gate: PasswordKdfGate = productionPasswordKdfGate
) {
  assertParameters(parameters);
  const salt = randomBytes(parameters.saltLength);
  const derived = await deriveKey(passwordBytes(password), salt, parameters.keyLength, parameters, gate);
  return `$scrypt$N=${parameters.N},r=${parameters.r},p=${parameters.p}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function verifyPassword(
  password: string,
  encodedHash: string,
  gate: PasswordKdfGate = productionPasswordKdfGate
) {
  const match = encodedHashPattern.exec(encodedHash);
  if (!match) return false;
  const [, N, r, p, encodedSalt, encodedExpected] = match;
  const salt = Buffer.from(encodedSalt, "base64url");
  const expected = Buffer.from(encodedExpected, "base64url");
  const parameters: ScryptParameters = {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    keyLength: expected.length,
    saltLength: salt.length,
    maxmem: Math.min(512 * 1024 * 1024, 128 * Number(N) * Number(r) + 2 * 1024 * 1024)
  };
  try {
    assertParameters(parameters);
    passwordBytes(password);
  } catch {
    return false;
  }
  const received = await deriveKey(password, salt, expected.length, parameters, gate);
  return expected.length === received.length && timingSafeEqual(expected, received);
}
