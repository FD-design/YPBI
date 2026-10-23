import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { authenticatedSession, biAuthPlugin } from "../auth/plugin";
import { LOCAL_BI_SESSION_COOKIE } from "../auth/cookies";
import type { BiAuthService, ResolvedAuthSession } from "../auth/service";
import { v2BiPlugin } from "../v2/plugin";
import { DailyDashboardService } from "../v2/daily-dashboard.service";
import { resolveIdentity } from "./resolve-identity";
import {
  freezeIdentityLookupFailure, identityLookupFailureDiagnostics,
  markIdentityLookupPhase, recordIdentityStorageFailure
} from "./identity-lookup-diagnostics";

const authenticated = {
  status: "authenticated",
  principal: { subjectId: "deadline-user", roles: ["reader"], permissions: ["bi:read"], pidScope: "all" }
} as const;
const session = { principal: { subjectId: "deadline-user" } } as ResolvedAuthSession;
const deadlineMs = 12;
function block() { const until = performance.now() + 30; while (performance.now() < until) {} }
type Work = (signal: AbortSignal) => Promise<unknown>;

function fixture(boundary: "identity" | "session", work: Work, timeoutMs = deadlineMs) {
  const external = new AbortController();
  const request = {
    headers: { cookie: `ypbi_session=${"a".repeat(43)}` },
    raw: Object.assign(new EventEmitter(), { aborted: false })
  } as unknown as FastifyRequest;
  const reply = { raw: Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false }) } as unknown as FastifyReply;
  let signal: AbortSignal | undefined;
  const read = (current: AbortSignal) => { signal = current; markIdentityLookupPhase(current, "query"); return work(current); };
  return {
    run: () => boundary === "identity"
      ? resolveIdentity({ resolve: current => read(current.signal) as Promise<typeof authenticated> }, { headers: {}, ip: "127.0.0.1", signal: external.signal }, timeoutMs)
      : authenticatedSession(request, reply, { resolveSession: (_token: string, current: AbortSignal) => read(current) } as unknown as BiAuthService, "ypbi_session", timeoutMs),
    abort: (reason: Error) => boundary === "identity" ? external.abort(reason) : request.raw.emit("aborted"),
    signal: () => signal!,
    diagnostics: () => identityLookupFailureDiagnostics(boundary === "identity" ? external.signal : request)
  };
}

