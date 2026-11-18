// Fuel surcharge: read a fuel card statement (ENOC, ADNOC, Emarat… Excel or CSV), compare what each litre cost
// with the official UAE price in a base month, and work out the surcharge per vehicle. Blank odometer readings
// are filled from the fuel bought between known readings. Produces an Excel file and the numbers for an invoice.
import { createRequire } from 'node:module';
import { db, one, run } from './db.js';
import { claude } from './ai.js';
const XLSX = createRequire(import.meta.url)('xlsx');

db.exec('CREATE TABLE IF NOT EXISTS fuel_prices (month TEXT PRIMARY KEY, super98 REAL, special95 REAL, eplus91 REAL, diesel REAL, src TEXT, at INTEGER)');
// Official UAE Fuel Price Committee prices (AED per litre, VAT included). Other months are looked up once and kept.
const KNOWN = {
  '2026-01': [2.53, 2.42, 2.34, 2.55], '2026-10': [4.40, 4.28, 4.21, 4.80], '2026-11': [4.16, 4.04, 3.97, 4.75],
};
const KEYS = ['super98', 'special95', 'eplus91', 'diesel'];
export const LABEL = { super98: 'Super 98', special95: 'Special 95', eplus91: 'E-Plus 91', diesel: 'Diesel' };
export async function prices(month) {
  if (KNOWN[month]) return Object.fromEntries(KEYS.map((k, i) => [k, KNOWN[month][i]]));
  const r = one('SELECT * FROM fuel_prices WHERE month = ?', month); if (r) return { super98: r.super98, special95: r.special95, eplus91: r.eplus91, diesel: r.diesel };
  const res = await claude({ max_tokens: 800, tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
    messages: [{ role: 'user', content: `What were the official UAE fuel prices (AED per litre) set by the UAE Fuel Price Committee for ${month}? Answer with only JSON: {"super98":0,"special95":0,"eplus91":0,"diesel":0,"source":"url"}` }] });
  const t = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''); const m = t.match(/\{[\s\S]*\}/);
  const j = m ? JSON.parse(m[0]) : null; if (!j || !(j.eplus91 > 1 && j.eplus91 < 8)) throw Object.assign(new Error(`Could not find the official fuel prices for ${month}.`), { status: 404 });
  run('INSERT OR REPLACE INTO fuel_prices (month, super98, special95, eplus91, diesel, src, at) VALUES (?, ?, ?, ?, ?, ?, ?)', month, j.super98, j.special95, j.eplus91, j.diesel, String(j.source || ''), Date.now());
  return { super98: j.super98, special95: j.special95, eplus91: j.eplus91, diesel: j.diesel };
}
const kind = (p) => { p = String(p || ''); return /diesel/i.test(p) ? 'diesel' : /98|super/i.test(p) ? 'super98' : /95|special/i.test(p) ? 'special95' : /91|e.?plus/i.test(p) ? 'eplus91' : ''; };
const num = (v) => Number(String(v ?? '').replace(/[^0-9.-]/g, '')) || 0;
const when = (v) => v instanceof Date ? v : new Date(String(v || '').replace(' ', 'T').slice(0, 19));

// Read the statement: finds the columns by their names, keeps the fuel purchases.
export function read(buf) {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
  for (const sn of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: null });
    const hi = rows.findIndex((r) => r.some((c) => /plate|vehicle/i.test(String(c))) && r.some((c) => /quantity|litre|liter|volume/i.test(String(c))));
    if (hi < 0) continue;
    const H = rows[hi].map((c) => String(c || '').toLowerCase()), col = (re, not) => H.findIndex((h) => re.test(h) && !(not && not.test(h)));
    const c = { date: col(/date/), plate: col(/plate|vehicle/), odo: col(/odometer|odo|km/), type: col(/transaction type|^type$/), prod: col(/product|fuel type|grade/), qty: col(/quantity|litre|liter|volume/), price: col(/unit price|price per|rate/), total: col(/total amount|^total|amount incl/), };
    const out = [];
    rows.slice(hi + 1).forEach((r, i) => {
      if (c.type >= 0 && r[c.type] && !/purchase|sale|fuel/i.test(String(r[c.type]))) return;
      const qty = num(r[c.qty]); const k = kind(r[c.prod]); if (!qty || !r[c.plate]) return;
      const total = c.total >= 0 ? num(r[c.total]) : 0, price = c.price >= 0 ? num(r[c.price]) : total && qty ? total / qty : 0;
      out.push({ row: hi + 2 + i, at: when(r[c.date]), plate: String(r[c.plate]).trim(), odo: c.odo >= 0 && num(r[c.odo]) ? Math.round(num(r[c.odo])) : 0, product: String(r[c.prod] || ''), kind: k || 'eplus91', qty, price, total: total || qty * price });
    });
    if (out.length) return { sheet: sn, rows: out };
  }
  throw Object.assign(new Error('Dioma could not find fuel purchases in this file (it needs plate number and quantity columns).'), { status: 400 });
}

