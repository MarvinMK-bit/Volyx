/* ============================================================
   BACKEND FEATURES — SQLite storage, audit trail, CSV import/export,
   signed-in devices, response headers.
   Run against a throwaway copy:  BASE=http://127.0.0.1:3200 node backend.api.test.mjs
   ============================================================ */

const BASE = process.env.BASE || 'http://localhost:3100';
let fails = 0;
const check = (l, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${extra ? ' — ' + extra : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function j(path, { method = 'GET', body, token, form, headers: extraHeaders } = {}) {
  const headers = { ...(extraHeaders || {}) };
  if (token) headers['X-Session'] = token;
  if (body && !form) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: form || (body ? JSON.stringify(body) : undefined) });
  const text = await res.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed, headers: res.headers };
}

/** Split CSV text into rows of cells, respecting quotes. */
function parseCsv(text) {
  const rows = []; let rowsOut = []; let cell = ''; let q = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (q) {
      if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i += 1; } else q = false; } else cell += ch;
      continue;
    }
    if (ch === '"') { q = true; continue; }
    if (ch === ',') { rowsOut.push(cell); cell = ''; continue; }
    if (ch === '\n') { rowsOut.push(cell); rows.push(rowsOut); rowsOut = []; cell = ''; continue; }
    if (ch === '\r') continue;
    cell += ch;
  }
  if (cell || rowsOut.length) { rowsOut.push(cell); rows.push(rowsOut); }
  return rows.filter((r) => r.length > 1);
}

const RUN = Date.now();
const signup = (email, name, type) => j('/api/auth/signup', { method: 'POST', body: { name, email, password: 'passw0rd1', accountType: type } });
const verify = (r) => j('/api/auth/verify-email', { method: 'POST', body: { email: r.body.email, code: r.body.delivery.devCode } });

async function upload(token, { email, studentId, name, subject, termId = '2026-T3' }) {
  const fd = new FormData();
  if (email) fd.append('studentEmail', email);
  if (studentId) fd.append('studentId', studentId);
  if (name) fd.append('studentName', name);
  fd.append('subject', subject);
  fd.append('assessmentType', 'End of term exam');
  fd.append('termId', termId);
  fd.append('attachments[0][file]', new Blob([Buffer.from('%PDF-1.4 test')], { type: 'application/pdf' }), 'script.pdf');
  fd.append('attachments[0][type]', 'SCRIPT');
  return j('/api/teacher/gradings', { method: 'POST', token, form: fd });
}

/* ---------- 1. storage engine ---------- */
{
  const h = await j('/api/health');
  check('health says the database is SQLite', h.body.storage?.engine === 'sqlite', h.body.storage?.engine);
  check('health reports WAL journaling', h.body.storage?.journal === 'wal', h.body.storage?.journal);
  check('health runs an integrity check', h.body.integrity === 'ok', String(h.body.integrity));
  check('health still reports demo mode and uptime', h.body.demo === true && typeof h.body.uptime === 'number');
}

/* ---------- 2. response headers ---------- */
{
  const page = await j('/');
  const csp = page.headers.get('content-security-policy') || '';
  check('HTML carries a Content-Security-Policy', csp.includes("default-src 'self'"), csp.slice(0, 40));
  check('the policy allows inline styles (theme variables)', csp.includes("style-src 'self' 'unsafe-inline'"));
  check('the policy allows Google Identity Services', csp.includes('accounts.google.com'));
  check('the page is not blocked from being previewed', !page.headers.get('x-frame-options'));
  check('HTML is served nosniff', page.headers.get('x-content-type-options') === 'nosniff');
  const apiRes = await j('/api/health');
  check('JSON responses are nosniff too', apiRes.headers.get('x-content-type-options') === 'nosniff');
  check('API responses are never cached', apiRes.headers.get('cache-control') === 'no-store');
}

/* ---------- 3. accounts + signed-in devices ---------- */
const A = await verify(await signup(`feat.a.${RUN}@example.com`, 'Feature Teacher', 'teacher'));
const AT = A.body.token;
check('a verified teacher signs in', A.status === 200 && Boolean(AT));

{
  const s1 = await j('/api/auth/sessions', { token: AT });
  check('sessions list is available', s1.status === 200 && Array.isArray(s1.body.sessions));
  check('the current session is marked', s1.body.sessions.some((x) => x.current === true));
  check('sessions record where they came from', s1.body.sessions[0].ip !== undefined && s1.body.sessions[0].device);
}

