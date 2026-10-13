import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { buildPreviewWorkbook, prepareWorkbookSheets, type WorkbookSheet } from "./preview-workbook";

function part(bytes: Uint8Array, name: string) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decode = new TextDecoder();
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    const size = view.getUint32(offset + 18, true), nameLength = view.getUint16(offset + 26, true), extraLength = view.getUint16(offset + 28, true);
    const dataStart = offset + 30 + nameLength + extraLength;
    if (decode.decode(bytes.subarray(offset + 30, offset + 30 + nameLength)) === name) return decode.decode(bytes.subarray(dataStart, dataStart + size));
    offset = dataStart + size;
  }
  throw new Error("工作簿缺少预期部分");
}

test("实际工作簿支持两期合法分组产生的162001行，保留首末值和空值", () => {
  const v8 = spawnSync("node", ["--input-type=module", "-e", `
    import { buildPreviewWorkbook } from ${JSON.stringify(new URL("./preview-workbook.ts", import.meta.url).href)};
    buildPreviewWorkbook([{ name: "内存大表", rows: Array.from({ length: 162001 }, () => [null]) }]);
  `], { encoding: "utf8", timeout: 10000 });
  expect({ exitCode: v8.status, error: v8.stderr }).toEqual({ exitCode: 0, error: "" });
  const rows: WorkbookSheet["rows"] = Array.from({ length: 162001 }, () => [null]);
  rows[0] = [0, null, "首行", "=1+1"];
  rows[162000] = [23.45, "末行"];
  const output = buildPreviewWorkbook([{ name: "内存大表", rows }]);
  const xml = part(output, "xl/worksheets/sheet1.xml");
  expect(xml.match(/<row r=/g)).toHaveLength(162001);
  expect(xml).toContain('<c r="A1"><v>0</v></c><c r="B1"/>');
  expect(xml).toContain('<t xml:space="preserve">=1+1</t>');
  expect(xml).not.toContain("<f>");
  expect(xml).toContain('<c r="A81000"/>');
  expect(xml).toContain('<c r="A162001"><v>23.45</v></c>');
  expect(xml).toContain('<c r="B162001" t="inlineStr"><is><t xml:space="preserve">末行</t>');
  expect(xml.match(/<col min=/g)).toHaveLength(4);
  expect(rows[0]).toEqual([0, null, "首行", "=1+1"]);
  expect(rows[162000]).toEqual([23.45, "末行"]);
});

test("空工作表保留单列，参差行宽按最宽行生成，数值及文本格式保持", () => {
  const sheets: WorkbookSheet[] = [
    { name: "空表", rows: [] },
    { name: "参差行", rows: [[], [0, null], [12.345, "<>&", "=SUM(A1)", "单位（元/人）"]] }
  ];
  const original = JSON.stringify(sheets);
  const output = buildPreviewWorkbook(sheets);
  const empty = part(output, "xl/worksheets/sheet1.xml");
  const ragged = part(output, "xl/worksheets/sheet2.xml");
  expect(empty.match(/<col min=/g)).toHaveLength(1);
  expect(empty).toContain("<sheetData></sheetData>");
  expect(ragged.match(/<col min=/g)).toHaveLength(4);
  expect(ragged).toContain('<row r="1"></row>');
  expect(ragged).toContain('<c r="A2"><v>0</v></c><c r="B2"/>');
  expect(ragged).toContain('<c r="A3"><v>12.345</v></c>');
  expect(ragged).toContain("&lt;&gt;&amp;");
  expect(ragged).toContain('<t xml:space="preserve">=SUM(A1)</t>');
  expect(ragged).not.toContain("<f>");
  expect(JSON.stringify(sheets)).toBe(original);
});

test("纯文本与需转义文本保留原始工作簿字节、数值、表名和公式字面量", () => {
  const sheets: WorkbookSheet[] = [
    { name: "  渠道/明细  ", rows: [[], [0, null, -1.25, NaN, Infinity, "普通中文", "ASCII text", "😀", "\"'&<>", "\u0000\u0007\u000B\u000C\u001F\t\n\r", "=SUM(A1)"]] },
    { name: "渠道:明细", rows: [Array.from({ length: 750 }, (_, i) => i % 3 === 0 ? null : i % 3 === 1 ? i : "数据")] }
  ];
  const prepared = prepareWorkbookSheets(sheets);
  const output = buildPreviewWorkbook(prepared);
  expect(output.length).toBe(72206);
  expect(createHash("sha256").update(output).digest("hex")).toBe("c559096a757ba12112239656bc7397b40d132f88ba45373babc0694fcefd15b6");
  expect(prepared.map(sheet => sheet.name)).toEqual(["渠道·明细", "渠道·明细 (2)", "工作表索引"]);
  const xml = part(output, "xl/worksheets/sheet1.xml");
  expect(xml).toContain('<c r="A2"><v>0</v></c><c r="B2"/><c r="C2"><v>-1.25</v></c>');
  for (const text of ["NaN", "Infinity", "普通中文", "ASCII text", "😀", "=SUM(A1)"]) expect(xml).toContain(`<t xml:space="preserve">${text}</t>`);
  expect(xml).toContain("&quot;&apos;&amp;&lt;&gt;");
  expect(xml).toContain('<t xml:space="preserve">\t\n\r</t>');
  expect(xml).not.toContain("<f>");
  expect(sheets[0].name).toBe("  渠道/明细  ");
  expect(Number.isNaN(sheets[0].rows[1][3])).toBe(true);
  expect(sheets[0].rows[1][4]).toBe(Infinity);
});

test("全部C0控制符沿用XML清理规则，合法空白与表名特殊字符保留", () => {
  const controls = Array.from({ length: 32 }, (_, code) => `x${String.fromCharCode(code)}y`);
  const output = buildPreviewWorkbook([{ name: "名称&<\"'>", rows: [controls, ["\u0085\u2028\u2029😀"]] }]);
  const xml = part(output, "xl/worksheets/sheet1.xml");
  for (let code = 0; code < controls.length; code++) {
    const expected = [9, 10, 13].includes(code) ? controls[code] : "xy";
    expect(xml).toContain(`<t xml:space="preserve">${expected}</t>`);
  }
  expect(xml).toContain('<t xml:space="preserve">\u0085\u2028\u2029😀</t>');
  expect(part(output, "xl/workbook.xml")).toContain('name="名称&amp;&lt;&quot;&apos;&gt;"');
});
