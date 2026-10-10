import { expect, test } from "bun:test";
import { metricNumberFormatOptions } from "./metric-number-format";

test("小额人均数值使用四位小数精度，普通数值保持既定精度", () => {
  for (const unit of ["元/人", "人民币元/人", "USD/人", "次/人"]) {
    for (const value of [.004, -.004, .0105, -.0105]) {
      expect(value.toLocaleString("zh-CN", metricNumberFormatOptions(value, unit))).toBe(String(value));
    }
    expect(metricNumberFormatOptions(0, unit).maximumFractionDigits).toBe(2);
    expect(metricNumberFormatOptions(.1, unit).maximumFractionDigits).toBe(2);
    expect((12345.6789).toLocaleString("zh-CN", metricNumberFormatOptions(12345.6789, unit))).toBe("12,345.68");
  }
  expect(metricNumberFormatOptions(.004, "元")).toEqual({ maximumFractionDigits: 2, minimumFractionDigits: 0 });
  for (const unit of ["人", "次"]) expect(metricNumberFormatOptions(12.34, unit)).toEqual({ maximumFractionDigits: 0, minimumFractionDigits: 0 });
  expect(metricNumberFormatOptions(.004, "%")).toEqual({ maximumFractionDigits: 2, minimumFractionDigits: 2 });
});
