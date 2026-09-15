import { describe, expect, test } from "bun:test";
import { validateAuthDatabaseUrl } from "./database";

describe("auth database URL", () => {
  test("允许标准 PostgreSQL URL 与传输参数", () => {
    expect(validateAuthDatabaseUrl("postgres://ypbi:secret@db.example.test/ypbi?sslmode=require"))
      .toBe("postgres://ypbi:secret@db.example.test/ypbi?sslmode=require");
    expect(validateAuthDatabaseUrl("postgresql://db.example.test/ypbi"))
      .toBe("postgresql://db.example.test/ypbi");
  });

  test("拒绝 URL 参数关闭超时或改变认证会话语义", () => {
    for (const parameter of [
      "statement_timeout=0",
      "LOCK_TIMEOUT=0",
      "idle_in_transaction_session_timeout=0",
      "options=-c%20statement_timeout%3D0",
      "search_path=public%2Cattacker"
    ]) {
      expect(() => validateAuthDatabaseUrl(`postgres://db.example.test/ypbi?${parameter}`))
        .toThrow("禁止通过查询参数覆盖账号库会话配置");
    }
  });

  test("拒绝非 PostgreSQL 或无法解析的地址", () => {
    expect(() => validateAuthDatabaseUrl("https://db.example.test/ypbi")).toThrow("必须使用 postgres://");
    expect(() => validateAuthDatabaseUrl("not-a-database-url")).toThrow("合法的 PostgreSQL URL");
  });
});
