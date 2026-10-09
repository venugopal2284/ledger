'use strict';
/* =====================================================================
   Ledger – local-only household income / expense / investment tracker
   Data lives in this browser (localStorage). Every record carries an id
   and updatedAt, and deletions are soft, so Google Drive sync can be
   added later without changing the data shape.
   ===================================================================== */

/* ---------- small utilities ---------- */
const p2 = n => String(n).padStart(2, '0');
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dmy = d => d ? `${d.slice(8, 10)} ${MON[+d.slice(5, 7) - 1]} ${d.slice(0, 4)}` : '';
const dm = d => d ? `${d.slice(8, 10)} ${MON[+d.slice(5, 7) - 1]}` : '';
const monLabel = m => `${MON[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}`;
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const lastDay = m => { const [y, mo] = m.split('-').map(Number); return `${m}-${p2(new Date(Date.UTC(y, mo, 0)).getUTCDate())}`; };
const monthsBetween = (a, b) => (+b.slice(0, 4) - +a.slice(0, 4)) * 12 + (+b.slice(5, 7) - +a.slice(5, 7)) + 1;
const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

const SYM = { INR: '₹', AED: 'AED ', USD: '$', EUR: '€', GBP: '£' };
const nfCache = {};
function fmtNum(n, cur) {
  const loc = cur === 'INR' ? 'en-IN' : 'en-US';
  nfCache[loc] = nfCache[loc] || new Intl.NumberFormat(loc, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return nfCache[loc].format(Math.abs(n) < 0.005 ? 0 : n);
}
function money(n, cur) {
  const neg = n < -0.005;
  return (neg ? '−' : '') + (SYM[cur] ?? ((cur || '') + ' ')) + fmtNum(Math.abs(n), cur);
}

/* ---------- data ---------- */
const KEY = 'ledger.v1';
const mkMaster = names => names.map(n => ({ id: uid(), name: n, active: true, updatedAt: Date.now() }));
function seed() {
  return {
    v: 1,
    settings: { base: 'INR', lastBackup: null, lastBy: null, lastDate: null },
    owners: mkMaster(['Me', 'Wife', 'Joint']),
    people: mkMaster(['Me', 'Wife']),
    currencies: mkMaster(['INR', 'AED']),
    accounts: [],
    expTypes: mkMaster(['Groceries', 'Rent', 'Utilities', 'Dining out', 'Transport', 'Fuel', 'Health', 'Shopping', 'Education',
      'Travel', 'Loan / EMI', 'Insurance', 'Subscriptions', 'Household help', 'Entertainment', 'Gifts', 'Other']),
    incTypes: mkMaster(['Salary', 'Interest', 'Business income', 'Rent received', 'Refund', 'Other']),
    invTypes: mkMaster(['Mutual funds', 'Stocks', 'Fixed deposit', 'Gold', 'PPF / EPF']).map(x => ({ ...x, owner: null, currency: 'INR', openBal: 0, openDate: '' })),
    entries: [], rates: [], budgets: {}, valuations: []
  };
}
function loadDb() {
  const base = seed();
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const d = JSON.parse(raw);
      for (const k of Object.keys(base)) if (d[k] === undefined) d[k] = base[k];
      d.settings = { ...base.settings, ...d.settings };
      return d;
    }
  } catch (e) { /* fall through to a fresh database */ }
  return base;
}
let db = loadDb();
let toastFn = null;
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); }
  catch (e) { if (toastFn) toastFn('Could not save – browser storage is full or blocked', true); }
}
const live = l => l.filter(x => !x.deleted);
const act = l => l.filter(x => !x.deleted && x.active !== false);
const byId = (l, id) => l.find(x => x.id === id);
const nm = (l, id) => { const x = byId(l, id); return x ? x.name : ''; };

/* ---------- exchange rates ---------- */
let warnMap = new Map();
function rateFor(from, to, date) {
  if (from === to) return 1;
  const pick = (a, b) => {
    let best = null;
    for (const r of live(db.rates)) {
      if (r.from === a && r.to === b && r.fromDate <= date && (!r.toDate || date <= r.toDate)) {
        if (!best || r.fromDate > best.fromDate) best = r;
      }
    }
    return best;
  };
  const d = pick(from, to);
  if (d) return d.rate;
  const rev = pick(to, from);
  if (rev && rev.rate) return 1 / rev.rate;
  return null;
}
function convertAmt(x, from, to, date) {
  if (!to || from === to || x === 0) return x;
  const r = rateFor(from, to, date);
  if (r == null) {
    const k = `${from}→${to}`;
    if (!warnMap.has(k)) warnMap.set(k, date);
    return 0;
  }
  return x * r;
}

/* ---------- ledger events ----------
   Every entry becomes one or two signed events on accounts.
   bucket: inc | exp | tr (transfer) | inv (investment buy/sell)       */
function buildLedger() {
  const L = {};
  live(db.accounts).forEach(a => { L[a.id] = []; });
  for (const e of db.entries) {
    if (e.deleted) continue;
    const push = (acc, b, x) => { if (L[acc]) L[acc].push({ d: e.date, b, x, e }); };
    if (e.kind === 'exp') push(e.acc, 'exp', -e.amount);
    else if (e.kind === 'inc') push(e.acc, 'inc', e.amount);
    else if (e.kind === 'tr') { push(e.acc, 'tr', -e.amount); push(e.to, 'tr', e.toAmount != null ? e.toAmount : e.amount); }
    else if (e.kind === 'inv') {
      if (e.action === 'buy') push(e.acc, 'inv', -e.amount);
      else if (e.action === 'sell') push(e.acc, 'inv', e.amount);
      else push(e.acc, 'inc', e.amount); // dividend / interest
    }
  }
  return L;
}

function monthOptions() {
  const s = new Set([todayStr().slice(0, 7)]);
  live(db.entries).forEach(e => s.add(e.date.slice(0, 7)));
  live(db.accounts).forEach(a => a.openDate && s.add(a.openDate.slice(0, 7)));
  return [...s].sort().reverse();
}

/* ---------- summary engine ----------
   S = { mon:'YYYY-MM'|'all', acc:'all'|id, owner:'all'|id, cur:'native'|code, view:'bank'|'combined' } */
function computeSummary(S) {
  warnMap = new Map();
  const ledger = buildLedger();
  const accs = live(db.accounts).filter(a => (S.acc === 'all' || a.id === S.acc) && (S.owner === 'all' || a.owner === S.owner));
  let start, end;
  if (S.mon === 'all') {
    const ds = [];
    accs.forEach(a => { if (a.openDate) ds.push(a.openDate); (ledger[a.id] || []).forEach(ev => ds.push(ev.d)); });
    ds.sort();
    start = ds[0] || todayStr();
    end = ds.length && ds[ds.length - 1] > todayStr() ? ds[ds.length - 1] : todayStr();
  } else { start = S.mon + '-01'; end = lastDay(S.mon); }

  const repCur = S.cur === 'native' ? null : S.cur;
  const sameCur = accs.length && accs.every(a => a.currency === accs[0].currency);
  const brCur = repCur || (sameCur ? accs[0].currency : db.settings.base);

  const rows = [];
  const inc = new Map(), exp = new Map(), inv = new Map(), byMonth = new Map();
  for (const a of accs) {
    const od = a.openDate || '';
    if (od > end) continue;
    const evs = ledger[a.id] || [];
    const rc = repCur || a.currency;
    let openN = a.openBal || 0, odate, begin;
    if (od && od >= start) { odate = od; begin = od; }
    else { odate = addDays(start, -1); begin = start; for (const ev of evs) if (ev.d >= od && ev.d < start) openN += ev.x; }
    let sInc = 0, sExp = 0, sTr = 0, sInv = 0, closeN = openN;
    for (const ev of evs) {
      if (ev.d < begin || ev.d > end) continue;
      closeN += ev.x;
      const v = convertAmt(ev.x, a.currency, rc, ev.d);
      if (ev.b === 'inc') sInc += v; else if (ev.b === 'exp') sExp += v; else if (ev.b === 'tr') sTr += v; else sInv += v;
      // breakdowns, in the breakdown currency
      const bv = convertAmt(ev.x, a.currency, brCur, ev.d);
      const e = ev.e, m = ev.d.slice(0, 7);
      if (ev.b === 'inc') {
        const key = e.kind === 'inc' ? 'c' + e.cat : 'investment-income';
        const lab = e.kind === 'inc' ? (nm(db.incTypes, e.cat) || 'Uncategorised') : 'Investment income';
        const o = inc.get(key) || { label: lab, amt: 0 }; o.amt += bv; inc.set(key, o);
        const bm = byMonth.get(m) || { inc: 0, exp: 0 }; bm.inc += bv; byMonth.set(m, bm);
      } else if (ev.b === 'exp') {
        const o = exp.get(e.cat) || { id: e.cat, label: nm(db.expTypes, e.cat) || 'Uncategorised', amt: 0 }; o.amt += -bv; exp.set(e.cat, o);
        const bm = byMonth.get(m) || { inc: 0, exp: 0 }; bm.exp += -bv; byMonth.set(m, bm);
      } else if (ev.b === 'inv') {
        const o = inv.get(e.invType) || { label: nm(db.invTypes, e.invType) || 'Uncategorised', bought: 0, sold: 0 };
        if (bv < 0) o.bought += -bv; else o.sold += bv; inv.set(e.invType, o);
      }
    }
    const opening = convertAmt(openN, a.currency, rc, odate);
    const closing = convertAmt(closeN, a.currency, rc, end);
    let fx = closing - opening - (sInc + sExp + sTr + sInv);
    if (!repCur || rc === a.currency) fx = 0;
    rows.push({ acc: a, cur: rc, opening, inc: sInc, exp: sExp, tr: sTr, inv: sInv, fx, closing });
  }

  const totals = {};
  for (const r of rows) {
    const t = totals[r.cur] = totals[r.cur] || { cur: r.cur, opening: 0, inc: 0, exp: 0, tr: 0, inv: 0, fx: 0, closing: 0 };
    for (const k of ['opening', 'inc', 'exp', 'tr', 'inv', 'fx', 'closing']) t[k] += r[k];
  }

  // budgets (monthly, set in base currency)
  const nMonths = monthsBetween(start, end);
  const budgetOf = id => {
    const b = db.budgets[id]; if (!b) return null;
    return convertAmt(b * nMonths, db.settings.base, brCur, end);
  };
  const expRows = [...exp.values()];
  for (const id of Object.keys(db.budgets)) {
    if (db.budgets[id] && !exp.has(id) && byId(db.expTypes, id)) expRows.push({ id, label: nm(db.expTypes, id), amt: 0 });
  }
  expRows.forEach(r => { r.budget = budgetOf(r.id); });
  expRows.sort((a, b) => b.amt - a.amt);
  const incRows = [...inc.values()].sort((a, b) => b.amt - a.amt);
  const invRows = [...inv.values()].sort((a, b) => (b.bought + b.sold) - (a.bought + a.sold));

  // monthly series (max 12 months ending at `end`)
  const series = [];
  let m = end.slice(0, 7);
  for (let i = 0; i < 12 && m >= start.slice(0, 7); i++) {
    const v = byMonth.get(m) || { inc: 0, exp: 0 };
    series.unshift({ m, inc: v.inc, exp: v.exp });
    const y = +m.slice(0, 4), mo = +m.slice(5, 7);
    m = mo === 1 ? `${y - 1}-12` : `${y}-${p2(mo - 1)}`;
  }
  const totInc = incRows.reduce((s, r) => s + r.amt, 0), totExp = expRows.reduce((s, r) => s + r.amt, 0);
  return { S, start, end, accs, rows, totals, repCur, brCur, incRows, expRows, invRows, series, totInc, totExp,
    warnings: [...warnMap.entries()] };
}

