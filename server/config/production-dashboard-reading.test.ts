import { describe, expect, test } from "bun:test";
import { loadEnv } from "./env";

const deployedOrigin = "https://187.77.129.207.nip.io";
const productionSource: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  UPSTREAM_API_BASE_URL: "https://primary.example.test",
  UPSTREAM_USER_NAME: "fake-primary-user",
  UPSTREAM_SECONDARY_API_BASE_URL: "https://secondary.example.test",
  UPSTREAM_SECONDARY_USER_NAME: "fake-secondary-user",
  TOKEN_MAINTENANCE_KEY: "fake-maintenance-password-2026",
  BI_IDENTITY_MODE: "local",
  BI_AUTH_DATABASE_URL: "postgres://fake-auth.example.test/ypbi",
  BI_AUTH_CSRF_SECRET: "fake-csrf-secret-with-at-least-32-characters",
  BI_PUBLIC_ORIGIN: deployedOrigin
};

describe("正式日看板读取配置", () => {
  for (const nodeEnv of ["development", "test"] as const) {
    test(`${nodeEnv} 普通配置默认关闭正式日看板读取`, () => {
      expect(loadEnv({ NODE_ENV: nodeEnv }).BI_PRODUCTION_DASHBOARD_READING_ENABLED).toBe(false);
      expect(loadEnv({ NODE_ENV: nodeEnv, BI_PUBLIC_ORIGIN: deployedOrigin }).BI_PRODUCTION_DASHBOARD_READING_ENABLED).toBe(false);
    });
  }

  for (const origin of [deployedOrigin, `${deployedOrigin}/`]) {
    test(`唯一生产部署 ${origin} 默认开启正式日看板读取`, () => {
      const env = loadEnv({ ...productionSource, BI_PUBLIC_ORIGIN: origin });
      expect(env.BI_PRODUCTION_DASHBOARD_READING_ENABLED).toBe(true);
      expect(env.BI_LOCAL_DASHBOARD_READING_ENABLED).toBe(false);
      expect(env.BI_V2_CORE_OVERVIEW_QUERY_ENABLED).toBe(false);
    });
  }

  test("显式 false 优先于单一部署默认值，可独立关闭正式读取", () => {
    const env = loadEnv({ ...productionSource, BI_PRODUCTION_DASHBOARD_READING_ENABLED: "false" });
    expect(env.BI_PRODUCTION_DASHBOARD_READING_ENABLED).toBe(false);
    expect(env.BI_TEST_DATA_PREVIEW_ENABLED).toBe(true);
  });

  for (const origin of ["https://unknown.example.test", "https://187.77.129.207.nip.io:8443", "https://187.77.129.207.nip.io.other.example.test"]) {
    test(`未登记生产 Origin ${origin} 默认关闭正式读取`, () => {
      expect(loadEnv({ ...productionSource, BI_PUBLIC_ORIGIN: origin }).BI_PRODUCTION_DASHBOARD_READING_ENABLED).toBe(false);
    });
  }

  test("正式读取配置只接受明确 true 或 false", () => {
    expect(loadEnv({ ...productionSource, BI_PRODUCTION_DASHBOARD_READING_ENABLED: "true" }).BI_PRODUCTION_DASHBOARD_READING_ENABLED).toBe(true);
    for (const value of ["1", "yes", "TRUE"]) {
      expect(() => loadEnv({ ...productionSource, BI_PRODUCTION_DASHBOARD_READING_ENABLED: value })).toThrow("环境变量配置错误");
    }
  });

  test("正式读取默认值保持既有测试预览的地址、用户名与默认状态", () => {
    const env = loadEnv(productionSource);
    expect(env.BI_TEST_DATA_PREVIEW_ENABLED).toBe(true);
    expect(env.UPSTREAM_TEST_API_BASE_URL).toBe("https://douyin.yah96.com");
    expect(env.UPSTREAM_TEST_USER_NAME).toBe("fake-primary-user");
    const disabled = loadEnv({ ...productionSource, BI_TEST_DATA_PREVIEW_ENABLED: "false" });
    expect(disabled.BI_PRODUCTION_DASHBOARD_READING_ENABLED).toBe(true);
    expect(disabled.BI_TEST_DATA_PREVIEW_ENABLED).toBe(false);
  });

  test("本地读取继续只允许非生产环境的 loopback 监听", () => {
    expect(loadEnv({ NODE_ENV: "test", HOST: "127.0.0.1", BI_LOCAL_DASHBOARD_READING_ENABLED: "true" }).BI_LOCAL_DASHBOARD_READING_ENABLED).toBe(true);
    expect(() => loadEnv({ NODE_ENV: "development", HOST: "0.0.0.0", BI_LOCAL_DASHBOARD_READING_ENABLED: "true" })).toThrow("本地真实看板读取仅允许");
    expect(() => loadEnv({ ...productionSource, BI_LOCAL_DASHBOARD_READING_ENABLED: "true" })).toThrow("本地真实看板读取仅允许");
  });
});