// The month most of the purchases are in, e.g. "2026-10".
export const monthOf = (rows) => { const c = {}; for (const r of rows) { const m = isNaN(r.at) ? '' : r.at.toISOString().slice(0, 7); c[m] = (c[m] || 0) + 1; } return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0] || ''; };

export function analyse(rows, base, opts = {}) {
  const by = {}; for (const r of rows) (by[r.plate] = by[r.plate] || []).push(r);
  const vehicles = [], fixes = [];
  for (const [plate, list] of Object.entries(by)) {
    list.sort((a, b) => a.at - b.at);
    const known = list.map((r, k) => [k, r.odo]).filter(([, v]) => v);
    // readings must go up with time: a reading lower than or equal to an earlier one is wrong (unless it is a missing digit, fixed below)
    for (let j = 1; j < known.length; j++) { const prev = Math.max(...known.slice(0, j).map((x) => x[1])), c = known[j][1], next = known[j + 1]?.[1];
      if (c <= prev && !(c * 10 >= prev && (!next || c * 10 <= next + 10))) { const r = list[known[j][0]]; fixes.push(`${plate} ${isNaN(r.at) ? '' : r.at.toISOString().slice(0, 16).replace('T', ' ')}: ${c === prev ? 'same reading as before' : 'went backwards'} (${c}), estimated`); r.bad = 1; known.splice(j, 1); j--; } }
    // a reading that dropped to about a tenth of its neighbours is a missing digit
    for (let j = 1; j < known.length - 1; j++) { const [p, c, n] = [known[j - 1][1], known[j][1], known[j + 1][1]]; if (c < p * 0.5 && c * 10 >= p && c * 10 <= n + 10) { fixes.push(`${plate}: ${c} read as ${c * 10}`); known[j][1] = c * 10; list[known[j][0]].fixed = c * 10; } }
    const cum = [0]; for (const r of list) cum.push(cum[cum.length - 1] + r.qty);
    const kpl = known.length > 1 ? (known[known.length - 1][1] - known[0][1]) / ((cum[known[known.length - 1][0]] - cum[known[0][0]]) || 1) : 0;
    list.forEach((r, k) => {
      const kk = known.find(([i]) => i === k); if (kk) { r.odoFilled = kk[1]; r.odoNote = r.fixed ? 'Corrected' : 'From statement'; return; }
      if (!known.length) { r.odoFilled = 0; r.odoNote = 'No readings'; return; }
      const prev = [...known].reverse().find(([i]) => i < k), next = known.find(([i]) => i > k);
      let v; if (prev && next) v = prev[1] + (cum[k] - cum[prev[0]]) / ((cum[next[0]] - cum[prev[0]]) || 1) * (next[1] - prev[1]);
      else if (prev) v = prev[1] + (cum[k] - cum[prev[0]]) * kpl; else v = next[1] - (cum[next[0]] - cum[k]) * kpl;
      r.odoFilled = Math.round(v); r.odoNote = r.bad ? 'Wrong reading, estimated' : 'Estimated';
    });
    const km = known.length ? Math.round(list[list.length - 1].odoFilled - list[0].odoFilled + list[list.length - 1].qty * kpl) : 0;
    const litres = {}; let spent = 0, sur = 0;
    for (const r of list) { litres[r.kind] = (litres[r.kind] || 0) + r.qty; spent += r.total; sur += r.qty * Math.max(0, r.price - (base[r.kind] || r.price)); }
    vehicles.push({ plate, fills: list.length, litres: +Object.values(litres).reduce((a, b) => a + b, 0).toFixed(2), byKind: Object.fromEntries(Object.entries(litres).map(([k, v]) => [k, +v.toFixed(2)])), spent: +spent.toFixed(2), km, kpl: +kpl.toFixed(2), surIncl: +sur.toFixed(2), surExcl: +(sur / 1.05).toFixed(2), include: !opts.plates || opts.plates.includes(plate) });
  }
  vehicles.sort((a, b) => b.litres - a.litres);
  const inc = vehicles.filter((v) => v.include), s = (f) => +inc.reduce((a, v) => a + f(v), 0).toFixed(2);
  const usedKinds = [...new Set(rows.map((r) => r.kind))];
  const paid = Object.fromEntries(usedKinds.map((k) => { const rs = rows.filter((r) => r.kind === k); return [k, +(rs.reduce((a, r) => a + r.price * r.qty, 0) / (rs.reduce((a, r) => a + r.qty, 0) || 1)).toFixed(2)]; }));
  const excl = s((v) => v.surExcl), vat = +(excl * 0.05).toFixed(2);
  return { vehicles, fixes, kinds: usedKinds, paid, totals: { litres: s((v) => v.litres), km: s((v) => v.km), spent: s((v) => v.spent), excl, vat, total: +(excl + vat).toFixed(2) } };
}

