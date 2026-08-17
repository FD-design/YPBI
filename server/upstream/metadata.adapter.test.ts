import { describe, expect, test } from "bun:test";
import { MetadataAdapter } from "./metadata.adapter";

describe("MetadataAdapter", () => {
  test("分类树只返回可用于筛选的轻量结构", async () => {
    const client = { get: async () => ({ code: 200, msg: [{ id: "A", name: "平台A", children: [{ id: "c1", name: "精选", type: "basic", children: [{ id: "x" }] }] }] }) } as any;
    expect(await new MetadataAdapter(client).categories()).toEqual([{ platformCode: "A", platformName: "平台A", groups: [{ id: "c1", name: "精选", type: "basic", childCount: 1 }] }]);
  });
  test("落地页模板不会透传Base64预览图", async () => {
    const client = { get: async () => ({ code: 200, msg: { pid: "PH", tmpl: [{ value: "default", label: "默认", previewHash: "hash", previewImage: "data:image/jpeg;base64,very-large" }] } }) } as any;
    const result = await new MetadataAdapter(client).landingTemplates("PH");
    expect(result.rows[0]).toEqual({ value: "default", label: "默认", previewHash: "hash" });
  });
  test("标签按ID去重后返回轻量列表", async () => {
    const client = { get: async () => ({ code: 200, msg: { pageData: [{ key: "tag", data: [{ id: "t1", name: "标签", type: "video" }, { id: "t1", name: "标签", type: "video" }] }] } }) } as any;
    const result = await new MetadataAdapter(client).tags("PH");
    expect(result).toMatchObject({ total: 2, uniqueTotal: 1, truncated: false });
    expect(result.rows).toHaveLength(1);
  });
});