/* ---------- investments ---------- */
function investmentStatus() {
  const out = [];
  for (const iv of live(db.invTypes)) {
    const od = iv.openDate || '';
    let invested = iv.openBal || 0, income = 0;
    for (const e of live(db.entries)) {
      if (e.kind !== 'inv' || e.invType !== iv.id || e.date < od) continue;
      const v = convertAmt(e.amount, e.cur, iv.currency, e.date);
      if (e.action === 'buy') invested += v; else if (e.action === 'sell') invested -= v; else income += v;
    }
    const vals = live(db.valuations).filter(v => v.inv === iv.id).sort((a, b) => a.date < b.date ? 1 : -1);
    const latest = vals[0] || null;
    out.push({ iv, invested, income, latest, value: latest ? latest.value : null,
      gain: latest ? latest.value - invested : null,
      pct: latest && invested > 0 ? (latest.value - invested) / invested * 100 : null });
  }
  return out;
}

/* =====================================================================
   Excel (.xlsx) writer – no libraries, works offline
   ===================================================================== */
const crcTable = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function zipStore(files) {
  const enc = new TextEncoder();
  const u16 = n => [n & 255, (n >>> 8) & 255];
  const u32 = n => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
  const parts = [], central = [];
  let off = 0;
  for (const f of files) {
    const name = enc.encode(f.name), data = enc.encode(f.text), crc = crc32(data);
    const local = new Uint8Array([0x50, 0x4b, 3, 4, ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21),
      ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0)]);
    parts.push(local, name, data);
    central.push(new Uint8Array([0x50, 0x4b, 1, 2, ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21),
      ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(off)]), name);
    off += local.length + name.length + data.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array([0x50, 0x4b, 5, 6, ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(off), ...u16(0)]);
  return new Blob([...parts, ...central, end], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
const xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
function colName(i) { let s = '', n = i + 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
function sheetXml(rows, widths) {
  let x = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">';
  if (widths) x += '<cols>' + widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols>';
  x += '<sheetData>';
  rows.forEach((r, ri) => {
    x += `<row r="${ri + 1}">`;
    r.forEach((c, ci) => {
      if (c == null || c === '') return;
      let v = c, b = false;
      if (typeof c === 'object') { v = c.v; b = !!c.b; }
      if (v == null || v === '') return;
      const ref = colName(ci) + (ri + 1);
      if (typeof v === 'number' && isFinite(v)) x += `<c r="${ref}" s="${b ? 3 : 2}"><v>${v}</v></c>`;
      else x += `<c r="${ref}" s="${b ? 1 : 0}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
    });
    x += '</row>';
  });
  return x + '</sheetData></worksheet>';
}
function buildXlsx(sheets) { // sheets: [{name, rows, widths}]
  const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const files = [
    { name: '[Content_Types].xml', text: head + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>' },
    { name: '_rels/.rels', text: head + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', text: head + `<workbook xmlns="${NS}" xmlns:r="${R}"><sheets>` +
        sheets.map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', text: head + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="${R}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
        `<Relationship Id="rId${sheets.length + 1}" Type="${R}/styles" Target="styles.xml"/></Relationships>` },
    { name: 'xl/styles.xml', text: head + `<styleSheet xmlns="${NS}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="4" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>` },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, text: sheetXml(s.rows, s.widths) }))
  ];
  return zipStore(files);
}

const KIND_LABEL = { exp: 'Expense', inc: 'Income', tr: 'Transfer', inv: 'Investment' };
const ACTION_LABEL = { buy: 'Buy', sell: 'Sell', div: 'Dividend / interest' };
function entryTitle(e) {
  if (e.kind === 'exp') return nm(db.expTypes, e.cat) || 'Expense';
  if (e.kind === 'inc') return nm(db.incTypes, e.cat) || 'Income';
  if (e.kind === 'tr') return 'Transfer to ' + (nm(db.accounts, e.to) || '?');
  return ({ buy: 'Bought ', sell: 'Sold ', div: 'Income from ' })[e.action] + (nm(db.invTypes, e.invType) || 'investment');
}
function entrySign(e) {
  if (e.kind === 'exp') return -1;
  if (e.kind === 'inc') return 1;
  if (e.kind === 'inv') return e.action === 'buy' ? -1 : 1;
  return 0;
}

function excelSheets(scope, S) {
  const R = computeSummary(S);
  const inRange = e => e.date >= R.start && e.date <= R.end;
  const ids = new Set(R.accs.map(a => a.id));
  let entries = live(db.entries);
  if (scope === 'filter') entries = entries.filter(e => inRange(e) && (ids.has(e.acc) || ids.has(e.to)));
  entries = entries.slice().sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : (a.createdAt || 0) - (b.createdAt || 0));
  const H = (...c) => c.map(v => ({ v, b: true }));
  const eRows = [H('Date', 'Type', 'Account', 'Owner', 'To account', 'Category / investment', 'Action', 'Amount', 'Currency', 'Amount received', 'Received currency', 'Description', 'Entered by')];
  for (const e of entries) {
    const a = byId(db.accounts, e.acc), to = byId(db.accounts, e.to);
    eRows.push([e.date, KIND_LABEL[e.kind], a ? a.name : '', a ? nm(db.owners, a.owner) : '', to ? to.name : '',
      e.kind === 'exp' ? nm(db.expTypes, e.cat) : e.kind === 'inc' ? nm(db.incTypes, e.cat) : e.kind === 'inv' ? nm(db.invTypes, e.invType) : '',
      e.kind === 'inv' ? ACTION_LABEL[e.action] : '', e.amount, e.cur, e.kind === 'tr' ? e.toAmount : '', e.kind === 'tr' && to ? to.currency : '',
      e.desc || '', nm(db.people, e.by)]);
  }
  const sRows = [];
  sRows.push([{ v: 'Summary', b: true }]);
  sRows.push(['Period', S.mon === 'all' ? `${dmy(R.start)} to ${dmy(R.end)}` : monLabel(S.mon)]);
  sRows.push(['Account', S.acc === 'all' ? 'All' : nm(db.accounts, S.acc)]);
  sRows.push(['Owner', S.owner === 'all' ? 'All' : nm(db.owners, S.owner)]);
  sRows.push(['Currency', R.repCur || 'Each account in its own currency']);
  sRows.push([]);
  if (S.view !== 'combined' || S.acc !== 'all') {
    sRows.push(H('Account', 'Currency', 'Opening balance', 'Income', 'Expenses', 'Transfers (net)', 'Investments (net)', 'Exchange difference', 'Closing balance'));
    for (const r of R.rows) sRows.push([r.acc.name, r.cur, round2(r.opening), round2(r.inc), round2(r.exp), round2(r.tr), round2(r.inv), round2(r.fx), round2(r.closing)]);
    for (const t of Object.values(R.totals)) sRows.push([{ v: 'Total', b: true }, t.cur, ...['opening', 'inc', 'exp', 'tr', 'inv', 'fx', 'closing'].map(k => ({ v: round2(t[k]), b: true }))]);
    sRows.push([]);
  }
  sRows.push([{ v: `Breakdown in ${R.brCur}`, b: true }]);
  sRows.push(H('Income by category', 'Amount'));
  R.incRows.forEach(r => sRows.push([r.label, round2(r.amt)]));
  sRows.push([{ v: 'Total income', b: true }, { v: round2(R.totInc), b: true }]);
  sRows.push([]);
  sRows.push(H('Expenses by category', 'Spent', 'Budget', 'Left (negative = over)'));
  R.expRows.forEach(r => sRows.push([r.label, round2(r.amt), r.budget == null ? '' : round2(r.budget), r.budget == null ? '' : round2(r.budget - r.amt)]));
  sRows.push([{ v: 'Total expenses', b: true }, { v: round2(R.totExp), b: true }]);
  sRows.push([]);
  sRows.push(H('Investments by type', 'Bought', 'Sold'));
  R.invRows.forEach(r => sRows.push([r.label, round2(r.bought), round2(r.sold)]));
  if (R.warnings.length) { sRows.push([]); sRows.push([{ v: 'Note: missing exchange rates for ' + R.warnings.map(w => w[0]).join(', ') + '. Those amounts are left out.', b: true }]); }

  const iRows = [H('Investment', 'Owner', 'Currency', 'Net invested', 'Latest market value', 'Value as on', 'Gain / loss', 'Gain %', 'Dividend / interest received')];
  for (const s of investmentStatus()) iRows.push([s.iv.name, nm(db.owners, s.iv.owner), s.iv.currency, round2(s.invested),
    s.value == null ? '' : round2(s.value), s.latest ? s.latest.date : '', s.gain == null ? '' : round2(s.gain), s.pct == null ? '' : round2(s.pct), round2(s.income)]);
  return [
    { name: 'Entries', rows: eRows, widths: [12, 11, 20, 10, 20, 24, 18, 14, 9, 14, 10, 36, 12] },
    { name: 'Summary', rows: sRows, widths: [28, 14, 18, 16, 16, 16, 18, 18, 18] },
    { name: 'Investments', rows: iRows, widths: [24, 10, 9, 16, 18, 12, 14, 9, 22] }
  ];
}

/* Node/test hook: stop here when there is no page to draw into */
if (typeof document === 'undefined' || !document.getElementById('app')) {
  if (typeof module !== 'undefined') module.exports = { get db() { return db; }, set db(v) { db = v; }, computeSummary, investmentStatus, buildXlsx, excelSheets, rateFor, money, convertAmt, seed };
} else {

/* =====================================================================
   UI
   ===================================================================== */
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value') e.value = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) { if (k == null || k === false) continue; e.append(k.nodeType ? k : document.createTextNode(k)); }
  return e;
}
let toastTimer;
function toast(msg, bad) {
  document.querySelector('.toast')?.remove();
  const t = h('div', { class: 'toast' + (bad ? ' bad' : ''), role: 'status' }, msg);
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), bad ? 4500 : 2200);
}
toastFn = toast;
const isDesktop = () => window.matchMedia && matchMedia('(hover:hover) and (pointer:fine)').matches;
let idSeq = 0;

/* ---------- searchable dropdown ---------- */
function combo({ opts, value, ph, onPick, add, labelOf, label }) {
  let val = value ?? null, hi = -1, shown = [], dirty = false;
  const id = 'cb' + (++idSeq);
  const input = h('input', { type: 'text', id, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: ph || 'Select or type to search', role: 'combobox', 'aria-expanded': 'false', 'aria-label': label || ph || 'Select' });
  const list = h('div', { class: 'cb-list', role: 'listbox', hidden: true });
  const caret = h('span', { class: 'cb-caret', 'aria-hidden': 'true' }, '▾');
  const wrap = h('div', { class: 'cb' }, input, caret, list);
  const lab = v => { if (v == null) return ''; const o = opts().find(o => o.id === v); return o ? o.label : (labelOf ? labelOf(v) : ''); };
  const setText = () => { input.value = lab(val); };
  function render() {
    const q = input.value.trim().toLowerCase();
    const all = opts();
    const terms = dirty ? q.split(/\s+/).filter(Boolean) : [];
    shown = all.filter(o => terms.every(t => (o.label + ' ' + (o.sub || '')).toLowerCase().includes(t)));
    list.replaceChildren();
    shown.forEach((o, i) => list.append(h('div', {
      class: 'cb-opt' + (i === hi ? ' hi' : '') + (o.id === val ? ' sel' : ''), role: 'option',
      onmousedown: e => e.preventDefault(), onclick: () => pick(o)
    }, h('span', {}, o.label), o.sub ? h('small', {}, o.sub) : null)));
    const exact = all.some(o => o.label.toLowerCase() === q);
    if (add && dirty && q && !exact) list.append(h('div', { class: 'cb-opt add' + (hi === shown.length ? ' hi' : ''), onmousedown: e => e.preventDefault(), onclick: doAdd }, `+ Add “${input.value.trim()}”`));
    if (!list.children.length) list.append(h('div', { class: 'cb-empty' }, 'No match'));
  }
  function place() {
    const r = input.getBoundingClientRect();
    const vh = (window.visualViewport && window.visualViewport.height) || innerHeight;
    wrap.classList.toggle('up', vh - r.bottom < 230 && r.top > vh - r.bottom);
  }
  function open() {
    if (list.hidden) {
      hi = -1;
      render(); list.hidden = false; input.setAttribute('aria-expanded', 'true'); place(); setTimeout(place, 300);
      const sel = list.querySelector('.sel'); if (sel && !dirty) sel.scrollIntoView({ block: 'nearest' });
    } else render();
  }
  function close() { list.hidden = true; input.setAttribute('aria-expanded', 'false'); }
  function pick(o) { val = o.id; dirty = false; setText(); close(); onPick && onPick(val, o); }
  function doAdd() {
    const t = input.value.trim(); const nid = add(t);
    if (nid) { val = nid; dirty = false; setText(); close(); onPick && onPick(val, { id: nid, label: t }); }
  }
  function moveHi(d) {
    const max = shown.length + (list.querySelector('.add') ? 1 : 0);
    if (!max) return; hi = (hi + d + max) % max; render();
    list.querySelector('.hi')?.scrollIntoView({ block: 'nearest' });
  }
  input.addEventListener('focus', () => { dirty = false; open(); input.select(); });
  input.addEventListener('click', () => { if (list.hidden) open(); });
  input.addEventListener('input', () => { dirty = true; if (list.hidden) open(); hi = 0; render(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (list.hidden) open(); moveHi(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (list.hidden) open(); moveHi(-1); }
    else if (e.key === 'Enter') {
      if (!list.hidden) {
        e.preventDefault();
        if (hi >= 0 && hi < shown.length) pick(shown[hi]);
        else if (hi === shown.length && list.querySelector('.add')) doAdd();
        else if (shown.length === 1) pick(shown[0]);
      }
    } else if (e.key === 'Escape') { if (!list.hidden) { e.stopPropagation(); e.preventDefault(); dirty = false; setText(); close(); } }
    else if (e.key === 'Tab') {
      if (!list.hidden && dirty) { if (hi >= 0 && hi < shown.length) pick(shown[hi]); else if (shown.length === 1) pick(shown[0]); }
    }
  });
  input.addEventListener('blur', () => { dirty = false; setText(); close(); });
  caret.style.pointerEvents = 'auto'; caret.style.cursor = 'pointer';
  caret.addEventListener('mousedown', e => { e.preventDefault(); if (document.activeElement === input) { list.hidden ? open() : close(); } else input.focus(); });
  setText();
  return { el: wrap, input, get: () => val, set: v => { val = v ?? null; dirty = false; setText(); }, focus: () => input.focus() };
}

/* ---------- generic modal form ---------- */
function openForm({ title, fields, values, onSave, onDelete, deleteLabel, validate, note }) {
  const dlg = h('dialog', { class: 'dlg' });
  const inputs = {};
  const body = h('div', { class: 'dlg-body' });
  const errEl = h('p', { class: 'err', role: 'alert' });
  fields.forEach(f => {
    const v = values[f.k];
    let ctl;
    if (f.t === 'ref' || f.t === 'select') {
      const optsFn = f.t === 'select' ? () => f.opts.map(o => ({ id: o, label: o }))
        : () => act(db[f.list]).map(x => ({ id: f.by === 'name' ? x.name : x.id, label: x.name }));
      const labelOf = f.t === 'select' || f.by === 'name' ? (x => x) : (x => nm(db[f.list], x));
      const c = combo({ opts: optsFn, value: v ?? null, labelOf, label: f.l, ph: f.ph });
      inputs[f.k] = { get: () => c.get() };
      ctl = c.el;
    } else if (f.t === 'check') {
      const cb = h('input', { type: 'checkbox', id: 'f' + f.k }); cb.checked = v !== false;
      inputs[f.k] = { get: () => cb.checked };
      body.append(h('label', { class: 'check', for: 'f' + f.k }, cb, f.l));
      return;
    } else {
      const i = h('input', { type: f.t === 'num' ? 'number' : f.t === 'date' ? 'date' : 'text', id: 'f' + f.k, step: 'any', inputmode: f.t === 'num' ? 'decimal' : null, autocomplete: 'off', value: v ?? '' });
      inputs[f.k] = { get: () => f.t === 'num' ? (i.value === '' ? null : parseFloat(i.value)) : i.value.trim() };
      ctl = i;
    }
    body.append(h('div', { class: 'fld' }, h('label', { for: ctl.id || (ctl.querySelector && ctl.querySelector('input')?.id) }, f.l + (f.req ? ' *' : '')), ctl, f.hint ? h('small', { class: 'hint' }, f.hint) : null));
  });
  if (note) body.append(h('p', { class: 'muted small' }, note));
  body.append(errEl);
  const doSave = () => {
    const out = {};
    for (const f of fields) out[f.k] = inputs[f.k].get();
    for (const f of fields) if (f.req && (out[f.k] == null || out[f.k] === '')) { errEl.textContent = `${f.l} is required`; return; }
    const msg = validate && validate(out);
    if (msg) { errEl.textContent = msg; return; }
    onSave(out); dlg.close();
  };
  dlg.append(h('div', { class: 'dlg-h' }, title), h('div', { class: 'dlg-inner' }, body),
    h('div', { class: 'dlg-f' },
      onDelete ? h('button', { class: 'btn danger', type: 'button', onclick: () => { if (confirm(deleteLabel || 'Delete this?')) { onDelete(); dlg.close(); } } }, 'Delete') : null,
      h('span', { class: 'sp' }),
      h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancel'),
      h('button', { class: 'btn primary', type: 'button', onclick: doSave }, 'Save')));
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox' && e.target.getAttribute('role') !== 'combobox') { e.preventDefault(); doSave(); } });
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

/* ---------- navigation ---------- */
const ui = {
  page: 'home', params: {}, master: 'accounts',
  ent: { mon: 'all', acc: 'all', q: '', n: 80 },
  sum: { mon: todayStr().slice(0, 7), acc: 'all', owner: 'all', cur: 'native', view: 'bank' }
};
const PAGES = {
  home: { t: 'New entry', ic: '＋' }, entries: { t: 'All entries', ic: '≡' }, summary: { t: 'Summary', ic: '▤' },
  invest: { t: 'Investments', ic: '↗' }, budgets: { t: 'Budgets', ic: '◔' }, rates: { t: 'Exchange rates', ic: '⇄' },
  masters: { t: 'Masters', ic: '☰' }, backup: { t: 'Backup & settings', ic: '⛁' }
};
const main = document.getElementById('app');
const titleEl = document.getElementById('title');
const drawer = document.getElementById('drawer');
const scrim = document.getElementById('scrim');

function buildDrawer() {
  drawer.replaceChildren(
    h('h2', {}, 'Ledger'),
    ...['home', 'summary', 'masters'].map(navBtn),
    h('h2', {}, 'More'),
    ...['entries', 'invest', 'budgets', 'rates'].map(navBtn),
    h('button', { onclick: () => { closeDrawer(); excelDialog(); } }, h('span', { class: 'ic' }, '⇩'), 'Download in Excel'),
    navBtn('backup')
  );
}
function navBtn(p) {
  return h('button', { 'aria-current': ui.page === p ? 'page' : null, onclick: () => go(p) }, h('span', { class: 'ic' }, PAGES[p].ic), p === 'home' ? 'Home – new entry' : PAGES[p].t);
}
function openDrawer() { buildDrawer(); drawer.classList.add('open'); scrim.hidden = false; }
function closeDrawer() { drawer.classList.remove('open'); scrim.hidden = true; }
document.getElementById('menu').addEventListener('click', openDrawer);
scrim.addEventListener('click', closeDrawer);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });

function go(page, params, noPush) {
  ui.page = page; ui.params = params || {};
  if (!noPush) history.pushState({ page, params: ui.params }, '');
  closeDrawer(); render(); window.scrollTo(0, 0);
}
window.addEventListener('popstate', e => { const s = e.state || { page: 'home', params: {} }; go(s.page, s.params, true); });
function render() {
  titleEl.textContent = ui.page === 'home' && ui.params.edit ? 'Edit entry' : PAGES[ui.page].t;
  main.replaceChildren(({ home: pageHome, entries: pageEntries, summary: pageSummary, invest: pageInvest, budgets: pageBudgets, rates: pageRates, masters: pageMasters, backup: pageBackup })[ui.page]());
}

/* ---------- entry rows ---------- */
function entryRow(e, { onClick, tools } = {}) {
  const a = byId(db.accounts, e.acc);
  const s = entrySign(e);
  const amt = e.kind === 'tr' && e.toAmount != null && e.toAmount !== e.amount
    ? `${money(e.amount, e.cur)} → ${money(e.toAmount, (byId(db.accounts, e.to) || {}).currency)}` : money(e.amount, e.cur);
  const el = h(onClick ? 'button' : 'div', { class: 'item', type: onClick ? 'button' : null, onclick: onClick },
    h('div', { class: 'l' },
      h('div', { class: 't' }, entryTitle(e)),
      h('div', { class: 's' }, [dm(e.date), a ? a.name : '', e.desc].filter(Boolean).join(' · '))),
    h('div', { class: 'num ' + (s > 0 ? 'pos' : s < 0 ? 'neg' : '') }, (s > 0 ? '+' : s < 0 ? '−' : '') + amt),
    tools || null);
  return el;
}
const sortedEntries = () => live(db.entries).slice().sort((a, b) => a.date < b.date ? 1 : a.date > b.date ? -1 : (b.createdAt || 0) - (a.createdAt || 0));

/* ---------- HOME / ENTRY FORM ---------- */
function pageHome() {
  const edit = ui.params.edit ? byId(db.entries, ui.params.edit) : null;
  const sd = db.settings;
  const f = edit ? { ...edit, amount: String(edit.amount), toAmount: edit.toAmount != null ? String(edit.toAmount) : '', desc: edit.desc || '' } : {
    date: sd.lastDate && sd.lastDate.sys === todayStr() ? sd.lastDate.date : todayStr(),
    by: sd.lastBy || (act(db.people)[0] || {}).id || null,
    kind: 'exp', acc: null, to: null, cat: null, invType: null, action: 'buy', amount: '', toAmount: '', desc: ''
  };
  const root = h('div', { class: 'page' });
  const form = h('div', { class: 'card form' });
  const recent = h('div', { class: 'card' });
  const refs = {};
  let err = '', errField = null;

  const accOpts = excl => () => act(db.accounts).filter(a => a.id !== excl).map(a => ({ id: a.id, label: a.name, sub: `${a.currency} · ${nm(db.owners, a.owner)}` }));
  const addMaster = list => name => {
    if (live(db[list]).some(x => x.name.toLowerCase() === name.toLowerCase())) { toast('That name already exists', true); return null; }
    const o = { id: uid(), name, active: true, updatedAt: Date.now() }; db[list].push(o); save(); return o.id;
  };
  const curOf = id => (byId(db.accounts, id) || {}).currency;

  function draw(focus) {
    form.dataset.kind = f.kind;
    form.replaceChildren();
    const k = f.kind;
    // date + entered by
    const dateIn = h('input', { type: 'date', id: 'f-date', value: f.date, 'aria-label': 'Date', onchange: e => { f.date = e.target.value; } });
    refs.date = dateIn;
    const by = combo({ opts: () => act(db.people).map(p => ({ id: p.id, label: p.name })), value: f.by, labelOf: id => nm(db.people, id), label: 'Entered by', onPick: v => { f.by = v; } });
    form.append(h('div', { class: 'grid2' },
      h('div', { class: 'fld' }, h('label', { for: 'f-date' }, 'Date'), dateIn),
      h('div', { class: 'fld' }, h('label', {}, 'Entered by'), by.el)));
    // kind
    form.append(h('div', { class: 'seg kinds', style: 'margin-bottom:12px', role: 'group', 'aria-label': 'Entry type' },
      [['exp', 'Expense'], ['inc', 'Income'], ['tr', 'Transfer'], ['inv', 'Investment']].map(([v, l]) =>
        h('button', { type: 'button', 'aria-pressed': String(k === v), onclick: () => { if (f.kind !== v) { f.kind = v; f.cat = null; f.to = null; f.invType = null; err = ''; draw('acc'); } } }, l))));
    if (k === 'inv') form.append(h('div', { class: 'seg', style: 'margin-bottom:12px', role: 'group', 'aria-label': 'Investment action' },
      [['buy', 'Buy'], ['sell', 'Sell'], ['div', 'Dividend']].map(([v, l]) =>
        h('button', { type: 'button', 'aria-pressed': String(f.action === v), onclick: () => { f.action = v; draw(); } }, l))));
    // account
    const accLabel = k === 'tr' ? 'From account' : (k === 'inc' || (k === 'inv' && f.action !== 'buy')) ? 'Received in' : 'Paid from';
    const next = k === 'tr' ? 'to' : k === 'inv' ? 'inv' : 'cat';
    const acc = combo({ opts: accOpts(null), value: f.acc, labelOf: id => nm(db.accounts, id), label: accLabel, ph: 'Bank, card or cash', onPick: v => { f.acc = v; if (f.to === v) f.to = null; draw(next); } });
    refs.acc = acc;
    form.append(h('div', { class: 'fld' }, h('label', {}, accLabel), acc.el));
    // kind specific
    if (k === 'exp' || k === 'inc') {
      const list = k === 'exp' ? 'expTypes' : 'incTypes';
      const c = combo({ opts: () => act(db[list]).map(x => ({ id: x.id, label: x.name })), value: f.cat, labelOf: id => nm(db[list], id), label: 'Category', ph: 'Type to search or add', add: addMaster(list), onPick: v => { f.cat = v; draw('amount'); } });
      refs.cat = c; form.append(h('div', { class: 'fld' }, h('label', {}, k === 'exp' ? 'Type of expense' : 'Type of income'), c.el));
    } else if (k === 'tr') {
      const c = combo({ opts: accOpts(f.acc), value: f.to, labelOf: id => nm(db.accounts, id), label: 'To account', ph: 'Bank, card or cash', onPick: v => { f.to = v; draw('amount'); } });
      refs.to = c; form.append(h('div', { class: 'fld' }, h('label', {}, 'To account'), c.el));
    } else {
      const c = combo({ opts: () => act(db.invTypes).map(x => ({ id: x.id, label: x.name })), value: f.invType, labelOf: id => nm(db.invTypes, id), label: 'Investment type', ph: 'Mutual funds, stocks…', add: name => { const id = addMaster('invTypes')(name); if (id) { Object.assign(byId(db.invTypes, id), { owner: null, currency: db.settings.base, openBal: 0, openDate: '' }); save(); } return id; }, onPick: v => { f.invType = v; draw('amount'); } });
      refs.inv = c; form.append(h('div', { class: 'fld' }, h('label', {}, 'Investment type'), c.el));
    }
    // amount
    const cur = curOf(f.acc) || db.settings.base;
    const amount = h('input', { type: 'number', id: 'f-amt', inputmode: 'decimal', step: 'any', min: '0', placeholder: '0.00', 'aria-label': 'Amount', value: f.amount, oninput: e => { f.amount = e.target.value; } });
    refs.amount = amount;
    form.append(h('div', { class: 'fld' }, h('label', { for: 'f-amt' }, 'Amount'), h('div', { class: 'amt' }, h('span', { class: 'chip' }, SYM[cur] ? SYM[cur].trim() : cur), amount)));
    const cross = k === 'tr' && f.to && curOf(f.to) !== curOf(f.acc);
    if (cross) {
      const toCur = curOf(f.to);
      const ta = h('input', { type: 'number', id: 'f-toamt', inputmode: 'decimal', step: 'any', min: '0', placeholder: '0.00', value: f.toAmount, oninput: e => { f.toAmount = e.target.value; } });
      refs.toAmount = ta;
      form.append(h('div', { class: 'fld' }, h('label', { for: 'f-toamt' }, `Amount received in ${toCur}`), h('div', { class: 'amt' }, h('span', { class: 'chip' }, SYM[toCur] ? SYM[toCur].trim() : toCur), ta),
        h('small', { class: 'hint' }, 'Enter what actually landed in the receiving account')));
      amount.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); ta.focus(); } });
      ta.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); desc.focus(); } });
    }
    // description
    const desc = h('input', { type: 'text', id: 'f-desc', autocomplete: 'off', placeholder: 'Optional note', value: f.desc, 'aria-label': 'Description', oninput: e => { f.desc = e.target.value; }, onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } } });
    refs.desc = desc;
    if (!cross) amount.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); desc.focus(); } });
    form.append(h('div', { class: 'fld' }, h('label', { for: 'f-desc' }, 'Description'), desc));
    form.append(h('p', { class: 'err', role: 'alert' }, err));
    form.append(h('div', { class: 'row' },
      edit ? h('button', { class: 'btn', type: 'button', onclick: () => go('entries') }, 'Cancel') : null,
      h('button', { class: 'btn save grow', type: 'button', onclick: submit }, edit ? 'Update entry' : 'Save entry')));
    if (focus && refs[focus]) setTimeout(() => (refs[focus].focus ? refs[focus].focus() : null), 0);
  }

  function fail(msg, field) { err = msg; errField = field; draw(field); }
  function submit() {
    const a = byId(db.accounts, f.acc), k = f.kind;
    const amt = parseFloat(f.amount);
    if (!f.date) return fail('Pick a date', 'date');
    if (!a) return fail('Choose the account', 'acc');
    if (k === 'tr') { if (!f.to) return fail('Choose the account it goes to', 'to'); }
    else if (k === 'inv') { if (!f.invType) return fail('Choose the investment type', 'inv'); }
    else if (!f.cat) return fail(k === 'exp' ? 'Choose the type of expense' : 'Choose the type of income', 'cat');
    if (!(amt > 0)) return fail('Enter an amount greater than 0', 'amount');
    const to = k === 'tr' ? byId(db.accounts, f.to) : null;
    let toAmount = null;
    if (k === 'tr') {
      if (to.currency !== a.currency) { toAmount = parseFloat(f.toAmount); if (!(toAmount > 0)) return fail(`Enter the amount received in ${to.currency}`, 'toAmount'); }
      else toAmount = round2(amt);
    }
    if (a.openDate && f.date < a.openDate) return fail(`${a.name} starts on ${dmy(a.openDate)}. Pick a later date, or change its “as on” date in Masters.`, 'date');
    if (to && to.openDate && f.date < to.openDate) return fail(`${to.name} starts on ${dmy(to.openDate)}. Pick a later date.`, 'date');
    if (k === 'inv') { const iv = byId(db.invTypes, f.invType); if (iv && iv.openDate && f.date < iv.openDate) return fail(`${iv.name} starts on ${dmy(iv.openDate)}. Pick a later date.`, 'date'); }
    const rec = {
      id: edit ? edit.id : uid(), date: f.date, kind: k, acc: f.acc, to: k === 'tr' ? f.to : null,
      cat: k === 'exp' || k === 'inc' ? f.cat : null, invType: k === 'inv' ? f.invType : null, action: k === 'inv' ? f.action : null,
      amount: round2(amt), toAmount: k === 'tr' ? round2(toAmount) : null, cur: a.currency, desc: f.desc.trim(), by: f.by,
      createdAt: edit ? edit.createdAt : Date.now(), updatedAt: Date.now()
    };
    if (edit) { Object.assign(edit, rec); save(); toast('Entry updated'); go('entries'); return; }
    db.entries.push(rec);
    sd.lastDate = { sys: todayStr(), date: f.date }; sd.lastBy = f.by;
    save();
    toast(`Saved · ${money(rec.amount, rec.cur)} ${entryTitle(rec)}`);
    Object.assign(f, { kind: 'exp', acc: null, to: null, cat: null, invType: null, action: 'buy', amount: '', toAmount: '', desc: '' });
    err = ''; draw(isDesktop() ? 'acc' : null); drawRecent();
    if (!isDesktop()) document.activeElement && document.activeElement.blur();
  }
  function drawRecent() {
    recent.replaceChildren(h('h3', {}, 'Latest entries'));
    const es = sortedEntries().slice(0, 5);
    if (!es.length) recent.append(h('div', { class: 'empty' }, 'Nothing yet. Your entries will appear here.'));
    else recent.append(h('div', { class: 'list' }, es.map(e => entryRow(e, { onClick: () => go('home', { edit: e.id }) }))));
    if (es.length) recent.append(h('button', { class: 'btn sm', style: 'margin-top:10px', type: 'button', onclick: () => go('entries') }, 'See all entries'));
  }

  // set-up and backup nudges
  if (!act(db.accounts).length && !edit) {
    root.append(h('div', { class: 'banner' }, h('strong', {}, 'Start by adding your accounts. '), 'Add each bank, credit card and cash account with its opening balance and the date it is as on.',
      h('div', { style: 'margin-top:8px' }, h('button', { class: 'btn primary sm', type: 'button', onclick: () => { ui.master = 'accounts'; go('masters'); } }, 'Add accounts'))));
  }
  const lb = db.settings.lastBackup;
  if (!edit && live(db.entries).length > 5 && (!lb || (Date.now() - lb) > 30 * 864e5)) {
    root.append(h('div', { class: 'banner' }, 'Your data lives only on this device. ', h('button', { class: 'btn sm', type: 'button', onclick: () => go('backup') }, 'Download a backup')));
  }
  root.append(form);
  draw(isDesktop() && !edit ? 'acc' : null);
  if (!edit) { drawRecent(); root.append(recent); }
  return root;
}