describe("身份绝对期限结算", () => {
  for (const boundary of ["identity", "session"] as const) {
    const valid = boundary === "identity" ? authenticated : session;
    const timeoutMessage = boundary === "identity" ? "identity_timeout" : "auth_session_lookup_timeout";
    for (const timing of ["同步", "微任务"] as const) {
      for (const outcome of ["成功", "异常"] as const) {
        test(`${boundary}${timing}阻塞后${outcome}在原期限外结算时返回期限错误`, async () => {
          const failure = new Error("synthetic overdue failure");
          const finish = () => { block(); if (outcome === "异常") throw failure; return valid; };
          const current = fixture(boundary, () => timing === "同步" ? Promise.resolve(finish()) : Promise.resolve().then(finish));
          await expect(current.run()).rejects.toThrow(timeoutMessage);
          expect(current.signal().aborted).toBe(true);
          expect(current.diagnostics()).toMatchObject({ failureCode: "deadline_exceeded", phase: "query", deadlineMs });
          expect(current.diagnostics().elapsedMs!).toBeGreaterThanOrEqual(deadlineMs);
        });
      }
    }

    test(`${boundary}期限内成功和异常保持原结果`, async () => {
      const success = fixture(boundary, async () => valid, 1000);
      const result = await success.run();
      expect(boundary === "identity" ? result : Reflect.get(result, "session")).toEqual(valid);
      expect(success.signal().aborted).toBe(false);
      const failure = new Error("synthetic timely failure");
      const failed = fixture(boundary, async () => { throw failure; }, 1000);
      await expect(failed.run()).rejects.toBe(failure);
      expect(failed.signal().aborted).toBe(false);
      expect(failed.diagnostics().failureCode).toBe("unknown");
    });

    test(`${boundary}已冻结的客户端取消在堵塞超过期限后保持原分类`, async () => {
      let current: ReturnType<typeof fixture>;
      const reason = new Error("synthetic disconnected client");
      current = fixture(boundary, async () => { current.abort(reason); block(); return valid; });
      await expect(current.run()).rejects.toThrow(boundary === "identity" ? reason.message : "auth_request_aborted");
      expect(current.diagnostics()).toMatchObject({ failureCode: "client_aborted", phase: "query" });
    });

    test(`${boundary}提前冻结的存储失败在期限外结算时更新为期限诊断`, async () => {
      const failure = Object.assign(new Error("synthetic connection failure"), { code: "ECONNRESET" });
      const current = fixture(boundary, async signal => {
        recordIdentityStorageFailure(signal, failure);
        freezeIdentityLookupFailure(signal);
        await Promise.resolve(); block(); throw failure;
      });
      await expect(current.run()).rejects.toThrow(timeoutMessage);
      expect(current.diagnostics()).toMatchObject({ failureCode: "deadline_exceeded", phase: "query", storageFailureCode: "connection_unavailable" });
    });

    test(`${boundary}提前冻结存储失败后客户端断连仍优先保留取消分类`, async () => {
      let current: ReturnType<typeof fixture>;
      const reason = new Error("synthetic client abort after storage snapshot");
      const failure = Object.assign(new Error("synthetic stored failure"), { code: "ECONNRESET" });
      current = fixture(boundary, async signal => {
        recordIdentityStorageFailure(signal, failure);
        freezeIdentityLookupFailure(signal);
        current.abort(reason); block(); throw failure;
      });
      await expect(current.run()).rejects.toThrow(boundary === "identity" ? reason.message : "auth_request_aborted");
      expect(current.diagnostics()).toMatchObject({ failureCode: "client_aborted", phase: "query" });
    });

    test(`${boundary}迟到存储快照先推断超时但客户端先取消时保留取消分类`, async () => {
      let current: ReturnType<typeof fixture>;
      const reason = new Error("synthetic client abort before deadline settlement");
      current = fixture(boundary, async signal => {
        block(); recordIdentityStorageFailure(signal, { code: "ECONNRESET" });
        freezeIdentityLookupFailure(signal); current.abort(reason);
        return valid;
      });
      await expect(current.run()).rejects.toThrow(boundary === "identity" ? reason.message : "auth_request_aborted");
      expect(current.diagnostics()).toMatchObject({ failureCode: "client_aborted", phase: "query" });
    });
  }

  for (const cancelled of [false, true]) test(`身份契约解析期间${cancelled ? "客户端取消" : "堵塞超过期限"}时不授予身份`, async () => {
    let current: ReturnType<typeof fixture>;
    const reason = new Error("synthetic cancellation during validation");
    const resolution = { ...authenticated, principal: {
      ...authenticated.principal,
      get roles() { if (cancelled) current.abort(reason); else block(); return ["reader"]; }
    } };
    current = fixture("identity", async () => resolution);
    await expect(current.run()).rejects.toThrow(cancelled ? reason.message : "identity_timeout");
    expect(current.diagnostics().failureCode).toBe(cancelled ? "client_aborted" : "deadline_exceeded");
  });

  for (const boundary of ["identity", "session"] as const) for (const failed of [false, true]) {
    test(`${boundary}路由将迟到${failed ? "异常" : "身份"}返回原503契约且不进入业务`, async () => {
      const logs: Record<string, unknown>[] = [];
      const app = Fastify({ logger: { level: "warn", stream: { write: (line: string) => { logs.push(JSON.parse(line)); } } } });
      let entries = 0;
      const read = async (signal: AbortSignal) => {
        markIdentityLookupPhase(signal, "query"); await Promise.resolve(); block();
        if (failed) throw new Error("synthetic overdue route failure");
      };
      try {
        if (boundary === "identity") await app.register(v2BiPlugin, {
          prefix: "/api/bi/v2", identityTimeoutMs: deadlineMs,
          identityProvider: { resolve: async ({ signal }) => { await read(signal); return authenticated; } },
          metricQueryService: { execute: async () => { throw new Error("unexpected metric query"); } },
          productionDailyDashboardEnabled: true,
          dailyDashboardService: { execute: (query, signal) => {
            entries++;
            return new DailyDashboardService({ get: async path => path.includes("/bi/v1/")
              ? { code: 200, msg: { metricVersion: "bi-v1", generatedAt: "2026-10-17T00:00:00Z", watermark: null, rows: [] } }
              : { msg: { pageData: [], totalCount: 0, totalData: [] }, data: [] } }, () => new Date("2026-10-17T00:00:00Z")).execute(query, signal);
          } }
        });
        else await app.register(biAuthPlugin, {
          prefix: "/auth", sessionCookie: LOCAL_BI_SESSION_COOKIE, sessionLookupTimeoutMs: deadlineMs,
          authService: {
            resolveSession: async (_token: string, signal: AbortSignal) => { await read(signal); return session; },
            sessionData: () => { entries++; return { active: true }; }
          } as unknown as BiAuthService
        });
        const response = await app.inject({ method: boundary === "identity" ? "POST" : "GET", url: boundary === "identity" ? "/api/bi/v2/queries/dashboards/daily-reading" : "/auth/session",
          ...(boundary === "identity" ? { payload: { boardId: "5.2", pid: "PH", dateRange: ["2026-10-16", "2026-10-16"] } } : {}),
          headers: { cookie: `ypbi_session=${"a".repeat(43)}` } });
        expect(response.statusCode).toBe(503);
        expect(response.json().error).toMatchObject({ code: boundary === "identity" ? "IDENTITY_PROVIDER_UNAVAILABLE" : "AUTH_SERVICE_UNAVAILABLE", requestId: expect.any(String) });
        expect(entries).toBe(0);
        expect(logs).toHaveLength(1);
        expect(logs[0]).toMatchObject({ identityLookup: { failureCode: "deadline_exceeded", phase: "query", deadlineMs } });
        expect(response.body).not.toContain("synthetic overdue route failure");
        expect(response.body).not.toContain("identityLookup");
      } finally { await app.close(); }
    });
  }
});
