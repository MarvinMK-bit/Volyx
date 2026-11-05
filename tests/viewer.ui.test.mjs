/* Marked-work viewer checks (jsdom). Renders the teacher and student viewer
   against a stubbed API and asserts the marker's annotations become real SVG. */
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
const check = (l, ok, extra = '') => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${extra ? ' — ' + extra : ''}`);
};
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

const CONFIG = {
  platform: { name: 'Volyx', tagline: 't', description: 'd' },
  school: { name: 'School', shortName: 'SCH', motto: 'm', address: 'a', phone: 'p', email: 'e', logoText: 'S' },
  scale: [
    { min: 80, max: 100, grade: 'A', points: 1, label: 'Excellent' },
    { min: 70, max: 79, grade: 'B', points: 2, label: 'Very good' },
    { min: 60, max: 69, grade: 'C', points: 3, label: 'Good' },
    { min: 50, max: 59, grade: 'D', points: 4, label: 'Fair' },
    { min: 40, max: 49, grade: 'E', points: 5, label: 'Weak' },
    { min: 0, max: 39, grade: 'F', points: 9, label: 'Needs support' },
  ],
  divisions: [],
  reporting: {
    terms: [{ id: '2026-T3', name: 'Term III', year: 2026, ends: '2026-12-04' }],
    classes: [{ id: 's2-blue', name: 'S.2 Blue', level: 'S.2' }],
    subjects: ['Mathematics'],
    currentTerm: '2026-T3',
  },
  demo: true, googleClientId: '', mailMode: 'dev', devCodes: true, key: { status: 'missing' }, pollSeconds: 6,
};

const TEACHER = { id: 'u_t', email: 't@example.com', name: 'Teacher One', role: 'teacher', emailVerified: true, canManageKey: false, canTeach: true, home: '#/teacher', linkedStudent: null, studentCount: 1 };
const STUDENT = { id: 'u_s', email: 'amina@gmail.com', name: 'Amina Nakato', role: 'student', emailVerified: true, canManageKey: false, canTeach: false, home: '#/portal', linkedStudent: null, studentCount: 0 };

const ANNOTATIONS = [
  { attachmentID: 'att_1', page: 1, pageIndex: 1, type: 'TICK', x: 0.12, y: 0.14, width: 0.36, height: 0.1, questionRef: '1', comment: '', markAwarded: 2, maximumMark: 2, needsReview: false, reviewReason: '' },
  { attachmentID: 'att_1', page: 1, pageIndex: 1, type: 'CROSS', x: 0.12, y: 0.33, width: 0.36, height: 0.1, questionRef: '2', comment: 'Units were left out of the final answer.', markAwarded: 0, maximumMark: 2, needsReview: true, reviewReason: 'Handwriting is hard to read.' },
  { attachmentID: 'att_1', page: 1, pageIndex: 1, type: 'PARTIAL', x: 0.12, y: 0.52, width: 0.36, height: 0.1, questionRef: '3', comment: '', markAwarded: 1, maximumMark: 2, needsReview: false, reviewReason: '' },
  { attachmentID: 'att_1', page: 1, pageIndex: 1, type: 'MARK', x: 0.91, y: 0.86, width: 0.08, height: 0.05, questionRef: '', comment: '', markAwarded: 3, maximumMark: 6, needsReview: false, reviewReason: '' },
  { attachmentID: 'att_2', page: 2, pageIndex: 2, type: 'COMMENT', x: 0.91, y: 0.2, width: 0.08, height: 0.05, questionRef: '4', comment: 'Good reasoning, tidy work.', markAwarded: null, maximumMark: null, needsReview: false, reviewReason: '' },
];

const GRADING = {
  id: 'g1', status: 'COMPLETED', subject: 'Mathematics', assessmentType: 'End of Term Exam',
  title: 'S.2 End of Term', termId: '2026-T3', termName: 'Term III 2026', level: 'S.2',
  studentName: 'Amina Nakato', studentEmail: 'amina@gmail.com',
  totalMark: 12.5, maximumMark: 16, percent: 78.1, grade: 'B',
  feedback: 'Strong algebra. Watch the units on question 2.',
  error: '', teacher: 'Robert Wamala', source: 'demo', gradedAt: '2026-11-01T09:00:00Z',
  questions: [
    { ref: '1', topic: 'Algebra', questionText: 'Solve 3x + 5 = 20', awarded: 2, max: 2, rationale: 'Correct working.', needsReview: false, reviewReason: '' },
    { ref: '2', topic: 'Measurement', questionText: 'Convert 4.5 m to cm', awarded: 0, max: 2, rationale: 'Units omitted.', needsReview: true, reviewReason: 'Handwriting is hard to read.' },
    { ref: '3', topic: 'Geometry', questionText: 'Find the area of the triangle', awarded: 1, max: 2, rationale: 'Half the base used.', needsReview: false, reviewReason: '' },
    { ref: '4', topic: 'Trigonometry', questionText: 'Find the height of the tower', awarded: 5, max: 5, rationale: 'Full method.', needsReview: false, reviewReason: '' },
    { ref: '5', topic: 'Statistics', questionText: 'Work out the median', awarded: 4.5, max: 5, rationale: 'Median right, mean missing.', needsReview: false, reviewReason: '' },
  ],
  annotations: ANNOTATIONS,
  attachments: [
    { id: 'att_1', type: 'SCRIPT', index: 1, filename: 'page-1.png' },
    { id: 'att_2', type: 'SCRIPT', index: 2, filename: 'page-2.png' },
  ],
  pages: [
    { index: 1, kind: 'image', contentType: 'image/png', filename: 'page-1.png' },
    { index: 2, kind: 'image', contentType: 'image/png', filename: 'page-2.png' },
  ],
};

const LIST = [
  { id: 'g1', status: 'COMPLETED', subject: 'Mathematics', assessmentType: 'End of Term Exam', studentName: 'Amina Nakato', studentNumber: 'S2/1', totalMark: 12.5, maximumMark: 16, percent: 78.1, annotationCount: 5, keptPages: 2, createdAt: '2026-11-01T09:00:00Z', updatedAt: '2026-11-01T09:00:00Z' },
  { id: 'g0', status: 'COMPLETED', subject: 'Biology', assessmentType: 'Mid Term', studentName: 'Legacy Script', studentNumber: 'S2/2', totalMark: 9, maximumMark: 16, percent: 56.3, annotationCount: 3, keptPages: 0, createdAt: '2026-10-01T09:00:00Z', updatedAt: '2026-10-01T09:00:00Z' },
];

function makeApp(user, detail = GRADING, calls = []) {
  const dom = new JSDOM(html, { url: 'http://localhost:3000/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.fetch = async (url, opts = {}) => {
    const path = String(url);
    const method = opts.method || 'GET';
    calls.push({ path, method });
    const reply = (o, s = 200) => ({ ok: s < 400, status: s, json: async () => o, text: async () => JSON.stringify(o) });

    if (path.endsWith('/api/config')) return reply(CONFIG);
    if (path.endsWith('/api/me')) return reply({ user, demo: true });
    if (path.endsWith('/api/teacher/gradings')) return reply({ gradings: LIST });
    if (path.includes('/api/teacher/gradings/g1')) return reply({ grading: detail, student: { id: 'st1', name: 'Amina Nakato' } });
    if (path.includes('/api/student/results/g1')) return reply({ grading: { ...detail } });
    if (path.endsWith('/api/student/results')) return reply({ readOnly: true, results: LIST });
    if (path.endsWith('/api/student/me')) return reply({
      readOnly: true, role: 'student',
      student: { id: 'u_s', name: 'Amina Nakato', email: 'amina@gmail.com', className: '', studentNumber: '', emails: ['amina@gmail.com'] },
      teachers: [{ id: 'u_t', name: 'Robert Wamala' }], termCount: 1, assessmentCount: 2,
      mustChangePassword: false,
      permissions: { viewOwnResults: true, editAnything: false, viewOtherStudents: false, systemSettings: false },
    });
    if (path.endsWith('/api/student/terms')) return reply({ readOnly: true, terms: [] });
    if (path.endsWith('/api/teacher/overview')) return reply({
      demo: true, user, key: { status: 'missing' }, counts: { students: 1, gradings: 1 },
      terms: CONFIG.reporting.terms, classes: CONFIG.reporting.classes,
      students: [{ id: 'st1', name: 'Amina Nakato', email: 'amina@gmail.com', studentNumber: 'S2/1', classId: 's2-blue', className: 'S.2 Blue', level: 'S.2' }],
      recent: LIST,
    });
    return reply({});
  };
  window.eval(appSource);
  return { window, calls };
}

/* ---------- teacher viewer ---------- */
{
  const { window, calls } = makeApp(TEACHER);
  await tick(150);
  window.location.hash = '#/teacher/grading/g1';
  window.dispatchEvent(new window.Event('hashchange'));
  await tick(300);

  const doc = window.document;
  const view = doc.getElementById('view');
  const text = view.textContent;

  check('teacher detail route loads the grading', calls.some((c) => c.path.includes('/api/teacher/gradings/g1')));
  check('viewer says whose work it is', /Amina Nakato/.test(text));
  check('viewer shows the score', /12\.5/.test(text) && /16/.test(text));
  check('viewer names the marker', /Robert Wamala/.test(text));
  check('viewer shows the feedback', /Watch the units/.test(text));
  check('viewer renders a page frame per page', doc.querySelectorAll('.page-frame').length === 2, String(doc.querySelectorAll('.page-frame').length));
  check('page 1 is fetched from the page route', doc.querySelector('.page-frame img')?.getAttribute('src') === '/api/teacher/gradings/g1/pages/1', doc.querySelector('.page-frame img')?.getAttribute('src'));

  const svgs = doc.querySelectorAll('.marks-layer');
  check('every page has an svg overlay', svgs.length === 2, String(svgs.length));
  check('overlay is set to the page pixel box', /^0 0 \d+ \d+$/.test(svgs[0]?.getAttribute('viewBox') || ''), svgs[0]?.getAttribute('viewBox'));

  const p1 = svgs[0];
  const paths = [...p1.querySelectorAll('path')].map((p) => p.getAttribute('d'));
  check('tick glyph drawn', paths.includes('M4 13l5 5L20 6'), paths.join(' | '));
  check('cross glyph drawn', paths.includes('M6 6l12 12M18 6 6 18'));
  check('partial glyph drawn', paths.includes('M4 13l5 5L20 6M9 6l6 12'));
  check('glyphs use the red marking pen', [...p1.querySelectorAll('path')].every((p) => p.getAttribute('stroke') === '#d32f2f'));
  check('marks are drawn, not just described', p1.querySelectorAll('path').length === 3, String(p1.querySelectorAll('path').length));

  const marksText = [...p1.querySelectorAll('text')].map((t) => t.textContent);
  check('the MARK annotation is drawn as 3/6', marksText.includes('3/6'), marksText.join(' | '));
  check('needsReview draws a ? flag', marksText.includes('?'));
  check('review reason is surfaced in the page text', /Handwriting is hard to read/.test(text));

  const p2 = svgs[1];
  const p2text = [...p2.querySelectorAll('text')].map((t) => t.textContent);
  check('margin comment is drawn on page 2', p2text.some((t) => /Good reasoning/.test(t)), p2text.join(' | '));
  check('page 2 has no ticks', p2.querySelectorAll('path').length === 0);

  check('question table lists every question', doc.querySelectorAll('.q-table tbody tr').length === 5, String(doc.querySelectorAll('.q-table tbody tr').length));
  check('no-review page still shows the marks per question', /Units omitted/.test(text));
}


/* ---------- how it was marked and graded ---------- */
{
  const { window } = makeApp(TEACHER);
  await tick(150);
  window.location.hash = '#/teacher/grading/g1';
  window.dispatchEvent(new window.Event('hashchange'));
  await tick(300);
  const doc = window.document;
  const text = doc.getElementById('view').textContent;

  check('the viewer explains how the grade was worked out', /How this was graded/.test(text));
  const flow = doc.querySelector('.grade-flow')?.textContent || '';
  check('the working shows marks given, possible and percent', /12\.5/.test(flow) && /16/.test(flow) && /78\.1%/.test(flow), flow.replace(/\s+/g, ' ').trim());
  check('the working names the band and its points', /Very good · 2 points/.test(flow), flow.replace(/\s+/g, ' ').trim());
  check('the working says where the band sits', /Grade B covers 70–79%/.test(text));
  check('the working says how close the next grade was', /0\.3 more marks would have reached an A/.test(text), text.match(/[0-9.]+ more marks[^.]*/)?.[0]);
  check('the working names the costliest question', /most lost was Q2 \(−2\)/.test(text), text.match(/most lost was[^.]*/)?.[0]);
  check('the working counts full-mark questions', /2 of 5 questions got full marks/.test(text), text.match(/\d+ of \d+ questions[^.]*/)?.[0]);
  check('the working checks the question marks add up', /add up to 12\.5 of 16/.test(text));
  check('the table is titled as marking, not just marks', /How each question was marked/.test(text));

  /* question ⇄ mark spotlight */
  const rows = doc.querySelectorAll('.q-row');
  check('each question row is clickable', rows.length === 5 && rows[0].hasAttribute('tabindex'), String(rows.length));
  const svg1 = doc.querySelectorAll('.marks-layer')[0];
  check('every mark knows its question', Boolean(svg1.querySelector('[data-qref="2"]')));
  const row2 = doc.querySelector('.q-row[data-qref="2"]');
  row2.click();
  await tick(30);
  check('clicking a question lights up its mark', svg1.classList.contains('focus') && svg1.querySelector('[data-qref="2"]').classList.contains('hit'));
  check('the lit mark shows its box', Boolean(svg1.querySelector('[data-qref="2"] .mark-box')));
  check('other marks are dimmed', !svg1.querySelector('[data-qref="1"]').classList.contains('hit'));
  check('the row stays highlighted', row2.classList.contains('active'));
  row2.click();
  await tick(30);
  check('clicking again clears the spotlight', !svg1.classList.contains('focus'));

  /* every question gets its own row with a mark bar */
  check('each question row shows its mark as a bar', doc.querySelectorAll('.q-bar').length === 5);
  check('full marks are toned as good', doc.querySelector('.q-row[data-qref="1"] .q-bar')?.classList.contains('good'));
}

/* ---------- legacy script with no stored page ---------- */
{
  const legacy = { ...GRADING, id: 'g0', pages: [], annotations: [], questions: [] };
  const { window } = makeApp(TEACHER, legacy);
  await tick(150);
  window.location.hash = '#/teacher/grading/g0';
  window.dispatchEvent(new window.Event('hashchange'));
  await tick(250);
  const text = window.document.getElementById('view').textContent;
  check('missing pages degrade gracefully', /No page copy for this script/.test(text));
  check('degraded state explains what to do', /uploaded from now on/i.test(text));
}

/* ---------- teacher list page ---------- */
{
  const { window } = makeApp(TEACHER);
  await tick(150);
  window.location.hash = '#/teacher/marked';
  window.dispatchEvent(new window.Event('hashchange'));
  await tick(250);
  const doc = window.document;
  const text = doc.getElementById('view').textContent;
  check('marked-work list has its own tab', /Marked work/.test(doc.querySelector('.nav')?.textContent || ''));
  check('list shows every graded script', /Amina Nakato/.test(text) && /Legacy Script/.test(text));
  const link = [...doc.querySelectorAll('a')].find((a) => a.getAttribute('href') === '#/teacher/grading/g1');
  check('list links into the viewer', Boolean(link));
  check('list shows which scripts have a page copy', /2 pages kept/.test(text) && /no page copy/.test(text));
}

/* ---------- student viewer ---------- */
{
  const { window, calls } = makeApp(STUDENT);
  await tick(200);
  window.location.hash = '#/portal/result/g1';
  window.dispatchEvent(new window.Event('hashchange'));
  await tick(300);
  const doc = window.document;
  const text = doc.getElementById('view').textContent;
  check('student can open their marked script', /Amina Nakato/.test(text) && doc.querySelectorAll('.page-frame').length === 2);
  check('student pages load from the student route', doc.querySelector('.page-frame img')?.getAttribute('src') === '/api/student/results/g1/pages/1', doc.querySelector('.page-frame img')?.getAttribute('src'));
  check('student viewer draws the tick', [...doc.querySelectorAll('.marks-layer path')].some((p) => p.getAttribute('d') === 'M4 13l5 5L20 6'));
  check('student viewer shows the feedback', /Watch the units/.test(text));
  check('student never calls a teacher endpoint', !calls.some((c) => c.path.includes('/api/teacher/')));
}

{
  const { window } = makeApp(STUDENT);
  await tick(200);
  window.location.hash = '#/portal/marks';
  window.dispatchEvent(new window.Event('hashchange'));
  await tick(250);
  const link = [...window.document.querySelectorAll('a')].find((a) => a.getAttribute('href') === '#/portal/result/g1');
  check('marks table links to the marked work', Boolean(link));
}

console.log(`\n${fails === 0 ? 'ALL VIEWER CHECKS PASSED' : fails + ' FAILED'}`);
process.exit(fails ? 1 : 0);
