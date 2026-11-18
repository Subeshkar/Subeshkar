// Polished Excel workbooks for Dioma (make_excel): title, yellow input cells feeding live formulas,
// brand-coloured header rows, money formats, bold totals, frozen header, sensible widths.
import { createRequire } from 'node:module';
export async function build(sheets, brand) {
    const ExcelJS = createRequire(import.meta.url)('exceljs'); const wb = new ExcelJS.Workbook(); wb.creator = 'Dioma'; wb.calcProperties = { fullCalcOnLoad: true };
  const BR = String(brand || 'C00000').replace(/^#/, '').toUpperCase().slice(0, 6) || 'C00000';
  for (const sh of (sheets || []).slice(0, 10)) {
    const ws = wb.addWorksheet(String(sh.name || 'Sheet').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31), { views: [{ showGridLines: false }] });
    ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } };
    let r0 = 1;
    if (sh.title) { const c = ws.getCell(1, 1); c.value = String(sh.title); c.font = { bold: true, size: 14, color: { argb: 'FF' + BR } }; r0 = 3; if (sh.subtitle) { ws.getCell(2, 1).value = String(sh.subtitle); ws.getCell(2, 1).font = { italic: true, color: { argb: 'FF666666' } }; } }
    const rows = (sh.rows || []).slice(0, 5000); const heads = new Set((sh.header_rows || [0]).map(Number)), bolds = new Set((sh.bold_rows || []).map(Number)), secs = new Set((sh.section_rows || []).map(Number));
    const shift = (f) => r0 === 1 ? f : f.replace(/(\$?)([A-Z]{1,3})(\$?)(\d+)(?![\d(])/g, (m, a, col, b, n) => a + col + b + (Number(n) + r0 - 1)); // their formulas count from row 1 of the data
    let maxC = 0;
    rows.forEach((row, i) => {
      const R = ws.getRow(r0 + i); const cells = Array.isArray(row) ? row : [row]; maxC = Math.max(maxC, cells.length);
      cells.forEach((cv, j) => {
        const c = R.getCell(j + 1); const o = cv && typeof cv === 'object' && !Array.isArray(cv) ? cv : { v: cv }; let v = o.v ?? o.value ?? null;
        if (typeof v === 'string' && v.startsWith('=')) c.value = { formula: shift(v.slice(1)) }; else c.value = v;
        const isNum = typeof v === 'number' || (typeof v === 'string' && v.startsWith('='));
        if (o.fmt) c.numFmt = String(o.fmt); else if (o.pct) c.numFmt = '0.0%'; else if (isNum && !heads.has(i) && !(Number.isInteger(v) && Math.abs(v) < 1000 && !o.money)) c.numFmt = '#,##0.00';
        if (heads.has(i)) { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + BR } }; c.alignment = { vertical: 'middle', wrapText: true }; }
        else if (secs.has(i)) c.font = { bold: true, size: 12 };
        if (o.input) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
        if (o.bold || bolds.has(i)) c.font = { ...(c.font || {}), bold: true };
        if (bolds.has(i) || o.total) c.border = { top: { style: 'thin', color: { argb: 'FF999999' } } };
        if (!heads.has(i) && !secs.has(i) && v !== null && v !== '') c.border = { ...(c.border || {}), bottom: { style: 'hair', color: { argb: 'FFDDDDDD' } } };
      });
      if (heads.has(i)) R.height = 22;
    });
    for (let j = 1; j <= maxC; j++) ws.getColumn(j).width = (sh.widths && sh.widths[j - 1]) || Math.min(42, Math.max(10, ...rows.map((r) => { const x = Array.isArray(r) ? r[j - 1] : ''; const v = x && typeof x === 'object' ? (x.v ?? '') : x; return typeof v === 'string' && v.startsWith('=') ? 12 : String(v ?? '').length + 3; })));
    const fh = [...heads].sort((a, b) => a - b)[0]; if (fh !== undefined && sh.freeze !== false && heads.size === 1) ws.views = [{ state: 'frozen', ySplit: r0 + fh, showGridLines: false }];
    if (sh.note) { const n = ws.getCell(r0 + rows.length + 1, 1); n.value = String(sh.note); n.font = { italic: true, color: { argb: 'FF666666' } }; }
  }
  if (!wb.worksheets.length) return null;
  return Buffer.from(await wb.xlsx.writeBuffer());
}
