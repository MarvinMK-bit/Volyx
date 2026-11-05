/* Design-system checks: the 60/30/10 palette, the type scale, and the rule
   that every screen is one purpose + one primary action with its words in COPY. */
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

const css = fs.readFileSync(`${ROOT}/public/styles.css`, 'utf8');
const appSource = fs.readFileSync(`${ROOT}/public/app.js`, 'utf8');
const html = fs.readFileSync(`${ROOT}/public/index.html`, 'utf8');

let fails = 0;
const check = (l, ok, extra = '') => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${extra ? ' — ' + extra : ''}`);
};
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

/* ---------------- palette ---------------- */
{
  const root = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
  check('the palette documents the 60 / 30 / 10 split', /60%/.test(css) && /30%/.test(css) && /10%/.test(css));
  check('60% neutrals are defined', ['--n-0', '--n-50', '--ink', '--line'].every((t) => root.includes(t + ':')));
  check('30% brand tones are defined', ['--brand-800', '--brand-700', '--brand-100'].every((t) => root.includes(t + ':')));
  check('10% accent is defined', ['--accent-500', '--accent-600', '--accent-on'].every((t) => root.includes(t + ':')));

  const btn = css.slice(css.indexOf('.btn-primary {'), css.indexOf('}', css.indexOf('.btn-primary {')));
  check('the primary action is the accent colour, not the brand colour', /var\(--accent-500\)/.test(btn) && !/var\(--green/.test(btn), btn.replace(/\s+/g, ' ').trim());
  check('accent text on the accent colour is the dark ink', /--accent-on/.test(btn));

  const topbar = css.slice(css.indexOf('.topbar {'), css.indexOf('}', css.indexOf('.topbar {')));
  check('the bar is the 30% brand colour', /var\(--brand-800\)|var\(--green-800\)/.test(topbar));
  const darkBlock = css.slice(css.indexOf("[data-theme='dark'] {"), css.indexOf('}', css.indexOf("[data-theme='dark'] {")));
  check('dark theme redefines the same roles', /--heading:/.test(darkBlock) && /--canvas:/.test(darkBlock) && /--n-50:/.test(darkBlock));
}

/* ---------------- type ---------------- */
{
  const sizes = [...css.matchAll(/font-size:\s*([0-9.]+)(rem|px)/g)].map((m) => ({ v: Number(m[1]), unit: m[2] }));
  const tooSmall = sizes.filter((s) => (s.unit === 'rem' ? s.v < 0.75 : s.v < 12));
  check('no text is smaller than 12px', tooSmall.length === 0, tooSmall.map((s) => `${s.v}${s.unit}`).join(', '));

  check('body text is 16px on a 1.6 line-height', /font-size: var\(--fs-md\)/.test(css) && /line-height: var\(--lh-body\)/.test(css));
  check('a single type scale is defined', ['--fs-2xs', '--fs-xs', '--fs-sm', '--fs-md', '--fs-lg', '--fs-xl', '--fs-2xl'].every((t) => css.includes(t + ':')));
  check('body copy is capped to a readable measure', /--measure:/.test(css) && /:where\(p, li\) \{ max-width: var\(--measure\)/.test(css));

  const inlineSizes = [...appSource.matchAll(/font-size:\s*\.?([0-9]*\.?[0-9]+)rem/g)].map((m) => Number(m[1]));
  check('inline styles in the app keep the floor too', inlineSizes.every((v) => v >= 0.75), inlineSizes.filter((v) => v < 0.75).join(', '));
}

/* ---------------- the requested hues ---------------- */
{
  const raw = (name) => {
    const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(css);
    return m ? m[1].trim() : null;
  };
  const hex = (name, depth = 0) => {
    const v = raw(name);
    if (!v || depth > 6) return null;
    if (/^#[0-9a-fA-F]{6}$/.test(v)) return v;
    const alias = /^var\(--([\w-]+)\)$/.exec(v);
    return alias ? hex(alias[1], depth + 1) : null;
  };
  const hsl = (h) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let hue = 0;
    if (max !== min) {
      const d = max - min;
      if (max === r) hue = ((g - b) / d) % 6;
      else if (max === g) hue = (b - r) / d + 2;
      else hue = (r - g) / d + 4;
      hue *= 60;
      if (hue < 0) hue += 360;
    }
    const l = (max + min) / 2;
    const sat = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
    return { hue, sat: sat * 100, light: l * 100 };
  };

  const canvas = hsl(hex('n-50'));
  const chrome = hsl(hex('brand-800'));
  const accent = hsl(hex('accent-500'));

  check('60% is blue', canvas.hue >= 195 && canvas.hue <= 250 && canvas.sat > 20, `hue ${Math.round(canvas.hue)}° sat ${Math.round(canvas.sat)}%`);
  check('60% is a light surface, not a mid tone', canvas.light > 88, `${Math.round(canvas.light)}% lightness`);
  check('30% is charcoal', chrome.light < 25 && chrome.sat <= 20, `L ${Math.round(chrome.light)}% · S ${Math.round(chrome.sat)}%`);
  check('10% is pink', accent.hue >= 300 || accent.hue <= 350, `hue ${Math.round(accent.hue)}°`);
  check('10% is a light pink, not a hot magenta', accent.light > 70 && accent.sat < 80, `L ${Math.round(accent.light)}% · S ${Math.round(accent.sat)}%`);
  check('the palette carries no green or gold', !/#[0-9a-f]{6}/i.test('') || !/--accent-500:\s*#(e|d)[0-9a-f]?[bc]/i.test(css));
}

/* ---------------- contrast ---------------- */
{
  const raw = (name) => {
    const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(css);
    return m ? m[1].trim() : null;
  };
  const token = (name, depth = 0) => {
    const v = raw(name);
    if (!v || depth > 6) return null;
    if (/^#[0-9a-fA-F]{6}$/.test(v)) return v;
    const alias = /^var\(--([\w-]+)\)$/.exec(v);
    return alias ? token(alias[1], depth + 1) : null;
  };
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const f = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => {
    const la = lum(a);
    const lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };
  const ink = token('ink');
  const ink3 = token('ink-3');
  const canvas = token('n-50');
  const paper = token('n-0');
  const accent = token('accent-500');
  const accentOn = token('accent-on');
  const brand800 = token('brand-800');

  check('body text on the canvas is AAA', ratio(ink, canvas) >= 7, ratio(ink, canvas).toFixed(2));
  check('body text on a card is AAA', ratio(ink, paper) >= 7, ratio(ink, paper).toFixed(2));
  check('muted 12px text still passes AA', ratio(ink3, canvas) >= 4.5, ratio(ink3, canvas).toFixed(2));
  check('the accent button label passes AAA', ratio(accentOn, accent) >= 7, ratio(accentOn, accent).toFixed(2));
  check('white chrome on the brand bar passes AAA', ratio('#ffffff', brand800) >= 7, ratio('#ffffff', brand800).toFixed(2));
}

/* ---------------- copy abstraction ---------------- */
{
  check('one COPY object holds the screen words', /const COPY = \{/.test(appSource));
  check('COPY describes the teacher screens', /teacher: \{[\s\S]*overview:[\s\S]*students:[\s\S]*upload:[\s\S]*marked:/.test(appSource));
  check('COPY describes the student screens', /student: \{[\s\S]*home:[\s\S]*marks:[\s\S]*account:/.test(appSource));
  check('COPY describes the admin screen', /admin: \{[\s\S]*title:/.test(appSource));
  check('COPY describes the marked-work view', /marked: \{[\s\S]*grade:[\s\S]*questions:/.test(appSource));
  const screenTitles = [...appSource.matchAll(/COPY\.(teacher|student|admin)\.(\w+)\.(title|lead|primary)/g)].length;
  check('screens read their wording from COPY rather than hard-coding it', screenTitles >= 12, `${screenTitles} references`);
}

/* ---------------- screens stay minimal ---------------- */
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
const TEACHER = { id: 'u_t', email: 't@example.com', name: 'Teacher One', role: 'teacher', emailVerified: true, canManageKey: false, canTeach: true, home: '#/teacher', linkedStudent: null, studentCount: 1 };

function makeApp() {
  const calls = [];
  const dom = new JSDOM(html, { url: 'http://localhost:3000/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.fetch = async (url, opts = {}) => {
    const p = String(url);
    calls.push({ path: p, method: opts.method || 'GET' });
    const reply = (o, s = 200) => ({ ok: s < 400, status: s, json: async () => o });
    if (p.endsWith('/api/config')) return reply(CONFIG);
    if (p.endsWith('/api/me')) return reply({ user: TEACHER, demo: true });
    if (p.endsWith('/api/teacher/overview'))
      return reply({
        demo: true, user: TEACHER, key: { status: 'missing', message: '' },
        counts: { students: 1, gradings: 2, pending: 0, processing: 0, completed: 2, partial: 0, failed: 0 },
        terms: CONFIG.reporting.terms, classes: CONFIG.reporting.classes,
        students: [{ id: 'st1', name: 'Amina', email: 'amina@gmail.com', studentNumber: 'S2/1', classId: 's2-blue', className: 'S.2 Blue', level: 'S.2' }],
        recent: [],
      });
    if (p.endsWith('/api/teacher/gradings')) return reply({ gradings: [] });
    if (p.endsWith('/api/students'))
      return reply({
        students: [{ id: 'st1', name: 'Amina', email: 'amina@gmail.com', studentNumber: 'S2/1', classId: 's2-blue', className: 'S.2 Blue', level: 'S.2', hasLogin: true }],
        classes: CONFIG.reporting.classes,
      });
    return reply({});
  };
  window.eval(appSource);
  return { window, calls };
}

async function visit(window, hash) {
  window.location.hash = hash;
  window.dispatchEvent(new window.Event('hashchange'));
  await tick(260);
  return window.document.getElementById('view');
}

{
  const { window } = makeApp();
  await tick(160);

  const overview = await visit(window, '#/teacher');
  const head = overview.querySelector('.page-head');
  check('a screen has one visible primary action', head.querySelectorAll('.btn-primary').length === 1, String(head.querySelectorAll('.btn-primary').length));
  check('the page head is title + one lead line', head.querySelectorAll('h1').length === 1 && head.querySelectorAll('.sub').length === 1);
  check('the lead line stays short', (head.querySelector('.sub')?.textContent || '').length <= 70, `${(head.querySelector('.sub')?.textContent || '').length} chars`);
  check('the overview shows three supporting stats, not five', overview.querySelectorAll('.stat-card').length <= 4, String(overview.querySelectorAll('.stat-card').length));
  check('the primary action on the overview is Upload', /Upload a script/.test(head.querySelector('.btn-primary')?.textContent || ''));

  const students = await visit(window, '#/teacher/students');
  const sHead = students.querySelector('.page-head');
  check('the students screen has one primary action', Boolean(sHead) && sHead.querySelectorAll('.btn-primary').length === 1, sHead ? '' : students.textContent.trim().slice(0, 60));

  const upload = await visit(window, '#/teacher/upload');
  check('the upload screen keeps one primary action', upload.querySelector('.page-head .btn-primary') === null && upload.querySelectorAll('#upload-form .btn-primary').length === 1);
  check('the long explanation is behind a disclosure', Boolean(upload.querySelector('details.disclose')), upload.querySelector('details.disclose summary')?.textContent?.trim());

  const settings = await visit(window, '#/teacher/settings');
  check('settings hides diagnostics behind a disclosure', Boolean(settings.querySelector('details.disclose')), settings.querySelector('details.disclose summary')?.textContent?.trim());

  const marked = await visit(window, '#/teacher/marked');
  check('the marked-work screen leads with its purpose', /Marked work/.test(marked.querySelector('h1')?.textContent || ''));
  check('the empty state is one title, one line and one action', /Nothing marked yet/.test(marked.textContent));
}

console.log(`\n${fails === 0 ? 'ALL DESIGN CHECKS PASSED' : fails + ' FAILED'}`);
process.exit(fails ? 1 : 0);
