import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { bindClientRequestAbort } from "./client-request-abort";

function harness() {
  const request = Object.assign(new EventEmitter(), { aborted: false }) as unknown as IncomingMessage;
  const response = Object.assign(new EventEmitter(), {
    writableEnded: false,
    destroyed: false
  }) as unknown as ServerResponse;
  const controller = new AbortController();
  return { request, response, controller };
}

describe("bindClientRequestAbort", () => {
  test("request aborted 会取消进行中的工作", () => {
    const { request, response, controller } = harness();
    bindClientRequestAbort(request, response, controller);

    request.emit("aborted");

    expect(controller.signal.aborted).toBe(true);
  });

  test("响应完成前连接关闭会取消进行中的工作", () => {
    const { request, response, controller } = harness();
    bindClientRequestAbort(request, response, controller);

    response.emit("close");

    expect(controller.signal.aborted).toBe(true);
  });

  test("正常完成后的 close 不会误判为客户端中断", () => {
    const { request, response, controller } = harness();
    Object.assign(response, { writableEnded: true });
    bindClientRequestAbort(request, response, controller);

    response.emit("close");

    expect(controller.signal.aborted).toBe(false);
  });

  test("cleanup 后事件不再影响已结束的边界", () => {
    const { request, response, controller } = harness();
    const cleanup = bindClientRequestAbort(request, response, controller);
    cleanup();

    request.emit("aborted");
    response.emit("close");

    expect(controller.signal.aborted).toBe(false);
  });
});
