export type WorkbookCell = string | number | null;
export interface WorkbookSheet { name: string; rows: WorkbookCell[][] }
const encode = (text: string) => new TextEncoder().encode(text);
const xml = (text: string) => text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
function column(index: number): string { let result = ""; for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(65 + (n - 1) % 26) + result; return result; }
const crcTable = Array.from({ length: 256 }, (_, index) => { let value = index; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1; return value >>> 0; });
function crc32(data: Uint8Array) { let crc = 0xFFFFFFFF; for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xFFFFFFFF) >>> 0; }
/** Small, dependency-free OOXML workbook. Text is always inline text, never a formula. */
export function buildPreviewWorkbook(sheets: WorkbookSheet[]): Uint8Array<ArrayBuffer> {
  if (!sheets.length || new Set(sheets.map(sheet => sheet.name)).size !== sheets.length || sheets.some(sheet => !sheet.name || sheet.name.length > 31 || /[\\/*?:\[\]]/.test(sheet.name))) throw new Error("工作表名称无效");
  const ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const files = [
    { name: "[Content_Types].xml", text: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>` },
    { name: "_rels/.rels", text: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", text: `<workbook xmlns="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sheet, i) => `<sheet name="${xml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", text: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>` },
    ...sheets.map((sheet, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, text: `<worksheet xmlns="${ns}"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${Array.from({ length: Math.max(1, ...sheet.rows.map(row => row.length)) }, (_, index) => `<col min="${index + 1}" max="${index + 1}" width="${index === 0 ? 30 : 22}" customWidth="1"/>`).join("")}</cols><sheetData>${sheet.rows.map((row, r) => `<row r="${r + 1}">${row.map((cell, c) => { const ref = column(c) + (r + 1); if (cell === null) return `<c r="${ref}"/>`; return typeof cell === "number" && Number.isFinite(cell) ? `<c r="${ref}"><v>${cell}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(String(cell))}</t></is></c>`; }).join("")}</row>`).join("")}</sheetData></worksheet>` }))
  ];
  const chunks: Uint8Array[] = [], central: Uint8Array[] = []; let offset = 0;
  for (const file of files) {
    const name = encode(file.name), data = encode(file.text), crc = crc32(data);
    const header = new Uint8Array(30 + name.length), view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(6, 0x800, true); view.setUint32(14, crc, true); view.setUint32(18, data.length, true); view.setUint32(22, data.length, true); view.setUint16(26, name.length, true); header.set(name, 30);
    const record = new Uint8Array(46 + name.length), cv = new DataView(record.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x800, true); cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true); cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true); record.set(name, 46);
    chunks.push(header, data); central.push(record); offset += header.length + data.length;
  }
  const centralSize = central.reduce((total, bytes) => total + bytes.length, 0);
  const end = new Uint8Array(22), ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true); ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);
  const result = new Uint8Array(offset + centralSize + 22); let cursor = 0;
  for (const bytes of [...chunks, ...central, end]) { result.set(bytes, cursor); cursor += bytes.length; }
  return result;
}
export function prepareWorkbookSheets(sheets: WorkbookSheet[]): WorkbookSheet[] {
  const used = new Set<string>();
  const allocate = (name: string) => {
    const base = name.replace(/[\\/*?:\[\]]/g, "·").replace(/^'+|'+$/g, "").trim() || "工作表";
    let suffix = "", next = 1, candidate: string;
    do {
      candidate = base.slice(0, 31 - suffix.length).replace(/[\uD800-\uDBFF]$/, "") + suffix;
      suffix = ` (${++next})`;
    } while (used.has(candidate.toLocaleLowerCase()));
    used.add(candidate.toLocaleLowerCase());
    return candidate;
  };
  const prepared = sheets.map(sheet => ({ ...sheet, name: allocate(sheet.name) }));
  if (prepared.some((sheet, i) => sheet.name !== sheets[i].name)) prepared.push({
    name: allocate("工作表索引"), rows: [["工作表名称", "完整名称"], ...sheets.map((sheet, i) => [prepared[i].name, sheet.name])]
  });
  return prepared;
}

export function downloadPreviewWorkbook(name: string, sheets: WorkbookSheet[], origin: "demo" | "pending" | "mixed" = "demo") {
  const url = URL.createObjectURL(new Blob([buildPreviewWorkbook(prepareWorkbookSheets(sheets))], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${name}-${origin === "pending" ? "待验数" : origin === "mixed" ? "来源分列" : "演示数据"}.xlsx`;
  link.hidden = true;
  // Keep activation inside the current modal's non-inert subtree.
  const surface = document.activeElement?.closest("dialog[open]") ?? document.body;
  surface.append(link);
  try { link.click(); } finally {
    link.remove();
    // Navigation consumes the Blob asynchronously; do not revoke during activation.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}