/* a second session on the same account */
const second = await j('/api/auth/login', { method: 'POST', body: { email: `feat.a.${RUN}@example.com`, password: 'passw0rd1' } });
const AT2 = second.body.token;
{
  const both = await j('/api/auth/sessions', { token: AT });
  check('two sessions are listed', both.body.sessions.length >= 2, String(both.body.sessions.length));
  const revoked = await j('/api/auth/sessions/revoke', { method: 'POST', token: AT, body: { scope: 'others' } });
  check('"sign out everywhere else" runs', revoked.status === 200 && revoked.body.revoked >= 1);
  check('the other session stops working', (await j('/api/me', { token: AT2 })).body.user === null);
  check('this session still works', (await j('/api/me', { token: AT })).body.user?.email === `feat.a.${RUN}@example.com`);
  check('no expired session is ever listed', (await j('/api/auth/sessions', { token: AT })).body.sessions.every((x) => new Date(x.expires) > new Date()));
}

/* ---------- 4. bulk import ---------- */
{
  const csv = [
    'name,email,class,number',
    `Amina Feature,amina.${RUN}@students.volyx.ug,S.2 Blue,S2/90`,
    `Brian Feature,brian.${RUN}@students.volyx.ug,S.2 Blue,`,
    `Broken Row,not-an-email,`,
    `Amina Feature,amina.${RUN}@students.volyx.ug,`,
    `,missing.name@students.volyx.ug,`,
  ].join('\n');

  const dry = await j('/api/students/import', { method: 'POST', token: AT, body: { csv, dryRun: true } });
  check('a dry run validates without writing', dry.status === 200 && dry.body.dryRun === true && dry.body.willCreate === 2);
  check('a dry run reports the bad rows', dry.body.willSkip === 3, String(dry.body.willSkip));
  check('a dry run creates nothing', (await j('/api/students', { token: AT })).body.students.length === 0);

  const run = await j('/api/students/import', { method: 'POST', token: AT, body: { csv } });
  check('the import adds the valid students', run.status === 200 && run.body.created === 2, String(run.body.created));
  check('the import explains every skipped row', run.body.skipped === 3 && run.body.problems.length === 3);
  check('skipped rows keep their line numbers', run.body.problems.every((p) => Number.isInteger(p.line)));

  const list = await j('/api/students', { token: AT });
  check('imported students are in the list', list.body.students.length === 2);
  const imported = list.body.students.find((s) => s.email === `amina.${RUN}@students.volyx.ug`);
  check('an imported student has a login', Boolean(imported?.loginEmail), imported?.loginEmail);
  check('an imported student has the class from the CSV', imported?.className === 'S.2 Blue', imported?.className);

  const again = await j('/api/students/import', { method: 'POST', token: AT, body: { csv } });
  check('importing the same list twice adds nothing', again.body.created === 0 && again.body.skipped >= 2);

  const headerless = await j('/api/students/import', { method: 'POST', token: AT, body: {
    csv: `Chloe Headerless,chloe.${RUN}@students.volyx.ug,S.2 Blue`,
  } });
  check('a list with no header row still imports', headerless.body.created === 1, String(headerless.body.created));

  const bad = await j('/api/students/import', { method: 'POST', token: AT, body: { csv: 'just one column\nanother' } });
  check('a list with no email column is refused', bad.status === 400 && bad.body.code === 'missing-columns');

  const empty = await j('/api/students/import', { method: 'POST', token: AT, body: { csv: '' } });
  check('an empty import is refused politely', empty.status === 400);
}

/* ---------- 5. audit trail ---------- */
{
  const ov = await j('/api/admin/overview', { token: AT });
  check('a teacher still cannot open the audit log', ov.status === 403);
  const denied = await j('/api/admin/audit', { token: AT });
  check('the audit endpoint is admin-only', denied.status === 403, String(denied.status));
}

const ADMIN_LOGIN = await j('/api/auth/login', { method: 'POST', body: { email: 'ryanroject@gmail.com', password: 'volyx-admin-2026' } });
const ADT = ADMIN_LOGIN.body.token;
check('the platform admin signs in', ADMIN_LOGIN.status === 200 && Boolean(ADT));

{
  const log = await j('/api/admin/audit?limit=200', { token: ADT });
  check('the admin can read the audit log', log.status === 200 && Array.isArray(log.body.entries));
  check('the log has entries', log.body.total > 0, String(log.body.total));

  const actions = new Set(log.body.entries.map((e) => e.action));
  check('sign-ins are recorded', actions.has('auth.login'), [...actions].slice(0, 6).join(','));
  check('new accounts are recorded', actions.has('account.signup'));
  check('student imports are recorded', actions.has('student.import'));
  check('session revocations are recorded', actions.has('session.revoke'));

  const entry = log.body.entries.find((e) => e.action === 'student.import');
  check('audit entries name the actor', Boolean(entry?.actorEmail), entry?.actorEmail);
  check('audit entries record the address', Boolean(entry?.ip), entry?.ip);
  check(
    'audit entries carry detail',
    log.body.entries.some((e) => e.action === 'student.import' && e.detail && e.detail.created === 2)
  );

  const filtered = await j('/api/admin/audit?action=student.import&limit=5', { token: ADT });
  check('the log filters by action', filtered.body.entries.every((e) => e.action === 'student.import'));
  check('the filter keeps the real total', filtered.body.total >= 1);
  check('the log offers a list of actions', Array.isArray(filtered.body.actions) && filtered.body.actions.length > 0);

  const paged = await j('/api/admin/audit?limit=1&offset=0', { token: ADT });
  check('the log paginates', paged.body.entries.length === 1 && paged.body.total > 1);
  const page2 = await j('/api/admin/audit?limit=1&offset=1', { token: ADT });
  check('page two is a different entry', page2.body.entries[0].id !== paged.body.entries[0].id);

  const failedLogin = await j('/api/auth/login', { method: 'POST', body: { email: `feat.a.${RUN}@example.com`, password: 'wrong-password' } });
  check('a bad password is rejected', failedLogin.status === 401);
  const afterFail = await j('/api/admin/audit?action=auth.login.failed', { token: ADT });
  check('failed sign-ins are recorded', afterFail.body.total >= 1, String(afterFail.body.total));
  check('a failed sign-in never records the password', !JSON.stringify(afterFail.body).includes('wrong-password'));

  check('the admin overview now shows storage', (await j('/api/admin/overview', { token: ADT })).body.storage?.engine === 'sqlite');
}

