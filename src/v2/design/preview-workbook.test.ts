import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { buildPreviewWorkbook, type WorkbookSheet } from "./preview-workbook";

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