/* ---------- ALL ENTRIES ---------- */
function pageEntries() {
  const S = ui.ent;
  const root = h('div', { class: 'page' });
  const listBox = h('div', { class: 'card' });
  const monthOpts = () => [{ id: 'all', label: 'All months' }, ...monthOptions().map(m => ({ id: m, label: monthLabel(m) }))];
  const accOpts = () => [{ id: 'all', label: 'All accounts' }, ...live(db.accounts).map(a => ({ id: a.id, label: a.name }))];
  const mon = combo({ opts: monthOpts, value: S.mon, labelOf: v => v === 'all' ? 'All months' : monLabel(v), label: 'Month', onPick: v => { S.mon = v; S.n = 80; draw(); } });
  const acc = combo({ opts: accOpts, value: S.acc, labelOf: v => v === 'all' ? 'All accounts' : nm(db.accounts, v), label: 'Account', onPick: v => { S.acc = v; S.n = 80; draw(); } });
  const q = h('input', { type: 'search', placeholder: 'Search description or category', value: S.q, 'aria-label': 'Search entries', oninput: e => { S.q = e.target.value; S.n = 80; draw(); } });
  root.append(h('div', { class: 'card' }, h('div', { class: 'grid2 stack' }, h('div', { class: 'fld' }, h('label', {}, 'Month'), mon.el), h('div', { class: 'fld' }, h('label', {}, 'Account'), acc.el)), q), listBox);
  function draw() {
    const term = S.q.trim().toLowerCase();
    let es = sortedEntries().filter(e => (S.mon === 'all' || e.date.startsWith(S.mon)) && (S.acc === 'all' || e.acc === S.acc || e.to === S.acc));
    if (term) es = es.filter(e => (entryTitle(e) + ' ' + (e.desc || '') + ' ' + nm(db.accounts, e.acc)).toLowerCase().includes(term));
    listBox.replaceChildren(h('h3', {}, `${es.length} ${es.length === 1 ? 'entry' : 'entries'}`));
    if (!es.length) { listBox.append(h('div', { class: 'empty' }, 'No entries match.')); return; }
    listBox.append(h('div', { class: 'list' }, es.slice(0, S.n).map(e => entryRow(e, {
      tools: h('div', { class: 'tools' },
        h('button', { class: 'btn sm', type: 'button', onclick: ev => { ev.stopPropagation(); go('home', { edit: e.id }); } }, 'Edit'),
        h('button', { class: 'btn sm danger', type: 'button', 'aria-label': 'Delete entry', onclick: ev => { ev.stopPropagation(); if (confirm(`Delete this entry?\n${entryTitle(e)} · ${money(e.amount, e.cur)} · ${dmy(e.date)}`)) { e.deleted = true; e.updatedAt = Date.now(); save(); toast('Entry deleted'); draw(); } } }, '✕'))
    }))));
    if (es.length > S.n) listBox.append(h('button', { class: 'btn block', style: 'margin-top:10px', type: 'button', onclick: () => { S.n += 80; draw(); } }, `Show more (${es.length - S.n} left)`));
  }
  draw();
  return root;
}

