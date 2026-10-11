/**
 * Tikka Bites · the shared database in Google Sheets (a Google Apps Script web app)
 * ==================================================================================
 * Paste this whole file into the script of the "Tikka Bites – Control" spreadsheet
 * (Extensions → Apps Script), then follow google-sheets/README.md.
 *
 * The app sends every request here: a POST whose text body is JSON { fn, args, token }.
 * The answer is { ok: true, data } or { ok: false, error: { kind, message } }.
 * It does exactly what supabase/schema.sql does in the Supabase mode (same checks,
 * same answers) and keeps the data in two Google Sheets that always match:
 *   Tikka Bites – Main     the app reads and writes this file (this month and the 2 before)
 *   Tikka Bites – Backup   every change is copied here in the same request (all months, kept)
 * Every night a dated copy of Main also goes to the "Nightly copies" folder (last 14 kept).
 *
 * How the sheets are kept from getting corrupted:
 *  1. One lock: requests that touch the sheets run one at a time, and every change is
 *     flushed before the next request starts, so a read never sees half a change.
 *  2. Everything is checked first; only then is anything written.
 *  3. Numbers are reserved before rows are written, so a crash can skip a number but
 *     never repeat one. A retried bill (same clientRef) gets the bill already saved.
 *  4. One record = one row, written in one call and found by its key; rows are never
 *     moved. The trusted copy of each record is the JSON in its hidden Data column(s);
 *     the readable columns are only for people.
 *  5. The header rows are checked: if a column was moved, added or deleted by hand,
 *     nothing is written and the app says what changed.
 *  6. Text stays text: plain-text cells, and anything that looks like a formula is
 *     escaped.
 *
 * Tested on a PC by tests/unit/sheetsBackend.test.ts (tests/helpers/fakeAppsScript.mjs
 * behaves like Google Sheets) and end to end by npm run e2e:sheets.
 *
 * The same script also has a second, separate use (owner request, 12 Oct 2026): while the
 * app uses Supabase, "Supabase backup" (at the end of this file) copies everything from
 * Supabase into a Google Sheet every night, with the same tabs and rules. It needs no web
 * app deployment. Tested by tests/unit/supabaseBackup.test.ts.
 */

const TB = {
  IST_OFFSET_MS: 330 * 60000, // India time is UTC+5:30 all year
  LOCK_WAIT_MS: 25000,
  LONG_LOCK_WAIT_MS: 240000,
  CELL_CHARS: 45000, // Google Sheets allows 50,000 characters in a cell
  ACCESS_MS: 12 * 3600000,
  REFRESH_MS: 60 * 86400000,
  HASH_ROUNDS: 2000,
  MAX_TRIES: 5,
  TRIES_WINDOW_S: 600,
  CACHE_S: 21600,
  USER_CACHE_S: 300,
  COPIES_KEPT: 14,
  BACKUP_CELLS_WARN: 8000000, // a Google Sheet holds at most 10 million cells
  USER_ID_RE: /^[a-z0-9][a-z0-9._-]{1,29}$/,
  UUID_RE: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  BILL_NO_RE: /^(RCPT|INV)-([0-9]{6})-([0-9]{4,})$/,
  OFF_NO_RE: /^OFF-[A-Z0-9]{3,6}-[0-9]{4,}$/,
};

const TOTALS_WRONG = 'Totals do not add up. Please check the bill and save again.';
const SIGNED_OUT = 'Your sign-in has expired. Please sign in again.';
const USER_ID_RULE = 'User ID must be 2–30 characters: small letters, numbers, dot, dash or underscore (e.g. counter2)';

/** Self-test only: temporary files and state, so the real ones are never touched. */
let OVERRIDE = null;

// ============================================================================
// Small helpers
// ============================================================================

class TbError extends Error {
  /** kind: auth | rejected | setup | server (the app's CloudError kinds); message is shown to staff. */
  constructor(kind, message) {
    super(message);
    this.name = 'TbError';
    this.kind = kind;
  }
}

