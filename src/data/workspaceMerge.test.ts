import { describe, expect, test } from "bun:test";
import type { DashboardTemplate } from "../types";
import { mergeTemplatesByRecency } from "./workspaceMerge";

const template = (id: string, updatedAt: string, title: string): DashboardTemplate => ({
  id,
  name: id,
  scenario: "",
  model: "business_overview",
  filters: ["date", "platform"],
  status: "published",
  updatedAt,
  cards: [{ id: "card", title, type: "kpi", model: "business_overview", metrics: ["dau"], dimensions: ["platform"], size: "full" }]
});

describe("mergeTemplatesByRecency", () => {
  test("保留远端没有的浏览器自定义模板", () => {
    const result = mergeTemplatesByRecency([template("overview", "2026-07-10", "远端")], [template("custom", "刚刚", "本地")]);
    expect(result.map((item) => item.id)).toEqual(["overview", "custom"]);
  });

  test("同ID模板保留较新的浏览器配置", () => {
    const result = mergeTemplatesByRecency(
      [template("overview", "2026-07-10", "旧配置")],
      [template("overview", "刚刚", "用户配置")]
    );
    expect(result[0].cards[0].title).toBe("用户配置");
  });

  test("同ID模板默认以服务器保存版本为准", () => {
    const result = mergeTemplatesByRecency(
      [template("overview", "2026-07-22 12:00", "服务器配置")],
      [template("overview", "2026-07-10", "浏览器旧配置")]
    );
    expect(result[0].cards[0].title).toBe("服务器配置");
  });
});
