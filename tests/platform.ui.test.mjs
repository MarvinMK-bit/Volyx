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
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

const CONFIG = {
  platform: { name: 'Volyx', tagline: 't', description: 'd' },
  school: { name: 'School', shortName: 'SCH', motto: 'm', address: 'a', phone: 'p', email: 'e', logoText: 'S' },
  scale: [{ min: 80, max: 100, grade: 'A', points: 1 }], divisions: [],
  reporting: { terms: [{ id: '2026-T3', name: 'Term III', year: 2026, ends: '2026-12-04' }, { id: '2026-T2', name: 'Term II', year: 2026, ends: '2026-08-01' }],
    classes: [{ id: 's2-blue', name: 'S.2 Blue', level: 'S.2' }], subjects: ['Mathematics'], currentTerm: '2026-T3' },
  demo: true, googleClientId: '', mailMode: 'dev', devCodes: true, key: { status: 'missing' }, pollSeconds: 6,
};

const TEACHER = { id: 'u_t', email: 't@example.com', name: 'Teacher One', role: 'teacher', emailVerified: true, canManageKey: false, canTeach: true, home: '#/teacher', linkedStudent: null, studentCount: 1 };
const ADMIN = { ...TEACHER, id: 'u_a', email: 'ryanroject@gmail.com', name: 'Platform Admin', role: 'admin', canManageKey: true };
const STUDENT = { id: 'u_s', email: 'amina@gmail.com', name: 'Amina Nakato', role: 'student', emailVerified: true, canManageKey: false, canTeach: false, home: '#/portal', linkedStudent: null, studentCount: 0 };