/* ---------- SUMMARY ---------- */
function pageSummary() {
  const S = ui.sum;
  const root = h('div', { class: 'page' });
  const out = h('div', { class: 'page' });
  const monOpts = () => [{ id: 'all', label: 'All months' }, ...monthOptions().map(m => ({ id: m, label: monthLabel(m) }))];
  const accOpts = () => [{ id: 'all', label: 'All banks & cards' }, ...live(db.accounts).map(a => ({ id: a.id, label: a.name, sub: a.currency }))];
  const ownOpts = () => [{ id: 'all', label: 'All owners' }, ...act(db.owners).map(o => ({ id: o.id, label: o.name }))];
  const curOpts = () => [{ id: 'native', label: 'Each account’s own currency' }, ...act(db.currencies).map(c => ({ id: c.name, label: 'Convert all to ' + c.name }))];
  const c1 = combo({ opts: monOpts, value: S.mon, labelOf: v => v === 'all' ? 'All months' : monLabel(v), label: 'Month', onPick: v => { S.mon = v; draw(); } });
  const c2 = combo({ opts: accOpts, value: S.acc, labelOf: v => v === 'all' ? 'All banks & cards' : nm(db.accounts, v), label: 'Bank', onPick: v => { S.acc = v; draw(); } });
  const c3 = combo({ opts: ownOpts, value: S.owner, labelOf: v => v === 'all' ? 'All owners' : nm(db.owners, v), label: 'Owner', onPick: v => { S.owner = v; draw(); } });
  const c4 = combo({ opts: curOpts, value: S.cur, labelOf: v => v === 'native' ? 'Each account’s own currency' : 'Convert all to ' + v, label: 'Currency', onPick: v => { S.cur = v; draw(); } });
  const viewBox = h('div');
  root.append(h('div', { class: 'card' },
    h('div', { class: 'grid2 stack' }, h('div', { class: 'fld' }, h('label', {}, 'Month'), c1.el), h('div', { class: 'fld' }, h('label', {}, 'Bank'), c2.el)),
    h('div', { class: 'grid2 stack' }, h('div', { class: 'fld' }, h('label', {}, 'Owner'), c3.el), h('div', { class: 'fld' }, h('label', {}, 'Show amounts in'), c4.el)),
    viewBox,
    h('button', { class: 'btn block', type: 'button', style: 'margin-top:4px', onclick: excelDialog }, 'Download in Excel')), out);

  function draw() {
    viewBox.replaceChildren();
    if (S.acc === 'all') viewBox.append(h('div', { class: 'seg', role: 'group', 'aria-label': 'Layout', style: 'margin-bottom:10px' },
      [['bank', 'Bank-wise'], ['combined', 'Combined']].map(([v, l]) => h('button', { type: 'button', 'aria-pressed': String(S.view === v), onclick: () => { S.view = v; draw(); } }, l))));
    out.replaceChildren();
    if (!live(db.accounts).length) { out.append(h('div', { class: 'card empty' }, 'Add an account in Masters to see balances here.')); return; }
    const R = computeSummary(S);
    const showTable = !(S.view === 'combined' && S.acc === 'all');
    out.append(h('div', { class: 'muted small' }, S.mon === 'all' ? `${dmy(R.start)} to ${dmy(R.end)}` : `${monLabel(S.mon)} · ${dmy(R.start)} to ${dmy(R.end)}`));
    if (R.warnings.length) out.append(h('div', { class: 'banner warn' }, 'No exchange rate found for ' + R.warnings.map(w => `${w[0]} (e.g. on ${dmy(w[1])})`).join(', ') + '. Those amounts are left out. Add the rate under Exchange rates.'));
    if (showTable) {
      if (!R.rows.length) out.append(h('div', { class: 'card empty' }, 'No accounts were open in this period.'));
      else {
        const hasFx = R.rows.some(r => Math.abs(r.fx) >= 0.005);
        const cols = [['opening', 'Opening'], ['inc', 'Income'], ['exp', 'Expenses'], ['tr', 'Transfers'], ['inv', 'Investments'], ...(hasFx ? [['fx', 'Exchange diff.']] : []), ['closing', 'Closing']];
        const cell = (v, cur, bold) => h('td', { class: v < -0.005 ? 'neg' : '' }, money(v, cur));
        out.append(h('div', { class: 'scrollx' }, h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Account'), cols.map(c => h('th', {}, c[1])))),
          h('tbody', {},
            R.rows.map(r => h('tr', {}, h('td', {}, r.acc.name, S.cur === 'native' ? h('span', { class: 'badge' }, r.cur) : null), cols.map(c => cell(r[c[0]], r.cur)))),
            (R.rows.length > 1 || Object.keys(R.totals).length > 1 ? Object.values(R.totals) : []).map(t => h('tr', { class: 'total' }, h('td', {}, 'Total ' + t.cur), cols.map(c => cell(t[c[0]], t.cur))))))),
          h('div', { class: 'muted small' }, 'Opening + income + expenses + transfers + investments' + (hasFx ? ' + exchange difference' : '') + ' = closing. Expenses and outgoing money show as negatives.'));
      }
    }
    // headline numbers
    const net = R.totInc - R.totExp;
    out.append(h('div', { class: 'card' }, h('h3', {}, `Income and expenses (${R.brCur})`), h('div', { class: 'kpis' },
      kpi('Income', money(R.totInc, R.brCur), 'pos'), kpi('Expenses', money(R.totExp, R.brCur), 'neg'), kpi('Saved', money(net, R.brCur), net < 0 ? 'neg' : 'pos'))));
    // expenses with budget
    const exCard = h('div', { class: 'card' }, h('h3', {}, 'Expenses by type'));
    if (!R.expRows.length) exCard.append(h('div', { class: 'muted' }, 'No expenses in this selection.'));
    else {
      const mx = Math.max(...R.expRows.map(r => r.amt), 1);
      R.expRows.forEach(r => exCard.append(h('div', { class: 'bar' }, h('span', { class: 'lab' }, r.label), h('div', { class: 'track' }, h('div', { class: 'fill', style: `width:${Math.max(r.amt / mx * 100, r.amt > 0 ? 2 : 0)}%` })), h('span', { class: 'num' }, money(r.amt, R.brCur)))));
      const withB = R.expRows.filter(r => r.budget != null);
      if (withB.length) {
        exCard.append(h('h3', { style: 'margin-top:16px' }, 'Budget vs actual'), h('div', { class: 'scrollx' }, h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Type'), h('th', {}, 'Spent'), h('th', {}, 'Budget'), h('th', {}, 'Left'))),
          h('tbody', {}, withB.map(r => { const left = r.budget - r.amt; return h('tr', {}, h('td', {}, r.label), h('td', {}, money(r.amt, R.brCur)), h('td', {}, money(r.budget, R.brCur)), h('td', { class: left < 0 ? 'neg' : 'pos' }, left < 0 ? 'Over ' + money(-left, R.brCur) : money(left, R.brCur))); })))));
      }
    }
    out.append(exCard);
    const inCard = h('div', { class: 'card' }, h('h3', {}, 'Income by type'));
    if (!R.incRows.length) inCard.append(h('div', { class: 'muted' }, 'No income in this selection.'));
    else { const mx = Math.max(...R.incRows.map(r => r.amt), 1); R.incRows.forEach(r => inCard.append(h('div', { class: 'bar inc' }, h('span', { class: 'lab' }, r.label), h('div', { class: 'track' }, h('div', { class: 'fill', style: `width:${Math.max(r.amt / mx * 100, 2)}%` })), h('span', { class: 'num' }, money(r.amt, R.brCur))))); }
    out.append(inCard);
    if (R.invRows.length) out.append(h('div', { class: 'card' }, h('h3', {}, 'Investments by type'), h('div', { class: 'scrollx' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Type'), h('th', {}, 'Bought'), h('th', {}, 'Sold'))),
      h('tbody', {}, R.invRows.map(r => h('tr', {}, h('td', {}, r.label), h('td', {}, money(r.bought, R.brCur)), h('td', {}, money(r.sold, R.brCur)))))))));
    if (R.series.length > 1) out.append(h('div', { class: 'card' }, h('h3', {}, 'Month by month'), trendChart(R.series), h('div', { class: 'muted small' }, 'Green is income, red is expenses.')));
  }
  const kpi = (n, v, cls) => h('div', { class: 'kpi' }, h('div', { class: 'n' }, n), h('div', { class: 'v ' + cls }, v));
  draw();
  return root;
}
function trendChart(series) {
  const W = 600, H = 170, pad = 22, bw = Math.min(26, (W - 20) / series.length / 2.6);
  const mx = Math.max(...series.map(s => Math.max(s.inc, s.exp)), 1);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('width', '100%'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Income and expenses by month');
  const step = (W - 20) / series.length;
  series.forEach((s, i) => {
    const cx = 10 + step * i + step / 2;
    [[s.inc, 'var(--inc)', -bw - 1], [s.exp, 'var(--exp)', 1]].forEach(([v, col, dx]) => {
      const bh = Math.max(v / mx * (H - pad - 10), v > 0 ? 2 : 0);
      const r = document.createElementNS(ns, 'rect');
      r.setAttribute('x', cx + dx); r.setAttribute('y', H - pad - bh); r.setAttribute('width', bw); r.setAttribute('height', bh); r.setAttribute('rx', 3); r.setAttribute('fill', col);
      svg.append(r);
    });
    const t = document.createElementNS(ns, 'text'); t.setAttribute('x', cx); t.setAttribute('y', H - 6); t.setAttribute('text-anchor', 'middle'); t.textContent = MON[+s.m.slice(5, 7) - 1];
    svg.append(t);
  });
  return svg;
}

/* ---------- INVESTMENTS ---------- */
function pageInvest() {
  const root = h('div', { class: 'page' });
  const f = { inv: null, date: todayStr(), value: '' };
  const tableBox = h('div', { class: 'card' });
  const valBox = h('div', { class: 'card' });
  function drawTable() {
    warnMap = new Map();
    const st = investmentStatus();
    tableBox.replaceChildren(h('h3', {}, 'Holdings'));
    if (!st.length) { tableBox.append(h('div', { class: 'empty' }, 'Add investment types in Masters.')); return; }
    tableBox.append(h('div', { class: 'scrollx' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Investment', 'Net invested', 'Market value', 'Gain / loss', '%', 'Dividends'].map(x => h('th', {}, x)))),
      h('tbody', {}, st.map(s => h('tr', {},
        h('td', {}, s.iv.name, h('span', { class: 'badge' }, s.iv.currency)),
        h('td', {}, money(s.invested, s.iv.currency)),
        h('td', {}, s.value == null ? '–' : money(s.value, s.iv.currency), s.latest ? h('div', { class: 'muted small' }, 'as on ' + dmy(s.latest.date)) : null),
        h('td', { class: s.gain == null ? '' : s.gain < 0 ? 'neg' : 'pos' }, s.gain == null ? '–' : money(s.gain, s.iv.currency)),
        h('td', { class: s.pct == null ? '' : s.pct < 0 ? 'neg' : 'pos' }, s.pct == null ? '–' : s.pct.toFixed(1) + '%'),
        h('td', {}, money(s.income, s.iv.currency))))))),
      h('div', { class: 'muted small', style: 'margin-top:8px' }, 'Net invested = opening amount + buys − sells. Gain = latest market value − net invested. Update the market value after you buy or sell.'));
  }
  function drawVals() {
    valBox.replaceChildren(h('h3', {}, 'Update market value'));
    const c = combo({ opts: () => act(db.invTypes).map(x => ({ id: x.id, label: x.name, sub: x.currency })), value: f.inv, labelOf: id => nm(db.invTypes, id), label: 'Investment', ph: 'Choose investment', onPick: v => { f.inv = v; } });
    const d = h('input', { type: 'date', value: f.date, 'aria-label': 'As on date', onchange: e => { f.date = e.target.value; } });
    const v = h('input', { type: 'number', inputmode: 'decimal', step: 'any', placeholder: 'Market value', 'aria-label': 'Market value', value: f.value, oninput: e => { f.value = e.target.value; }, onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); add(); } } });
    const msg = h('p', { class: 'err' });
    function add() {
      const val = parseFloat(f.value);
      if (!f.inv) { msg.textContent = 'Choose the investment'; return; }
      if (!f.date) { msg.textContent = 'Pick the as-on date'; return; }
      if (!(val >= 0)) { msg.textContent = 'Enter the market value'; return; }
      const ex = live(db.valuations).find(x => x.inv === f.inv && x.date === f.date);
      if (ex) { ex.value = val; ex.updatedAt = Date.now(); } else db.valuations.push({ id: uid(), inv: f.inv, date: f.date, value: val, updatedAt: Date.now() });
      save(); toast('Market value saved'); f.value = ''; drawTable(); drawVals();
    }
    valBox.append(h('div', { class: 'fld' }, h('label', {}, 'Investment'), c.el),
      h('div', { class: 'grid2' }, h('div', { class: 'fld' }, h('label', {}, 'As on'), d), h('div', { class: 'fld' }, h('label', {}, 'Market value'), v)),
      msg, h('button', { class: 'btn primary block', type: 'button', onclick: add }, 'Save market value'));
    const vs = live(db.valuations).slice().sort((a, b) => a.date < b.date ? 1 : -1).slice(0, 15);
    if (vs.length) valBox.append(h('h3', { style: 'margin-top:18px' }, 'Recent updates'), h('div', { class: 'list' }, vs.map(x => {
      const iv = byId(db.invTypes, x.inv);
      return h('div', { class: 'item', style: 'cursor:default' }, h('div', { class: 'l' }, h('div', { class: 't' }, iv ? iv.name : '?'), h('div', { class: 's' }, 'as on ' + dmy(x.date))),
        h('div', { class: 'num' }, money(x.value, iv ? iv.currency : '')),
        h('button', { class: 'btn sm danger', type: 'button', 'aria-label': 'Delete update', onclick: () => { if (confirm('Delete this market value?')) { x.deleted = true; x.updatedAt = Date.now(); save(); drawTable(); drawVals(); } } }, '✕'));
    })));
  }
  drawTable(); drawVals();
  root.append(tableBox, valBox);
  return root;
}

