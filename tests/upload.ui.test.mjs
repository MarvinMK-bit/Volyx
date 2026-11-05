/* Upload-page resilience checks (jsdom): the form must say exactly why a
   grading was not queued, keep the files, and survive a restarting server. */
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
  scale: [{ min: 80, max: 100, grade: 'A', points: 1, label: 'Excellent' }],
  divisions: [],
  reporting: {
    terms: [{ id: '2026-T3', name: 'Term III', year: 2026, ends: '2026-12-04' }],
    classes: [{ id: 's2-blue', name: 'S.2 Blue', level: 'S.2' }],
    subjects: ['Mathematics'],
    currentTerm: '2026-T3',
  },
  demo: true, googleClientId: '', mailMode: 'dev', devCodes: true, key: { status: 'missing' }, pollSeconds: 6,
};

const TEACHER = { id: 'u_t', email: 't@example.com', name: 'Teacher One', role: 'teacher', emailVerified: true, canManageKey: false, canTeach: true, home: '#/teacher', linkedStudent: null, studentCount: 0 };

function makeApp(handlers = {}) {
  const dom = new JSDOM(html, { url: 'http://localhost:3000/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const calls = [];
  window.fetch = async (url, opts = {}) => {
    const path = String(url);
    calls.push({ path, method: opts.method || 'GET' });
    for (const [needle, handler] of Object.entries(handlers)) {
      if (path.includes(needle)) return handler({ path, opts });
    }
    const reply = (o, s = 200) => ({ ok: s < 400, status: s, json: async () => o });
    if (path.endsWith('/api/config')) return reply(CONFIG);
    if (path.endsWith('/api/me')) return reply({ user: TEACHER, demo: true });
    if (path.endsWith('/api/teacher/overview')) {
      return reply({
        demo: true, user: TEACHER, key: { status: 'missing' },
        counts: { students: 0, gradings: 0 }, terms: CONFIG.reporting.terms, classes: CONFIG.reporting.classes,
        students: [], recent: [],
      });
    }
    return reply({});
  };
  window.eval(appSource);
  return { window, calls };
}

async function openUpload(window) {
  window.location.hash = '#/teacher/upload';
  window.dispatchEvent(new window.Event('hashchange'));
  await tick(300);
}

function dropFile(window, file) {
  const dz = window.document.getElementById('dropzone');
  const ev = new window.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: { files: [file] } });
  dz.dispatchEvent(ev);
}

/* ---------- the server refuses: say why, keep the form ---------- */
{
  const { window } = makeApp({
    '/api/teacher/gradings': () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: 'page-1.png must be a PDF, PNG, JPEG or WEBP file!' }),
    }),
  });
  await tick(150);
  await openUpload(window);
  const doc = window.document;

  const form = doc.getElementById('upload-form');
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick(80);
  const noEmail = doc.getElementById('upload-error');
  check('submitting with no email shows an inline reason', noEmail && !noEmail.hidden && /student's email/i.test(noEmail.textContent), noEmail?.textContent?.trim());

  doc.getElementById('studentEmail').value = 'amina@gmail.com';
  doc.getElementById('subject').value = 'Mathematics';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick(80);
  check('submitting with no page shows an inline reason', /Attach at least one script page/i.test(doc.getElementById('upload-error').textContent));

  check('the dropzone tells you photos are converted', /converted to PNG/i.test(doc.getElementById('dropzone').textContent));
}

/* ---------- a real file, rejected by the API ---------- */
{
  const { window } = makeApp({
    '/api/teacher/gradings': () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: 'Subject is required.' }),
    }),
  });
  await tick(150);
  await openUpload(window);
  const doc = window.document;
  const file = new window.File([new Uint8Array([137, 80, 78, 71])], 'page-1.png', { type: 'image/png' });
  dropFile(window, file);
  await tick(80);

  doc.getElementById('studentEmail').value = 'amina@gmail.com';
  doc.getElementById('subject').value = 'Mathematics';
  doc.getElementById('upload-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick(200);

  const box = doc.getElementById('upload-error');
  check('a refused upload is explained in the form, not just a toast', box && !box.hidden && /Grading was not queued/.test(box.textContent), box?.textContent?.trim().slice(0, 90));
  check('the reason from the server is repeated', /Subject is required/.test(box.textContent));
  check('the button is usable again', doc.getElementById('submit-btn').disabled === false);
  check('the chosen page is still attached', /page-1\.png/.test(doc.getElementById('filelist').textContent));
}

/* ---------- server unreachable: retry once, then say so plainly ---------- */
{
  let attempts = 0;
  const { window } = makeApp({
    '/api/teacher/gradings': () => {
      attempts += 1;
      throw new TypeError('Failed to fetch');
    },
  });
  await tick(150);
  await openUpload(window);
  const doc = window.document;
  dropFile(window, new window.File([new Uint8Array([1, 2, 3])], 'page-1.png', { type: 'image/png' }));
  await tick(80);
  doc.getElementById('studentEmail').value = 'amina@gmail.com';
  doc.getElementById('subject').value = 'Mathematics';
  doc.getElementById('upload-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick(1200);

  const box = doc.getElementById('upload-error');
  check('a dead server is retried once before failing', attempts === 2, String(attempts));
  check('the message explains the server was unreachable', /Cannot reach the Volyx server/i.test(box?.textContent || ''), box?.textContent?.trim().slice(0, 90));
  check('it says nothing was lost', /still attached/i.test(box?.textContent || ''));
}

/* ---------- success is confirmed in the form ---------- */
{
  const { window } = makeApp({
    '/api/teacher/gradings': () => ({
      ok: true,
      status: 202,
      json: async () => ({ ok: true, grading: { id: 'sim_1', status: 'PENDING' } }),
    }),
  });
  await tick(150);
  await openUpload(window);
  const doc = window.document;
  dropFile(window, new window.File([new Uint8Array([1, 2, 3])], 'page-1.png', { type: 'image/png' }));
  await tick(80);
  doc.getElementById('studentEmail').value = 'amina@gmail.com';
  doc.getElementById('subject').value = 'Mathematics';
  doc.getElementById('upload-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick(200);

  const ok = doc.getElementById('upload-ok');
  check('queuing a grading is confirmed in the form', ok && !ok.hidden && /Queued for/.test(ok.textContent), ok?.textContent?.trim().slice(0, 80));
  check('the confirmation links to the marked work', /#\/teacher\/marked/.test(ok.innerHTML));
  check('the error box is cleared on success', doc.getElementById('upload-error').hidden === true);
}

console.log(`\n${fails === 0 ? 'ALL UPLOAD CHECKS PASSED' : fails + ' FAILED'}`);
process.exit(fails ? 1 : 0);
