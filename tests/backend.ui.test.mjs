/* ============================================================
   BACKEND FEATURES — the screens that drive them.
   Audit log, student import, signed-in devices, CSV export.
   Runs against public/app.js with a mocked API (no server needed).
   ============================================================ */

import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = (() => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [process.env.VOLYX_ROOT, path.resolve(here, '..'), path.resolve(here, '..', 'gradescript-portal')]) {
    if (candidate && fs.existsSync(path.join(candidate, 'server.js'))) return candidate;
  }
  return path.resolve(here, '..');
})();
const html = fs.readFileSync(`${ROOT}/public/index.html`, 'utf8');
const appSource = fs.readFileSync(`${ROOT}/public/app.js`, 'utf8');

let fails = 0;
const check = (l, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${extra ? ' — ' + extra : ''}`); };
const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));

const CONFIG = {
  platform: { name: 'Volyx', tagline: 't', description: 'd' },
  school: { name: 'School', shortName: 'SCH', motto: 'm', address: 'a', phone: 'p', email: 'e', logoText: 'S' },
  scale: [{ min: 80, max: 100, grade: 'A', points: 1 }], divisions: [],
  reporting: {
    terms: [{ id: '2026-T3', name: 'Term III', year: 2026, ends: '2026-12-04' }],
    classes: [{ id: 's2-blue', name: 'S.2 Blue', level: 'S.2' }],
    subjects: ['Mathematics'], currentTerm: '2026-T3',
  },
  demo: true, googleClientId: '', mailMode: 'dev', devCodes: true, key: { status: 'missing' }, pollSeconds: 6,
};

const ADMIN = { id: 'u_a', email: 'ryanroject@gmail.com', name: 'Platform Admin', role: 'admin', emailVerified: true, canManageKey: true, canTeach: true, home: '#/teacher', linkedStudent: null, studentCount: 0 };
const TEACHER = { ...ADMIN, id: 'u_t', email: 't@example.com', name: 'Teacher One', role: 'teacher', canManageKey: false };
const STUDENT = { id: 'u_s', email: 'amina@gmail.com', name: 'Amina Nakato', role: 'student', emailVerified: true, canManageKey: false, canTeach: false, home: '#/portal', linkedStudent: null, studentCount: 0 };

const AUDIT = {
  ok: true, total: 3, limit: 50, offset: 0,
  actions: [{ action: 'auth.login', n: 2 }, { action: 'student.import', n: 1 }],
  storage: { engine: 'sqlite', bytes: 40960, counts: { users: 4, students: 3, gradings: 9, sessions: 2, audit_log: 3 } },
  entries: [
    { id: 3, at: new Date().toISOString(), action: 'auth.login', actorEmail: 't@example.com', role: 'teacher', target: 't@example.com', ip: '127.0.0.1', detail: null },
    { id: 2, at: new Date(Date.now() - 60000).toISOString(), action: 'student.import', actorEmail: 't@example.com', role: 'teacher', target: null, ip: '127.0.0.1', detail: { created: 2, skipped: 1 } },
    { id: 1, at: new Date(Date.now() - 120000).toISOString(), action: 'auth.login.failed', actorEmail: null, role: null, target: 'nobody@example.com', ip: '127.0.0.1', detail: null },
  ],
};

const STUDENTS = [
  { id: 'st_1', name: 'Amina Nakato', email: 'amina@example.com', studentNumber: 'S2/1', className: 'S.2 Blue', classId: 's2-blue', subjects: 1, assessments: 2, loginEmail: 'amina.nakato@students.volyx.ug' },
];

const SESSIONS = {
  ok: true,
  current: 'sid_current',
  sessions: [
    { id: 'sid_current', device: 'Chrome on macOS', ip: '10.0.0.2', createdAt: new Date().toISOString(), lastSeen: new Date().toISOString(), expires: new Date(Date.now() + 3.6e6).toISOString(), current: true, live: true },
    { id: 'sid_other', device: 'Safari on iOS', ip: '10.0.0.9', createdAt: new Date(Date.now() - 7200000).toISOString(), lastSeen: new Date(Date.now() - 3600000).toISOString(), expires: new Date(Date.now() + 3.6e6).toISOString(), current: false, live: true },
  ],
};

function makeApp(user, calls = []) {
  const dom = new JSDOM(html, { url: 'http://localhost:3000/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.HTMLElement.prototype.scrollTo = () => {};
  window.fetch = async (url, opts = {}) => {
    const p = String(url);
    const method = opts.method || 'GET';
    let body = null;
    if (opts.body && typeof opts.body === 'string') { try { body = JSON.parse(opts.body); } catch { body = opts.body; } }
    calls.push({ path: p, method, body });
    const reply = (o, s = 200) => ({ ok: s < 400, status: s, json: async () => o });

    if (p.endsWith('/api/config')) return reply(CONFIG);
    if (p.endsWith('/api/me')) return reply({ user, demo: true });
    if (p.includes('/api/admin/audit')) return reply(AUDIT);
    if (p.endsWith('/api/admin/overview')) return reply({
      ok: true, admin: { email: ADMIN.email, name: ADMIN.name },
      key: { status: 'missing', hint: '', connected: false, source: 'none', setBy: null, setAt: null, message: '' },
      counts: { teachers: 1, students: 1, accounts: 2, studentsTracked: 1, gradings: 3, completed: 2, pending: 1, emailsAddressed: 1 },
      demo: true, storage: AUDIT.storage, recent: AUDIT.entries,
    });
    if (p.endsWith('/api/auth/sessions')) return reply(SESSIONS);
    if (p.endsWith('/api/auth/sessions/revoke')) return reply({ ok: true, revoked: 1, signedOut: false });
    if (p.endsWith('/api/students/import')) {
      if (body?.dryRun) return reply({ ok: true, dryRun: true, willCreate: 1, willSkip: 1, preview: [{ line: 2, name: 'Zoe Check', email: 'zoe@students.volyx.ug', className: 'S.2 Blue' }], skipped: [{ line: 3, reason: 'Invalid email', value: 'bad-email' }] });
      return reply({ ok: true, created: 1, skipped: 1, students: [], problems: [{ line: 3, reason: 'Invalid email', value: 'bad-email' }], message: '1 student added, 1 skipped.' });
    }
    if (p.endsWith('/api/students')) return reply({ students: STUDENTS, classes: CONFIG.reporting.classes });
    if (p.endsWith('/api/teacher/overview')) return reply({
      demo: true, user, key: { status: 'missing', hint: '', message: '' },
      counts: { students: 1, gradings: 1, pending: 0, processing: 0, completed: 1, partial: 0, failed: 0 },
      terms: CONFIG.reporting.terms, classes: CONFIG.reporting.classes,
      recent: [], students_preview: STUDENTS,
    });
    if (p.includes('/api/teacher/reports')) return reply({ published: false, students: [{ id: 'st_1', name: 'Amina Nakato', email: 'amina@example.com', studentNumber: 'S2/1', subjects: 1, average: 78, flagged: 0 }] });
    if (p.endsWith('/api/diagnostics')) return reply({ demo: true, uptime: 10, entries: [] });
    if (p.endsWith('/api/student/me')) return reply({ readOnly: true, role: 'student', student: { id: 'u_s', name: 'Amina Nakato', email: 'amina@gmail.com', className: 'S.2 Blue', studentNumber: 'S2/1' }, teachers: [], mustChangePassword: false });
    return reply({ ok: true });
  };
  return { dom, window };
}

async function boot(user, calls = []) {
  const { window } = makeApp(user, calls);
  window.eval(appSource);
  await tick(300);
  return window;
}

const go = async (window, hash) => {
  window.location.hash = hash;
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await tick(400);
};

/* ---------- admin: audit log ---------- */
{
  const calls = [];
  const w = await boot(ADMIN, calls);
  const nav = w.document.querySelector('.nav a[href="#/admin/audit"]');
  check('the rail shows an Audit log entry for admins', Boolean(nav) && /Audit log/.test(nav.textContent));

  await go(w, '#/admin/audit');
  const d = w.document;
  check('the audit screen opens', d.querySelector('.page-head h1')?.textContent === 'Audit log');
  check('entries are listed', d.querySelectorAll('#audit-table tbody tr').length === 3, String(d.querySelectorAll('#audit-table tbody tr').length));
  check('actions are translated into plain words', /Signed in/.test(d.getElementById('audit-table').textContent));
  check('failed sign-ins are named', /Failed sign-in/.test(d.getElementById('audit-table').textContent));
  check('the storage size is shown', /KB/.test(d.body.textContent));
  check('the action filter lists what happened', d.querySelectorAll('#audit-action option').length === 3);
  check('the filter is wired to the address bar', (() => {
    const sel = d.getElementById('audit-action');
    sel.value = 'auth.login';
    sel.dispatchEvent(new w.Event('change'));
    return w.location.hash.includes('action=auth.login');
  })());

  const requested = calls.find((c) => c.path.includes('/api/admin/audit'));
  check('the screen asks for the audit endpoint', Boolean(requested), requested?.path);
}

/* ---------- a teacher cannot reach it ---------- */
{
  const w = await boot(TEACHER, []);
  check('the rail hides Audit log from teachers', !w.document.querySelector('.nav a[href="#/admin/audit"]'));
  await go(w, '#/admin/audit');
  await tick(200);
  check('a teacher is bounced off the audit route', !w.location.hash.startsWith('#/admin/audit'), w.location.hash);
}

/* ---------- teacher: import students ---------- */
{
  const calls = [];
  const w = await boot(TEACHER, calls);
  await go(w, '#/teacher/students');
  const d = w.document;
  const btn = d.getElementById('import-students');
  check('the students screen offers an import', Boolean(btn));

  btn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick(150);
  const ta = d.getElementById('import-csv');
  check('the import dialog opens with a place to paste', Boolean(ta));
  check('the dialog has check + import actions', d.querySelectorAll('.modal-foot button').length === 2);

  ta.value = 'name,email,class\nZoe Check,zoe@students.volyx.ug,S.2 Blue\nbad,bad-email,';
  d.querySelector('[data-act="check"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick(250);
  const report = d.getElementById('import-report').textContent.replace(/\s+/g, ' ');
  check('checking the list previews what will happen', /1 student ready to add/.test(report), report.slice(0, 80));
  check('the preview names the student', /Zoe Check/.test(report));
  check('checking sends a dry run', calls.some((c) => c.path.includes('/students/import') && c.body?.dryRun === true));

  d.querySelector('[data-act="import"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick(300);
  check('importing sends a real request', calls.some((c) => c.path.includes('/students/import') && c.body && !c.body.dryRun));
  check('the dialog closes after importing', !d.getElementById('import-csv'));
}

/* ---------- signed-in devices ---------- */
{
  const calls = [];
  const w = await boot(TEACHER, calls);
  await go(w, '#/teacher/settings');
  await tick(300);
  const d = w.document;
  check('settings lists where you are signed in', d.querySelectorAll('#sessions-card .session-row').length === 2);
  check('this device is labelled', /this device/.test(d.getElementById('sessions-card').textContent));
  check('other devices get their own sign-out', d.querySelectorAll('#sessions-card [data-revoke]').length === 1);
  check('devices show when they were last active', /active .* ago|active just now/.test(d.getElementById('sessions-card').textContent));

  d.getElementById('signout-others').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick(200);
  const confirmBtn = d.querySelector('.modal-foot [data-act="ok"]');
  check('signing out everywhere asks first', Boolean(confirmBtn));
  if (confirmBtn) {
    confirmBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await tick(300);
    check(
      'confirming posts "others" to the revoke endpoint',
      calls.some((c) => c.path.includes('/auth/sessions/revoke') && c.body?.scope === 'others')
    );
  }
}

/* ---------- student portal account ---------- */
{
  const w = await boot(STUDENT, []);
  await go(w, '#/portal/account');
  await tick(300);
  check('a student also manages their own devices', Boolean(w.document.getElementById('sessions-card')));
  check('the student device list rendered', w.document.querySelectorAll('#sessions-card .session-row').length === 2);
}

/* ---------- export button ---------- */
{
  const w = await boot(TEACHER, []);
  await go(w, '#/teacher/results');
  await tick(400);
  const link = w.document.querySelector('a[href^="/api/teacher/export.csv"]');
  check('results offer a CSV export', Boolean(link), link?.getAttribute('href'));
  check('the export carries the chosen term', /term=/.test(link?.getAttribute('href') || ''));
}

console.log("");
console.log(fails === 0 ? "ALL BACKEND UI CHECKS PASSED" : `${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