/* ---------- BUDGETS ---------- */
function pageBudgets() {
  const base = db.settings.base;
  const root = h('div', { class: 'page' });
  const types = act(db.expTypes);
  root.append(h('div', { class: 'card' }, h('h3', {}, `Monthly budget per expense type (${base})`),
    h('div', { class: 'muted small', style: 'margin-bottom:10px' }, 'Leave blank for no budget. Budget vs actual shows up in the Summary. When a period covers several months, the budget is multiplied accordingly.'),
    ...types.map(t => h('div', { class: 'fld' }, h('label', { for: 'b' + t.id }, t.name),
      h('input', { type: 'number', id: 'b' + t.id, inputmode: 'decimal', step: 'any', min: '0', placeholder: 'No budget', value: db.budgets[t.id] ?? '',
        onchange: e => { const v = parseFloat(e.target.value); if (v > 0) db.budgets[t.id] = v; else delete db.budgets[t.id]; save(); toast('Budget saved'); } })))));
  return root;
}

/* ---------- EXCHANGE RATES ---------- */
function pageRates() {
  const root = h('div', { class: 'page' });
  const box = h('div', { class: 'card' });
  const fields = [
    { k: 'from', l: 'From currency', t: 'ref', list: 'currencies', by: 'name', req: true },
    { k: 'to', l: 'To currency', t: 'ref', list: 'currencies', by: 'name', req: true },
    { k: 'rate', l: 'Rate (1 unit of “from” = ? units of “to”)', t: 'num', req: true, hint: 'Example: 1 AED = 22.60 INR. The reverse (INR to AED) is worked out automatically.' },
    { k: 'fromDate', l: 'Valid from', t: 'date', req: true },
    { k: 'toDate', l: 'Valid until (blank = until you add a newer rate)', t: 'date' }
  ];
  const validate = cur => cur.from === cur.to ? 'Choose two different currencies' : !(cur.rate > 0) ? 'Rate must be greater than 0' : (cur.toDate && cur.toDate < cur.fromDate) ? '“Valid until” is before “Valid from”' : null;
  const edit = r => openForm({
    title: r ? 'Edit exchange rate' : 'Add exchange rate', fields, validate, values: r || { from: 'AED', to: 'INR', fromDate: todayStr() },
    onSave: o => { if (r) Object.assign(r, o, { updatedAt: Date.now() }); else db.rates.push({ id: uid(), ...o, updatedAt: Date.now() }); save(); draw(); },
    onDelete: r ? () => { r.deleted = true; r.updatedAt = Date.now(); save(); draw(); } : null, deleteLabel: 'Delete this rate?'
  });
  function draw() {
    box.replaceChildren(h('div', { class: 'row' }, h('h3', { class: 'grow', style: 'margin:0' }, 'Exchange rates'), h('button', { class: 'btn primary sm', type: 'button', onclick: () => edit(null) }, '+ Add rate')),
      h('div', { class: 'muted small', style: 'margin:6px 0 10px' }, 'Used when you view reports in a single currency. Each amount is converted at the rate valid on its date.'));
    const rs = live(db.rates).slice().sort((a, b) => a.fromDate < b.fromDate ? 1 : -1);
    if (!rs.length) box.append(h('div', { class: 'empty' }, 'No rates yet.'));
    else box.append(h('div', { class: 'list' }, rs.map(r => h('button', { class: 'item', type: 'button', onclick: () => edit(r) },
      h('div', { class: 'l' }, h('div', { class: 't' }, `1 ${r.from} = ${r.rate} ${r.to}`), h('div', { class: 's' }, `${dmy(r.fromDate)} to ${r.toDate ? dmy(r.toDate) : 'until further notice'}`))))));
  }
  draw(); root.append(box); return root;
}

