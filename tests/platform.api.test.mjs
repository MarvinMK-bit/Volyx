/* Platform + marked-work API checks. Needs a server on :3100
   (see uitest/run.sh — a throwaway copy with a fresh data/). */
const BASE = process.env.BASE || 'http://127.0.0.1:3100';
const RUN = Date.now();
let fails = 0;
const check = (l, ok, extra = '') => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${extra ? ' — ' + extra : ''}`);
};

function client() {
  let cookie = '';
  return async function call(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (cookie) headers.cookie = cookie;
    const res = await fetch(BASE + path, { ...opts, headers });
    const sc = res.headers.getSetCookie?.() || [];
    if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
    const ct = res.headers.get('content-type') || '';
    const body = ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, body, ct };
  };
}

const jsonPost = (c, path, obj) =>
  c(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

async function signupAndVerify(c, { name, email, password, accountType }) {
  const s = await jsonPost(c, '/api/auth/signup', { name, email, password, accountType });
  const code = s.body?.delivery?.devCode || s.body?.devCode;
  if (code) await jsonPost(c, '/api/auth/verify-email', { email, code });
  const login = await jsonPost(c, '/api/auth/login', { email, password });
  return { signup: s.status, login, code: Boolean(code) };
}

/* 1x1 png so page storage has something real to keep. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

async function upload(c, { name, email, subject }) {
  const form = new FormData();
  form.set('studentName', name);
  form.set('studentEmail', email);
  form.set('subject', subject);
  form.set('assessmentType', 'End of Term Exam');
  form.set('attachments[0][type]', 'SCRIPT');
  form.set('attachments[0][file]', new Blob([PNG], { type: 'image/png' }), 'page-1.png');
  return c('/api/teacher/gradings', { method: 'POST', body: form });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- admin holds the only key ---------- */
const admin = client();
const adminLogin = await jsonPost(admin, '/api/auth/login', {
  email: 'ryanroject@gmail.com',
  password: process.env.ADMIN_PASSWORD || 'volyx-admin-2026',
});
check('admin can sign in', adminLogin.status === 200, String(adminLogin.status));
check('admin role is admin', adminLogin.body?.user?.role === 'admin', adminLogin.body?.user?.role);
check('admin may manage the key', adminLogin.body?.user?.canManageKey === true);

/* Sandbox has no route to api.gradescriptug.com, so a fake key is rejected.
   What matters: only the admin may submit one, and nothing usable is stored. */
const fakeKey = `gsk_${'a'.repeat(8)}_${'b'.repeat(32)}`;
const keySet = await jsonPost(admin, '/api/admin/key', { apiKey: fakeKey });
check('admin may submit a key (it is verified, not trusted)', keySet.status >= 200, String(keySet.status));
let cfg = (await admin('/api/config')).body;
check('an unverifiable key is not stored as connected', cfg.key?.status !== 'connected', cfg.key?.status);
check('config never returns the key itself', !JSON.stringify(cfg).includes(fakeKey.split('_')[2]));
await admin('/api/admin/key', { method: 'DELETE' });
cfg = (await admin('/api/config')).body;
check('removing a bad key puts the platform back in demo mode', cfg.demo === true && cfg.key?.status === 'missing', JSON.stringify(cfg.key));

/* ---------- two teachers, isolated ---------- */
const tA = client();
const tAEmail = `teacher.a.${RUN}@example.com`;
const tASignup = await signupAndVerify(tA, { name: 'Teacher A', email: tAEmail, password: 'passw0rd1', accountType: 'teacher' });
check('teacher signup verifies and logs in', tASignup.signup === 200 && tASignup.login.status === 200);
check('new teacher starts with zero students', (await tA('/api/teacher/overview')).body.counts.students === 0);

const tB = client();
const tBEmail = `teacher.b.${RUN}@example.com`;
await signupAndVerify(tB, { name: 'Teacher B', email: tBEmail, password: 'passw0rd1', accountType: 'teacher' });

check('teacher cannot read the platform key', (await tA('/api/admin/key')).status === 403);
check('teacher cannot post the platform key', (await jsonPost(tA, '/api/admin/key', { apiKey: 'x' })).status === 403);
check('teacher cannot open the admin overview', (await tA('/api/admin/overview')).status === 403);
check('teacher cannot reach student routes', (await tA('/api/student/results')).status === 403);

const sharedEmail = `shared.${RUN}@example.com`;
const upA = await upload(tA, { name: 'Shared Student', email: sharedEmail, subject: 'Mathematics' });
check('teacher A uploads a script', upA.status === 202, JSON.stringify(upA.body).slice(0, 120));
const gidA = upA.body?.grading?.id;
check('the upload keeps a copy of the page', (upA.body?.grading?.keptPages || 0) === 1, String(upA.body?.grading?.keptPages));

const upB = await upload(tB, { name: 'Shared Student', email: sharedEmail, subject: 'Biology' });
const gidB = upB.body?.grading?.id;
check('teacher B uploads for the same email', upB.status === 202);

for (let i = 0; i < 4; i++) {
  await tA('/api/teacher/sync', { method: 'POST' });
  await tB('/api/teacher/sync', { method: 'POST' });
}

const detailA = await tA(`/api/teacher/gradings/${gidA}`);
check('teacher A opens the grading detail', detailA.status === 200);
check('detail carries the stored page', (detailA.body?.grading?.pages || []).length === 1);
check('detail carries the marker annotations', (detailA.body?.grading?.annotations || []).length > 0);
const ann = (detailA.body?.grading?.annotations || [])[0] || {};
check(
  'annotations use the documented box fields',
  typeof ann.x === 'number' && typeof ann.y === 'number' && typeof ann.width === 'number' && typeof ann.height === 'number',
  JSON.stringify(ann).slice(0, 90)
);
check('annotations carry a page index', typeof ann.pageIndex === 'number', String(ann.pageIndex));

const pageA = await tA(`/api/teacher/gradings/${gidA}/pages/1`);
check('teacher A loads the page image', pageA.status === 200 && pageA.ct.startsWith('image/'), `${pageA.status} ${pageA.ct}`);
check('a page that was never stored is a 404', (await tA(`/api/teacher/gradings/${gidA}/pages/7`)).status === 404);
check('teacher B cannot open teacher A pages', (await tB(`/api/teacher/gradings/${gidA}/pages/1`)).status === 404);
check('teacher B cannot open teacher A grading', (await tB(`/api/teacher/gradings/${gidA}`)).status === 404);

/* ---------- the student sees every teacher by email ---------- */
const stu = client();
const stuSignup = await signupAndVerify(stu, { name: 'Shared Student', email: sharedEmail, password: 'passw0rd1', accountType: 'student' });
check('student signs up with their own email', stuSignup.login.status === 200 && stuSignup.login.body?.user?.role === 'student');
const stuResults = await stu('/api/student/results');
check('student sees both teachers’ marks', stuResults.body?.results?.length === 2, String(stuResults.body?.results?.length));
const teachers = (stuResults.body?.results || []).map((r) => r.teacher).sort();
check('both teachers are named', teachers.length === 2 && teachers[0] !== teachers[1], teachers.join(', '));

const stuDetail = await stu(`/api/student/results/${gidA}`);
check('student opens their marked script', stuDetail.status === 200);
check('student detail includes annotations', (stuDetail.body?.grading?.annotations || []).length > 0);
const stuPage = await stu(`/api/student/results/${gidA}/pages/1`);
check('student loads the page image', stuPage.status === 200 && stuPage.ct.startsWith('image/'), `${stuPage.status} ${stuPage.ct}`);
check('student cannot reach teacher routes', (await stu(`/api/teacher/gradings/${gidA}`)).status === 403);

const other = client();
const otherEmail = `other.${RUN}@example.com`;
await signupAndVerify(other, { name: 'Other Student', email: otherEmail, password: 'passw0rd1', accountType: 'student' });
check('another student cannot open the grading', (await other(`/api/student/results/${gidA}`)).status === 404);
check('another student cannot open the page', (await other(`/api/student/results/${gidA}/pages/1`)).status === 404);
check('another student sees an empty list', ((await other('/api/student/results')).body?.results || []).length === 0);

/* ---------- clearing results also clears stored pages ---------- */
const cleared = await tA('/api/teacher/clear-results', { method: 'POST' });
check('teacher clears their results', cleared.status === 200 && cleared.body.removed === 1, JSON.stringify(cleared.body));
check('cleared grading is gone', (await tA(`/api/teacher/gradings/${gidA}`)).status === 404);
check('cleared page is gone too', (await tA(`/api/teacher/gradings/${gidA}/pages/1`)).status === 404);
check('teacher B is untouched', (await tB(`/api/teacher/gradings/${gidB}`)).status === 200);

/* ---------- key removal drops everyone back to demo ---------- */
check('admin removes the key', (await admin('/api/admin/key', { method: 'DELETE' })).status === 200);
check('config says the key is missing', (await admin('/api/config')).body.key?.status === 'missing');

console.log(`\n${fails === 0 ? 'ALL PLATFORM API CHECKS PASSED' : fails + ' FAILED'}`);
process.exit(fails ? 1 : 0);