// The Excel file: a summary sheet first, then the statement with the odometer filled in.
export function workbook(rows, a, month, baseMonth, base) {
  const wb = XLSX.utils.book_new();
  const S = [[`Fuel surcharge ${month} (base: ${baseMonth} official UAE fuel prices)`], [],
    ['Fuel', `${baseMonth} price (AED/L)`, `${month} price paid (AED/L)`, 'Increase (AED/L)', 'Increase %'],
    ...a.kinds.map((k) => [LABEL[k], base[k], a.paid[k], +(a.paid[k] - base[k]).toFixed(2), +((a.paid[k] - base[k]) / base[k]).toFixed(4)]), [],
    ['Vehicle', 'Included', 'Fills', 'Litres', 'Fuel spent incl. VAT', 'Km (approx)', 'Km per litre', 'Surcharge incl. VAT', 'Surcharge excl. VAT'],
    ...a.vehicles.map((v) => [v.plate, v.include ? 'Yes' : 'No', v.fills, v.litres, v.spent, v.km, v.kpl, v.surIncl, v.surExcl]),
    ['Total (included vehicles)', '', '', a.totals.litres, a.totals.spent, a.totals.km, '', '', a.totals.excl], [],
    ['Invoice before VAT', a.totals.excl], ['VAT 5%', a.totals.vat], ['Invoice total', a.totals.total], [],
    ['How it is worked out: litres bought x (price paid per litre minus the official base-month price). Pump prices include 5% VAT, so the surcharge before VAT is that / 1.05; the invoice adds 5% VAT.'],
    ...(a.fixes.length ? [['Odometer corrections: ' + a.fixes.join('; ')]] : []), ['Blank odometer readings are estimated from the fuel bought between known readings.']];
  const ws = XLSX.utils.aoa_to_sheet(S); ws['!cols'] = [26, 16, 18, 14, 18, 14, 12, 18, 18].map((w) => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws, 'Fuel surcharge');
  const T = [['Date', 'Plate', 'Product', 'Litres', 'Price per litre', 'Amount', 'Odometer (statement)', 'Odometer (filled)', 'Odometer note']];
  for (const r of [...rows].sort((x, y) => x.plate.localeCompare(y.plate) || x.at - y.at)) T.push([isNaN(r.at) ? '' : r.at.toISOString().slice(0, 16).replace('T', ' '), r.plate, r.product, r.qty, r.price, r.total, r.odo || '', r.odoFilled || '', r.odoNote || '']);
  const wt = XLSX.utils.aoa_to_sheet(T); wt['!cols'] = [18, 14, 12, 10, 12, 10, 16, 16, 16].map((w) => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, wt, 'Transactions');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