function refuse(message) {
  throw new TbError('rejected', message);
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Text of a JSON value, like Postgres ->> (null when missing or null). */
function txt(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return isFinite(v) ? String(v) : null;
  if (typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

/** Length in characters as people count them (emoji = 1), like Postgres char_length. */
function chars(s) {
  return Array.from(s).length;
}

/** Trim spaces only, like Postgres btrim. */
function btrim(s) {
  return s.replace(/^ +| +$/g, '');
}

function pad(n, width) {
  return String(n).padStart(width, '0');
}

/** Drop null / undefined fields (like jsonb_strip_nulls). */
function strip(o) {
  const out = {};
  Object.keys(o).forEach((k) => {
    if (o[k] !== null && o[k] !== undefined) out[k] = o[k];
  });
  return out;
}

function sameText(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------- India time ----------
function ist(ms) {
  const d = new Date(ms + TB.IST_OFFSET_MS);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), dow: d.getUTCDay() };
}
function monthKeyAt(ms) {
  const t = ist(ms);
  return t.y + pad(t.mo, 2);
}
/** The oldest month kept in Main and on the phones: this month and the 2 before it. */
function keepFromAt(ms) {
  const t = ist(ms);
  let y = t.y;
  let m = t.mo - 2;
  if (m < 1) {
    m += 12;
    y -= 1;
  }
  return y + pad(m, 2);
}
function isoDate(ms) {
  const t = ist(ms);
  return t.y + '-' + pad(t.mo, 2) + '-' + pad(t.d, 2);
}
function dayText(ms) {
  const t = ist(ms);
  return pad(t.d, 2) + '-' + pad(t.mo, 2) + '-' + t.y;
}
function timeText(ms) {
  const t = ist(ms);
  return pad(t.h, 2) + ':' + pad(t.mi, 2);
}
function billsTab(monthKey) {
  return 'Bills ' + monthKey.slice(0, 4) + '-' + monthKey.slice(4);
}
function tabMonth(name) {
  const m = /^Bills (\d{4})-(\d{2})$/.exec(name);
  return m ? m[1] + m[2] : null;
}

// ============================================================================
// What each tab holds. Readable columns first (for people), then Rev (the change
// number), extra lookup columns, and the Data column(s) with the record as JSON.
// ============================================================================

function yes(b) {
  return b ? 'Yes' : 'No';
}
/** ₹ for reading in the sheet only; the exact paise are in the Data column. */
function rupees(p) {
  return typeof p === 'number' && isFinite(p) ? p / 100 : '';
}

/** "₹150" or "₹120.50", for reading only. */
function rupeeText(p) {
  if (typeof p !== 'number' || !isFinite(p)) return '';
  return '₹' + (p % 100 === 0 ? String(p / 100) : (p / 100).toFixed(2));
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ORDER_TYPES = { 'dine-in': 'Dine-in', takeaway: 'Takeaway', delivery: 'Delivery' };
const PAYMENTS = { cash: 'Cash', upi: 'UPI', card: 'Card' };

function discountText(d) {
  if (!isObj(d)) return '';
  if (d.kind === 'pct') return Number(d.bp) / 100 + '%';
  return Number(d.paise) > 0 ? rupeeText(Number(d.paise)) + ' off' : 'None';
}

/** Every field of the bill, one column each (owner request, 12 Oct 2026: the whole bill on one row). */
function billCells(r) {
  const b = r.bill;
  const at = typeof b.createdAt === 'number' ? b.createdAt : NaN;
  const items = (b.items || []).map((i) => i.qty + ' × ' + i.name + ' @ ' + rupeeText(i.unitPaise) + ' = ' + rupeeText(i.linePaise)).join('; ');
  return [
    b.billNo, dayText(at), timeText(at), isFinite(at) ? DAYS[ist(at).dow] : '',
    ORDER_TYPES[b.orderType] || b.orderType || '', b.tableNo || '', b.customerName || '', PAYMENTS[b.paymentMode] || b.paymentMode || '',
    items, b.itemCount, (b.categories || []).join(', '), b.hasVeg && b.hasNonVeg ? 'Veg + Non-veg' : b.hasVeg ? 'Veg' : b.hasNonVeg ? 'Non-veg' : '',
    rupees(b.subtotalPaise), discountText(b.discount), rupees(b.discountPaise), rupees(b.roundOffPaise), rupees(b.totalPaise),
    b.status === 'void' ? 'Void' : 'Paid', b.voidReason || '', typeof b.voidedAt === 'number' ? dayText(b.voidedAt) + ' ' + timeText(b.voidedAt) : '',
    r.by || '', b.printedAs || '', b.cheesyLine || '',
  ];
}

/** Earlier bill-tab headers (oldest first). Tabs with one of these are rebuilt from their Data column (upgradeTab). */
const OLD_BILL_HEADS = [
  ['Receipt no', 'Date', 'Time', 'Order type', 'Table', 'Customer', 'Payment', 'Items', 'Item count', 'Subtotal ₹', 'Discount ₹', 'Round-off ₹', 'Total ₹', 'Status', 'Void reason', 'Saved by', 'Printed as', 'Rev', 'Client ref', 'Data', 'Data 2'],
];

const SPECS = {
  meta: {
    tab: 'Meta', head: ['Key', 'Value'], fmt: ['@', '@'], rev: false, extra: [], cells: 1,
    key: (r) => r.key,
    show: (r) => [r.key, typeof r.value === 'string' ? r.value : JSON.stringify(r.value)],
  },
  counters: {
    tab: 'Counters', head: ['Month', 'Last receipt number'], fmt: ['@', '0'], rev: false, extra: [], cells: 1,
    key: (r) => r.monthKey,
    show: (r) => [r.monthKey, r.last],
  },
  settings: {
    tab: 'Settings', head: ['Key', 'Shop name', 'Phone', 'Tagline'], fmt: ['@', '@', '@', '@'], rev: true, extra: [], cells: 20, // the logo needs up to 16
    key: () => 'app',
    show: (s) => ['app', s.name, s.phone || '', s.tagline || ''],
  },
  menu: {
    tab: 'Menu',
    head: ['ID', 'Dish', 'Category', 'Price ₹', 'Veg', 'On menu', 'Deleted', 'Used in bills', 'Last edited'],
    fmt: ['0', '@', '@', '0.00', '@', '@', '@', '@', '@'], rev: true, extra: [], cells: 1,
    key: (r) => String(r.id),
    show: (r) => [r.id, r.name, r.category, rupees(r.price_paise), yes(r.is_veg), yes(r.active), yes(r.deleted), yes(r.used_in_bills), dayText(r.updated_at) + ' ' + timeText(r.updated_at)],
  },
  lines: {
    tab: 'Cheesy lines', head: ['ID', 'Text', 'Active', 'Built in', 'Removed'], fmt: ['0', '@', '@', '@', '@'], rev: true, extra: [], cells: 1,
    key: (r) => String(r.id),
    show: (r) => [r.id, r.text, yes(r.active), yes(r.built_in), yes(r.removed)],
  },
  users: {
    tab: 'Users', head: ['User ID', 'Role', 'Added', 'Removed'], fmt: ['@', '@', '@', '@'], rev: true, extra: [], cells: 1,
    key: (r) => r.username,
    show: (r) => [r.username, r.role === 'super_admin' ? 'Super admin' : 'Staff', dayText(r.addedAt), yes(r.removed)],
  },
  bills: {
    tab: null, // one tab per month: "Bills 2026-10"
    head: [
      'Receipt no', 'Date', 'Time', 'Day', 'Order type', 'Table', 'Customer', 'Payment', 'Items (qty × rate = amount)', 'Item count', 'Categories', 'Veg / Non-veg',
      'Subtotal ₹', 'Discount', 'Discount ₹', 'Round-off ₹', 'Total ₹', 'Status', 'Void reason', 'Voided at', 'Saved by', 'Printed as', 'Receipt line',
    ],
    fmt: ['@', '@', '@', '@', '@', '@', '@', '@', '@', '0', '@', '@', '0.00', '@', '0.00', '0.00', '0.00', '@', '@', '@', '@', '@', '@'],
    rev: true, extra: ['Client ref'], cells: 2, old: OLD_BILL_HEADS,
    key: (r) => r.bill.billNo,
    show: billCells,
    extraOf: (r) => [r.ref || ''],
  },
};
const SMALL = ['meta', 'counters', 'settings', 'menu', 'lines', 'users'];

/** Column positions (1-based) and the full header of a tab. */
function layout(spec) {
  if (spec.L) return spec.L;
  const head = spec.head.slice();
  const fmt = spec.fmt.slice();
  if (spec.rev) {
    head.push('Rev');
    fmt.push('0');
  }
  const extraCol = head.length + 1;
  spec.extra.forEach((x) => {
    head.push(x);
    fmt.push('@');
  });
  const dataCol = head.length + 1;
  for (let i = 0; i < spec.cells; i++) {
    head.push(i ? 'Data ' + (i + 1) : 'Data');
    fmt.push('@');
  }
  spec.L = { head, fmt, width: head.length, revCol: spec.rev ? spec.head.length + 1 : 0, extraCol, dataCol, firstHidden: spec.head.length + 1 };
  return spec.L;
}

/** A readable cell: never a formula, never too long. */
function cleanCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return isFinite(v) ? v : '';
  if (typeof v === 'boolean') return yes(v);
  let s = String(v);
  if (s.length > 40000) s = s.slice(0, 40000) + '…';
  return /^[=+\-@']/.test(s) ? "'" + s : s;
}

/** The record as JSON in "j:"-prefixed pieces (never a number, date or formula), split safely. */
function dataCells(json, count, what) {
  const out = [];
  let i = 0;
  while (i < json.length) {
    let end = Math.min(i + TB.CELL_CHARS, json.length);
    const c = json.charCodeAt(end - 1);
    if (end < json.length && c >= 0xd800 && c <= 0xdbff) end -= 1; // never split an emoji
    out.push('j:' + json.slice(i, end));
    i = end;
  }
  if (out.length > count) refuse(what + ' is too large for the Google Sheet.');
  while (out.length < count) out.push('');
  return out;
}

function buildRow(spec, rec, rev, what) {
  const row = spec.show(rec).map(cleanCell);
  if (spec.rev) row.push(rev);
  if (spec.extra.length) spec.extraOf(rec).forEach((x) => row.push(cleanCell(x)));
  return row.concat(dataCells(JSON.stringify(rec), spec.cells, what || 'This record'));
}

function damaged(where) {
  return new TbError('server', 'The Google Sheet has a damaged row (' + where + '). The owner should open "Tikka Bites – Control" → Tikka Bites → Check the sheets, or switch the app to the Backup sheet.');
}

function parseCells(cells, where) {
  let json = '';
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (c === '' || c === null || c === undefined) break;
    const s = String(c);
    if (s.slice(0, 2) !== 'j:') throw damaged(where);
    json += s.slice(2);
  }
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch (e) {
    throw damaged(where);
  }
}

function parseRow(spec, values, where) {
  const L = layout(spec);
  const rec = parseCells(values.slice(L.dataCol - 1, L.dataCol - 1 + spec.cells), where);
  if (!rec) return null;
  return { rec, rev: spec.rev ? Number(values[L.revCol - 1]) || 0 : 0 };
}

// ============================================================================
// Tabs
// ============================================================================

function writeHeader(sh, spec) {
  const L = layout(spec);
  sh.getRange(1, 1, 2, L.width).setNumberFormats([L.head.map(() => '@'), L.fmt]);
  sh.getRange(1, 1, 1, L.width).setValues([L.head]).setFontWeight('bold');
}

/** Shape an empty tab. The header goes in LAST: a tab with a header is complete. */
function formatTab(sh, spec) {
  const L = layout(spec);
  if (sh.getMaxColumns() > L.width) sh.deleteColumns(L.width + 1, sh.getMaxColumns() - L.width);
  else if (sh.getMaxColumns() < L.width) sh.insertColumnsAfter(sh.getMaxColumns(), L.width - sh.getMaxColumns());
  if (sh.getMaxRows() > 2) sh.deleteRows(3, sh.getMaxRows() - 2);
  sh.setFrozenRows(1);
  sh.hideColumns(L.firstHidden, L.width - L.firstHidden + 1);
  sh.protect().setDescription('Tikka Bites: written by the app. Please do not edit by hand.').setWarningOnly(true);
  writeHeader(sh, spec);
}

function initTab(ss, name, spec, index) {
  const sh = ss.insertSheet(name, index);
  formatTab(sh, spec);
  return sh;
}

function changedByHand(file, tab, what) {
  return new TbError('server', 'The ' + file + ' Google Sheet was changed by hand (tab "' + tab + '": ' + what + '). Nothing was saved. Undo the change (Edit → Undo, or File → Version history), or switch the app to the Backup sheet.');
}

function colName(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * Refuse to touch a tab whose columns were moved, added in between or deleted by hand.
 * A tab in an earlier layout of this script (spec.old) is rebuilt in the current one.
 * Returns the tab to use (a rebuilt tab is a new sheet object).
 */
function checkLayout(sh, spec, file, writable, ss) {
  const L = layout(spec);
  const got = sh.getRange(1, 1, 1, sh.getMaxColumns()).getValues()[0];
  if (got.every((v) => v === '' || v === null) && sh.getLastRow() <= 1 && writable) {
    formatTab(sh, spec); // a tab whose creation was interrupted: finish it
    return sh;
  }
  const old = (spec.old || []).find((h) => h.every((x, i) => String(got[i]) === x) && got.slice(h.length).every((v) => v === '' || v === null));
  if (old) {
    if (!writable || !ss) throw new TbError('server', 'The ' + file + ' Google Sheet tab "' + sh.getName() + '" still has the older column layout. It is upgraded by itself on the next change or copy.');
    return upgradeTab(ss, sh, spec, old);
  }
  if (got.length < L.width) throw changedByHand(file, sh.getName(), 'a column was deleted');
  for (let i = 0; i < L.width; i++) {
    if (String(got[i]) !== L.head[i]) {
      throw changedByHand(file, sh.getName(), 'column ' + colName(i + 1) + ' should be "' + L.head[i] + '" but is "' + String(got[i]).slice(0, 40) + '"');
    }
  }
  return sh;
}

const UPGRADING = ' (upgrading)';

/**
 * Rebuild a tab in the current layout from its trusted Data column. The new rows go into
 * "<name> (upgrading)" first; only when that tab is complete is the old one deleted and the
 * new one renamed. A crash before that leaves the old tab as it was (finishUpgrades tidies up).
 */
function upgradeTab(ss, sh, spec, oldHead) {
  const name = sh.getName();
  const leftover = ss.getSheetByName(name + UPGRADING);
  if (leftover) ss.deleteSheet(leftover); // an earlier attempt that did not finish
  const revCol = oldHead.indexOf('Rev');
  const dataCol = oldHead.indexOf('Data');
  const last = sh.getLastRow();
  const values = last >= 2 ? sh.getRange(2, 1, last - 1, oldHead.length).getValues() : [];
  const rows = [];
  values.forEach((v, i) => {
    const rec = parseCells(v.slice(dataCol), 'tab "' + name + '" row ' + (i + 2));
    if (rec) rows.push(buildRow(spec, rec, revCol >= 0 ? Number(v[revCol]) || 0 : 0, 'This record'));
  });
  const fresh = initTab(ss, name + UPGRADING, spec, sh.getIndex());
  if (rows.length) appendRows(fresh, spec, rows);
  SpreadsheetApp.flush();
  ss.deleteSheet(sh);
  fresh.setName(name);
  return fresh;
}

/** After a crash in the middle of upgradeTab: keep the complete tab, drop the half-made one. */
function finishUpgrades(ss) {
  ss.getSheets().forEach((sh) => {
    const n = sh.getName();
    if (n.slice(-UPGRADING.length) !== UPGRADING) return;
    const base = n.slice(0, -UPGRADING.length);
    if (ss.getSheetByName(base)) ss.deleteSheet(sh); // the old tab is still there: start again from it
    else sh.setName(base); // the old tab was already deleted, so this one is complete
  });
}

/** Add rows below the last one (one call for the formats, one for the values). Returns the first row. */
function appendRows(sh, spec, rows) {
  const L = layout(spec);
  const first = Math.max(sh.getLastRow(), 1) + 1;
  const need = first + rows.length - 1;
  if (sh.getMaxRows() < need) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows());
  const range = sh.getRange(first, 1, rows.length, L.width);
  range.setNumberFormats(rows.map(() => L.fmt));
  range.setValues(rows);
  return first;
}

function findRow(sh, col, text) {
  const last = sh.getLastRow();
  if (last < 2 || !text) return 0;
  const hit = sh.getRange(2, col, last - 1, 1).createTextFinder(text).matchCase(true).matchEntireCell(true).findNext();
  return hit ? hit.getRow() : 0;
}

/** Update rows found by their key (column A) and append the rest, in as few calls as possible. */
function upsertValues(sh, spec, keys, rows) {
  const L = layout(spec);
  const last = sh.getLastRow();
  const at = {};
  if (last >= 2) {
    sh.getRange(2, 1, last - 1, 1).getValues().forEach((v, i) => {
      at[String(v[0])] = i + 2;
    });
  }
  const appends = [];
  const pending = {};
  keys.forEach((k, i) => {
    if (at[k] > 0) sh.getRange(at[k], 1, 1, L.width).setValues([rows[i]]);
    else if (pending[k] !== undefined) appends[pending[k]] = rows[i];
    else {
      pending[k] = appends.length;
      appends.push(rows[i]);
    }
  });
  if (appends.length) appendRows(sh, spec, appends);
}

// ============================================================================
// One open data file (Main or Backup)
// ============================================================================

class Db {
  constructor(ss, label, writable) {
    this.ss = ss;
    this.label = label;
    this.writable = writable;
    this.memo = {};
    this.checked = {};
    this.log = []; // what was written, to copy to the Backup
  }

  /** Once per request, before any tab is used: finish a layout upgrade a crash interrupted. */
  tidy() {
    if (this.tidied || !this.writable) return;
    this.tidied = true;
    finishUpgrades(this.ss);
  }

  sheet(name, spec, create) {
    this.tidy();
    let sh = this.ss.getSheetByName(name);
    if (!sh) {
      if (!create || !this.writable) return null;
      sh = initTab(this.ss, name, spec, tabMonth(name) ? 1 : this.ss.getSheets().length); // newest month first
      this.checked[name] = true;
      return sh;
    }
    if (!this.checked[name]) {
      sh = checkLayout(sh, spec, this.label, this.writable, this.ss);
      this.checked[name] = true;
    }
    return sh;
  }

  core(kind) {
    const spec = SPECS[kind];
    const sh = this.sheet(spec.tab, spec, false);
    if (!sh) throw new TbError('server', 'The ' + this.label + ' Google Sheet is missing its "' + spec.tab + '" tab (deleted or renamed by hand). Undo the change, or switch the app to the Backup sheet.');
    return sh;
  }

  /** Every row of a small tab, parsed (read once per request). */
  all(kind) {
    if (!this.memo[kind]) {
      const spec = SPECS[kind];
      const L = layout(spec);
      const sh = this.core(kind);
      const last = sh.getLastRow();
      const values = last >= 2 ? sh.getRange(2, 1, last - 1, L.width).getValues() : [];
      const rows = [];
      values.forEach((v, i) => {
        const p = parseRow(spec, v, this.label + ' › ' + spec.tab + ' row ' + (i + 2));
        if (p) rows.push({ row: i + 2, rev: p.rev, rec: p.rec, key: spec.key(p.rec) });
      });
      this.memo[kind] = rows;
    }
    return this.memo[kind];
  }

  find(kind, key) {
    return this.all(kind).find((r) => r.key === String(key)) || null;
  }

  meta() {
    const m = {};
    this.all('meta').forEach((r) => {
      m[r.rec.key] = r.rec.value;
    });
    return m;
  }

  clock() {
    return Number(this.meta().rev) || 0;
  }

  /** True once the shop's settings are in (the first phone has set it up). */
  hasSettings() {
    const L = layout(SPECS.settings);
    const sh = this.core('settings');
    if (sh.getLastRow() < 2) return false;
    return String(sh.getRange(2, L.dataCol).getValue()) !== '';
  }

  /** Write records of a small tab ([{ rec, rev }]): update by key, append the rest. */
  put(kind, items) {
    if (!items.length) return;
    const spec = SPECS[kind];
    const L = layout(spec);
    const sh = this.core(kind);
    const rows = this.all(kind);
    const keys = items.map((x) => spec.key(x.rec));
    const values = items.map((x) => buildRow(spec, x.rec, x.rev, spec.tab)); // all checked before the first write
    const appends = [];
    const appended = [];
    items.forEach((x, i) => {
      const row = values[i];
      const key = keys[i];
      const hit = rows.find((r) => r.key === key) || appended.find((r) => r.key === key);
      if (hit && hit.row) {
        sh.getRange(hit.row, 1, 1, L.width).setValues([row]);
        hit.rec = x.rec;
        hit.rev = x.rev;
      } else if (hit) {
        appends[hit.at] = row;
        hit.rec = x.rec;
        hit.rev = x.rev;
      } else {
        appended.push({ at: appends.length, key, rec: x.rec, rev: x.rev });
        appends.push(row);
      }
    });
    if (appends.length) {
      const first = appendRows(sh, spec, appends);
      appended.forEach((a) => rows.push({ row: first + a.at, rev: a.rev, rec: a.rec, key: a.key }));
    }
    this.log.push({ type: 'put', kind, tab: spec.tab, keys, values });
  }

  setMeta(patch) {
    this.put('meta', Object.keys(patch).map((k) => ({ rec: { key: k, value: patch[k] }, rev: 0 })));
  }

  /** Reserve n change numbers. The clock is written first, so a crash leaves a gap, never a repeat. */
  reserve(n) {
    const start = this.clock() + 1;
    if (n > 0) this.setMeta({ rev: start + n - 1 });
    return start;
  }

  /** Empty a small tab (only while setting up: the first phone's cheesy lines replace the old ones). */
  clear(kind) {
    const spec = SPECS[kind];
    const sh = this.core(kind);
    const last = sh.getLastRow();
    if (last >= 2) sh.getRange(2, 1, last - 1, layout(spec).width).clearContent();
    this.memo[kind] = [];
    this.log.push({ type: 'clear', kind, tab: spec.tab });
  }

  // ---------- bills: one tab per month ----------
  monthTabs() {
    this.tidy();
    return this.ss.getSheets().map((sh) => ({ sh, name: sh.getName(), month: tabMonth(sh.getName()) })).filter((t) => t.month);
  }

  billSheet(month, create) {
    return this.sheet(billsTab(month), SPECS.bills, create);
  }

  billAt(sh, row) {
    const L = layout(SPECS.bills);
    const values = sh.getRange(row, 1, 1, L.width).getValues()[0];
    const p = parseRow(SPECS.bills, values, this.label + ' › ' + sh.getName() + ' row ' + row);
    if (!p) throw damaged(this.label + ' › ' + sh.getName() + ' row ' + row);
    return { sh, row, rev: p.rev, rec: p.rec };
  }

  findBill(billNo) {
    const m = TB.BILL_NO_RE.exec(billNo);
    if (!m) return null;
    const sh = this.billSheet(m[2], false);
    const row = sh ? findRow(sh, 1, billNo) : 0;
    return row ? this.billAt(sh, row) : null;
  }

  findByRef(ref, fromMonth) {
    const col = layout(SPECS.bills).extraCol;
    const tabs = this.monthTabs().filter((t) => t.month >= fromMonth);
    for (let i = 0; i < tabs.length; i++) {
      const sh = this.sheet(tabs[i].name, SPECS.bills, false);
      const row = findRow(sh, col, ref);
      if (row) return this.billAt(sh, row);
    }
    return null;
  }

  /** The number on the month's last row (belt and braces next to the Counters tab). */
  lastSeq(month) {
    const sh = this.billSheet(month, false);
    if (!sh || sh.getLastRow() < 2) return 0;
    const m = TB.BILL_NO_RE.exec(String(sh.getRange(sh.getLastRow(), 1).getValue()));
    return m ? Number(m[3]) : 0;
  }

  addBills(month, items) {
    const spec = SPECS.bills;
    const sh = this.billSheet(month, true);
    const rows = items.map((x) => buildRow(spec, x.rec, x.rev, 'This bill'));
    appendRows(sh, spec, rows);
    this.log.push({ type: 'put', kind: 'bills', tab: sh.getName(), keys: items.map((x) => spec.key(x.rec)), values: rows });
  }

  updateBill(found, rec, rev) {
    const spec = SPECS.bills;
    const row = buildRow(spec, rec, rev, 'This bill');
    found.sh.getRange(found.row, 1, 1, layout(spec).width).setValues([row]);
    this.log.push({ type: 'put', kind: 'bills', tab: found.sh.getName(), keys: [spec.key(rec)], values: [row] });
  }
}

// ============================================================================
// Files, saved state, cache
// ============================================================================

function realProps() {
  return PropertiesService.getScriptProperties();
}

/** Script properties, read once per request (Google counts every read: 50,000 a day). */
let PROPS = null;

/** Script properties (or the self-test's own copy). */
function getProp(name) {
  if (OVERRIDE) return OVERRIDE.props[name] === undefined ? null : OVERRIDE.props[name];
  if (!PROPS) PROPS = realProps().getProperties();
  return PROPS[name] === undefined ? null : PROPS[name];
}
function setProps(values) {
  if (OVERRIDE) {
    Object.assign(OVERRIDE.props, values);
    return;
  }
  realProps().setProperties(values);
  if (PROPS) Object.assign(PROPS, values);
}

function files() {
  const main = getProp('MAIN_ID');
  const backup = getProp('BACKUP_ID');
  if (!main || !backup) {
    throw new TbError('setup', 'The Google Sheet is not set up yet. The owner should open "Tikka Bites – Control" and choose Tikka Bites → Set up (google-sheets/README.md).');
  }
  return { main, backup, folder: getProp('FOLDER_ID'), copies: getProp('COPIES_ID') };
}

function openFile(id, label, writable) {
  let ss;
  try {
    ss = SpreadsheetApp.openById(id);
  } catch (e) {
    throw new TbError('server', 'The ' + label + ' Google Sheet can\'t be opened (deleted, moved to the trash, or Google is busy). If it was deleted, restore it from the Drive trash or switch the app to the Backup sheet.');
  }
  return new Db(ss, label, writable);
}
function openMain(writable) {
  return openFile(files().main, 'Main', writable);
}
function openBackup(writable) {
  return openFile(files().backup, 'Backup', writable);
}

function secret() {
  const s = getProp('TOKEN_SECRET');
  if (!s) throw new TbError('setup', 'The Google Sheet is not set up yet. The owner should run Tikka Bites → Set up.');
  return s;
}

function hashRounds() {
  return Number(realProps().getProperty('HASH_ROUNDS')) || TB.HASH_ROUNDS;
}

/** How far the Backup has been copied: every change up to backupRev, unless dirty. */
function backupState() {
  return { rev: Number(getProp('BACKUP_REV')) || 0, dirty: getProp('BACKUP_DIRTY') === '1', error: getProp('BACKUP_ERROR') || '' };
}

function cache() {
  return CacheService.getScriptCache();
}
/** Cache keys belong to one Main file (a switch to the Backup starts fresh). */
function ck(name) {
  return 'tb:' + files().main.slice(-12) + ':' + name;
}

/** After each change: the clock and set-up state, so "anything new?" needs no sheet at all. */
function publishHead(db) {
  const meta = db.meta();
  const head = { dbId: meta.dbId, ready: db.hasSettings() && meta.importOpen !== true, importOpen: meta.importOpen === true };
  const put = {};
  put[ck('rev')] = String(Number(meta.rev) || 0);
  put[ck('head')] = JSON.stringify(head);
  cache().putAll(put, TB.CACHE_S);
  return head;
}

function headInfo() {
  const got = cache().get(ck('head'));
  if (got) return JSON.parse(got);
  return publishHead(openMain(false));
}

// ============================================================================
// The lock, and copying every change to the Backup
// ============================================================================

/** Run with the one lock held; always flush before letting go. */
function lockOnly(work, waitMs) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(waitMs || TB.LOCK_WAIT_MS)) throw new TbError('server', 'The Google Sheet is busy. Please try again in a moment.');
  PROPS = null; // read again: another request may have changed them while this one waited
  try {
    return work();
  } finally {
    SpreadsheetApp.flush();
    lock.releaseLock();
  }
}

