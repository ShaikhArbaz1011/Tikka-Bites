// A stand-in for Google Apps Script and Google Sheets, so google-sheets/Code.gs can be
// tested on this PC (tests/unit/sheetsBackend.test.ts, scripts/fake-sheets.mjs).
//
// It behaves like the real thing where that matters for corruption:
//  - a cell that is not plain text turns "123" into a number, "TRUE" into true and
//    "=…" / "+x" into a formula (counted in formulaWrites, which must stay 0)
//  - at most 50,000 characters in a cell; ranges outside the sheet are refused
//  - writes are applied one call at a time, so a crash in the middle leaves the
//    earlier calls done (failAfterWrites / failFile inject such crashes)
//  - every write must happen while the script lock is held, and the lock must not be
//    released before SpreadsheetApp.flush() (both are recorded in violations)
//  - every call of a script function runs in a fresh JavaScript context, like each
//    Apps Script execution, sharing only the sheets, Drive, cache and properties.
import vm from 'node:vm';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const CODE = new vm.Script(readFileSync(new URL('../../google-sheets/Code.gs', import.meta.url), 'utf8'), { filename: 'Code.gs' });

const toSigned = (buf) => Array.from(buf, (b) => (b > 127 ? b - 256 : b));
const toBuf = (v) => (typeof v === 'string' ? Buffer.from(v, 'utf8') : Buffer.from(v.map((b) => b & 255)));
const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

