import { expect, test } from "bun:test";
import { metricBusinessDefinition } from "./metric-description";

test("业务定义优先引用推荐正文，保留源文本与历史技术口径", () => {
  const authority = Object.freeze({ definition: "现有后台未登记。", recommendedDefinition: "  每名付费用户平均贡献的实际支付金额。  " });
  expect(metricBusinessDefinition(authority)).toBe(authority.recommendedDefinition);
  expect(authority.definition).toBe("现有后台未登记。");
});

test("业务定义将同义引用哨兵及空推荐回溯至现有定义", () => {
  for (const recommendedDefinition of [undefined, null, "", "  ", "与现有定义一致", " 与现有定义一致 ", "与现有定义一致。", "与现有定义一致."]) {
    expect(metricBusinessDefinition({ definition: "业务日内至少成功登录一次的去重用户数。", recommendedDefinition }))
      .toBe("业务日内至少成功登录一次的去重用户数。");
  }
});