/** A request that reads or changes the data: Main first, then the same change in the Backup. */
function withLock(work, opts) {
  opts = opts || {};
  return lockOnly(() => {
    const main = openMain(true);
    const before = main.clock();
    let result;
    try {
      result = work(main);
      SpreadsheetApp.flush();
    } catch (e) {
      if (main.log.length) {
        try {
          cache().remove(ck('rev')); // half done: the next sync reads the sheet itself
        } catch (ignore) {
          // the cache is only a shortcut
        }
      }
      throw e;
    }
    publishHead(main);
    if (!opts.noMirror) mirror(main, before);
    return result;
  }, opts.waitMs);
}

/** Copy this request's changes to the Backup. If it fell behind before, copy everything it missed. */
function mirror(main, revBefore) {
  const st = backupState();
  const clock = main.clock();
  if (!main.log.length && !st.dirty && st.rev >= clock) return true;
  return syncBackup(main, st.dirty || st.rev < revBefore ? st.rev : null);
}

/**
 * Bring the Backup up to date. fromRev = null: only this request's changes (the usual case);
 * a number: everything changed after it. A failure never undoes Main: it is noted and retried.
 */
function syncBackup(main, fromRev) {
  try {
    const b = openBackup(true);
    if (fromRev === null) replay(main.log, b);
    else catchUp(main, b, fromRev);
    SpreadsheetApp.flush();
    setProps({ BACKUP_REV: String(main.clock()), BACKUP_DIRTY: '', BACKUP_ERROR: '' });
    return true;
  } catch (e) {
    console.warn('Backup not updated: ' + (e && e.message));
    setProps({ BACKUP_DIRTY: '1', BACKUP_ERROR: String((e && e.message) || e).slice(0, 300), BACKUP_ERROR_AT: String(Date.now()) });
    return false;
  }
}

function syncBackupNow(main) {
  const st = backupState();
  if (!st.dirty && st.rev >= main.clock()) return true;
  return syncBackup(main, st.rev);
}

function replay(log, b) {
  log.forEach((e) => {
    const spec = SPECS[e.kind];
    const sh = b.sheet(e.tab, spec, true);
    if (e.type === 'clear') {
      const last = sh.getLastRow();
      if (last >= 2) sh.getRange(2, 1, last - 1, layout(spec).width).clearContent();
      return;
    }
    upsertValues(sh, spec, e.keys, e.values);
  });
}

/** Copy rows changed after fromRev (meta and counters: all rows) from Main to the Backup, exactly as they are. */
function catchUp(main, b, fromRev) {
  SMALL.forEach((kind) => copyRows(main, b, kind, SPECS[kind].tab, SPECS[kind].rev ? fromRev : -1));
  main.monthTabs().forEach((t) => copyRows(main, b, 'bills', t.name, fromRev));
}

function copyRows(main, b, kind, tab, fromRev) {
  const spec = SPECS[kind];
  const L = layout(spec);
  const sh = main.sheet(tab, spec, false);
  if (!sh || sh.getLastRow() < 2) return;
  const values = sh.getRange(2, 1, sh.getLastRow() - 1, L.width).getValues();
  const keys = [];
  const rows = [];
  values.forEach((v) => {
    if (v[L.dataCol - 1] === '' || v[L.dataCol - 1] === null) return; // empty row
    if (spec.rev && fromRev >= 0 && !(Number(v[L.revCol - 1]) > fromRev)) return;
    keys.push(String(v[0]));
    rows.push(v);
  });
  if (rows.length) upsertValues(b.sheet(tab, spec, true), spec, keys, rows);
}

// ============================================================================
// Requests from the app
// ============================================================================

function doPost(e) {
  let out;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '');
    out = { ok: true, data: handleRequest(req) };
  } catch (err) {
    out = { ok: false, error: errorBody(err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/** Opening the web app address in a browser just says it is running. */
function doGet() {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, data: 'Tikka Bites Google Sheet server is running.' })).setMimeType(ContentService.MimeType.JSON);
}

function errorBody(err) {
  if (err instanceof TbError) return { kind: err.kind, message: err.message };
  if (err instanceof SyntaxError) return { kind: 'server', message: 'The request was not understood.' };
  console.error(err && err.stack ? err.stack : err);
  return { kind: 'server', message: 'The Google Sheet had a problem (' + String((err && err.message) || err).slice(0, 200) + '). Please try again.' };
}

const OPS = {
  pull_changes: opPull,
  save_bill: opSaveBill,
  void_bill: opVoidBill,
  patch_settings: opPatchSettings,
  purge_old_months: opPurge,
  import_device_data: opImportDevice,
  import_bills: opImportBills,
  finish_import: opFinishImport,
  insert_dishes: opInsertDishes,
  update_dish: opUpdateDish,
  insert_line: opInsertLine,
  update_line: opUpdateLine,
  my_role: opMyRole,
  list_staff: opListStaff,
  staff_admin: opStaffAdmin,
  sheet_status: opSheetStatus,
};

function handleRequest(req) {
  if (!isObj(req) || typeof req.fn !== 'string') throw new TbError('server', 'The request was not understood.');
  const args = isObj(req.args) ? req.args : {};
  if (req.fn === 'sign_in') return signIn(args.username, args.password);
  if (req.fn === 'refresh_session') return refreshSession(args.refreshToken);
  if (!Object.prototype.hasOwnProperty.call(OPS, req.fn)) {
    throw new TbError('setup', 'The Google Sheet script is older than the app. The owner should paste the new Code.gs and deploy a new version (google-sheets/README.md).');
  }
  const who = verifyAccess(req.token);
  if (req.fn === 'pull_changes') {
    const quick = quickPull(args);
    if (quick) return quick;
  }
  return withLock((db) => OPS[req.fn](db, args, who));
}

// ============================================================================
// Sign-in: User ID + password, signed tokens
// ============================================================================

function b64(data) {
  return Utilities.base64EncodeWebSafe(data).replace(/=+$/, '');
}
function fromB64(s) {
  return Utilities.newBlob(Utilities.base64DecodeWebSafe(s + '==='.slice((s.length + 3) % 4))).getDataAsString();
}
function sign(body) {
  return b64(Utilities.computeHmacSha256Signature(body, secret()));
}
function makeToken(payload) {
  const body = b64(JSON.stringify(payload));
  return body + '.' + sign(body);
}

function readToken(token, type) {
  const expired = new TbError('auth', SIGNED_OUT);
  if (typeof token !== 'string' || token.length > 4000) throw expired;
  const parts = token.split('.');
  if (parts.length !== 2 || !sameText(sign(parts[0]), parts[1])) throw expired;
  let p;
  try {
    p = JSON.parse(fromB64(parts[0]));
  } catch (e) {
    throw expired;
  }
  if (!isObj(p) || p.t !== type || !(p.e > Date.now()) || typeof p.u !== 'string') throw expired;
  return p;
}

/** The person's current role and token version (cached for a few minutes; cleared on every change). */
function userInfo(name) {
  const key = ck('user:' + name);
  const got = cache().get(key);
  if (got) return JSON.parse(got);
  const row = openMain(false).find('users', name);
  const info = row && !row.rec.removed ? { v: row.rec.version, role: row.rec.role } : { gone: true };
  cache().put(key, JSON.stringify(info), TB.USER_CACHE_S);
  return info;
}
function forgetUser(name) {
  cache().remove(ck('user:' + name));
}

/** A valid token whose person is still allowed in (not removed, password not changed by the owner). */
function checkTokenUser(p) {
  if (p.d !== headInfo().dbId) throw new TbError('auth', SIGNED_OUT);
  const u = userInfo(p.u);
  if (u.gone || u.v !== p.v) throw new TbError('auth', SIGNED_OUT);
  return { username: p.u, version: u.v };
}

function verifyAccess(token) {
  return checkTokenUser(readToken(token, 'a'));
}

function issueSession(username, version, dbId) {
  const now = Date.now();
  return {
    accessToken: makeToken({ t: 'a', u: username, v: version, d: dbId, e: now + TB.ACCESS_MS }),
    refreshToken: makeToken({ t: 'r', u: username, v: version, d: dbId, e: now + TB.REFRESH_MS }),
    expiresAt: now + TB.ACCESS_MS,
    userId: username,
    username,
  };
}