export function createRuntime(opts = {}) {
  const rt = {
    clock: opts.now ?? null, // fixed time (ms) for tests, or null for the real time
    files: new Map(), // id → spreadsheet or folder
    props: new Map(),
    cache: new Map(),
    triggers: [],
    lockHeld: false,
    lockBusy: false, // another execution holds the lock
    dirty: false,
    writes: 0,
    failAfter: Infinity,
    failFiles: new Set(),
    formulaWrites: 0,
    propReads: 0, // Google allows about 50,000 property reads a day
    violations: [],
    evictCache: false,
    ui: null,
    activeId: null,
    logs: [],
    fetch: null, // UrlFetchApp: (url, opts) => { code, body } (throw = no connection)
    fetches: [],
  };
  const now = () => (rt.clock ?? Date.now());

  // ---------------------------------------------------------------- sheets
  function write(ss) {
    if (rt.failFiles.has(ss.id)) throw new Error(`Service Spreadsheets failed while accessing document with id ${ss.id}.`);
    if (!rt.lockHeld) {
      rt.violations.push('a sheet was written without the lock');
      throw new Error('write without the script lock (test rule)');
    }
    rt.writes += 1;
    if (rt.writes > rt.failAfter) throw new Error('Service Spreadsheets failed (injected crash)');
    rt.dirty = true;
  }

  function store(v, fmt) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    if (v instanceof Date) return v;
    if (typeof v !== 'string') throw new Error('Unsupported value: ' + typeof v);
    if (v.length > 50000) throw new Error('Your input contains more than the maximum of 50000 characters in a single cell.');
    if (fmt === '@') return v; // plain text: kept exactly
    if (v.startsWith("'")) return v.slice(1);
    if (v.startsWith('=') || (/^[+-]/.test(v) && !NUMERIC.test(v.trim()))) {
      rt.formulaWrites += 1;
      return '#ERROR!';
    }
    if (v.trim() !== '' && NUMERIC.test(v.trim())) return Number(v);
    if (/^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
    return v;
  }

  function display(v, fmt) {
    if (typeof v === 'number') return fmt === '0.00' ? v.toFixed(2) : String(v);
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    return String(v);
  }

  class Sheet {
    constructor(ss, name) {
      this.ss = ss;
      this.name = name;
      this.rows = 1000;
      this.cols = 26;
      this.v = []; // v[r][c], 0-based
      this.f = [];
      this.frozen = 0;
      this.hidden = new Set();
      this.protected = false;
    }
    getName() {
      return this.name;
    }
    setName(n) {
      write(this.ss);
      if (this.ss.sheets.some((s) => s !== this && s.name === n)) throw new Error(`A sheet with the name "${n}" already exists. Please enter another name.`);
      this.name = n;
      return this;
    }
    /** 1-based position, like Apps Script. */
    getIndex() {
      return this.ss.sheets.indexOf(this) + 1;
    }
    getMaxRows() {
      return this.rows;
    }
    getMaxColumns() {
      return this.cols;
    }
    getLastRow() {
      for (let r = Math.min(this.v.length, this.rows) - 1; r >= 0; r--) {
        if ((this.v[r] ?? []).some((x) => x !== '' && x !== undefined && x !== null)) return r + 1;
      }
      return 0;
    }
    getLastColumn() {
      let last = 0;
      for (const row of this.v) if (row) for (let c = row.length - 1; c >= last; c--) if (row[c] !== '' && row[c] !== undefined) last = c + 1;
      return last;
    }
    cell(r, c) {
      return this.v[r]?.[c] ?? '';
    }
    fmt(r, c) {
      return this.f[r]?.[c] ?? '';
    }
    put(r, c, value) {
      (this.v[r] ??= [])[c] = store(value, this.fmt(r, c));
    }
    getRange(row, col, numRows = 1, numCols = 1) {
      if (!Number.isInteger(row) || !Number.isInteger(col) || row < 1 || col < 1 || numRows < 1 || numCols < 1 || row + numRows - 1 > this.rows || col + numCols - 1 > this.cols) {
        throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
      }
      return new Range(this, row, col, numRows, numCols);
    }
    insertRowsAfter(after, n) {
      write(this.ss);
      this.v.splice(after, 0, ...Array.from({ length: n }, () => undefined));
      this.f.splice(after, 0, ...Array.from({ length: n }, () => undefined));
      this.rows += n;
      return this;
    }
    deleteRows(pos, n) {
      write(this.ss);
      if (this.rows - n <= this.frozen) throw new Error('Sorry, it is not possible to delete all non-frozen rows.');
      this.v.splice(pos - 1, n);
      this.f.splice(pos - 1, n);
      this.rows -= n;
    }
    insertColumnsAfter(after, n) {
      write(this.ss);
      for (const row of [...this.v, ...this.f]) if (row) row.splice(after, 0, ...Array.from({ length: n }, () => ''));
      this.cols += n;
      return this;
    }
    deleteColumns(pos, n) {
      write(this.ss);
      for (const row of [...this.v, ...this.f]) if (row) row.splice(pos - 1, n);
      this.cols -= n;
    }
    setFrozenRows(n) {
      write(this.ss);
      this.frozen = n;
    }
    hideColumns(col, n) {
      write(this.ss);
      for (let c = col; c < col + n; c++) this.hidden.add(c);
    }
    protect() {
      write(this.ss);
      this.protected = true;
      const p = { setDescription: () => p, setWarningOnly: () => p };
      return p;
    }
    /** Test helper: all values as a grid (no formats). */
    dump() {
      const last = this.getLastRow();
      return Array.from({ length: last }, (_, r) => Array.from({ length: this.cols }, (_, c) => this.cell(r, c)));
    }
    /** Test helper: a hand edit, bypassing the lock (like a person typing in the sheet). */
    handEdit(fn) {
      const held = rt.lockHeld;
      rt.lockHeld = true;
      try {
        fn(this);
      } finally {
        rt.lockHeld = held;
        rt.dirty = false;
      }
    }
  }

  class Range {
    constructor(sh, row, col, nr, nc) {
      Object.assign(this, { sh, row, col, nr, nc });
    }
    getRow() {
      return this.row;
    }
    getValues() {
      return Array.from({ length: this.nr }, (_, r) => Array.from({ length: this.nc }, (_, c) => this.sh.cell(this.row - 1 + r, this.col - 1 + c)));
    }
    getValue() {
      return this.sh.cell(this.row - 1, this.col - 1);
    }
    setValues(m) {
      if (!Array.isArray(m) || m.length !== this.nr) throw new Error(`The number of rows in the data does not match the number of rows in the range. The data has ${m?.length} but the range has ${this.nr}.`);
      for (const row of m) if (!Array.isArray(row) || row.length !== this.nc) throw new Error(`The number of columns in the data does not match the number of columns in the range. The data has ${row?.length} but the range has ${this.nc}.`);
      write(this.sh.ss);
      m.forEach((row, r) => row.forEach((v, c) => this.sh.put(this.row - 1 + r, this.col - 1 + c, v)));
      return this;
    }
    setValue(v) {
      return this.setValues([[v]]);
    }
    setNumberFormats(m) {
      if (m.length !== this.nr || m.some((row) => row.length !== this.nc)) throw new Error('The number of rows or columns in the formats does not match the range.');
      write(this.sh.ss);
      m.forEach((row, r) => row.forEach((f, c) => ((this.sh.f[this.row - 1 + r] ??= [])[this.col - 1 + c] = f)));
      return this;
    }
    setNumberFormat(f) {
      return this.setNumberFormats(Array.from({ length: this.nr }, () => Array.from({ length: this.nc }, () => f)));
    }
    setFontWeight() {
      write(this.sh.ss);
      return this;
    }
    clearContent() {
      write(this.sh.ss);
      for (let r = 0; r < this.nr; r++) for (let c = 0; c < this.nc; c++) if (this.sh.v[this.row - 1 + r]) this.sh.v[this.row - 1 + r][this.col - 1 + c] = '';
      return this;
    }
    createTextFinder(text) {
      const range = this;
      const o = { matchCase: false, entire: false };
      const finder = {
        matchCase(b) {
          o.matchCase = b;
          return finder;
        },
        matchEntireCell(b) {
          o.entire = b;
          return finder;
        },
        findNext() {
          for (let r = 0; r < range.nr; r++) {
            for (let c = 0; c < range.nc; c++) {
              const rr = range.row - 1 + r;
              const cc = range.col - 1 + c;
              let shown = display(range.sh.cell(rr, cc), range.sh.fmt(rr, cc));
              let want = String(text);
              if (!o.matchCase) {
                shown = shown.toLowerCase();
                want = want.toLowerCase();
              }
              if (o.entire ? shown === want : shown.includes(want)) return new Range(range.sh, rr + 1, cc + 1, 1, 1);
            }
          }
          return null;
        },
      };
      return finder;
    }
  }

  class Spreadsheet {
    constructor(name, id) {
      this.kind = 'sheet';
      this.id = id ?? 'ss-' + randomUUID();
      this.name = name;
      this.sheets = [new Sheet(this, 'Sheet1')];
      this.parents = ['root'];
      this.trashed = false;
      this.created = now();
    }
    getId() {
      return this.id;
    }
    getName() {
      return this.name;
    }
    getSheets() {
      return [...this.sheets];
    }
    getSheetByName(n) {
      return this.sheets.find((s) => s.name === n) ?? null;
    }
    insertSheet(name, index) {
      write(this);
      if (this.getSheetByName(name)) throw new Error(`A sheet with the name "${name}" already exists. Please enter another name.`);
      const sh = new Sheet(this, name);
      this.sheets.splice(index ?? this.sheets.length, 0, sh);
      return sh;
    }
    deleteSheet(sh) {
      write(this);
      if (this.sheets.length === 1) throw new Error("You can't remove all the sheets in a document.");
      this.sheets = this.sheets.filter((s) => s !== sh);
    }
  }

  function openSheet(id) {
    const ss = rt.files.get(id);
    if (!ss || ss.kind !== 'sheet' || rt.failFiles.has(id)) throw new Error('Unexpected error while getting the method or property openById on object SpreadsheetApp.');
    return ss;
  }

  function copySpreadsheet(src, name) {
    const ss = new Spreadsheet(name);
    ss.sheets = src.sheets.map((s) => {
      const c = new Sheet(ss, s.name);
      Object.assign(c, { rows: s.rows, cols: s.cols, v: structuredClone(s.v), f: structuredClone(s.f), frozen: s.frozen, hidden: new Set(s.hidden), protected: s.protected });
      return c;
    });
    rt.files.set(ss.id, ss);
    return ss;
  }

  // ---------------------------------------------------------------- Drive
  const fileApi = (x) => ({
    getId: () => x.id,
    getName: () => x.name,
    setName: (n) => {
      x.name = n;
    },
    moveTo: (folder) => {
      x.parents = [folder.getId()];
    },
    makeCopy: (name, folder) => {
      const c = copySpreadsheet(x, name);
      if (folder) c.parents = [folder.getId()];
      return fileApi(c);
    },
    getDateCreated: () => new Date(x.created),
    setTrashed: (b) => {
      x.trashed = b;
    },
    isTrashed: () => x.trashed,
  });
  const folderApi = (f) => ({
    getId: () => f.id,
    getName: () => f.name,
    createFolder: (name) => folderApi(newFolder(name, f.id)),
    getFiles: () => {
      const list = [...rt.files.values()].filter((x) => x.kind === 'sheet' && !x.trashed && x.parents.includes(f.id));
      let i = 0;
      return { hasNext: () => i < list.length, next: () => fileApi(list[i++]) };
    },
  });
  function newFolder(name, parent) {
    const f = { kind: 'folder', id: 'folder-' + randomUUID(), name, parents: [parent] };
    rt.files.set(f.id, f);
    return f;
  }

  // ---------------------------------------------------------------- services
  const SpreadsheetApp = {
    create: (name) => {
      const ss = new Spreadsheet(name);
      rt.files.set(ss.id, ss);
      return ss;
    },
    openById: openSheet,
    getActiveSpreadsheet: () => (rt.activeId ? rt.files.get(rt.activeId) : null),
    getActive: () => SpreadsheetApp.getActiveSpreadsheet(),
    flush: () => {
      rt.dirty = false;
    },
    getUi: () => {
      if (!rt.ui) throw new Error('Cannot call SpreadsheetApp.getUi() from this context.');
      return rt.ui;
    },
  };

  const DriveApp = {
    getFileById: (id) => {
      const x = rt.files.get(id);
      if (!x || x.kind !== 'sheet') throw new Error('No item with the given ID could be found.');
      return fileApi(x);
    },
    getFolderById: (id) => {
      const f = rt.files.get(id);
      if (!f || f.kind !== 'folder') throw new Error('No item with the given ID could be found.');
      return folderApi(f);
    },
    createFolder: (name) => folderApi(newFolder(name, 'root')),
  };

  const LockService = {
    getScriptLock: () => ({
      tryLock: () => {
        if (rt.lockBusy) return false;
        rt.lockHeld = true;
        return true;
      },
      waitLock: () => {
        if (rt.lockBusy) throw new Error('Lock timeout: another process was holding the lock for too long.');
        rt.lockHeld = true;
      },
      hasLock: () => rt.lockHeld,
      releaseLock: () => {
        if (rt.dirty) rt.violations.push('the lock was released before SpreadsheetApp.flush()');
        rt.lockHeld = false;
      },
    }),
  };

  const scriptCache = {
    get: (k) => {
      if (rt.evictCache) return null;
      const e = rt.cache.get(k);
      if (!e || e.until <= now()) return null;
      return e.v;
    },
    getAll: (keys) => {
      const out = {};
      for (const k of keys) {
        const v = scriptCache.get(k);
        if (v !== null) out[k] = v;
      }
      return out;
    },
    put: (k, v, s = 600) => {
      if (typeof v !== 'string') throw new Error('Cache values must be strings');
      if (k.length > 250) throw new Error('Cache key too long');
      rt.cache.set(k, { v, until: now() + Math.min(s, 21600) * 1000 });
    },
    putAll: (o, s) => Object.entries(o).forEach(([k, v]) => scriptCache.put(k, v, s)),
    remove: (k) => rt.cache.delete(k),
    removeAll: (keys) => keys.forEach((k) => rt.cache.delete(k)),
  };
  const CacheService = { getScriptCache: () => scriptCache };

  const scriptProps = {
    getProperty: (k) => {
      rt.propReads += 1;
      return rt.props.has(k) ? rt.props.get(k) : null;
    },
    setProperty: (k, v) => {
      rt.props.set(k, String(v));
      return scriptProps;
    },
    setProperties: (o) => {
      for (const [k, v] of Object.entries(o)) rt.props.set(k, String(v));
      return scriptProps;
    },
    getProperties: () => {
      rt.propReads += 1;
      return Object.fromEntries(rt.props);
    },
    deleteProperty: (k) => {
      rt.props.delete(k);
      return scriptProps;
    },
  };
  const PropertiesService = { getScriptProperties: () => scriptProps };

  const Utilities = {
    DigestAlgorithm: { SHA_256: 'sha256' },
    Charset: { UTF_8: 'utf8' },
    computeDigest: (alg, value) => toSigned(createHash(alg).update(toBuf(value)).digest()),
    getUuid: () => randomUUID(),
    computeHmacSha256Signature: (value, key) => toSigned(createHmac('sha256', toBuf(key)).update(toBuf(value)).digest()),
    base64Encode: (d) => toBuf(d).toString('base64'),
    base64EncodeWebSafe: (d) => toBuf(d).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
    base64Decode: (s) => toSigned(Buffer.from(s, 'base64')),
    base64DecodeWebSafe: (s) => toSigned(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')),
    newBlob: (d) => ({ getBytes: () => toSigned(toBuf(d)), getDataAsString: () => toBuf(d).toString('utf8') }),
    sleep: () => undefined,
  };

  const ContentService = {
    MimeType: { JSON: 'JSON', TEXT: 'TEXT' },
    createTextOutput: (s) => {
      const out = { content: s, mime: 'TEXT', setMimeType: (m) => ((out.mime = m), out), getContent: () => s };
      return out;
    },
  };

  const ScriptApp = {
    newTrigger: (fn) => {
      const t = { fn, getHandlerFunction: () => fn };
      const b = {
        timeBased: () => b,
        everyDays: (n) => ((t.everyDays = n), b),
        atHour: (h) => ((t.hour = h), b),
        nearMinute: (m) => ((t.minute = m), b),
        inTimezone: (z) => ((t.tz = z), b),
        after: (ms) => ((t.after = ms), b),
        create: () => (rt.triggers.push(t), t),
      };
      return b;
    },
    getProjectTriggers: () => [...rt.triggers],
    deleteTrigger: (t) => {
      rt.triggers = rt.triggers.filter((x) => x !== t);
    },
  };

  const UrlFetchApp = {
    fetch: (url, opts = {}) => {
      if (!rt.fetch) throw new Error('Address unavailable: ' + url);
      rt.fetches.push({ url, opts });
      const res = rt.fetch(url, opts);
      if (!opts.muteHttpExceptions && res.code >= 400) throw new Error('Request failed for ' + url + ' returned code ' + res.code);
      return { getResponseCode: () => res.code, getContentText: () => res.body };
    },
  };

  class FakeDate extends Date {
    constructor(...a) {
      if (a.length) super(...a);
      else super(now());
    }
    static now() {
      return now();
    }
  }

  const quiet = {
    log: (...a) => rt.logs.push(a.join(' ')),
    warn: (...a) => rt.logs.push(a.join(' ')),
    error: (...a) => rt.logs.push(a.join(' ')),
    info: (...a) => rt.logs.push(a.join(' ')),
  };

  /** Run one script function as its own execution (fresh globals, like Apps Script). */
  function exec(fn, ...args) {
    const ctx = vm.createContext({ SpreadsheetApp, DriveApp, LockService, CacheService, PropertiesService, Utilities, ContentService, ScriptApp, UrlFetchApp, console: quiet, Date: FakeDate });
    CODE.runInContext(ctx);
    try {
      return ctx[fn](...args);
    } finally {
      if (rt.lockHeld) {
        rt.violations.push(`${fn} ended still holding the lock`);
        rt.lockHeld = false;
      }
      rt.dirty = false;
    }
  }

  /** What the app does: POST { fn, args, token } and read the JSON answer. */
  function post(body) {
    const out = exec('doPost', { postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } });
    if (out.mime !== 'JSON') throw new Error('doPost did not answer JSON');
    return JSON.parse(out.content);
  }

  // The Control spreadsheet the script lives in (the Tikka Bites menu).
  const control = SpreadsheetApp.create('Tikka Bites – Control');
  rt.activeId = control.id;

  const api = {
    rt,
    exec,
    post,
    control,
    /** Answers for ui.prompt / ui.alert (menu actions). */
    useUi(answers = []) {
      const alerts = [];
      const queue = [...answers];
      rt.ui = {
        ButtonSet: { OK: 'OK', OK_CANCEL: 'OK_CANCEL', YES_NO: 'YES_NO' },
        Button: { OK: 'OK', CANCEL: 'CANCEL', YES: 'YES', NO: 'NO' },
        createMenu: () => {
          const m = { addItem: () => m, addSeparator: () => m, addSubMenu: () => m, addToUi: () => undefined };
          return m;
        },
        prompt: () => {
          const a = queue.shift();
          return { getSelectedButton: () => (a === null ? 'CANCEL' : 'OK'), getResponseText: () => a ?? '' };
        },
        alert: (title, msg) => {
          alerts.push(msg === undefined ? title : `${title}: ${msg ?? ''}`);
          return queue.length ? queue.shift() : 'OK';
        },
      };
      return alerts;
    },
    sheet: (id) => openSheet(id),
    mainId: () => rt.props.get('MAIN_ID'),
    backupId: () => rt.props.get('BACKUP_ID'),
    main: () => rt.files.get(rt.props.get('MAIN_ID')),
    backup: () => rt.files.get(rt.props.get('BACKUP_ID')),
    /** Rows (without the header) of a tab, as stored. */
    rows(ss, tab) {
      const sh = ss.getSheetByName(tab);
      return sh ? sh.dump().slice(1) : [];
    },
    /** The records in a tab, parsed from the Data columns (what the app trusts). */
    records(ss, tab) {
      const sh = ss.getSheetByName(tab);
      if (!sh) return [];
      const head = sh.dump()[0] ?? [];
      const first = head.indexOf('Data');
      return sh
        .dump()
        .slice(1)
        .filter((r) => r[first] !== '')
        .map((r) => {
          let json = '';
          for (let c = first; c < head.length && String(head[c]).startsWith('Data') && r[c] !== ''; c++) json += String(r[c]).slice(2);
          return JSON.parse(json);
        });
    },
    /** Every tab of a file as { name: rows-including-header } (to compare Main and Backup). */
    snapshot(ss) {
      return Object.fromEntries(ss.getSheets().map((s) => [s.name, s.dump()]));
    },
  };
  return api;
}
