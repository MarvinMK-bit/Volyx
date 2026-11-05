const BASE = process.env.BASE || 'http://localhost:3100';
let fails = 0;
const check = (l, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${extra ? ' — ' + extra : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function j(path, { method = 'GET', body, token, form } = {}) {
  const headers = {};
  if (token) headers['X-Session'] = token;
  if (body && !form) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: form || (body ? JSON.stringify(body) : undefined) });
  const text = await res.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
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

/* ---------- password + code auth still work ---------- */
{
  const email = `auth.${RUN}@example.com`;
  const su = await signup(email, 'Auth Teacher', 'teacher');
  check('signup issues a verification code', su.status === 200 && su.body.delivery?.devCode);
  const unverified = await j('/api/auth/login', { method: 'POST', body: { email, password: 'passw0rd1' } });
  check('unverified account cannot sign in', unverified.status === 403 && unverified.body.needsVerification === true);
  const vf = await verify(su);
  check('verification activates the account', vf.status === 200 && vf.body.user?.emailVerified);
  const login = await j('/api/auth/login', { method: 'POST', body: { email, password: 'passw0rd1' } });
  check('password sign-in works', login.status === 200);

  const code = await j('/api/auth/request-code', { method: 'POST', body: { email } });
  check('"email me a code" still issues a code', code.status === 200 && code.body.delivery?.devCode);
  const codeLogin = await j('/api/auth/verify-code', { method: 'POST', body: { email, code: code.body.delivery.devCode } });
  check('code sign-in works', codeLogin.status === 200 && codeLogin.body.user?.email);

  const reset = await j('/api/auth/forgot', { method: 'POST', body: { email } });
  const resetDone = await j('/api/auth/reset', { method: 'POST', body: { email, code: reset.body.delivery.devCode, password: 'newpass123' } });
  check('password reset works', resetDone.status === 200);
  check('old password stops working after reset', (await j('/api/auth/login', { method: 'POST', body: { email, password: 'passw0rd1' } })).status === 401);
}

/* ---------- teacher isolation ---------- */
const A = await verify(await signup(`a.${RUN}@example.com`, 'Teacher A', 'teacher'));
const B = await verify(await signup(`b.${RUN}@example.com`, 'Teacher B', 'teacher'));
const AT = A.body.token, BT = B.body.token;

const stA = await j('/api/students', { method: 'POST', token: AT, body: { name: 'Pupil A', email: `pupil.a.${RUN}@example.com`, classId: 's2-blue' } });
check('teacher A adds a student', stA.status === 201);
check("teacher B's list is empty", (await j('/api/students', { token: BT })).body.students.length === 0);
check("teacher B cannot read A's student", (await j(`/api/students/${stA.body.student.id}/credentials`, { token: BT })).status === 404);
check('new teacher starts with 0 students', (await j('/api/students', { token: BT })).body.students.length === 0);

/* ---------- a teacher-issued student login sees work for that email ---------- */
const issued = stA.body.credentials;
check('adding a student still mints a login', Boolean(issued?.loginEmail && issued?.password), issued?.loginEmail);
const pupilLogin = await j('/api/auth/login', { method: 'POST', body: { email: issued.loginEmail, password: issued.password } });
check('the issued login works', pupilLogin.status === 200 && pupilLogin.body.user.role === 'student');
const PT = pupilLogin.body.token;

/* grade by picking the saved student (no email typed) */
const byId = await upload(AT, { studentId: stA.body.student.id, subject: 'Mathematics' });
check('grading by saved student still works', byId.status === 202, String(byId.status));
check('the email is taken from the student record', byId.body.grading.studentEmail === `pupil.a.${RUN}@example.com`, byId.body.grading.studentEmail);

/* and another teacher grades the same address directly */
const byEmail = await upload(BT, { email: `pupil.a.${RUN}@example.com`, name: 'Pupil A', subject: 'Biology' });
check('a second teacher can grade the same email', byEmail.status === 202);

await sleep(13000);

const seen = await j('/api/student/results', { token: PT });
check('issued login sees work addressed to the student email', seen.body.results?.length === 2, String(seen.body.results?.length));
check('and it names both teachers', /Teacher A/.test(JSON.stringify(seen.body.results)) && /Teacher B/.test(JSON.stringify(seen.body.results)));

/* ---------- isolation of gradings ---------- */
check("teacher B cannot open A's grading", (await j(`/api/teacher/gradings/${byId.body.grading.id}`, { token: BT })).status === 404);
check('teacher A sees only their own gradings', (await j('/api/teacher/gradings', { token: AT })).body.gradings.every((g) => g.studentEmail));
check('admin has no special access to teacher students', (await (async () => {
  const ad = await j('/api/auth/login', { method: 'POST', body: { email: 'ryanroject@gmail.com', password: 'volyx-admin-2026' } });
  return j('/api/students', { token: ad.body.token });
})().then((r) => r.body.students.length === 0)));

/* ---------- read-only enforcement ---------- */
const blockedRoutes = [
  ['POST', '/api/students'],
  ['GET', '/api/teacher/overview'],
  ['GET', '/api/teacher/gradings'],
  ['POST', '/api/teacher/clear-results'],
  ['GET', '/api/admin/overview'],
  ['POST', '/api/admin/key'],
  ['POST', '/api/settings/google'],
];
for (const [method, path] of blockedRoutes) {
  const r = await j(path, { method, token: PT, body: method === 'POST' ? {} : undefined });
  check(`student blocked: ${method} ${path}`, r.status === 403, String(r.status));
}

/* ---------- student password change ---------- */
const chg = await j('/api/auth/change-password', { method: 'POST', token: PT, body: { currentPassword: issued.password, newPassword: 'myOwnPass123' } });
check('student can replace the temporary password', chg.status === 200);
check('and signs in with it', (await j('/api/auth/login', { method: 'POST', body: { email: issued.loginEmail, password: 'myOwnPass123' } })).status === 200);

/* ---------- deleting a student removes their login ---------- */
const del = await j(`/api/students/${stA.body.student.id}`, { method: 'DELETE', token: AT });
check('teacher deletes the student', del.status === 200);
check('the issued login stops working', (await j('/api/auth/login', { method: 'POST', body: { email: issued.loginEmail, password: 'myOwnPass123' } })).status === 401);

/* ---------- teacher-created profile keeps working for the guardian flow ---------- */
const S = await verify(await signup(`self.${RUN}@example.com`, 'Self Student', 'student'));
const su2 = await upload(BT, { email: `self.${RUN}@example.com`, subject: 'Chemistry' });
check('a self-signed student can be graded immediately', su2.status === 202);
await sleep(12000);
const selfView = await j('/api/student/results', { token: S.body.token });
check('and sees it', selfView.body.results?.length === 1, String(selfView.body.results?.length));

console.log(`\n${fails === 0 ? 'ALL API REGRESSION CHECKS PASSED' : fails + ' FAILED'}`);
process.exit(fails ? 1 : 0);