/** PBKDF2 with HMAC-SHA256 (Google's own HMAC): the password itself is never stored. */
function hashPassword(password, salt, rounds) {
  const key = Utilities.newBlob(password).getBytes();
  let u = Utilities.computeHmacSha256Signature(Utilities.newBlob(salt).getBytes().concat([0, 0, 0, 1]), key);
  const t = u.slice();
  for (let i = 1; i < rounds; i++) {
    u = Utilities.computeHmacSha256Signature(u, key);
    for (let j = 0; j < t.length; j++) t[j] ^= u[j];
  }
  return Utilities.base64Encode(t);
}

function passwordFields(password) {
  const salt = Utilities.getUuid();
  const rounds = hashRounds();
  return { salt, rounds, hash: hashPassword(password, salt, rounds) };
}

/** Same rule as the app (src/core/validate.ts newPassword). */
function passwordProblem(p) {
  if (typeof p !== 'string' || p.length < 8) return 'Password must be at least 8 characters';
  if (Utilities.newBlob(p).getBytes().length > 72) return 'Password must be at most 72 characters';
  if (p.trim() !== p) return 'Password cannot start or end with a space';
  return null;
}

function signIn(username, password) {
  const name = typeof username === 'string' ? username.trim().toLowerCase().slice(0, 80) : '';
  if (!name || typeof password !== 'string' || !password) throw new TbError('auth', 'Enter your User ID and password.');
  const triesKey = ck('tries:' + name);
  const tries = Number(cache().get(triesKey)) || 0;
  if (tries >= TB.MAX_TRIES) throw new TbError('auth', 'Too many sign-in tries. Wait a few minutes and try again.');
  const main = openMain(false);
  const row = TB.USER_ID_RE.test(name) ? main.find('users', name) : null;
  const u = row && !row.rec.removed ? row.rec : null;
  const hash = hashPassword(password.slice(0, 200), u ? u.salt : 'nobody', u ? u.rounds : hashRounds()); // same work for unknown names
  if (!u || !sameText(hash, u.hash)) {
    cache().put(triesKey, String(tries + 1), TB.TRIES_WINDOW_S);
    throw new TbError('auth', 'Wrong User ID or password.');
  }
  cache().remove(triesKey);
  return issueSession(u.username, u.version, main.meta().dbId);
}

function refreshSession(refreshToken) {
  const who = checkTokenUser(readToken(refreshToken, 'r'));
  return issueSession(who.username, who.version, headInfo().dbId);
}

function activeUser(db, name) {
  const row = db.find('users', name);
  return row && !row.rec.removed ? row.rec : null;
}

function requireSuperAdmin(db, who) {
  const me = activeUser(db, who.username);
  if (!me) throw new TbError('auth', SIGNED_OUT);
  if (me.role !== 'super_admin') refuse('Only the super admin can manage users.');
  return me;
}

// ============================================================================
// pull_changes: everything changed after rev p_since, page by page
// ============================================================================

/** Nothing new since the phone last looked: answered from the cache, without opening the sheet. */
function quickPull(args) {
  const got = cache().getAll([ck('rev'), ck('head')]);
  if (!got[ck('rev')] || !got[ck('head')]) return null;
  const since = Math.max(Math.trunc(Number(args.p_since)) || 0, 0);
  if (since < Number(got[ck('rev')])) return null;
  const head = JSON.parse(got[ck('head')]);
  return { menu: [], lines: [], settings: null, bills: [], dbId: head.dbId, ready: head.ready, importOpen: head.importOpen, keepFrom: keepFromAt(Date.now()), more: false, rev: since };
}

/** Bill rows changed after `since` in the kept months: only their change numbers (one read per tab). */
function changedBillRows(db, since, keepFrom) {
  const L = layout(SPECS.bills);
  const out = [];
  db.monthTabs().forEach((t) => {
    if (t.month < keepFrom) return;
    const sh = db.sheet(t.name, SPECS.bills, false);
    const last = sh.getLastRow();
    if (last < 2) return;
    sh.getRange(2, L.revCol, last - 1, 1).getValues().forEach((r, i) => {
      if (Number(r[0]) > since) out.push({ rev: Number(r[0]), kind: 'bills', sh, row: i + 2 });
    });
  });
  return out;
}

/** Read the bills on this page only: one block per month tab. */
function readBillRows(db, items) {
  const spec = SPECS.bills;
  const L = layout(spec);
  const byTab = {};
  items.forEach((x) => (byTab[x.sh.getName()] = byTab[x.sh.getName()] || []).push(x));
  Object.keys(byTab).forEach((name) => {
    const list = byTab[name];
    const lo = Math.min.apply(null, list.map((x) => x.row));
    const hi = Math.max.apply(null, list.map((x) => x.row));
    const block = list[0].sh.getRange(lo, L.dataCol, hi - lo + 1, spec.cells).getValues();
    list.forEach((x) => {
      const rec = parseCells(block[x.row - lo], db.label + ' › ' + name + ' row ' + x.row);
      x.val = rec ? rec.bill : null;
    });
  });
}

function opPull(db, a) {
  const since = Math.max(Math.trunc(Number(a.p_since)) || 0, 0);
  const limit = Math.min(Math.max(Math.trunc(Number(a.p_limit)) || 500, 1), 2000);
  const meta = db.meta();
  const keepFrom = keepFromAt(Date.now());
  const items = [];
  ['menu', 'lines'].forEach((kind) => {
    db.all(kind).forEach((r) => {
      if (r.rev > since) items.push({ rev: r.rev, kind, val: Object.assign({}, r.rec, { rev: r.rev }) });
    });
  });
  // Settings hold the logo (up to 700 KB): read the row only when it changed.
  const sl = layout(SPECS.settings);
  const ssh = db.core('settings');
  if (ssh.getLastRow() >= 2 && Number(ssh.getRange(2, sl.revCol).getValue()) > since) {
    db.all('settings').forEach((r) => items.push({ rev: r.rev, kind: 'settings', val: r.rec }));
  }
  changedBillRows(db, since, keepFrom).forEach((x) => items.push(x));
  items.sort((x, y) => x.rev - y.rev);
  const page = items.slice(0, limit);
  readBillRows(db, page.filter((x) => x.kind === 'bills'));
  const out = { menu: [], lines: [], settings: null, bills: [] };
  page.forEach((x) => {
    if (x.kind === 'settings') out.settings = x.val;
    else if (x.val) out[x.kind].push(x.val);
  });
  const full = page.length === limit;
  out.dbId = meta.dbId;
  out.importOpen = meta.importOpen === true;
  out.ready = db.hasSettings() && !out.importOpen;
  out.keepFrom = keepFrom;
  out.more = full;
  // A full page: continue after its last row. Otherwise this page holds every change up to the clock.
  out.rev = full ? page[page.length - 1].rev : Math.max(Number(meta.rev) || 0, since);
  return out;
}

// ============================================================================
// save_bill: check a bill and give it the next receipt number (same rules as SQL)
// ============================================================================

function opSaveBill(db, a, who) {
  const p = a.p_bill;
  if (!isObj(p) || !Array.isArray(p.items) || p.items.length < 1 || p.items.length > 500) refuse('Add at least one item');
  const now = Date.now();
  const keepFrom = keepFromAt(now);
  let ref = '';
  if ('clientRef' in p) {
    ref = txt(p.clientRef) || '';
    if (!TB.UUID_RE.test(ref)) refuse('Invalid bill reference');
    const done = db.findByRef(ref, keepFrom);
    if (done) return done.rec.bill; // already saved: this is a retry after a lost reply
  }

  // Offline bills were made while a phone had no internet and are uploaded later. They keep
  // the time of the sale (right month), the price charged and the number printed (OFF-…).
  const offline = p.offline === true;
  let at = now;
  let printed = null;
  if (offline) {
    const t = txt(p.createdAt) || '';
    if (!/^[0-9]{12,14}$/.test(t)) refuse('Invalid time on an offline bill');
    at = Number(t);
    if (at > now + 600000) refuse("This offline bill has a time in the future. Check the phone's date and time.");
    if (at < now - 35 * 86400000) refuse("This offline bill is more than 35 days old and can't be uploaded.");
    if (monthKeyAt(at) < keepFrom) refuse('This offline bill is from a month that has already been cleared (only 3 months are kept).');
    printed = txt(p.printedAs);
    if (printed !== null && !TB.OFF_NO_RE.test(printed)) refuse('Invalid offline bill number');
  }
  const month = monthKeyAt(at);

  const menu = {};
  db.all('menu').forEach((r) => {
    menu[r.rec.id] = r;
  });
  const seen = {};
  const items = [];
  const cats = [];
  const used = [];
  let sub = 0;
  let count = 0;
  let veg = false;
  let nonVeg = false;
  p.items.forEach((it) => {
    if (!isObj(it)) refuse('Invalid item in the bill');
    const idT = txt(it.menuId) || '';
    const qtyT = txt(it.qty) || '';
    const unitT = txt(it.unitPaise) || '';
    if (!/^[0-9]{1,15}$/.test(idT) || !/^[0-9]{1,3}$/.test(qtyT) || !/^[0-9]{1,9}$/.test(unitT)) refuse('Invalid item in the bill');
    const row = menu[Number(idT)];
    if (!row || (row.rec.deleted && !offline)) refuse('A dish in this bill is no longer on the menu. Please check the bill and save again.');
    const d = row.rec;
    if (seen[d.id]) refuse('The same dish appears twice in the bill');
    seen[d.id] = true;
    const qty = Number(qtyT);
    if (qty < 1 || qty > 999) refuse('Quantity must be a whole number 1–999');
    let name = d.name;
    let cat = d.category;
    let isVeg = d.is_veg;
    let price = d.price_paise;
    if (offline) {
      // Already sold on the offline phone: keep what was charged and printed.
      price = Number(unitT);
      if (price < 1 || price > 10000000) refuse('Invalid item in the bill');
      if (typeof it.name === 'string' && chars(it.name) >= 1 && chars(it.name) <= 60) name = it.name;
      if (typeof it.category === 'string' && chars(it.category) >= 1 && chars(it.category) <= 30) cat = it.category;
      if (typeof it.isVeg === 'boolean') isVeg = it.isVeg;
    } else if (Number(unitT) !== price) {
      refuse('The price of ' + d.name + ' was changed on another device. Please check the bill and save again.');
    }
    sub += price * qty;
    count += qty;
    items.push({ menuId: d.id, name, category: cat, isVeg, unitPaise: price, qty, linePaise: price * qty });
    if (cats.indexOf(cat) < 0) cats.push(cat);
    veg = veg || isVeg;
    nonVeg = nonVeg || !isVeg;
    if (!d.used_in_bills) used.push(row);
  });
  if (sub > 400000000000) refuse('This bill total is too large.'); // keeps the integer math exact

  // Same integer math as src/core/money.ts and totals.ts.
  const disc = p.discount;
  const kind = isObj(disc) ? txt(disc.kind) : null;
  let discount;
  let discPaise;
  if (kind === 'flat' && /^[0-9]{1,12}$/.test(txt(disc.paise) || '')) {
    discount = { kind: 'flat', paise: Number(txt(disc.paise)) };
    discPaise = Math.min(discount.paise, sub);
  } else if (kind === 'pct' && /^[0-9]{1,5}$/.test(txt(disc.bp) || '') && Number(txt(disc.bp)) <= 10000) {
    discount = { kind: 'pct', bp: Number(txt(disc.bp)) };
    discPaise = Math.floor((2 * sub * discount.bp + 10000) / 20000); // half-up
  } else {
    refuse('Invalid discount');
  }
  const net = sub - discPaise;
  const roundT = txt(p.roundOffPaise) || '';
  if (!/^-?[0-9]{1,2}$/.test(roundT)) refuse(TOTALS_WRONG);
  const round = Number(roundT);
  if (round !== 0 && round !== Math.floor((net + 50) / 100) * 100 - net) refuse(TOTALS_WRONG); // 0, or to the nearest rupee
  const total = net + round;
  if (txt(p.totalPaise) !== String(total)) refuse(TOTALS_WRONG);

  const order = txt(p.orderType);
  const pay = txt(p.paymentMode);
  if (['dine-in', 'takeaway', 'delivery'].indexOf(order) < 0) refuse('Invalid order type');
  if (['cash', 'upi'].indexOf(pay) < 0) refuse('Invalid payment mode');
  let table = btrim(txt(p.tableNo) || '') || null;
  const customer = btrim(txt(p.customerName) || '') || null;
  const cheesy = txt(p.cheesyLine) || '';
  if (order !== 'dine-in') table = null;
  if ((table && chars(table) > 10) || (customer && chars(customer) > 60) || chars(cheesy) > 120) refuse('Some text in the bill is too long');

  // Reserve the numbers first (clock + receipt counter), flushed before the bill is written:
  // a crash after this can only skip a number, never give the same one twice.
  const counter = db.find('counters', month);
  const seq = Math.max(counter ? Number(counter.rec.last) || 0 : 0, db.lastSeq(month)) + 1;
  const billNo = 'RCPT-' + month + '-' + pad(seq, 4);
  const firstRev = db.reserve(used.length + 1);
  db.put('counters', [{ rec: { monthKey: month, last: seq }, rev: 0 }]);
  SpreadsheetApp.flush();

  const t = ist(at);
  const bill = strip({
    billNo, createdAt: at, monthKey: month, hour: t.h, weekday: t.dow, items, orderType: order, tableNo: table, customerName: customer,
    paymentMode: pay, discount, subtotalPaise: sub, discountPaise: discPaise, roundOffPaise: round, totalPaise: total, itemCount: count,
    categories: cats, hasVeg: veg, hasNonVeg: nonVeg, cheesyLine: cheesy, printedAs: printed, status: 'paid',
  });
  if (used.length) db.put('menu', used.map((r, i) => ({ rec: Object.assign({}, r.rec, { used_in_bills: true }), rev: firstRev + i })));
  db.addBills(month, [{ rec: { bill, by: who.username, ref }, rev: firstRev + used.length }]);
  return bill;
}