function makeApp(user, calls = []) {
  const dom = new JSDOM(html, { url: 'http://localhost:3000/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.fetch = async (url, opts = {}) => {
    const path = String(url);
    const method = opts.method || 'GET';
    let body = null;
    if (opts.body && typeof opts.body === 'string') { try { body = JSON.parse(opts.body); } catch { body = opts.body; } }
    calls.push({ path, method, body });
    const reply = (o, s = 200) => ({ ok: s < 400, status: s, json: async () => o });

    if (path.endsWith('/api/config')) return reply(CONFIG);
    if (path.endsWith('/api/me')) return reply({ user, demo: true });
    if (path.endsWith('/api/auth/signup')) return reply({ ok: true, email: body?.email, needsVerification: true, delivery: { devCode: '123456' }, message: 'sent' });
    if (path.endsWith('/api/admin/overview')) return reply({
      ok: true, admin: { email: ADMIN.email, name: ADMIN.name },
      key: { status: 'missing', hint: '', connected: false, source: 'none', setBy: null, setAt: null, message: '' },
      counts: { teachers: 4, students: 7, accounts: 12, studentsTracked: 3, gradings: 19, completed: 17, pending: 2, emailsAddressed: 6 },
      demo: true,
    });
    if (path.endsWith('/api/teacher/overview')) return reply({
      demo: true, user, key: { status: 'missing', hint: '', message: '' },
      counts: { students: 1, gradings: 0, pending: 0, processing: 0, completed: 0, partial: 0, failed: 0 },
      terms: CONFIG.reporting.terms, classes: CONFIG.reporting.classes,
      students: [{ id: 'st1', name: 'Amina Nakato', email: 'amina@gmail.com', studentNumber: 'S2/1', classId: 's2-blue', className: 'S.2 Blue', level: 'S.2', hasLogin: true }],
      recent: [],
    });
    if (path.endsWith('/api/student/me')) return reply({
      readOnly: true, role: 'student',
      student: { id: 'u_s', name: 'Amina Nakato', email: 'amina@gmail.com', className: '', studentNumber: '', emails: ['amina@gmail.com'] },
      teachers: [{ id: 'u_t', name: 'Teacher One' }, { id: 'u_t2', name: 'Teacher Two' }],
      termCount: 1, assessmentCount: 2, mustChangePassword: false,
      permissions: { viewOwnResults: true, editAnything: false, viewOtherStudents: false, systemSettings: false },
    });
    if (path.endsWith('/api/student/terms')) return reply({
      readOnly: true,
      terms: [{ id: '2026-T3', name: 'Term III', year: 2026, ends: '2026-12-04', subjects: 2, average: 61, assessments: 2, teachers: 2 }],
    });
    if (path.endsWith('/api/student/results')) return reply({
      readOnly: true, teachers: [{ id: 'u_t', name: 'Teacher One' }, { id: 'u_t2', name: 'Teacher Two' }],
      results: [
        { id: 'g1', subject: 'Mathematics', assessmentType: 'End of term exam', termId: '2026-T3', termName: 'Term III 2026', totalMark: 12.5, maximumMark: 16, percent: 78.1, grade: 'B', teacher: 'Teacher One', gradedAt: '2026-11-01T09:00:00Z' },
        { id: 'g2', subject: 'Biology', assessmentType: 'End of term exam', termId: '2026-T3', termName: 'Term III 2026', totalMark: 8, maximumMark: 16, percent: 50, grade: 'D', teacher: 'Teacher Two', gradedAt: '2026-11-01T10:00:00Z' },
      ],
    });
    return reply({});
  };
  window.eval(appSource);
  return { window, calls };
}

{
  const { window, calls } = makeApp(null);
  await tick(120);
  window.document.querySelector('[data-mode="signup"]').click();
  await tick(30);
  const picker = window.document.getElementById('role-picker');
  check('signup asks teacher or student', Boolean(picker) && /Teacher/.test(picker.textContent) && /Student/.test(picker.textContent));
  const radios = window.document.querySelectorAll('input[name="accountType"]');
  check('teacher is the default', radios[0].checked === true);
  radios[1].checked = true;
  radios[1].dispatchEvent(new window.Event('change', { bubbles: true }));
  await tick(20);
  check('choosing student updates the hint', /any teacher/i.test(window.document.getElementById('email-hint').textContent));
  window.document.getElementById('name').value = 'Amina Nakato';
  window.document.getElementById('email').value = 'amina@gmail.com';
  window.document.getElementById('password').value = 'passw0rd1';
  window.document.getElementById('signup-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick(150);
  const call = calls.find((c) => c.path.endsWith('/api/auth/signup'));
  check('signup sends accountType=student', call?.body?.accountType === 'student', JSON.stringify(call?.body?.accountType));
  check('signup still sends the email', call?.body?.email === 'amina@gmail.com');
}

{
  const { window } = makeApp(TEACHER);
  await tick(120);
  window.location.hash = '#/teacher/upload';
  window.dispatchEvent(new window.Event('hashchange'));
  await tick(250);
  const text = window.document.getElementById('view').textContent;
  const email = window.document.getElementById('studentEmail');
  check('upload asks for the student email', Boolean(email), email ? '' : 'missing');
  check('student email is required', email?.hasAttribute('required'));
  check('upload no longer blocks on having students', !/Add a student first/.test(text));
  check('student name is optional', !window.document.getElementById('studentName')?.hasAttribute('required'));
  check('teacher console has no Platform tab', !/Platform/.test(window.document.querySelector('.nav')?.textContent || ''));
  email.value = 'amina@gmail.com';
  email.dispatchEvent(new window.Event('input', { bubbles: true }));
  await tick(30);
  check('saved student name is filled in', window.document.getElementById('studentName').value === 'Amina Nakato', window.document.getElementById('studentName').value);
}

{
  const { window, calls } = makeApp(ADMIN);
  await tick(120);
  check('admin nav exposes Platform', /Platform/.test(window.document.querySelector('.nav')?.textContent || ''));
  check('topbar marks the administrator', /Administrator/.test(window.document.querySelector('.who')?.textContent || ''));
  window.location.hash = '#/admin';
  window.dispatchEvent(new window.Event('hashchange'));
  await tick(300);
  const text = window.document.getElementById('view').textContent;
  check('platform page renders', /One GradeScriptUG key/.test(text));
  check('platform page shows counts', /Teachers/.test(text) && /Student accounts/.test(text));
  check('platform page has the key form', Boolean(window.document.getElementById('admin-key-form')));
  check('key input is a password field', window.document.getElementById('adminApiKey')?.type === 'password');
  window.document.getElementById('adminApiKey').value = 'gsk_12345678_' + 'a'.repeat(32);
  window.document.getElementById('admin-key-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick(150);
  check('key posts to /api/admin/key', calls.some((c) => c.path.endsWith('/api/admin/key') && c.method === 'POST'));
  window.location.hash = '#/teacher/settings';
  window.dispatchEvent(new window.Event('hashchange'));
  await tick(300);
  check('admin also sees the key form in settings', Boolean(window.document.getElementById('key-form')));
}

{
  const { window } = makeApp(TEACHER);
  await tick(120);
  window.location.hash = '#/teacher/settings';
  window.dispatchEvent(new window.Event('hashchange'));
  await tick(300);
  const text = window.document.getElementById('view').textContent;
  check('teacher sees no key input', !window.document.getElementById('apiKey'));
  check('teacher is told the admin holds the key', /administrator/i.test(text));
}

{
  const { window } = makeApp(STUDENT);
  await tick(150);
  check('student lands on the portal', window.location.hash === '#/portal', window.location.hash);
  const text = window.document.getElementById('view').textContent;
  check('portal names the teachers', /marked by 2 teachers/i.test(text), text.match(/marked by[^·]*/i)?.[0]);
  window.location.hash = '#/portal/marks';
  window.dispatchEvent(new window.Event('hashchange'));
  await tick(250);
  const marks = window.document.getElementById('view').textContent;
  check('marks table shows who marked each subject', /Teacher One/.test(marks) && /Teacher Two/.test(marks));
  check('marks table has a Marked by column', /Marked by/.test(marks));
}

console.log(`\n${fails === 0 ? 'ALL PLATFORM UI CHECKS PASSED' : fails + ' FAILED'}`);
process.exit(fails ? 1 : 0);
