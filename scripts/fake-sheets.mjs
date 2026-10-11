// A stand-in for the Google Apps Script web app, for end-to-end tests on this PC: the
// real app talks to it exactly like to Google (POST with a text body, no pre-check,
// CORS "*"), and every request runs the real google-sheets/Code.gs on sheets that
// behave like Google Sheets (tests/helpers/fakeAppsScript.mjs).
// Google answers through a redirect to script.googleusercontent.com (https → https, allowed
// by the CSP). Here the answer comes straight back: the page's upgrade-insecure-requests
// would turn a redirect to this http://localhost server into https, which it doesn't serve.
//
// Usage: node scripts/fake-sheets.mjs [port=54330]
// Test-only routes (never part of the real thing): /__test/reset, /__test/state, /__test/old-bill
import { createServer } from 'node:http';
import { createRuntime } from '../tests/helpers/fakeAppsScript.mjs';

const PORT = Number(process.argv[2] ?? 54330);
export const EXEC_PATH = '/macros/s/fake-e2e-deployment/exec';
const CORS = { 'Access-Control-Allow-Origin': '*' };

let g;
/** An empty, set-up sheet with the owner (super admin) and counter1 (staff). */
function reset() {
  g = createRuntime();
  g.exec('setup');
  g.exec('setOwnerLogin', 'owner', 'owner-pass-123');
  const owner = g.post({ fn: 'sign_in', args: { username: 'owner', password: 'owner-pass-123' } }).data.accessToken;
  const added = g.post({ fn: 'staff_admin', token: owner, args: { action: 'add', username: 'counter1', password: 'counter-pass-123' } });
  if (!added.ok) throw new Error(added.error.message);
}

/** What the sheets hold, for the tests to check (bills of every month tab, menu, users). */
function state() {
  const bills = (ss) =>
    ss
      .getSheets()
      .filter((s) => /^Bills \d{4}-\d{2}$/.test(s.name))
      .flatMap((s) => g.records(ss, s.name).map((r) => ({ ...r.bill, savedBy: r.by })));
  return {
    main: { bills: bills(g.main()), menu: g.records(g.main(), 'Menu'), users: g.records(g.main(), 'Users').map((u) => ({ username: u.username, role: u.role, removed: u.removed })) },
    backup: { bills: bills(g.backup()), menu: g.records(g.backup(), 'Menu') },
    violations: g.rt.violations,
    formulaWrites: g.rt.formulaWrites,
  };
}

/** Put a bill from an old month straight into Main (as if it had been there for months). */
function oldBill(month) {
  const billNo = `RCPT-${month}-0001`;
  const bill = {
    billNo, createdAt: 1, monthKey: month, hour: 12, weekday: 1, items: [], orderType: 'takeaway', paymentMode: 'cash', discount: { kind: 'flat', paise: 0 },
    subtotalPaise: 0, discountPaise: 0, roundOffPaise: 0, totalPaise: 0, itemCount: 0, categories: [], hasVeg: false, hasNonVeg: false, cheesyLine: '', status: 'paid',
  };
  g.exec('withLock', (db) => db.addBills(month, [{ rec: { bill, by: 'owner', ref: '' }, rev: db.reserve(1) }]));
  return billNo;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS, ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

reset();

createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    try {
      if (url.pathname === EXEC_PATH && req.method === 'POST') return send(res, 200, g.post(raw));
      if (url.pathname === EXEC_PATH && req.method === 'GET') return send(res, 200, JSON.parse(g.exec('doGet').content));
      if (req.method === 'OPTIONS') return send(res, 405, { message: 'Apps Script does not answer CORS pre-checks' });
      if (url.pathname === '/__test/reset' && req.method === 'POST') {
        reset();
        return send(res, 200, { ok: true });
      }
      if (url.pathname === '/__test/state') return send(res, 200, state());
      if (url.pathname === '/__test/old-bill' && req.method === 'POST') return send(res, 200, { billNo: oldBill(JSON.parse(raw).month) });
      if (url.pathname === '/__test/nightly' && req.method === 'POST') return send(res, 200, g.exec('nightly'));
      send(res, 404, { message: 'not found' });
    } catch (e) {
      send(res, 500, { message: String(e?.stack ?? e) });
    }
  });
}).listen(PORT, () => console.log(`fake Google Apps Script on http://localhost:${PORT}${EXEC_PATH}`));