// ---------- void_bill: cancel a bill, keeping it for the audit trail ----------
function opVoidBill(db, a) {
  const reason = btrim(String(txt(a.p_reason) || '').replace(/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ''));
  if (chars(reason) < 3) refuse('Please give a reason (at least 3 characters)');
  if (chars(reason) > 200) refuse('Reason must be at most 200 characters');
  const found = db.findBill(txt(a.p_bill_no) || '');
  if (!found) refuse('Bill not found');
  const bill = found.rec.bill;
  if (bill.status === 'void') refuse('Bill is already voided');
  const rev = db.reserve(1);
  const next = Object.assign({}, bill, { status: 'void', voidReason: reason, voidedAt: Date.now() });
  db.updateBill(found, Object.assign({}, found.rec, { bill: next }), rev);
  return next;
}

// ============================================================================
// Settings: checked, merged on the server
// ============================================================================

const SETTINGS_KEYS = ['name', 'tagline', 'address', 'phone', 'currencySymbol', 'receiptWidth', 'roundOff', 'printLogo', 'lastBackupAt', 'logoDataUrl'];

function settingsOk(p) {
  if (!isObj(p)) return false;
  if (Object.keys(p).some((k) => SETTINGS_KEYS.indexOf(k) < 0)) return false;
  const text = (k, min, max) => typeof p[k] === 'string' && chars(p[k]) >= min && chars(p[k]) <= max;
  const optional = (k, max) => !(k in p) || text(k, 0, max);
  if (!text('name', 1, 80) || !optional('tagline', 60) || !optional('address', 200) || !optional('phone', 20)) return false;
  if (!text('currencySymbol', 1, 3)) return false;
  if (['58', '80', 'A4'].indexOf(txt(p.receiptWidth)) < 0) return false;
  if (typeof p.roundOff !== 'boolean') return false;
  if ('printLogo' in p && typeof p.printLogo !== 'boolean') return false;
  if ('lastBackupAt' in p && !(typeof p.lastBackupAt === 'number' && isFinite(p.lastBackupAt))) return false;
  if ('logoDataUrl' in p) {
    const l = p.logoDataUrl;
    if (typeof l !== 'string' || l.length > 700000 || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(l)) return false; // same limit as the app
  }
  return true;
}

/** Change some settings and remove others in one step, so two phones don't undo each other. */
function opPatchSettings(db, a) {
  if (!isObj(a.p_set)) refuse('Invalid settings');
  const unset = a.p_unset === undefined || a.p_unset === null ? [] : a.p_unset;
  if (!Array.isArray(unset) || unset.some((k) => typeof k !== 'string')) refuse('Invalid settings');
  const row = db.all('settings')[0];
  if (!row) refuse('The shared database is not set up yet');
  const next = Object.assign({}, row.rec, a.p_set);
  unset.forEach((k) => {
    delete next[k];
  });
  if (!settingsOk(next)) refuse('Invalid settings');
  db.put('settings', [{ rec: next, rev: db.reserve(1) }]);
  return next;
}

// ============================================================================
// Menu and cheesy lines
// ============================================================================

function dishProblem(d) {
  if (typeof d.name !== 'string' || chars(d.name) < 1 || chars(d.name) > 60) return 'Dish name must be 1–60 characters';
  if (typeof d.category !== 'string' || chars(d.category) < 1 || chars(d.category) > 30) return 'Category must be 1–30 characters';
  if (!Number.isInteger(d.price_paise) || d.price_paise < 1 || d.price_paise > 10000000) return 'Price must be between 0.01 and 1,00,000';
  if (['is_veg', 'active', 'deleted', 'used_in_bills'].some((k) => typeof d[k] !== 'boolean')) return 'Invalid dish';
  return null;
}

function lineProblem(l) {
  if (typeof l.text !== 'string' || chars(l.text) < 1 || chars(l.text) > 120) return 'A cheesy line must be 1–120 characters';
  if (['built_in', 'active', 'removed'].some((k) => typeof l[k] !== 'boolean')) return 'Invalid cheesy line';
  return null;
}

function nextId(db, kind) {
  return db.all(kind).reduce((m, r) => Math.max(m, Number(r.rec.id) || 0), 0) + 1;
}

const DISH_NEW_KEYS = ['name', 'category', 'price_paise', 'is_veg', 'active'];
const DISH_EDIT_KEYS = ['name', 'category', 'price_paise', 'is_veg', 'active', 'deleted'];

function opInsertDishes(db, a) {
  const list = a.p_rows;
  if (!Array.isArray(list) || list.length < 1 || list.length > 500) refuse('Invalid dish');
  const now = Date.now();
  let id = nextId(db, 'menu');
  const rows = list.map((x) => {
    if (!isObj(x) || Object.keys(x).some((k) => DISH_NEW_KEYS.indexOf(k) < 0)) refuse('Invalid dish');
    const r = { id: id++, name: x.name, category: x.category, price_paise: x.price_paise, is_veg: x.is_veg, active: x.active === undefined ? true : x.active, deleted: false, used_in_bills: false, created_at: now, updated_at: now };
    const bad = dishProblem(r);
    if (bad) refuse(bad);
    return r;
  });
  const first = db.reserve(rows.length);
  db.put('menu', rows.map((r, i) => ({ rec: r, rev: first + i })));
  return rows.map((r, i) => Object.assign({}, r, { rev: first + i }));
}

function opUpdateDish(db, a) {
  const patch = a.p_patch;
  if (!isObj(patch) || Object.keys(patch).some((k) => DISH_EDIT_KEYS.indexOf(k) < 0)) refuse('Invalid dish change');
  const row = db.find('menu', txt(a.p_id) || '');
  if (!row) refuse('Dish not found in the shared database.');
  const next = Object.assign({}, row.rec, patch);
  const bad = dishProblem(next);
  if (bad) refuse(bad);
  // The server keeps the "last edited" time; being billed is not an edit.
  if (DISH_EDIT_KEYS.some((k) => next[k] !== row.rec[k])) next.updated_at = Date.now();
  const rev = db.reserve(1);
  db.put('menu', [{ rec: next, rev }]);
  return Object.assign({}, next, { rev });
}

function opInsertLine(db, a) {
  const r = { id: nextId(db, 'lines'), text: a.p_text, built_in: false, active: a.p_active === undefined ? true : a.p_active, removed: false };
  const bad = lineProblem(r);
  if (bad) refuse(bad);
  const rev = db.reserve(1);
  db.put('lines', [{ rec: r, rev }]);
  return Object.assign({}, r, { rev });
}

function opUpdateLine(db, a) {
  const patch = a.p_patch;
  if (!isObj(patch) || Object.keys(patch).some((k) => ['text', 'active', 'removed'].indexOf(k) < 0)) refuse('Invalid cheesy line change');
  const row = db.find('lines', txt(a.p_id) || '');
  if (!row) refuse('Line not found in the shared database.');
  const next = Object.assign({}, row.rec, patch);
  const bad = lineProblem(next);
  if (bad) refuse(bad);
  const rev = db.reserve(1);
  db.put('lines', [{ rec: next, rev }]);
  return Object.assign({}, next, { rev });
}

// ============================================================================
// One-time move of the first phone's data into the empty sheet
// ============================================================================

function hasBills(db) {
  return db.monthTabs().some((t) => t.sh.getLastRow() >= 2);
}

/**
 * Settings, menu, cheesy lines and receipt counters from the first phone. Allowed while the
 * sheet is empty, and again while that setup is still open (so an interrupted setup can resume).
 */
function opImportDevice(db, a) {
  const open = db.meta().importOpen === true;
  if (!open && (db.hasSettings() || db.all('menu').length || hasBills(db))) refuse('The shared database is already set up');
  if (!settingsOk(a.p_settings)) refuse('Invalid settings');
  const menu = a.p_menu;
  const lines = a.p_lines;
  const counters = a.p_counters === undefined || a.p_counters === null ? [] : a.p_counters;
  if (!Array.isArray(menu) || !Array.isArray(lines) || !Array.isArray(counters)) refuse('Invalid data from the phone');
  const now = Date.now();
  const ids = {};
  const dishes = menu.map((d) => {
    const r = isObj(d)
      ? {
          id: d.id, name: d.name, category: d.category, price_paise: d.pricePaise, is_veg: d.isVeg,
          active: d.active === undefined || d.active === null ? true : d.active,
          deleted: d.deleted === undefined || d.deleted === null ? false : d.deleted,
          used_in_bills: d.usedInBills === undefined || d.usedInBills === null ? false : d.usedInBills,
          created_at: typeof d.createdAt === 'number' ? d.createdAt : now,
          updated_at: typeof d.updatedAt === 'number' ? d.updatedAt : now,
        }
      : null;
    if (!r || !Number.isInteger(r.id) || r.id < 1 || ids['m' + r.id] || dishProblem(r)) refuse('Invalid dish from the phone: ' + String(isObj(d) ? d.name : d).slice(0, 60));
    ids['m' + r.id] = true;
    return r;
  });
  const lineRows = lines.map((l) => {
    const r = isObj(l)
      ? { id: l.id, text: l.text, built_in: l.builtIn === undefined || l.builtIn === null ? false : l.builtIn, active: l.active === undefined || l.active === null ? true : l.active, removed: false }
      : null;
    if (!r || !Number.isInteger(r.id) || r.id < 1 || ids['l' + r.id] || lineProblem(r)) refuse('Invalid cheesy line from the phone');
    ids['l' + r.id] = true;
    return r;
  });
  const counts = counters.map((c) => {
    if (!isObj(c) || !/^[0-9]{6}$/.test(String(c.monthKey)) || !Number.isInteger(c.last) || c.last < 0) refuse('Invalid receipt counter from the phone');
    const have = db.find('counters', c.monthKey);
    return { rec: { monthKey: c.monthKey, last: Math.max(c.last, have ? Number(have.rec.last) || 0 : 0) }, rev: 0 };
  });

  const first = db.reserve(1 + dishes.length + lineRows.length);
  db.put('counters', counts); // the phone's counters first: new bills never collide with old ones still uploading
  db.put('settings', [{ rec: a.p_settings, rev: first }]);
  db.put('menu', dishes.map((r, i) => ({ rec: r, rev: first + 1 + i })));
  db.clear('lines');
  db.put('lines', lineRows.map((r, i) => ({ rec: r, rev: first + 1 + dishes.length + i })));
  db.setMeta({ importOpen: true });
  return null;
}

/** The first phone's bills (kept months only), up to 1000 at a time; uploading twice is harmless. */
function opImportBills(db, a, who) {
  if (db.meta().importOpen !== true) refuse('Moving old bills is only allowed while setting up the shared database');
  const list = a.p_bills;
  if (!Array.isArray(list) || list.length > 1000) refuse('Send at most 1000 bills at a time');
  const keep = keepFromAt(Date.now());
  const byMonth = {};
  const top = {};
  list.forEach((b) => {
    const m = isObj(b) ? TB.BILL_NO_RE.exec(String(b.billNo)) : null;
    if (!m || b.monthKey !== m[2] || (b.status !== 'paid' && b.status !== 'void') || typeof b.createdAt !== 'number') {
      refuse('Invalid bill from the phone: ' + (isObj(b) ? String(b.billNo).slice(0, 30) : '?'));
    }
    if (b.monthKey < keep) return; // only the 3 kept months
    const bill = Object.assign({}, b);
    delete bill.sync;
    dataCells(JSON.stringify({ bill, by: who.username, ref: '' }), SPECS.bills.cells, 'Bill ' + b.billNo); // too large? refuse before writing
    (byMonth[b.monthKey] = byMonth[b.monthKey] || []).push(bill);
    top[b.monthKey] = Math.max(top[b.monthKey] || 0, Number(m[3]));
  });
  const fresh = {};
  let added = 0;
  Object.keys(byMonth).forEach((mk) => {
    const sh = db.billSheet(mk, false);
    const have = {};
    if (sh && sh.getLastRow() >= 2) {
      sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().forEach((v) => {
        have[String(v[0])] = true;
      });
    }
    fresh[mk] = byMonth[mk].filter((b) => {
      if (have[b.billNo]) return false;
      have[b.billNo] = true;
      return true;
    });
    added += fresh[mk].length;
  });
  let rev = db.reserve(added);
  db.put('counters', Object.keys(top).map((mk) => {
    const have = db.find('counters', mk);
    return { rec: { monthKey: mk, last: Math.max(top[mk], have ? Number(have.rec.last) || 0 : 0) }, rev: 0 };
  }));
  Object.keys(fresh).sort().forEach((mk) => {
    if (fresh[mk].length) db.addBills(mk, fresh[mk].map((bill) => ({ rec: { bill, by: who.username, ref: '' }, rev: rev++ })));
  });
  return added;
}

function opFinishImport(db) {
  db.setMeta({ importOpen: false });
  return null;
}

// ============================================================================
// Keep 3 months in Main (the Backup keeps every month)
// ============================================================================

