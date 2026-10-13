import { expect, spyOn, test } from "bun:test";
import { formatMetricNumber, metricNumberFormatOptions } from "./metric-number-format";

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

test("复用格式配置后两种语言、各精度与特殊数值逐字保持一致", () => {
  const values = [0, -0, 1, -1, .004, -.004, .09999, .1, 64 / 3600, 12345.6789, Number.MIN_VALUE, Number.MAX_VALUE, NaN, Infinity, -Infinity];
  for (const locale of ["en-US", "zh-CN"] as const) {
    for (const unit of ["人", "次", "次/人", "元", "元/人", "USD", "USD/人", "%", "小时", ""])
      for (const value of values) {
        const options = metricNumberFormatOptions(value, unit);
        expect(formatMetricNumber(value, locale, options)).toBe(value.toLocaleString(locale, options));
      }
    for (const value of values) expect(formatMetricNumber(value, locale, { maximumSignificantDigits: 4 })).toBe(value.toLocaleString(locale, { maximumSignificantDigits: 4 }));
  }
});

test("相同配置复用构造器，不缓存数值；超过上限后安全淘汰", () => {
  const Original = Intl.NumberFormat;
  const constructor = spyOn(Intl, "NumberFormat").mockImplementation((locales, options) => new Original(locales, options));
  try {
    const options = { minimumIntegerDigits: 17, maximumFractionDigits: 6 };
    expect(formatMetricNumber(1.25, "en-US", options)).toBe(new Original("en-US", options).format(1.25));
    expect(formatMetricNumber(2.75, "en-US", { ...options })).toBe(new Original("en-US", options).format(2.75));
    expect(constructor).toHaveBeenCalledTimes(1);
    for (let precision = 1; precision <= 21; precision++)
      for (const locale of ["en-US", "zh-CN"] as const) formatMetricNumber(3.5, locale, { minimumIntegerDigits: 18, maximumSignificantDigits: precision });
    const before = constructor.mock.calls.length;
    expect(formatMetricNumber(1.25, "en-US", options)).toBe(new Original("en-US", options).format(1.25));
    expect(constructor.mock.calls.length).toBe(before + 1);
    expect(formatMetricNumber(2.75, "en-US", options)).toBe(new Original("en-US", options).format(2.75));
    expect(constructor.mock.calls.length).toBe(before + 1);
  } finally {
    constructor.mockRestore();
  }
});