/* ---------- MASTERS ---------- */
const MASTERS = {
  accounts: { t: 'Accounts', one: 'account', fields: [
    { k: 'name', l: 'Account name', t: 'text', req: true, ph: 'e.g. HDFC Savings' },
    { k: 'type', l: 'Type', t: 'select', opts: ['Bank account', 'Credit card', 'Cash', 'Wallet'], req: true },
    { k: 'owner', l: 'Owner', t: 'ref', list: 'owners' },
    { k: 'currency', l: 'Currency', t: 'ref', list: 'currencies', by: 'name', req: true },
    { k: 'openBal', l: 'Opening balance', t: 'num', hint: 'For a credit card, enter what you owe as a negative number (e.g. -15000).' },
    { k: 'openDate', l: 'Opening balance as on', t: 'date', req: true, hint: 'Entries before this date are not allowed for this account.' },
    { k: 'limit', l: 'Credit limit (cards only, optional)', t: 'num' },
    { k: 'active', l: 'Show in dropdowns', t: 'check' }],
    sub: a => [a.type, nm(db.owners, a.owner), a.currency, `opening ${money(a.openBal || 0, a.currency)} as on ${dmy(a.openDate)}`].filter(Boolean).join(' · ') },
  expTypes: { t: 'Expense types', one: 'expense type', fields: [{ k: 'name', l: 'Name', t: 'text', req: true }, { k: 'active', l: 'Show in dropdowns', t: 'check' }] },
  incTypes: { t: 'Income types', one: 'income type', fields: [{ k: 'name', l: 'Name', t: 'text', req: true }, { k: 'active', l: 'Show in dropdowns', t: 'check' }] },
  invTypes: { t: 'Investment types', one: 'investment type', fields: [
    { k: 'name', l: 'Name', t: 'text', req: true, ph: 'e.g. Mutual funds' },
    { k: 'owner', l: 'Owner', t: 'ref', list: 'owners' },
    { k: 'currency', l: 'Currency', t: 'ref', list: 'currencies', by: 'name', req: true },
    { k: 'openBal', l: 'Opening invested amount', t: 'num' },
    { k: 'openDate', l: 'Opening amount as on', t: 'date' },
    { k: 'active', l: 'Show in dropdowns', t: 'check' }],
    sub: x => [nm(db.owners, x.owner), x.currency, x.openBal ? `opening ${money(x.openBal, x.currency)}${x.openDate ? ' as on ' + dmy(x.openDate) : ''}` : ''].filter(Boolean).join(' · ') },
  owners: { t: 'Owners', one: 'owner', fields: [{ k: 'name', l: 'Name', t: 'text', req: true }, { k: 'active', l: 'Show in dropdowns', t: 'check' }] },
  people: { t: 'Entered by', one: 'person', fields: [{ k: 'name', l: 'Name', t: 'text', req: true }, { k: 'active', l: 'Show in dropdowns', t: 'check' }] },
  currencies: { t: 'Currencies', one: 'currency', fields: [{ k: 'name', l: 'Currency code', t: 'text', req: true, hint: 'Three letters, e.g. INR, AED, USD' }, { k: 'active', l: 'Show in dropdowns', t: 'check' }] }
};
function usage(key, x) {
  const E = live(db.entries);
  switch (key) {
    case 'accounts': return E.filter(e => e.acc === x.id || e.to === x.id).length;
    case 'expTypes': case 'incTypes': return E.filter(e => e.cat === x.id).length + (db.budgets[x.id] ? 1 : 0);
    case 'invTypes': return E.filter(e => e.invType === x.id).length + live(db.valuations).filter(v => v.inv === x.id).length;
    case 'owners': return live(db.accounts).filter(a => a.owner === x.id).length + live(db.invTypes).filter(a => a.owner === x.id).length;
    case 'people': return E.filter(e => e.by === x.id).length;
    case 'currencies': return live(db.accounts).filter(a => a.currency === x.name).length + live(db.invTypes).filter(a => a.currency === x.name).length + live(db.rates).filter(r => r.from === x.name || r.to === x.name).length + (db.settings.base === x.name ? 1 : 0);
  }
  return 0;
}
function pageMasters() {
  const root = h('div', { class: 'page' });
  const box = h('div', { class: 'card' });
  function edit(key, item) {
    const M = MASTERS[key];
    const vals = item ? { ...item } : (key === 'accounts' ? { currency: db.settings.base, active: true, openDate: todayStr() } : key === 'invTypes' ? { currency: db.settings.base, active: true } : { active: true });
    openForm({
      title: item ? `Edit ${M.one}` : `Add ${M.one}`, fields: M.fields, values: vals,
      validate: o => {
        const nmv = (o.name || '').toLowerCase();
        if (live(db[key]).some(x => x.id !== (item && item.id) && x.name.toLowerCase() === nmv)) return 'That name is already in use';
        if (key === 'currencies' && !/^[A-Za-z]{3}$/.test(o.name)) return 'Use a three-letter currency code';
        if (key === 'accounts' && item && item.openDate !== o.openDate && o.openDate) {
          const early = live(db.entries).filter(e => (e.acc === item.id || e.to === item.id) && e.date < o.openDate).length;
          if (early) return `${early} existing entries are dated before ${dmy(o.openDate)}. Move the date earlier or edit those entries first.`;
        }
        return null;
      },
      onSave: o => {
        if (key === 'currencies') o.name = o.name.toUpperCase();
        if (item) {
          if (key === 'currencies' && item.name !== o.name) return toast('Currency codes cannot be renamed. Add a new one and hide this one.', true);
          Object.assign(item, o, { updatedAt: Date.now() });
        } else db[key].push({ id: uid(), ...o, updatedAt: Date.now() });
        save(); draw(); toast('Saved');
      },
      onDelete: item && usage(key, item) === 0 ? () => { item.deleted = true; item.updatedAt = Date.now(); save(); draw(); } : null,
      deleteLabel: 'Delete this ' + M.one + '?',
      note: item && usage(key, item) > 0 ? 'This is used in your records, so it can be hidden but not deleted. Untick “Show in dropdowns” to hide it.' : null
    });
  }
  function draw() {
    const key = ui.master, M = MASTERS[key];
    box.replaceChildren(
      h('div', { class: 'seg scroll', role: 'group', 'aria-label': 'Master list', style: 'margin-bottom:12px' },
        Object.entries(MASTERS).map(([k, m]) => h('button', { type: 'button', 'aria-pressed': String(k === key), onclick: () => { ui.master = k; draw(); } }, m.t))),
      h('div', { class: 'row', style: 'margin-bottom:6px' }, h('h3', { class: 'grow', style: 'margin:0' }, M.t), h('button', { class: 'btn primary sm', type: 'button', onclick: () => edit(key, null) }, `+ Add ${M.one}`)));
    const items = live(db[key]);
    if (!items.length) box.append(h('div', { class: 'empty' }, `No ${M.t.toLowerCase()} yet.`));
    else box.append(h('div', { class: 'list' }, items.map(x => h('button', { class: 'item', type: 'button', onclick: () => edit(key, x) },
      h('div', { class: 'l' }, h('div', { class: 't' }, x.name, x.active === false ? h('span', { class: 'badge' }, 'Hidden') : null), M.sub ? h('div', { class: 's' }, M.sub(x)) : null),
      h('span', { class: 'muted' }, '›')))));
  }
  draw(); root.append(box); return root;
}