function opPurge(db) {
  // Never delete a month from Main unless the Backup has every change.
  if (!syncBackupNow(db)) return 0;
  const keep = keepFromAt(Date.now());
  let removed = 0;
  db.monthTabs().forEach((t) => {
    if (t.month >= keep) return;
    try {
      copyRows(db, openBackup(true), 'bills', t.name, -1); // the whole month, once more, to be sure
      SpreadsheetApp.flush();
    } catch (e) {
      return; // the Backup can't be reached: keep the month in Main for now
    }
    removed += Math.max(t.sh.getLastRow() - 1, 0);
    db.ss.deleteSheet(t.sh);
  });
  return removed;
}

// ============================================================================
// Users (Settings → Users in the app, super admin only)
// ============================================================================

function opMyRole(db, a, who) {
  const me = activeUser(db, who.username);
  return me ? me.role : null;
}

function opListStaff(db, a, who) {
  requireSuperAdmin(db, who);
  return db
    .all('users')
    .filter((r) => !r.rec.removed)
    .map((r) => ({ username: r.rec.username, role: r.rec.role, me: r.rec.username === who.username, addedAt: r.rec.addedAt }))
    .sort((x, y) => (x.role === y.role ? (x.username < y.username ? -1 : 1) : x.role === 'super_admin' ? -1 : 1));
}

function opStaffAdmin(db, a, who) {
  requireSuperAdmin(db, who);
  const action = a.action;
  const name = typeof a.username === 'string' ? a.username.trim().toLowerCase() : '';
  if (['add', 'reset', 'remove'].indexOf(action) < 0) refuse('Unknown action');
  if (!TB.USER_ID_RE.test(name)) refuse(USER_ID_RULE);
  if (action !== 'remove') {
    const bad = passwordProblem(a.password);
    if (bad) refuse(bad);
  }
  const row = db.find('users', name);
  const live = row && !row.rec.removed ? row.rec : null;
  let rec;
  if (action === 'add') {
    if (live) refuse('User ID ' + name + ' is already used');
    rec = Object.assign({ username: name, role: 'staff', addedAt: Date.now(), removed: false }, passwordFields(a.password), { version: row ? Number(row.rec.version) + 1 : 1 });
  } else if (!live) {
    refuse('No user called ' + name);
  } else if (action === 'reset') {
    if (live.role === 'super_admin' && name !== who.username) refuse('Only that super admin can change their own password');
    // Changed by the owner: that person is signed out on every phone. Your own: you stay signed in here.
    rec = Object.assign({}, live, passwordFields(a.password), { version: name === who.username ? live.version : live.version + 1 });
  } else {
    if (name === who.username) refuse('You cannot remove yourself');
    if (live.role === 'super_admin') refuse('A super admin can only be removed from the Control sheet');
    rec = Object.assign({}, live, { removed: true, version: live.version + 1 });
  }
  db.put('users', [{ rec, rev: db.reserve(1) }]);
  forgetUser(name);
  return { username: name };
}

/** For the super admin in the app: is the Backup up to date, and what did the last check find? */
function opSheetStatus(db, a, who) {
  requireSuperAdmin(db, who);
  const st = backupState();
  const clock = db.clock();
  let health = null;
  try {
    health = JSON.parse(getProp('HEALTH') || 'null');
  } catch (e) {
    health = null;
  }
  return {
    backupOk: !st.dirty && st.rev >= clock,
    backupBehind: Math.max(clock - st.rev, 0),
    backupError: st.error || null,
    lastNightlyAt: Number(getProp('LAST_NIGHTLY_AT')) || null,
    lastCopyAt: Number(getProp('LAST_COPY_AT')) || null,
    health,
  };
}

// ============================================================================
// Owner tools: the Tikka Bites menu in the Control sheet, setup, nightly job
// ============================================================================

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('Tikka Bites')
    .addItem('Supabase backup: set up', 'menuSupabaseBackup')
    .addItem('Supabase backup: copy now', 'menuSupabaseBackupNow')
    .addSeparator()
    .addSubMenu(
      ui.createMenu('Google Sheets as the app\'s database')
        .addItem('Set up (first time)', 'setup')
        .addItem('Create or reset the owner login', 'menuOwnerLogin')
        .addSeparator()
        .addItem('Check the sheets now', 'menuCheck')
        .addItem('Make a backup copy now', 'menuCopyNow')
        .addItem('Switch the app to the Backup sheet', 'menuSwitchToBackup')
        .addSeparator()
        .addItem('Run the self-test (temporary files only)', 'selfTest'),
    )
    .addToUi();
}

function tellOwner(title, message) {
  try {
    const ui = SpreadsheetApp.getUi();
    ui.alert(title, message, ui.ButtonSet.OK);
  } catch (e) {
    console.log(title + ': ' + message); // run from the script editor: see the execution log
  }
}

function controlFile() {
  try {
    const active = SpreadsheetApp.getActiveSpreadsheet();
    if (active) return active;
  } catch (e) {
    // a trigger or the web app: no active spreadsheet
  }
  const id = realProps().getProperty('CONTROL_ID');
  return id ? SpreadsheetApp.openById(id) : null;
}

/** Newest first on the Status tab of the Control sheet. */
function writeStatus(title, lines) {
  try {
    lockOnly(() => {
      const ctl = controlFile();
      if (!ctl) return;
      let sh = ctl.getSheetByName('Status');
      if (!sh) {
        sh = ctl.insertSheet('Status', 0);
        sh.getRange(1, 1, 1, 3).setNumberFormat('@').setValues([['When (India time)', 'What', 'Result']]).setFontWeight('bold');
        sh.setFrozenRows(1);
      }
      const now = Date.now();
      const rows = lines.map((l) => [isoDate(now) + ' ' + timeText(now), title, cleanCell(l)]);
      sh.insertRowsAfter(1, rows.length);
      sh.getRange(2, 1, rows.length, 3).setNumberFormat('@').setValues(rows);
      if (sh.getMaxRows() > 300) sh.deleteRows(301, sh.getMaxRows() - 300);
    }, TB.LONG_LOCK_WAIT_MS);
  } catch (e) {
    console.warn('Status not written: ' + e.message);
  }
}

const README = {
  main: [
    'Tikka Bites – Main: the app reads and writes this file.',
    'Please do not type in it, sort it, or add, move or delete columns. Use the app. (Hand edits stop the app from saving here until they are undone.)',
    'Each month has its own tab: "Bills 2026-10" and so on. This file keeps this month and the 2 before it.',
    'The ₹ columns are for reading. The exact amounts are in the hidden Data columns.',
    'Every change is also copied to "Tikka Bites – Backup", which keeps every month.',
  ],
  backup: [
    'Tikka Bites – Backup: every change in the Main file is copied here straight away.',
    'Old months stay here permanently (the Main file keeps only 3 months).',
    'Please do not edit this file by hand.',
    'If the Main file is ever damaged: open "Tikka Bites – Control" → Tikka Bites menu → "Switch the app to the Backup sheet".',
  ],
  supabase: [
    'Tikka Bites – Supabase backup: every night the script copies the shop\'s data here from Supabase (the app\'s database).',
    'Every month stays here for good (Supabase and the phones keep only the last 3 months).',
    'Please do not type in it, sort it, or add, move or delete columns. (Hand edits stop the nightly copy until they are undone.)',
    'Each month has its own tab: "Bills 2026-10" and so on. The ₹ columns are for reading; the exact amounts are in the hidden Data columns.',
    'The Status tab of "Tikka Bites – Control" says when the last copy was made.',
  ],
};

/** A new data file with every tab ready and empty. */
function newDataFile(name, folder, dbId, readme) {
  const ss = SpreadsheetApp.create(name);
  if (folder) DriveApp.getFileById(ss.getId()).moveTo(folder);
  const first = ss.getSheets()[0];
  const about = ss.insertSheet('Read me', 0);
  about.getRange(1, 1, readme.length, 1).setNumberFormat('@').setValues(readme.map((l) => [l]));
  about.protect().setDescription('Tikka Bites').setWarningOnly(true);
  ['settings', 'menu', 'lines', 'users', 'counters', 'meta'].forEach((kind) => initTab(ss, SPECS[kind].tab, SPECS[kind], ss.getSheets().length));
  ss.deleteSheet(first);
  new Db(ss, name, true).setMeta({ rev: 0, dbId, importOpen: false, layout: 1 });
  SpreadsheetApp.flush();
  return ss.getId();
}

function installNightly() {
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (t.getHandlerFunction() === 'nightly') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('nightly').timeBased().everyDays(1).atHour(0).nearMinute(5).inTimezone('Asia/Kolkata').create();
}

/** Tikka Bites → Set up: makes the Main and Backup files, the nightly job and the sign-in secret. Safe to run again. */
function setup() {
  let message;
  try {
    message = lockOnly(() => {
      const props = realProps();
      const p = props.getProperties();
      const ctl = controlFile();
      if (ctl) props.setProperty('CONTROL_ID', ctl.getId());
      if (!p.TOKEN_SECRET) props.setProperty('TOKEN_SECRET', Utilities.getUuid() + Utilities.getUuid());
      if (p.MAIN_ID && p.BACKUP_ID) {
        SpreadsheetApp.openById(p.MAIN_ID); // still there?
        SpreadsheetApp.openById(p.BACKUP_ID);
        return 'Already set up. The nightly job was checked. Next: Create or reset the owner login, then Deploy → New deployment (google-sheets/README.md).';
      }
      const folder = DriveApp.createFolder('Tikka Bites data');
      const copies = folder.createFolder('Nightly copies');
      const dbId = Utilities.getUuid();
      const main = newDataFile('Tikka Bites – Main', folder, dbId, README.main);
      const backup = newDataFile('Tikka Bites – Backup', folder, dbId, README.backup);
      props.setProperties({ MAIN_ID: main, BACKUP_ID: backup, FOLDER_ID: folder.getId(), COPIES_ID: copies.getId(), BACKUP_REV: '0', BACKUP_DIRTY: '', BACKUP_ERROR: '' });
      return 'Set up done: the folder "Tikka Bites data" in your Google Drive has the Main and Backup sheets. Next: Tikka Bites → Create or reset the owner login.';
    }, TB.LONG_LOCK_WAIT_MS);
    installNightly();
  } catch (e) {
    message = 'Set up did not finish: ' + e.message + ' (a sheet may have been deleted: restore it from the Drive trash, then run Set up again).';
  }
  writeStatus('Set up', [message]);
  tellOwner('Tikka Bites', message);
  return message;
}

/** The super admin login (User ID + password), created or reset from the Control sheet. */
function setOwnerLogin(username, password) {
  const name = String(username || '').trim().toLowerCase();
  if (!TB.USER_ID_RE.test(name)) throw new TbError('rejected', USER_ID_RULE);
  const bad = passwordProblem(password);
  if (bad) throw new TbError('rejected', bad);
  return withLock((db) => {
    const row = db.find('users', name);
    const old = row ? row.rec : null;
    const rec = Object.assign({ username: name, addedAt: Date.now() }, old || {}, passwordFields(password), { role: 'super_admin', removed: false, version: old ? Number(old.version) + 1 : 1 });
    db.put('users', [{ rec, rev: db.reserve(1) }]);
    forgetUser(name);
    return 'Owner login ready: sign in to the app with User ID "' + name + '" and the password you just typed.' + (old ? ' Phones signed in as ' + name + ' must sign in again.' : '');
  });
}

function menuOwnerLogin() {
  const ui = SpreadsheetApp.getUi();
  const a = ui.prompt('Owner login (1 of 2)', 'User ID for the owner, for example: owner', ui.ButtonSet.OK_CANCEL);
  if (a.getSelectedButton() !== ui.Button.OK) return;
  const b = ui.prompt('Owner login (2 of 2)', 'New password (at least 8 characters). It shows while you type, so make sure nobody is watching.', ui.ButtonSet.OK_CANCEL);
  if (b.getSelectedButton() !== ui.Button.OK) return;
  let message;
  try {
    message = setOwnerLogin(a.getResponseText(), b.getResponseText());
  } catch (e) {
    message = 'Not changed: ' + e.message;
  }
  writeStatus('Owner login', [message]);
  ui.alert('Tikka Bites', message, ui.ButtonSet.OK);
}

/** Look for problems in Main and Backup, and check they hold the same data. Results: the Status tab. */
function healthCheck() {
  const problems = [];
  try {
    lockOnly(() => {
      const keep = keepFromAt(Date.now());
      let main = null;
      let backup = null;
      try {
        main = openMain(false);
      } catch (e) {
        problems.push(e.message);
      }
      try {
        backup = openBackup(false);
      } catch (e) {
        problems.push(e.message);
      }
      const sm = main ? scan(main, problems) : null;
      const sb = backup ? scan(backup, problems) : null;
      if (sm && sb) {
        SMALL.forEach((kind) => {
          if (kind === 'meta') return;
          const diff = differences(sm.small[kind], sb.small[kind]);
          if (diff) problems.push('Main and Backup differ in "' + SPECS[kind].tab + '" (' + diff + ' rows). The next change copies it again; if it stays, check by hand.');
        });
        Object.keys(sm.bills).forEach((mk) => {
          if (mk < keep) return;
          const diff = differences(sm.bills[mk], sb.bills[mk] || {});
          if (diff) problems.push('Main and Backup differ in "' + billsTab(mk) + '" (' + diff + ' bills).');
        });
      }
      if (backup) {
        const cells = backup.ss.getSheets().reduce((n, sh) => n + sh.getMaxRows() * sh.getMaxColumns(), 0);
        if (cells > TB.BACKUP_CELLS_WARN) problems.push('The Backup sheet is getting full (' + (cells / 1e6).toFixed(1) + ' of 10 million cells). Time to start a new Backup file.');
      }
      if (backupState().dirty) problems.push('The Backup sheet is behind: ' + backupState().error);
    }, TB.LONG_LOCK_WAIT_MS);
  } catch (e) {
    problems.push('The check could not run: ' + e.message);
  }
  const h = { at: Date.now(), ok: problems.length === 0, problems: problems.slice(0, 20) };
  setProps({ HEALTH: JSON.stringify(h) });
  return h;
}