/* ---------- 6. CSV export ---------- */
{
  const students = await j('/api/students', { token: AT });
  const pupil = students.body.students[0];
  const queued = await upload(AT, { studentId: pupil.id, subject: 'Mathematics' });
  check('a script can still be queued', queued.status === 202, String(queued.status));
  check('queuing a script is recorded', (await j('/api/admin/audit?action=grading.create', { token: ADT })).body.total >= 1);

  const res = await fetch(`${BASE}/api/teacher/export.csv?term=all`, { headers: { 'X-Session': AT } });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder('utf-8').decode(bytes);
  check('the export downloads as CSV', res.status === 200 && (res.headers.get('content-type') || '').includes('text/csv'));
  check('the download gets a filename', /filename="volyx-results-/.test(res.headers.get('content-disposition') || ''));
  check('the CSV is Excel-friendly (BOM byte order mark)', bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf);
  const lines = text.replace(/^\uFEFF/, '').trim().split('\r\n');
  check('the CSV has a header row', lines[0].startsWith('Student,Student number,Class,Subject'));
  check('the CSV has one row per script', lines.length === 2, String(lines.length));

  // wait for the demo grader to finish, then the same row should carry marks
  let finished = false;
  for (let i = 0; i < 12 && !finished; i += 1) {
    await sleep(2500);
    const list = await j('/api/teacher/gradings', { token: AT });
    const g = (list.body.gradings || []).find((x) => x.id === queued.body.grading.id);
    finished = Boolean(g && ['COMPLETED', 'COMPLETE', 'FINISHED', 'GRADED', 'FAILED'].includes(String(g.status).toUpperCase()));
  }
  check('the demo grader finishes (or reports)', finished);
  const res2 = await fetch(`${BASE}/api/teacher/export.csv?term=all`, { headers: { 'X-Session': AT } });
  const table = parseCsv(await res2.text());
  const head = table[0];
  const col = (n) => head.indexOf(n);
  const row = table.slice(1).find((r) => r[col('Grading ID')] === queued.body.grading.id) || table[1] || [];
  check('a marked script exports a score', row[col('Score')] !== '', row.join('|').slice(0, 90));
  check('a marked script exports a grade', (row[col('Grade')] || '').length === 1, row[col('Grade')]);
  check('a marked script exports its percent', /^[0-9.]+$/.test(row[col('Percent')] || ''), row[col('Percent')]);

  const other = await fetch(`${BASE}/api/teacher/export.csv?term=2019-T1`, { headers: { 'X-Session': AT } });
  const otherText = (await other.text()).replace(/^\uFEFF/, '').trim();
  check('filtering by a quiet term exports just the header', otherText.split('\r\n').length === 1);

  const unauth = await fetch(`${BASE}/api/teacher/export.csv`);
  check('the export needs a session', unauth.status === 401 || unauth.status === 403, String(unauth.status));

  const exported = await j('/api/admin/audit?action=results.export', { token: ADT });
  check('exports are recorded in the audit log', exported.body.total >= 1);
}

/* ---------- 7. isolation is unchanged ---------- */
const B = await verify(await signup(`feat.b.${RUN}@example.com`, 'Other Teacher', 'teacher'));
const BT = B.body.token;
{
  check("another account still cannot read A's students", (await j('/api/students', { token: BT })).body.students.length === 0);
  const bImport = await j('/api/students/import', { method: 'POST', token: BT, body: { csv: `Solo Pupil,solo.${RUN}@students.volyx.ug` } });
  check('imports stay inside the importing account', bImport.body.created === 1);
  check("A's list is unchanged by B's import", (await j('/api/students', { token: AT })).body.students.length === 3);
}

console.log('');
console.log(fails === 0 ? 'ALL BACKEND FEATURE CHECKS PASSED' : `${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