/* ---------- BACKUP & SETTINGS ---------- */
function pageBackup() {
  const root = h('div', { class: 'page' });
  const lb = db.settings.lastBackup;
  const baseC = combo({ opts: () => act(db.currencies).map(c => ({ id: c.name, label: c.name })), value: db.settings.base, labelOf: x => x, label: 'Main currency', onPick: v => { db.settings.base = v; save(); toast('Main currency set to ' + v); } });
  const file = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: ev => {
    const fl = ev.target.files[0]; if (!fl) return;
    fl.text().then(t => {
      try {
        const d = JSON.parse(t);
        if (!d || !Array.isArray(d.entries) || !Array.isArray(d.accounts)) throw new Error('bad');
        if (!confirm(`Replace everything on this device with this backup?\n${d.entries.length} entries, ${d.accounts.length} accounts.`)) return;
        const base = seed(); for (const k of Object.keys(base)) if (d[k] === undefined) d[k] = base[k];
        d.settings = { ...base.settings, ...d.settings }; db = d; save(); toast('Backup restored'); go('home');
      } catch (e) { toast('That file is not a Ledger backup', true); }
    });
  } });
  root.append(
    h('div', { class: 'card' }, h('h3', {}, 'Backup'),
      h('p', { class: 'muted small' }, `All data is stored in this browser on this device. Download a backup now and then, and before clearing browser data or moving to a new phone. ${lb ? 'Last backup: ' + new Date(lb).toLocaleString() : 'No backup yet.'}`),
      h('div', { class: 'row' }, h('button', { class: 'btn primary grow', type: 'button', onclick: () => {
        const blob = new Blob([JSON.stringify(db, null, 1)], { type: 'application/json' });
        download(blob, `Ledger-backup-${todayStr()}.json`); db.settings.lastBackup = Date.now(); save(); toast('Backup downloaded');
      } }, 'Download backup'), h('button', { class: 'btn grow', type: 'button', onclick: () => file.click() }, 'Restore from backup')), file),
    h('div', { class: 'card' }, h('h3', {}, 'Main currency'), h('div', { class: 'fld' }, h('label', {}, 'Used for budgets and for breakdowns that mix currencies'), baseC.el)),
    h('div', { class: 'card' }, h('h3', {}, 'Sync'), h('p', { class: 'muted small' }, 'Google Drive sync for two devices comes in the next step. Every record already carries an id and an updated time so it can merge safely.')),
    h('div', { class: 'card' }, h('h3', {}, 'Erase everything'), h('p', { class: 'muted small' }, 'Deletes all data on this device. Download a backup first.'),
      h('button', { class: 'btn danger', type: 'button', onclick: () => { if (confirm('Erase ALL data on this device? This cannot be undone.') && confirm('Really erase everything?')) { db = seed(); save(); toast('All data erased'); go('home'); } } }, 'Erase all data')));
  return root;
}
function download(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/* ---------- EXCEL DIALOG ---------- */
function excelDialog() {
  let scope = 'filter';
  const S = ui.sum;
  const desc = `${S.mon === 'all' ? 'all months' : monLabel(S.mon)} · ${S.acc === 'all' ? 'all banks' : nm(db.accounts, S.acc)} · ${S.owner === 'all' ? 'all owners' : nm(db.owners, S.owner)} · ${S.cur === 'native' ? 'own currencies' : S.cur}`;
  const dlg = h('dialog', { class: 'dlg' });
  const radios = h('div', { class: 'dlg-body' });
  const mk = (v, title, sub) => h('label', { class: 'check', style: 'align-items:flex-start' }, h('input', { type: 'radio', name: 'sc', checked: v === scope, onchange: () => { scope = v; } }), h('span', {}, h('strong', {}, title), h('div', { class: 'muted small' }, sub)));
  radios.append(h('p', { class: 'muted small' }, 'The workbook has three sheets: Entries, Summary and Investments.'),
    mk('filter', 'Current Summary selection', desc), mk('all', 'All entries', 'Every entry ever recorded. The Summary sheet still follows the selection above.'));
  dlg.append(h('div', { class: 'dlg-h' }, 'Download in Excel'), radios, h('div', { class: 'dlg-f' },
    h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancel'),
    h('button', { class: 'btn primary', type: 'button', onclick: () => {
      try { download(buildXlsx(excelSheets(scope, S)), `Ledger-${S.mon === 'all' ? 'all-months' : S.mon}-${todayStr()}.xlsx`); toast('Excel file downloaded'); dlg.close(); }
      catch (e) { console.error(e); toast('Could not create the Excel file', true); }
    } }, 'Download')));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg); dlg.showModal();
}

/* ---------- boot ---------- */
history.replaceState({ page: 'home', params: {} }, '');
render();
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register('sw.js').catch(() => {});
}