/** Read every row of one file: damaged rows, repeated receipt numbers, counters or clock behind. */
function scan(db, problems) {
  const out = { small: {}, bills: {} };
  let clock = 0;
  let maxRev = 0;
  SMALL.forEach((kind) => {
    out.small[kind] = {};
    try {
      db.all(kind).forEach((r) => {
        out.small[kind][r.key] = r.rev + ' ' + JSON.stringify(r.rec);
        maxRev = Math.max(maxRev, r.rev);
      });
    } catch (e) {
      problems.push(e.message);
    }
  });
  try {
    clock = db.clock();
  } catch (e) {
    problems.push(e.message);
  }
  const counters = {};
  Object.keys(out.small.counters || {}).forEach((mk) => {
    const r = db.find('counters', mk);
    counters[mk] = r ? Number(r.rec.last) || 0 : 0;
  });
  const spec = SPECS.bills;
  const L = layout(spec);
  db.monthTabs().forEach((t) => {
    const seen = {};
    out.bills[t.month] = seen;
    try {
      const sh = db.sheet(t.name, spec, false);
      const last = sh.getLastRow();
      const values = last >= 2 ? sh.getRange(2, 1, last - 1, L.width).getValues() : [];
      let top = 0;
      values.forEach((v, i) => {
        let p;
        try {
          p = parseRow(spec, v, db.label + ' › ' + t.name + ' row ' + (i + 2));
        } catch (e) {
          problems.push(e.message);
          return;
        }
        if (!p) return;
        const no = p.rec.bill.billNo;
        if (seen[no]) problems.push(db.label + ': receipt ' + no + ' appears twice in "' + t.name + '".');
        seen[no] = p.rev + ' ' + JSON.stringify(p.rec);
        maxRev = Math.max(maxRev, p.rev);
        const m = TB.BILL_NO_RE.exec(no);
        if (m) top = Math.max(top, Number(m[3]));
      });
      if (top > (counters[t.month] || 0)) problems.push(db.label + ': the receipt counter for ' + t.month + ' is behind (' + (counters[t.month] || 0) + ' < ' + top + ').');
    } catch (e) {
      problems.push(e.message);
    }
  });
  if (maxRev > clock) problems.push(db.label + ': the change counter is behind (' + clock + ' < ' + maxRev + ').');
  return out;
}

function differences(a, b) {
  let n = 0;
  Object.keys(a || {}).forEach((k) => {
    if ((b || {})[k] !== a[k]) n++;
  });
  Object.keys(b || {}).forEach((k) => {
    if (!(a || {})[k]) n++;
  });
  return n;
}

/** A dated copy of Main in "Nightly copies"; only the newest 14 are kept (older ones go to the trash). */
function copyMainNow() {
  return lockOnly(() => {
    const f = files();
    const now = Date.now();
    const name = 'Tikka Bites – Main ' + isoDate(now) + ' ' + timeText(now).replace(':', '.');
    const folder = DriveApp.getFolderById(f.copies);
    DriveApp.getFileById(f.main).makeCopy(name, folder);
    const list = [];
    const it = folder.getFiles();
    while (it.hasNext()) list.push(it.next());
    list.sort((x, y) => y.getDateCreated().getTime() - x.getDateCreated().getTime());
    list.slice(TB.COPIES_KEPT).forEach((x) => x.setTrashed(true));
    setProps({ LAST_COPY_AT: String(now) });
    return 'Copy saved: ' + name;
  }, TB.LONG_LOCK_WAIT_MS);
}

/** Every night at about 00:05 India time. */
function nightly() {
  const report = [];
  try {
    withLock(
      (db) => {
        report.push(syncBackupNow(db) ? 'Backup sheet: up to date' : 'Backup sheet could not be updated: ' + backupState().error);
        const n = opPurge(db);
        if (n) report.push('Old months cleared from Main: ' + n + ' bills (they stay in the Backup sheet)');
      },
      { waitMs: TB.LONG_LOCK_WAIT_MS, noMirror: true },
    );
  } catch (e) {
    report.push('Nightly clean-up did not run: ' + e.message);
  }
  try {
    report.push(copyMainNow());
  } catch (e) {
    report.push('Nightly copy failed: ' + e.message);
  }
  const h = healthCheck();
  report.push(h.ok ? 'Check: everything is fine' : 'Check found problems: ' + h.problems.join(' · '));
  setProps({ LAST_NIGHTLY_AT: String(Date.now()) });
  writeStatus('Nightly', report);
  return report;
}

function menuCheck() {
  const h = healthCheck();
  const msg = h.ok ? 'Everything is fine: Main and Backup match, and no damaged rows were found.' : 'Problems found:\n• ' + h.problems.join('\n• ');
  writeStatus('Check', [msg]);
  tellOwner('Tikka Bites check', msg);
}

function menuCopyNow() {
  let msg;
  try {
    msg = copyMainNow();
  } catch (e) {
    msg = 'Copy failed: ' + e.message;
  }
  writeStatus('Copy', [msg]);
  tellOwner('Tikka Bites', msg);
}

/**
 * If Main is damaged: the Backup becomes Main (same data, same change numbers, so phones carry
 * on), and a fresh Backup is copied from it, so the old months stay safe. Main is renamed, kept.
 */
function switchToBackupNow() {
  const msg = lockOnly(() => {
    const f = files();
    let note = '';
    try {
      if (!syncBackupNow(openMain(true))) note = ' The newest changes could not be copied first: ' + backupState().error;
    } catch (e) {
      note = ' (Main could not be read: ' + e.message + ')';
    }
    const now = Date.now();
    const folder = f.folder ? DriveApp.getFolderById(f.folder) : null;
    const backupFile = DriveApp.getFileById(f.backup);
    const fresh = folder ? backupFile.makeCopy('Tikka Bites – Backup', folder) : backupFile.makeCopy('Tikka Bites – Backup');
    try {
      DriveApp.getFileById(f.main).setName('Tikka Bites – Main (damaged ' + isoDate(now) + ')');
    } catch (e) {
      // already gone
    }
    backupFile.setName('Tikka Bites – Main');
    const clock = openFile(f.backup, 'Main', false).clock();
    setProps({ MAIN_ID: f.backup, BACKUP_ID: fresh.getId(), BACKUP_REV: String(clock), BACKUP_DIRTY: '', BACKUP_ERROR: '' });
    return 'Done: the app now uses the former Backup sheet as Main, and a fresh Backup was copied from it. The old Main was renamed "(damaged …)" and kept.' + note;
  }, TB.LONG_LOCK_WAIT_MS);
  writeStatus('Switch to Backup', [msg]);
  return msg;
}

function menuSwitchToBackup() {
  const ui = SpreadsheetApp.getUi();
  const ok = ui.alert('Switch the app to the Backup sheet?', 'Only do this if the Main sheet is damaged. The app keeps working with the same data.', ui.ButtonSet.YES_NO);
  if (ok !== ui.Button.YES) return;
  let msg;
  try {
    msg = switchToBackupNow();
  } catch (e) {
    msg = 'Not switched: ' + e.message;
  }
  ui.alert('Tikka Bites', msg, ui.ButtonSet.OK);
}

/**
 * Runs the real thing on Google with two temporary sheets (never the live ones), then moves
 * them to the trash. Also measures how long a password check takes and tunes it to ~0.3 s.
 */
function selfTest() {
  const lines = [];
  const made = [];
  const check = (ok, what) => {
    if (!ok) throw new Error(what);
    lines.push('✓ ' + what);
  };
  const realSecret = realProps().getProperty('TOKEN_SECRET');
  try {
    const dbId = 'selftest-' + Utilities.getUuid();
    lockOnly(() => {
      made.push(newDataFile('Tikka Bites self-test Main (safe to delete)', null, dbId, ['Self-test']));
      made.push(newDataFile('Tikka Bites self-test Backup (safe to delete)', null, dbId, ['Self-test']));
    }, TB.LONG_LOCK_WAIT_MS);
    OVERRIDE = { props: { MAIN_ID: made[0], BACKUP_ID: made[1], TOKEN_SECRET: realSecret || Utilities.getUuid() + Utilities.getUuid(), BACKUP_REV: '0' } };

    let t = Date.now();
    hashPassword('self-test-pass-1', 'salt', hashRounds());
    const hashMs = Math.max(Date.now() - t, 1);
    lines.push('Password check: ' + hashMs + ' ms (' + hashRounds() + ' rounds)');
    if (!realProps().getProperty('HASH_ROUNDS_FIXED')) {
      const tuned = Math.min(Math.max(Math.round((hashRounds() * 300) / hashMs / 100) * 100, 1000), 20000);
      realProps().setProperty('HASH_ROUNDS', String(tuned));
      lines.push('New passwords will use ' + tuned + ' rounds');
    }

    setOwnerLogin('selftest', 'self-test-pass-1');
    t = Date.now();
    const s = handleRequest({ fn: 'sign_in', args: { username: 'selftest', password: 'self-test-pass-1' } });
    lines.push('Sign-in: ' + (Date.now() - t) + ' ms');
    const call = (fn, args) => handleRequest({ fn, args, token: s.accessToken });
    const now = Date.now();
    call('import_device_data', {
      p_menu: [{ id: 1, name: 'Test Tikka', category: 'Test', pricePaise: 25000, isVeg: false, createdAt: now, updatedAt: now }],
      p_lines: [], p_settings: { name: 'Self-test', currencySymbol: '₹', receiptWidth: '80', roundOff: true }, p_counters: [],
    });
    call('finish_import', {});
    const bill = { clientRef: Utilities.getUuid(), items: [{ menuId: 1, qty: 2, unitPaise: 25000 }], orderType: 'takeaway', paymentMode: 'cash', discount: { kind: 'flat', paise: 0 }, roundOffPaise: 0, totalPaise: 50000, cheesyLine: '' };
    t = Date.now();
    const b1 = call('save_bill', { p_bill: bill });
    lines.push('Save a bill: ' + (Date.now() - t) + ' ms');
    check(call('save_bill', { p_bill: bill }).billNo === b1.billNo, 'a retried bill gets the same receipt number');
    const b3 = call('save_bill', { p_bill: Object.assign({}, bill, { clientRef: Utilities.getUuid() }) });
    check(Number(b3.billNo.slice(-4)) === Number(b1.billNo.slice(-4)) + 1, 'the next bill gets the next number');
    check(call('void_bill', { p_bill_no: b1.billNo, p_reason: 'self-test' }).status === 'void', 'voiding works');
    const page = call('pull_changes', { p_since: 0, p_limit: 500 });
    check(page.bills.length === 2 && page.menu.length === 1 && page.ready, 'a phone downloads every change');
    t = Date.now();
    call('pull_changes', { p_since: page.rev });
    lines.push('Sync with nothing new: ' + (Date.now() - t) + ' ms');
    const h = healthCheck();
    check(h.ok, 'Main and Backup match' + (h.ok ? '' : ': ' + h.problems.join('; ')));
    lines.unshift('Self-test passed.');
  } catch (e) {
    lines.unshift('Self-test FAILED: ' + e.message);
  } finally {
    OVERRIDE = null;
    made.forEach((id) => {
      try {
        DriveApp.getFileById(id).setTrashed(true);
      } catch (e) {
        // already gone
      }
    });
  }
  writeStatus('Self-test', lines);
  tellOwner('Tikka Bites self-test', lines.join('\n'));
  return lines;
}

// ============================================================================
// Supabase backup: while the app uses Supabase, copy everything into a Google Sheet
// ============================================================================
// Every night (about 3 am India time) the script asks Supabase for every change since the
// last copy (public.backup_pull in supabase/schema.sql: read only, locked by a backup key)
// and writes it into "Tikka Bites – Supabase backup", with the same tabs and rules as the
// sheets above: everything checked first, then written; one row per record, found by its
// key, never moved. Old months stay here for good (Supabase keeps only 3). Nothing is ever
// written to Supabase. A copy that stops halfway is simply done again next time: rows are
// found by key, so nothing is doubled. Set up: Tikka Bites → Supabase backup: set up.

const SB = { PAGE: 500, RUN_MS: 4 * 60000, HOUR: 3, FILE: 'Tikka Bites – Supabase backup' };
const SB_SECRET_KEY = 'That is the SECRET (service_role) key. Paste the anon / publishable key instead, and keep the secret key private.';

function sbHex(bytes) {
  return bytes.map((b) => ((b + 256) % 256).toString(16).padStart(2, '0')).join('');
}

/** What Supabase stores: the SHA-256 of the backup key (the key itself stays in this script). */
function sbKeyHash(key) {
  return sbHex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, key, Utilities.Charset.UTF_8));
}

function sbSqlLine(key) {
  return "select public.set_backup_key('" + sbKeyHash(key) + "');";
}

function sbJwtRole(key) {
  const parts = key.split('.');
  if (parts.length !== 3) return null;
  let s = parts[1];
  while (s.length % 4) s += '=';
  try {
    const p = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(s)).getDataAsString());
    return isObj(p) ? String(p.role || '') : null;
  } catch (e) {
    return null;
  }
}

/** Only the project address and the PUBLIC key are accepted, never the secret key. */
function sbCheckSettings(url, anonKey) {
  const u = String(url || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(u)) refuse('The Supabase address should look like https://abcd1234.supabase.co (Supabase → Project Settings → API).');
  const k = String(anonKey || '').trim();
  if (/^sb_secret_/.test(k)) refuse(SB_SECRET_KEY);
  if (/^eyJ/.test(k)) {
    const role = sbJwtRole(k);
    if (role === 'service_role') refuse(SB_SECRET_KEY);
    if (role !== 'anon') refuse('That key could not be read as the anon key. Copy the anon / publishable key again (Supabase → Project Settings → API).');
  } else if (!/^sb_publishable_[A-Za-z0-9_-]{10,}$/.test(k)) {
    refuse('Paste the anon / publishable key (Supabase → Project Settings → API).');
  }
  return { url: u, anon: k };
}

function sbConfig() {
  const url = getProp('SB_URL');
  const anon = getProp('SB_ANON');
  const key = getProp('SB_KEY');
  if (!url || !anon || !key) throw new TbError('setup', 'The Supabase backup is not set up yet: Tikka Bites → Supabase backup: set up.');
  return { url, anon, key };
}

/** The "Tikka Bites data" folder (the same one the Google Sheets database uses). */
function sbFolder() {
  const ids = [getProp('FOLDER_ID'), getProp('SB_FOLDER')];
  for (let i = 0; i < ids.length; i++) {
    if (!ids[i]) continue;
    try {
      return DriveApp.getFolderById(ids[i]);
    } catch (e) {
      // deleted: try the next one, or make a new folder
    }
  }
  const f = DriveApp.createFolder('Tikka Bites data');
  setProps({ SB_FOLDER: f.getId() });
  return f;
}

function sbOpen(writable) {
  const id = getProp('SB_FILE');
  if (!id) throw new TbError('setup', 'The Supabase backup is not set up yet: Tikka Bites → Supabase backup: set up.');
  let ss;
  try {
    ss = SpreadsheetApp.openById(id);
  } catch (e) {
    throw new TbError('setup', 'The "' + SB.FILE + '" sheet can\'t be opened (deleted or in the Drive trash?). Restore it from the trash, or run Supabase backup: set up again to start a new one.');
  }
  return new Db(ss, 'Supabase backup', writable);
}

/** A new, empty backup file (first set-up, or the Supabase database was re-created). */
function sbNewFile(name) {
  const id = newDataFile(name, sbFolder(), '', README.supabase);
  setProps({ SB_FILE: id, SB_REV: '0', SB_DBID: '' });
  return sbOpen(true);
}

/** Tikka Bites → Supabase backup: set up. Safe to run again (the backup key and the file are kept). */
function setupSupabaseBackup(url, anonKey) {
  const cfg = sbCheckSettings(url, anonKey);
  const key = lockOnly(() => {
    const ctl = controlFile();
    if (ctl) setProps({ CONTROL_ID: ctl.getId() });
    const k = getProp('SB_KEY') || (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    setProps({ SB_URL: cfg.url, SB_ANON: cfg.anon, SB_KEY: k });
    let have = false;
    if (getProp('SB_FILE')) {
      try {
        SpreadsheetApp.openById(getProp('SB_FILE'));
        have = true;
      } catch (e) {
        // deleted: start a new one below
      }
    }
    if (!have) sbNewFile(SB.FILE);
    return k;
  }, TB.LONG_LOCK_WAIT_MS);
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (t.getHandlerFunction() === 'supabaseBackup') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('supabaseBackup').timeBased().everyDays(1).atHour(SB.HOUR).nearMinute(0).inTimezone('Asia/Kolkata').create();
  const sql = sbSqlLine(key);
  return {
    sql,
    message:
      'Almost done. Last step, once: open Supabase → SQL Editor, paste this line and click Run:\n\n' + sql +
      '\n\n(The same line is on the Status tab.) Then choose Tikka Bites → Supabase backup: copy now. After that it copies by itself every night at about 3 am.',
  };
}

/** Ask Supabase for one page of changes after `since`. */
function sbFetch(cfg, since) {
  let res;
  try {
    res = UrlFetchApp.fetch(cfg.url + '/rest/v1/rpc/backup_pull', {
      method: 'post',
      contentType: 'application/json',
      headers: { apikey: cfg.anon, Authorization: 'Bearer ' + cfg.anon },
      payload: JSON.stringify({ p_key: cfg.key, p_since: since, p_limit: SB.PAGE }),
      muteHttpExceptions: true,
    });
  } catch (e) {
    throw new TbError('server', 'Supabase could not be reached (' + String((e && e.message) || e).slice(0, 150) + '). It tries again tomorrow night, or choose Supabase backup: copy now.');
  }
  const code = res.getResponseCode();
  const text = String(res.getContentText() || '');
  let body = null;
  try {
    body = JSON.parse(text);
  } catch (e) {
    // not JSON: handled below
  }
  if (code === 200 && isObj(body)) return body;
  const msg = isObj(body) && body.message ? String(body.message) : text.slice(0, 200);
  if (/Wrong backup key/.test(msg)) throw new TbError('setup', 'Supabase did not accept the backup key. Run this line once in Supabase → SQL Editor: ' + sbSqlLine(cfg.key));
  if (code === 404 || /backup_pull/.test(msg)) throw new TbError('setup', 'Supabase does not have the backup function yet: run supabase/schema.sql in Supabase → SQL Editor.');
  if (code === 401 || /Invalid API key|JWT/i.test(msg)) throw new TbError('setup', 'Supabase refused the public key. Run Supabase backup: set up again with the anon / publishable key.');
  throw new TbError('server', 'Supabase answered ' + code + ' (' + msg.slice(0, 150) + '). If the project is paused, open the Supabase dashboard and click Restore project.');
}

function sbBad(what) {
  return new TbError('server', 'Supabase sent ' + what + ' that the backup does not understand. Is supabase/schema.sql up to date? Nothing was written.');
}

/** Turn one page into rows. Everything is checked here, before anything is written. */
function sbPrepare(page) {
  if (!isObj(page) || !Array.isArray(page.menu) || !Array.isArray(page.lines) || !Array.isArray(page.bills) || typeof page.more !== 'boolean' || !(Number(page.rev) >= 0) || !TB.UUID_RE.test(String(page.dbId))) {
    throw sbBad('an answer');
  }
  const small = { settings: [], menu: [], lines: [] };
  ['menu', 'lines'].forEach((kind) => {
    page[kind].forEach((r) => {
      if (!isObj(r) || !(Number(r.id) > 0)) throw sbBad(kind === 'menu' ? 'a dish' : 'a cheesy line');
      const rec = Object.assign({}, r);
      delete rec.rev;
      small[kind].push({ rec, rev: Number(r.rev) || 0 });
    });
  });
  if (page.settings !== null && page.settings !== undefined) {
    if (!isObj(page.settings) || !isObj(page.settings.data)) throw sbBad('the settings');
    small.settings.push({ rec: page.settings.data, rev: Number(page.settings.rev) || 0 });
  }
  Object.keys(small).forEach((kind) => small[kind].forEach((x) => buildRow(SPECS[kind], x.rec, x.rev, SPECS[kind].tab))); // too large? refuse now
  const months = {};
  page.bills.forEach((x) => {
    const no = isObj(x) ? String(x.no || (isObj(x.bill) && x.bill.billNo) || '') : '';
    const m = TB.BILL_NO_RE.exec(no);
    if (!m || !isObj(x.bill)) throw sbBad('a bill (' + no.slice(0, 30) + ')');
    const bill = x.bill.billNo === no ? x.bill : Object.assign({}, x.bill, { billNo: no });
    const rec = { bill, by: typeof x.by === 'string' ? x.by : '', ref: typeof x.ref === 'string' ? x.ref : '' };
    const mo = (months[m[2]] = months[m[2]] || { keys: [], rows: [], top: 0 });
    mo.keys.push(no);
    mo.rows.push(buildRow(SPECS.bills, rec, Number(x.rev) || 0, 'Bill ' + no));
    mo.top = Math.max(mo.top, Number(m[3]));
  });
  return { small, months };
}

/** Write one checked page. The change number goes in last: it means "copied up to here". */
function sbApply(db, prep, page) {
  ['settings', 'menu', 'lines'].forEach((kind) => db.put(kind, prep.small[kind]));
  Object.keys(prep.months).sort().forEach((mk) => {
    const x = prep.months[mk];
    upsertValues(db.billSheet(mk, true), SPECS.bills, x.keys, x.rows);
  });
  db.put('counters', Object.keys(prep.months).map((mk) => {
    const have = db.find('counters', mk);
    return { rec: { monthKey: mk, last: Math.max(prep.months[mk].top, have ? Number(have.rec.last) || 0 : 0) }, rev: 0 };
  }));
  db.setMeta({ rev: Math.max(db.clock(), Number(page.rev)), dbId: page.dbId });
}

/** Every month Supabase still has must be complete here. If not, everything is copied again. */
function sbCompare(db, counts, report) {
  if (!isObj(counts)) return;
  const missing = [];
  let total = 0;
  Object.keys(counts).sort().forEach((mk) => {
    const want = Number(counts[mk]) || 0;
    const sh = /^\d{6}$/.test(mk) ? db.billSheet(mk, false) : null;
    const have = sh ? Math.max(sh.getLastRow() - 1, 0) : 0;
    total += want;
    if (have < want) missing.push(billsTab(mk) + ': ' + (want - have) + ' missing');
  });
  if (missing.length) {
    setProps({ SB_REV: '0' });
    report.push('Bills were missing (' + missing.join(', ') + '). Everything is copied again in a few minutes.');
    sbContinueSoon();
    return;
  }
  const older = db.monthTabs().filter((t) => !Object.prototype.hasOwnProperty.call(counts, t.month)).length;
  report.push('Checked: all ' + total + ' bills Supabase has are in the sheet' + (older ? ', plus ' + older + ' older month' + (older > 1 ? 's' : '') + ' kept only here.' : '.'));
}

/** A big first copy goes on in a few minutes (Google stops a run after 6 minutes). */
function sbContinueSoon() {
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (t.getHandlerFunction() === 'supabaseBackupMore') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('supabaseBackupMore').timeBased().after(2 * 60000).create();
}

/** The nightly job. Throws when it fails, so Google emails the owner about it. */
function supabaseBackup() {
  const start = Date.now();
  const report = [];
  let failed = null;
  try {
    lockOnly(() => {
      const cfg = sbConfig();
      let db = sbOpen(true);
      let since = Number(getProp('SB_REV')) || 0;
      let bills = 0;
      for (let guard = 0; guard < 10000; guard++) {
        const page = sbFetch(cfg, since);
        const prep = sbPrepare(page);
        const known = getProp('SB_DBID') || String(db.meta().dbId || '');
        if (known && known !== page.dbId) {
          db = sbNewFile(SB.FILE + ' (from ' + isoDate(Date.now()) + ')');
          since = 0;
          report.push('Supabase is a new database (re-created, or another project), so a new backup file was started. The old file is kept as it is.');
          continue;
        }
        sbApply(db, prep, page);
        SpreadsheetApp.flush();
        setProps({ SB_REV: String(page.rev), SB_DBID: page.dbId });
        since = Number(page.rev);
        bills += page.bills.length;
        if (!page.more) {
          sbCompare(db, page.counts, report);
          break;
        }
        if (Date.now() - start > SB.RUN_MS) {
          sbContinueSoon();
          report.push('More to copy: it carries on by itself in a few minutes.');
          break;
        }
      }
      report.unshift('Copied from Supabase: ' + bills + ' new or changed bills (up to change ' + since + ').');
      const problems = [];
      scan(db, problems);
      report.push(problems.length ? 'Check found problems: ' + problems.slice(0, 5).join(' · ') : 'Check: no damaged rows.');
    }, TB.LONG_LOCK_WAIT_MS);
  } catch (e) {
    failed = e;
    report.push('The backup did not finish: ' + e.message);
  }
  const done = { SB_LAST_AT: String(Date.now()), SB_ERROR: failed ? String(failed.message).slice(0, 300) : '' };
  if (!failed) done.SB_LAST_OK_AT = done.SB_LAST_AT;
  setProps(done);
  writeStatus('Supabase backup', report);
  if (failed) throw failed;
  return report;
}

/** The follow-up run of a big copy (a one-off trigger, removed here). */
function supabaseBackupMore() {
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (t.getHandlerFunction() === 'supabaseBackupMore') ScriptApp.deleteTrigger(t);
  });
  return supabaseBackup();
}

function menuSupabaseBackup() {
  const ui = SpreadsheetApp.getUi();
  const a = ui.prompt('Supabase backup (1 of 2)', 'The Supabase project address (Supabase → Project Settings → API), for example https://abcd1234.supabase.co', ui.ButtonSet.OK_CANCEL);
  if (a.getSelectedButton() !== ui.Button.OK) return;
  const b = ui.prompt('Supabase backup (2 of 2)', 'The anon / publishable key: the PUBLIC one the app uses (never the secret / service_role key).', ui.ButtonSet.OK_CANCEL);
  if (b.getSelectedButton() !== ui.Button.OK) return;
  let msg;
  try {
    const r = setupSupabaseBackup(a.getResponseText(), b.getResponseText());
    writeStatus('Supabase backup set up', ['Run once in Supabase → SQL Editor: ' + r.sql]);
    msg = r.message;
  } catch (e) {
    msg = 'Not set up: ' + e.message;
    writeStatus('Supabase backup set up', [msg]);
  }
  ui.alert('Tikka Bites', msg, ui.ButtonSet.OK);
}

function menuSupabaseBackupNow() {
  let lines;
  try {
    lines = supabaseBackup();
  } catch (e) {
    lines = ['The backup did not finish: ' + e.message];
  }
  tellOwner('Tikka Bites – Supabase backup', lines.join('\n'));
}
