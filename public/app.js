/* ============================================================
   VOLYX — front end
   Accounts (sign up → email code → verify → login), owner-scoped
   student management, and the report-card portal.
   ============================================================ */

const view = document.getElementById('view');
const topbar = document.getElementById('topbar');
const toastEl = document.getElementById('toast');
const modalRoot = document.getElementById('modal-root');

/* ---------------- utils ---------------- */

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const initials = (name = '') =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

/* If something breaks in the browser, tell the server so it can be explained
   later instead of guessed at. Never more than a handful of reports. */
const reportedErrors = new Set();
function reportClientError(message, stack = '', where = '') {
  try {
    const key = String(message).slice(0, 120);
    if (!key || reportedErrors.has(key) || reportedErrors.size > 15) return;
    reportedErrors.add(key);
    fetch('/api/client-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, stack, where, route: location.hash }),
      keepalive: true,
    }).catch(() => {});
  } catch { /* never let reporting throw */ }
}
window.addEventListener('error', (e) =>
  reportClientError(e.message || 'unknown error', (e.error && e.error.stack) || '', `${e.filename || ''}:${e.lineno || ''}`)
);
window.addEventListener('unhandledrejection', (e) =>
  reportClientError(
    (e.reason && e.reason.message) || String(e.reason),
    (e.reason && e.reason.stack) || '',
    'unhandled promise'
  )
);

/* ============================================================
   COPY
   ------------------------------------------------------------
   Every screen's words live here, not scattered through markup.
   A screen is described as: one title (its main purpose), one lead
   line, one primary action, and an empty state. Anything longer
   belongs behind a disclosure the user can open.
   ============================================================ */

const COPY = {
  auth: {
    title: 'Sign in',
    lead: 'Mark scripts, publish report cards, read them with your own email.',
  },
  teacher: {
    overview: {
      title: (first) => `Hello, ${first || 'there'}`,
      lead: 'Your scripts, your students, your marks.',
      primary: 'Upload a script',
    },
    students: {
      title: 'Students',
      lead: (n) =>
        n
          ? `${n} on this account. Each one has their own read-only login.`
          : 'Nobody here yet. Add a student and give them a login.',
      primary: 'Add student',
      empty: {
        title: 'No students yet',
        body: 'Add someone, or grade a script straight away with just their email.',
        cta: 'Add a student',
      },
    },
    upload: {
      title: 'Upload a script',
      lead: 'One script per upload. The marks go straight to that student’s email.',
      primary: 'Queue grading',
      help: 'How this works',
    },
    marked: {
      title: 'Marked work',
      lead: (n) =>
        n
          ? `${n} marked script${n === 1 ? '' : 's'}. Open one to see the marker’s ticks on the page.`
          : 'Nothing marked yet. Upload a script and it lands here.',
      empty: {
        title: 'Nothing marked yet',
        body: 'Upload a script and it appears here with the marker’s marks on the page.',
        cta: 'Upload a script',
      },
    },
    results: {
      title: 'Results',
      lead: 'Publish a term when the class is ready to read it.',
    },
    settings: {
      title: 'Settings',
      lead: 'Your account, your data.',
    },
  },
  admin: {
    title: 'Platform',
    lead: 'One GradeScriptUG key serves every teacher. Only this account can see it.',
  },
  student: {
    home: {
      title: 'My report cards',
      lead: 'Marks from every teacher who has your email.',
    },
    marks: {
      title: 'All my marks',
      lead: (n) => (n ? `${n} script${n === 1 ? '' : 's'} marked. Read-only.` : 'Nothing marked yet.'),
    },
    account: {
      title: 'Account',
      lead: 'Your email, your password, your logins.',
    },
  },
  marked: {
    page: 'The marked work',
    marks: (n) => `${n} mark${n === 1 ? '' : 's'} drawn`,
    grade: 'How this was graded',
    feedback: 'Marker’s feedback',
    questions: 'How each question was marked',
    highlight: 'Click a question to show its marks',
  },
};

const gradeClass = (g) => `g-${String(g || 'F').charAt(0)}`;

const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};

const store = {
  get(k, fallback = '') {
    try { return localStorage.getItem(k) ?? fallback; } catch { return fallback; }
  },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* sandboxed */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* sandboxed */ } },
};

function toast(message, isError = false) {
  toastEl.textContent = message;
  toastEl.className = `toast show${isError ? ' error' : ''}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { toastEl.className = 'toast'; }, 4200);
}

/* Emails get pasted with invisible junk far more often than you'd think. */
const cleanEmail = (v) => String(v ?? '').trim().replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '');

const readField = (id) => document.getElementById(id)?.value ?? '';

/* The auth view re-renders to show a spinner, which destroys the inputs.
   Snapshot what the user typed first, then re-render from that. */
function snapshotAuthFields() {
  state.auth.fields = {
    name: readField('name'),
    email: cleanEmail(readField('email')),
    password: readField('password'),
    code: readField('code'),
  };
  return state.auth.fields;
}

const state = {
  token: store.get('volyx.token'),
  user: null,
  config: null,
  auth: { mode: 'signin', busy: false, error: '', info: '', email: '', devCode: '', purpose: 'signup', fields: {} },
  pollTimer: null,
  overview: null,
};

/* ---------------- theme ---------------- */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  store.set('volyx.theme', theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#0c1520' : '#12161a');
  const btn = document.getElementById('theme-btn');
  if (btn) btn.textContent = theme === 'dark' ? '☀' : '☾';
}
const currentTheme = () => document.documentElement.dataset.theme || 'light';
const toggleTheme = () => applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');

/* ---------------- ui primitives ---------------- */

function mount(html) {
  view.classList.remove('page-in');
  view.innerHTML = html;
  void view.offsetWidth;
  view.classList.add('page-in');
  window.scrollTo({ top: 0 });
}

const loadingBlock = (label = 'Loading…') =>
  `<div class="loading-block"><span class="spinner dark"></span><span>${esc(label)}</span></div>`;

const skeleton = (blocks = 3) => `
  <div class="skel-wrap">
    <div class="skel skel-hero"></div>
    ${Array.from({ length: blocks }).map(() => `<div class="skel skel-row"></div>`).join('')}
  </div>`;

function openModal({ title, body, actions = [], wide = false }) {
  modalRoot.innerHTML = `
    <div class="modal-backdrop" data-close="1"></div>
    <div class="modal ${wide ? 'modal-wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="modal-head">
        <h3>${esc(title)}</h3>
        <button class="modal-x" data-close="1" aria-label="Close">✕</button>
      </div>
      <div class="modal-body">${body}</div>
      ${actions.length ? `<div class="modal-foot">${actions.map((a) => `<button class="btn ${a.class || 'btn-ghost'}" data-act="${esc(a.id)}">${esc(a.label)}</button>`).join('')}</div>` : ''}
    </div>`;
  document.body.classList.add('modal-open');

  const api = {
    close() {
      modalRoot.innerHTML = '';
      document.body.classList.remove('modal-open');
      document.removeEventListener('keydown', onKey);
    },
    on(id, fn) {
      const el = modalRoot.querySelector(`[data-act="${esc(id)}"]`);
      if (el) el.addEventListener('click', fn);
      return api;
    },
    body: modalRoot.querySelector('.modal-body'),
  };
  function onKey(e) { if (e.key === 'Escape') api.close(); }
  document.addEventListener('keydown', onKey);
  modalRoot.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', () => api.close()));
  return api;
}

function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const m = openModal({
      title,
      body: `<p class="small" style="margin:0">${esc(message)}</p>`,
      actions: [
        { id: 'cancel', label: 'Cancel', class: 'btn-ghost' },
        { id: 'ok', label: confirmLabel, class: danger ? 'btn-danger' : 'btn-primary' },
      ],
    });
    m.on('cancel', () => { m.close(); resolve(false); });
    m.on('ok', () => { m.close(); resolve(true); });
  });
}

const statusBadge = (status) => {
  const map = {
    COMPLETED: ['badge-ok', 'Graded'],
    PARTIAL: ['badge-warn', 'Partly graded'],
    FAILED: ['badge-danger', 'Failed'],
    PROCESSING: ['badge-info', 'Grading'],
    PENDING: ['badge-muted', 'Queued'],
  };
  const [cls, label] = map[status] || ['badge-muted', status];
  return `<span class="badge ${cls}">${esc(label)}</span>`;
};

/* ---------------- api ---------------- */

async function api(path, { method = 'GET', body } = {}) {
  const opts = { method, headers: {} };
  if (state.token) opts.headers['X-Session'] = state.token;
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  for (let attempt = 0; ; attempt += 1) {
    try {
      res = await fetch(path, opts);
      break;
    } catch (netErr) {
      // The server may just have restarted (or the connection dropped). One
      // quiet retry, then say plainly what happened instead of a bare
      // "Failed to fetch".
      if (attempt < 1) {
        await new Promise((r) => setTimeout(r, 600));
        continue;
      }
      const err = new Error(
        'Cannot reach the Volyx server. It may be starting up — nothing was lost, so try again in a moment.'
      );
      err.status = 0;
      err.network = true;
      throw err;
    }
  }
  let data = {};
  try { data = await res.json(); } catch { data = {}; }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/* ============================================================
   CHROME
   ============================================================ */

function navLinks() {
  const path = (location.hash || '#/').split('?')[0];
  const student = state.user?.role === 'student';
  const items = student
    ? [
        ['#/portal', 'My results'],
        ['#/portal/marks', 'My marks'],
        ['#/portal/account', 'Account'],
      ]
    : [
        ['#/teacher', 'Overview'],
        ['#/teacher/students', 'Students'],
        ['#/teacher/upload', 'Upload'],
        ['#/teacher/results', 'Results'],
        ['#/teacher/marked', 'Marked work'],
        ...(state.user?.role === 'admin' ? [['#/admin', 'Platform']] : []),
        ['#/teacher/settings', 'Settings'],
      ];

  return items
    .map(([href, label]) => {
      const active = path === href || (href !== '#/teacher' && path.startsWith(href));
      return `<a href="${href}" class="${active ? 'active' : ''}">${esc(label)}</a>`;
    })
    .join('');
}

function renderTopbar() {
  const c = state.config;
  const u = state.user;
  if (!c || !u) {
    topbar.innerHTML = '';
    topbar.classList.add('hidden');
    document.body.classList.remove('drawer-open');
    return;
  }
  topbar.classList.remove('hidden');

  topbar.innerHTML = `
    <div class="topbar-inner">
      <button class="menu-btn" id="menu-btn" aria-label="Menu">☰</button>
      <a class="brand" href="${u.role === 'student' ? '#/portal' : '#/teacher'}">
        <span class="brand-mark">V</span>
        <span class="brand-text">
          <span class="brand-name">${esc(c.platform.name)}</span>
          <span class="brand-sub">${esc(c.school.shortName || c.school.name)}</span>
        </span>
      </a>
      <nav class="nav">${navLinks()}</nav>
      <div class="userchip">
        <button class="btn-icon theme-btn" id="theme-btn" title="Toggle theme" aria-label="Toggle dark mode">${currentTheme() === 'dark' ? '☀' : '☾'}</button>
        <div class="avatar">${esc(initials(u.name || u.email))}</div>
        <span class="who">
          ${esc((u.name || u.email).split(' ')[0])}
          <strong>${u.role === 'student' ? 'Student' : u.role === 'admin' ? 'Administrator' : esc(u.studentCount === 1 ? '1 student' : `${u.studentCount || 0} students`)}</strong>
        </span>
        <button class="btn-icon" id="logout">Sign out</button>
      </div>
    </div>
    <div class="drawer" id="drawer">
      <nav class="drawer-nav">${navLinks()}</nav>
      <div class="drawer-user">
        <span class="avatar">${esc(initials(u.name || u.email))}</span>
        <div>
          <strong>${esc(u.name || 'Account')}</strong>
          <div class="small muted">${esc(u.email)}</div>
        </div>
      </div>
    </div>`;

  document.getElementById('theme-btn').addEventListener('click', toggleTheme);
  document.getElementById('logout').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    state.user = null;
    state.token = '';
    store.del('volyx.token');
    state.overview = null;
    state.auth = { mode: 'signin', busy: false, error: '', info: '', email: '', devCode: '', purpose: 'signup', fields: {} };
    location.hash = '#/auth';
    renderTopbar();
    route();
  });
  document.getElementById('menu-btn').addEventListener('click', () => document.body.classList.toggle('drawer-open'));
  document.getElementById('drawer').querySelectorAll('a').forEach((a) =>
    a.addEventListener('click', () => document.body.classList.remove('drawer-open'))
  );
}

/* ============================================================
   ROUTER
   ============================================================ */

const routes = () => (location.hash || '#/').replace(/^#/, '').split('?')[0].split('/').filter(Boolean);

async function route() {
  clearTimeout(state.pollTimer);
  document.body.classList.remove('drawer-open');
  if (!state.config) return;

  const parts = routes();
  const loggedIn = Boolean(state.user);
  const role = state.user?.role === 'student' ? 'student' : 'guardian';
  const home = role === 'student' ? '#/portal' : '#/teacher';

  if (!loggedIn && parts[0] !== 'auth') { location.hash = '#/auth'; return; }
  if (loggedIn && (parts.length === 0 || parts[0] === 'auth')) { location.hash = home; return; }

  /* Session isolation: a student session can only reach portal routes, and a
     guardian session can never render the portal. */
  if (loggedIn && role === 'student' && parts[0] !== 'portal') { location.hash = '#/portal'; return; }
  if (loggedIn && role !== 'student' && parts[0] === 'portal') { location.hash = '#/teacher'; return; }
  // Legacy links from the old single-role portal.
  if (loggedIn && (parts[0] === 'home' || parts[0] === 'report')) {
    location.hash = parts[0] === 'report' && parts[1]
      ? `#/portal/report/${encodeURIComponent(decodeURIComponent(parts[1]))}`
      : '#/portal';
    return;
  }

  renderTopbar();

  try {
    if (parts[0] === 'auth') return renderAuth();
    if (parts[0] === 'portal') {
      if (parts[1] === 'marks') return await renderPortalMarks();
      if (parts[1] === 'account') return await renderPortalAccount();
      if (parts[1] === 'report' && parts[2]) return await renderPortalReport(decodeURIComponent(parts[2]));
      if (parts[1] === 'result' && parts[2]) return await renderMarkedScript('student', decodeURIComponent(parts[2]));
      return await renderPortalHome();
    }
    if (parts[0] === 'admin') return await renderAdminPlatform();
    if (parts[0] === 'teacher') {
      if (parts[1] === 'students') return await renderStudents();
      if (parts[1] === 'upload') return await renderTeacherUpload();
      if (parts[1] === 'results') return await renderTeacherResults();
      if (parts[1] === 'marked') return await renderMarkedList();
      if (parts[1] === 'settings') return await renderTeacherSettings();
      if (parts[1] === 'grading' && parts[2]) return await renderMarkedScript('teacher', decodeURIComponent(parts[2]));
      if (parts[1] === 'report' && parts[2])
        return await renderTeacherReport(
          decodeURIComponent(parts[2]),
          decodeURIComponent(parts[3] || state.config.reporting.currentTerm)
        );
      return await renderTeacherOverview();
    }
    location.hash = loggedIn ? home : '#/auth';
  } catch (err) {
    if (err.status === 401) {
      state.user = null;
      state.token = '';
      store.del('volyx.token');
      location.hash = '#/auth';
      return;
    }
    mount(`
      <div class="card card-pad empty" style="max-width:520px;margin:3rem auto">
        <div class="big">⚠️</div>
        <h2 style="font-size:1rem;margin-bottom:.35rem">That didn't load</h2>
        <p class="small muted">${esc(err.message)}</p>
        <a class="btn btn-primary btn-sm" href="#/">Try again</a>
      </div>`);
  }
}

/* ============================================================
   AUTH
   ============================================================ */

let gsiPromise = null;
function loadGis() {
  if (window.google?.accounts?.id) return Promise.resolve();
  if (gsiPromise) return gsiPromise;
  gsiPromise = new Promise((resolve, reject) => {
    const done = () => resolve();
    const fail = () => reject(new Error('Google sign-in could not load on this page.'));
    const existing = document.querySelector('script[data-gsi]');
    if (existing) {
      existing.addEventListener('load', done);
      existing.addEventListener('error', fail);
      return;
    }
    const sc = document.createElement('script');
    sc.src = 'https://accounts.google.com/gsi/client';
    sc.async = true;
    sc.defer = true;
    sc.dataset.gsi = '1';
    sc.onload = done;
    sc.onerror = fail;
    document.head.appendChild(sc);
  });
  return gsiPromise;
}

function onLoggedIn(res) {
  state.token = res.token || '';
  store.set('volyx.token', state.token);
  state.user = res.user;
  state.auth = { mode: 'signin', busy: false, error: '', info: '', email: '', devCode: '', purpose: 'signup', fields: {} };
  state.overview = null;
  // Role-based landing: students to the portal, guardians to the console.
  const home = res.home || state.user?.home || (state.user?.role === 'student' ? '#/portal' : '#/teacher');
  location.hash = home;
  if (state.user) state.user.home = home;
  renderTopbar();
  route();
}

const pickedAccountType = () =>
  document.querySelector('input[name="accountType"]:checked')?.value ||
  state.auth?.fields?.accountType ||
  'teacher';

async function handleGoogleCredential(response) {
  const a = state.auth;
  /* Google has no sign-up form, so the role chosen on the form rides along. */
  const accountType = a?.fields?.accountType || pickedAccountType() || 'teacher';
  a.busy = true;
  a.error = '';
  renderAuth();
  try {
    onLoggedIn(await api('/api/auth/google', { method: 'POST', body: { credential: response.credential, accountType } }));
  } catch (err) {
    a.busy = false;
    a.error = err.message;
    renderAuth();
  }
}

async function mountGoogleButton() {
  const slot = document.getElementById('gsi-slot');
  if (!slot) return;
  const clientId = state.config.googleClientId;
  if (!clientId) {
    slot.innerHTML = '';
    return;
  }
  try {
    await loadGis();
    google.accounts.id.initialize({
      client_id: clientId,
      callback: handleGoogleCredential,
      auto_select: false,
      cancel_on_tap_outside: true,
    });
    slot.innerHTML = '';
    google.accounts.id.renderButton(slot, {
      type: 'standard',
      theme: currentTheme() === 'dark' ? 'filled_black' : 'outline',
      size: 'large',
      text: 'continue_with',
      shape: 'pill',
      logo_alignment: 'left',
      width: 320,
    });
  } catch {
    slot.innerHTML = `<div class="notice notice-warn small">Google sign-in could not load here. Use email and password.</div>`;
  }
}

function authForm() {
  const a = state.auth;
  const c = state.config;

  if (a.mode === 'signup') {
    return `
      <form id="signup-form" novalidate>
        <div class="field">
          <label>I'm signing up as</label>
          <div class="role-picker" id="role-picker">
            <label class="role-option ${(a.fields?.accountType || 'teacher') === 'teacher' ? 'selected' : ''}">
              <input type="radio" name="accountType" value="teacher" ${(a.fields?.accountType || 'teacher') === 'teacher' ? 'checked' : ''} />
              <span class="role-emoji">🧑‍🏫</span>
              <span class="role-text"><strong>Teacher</strong><small>Grade scripts, manage students, publish results</small></span>
            </label>
            <label class="role-option ${a.fields?.accountType === 'student' ? 'selected' : ''}">
              <input type="radio" name="accountType" value="student" ${a.fields?.accountType === 'student' ? 'checked' : ''} />
              <span class="role-emoji">🎓</span>
              <span class="role-text"><strong>Student</strong><small>See the work any teacher marked for your email</small></span>
            </label>
          </div>
        </div>
        <div class="field">
          <label for="name">Your name</label>
          <input id="name" type="text" autocomplete="name" placeholder="Robert Wamala"
                 value="${esc(a.fields?.name || '')}" required />
        </div>
        <div class="field">
          <label for="email">Email address</label>
          <input id="email" type="email" autocomplete="email" inputmode="email"
                 autocapitalize="none" autocorrect="off" spellcheck="false"
                 placeholder="you@example.com" value="${esc(a.fields?.email || '')}" required />
          <div class="hint" id="email-hint">Use the address your teachers have on file for your work.</div>
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input id="password" type="password" autocomplete="new-password" placeholder="At least 8 characters"
                 value="${esc(a.fields?.password || '')}" required />
          <div class="hint">Mix letters and numbers. You'll verify your email next.</div>
        </div>
        ${a.error ? `<div class="notice notice-danger">${esc(a.error)}</div>` : ''}
        <button class="btn btn-primary btn-block" type="submit" ${a.busy ? 'disabled' : ''}>
          ${a.busy ? '<span class="spinner"></span> Creating account…' : 'Create account'}
        </button>
      </form>
      <div class="login-switch">Already have an account? <button data-mode="signin">Sign in</button></div>`;
  }

  if (a.mode === 'verify') {
    return `
      <form id="verify-form" novalidate>
        ${a.devCode ? `<div class="code-display">${esc(a.devCode)}</div>` : ''}
        <div class="field">
          <label for="code">6-digit verification code</label>
          <input id="code" class="code-input" type="text" inputmode="numeric" maxlength="6" placeholder="••••••"
                 autocomplete="one-time-code" value="${esc(a.fields?.code || '')}" required />
          <div class="hint">
            Sent to <span class="mono">${esc(a.email)}</span> · valid for 15 minutes.
            ${c.devCodes ? '<br>No mail server is configured, so the code is shown above and in the server log.' : ''}
          </div>
        </div>
        ${a.error ? `<div class="notice notice-danger">${esc(a.error)}</div>` : ''}
        <button class="btn btn-primary btn-block" type="submit" ${a.busy ? 'disabled' : ''}>
          ${a.busy ? '<span class="spinner"></span> Verifying…' : 'Verify and continue'}
        </button>
      </form>
      <div class="login-switch"><button id="resend">Resend the code</button> · <button data-mode="signin">Use another account</button></div>`;
  }

  if (a.mode === 'forgot' || a.mode === 'reset') {
    if (a.mode === 'forgot') {
      return `
        <form id="forgot-form" novalidate>
          <div class="field">
            <label for="email">Email address</label>
            <input id="email" type="email" autocomplete="email" inputmode="email"
                   autocapitalize="none" autocorrect="off" spellcheck="false"
                   placeholder="you@example.com" value="${esc(a.fields?.email || a.email || '')}" required />
            <div class="hint">We'll send a 6-digit code to reset your password.</div>
          </div>
          ${a.error ? `<div class="notice notice-danger">${esc(a.error)}</div>` : ''}
          <button class="btn btn-primary btn-block" type="submit" ${a.busy ? 'disabled' : ''}>
            ${a.busy ? '<span class="spinner"></span> Sending…' : 'Send reset code'}
          </button>
        </form>
        <div class="login-switch"><button data-mode="signin">Back to sign in</button></div>`;
    }
    return `
      <form id="reset-form" novalidate>
        ${a.devCode ? `<div class="code-display">${esc(a.devCode)}</div>` : ''}
        <div class="field">
          <label for="code">Reset code</label>
          <input id="code" class="code-input" type="text" inputmode="numeric" maxlength="6" placeholder="••••••"
                 value="${esc(a.fields?.code || '')}" required />
        </div>
        <div class="field">
          <label for="password">New password</label>
          <input id="password" type="password" autocomplete="new-password" placeholder="At least 8 characters"
                 value="${esc(a.fields?.password || '')}" required />
        </div>
        ${a.error ? `<div class="notice notice-danger">${esc(a.error)}</div>` : ''}
        <button class="btn btn-primary btn-block" type="submit" ${a.busy ? 'disabled' : ''}>
          ${a.busy ? '<span class="spinner"></span> Saving…' : 'Set new password'}
        </button>
      </form>
      <div class="login-switch"><button data-mode="signin">Back to sign in</button></div>`;
  }

  if (a.mode === 'code') {
    return `
      <form id="request-code-form" novalidate>
        <div class="field">
          <label for="email">Email address</label>
          <input id="email" type="email" autocomplete="email" inputmode="email"
                 autocapitalize="none" autocorrect="off" spellcheck="false"
                 placeholder="you@example.com" value="${esc(a.fields?.email || a.email || '')}" required />
          <div class="hint">We'll email you a 6-digit code — no password needed.</div>
        </div>
        ${a.error ? `<div class="notice notice-danger">${esc(a.error)}</div>` : ''}
        <button class="btn btn-primary btn-block" type="submit" ${a.busy ? 'disabled' : ''}>
          ${a.busy ? '<span class="spinner"></span> Sending code…' : 'Email me a code'}
        </button>
      </form>
      <div class="login-switch"><button data-mode="signin">Use my password instead</button></div>`;
  }

  return `
    <form id="signin-form" novalidate>
      <div class="field">
        <label for="email">Email address</label>
        <input id="email" type="email" autocomplete="email" inputmode="email"
               autocapitalize="none" autocorrect="off" spellcheck="false"
               placeholder="you@example.com" value="${esc(a.fields?.email || a.email || '')}" required />
      </div>
      <div class="field">
        <label for="password">Password</label>
        <input id="password" type="password" autocomplete="current-password" placeholder="Your password"
               value="${esc(a.fields?.password || '')}" required />
        <div class="hint" style="display:flex;justify-content:space-between">
          <button type="button" class="linkish" data-mode="code" style="font-size:.8125rem">Email me a code instead</button>
          <button type="button" class="linkish" data-mode="forgot" style="font-size:.8125rem">Forgot password?</button>
        </div>
      </div>
      ${a.error ? `<div class="notice notice-danger">${esc(a.error)}</div>` : ''}
      <button class="btn btn-primary btn-block" type="submit" ${a.busy ? 'disabled' : ''}>
        ${a.busy ? '<span class="spinner"></span> Signing in…' : 'Sign in'}
      </button>
    </form>
    <div class="login-switch">New here? <button data-mode="signup">Create an account</button></div>`;
}

function renderAuth() {
  const c = state.config;
  const a = state.auth;
  view.className = 'view login-view';

  const headings = {
    signin: ['Sign in', 'Welcome back. Your students are where you left them.'],
    code: ['Sign in with a code', 'Enter your email and we’ll send you a 6-digit code.'],
    signup: ['Create an account', 'Verify your email, then start registering your students.'],
    verify: a.purpose === 'login'
      ? ['Check your email', 'Enter the 6-digit code to sign in.']
      : ['Verify your email', 'Enter the code we sent you to activate the account.'],
    forgot: ['Reset your password', 'We’ll email you a 6-digit code.'],
    reset: ['Choose a new password', 'Enter the code and pick something new.'],
  };
  const [title, lead] = headings[a.mode] || headings.signin;

  const googleBlock =
    a.mode === 'signin' || a.mode === 'signup' || a.mode === 'code'
      ? `<div id="gsi-slot" class="gsi-slot"></div>
         ${c.googleClientId ? '<div class="divider"><span>or use email and password</span></div>' : ''}`
      : '';

  const demoBox =
    c.demo && a.mode === 'signin'
      ? `<div class="demo-note">
           <strong>Demo account</strong>
           <span class="mono">robert.wamala@gmail.com</span> · password <span class="mono">volyx1234</span>
           — <button type="button" class="linkish" data-fill-demo="1">fill it in</button>
         </div>`
      : '';

  mount(`
    <div class="login-wrap">
      <section class="login-hero">
        <div class="hero-mark">V</div>
        <div class="eyebrow">${esc(c.platform.tagline)}</div>
        <h1>Your marks,<br/>turned into a report card.</h1>
        <p>${esc(c.platform.description)}</p>
        <ul class="hero-points">
          <li><span class="dot">1</span><span>Create an account and verify your email.</span></li>
          <li><span class="dot">2</span><span>Register your own students — nobody else sees them.</span></li>
          <li><span class="dot">3</span><span>Upload scripts, publish results, students sign in to read them.</span></li>
        </ul>
      </section>
      <section class="card login-card">
        <div class="login-brand">
          <span class="brand-mark">V</span>
          <div>
            <div class="brand-name">${esc(c.platform.name)}</div>
            <div class="brand-sub">${esc(c.school.name)}</div>
          </div>
        </div>
        <h2>${esc(title)}</h2>
        <p class="lead">${esc(lead)}</p>
        ${demoBox}
        ${googleBlock}
        ${authForm()}
      </section>
    </div>`);

  if (a.mode === 'signin' || a.mode === 'signup' || a.mode === 'code') mountGoogleButton();

  if (a.mode === 'signup') {
    const hint = document.getElementById('email-hint');
    document.querySelectorAll('input[name="accountType"]').forEach((radio) =>
      radio.addEventListener('change', () => {
        state.auth.fields = { ...(state.auth.fields || {}), accountType: radio.value };
        hint.textContent =
          radio.value === 'student'
            ? 'Any teacher who was given this email can mark your work — it appears here automatically.'
            : 'Your own login. Students are matched by the email you attach to their scripts.';
      })
    );
  }

  view.querySelectorAll('[data-mode]').forEach((b) =>
    b.addEventListener('click', () => {
      state.auth = { ...state.auth, mode: b.dataset.mode, error: '', info: '', devCode: '', busy: false };
      renderAuth();
    })
  );

  const fillDemo = view.querySelector('[data-fill-demo]');
  if (fillDemo)
    fillDemo.addEventListener('click', () => {
      document.getElementById('email').value = 'robert.wamala@gmail.com';
      document.getElementById('password').value = 'volyx1234';
    });

  const signup = document.getElementById('signup-form');
  if (signup)
    signup.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fields = snapshotAuthFields();   // before re-render wipes the inputs
      const picked = document.querySelector('input[name="accountType"]:checked')?.value || 'teacher';
      a.busy = true;
      a.error = '';
      renderAuth();
      try {
        const res = await api('/api/auth/signup', {
          method: 'POST',
          body: {
            name: fields.name.trim(),
            email: fields.email,
            password: fields.password,
            accountType: picked,
          },
        });
        state.auth = { ...a, mode: 'verify', purpose: 'signup', busy: false, error: '', email: res.email, devCode: res.delivery?.devCode || '', info: res.message };
        renderAuth();
      } catch (err) {
        state.auth = { ...a, busy: false, error: err.message };
        renderAuth();
      }
    });

  const verify = document.getElementById('verify-form');
  if (verify)
    verify.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fields = snapshotAuthFields();
      a.busy = true;
      a.error = '';
      renderAuth();
      try {
        const code = fields.code.trim();
        // Signup uses the verification endpoint; "Email me a code" uses the
        // code-login endpoint. Both live on this server, not the old URLs.
        const endpoint = a.purpose === 'login' ? '/api/auth/verify-code' : '/api/auth/verify-email';
        onLoggedIn(await api(endpoint, { method: 'POST', body: { email: a.email, code } }));
      } catch (err) {
        state.auth = { ...a, busy: false, error: err.message };
        renderAuth();
      }
    });

  const resend = document.getElementById('resend');
  if (resend)
    resend.addEventListener('click', async () => {
      try {
        const res = await api('/api/auth/request-code', { method: 'POST', body: { email: a.email } });
        state.auth = { ...a, devCode: res.delivery?.devCode || '', error: '', info: res.message };
        renderAuth();
        toast('New code sent.');
      } catch (err) {
        toast(err.message, true);
      }
    });

  const requestCode = document.getElementById('request-code-form');
  if (requestCode)
    requestCode.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fields = snapshotAuthFields();
      a.busy = true;
      a.error = '';
      a.email = fields.email;
      renderAuth();
      try {
        const res = await api('/api/auth/request-code', { method: 'POST', body: { email: fields.email } });
        state.auth = {
          ...a,
          mode: 'verify',
          purpose: res.purpose || 'login',
          busy: false,
          error: '',
          devCode: res.delivery?.devCode || '',
          info: res.message,
        };
        renderAuth();
        if (!res.delivery?.devCode) toast('Code sent — check your inbox.');
      } catch (err) {
        // No account for that email → offer to create one with it prefilled.
        state.auth = { ...a, busy: false, error: err.message };
        renderAuth();
        if (err.data?.code === 'no-account') {
          setTimeout(() => {
            const link = document.createElement('button');
            link.className = 'linkish';
            link.textContent = ' Create one with this email →';
            link.addEventListener('click', () => {
              state.auth = { ...state.auth, mode: 'signup', error: '' };
              renderAuth();
              const emailInput = document.getElementById('email');
              if (emailInput) emailInput.value = a.email;
            });
            document.querySelector('#request-code-form + .login-switch')?.prepend(link);
          }, 0);
        }
      }
    });

  const signin = document.getElementById('signin-form');
  if (signin)
    signin.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fields = snapshotAuthFields();
      a.busy = true;
      a.error = '';
      a.email = fields.email;
      renderAuth();
      try {
        onLoggedIn(await api('/api/auth/login', {
          method: 'POST',
          body: { email: fields.email, password: fields.password },
        }));
      } catch (err) {
        if (err.data?.needsVerification) {
          state.auth = { ...a, mode: 'verify', purpose: 'signup', busy: false, error: '', email: err.data.email || a.email, devCode: '' };
          renderAuth();
          toast('Verify your email to continue.', true);
        } else {
          state.auth = { ...a, busy: false, error: err.message };
          renderAuth();
        }
      }
    });

  const forgot = document.getElementById('forgot-form');
  if (forgot)
    forgot.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fields = snapshotAuthFields();
      a.busy = true;
      a.error = '';
      a.email = fields.email;
      renderAuth();
      try {
        const res = await api('/api/auth/forgot', { method: 'POST', body: { email: fields.email } });
        state.auth = { ...a, mode: 'reset', busy: false, devCode: res.delivery?.devCode || '', info: res.message, error: '' };
        renderAuth();
      } catch (err) {
        state.auth = { ...a, busy: false, error: err.message };
        renderAuth();
      }
    });

  const reset = document.getElementById('reset-form');
  if (reset)
    reset.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fields = snapshotAuthFields();
      a.busy = true;
      a.error = '';
      renderAuth();
      try {
        onLoggedIn(await api('/api/auth/reset', {
          method: 'POST',
          body: {
            email: fields.email || a.email,
            code: fields.code.trim(),
            password: fields.password,
          },
        }));
      } catch (err) {
        state.auth = { ...a, busy: false, error: err.message };
        renderAuth();
      }
    });

  const focusId = a.mode === 'verify' || a.mode === 'reset' ? 'code' : 'email';
  const focusEl = document.getElementById(focusId);
  if (focusEl) setTimeout(() => focusEl.focus(), 60);
}

/* ============================================================
   STUDENT PORTAL
   ============================================================ */

function gradeLetter(percent, scale) {
  const band = (scale || []).find((b) => percent >= b.min && percent <= b.max);
  return band ? band.grade : '—';
}

function sparkline(terms) {
  const pts = [...terms].reverse().filter((t) => Number.isFinite(t.average));
  if (pts.length < 2) return '';
  const w = 220, h = 56, pad = 8;
  const x = (i) => pad + (i * (w - pad * 2)) / (pts.length - 1);
  const y = (v) => h - pad - (Math.max(0, Math.min(100, v)) / 100) * (h - pad * 2);
  const points = pts.map((t, i) => `${x(i).toFixed(1)},${y(t.average).toFixed(1)}`).join(' ');
  const dots = pts.map((t, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(t.average).toFixed(1)}" r="2.6" fill="var(--gold-300)"><title>${esc(t.name)}: ${t.average}%</title></circle>`).join('');
  const first = pts[0], last = pts[pts.length - 1];
  const delta = Math.round((last.average - first.average) * 10) / 10;
  return `
    <div class="spark">
      <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
        <polyline points="${points}" fill="none" stroke="rgba(232,195,122,.85)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        ${dots}
      </svg>
      <div class="spark-legend">
        <span>${esc(first.name)} → ${esc(last.name)}</span>
        <span class="${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta)} pts</span>
      </div>
    </div>`;
}

/* ============================================================
   STUDENT PORTAL — read-only, own data only
   Everything here is rendered from /api/student/* which is
   student-role gated. There are no edit affordances by design.
   ============================================================ */

function portalTabs(active) {
  const tabs = [
    ['#/portal', 'Overview'],
    ['#/portal/marks', 'My marks'],
    ['#/portal/account', 'Account'],
  ];
  return `<div class="tabs">${tabs
    .map(([href, label]) => `<a href="${href}" class="${active === href ? 'active' : ''}">${esc(label)}</a>`)
    .join('')}</div>`;
}

const readOnlyChip = () =>
  `<span class="chip chip-ro" title="Student accounts are read-only">🔒 Read-only</span>`;

function portalHero({ student, teachers = [], right = '' }) {
  const bits = [];
  if (student.className) bits.push(esc(student.className));
  if (student.studentNumber) bits.push(`Student No. ${esc(student.studentNumber)}`);
  if (teachers.length)
    bits.push(`marked by ${teachers.length > 1 ? `${teachers.length} teachers` : esc(teachers[0].name)}`);

  return `
    <section class="hello">
      <div>
        <div class="eyebrow">Student portal ${readOnlyChip()}</div>
        <h1>Hello, ${esc(String(student.name).split(' ')[0])}</h1>
        <p>${bits.join(' · ')}</p>
      </div>
      ${right}
    </section>`;
}

async function renderPortalHome() {
  view.className = 'view';
  mount(skeleton(3));
  const [me, termData, markData] = await Promise.all([
    api('/api/student/me'),
    api('/api/student/terms'),
    api('/api/student/assessments'),
  ]);
  const c = state.config;
  const latest = termData.terms[0];
  const marks = markData.assessments || [];
  const avg = marks.length
    ? Math.round((marks.reduce((n, m) => n + m.percent, 0) / marks.length) * 10) / 10
    : null;

  const termCards = termData.terms.length
    ? termData.terms
        .map((t) => {
          const grade = gradeLetter(t.average, c.scale);
          return `
        <a class="card term-card" href="#/portal/report/${encodeURIComponent(t.id)}">
          <div class="term-main">
            <div class="term-name">${esc(t.name)} ${esc(t.year)}</div>
            <div class="meta">${t.subjects} subjects · ${t.assessments} scripts graded · term ends ${esc(fmtDate(t.ends))}</div>
          </div>
          <div class="avg">
            <div class="num">${t.average}<small>%</small></div>
            <span class="grade-pill ${gradeClass(grade)}">${esc(grade)}</span>
            <span class="go">Open report <span class="arrow">→</span></span>
          </div>
        </a>`;
        })
        .join('')
    : `<div class="card empty">
         <div class="big">📄</div>
         <h3 style="font-size:1rem;margin-bottom:.3rem">No published results yet</h3>
         <p class="small">Your report appears here once your guardian has marked the scripts and published the term.</p>
       </div>`;

  const recent = marks.slice(0, 5);
  const recentRows = recent.length
    ? recent
        .map(
          (m) => `
      <tr class="row-link">
        <td><strong>${esc(m.subject)}</strong><div class="muted small">${esc(m.assessmentType)}</div></td>
        <td class="muted small hide-sm">${esc(m.teacher || '')}</td>
        <td class="muted small hide-sm">${esc(m.termName)}</td>
        <td class="num mono">${m.totalMark}/${m.maximumMark}</td>
        <td class="num mono">${m.percent}%</td>
        <td><span class="grade-pill ${gradeClass(m.grade)}">${esc(m.grade)}</span>
          <a class="btn btn-ghost btn-sm" href="#/portal/result/${encodeURIComponent(m.id)}">See the marked work</a></td>
      </tr>`
        )
        .join('')
    : `<tr><td colspan="6" class="muted small" style="padding:1.4rem;text-align:center">No marks yet.</td></tr>`;

  mount(`
    ${portalHero({
      student: me.student,
      teachers: me.teachers || [],
      right: `<div class="stats">
        <div class="stat"><div class="n">${avg !== null ? avg + '%' : '—'}</div><div class="l">Average</div></div>
        <div class="stat"><div class="n">${termData.terms.length}</div><div class="l">Report cards</div></div>
        <div class="stat"><div class="n">${marks.length}</div><div class="l">Scripts marked</div></div>
      </div>`,
    })}
    ${portalTabs('#/portal')}

    ${me.mustChangePassword ? `
      <div class="notice notice-warn" style="display:flex;gap:.8rem;align-items:center;flex-wrap:wrap">
        <span>You're still using the temporary password your guardian gave you.</span>
        <a class="btn btn-primary btn-sm" href="#/portal/account">Choose your own password</a>
      </div>` : ''}

    <div class="page-head">
      <div>
        <h1>${esc(COPY.student.home.title)}</h1>
        <p class="sub">${esc(COPY.student.home.lead)}</p>
      </div>
      <div class="spacer"></div>
      <input class="search" id="term-search" placeholder="Filter terms…" aria-label="Filter terms" />
    </div>
    <div class="term-list" id="term-list">${termCards}</div>

    <div class="card" style="margin-top:1.4rem">
      <div class="card-head">
        <h2>Recent marks</h2>
        <a class="btn btn-ghost btn-sm" href="#/portal/marks">All marks</a>
      </div>
      <div class="table-scroll">
        <table class="data">
          <thead><tr><th>Subject</th><th class="hide-sm">Marked by</th><th class="hide-sm">Term</th><th class="right">Score</th><th class="right">%</th><th>Grade</th></tr></thead>
          <tbody>${recentRows}</tbody>
        </table>
      </div>
    </div>

    <p class="portal-foot">
      ${esc(c.platform.name)} · ${esc(c.school.name)} — you can view your results but not change them.
    </p>`);

  const search = document.getElementById('term-search');
  if (search)
    search.addEventListener('input', () => {
      const q = search.value.toLowerCase();
      document.querySelectorAll('#term-list .term-card').forEach((el) => {
        el.style.display = el.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    });
}

async function renderPortalMarks() {
  view.className = 'view';
  mount(skeleton(3));
  const [me, markData] = await Promise.all([api('/api/student/me'), api('/api/student/results')]);
  const marks = markData.results || [];

  const rows = marks.length
    ? marks
        .map(
          (m) => `
      <tr>
        <td><strong>${esc(m.subject)}</strong><div class="muted small">${esc(m.assessmentType)}</div></td>
        <td class="muted small hide-sm">${esc(m.teacher || '')}</td>
        <td class="muted small hide-sm">${esc(m.termName)}</td>
        <td class="num mono">${m.totalMark}/${m.maximumMark}</td>
        <td class="num mono">${m.percent}%</td>
        <td><span class="grade-pill ${gradeClass(m.grade)}">${esc(m.grade)}</span></td>
        <td class="muted small nowrap hide-sm">${esc(fmtDate(m.gradedAt))}</td>
        <td class="actions"><a class="btn btn-ghost btn-sm" href="#/portal/result/${encodeURIComponent(m.id)}">Marked work</a></td>
      </tr>`
        )
        .join('')
    : `<tr><td colspan="8" class="muted small" style="padding:2rem;text-align:center">No marks yet. Work appears here as soon as any teacher marks a script with your email on it.</td></tr>`;

  mount(`
    ${portalHero({ student: me.student, teachers: me.teachers || [] })}
    ${portalTabs('#/portal/marks')}
    <div class="page-head">
      <div>
        <h1>${esc(COPY.student.marks.title)}</h1>
        <p class="sub">${marks.length} script${marks.length === 1 ? '' : 's'} marked${me.teachers?.length ? ` by ${me.teachers.length} teacher${me.teachers.length === 1 ? '' : 's'}` : ''}. Read-only.</p>
      </div>
      <div class="spacer"></div>
      <input class="search" id="mark-search" placeholder="Search subject…" aria-label="Search marks" />
    </div>
    <div class="card">
      <div class="table-scroll">
        <table class="data" id="marks-table">
          <thead><tr>
            <th>Subject</th><th class="hide-sm">Marked by</th><th class="hide-sm">Term</th><th class="right">Score</th>
            <th class="right">%</th><th>Grade</th><th class="hide-sm">Marked</th><th></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`);

  const search = document.getElementById('mark-search');
  if (search)
    search.addEventListener('input', () => {
      const q = search.value.toLowerCase();
      document.querySelectorAll('#marks-table tbody tr').forEach((tr) => {
        tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    });
}

async function renderPortalReport(termId) {
  view.className = 'view';
  mount(skeleton(4));
  const card = await api(`/api/student/report/${encodeURIComponent(termId)}`);
  mount(`
    <div class="report-toolbar">
      <a class="btn btn-ghost btn-sm" href="#/portal">← All reports</a>
      <span class="badge badge-ok">Published</span>
      ${readOnlyChip()}
      <div class="spacer"></div>
      <button class="btn btn-ghost btn-sm" id="copy-link">Copy link</button>
      <button class="btn btn-primary btn-sm" id="print-btn">Print / save as PDF</button>
    </div>
    ${reportCardHTML(card)}
    ${markingDetailHTML(card)}`);

  document.getElementById('print-btn').addEventListener('click', () => window.print());
  document.getElementById('copy-link').addEventListener('click', async () => {
    await copyText(location.href, 'Link copied.');
  });
}

async function renderPortalAccount() {
  view.className = 'view';
  mount(skeleton(2));
  const me = await api('/api/student/me');

  mount(`
    ${portalHero({ student: me.student, teachers: me.teachers || [] })}
    ${portalTabs('#/portal/account')}

    <div class="grid grid-2" style="align-items:start">
      <div class="card card-pad">
        <h2 style="font-size:1rem;margin-bottom:.8rem">Your account</h2>
        <div class="kv"><span>Sign-in address</span><strong class="mono">${esc(state.user.email)}</strong></div>
        <div class="kv"><span>Role</span><strong>Student (read-only)</strong></div>
        <div class="kv"><span>Student number</span><strong>${esc(me.student.studentNumber)}</strong></div>
        <div class="kv"><span>Class</span><strong>${esc(me.student.className)}</strong></div>
        <div class="kv"><span>Marked by</span><strong>${me.teachers?.length ? esc(me.teachers.map((t) => t.name).join(', ')) : 'No teachers yet'}</strong></div>
        <p class="small muted" style="margin-top:.9rem">
          Any teacher who was given this email can mark your work — it all appears here.
          Student accounts are read-only, so ask your teacher to correct a name or class.
        </p>
      </div>

      <div class="card card-pad">
        <h2 style="font-size:1rem;margin-bottom:.8rem">${me.mustChangePassword ? 'Replace your temporary password' : 'Change your password'}</h2>
        ${me.mustChangePassword
          ? `<div class="notice notice-warn small" style="margin-bottom:.9rem">You're using the password your guardian shared with you. Choose your own.</div>`
          : ''}
        <form id="pw-form">
          <div class="field">
            <label for="cur-pw">Current password</label>
            <input id="cur-pw" type="password" autocomplete="current-password" placeholder="Your current password" required />
          </div>
          <div class="field">
            <label for="new-pw">New password</label>
            <input id="new-pw" type="password" autocomplete="new-password" placeholder="At least 8 characters" required />
          </div>
          <div id="pw-error"></div>
          <button class="btn btn-primary btn-sm" type="submit">Update password</button>
        </form>
      </div>
    </div>`);

  const form = document.getElementById('pw-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const currentPassword = document.getElementById('cur-pw').value;
    const newPassword = document.getElementById('new-pw').value;
    const errBox = document.getElementById('pw-error');
    errBox.innerHTML = '';
    try {
      const res = await api('/api/auth/change-password', { method: 'POST', body: { currentPassword, newPassword } });
      state.user = { ...state.user, ...res.user };
      renderTopbar();
      toast('Password updated.');
      renderPortalAccount();
    } catch (err) {
      errBox.innerHTML = `<div class="notice notice-danger small" style="margin:0 0 .8rem">${esc(err.message)}</div>`;
    }
  });
}

/* ---------------- copy helper ---------------- */

async function copyText(text, message = 'Copied.') {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast(message);
  } catch {
    toast('Could not copy — select the text instead.', true);
  }
}

/* ---------------- marked work list ---------------- */

async function renderMarkedList() {
  view.className = 'view';
  mount(skeleton(3));
  const data = await api('/api/teacher/gradings');
  const list = (data.gradings || []).slice().sort(
    (a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt))
  );
  const ready = list.filter((g) => g.status === 'COMPLETED' || g.status === 'PARTIAL');
  const withPages = list.filter((g) => g.keptPages > 0).length;

  const rows = list.length
    ? list
        .map(
          (g) => `
      <tr class="row-link" data-open="${esc(g.id)}" tabindex="0">
        <td><strong>${esc(g.studentName)}</strong><div class="muted small">${esc(g.studentNumber || g.studentEmail)}</div></td>
        <td>${esc(g.subject)}<div class="muted small">${esc(g.assessmentType || '')}</div></td>
        <td>${statusBadge(g.status)}</td>
        <td class="num mono">${g.totalMark !== null && g.totalMark !== undefined ? `${g.totalMark}/${g.maximumMark}` : '—'}</td>
        <td class="num mono">${g.percent !== null ? `${g.percent}%` : '—'}</td>
        <td class="small muted nowrap">
          ${g.annotationCount ? `${g.annotationCount} mark${g.annotationCount === 1 ? '' : 's'}` : '—'}
          <div>${g.keptPages ? `${g.keptPages} page${g.keptPages === 1 ? '' : 's'} kept` : '<span class="muted">no page copy</span>'}</div>
        </td>
        <td class="muted small nowrap hide-sm">${esc(fmtDate(g.updatedAt || g.createdAt))}</td>
        <td class="actions"><a class="btn btn-ghost btn-sm" href="#/teacher/grading/${encodeURIComponent(g.id)}">Open</a></td>
      </tr>`
        )
        .join('')
    : `<tr><td colspan="8" class="muted small" style="padding:2rem;text-align:center">
         Nothing marked yet. <a href="#/teacher/upload">Upload a script</a> and the marks appear here.</td></tr>`;

  mount(`
    <div class="page-head">
      <div>
        <h1>${esc(COPY.teacher.marked.title)}</h1>
        <p class="sub">${esc(COPY.teacher.marked.lead(ready.length))}${
          withPages ? '' : ' Older scripts have no page copy.'
        }</p>
      </div>
      <div class="spacer"></div>
      <input class="search" id="marked-search" placeholder="Search student, subject…" aria-label="Search marked work" />
    </div>
    <div class="card">
      <div class="table-scroll">
        <table class="data" id="marked-table">
          <thead><tr>
            <th>Student</th><th>Subject</th><th>Status</th><th class="right">Score</th><th class="right">%</th>
            <th>Marks</th><th class="hide-sm">Marked</th><th></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`);

  const search = document.getElementById('marked-search');
  if (search)
    search.addEventListener('input', () => {
      const q = search.value.toLowerCase();
      document.querySelectorAll('#marked-table tbody tr').forEach((tr) => {
        tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    });

  document.querySelectorAll('#marked-table [data-open]').forEach((tr) => {
    const go = () => { location.hash = `#/teacher/grading/${encodeURIComponent(tr.dataset.open)}`; };
    tr.addEventListener('click', (e) => { if (e.target.closest('a')) return; go(); });
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  });
}

/* ============================================================
   MARKED SCRIPT VIEWER
   GradeScriptUG returns annotations as data: a box (x, y, width,
   height as fractions from the top-left), a type and an optional
   comment. We keep our own copy of each uploaded page and draw the
   marks over it, the way the console does.
   ============================================================ */

const SVG_NS = 'http://www.w3.org/2000/svg';
const MARK_PEN = '#d32f2f';

/* Glyphs from the API docs, drawn in a 24 × 24 box. */
const MARK_GLYPHS = {
  TICK: 'M4 13l5 5L20 6',
  PARTIAL: 'M4 13l5 5L20 6M9 6l6 12',
  CROSS: 'M6 6l12 12M18 6 6 18',
};

const MARK_LABEL = {
  TICK: 'Correct',
  CROSS: 'Incorrect',
  PARTIAL: 'Partly correct',
  COMMENT: 'Comment',
  MARK: 'Marks',
  BLANK: 'Unused space',
  CROSSED_OUT: 'Crossed out',
};

function drawMarks(svg, annotations, pageWidth, pageHeight) {
  svg.setAttribute('viewBox', `0 0 ${pageWidth} ${pageHeight}`);
  svg.replaceChildren();

  const add = (tag, attributes, text = '') => {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, value);
    if (text) el.textContent = text;
    svg.appendChild(el);
    return el;
  };

  // Sizes are a share of the page width so they hold at any zoom (docs §sizing).
  const glyph = pageWidth * 0.045;
  const textSize = pageWidth * 0.023;

  for (const a of annotations) {
    const x = a.x * pageWidth;
    const y = a.y * pageHeight;
    const w = (a.width || 0) * pageWidth;
    const h = (a.height || 0) * pageHeight;
    const midY = y + h / 2;
    const inMargin = x >= 0.9 * pageWidth || a.type === 'MARK' || a.type === 'COMMENT';

    // Every mark hangs off a group tagged with its question, so the questions
    // table can light up exactly the marks that belong to one question.
    const group = add('g', { 'data-qref': a.questionRef || '', 'data-type': a.type });
    const addIn = (tag, attributes, text = '') => {
      const el = document.createElementNS(SVG_NS, tag);
      for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, value);
      if (text) el.textContent = text;
      group.appendChild(el);
      return el;
    };
    if (w > 0 && h > 0) {
      addIn('rect', {
        class: 'mark-box',
        x: Math.max(0, x),
        y: Math.max(0, y),
        width: Math.min(w, pageWidth - x),
        height: Math.min(h, pageHeight - y),
        rx: Math.min(w, h) * 0.08,
        fill: 'rgba(211,47,47,.07)',
        stroke: MARK_PEN,
        'stroke-dasharray': '6 5',
        'stroke-width': Math.max(1, pageWidth * 0.0018),
      });
    }

    if (MARK_GLYPHS[a.type]) {
      const gx = inMargin ? pageWidth * 0.9 : x + w - glyph * 0.5;
      const gy = midY - glyph / 2;
      addIn('path', {
        d: MARK_GLYPHS[a.type],
        transform: `translate(${gx} ${gy}) scale(${glyph / 24})`,
        fill: 'none',
        stroke: MARK_PEN,
        'stroke-width': 2.6,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      });
    } else if (a.type === 'BLANK' || a.type === 'CROSSED_OUT') {
      addIn('line', {
        x1: x,
        y1: y,
        x2: x + w,
        y2: y + h,
        stroke: MARK_PEN,
        'stroke-width': Math.max(1.5, pageWidth * 0.004),
        opacity: 0.7,
      });
    } else if (a.type === 'MARK') {
      addIn(
        'text',
        {
          x: pageWidth * 0.985,
          y: midY + textSize * 0.36,
          fill: MARK_PEN,
          'font-size': textSize,
          'font-weight': 700,
          'text-anchor': 'end',
        },
        `${a.markAwarded ?? ''}/${a.maximumMark ?? ''}`
      );
    } else if (a.type === 'COMMENT' && a.comment) {
      // Right margin, anchored to the page edge so it can never run off.
      const text = a.comment.length > 28 ? `${a.comment.slice(0, 27)}…` : a.comment;
      addIn(
        'text',
        {
          x: pageWidth * 0.985,
          y: midY + textSize * 0.36,
          fill: MARK_PEN,
          'font-size': textSize,
          'text-anchor': 'end',
        },
        text
      );
    }

    if (a.needsReview) {
      const fx = Math.min(pageWidth - glyph * 0.6, x + w + glyph * 0.2);
      addIn('circle', {
        cx: fx,
        cy: y + glyph * 0.35,
        r: glyph * 0.36,
        fill: '#fff3cd',
        stroke: '#b8860b',
        'stroke-width': Math.max(1, pageWidth * 0.002),
      });
      addIn(
        'text',
        {
          x: fx,
          y: y + glyph * 0.35 + textSize * 0.38,
          fill: '#8a5a00',
          'font-size': textSize * 0.95,
          'text-anchor': 'middle',
          'font-weight': 700,
        },
        '?'
      );
    }
  }
}

/** One page of the script with the marker's marks drawn over it. */
function markedPageHTML(page, annotations, pageUrl) {
  const notes = annotations
    .filter((a) => a.comment)
    .map(
      (a) =>
        `<li><span class="amk amk-${esc(String(a.type).toLowerCase())}">${esc(MARK_LABEL[a.type] || a.type)}</span>
         <span class="amk-q">${a.questionRef ? `Q${esc(a.questionRef)}` : ''}</span>
         ${esc(a.comment)}</li>`
    )
    .join('');

  const legend = annotations.length
    ? `<div class="page-legend">${[...new Set(annotations.map((a) => a.type))]
        .map((t) => `<span class="amk amk-${esc(String(t).toLowerCase())}">${esc(MARK_LABEL[t] || t)}</span>`)
        .join('')}</div>`
    : `<div class="page-legend muted small">No marks on this page.</div>`;

  if (page.kind === 'pdf') {
    return `
      <figure class="page-card">
        <figcaption>Page ${page.index} <span class="muted small">· ${esc(page.filename)}</span></figcaption>
        <div class="page-pdf">
          <div class="big">📄</div>
          <p class="small muted">This page was sent as a PDF. The browser build has no PDF renderer, so the
             marker's marks cannot be drawn over it — they are listed underneath instead.
             Upload PNG or JPEG scans of the pages to see the ticks and crosses drawn on the work itself.</p>
          <a class="btn btn-ghost btn-sm" href="${esc(pageUrl)}" target="_blank" rel="noopener">Open the PDF</a>
        </div>
        ${legend}
        ${notes ? `<ul class="annot-list">${notes}</ul>` : ''}
      </figure>`;
  }

  return `
    <figure class="page-card">
      <figcaption>Page ${page.index} <span class="muted small">· ${esc(page.filename)}</span></figcaption>
      <div class="page-frame" data-page="${page.index}">
        <img src="${esc(pageUrl)}" alt="Script page ${page.index}" loading="lazy" />
        <svg class="marks-layer" aria-hidden="true"></svg>
      </div>
      ${legend}
      ${notes ? `<ul class="annot-list">${notes}</ul>` : ''}
    </figure>`;
}

/** Full picture of one marked script. `scope` decides where pages load from. */
function markedScriptHTML(detail, scope) {
  const anns = detail.annotations || [];
  const questions = detail.questions || [];
  const pages = detail.pages || [];
  const base = scope === 'student' ? '/api/student/results' : '/api/teacher/gradings';
  const pageUrl = (i) => `${base}/${encodeURIComponent(detail.id)}/pages/${i}`;

  const flagged = questions.filter((q) => q.needsReview || q.graded === false);
  const totalAnns = anns.length;

  /* How the final mark and grade were arrived at. */
  const scale = [...(state.config?.scale || [])].sort((a, b) => a.min - b.min);
  const percent = Number(detail.percent) || 0;
  const maximum = Number(detail.maximumMark) || 0;
  const total = Number(detail.totalMark) || 0;
  const band = scale.find((b) => percent >= b.min && percent <= b.max);
  const nextBand = scale.filter((b) => b.min > percent).sort((a, b) => a.min - b.min)[0];
  const marksToNext = nextBand && maximum ? Math.round((((nextBand.min / 100) * maximum) - total) * 10) / 10 : 0;
  const scored = questions.filter((q) => q.graded !== false && q.max !== undefined);
  const sumQ = Math.round(scored.reduce((sum, q) => sum + (Number(q.awarded) || 0), 0) * 10) / 10;
  const maxQ = Math.round(scored.reduce((sum, q) => sum + (Number(q.max) || 0), 0) * 10) / 10;
  const mismatch = scored.length > 0 && Math.abs(sumQ - total) > 0.05;
  const worst = [...scored].sort((a, b) => (Number(b.max) - (Number(b.awarded) || 0)) - (Number(a.max) - (Number(a.awarded) || 0)))[0];
  const lostMarks = worst ? Math.round((Number(worst.max) - (Number(worst.awarded) || 0)) * 10) / 10 : 0;
  const fullMarks = scored.filter((q) => Number(q.awarded) >= Number(q.max)).length;
  const article = (letter) => (/^[AEFHILMNORSX]/i.test(String(letter || '')) ? 'an' : 'a');

  const gradeWorking = `
    <div class="card card-pad grade-card">
      <h2>${esc(COPY.marked.grade)}</h2>
      <div class="grade-flow">
        <div class="gf-step"><span class="gf-n mono">${total}</span><span class="gf-l">marks given</span></div>
        <span class="gf-op">÷</span>
        <div class="gf-step"><span class="gf-n mono">${maximum}</span><span class="gf-l">possible</span></div>
        <span class="gf-op">=</span>
        <div class="gf-step"><span class="gf-n mono">${percent}%</span><span class="gf-l">score</span></div>
        <span class="gf-op">→</span>
        <div class="gf-step">
          <span class="grade-pill ${gradeClass(detail.grade)}">${esc(detail.grade)}</span>
          <span class="gf-l">${band ? `${esc(band.label || '')} · ${band.points} point${band.points === 1 ? '' : 's'}` : 'grade'}</span>
        </div>
      </div>
      <div class="grade-bar" role="img" aria-label="${percent}% of ${maximum} marks">
        <div class="grade-bar-fill" style="width:${Math.max(0, Math.min(100, percent))}%"></div>
      </div>
      <ul class="grade-notes">
        ${
          band
            ? `<li>Grade <strong>${esc(band.grade)}</strong> covers <span class="mono">${band.min}–${band.max}%</span>, so ${percent}% lands in it.</li>`
            : `<li>${percent}% does not fall inside a band on this school's scale.</li>`
        }
        ${
          nextBand && marksToNext > 0
            ? `<li><span class="mono">${marksToNext}</span> more mark${marksToNext === 1 ? '' : 's'} would have reached ${article(nextBand.grade)} <strong>${esc(nextBand.grade)}</strong> (${nextBand.min}%).</li>`
            : band && !nextBand
              ? `<li>That is the top band on the scale.</li>`
              : ''
        }
        ${
          scored.length
            ? `<li>${fullMarks} of ${scored.length} question${scored.length === 1 ? '' : 's'} got full marks${
                worst && lostMarks > 0 ? `; the most lost was Q${esc(worst.ref)} (−${lostMarks})` : ''
              }.</li>`
            : ''
        }
      </ul>
      ${
        scored.length
          ? `<p class="grade-check ${mismatch ? 'bad' : ''}">
               ${mismatch ? '⚠' : '✓'} The question marks add up to <strong>${sumQ}</strong> of ${maxQ}${
                 mismatch ? ` — the total recorded is ${total}.` : `, the same as the total.`
               }
             </p>`
          : ''
      }
    </div>`;

  const qRows = questions.length
    ? questions
        .map((q) => {
          const got = Number(q.awarded) || 0;
          const max = Number(q.max) || 0;
          const ratio = max ? Math.max(0, Math.min(1, got / max)) : 0;
          const tone = ratio >= 0.999 ? 'good' : ratio >= 0.5 ? 'part' : 'bad';
          return `
      <tr class="q-row ${q.needsReview || q.graded === false ? 'q-flagged' : ''}" data-qref="${esc(q.ref)}" tabindex="0"
          title="Show question ${esc(q.ref)}'s marks on the page">
        <td><strong>${esc(q.ref)}</strong></td>
        <td>${esc(q.topic || '')}</td>
        <td class="small hide-sm">${esc(q.questionText || '')}</td>
        <td class="right mono">
          <span class="q-score ${tone}">${q.awarded ?? '—'}/${q.max}</span>
          <span class="q-bar ${tone}"><i style="width:${Math.round(ratio * 100)}%"></i></span>
        </td>
        <td class="small">${esc(q.rationale || '')}${
          q.needsReview
            ? `<span class="q-flag" title="${esc(q.reviewReason || 'The marker was unsure')}">⚑ ${esc(q.reviewReason || 'needs review')}</span>`
            : ''
        }</td>
      </tr>`;
        })
        .join('')
    : `<tr><td colspan="5" class="muted small" style="padding:1.2rem;text-align:center">
         No question breakdown — this script is ${esc(String(detail.status).toLowerCase())}.</td></tr>`;

  return `
    <section class="marked-head">
      <div class="marked-title">
        <div class="eyebrow">${esc(detail.subject)} · ${esc(detail.assessmentType)}${detail.termName ? ` · ${esc(detail.termName)}` : ''}</div>
        <h1>${esc(detail.studentName || 'Student')}</h1>
        <p class="small muted">
          Marked by <strong>${esc(detail.teacher)}</strong>
          ${detail.gradedAt ? ` · ${esc(fmtDate(detail.gradedAt))}` : ''}
          ${detail.title ? ` · ${esc(detail.title)}` : ''}
        </p>
      </div>
      <div class="marked-score">
        <div class="big-score">${detail.totalMark}<span>/${detail.maximumMark}</span></div>
        <div class="marked-meta">
          <span class="grade-pill ${gradeClass(detail.grade)}">${esc(detail.grade)}</span>
          <span class="mono">${detail.percent}%</span>
          ${statusBadge(detail.status)}
        </div>
      </div>
    </section>

    ${detail.error ? `<div class="notice notice-warn small">${esc(detail.error)}</div>` : ''}

    <div class="marked-grid">
      <div class="marked-pages">
        <div class="marked-sec-head">
          <h2>${esc(COPY.marked.page)}</h2>
          <span class="muted small">${pages.length} page${pages.length === 1 ? '' : 's'} · ${esc(COPY.marked.marks(totalAnns))}</span>
        </div>
        ${
          pages.length
            ? pages.map((pg) => markedPageHTML(pg, anns.filter((a) => Number(a.pageIndex) === Number(pg.index)), pageUrl(pg.index))).join('')
            : `<div class="card empty" style="padding:2rem">
                 <div class="big">🗂</div>
                 <h3 style="font-size:1rem;margin-bottom:.3rem">No page copy for this script</h3>
                 <p class="small muted" style="max-width:44ch;margin:0 auto">
                   The marks are below. Pages uploaded from now on are kept, so future scripts show the
                   marker's ticks and crosses drawn over the student's work.
                 </p>
               </div>`
        }
      </div>

      <aside class="marked-side">
        ${gradeWorking}

        <div class="card card-pad">
          <h2 style="font-size:1rem;margin-bottom:.6rem">${esc(COPY.marked.feedback)}</h2>
          <p class="small${detail.feedback ? '' : ' muted'}" style="margin:0">
            ${detail.feedback ? esc(detail.feedback) : 'No written feedback for this script.'}
          </p>
        </div>

        ${flagged.length ? `
        <div class="card card-pad flagged-card">
          <h2 style="font-size:1rem;margin-bottom:.5rem">⚑ ${flagged.length} to review</h2>
          <ul class="small" style="margin:0;padding-left:1.1rem">
            ${flagged.map((q) => `<li>Q${esc(q.ref)}${q.reviewReason ? ` — ${esc(q.reviewReason)}` : ''}</li>`).join('')}
          </ul>
        </div>` : ''}

        <div class="card">
          <div class="card-head">
            <h2>${esc(COPY.marked.questions)}</h2>
            ${anns.length ? `<span class="small muted">${esc(COPY.marked.highlight)}</span>` : ''}
          </div>
          <div class="table-scroll">
            <table class="q-table">
              <thead><tr><th>Q</th><th>Topic</th><th class="hide-sm">Question</th><th class="right">Mark</th><th>Why</th></tr></thead>
              <tbody>${qRows}</tbody>
            </table>
          </div>
        </div>
      </aside>
    </div>

    <style>
      .marked-head { display:flex; justify-content:space-between; gap:1rem; align-items:flex-start; flex-wrap:wrap; margin-bottom:1.2rem; }
      .marked-title h1 { font-size:1.375rem; margin:.15rem 0 .2rem; }
      .marked-score { text-align:right; }
      .big-score { font-size:2rem; font-weight:700; line-height:1; color:var(--ink); }
      .big-score span { font-size:1rem; color:var(--ink-3); font-weight:500; }
      .marked-meta { display:flex; gap:.4rem; align-items:center; justify-content:flex-end; margin-top:.35rem; flex-wrap:wrap; }
      .marked-grid { display:grid; grid-template-columns: minmax(0,1.55fr) minmax(0,1fr); gap:1.2rem; align-items:start; }
      @media (max-width: 900px) { .marked-grid { grid-template-columns: 1fr; } }
      .marked-sec-head { display:flex; align-items:baseline; justify-content:space-between; gap:.6rem; margin-bottom:.6rem; }
      .marked-sec-head h2 { font-size:1rem; margin:0; }
      .marked-side { display:grid; gap:1rem; }
      .page-card { margin:0 0 1.1rem; }
      .page-card figcaption { font-size:.8125rem; font-weight:600; color:var(--ink-2); margin-bottom:.35rem; }
      .page-frame { position:relative; border:1px solid var(--line); border-radius:10px; overflow:hidden; background:#fff; }
      .page-frame img { display:block; width:100%; height:auto; }
      .marks-layer { position:absolute; inset:0; width:100%; height:100%; pointer-events:none; }
      .page-pdf { border:1px dashed var(--line); border-radius:10px; padding:1.2rem; text-align:center; background:var(--canvas); }
      .page-legend { display:flex; gap:.4rem; flex-wrap:wrap; margin-top:.45rem; }
      .amk { display:inline-block; font-size:.75rem; font-weight:700; padding:.1rem .35rem; border-radius:999px; letter-spacing:.02em; }
      .amk-tick { background:rgba(27,77,120,.12); color:var(--blue-700); }
      .amk-cross { background:rgba(179,38,30,.12); color:var(--danger); }
      .amk-partial { background:rgba(169,67,108,.14); color:var(--pink-700); }
      .amk-mark, .amk-comment { background:var(--blue-100); color:var(--blue-700); }
      .amk-blank, .amk-crossed_out { background:var(--blue-100); color:var(--ink-3); }
      .annot-list { margin:.45rem 0 0; padding-left:1.1rem; font-size:.875rem; color:var(--ink-2); }
      .annot-list li { margin-bottom:.15rem; }
      .amk-q { font-weight:700; margin-right:.25rem; }
      .q-table tr.q-flagged { background:var(--pink-100); }
      .flagged-card { border-color:var(--pink-600); }
      .card-head { display:flex; align-items:baseline; justify-content:space-between; gap:.5rem; padding:1rem 1rem .4rem; flex-wrap:wrap; }
      .grade-card h2, .marked-side h2 { font-size:1rem; margin:0 0 .6rem; }
      .grade-flow { display:flex; align-items:center; gap:.45rem; flex-wrap:wrap; margin-bottom:.7rem; }
      .gf-step { display:flex; flex-direction:column; align-items:center; gap:.15rem; padding:.35rem .5rem;
        background:var(--canvas); border-radius:10px; min-width:56px; }
      .gf-n { font-size:1rem; font-weight:700; line-height:1; }
      .gf-l { font-size:.75rem; text-transform:uppercase; letter-spacing:.06em; color:var(--ink-3); font-weight:700; }
      .gf-op { color:var(--ink-3); font-weight:700; }
      .grade-bar { height:8px; border-radius:999px; background:var(--line); overflow:hidden; }
      .grade-bar-fill { height:100%; border-radius:999px; background:linear-gradient(90deg,var(--blue-700),var(--blue-600)); }
      .grade-notes { margin:.7rem 0 0; padding-left:1.05rem; font-size:.875rem; color:var(--ink-2); }
      .grade-notes li { margin-bottom:.2rem; }
      .grade-check { margin:.6rem 0 0; font-size:.8125rem; color:var(--green-700); font-weight:600; }
      .grade-check.bad { color:var(--warn); }
      .q-row { cursor:pointer; }
      .q-row:hover td, .q-row:focus-visible td { background:var(--green-100); }
      .q-row:focus-visible { outline:2px solid var(--green-600); outline-offset:-2px; }
      .q-score { font-weight:700; }
      .q-score.bad, .q-score.part { color:var(--warn); }
      .q-score.good { color:var(--green-700); }
      .q-bar { display:block; height:4px; margin-top:.2rem; border-radius:999px; background:var(--line); overflow:hidden; }
      .q-bar i { display:block; height:100%; border-radius:999px; background:var(--green-600); }
      .q-bar.part i { background:var(--warn); }
      .q-bar.bad i { background:var(--danger); }
      .marks-layer .mark-box { display:none; }
      .marks-layer.focus [data-qref]:not(.hit) { opacity:.12; }
      .marks-layer.focus [data-qref].hit .mark-box { display:block; }
      .page-card.flash { animation: pageFlash 1.1s ease-out 1; }
      @keyframes pageFlash { from { box-shadow:0 0 0 3px rgba(169,67,108,.45); } to { box-shadow:0 0 0 0 rgba(169,67,108,0); } }
      .q-flag { color:var(--warn); font-weight:700; font-size:.75rem; margin-left:.25rem; }
    </style>`;
}

/** Light up one question's marks on the pages — or clear the spotlight. */
function spotlightQuestion(root, ref) {
  const target = ref === null || ref === undefined ? null : String(ref);
  let firstPage = null;

  root.querySelectorAll('.marks-layer').forEach((svg) => {
    const marks = [...svg.querySelectorAll('[data-qref]')];
    const mine = target === null ? [] : marks.filter((g) => g.dataset.qref === target);
    svg.classList.toggle('focus', mine.length > 0);
    marks.forEach((g) => g.classList.toggle('hit', target !== null && g.dataset.qref === target));
    if (mine.length && !firstPage) firstPage = svg.closest('.page-card');
  });

  root.querySelectorAll('.q-row').forEach((row) => {
    row.classList.toggle('active', target !== null && row.dataset.qref === target);
  });

  if (firstPage) {
    firstPage.classList.remove('flash');
    void firstPage.offsetWidth;
    firstPage.classList.add('flash');
    if (typeof firstPage.scrollIntoView === 'function') {
      firstPage.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
  return Boolean(firstPage);
}

/** Draw the marks once each page image knows its pixel size. */
function wireMarkedScript(root, detail) {
  const anns = detail.annotations || [];
  root.querySelectorAll('[data-page]').forEach((frame) => {
    const img = frame.querySelector('img');
    const svg = frame.querySelector('svg');
    if (!img || !svg) return;
    const pageIndex = Number(frame.dataset.page);
    const mine = anns.filter((a) => Number(a.pageIndex) === pageIndex);
    // Marks are fractions of the page, so they can be drawn before the image
    // arrives (A4 portrait until we know better) and redrawn at its real size.
    const size = () => [img.naturalWidth || 1000, img.naturalHeight || 1414];
    const draw = () => drawMarks(svg, mine, ...size());
    draw();
    img.addEventListener('load', draw, { once: true });
    img.addEventListener('error', () => {
      frame.innerHTML = `<div class="page-pdf"><div class="big">🖼</div>
        <p class="small muted" style="margin:.3rem 0 0">This page image could not be loaded.</p></div>`;
    }, { once: true });
  });

  // Question table ⇄ page marks: click a question to see exactly where it was marked.
  let active = null;
  root.querySelectorAll('.q-row').forEach((row) => {
    const toggle = () => {
      const ref = row.dataset.qref;
      active = active === ref ? null : ref;
      spotlightQuestion(root, active);
    };
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && active !== null) {
      active = null;
      spotlightQuestion(root, null);
    }
  });
}

async function renderMarkedScript(scope, id) {
  view.className = 'view';
  mount(skeleton(2));
  const isStudent = scope === 'student';
  const base = isStudent ? '/api/student/results' : '/api/teacher/gradings';
  const back = isStudent ? '#/portal/marks' : '#/teacher/marked';
  const data = await api(`${base}/${encodeURIComponent(id)}`);
  const detail = data.grading || data.result || data;
  const student = data.student || null;

  mount(`
    <div class="page-head">
      <a class="btn btn-ghost btn-sm" href="${back}">← Back</a>
      <div class="spacer"></div>
      ${!isStudent && student ? `<a class="btn btn-ghost btn-sm" href="#/teacher/students">Manage student</a>` : ''}
      <button class="btn btn-ghost btn-sm" id="print-script">Print</button>
    </div>
    ${markedScriptHTML(detail, scope)}`);

  wireMarkedScript(view, detail);
  const print = document.getElementById('print-script');
  if (print) print.addEventListener('click', () => window.print());
}

/* ---------------- report rendering ---------------- */

function reportCardHTML(card) {
  const s = card.summary;
  const rows = card.rows.map((r) => `
      <tr>
        <td class="subject">${esc(r.subject)}${
          Array.isArray(r.teachers) && r.teachers.length
            ? `<div class="rc-teacher">${esc(r.teachers.join(' · '))}</div>`
            : ''
        }${r.provisional ? '<span class="badge badge-warn" style="margin-left:.35rem">provisional</span>' : ''}</td>
        <td class="num">${r.awarded}</td>
        <td class="num hide-sm">${r.max}</td>
        <td class="num">${r.percent}%</td>
        <td class="num"><span class="grade-pill ${gradeClass(r.grade)}">${esc(r.grade)}</span></td>
        <td class="num hide-sm">${r.points}</td>
        <td class="hide-sm">${esc(r.label)}</td>
      </tr>`).join('');

  return `
  <article class="paper" id="report-paper">
    <header class="rc-head">
      <div class="rc-logo">${esc(card.school.logoText)}</div>
      <div class="rc-school">
        <h2>${esc(card.school.name)}</h2>
        <div class="motto">${esc(card.school.motto)}</div>
        <div class="addr">${esc(card.school.address)} · ${esc(card.school.phone)} · ${esc(card.school.email)}</div>
      </div>
      <div class="rc-logo" style="visibility:hidden">${esc(card.school.logoText)}</div>
    </header>
    <div class="rc-title">${esc(card.term.name)} ${esc(card.term.year)} — Terminal Report</div>
    <div class="rc-id">
      <div><div class="k">Student</div><div class="v">${esc(card.student.name)}</div></div>
      <div><div class="k">Class</div><div class="v">${esc(card.student.className || '—')}</div></div>
      <div><div class="k">Student No.</div><div class="v">${esc(card.student.studentNumber || '—')}</div></div>
      <div><div class="k">Term ends</div><div class="v">${esc(fmtDate(card.term.ends))}</div></div>
    </div>
    <table class="rc-table">
      <thead><tr>
        <th>Subject</th><th class="num">Marks</th><th class="num hide-sm">Out of</th>
        <th class="num">%</th><th class="num">Grade</th><th class="num hide-sm">Points</th><th class="hide-sm">Comment</th>
      </tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr>
        <td>Total / average</td><td class="num">${s.totalAwarded}</td><td class="num hide-sm">${s.totalMax}</td>
        <td class="num">${s.average}%</td><td class="num">${esc(s.division)}</td>
        <td class="num hide-sm">${s.aggregate ?? '—'}</td><td class="hide-sm">${esc(s.divisionTitle)}</td>
      </tr></tfoot>
    </table>
    <div class="rc-summary">
      <div class="box"><div class="k">Subjects</div><div class="v">${s.subjects}</div></div>
      <div class="box"><div class="k">Average</div><div class="v">${s.average}<small>%</small></div></div>
      <div class="box"><div class="k">Aggregate</div><div class="v">${s.aggregate ?? '—'}<small>/${s.subjectsCounted}</small></div></div>
      <div class="box"><div class="k">Division</div><div class="v">${esc(s.division)}</div></div>
      <div class="box"><div class="k">Position</div><div class="v">${s.position ?? '—'}<small>${s.classSize ? `/${s.classSize}` : ''}</small></div></div>
    </div>
    <div class="rc-comment">
      <div class="label">Class teacher's comment</div>
      <div class="box">${esc(card.comment)}</div>
    </div>
    <div class="rc-comment">
      <div class="label">Head teacher's comment</div>
      <div class="box serif">${esc(card.headComment)}</div>
    </div>
    <div class="rc-key">${card.scale.map((b) => `<span><b>${esc(b.grade)}</b> ${esc(b.range)}% · ${b.points} pt</span>`).join('')}</div>
    <div class="rc-sign">
      <div><div class="line"></div>Class teacher</div>
      <div><div class="line"></div>Head teacher</div>
      <div style="text-align:right"><div class="line" style="margin-left:auto"></div>School stamp</div>
    </div>
    <div class="rc-foot">${esc(card.gradingNote)} · Generated by ${esc(state.config?.platform?.name || 'Volyx')} on ${esc(fmtDate(card.generatedAt))}</div>
  </article>`;
}

function markingDetailHTML(card) {
  const subjects = card.rows.filter((r) => r.assessments.some((a) => a.questions.length || a.feedback));
  if (!subjects.length) return '';
  return `
  <details class="detail-wrap">
    <summary>How each script was marked <span class="chev">▾</span></summary>
    <p class="small muted" style="margin:.6rem 0 1rem">
      The marking detail GradeScriptUG returned for each script — the mark awarded, the reason, and any question flagged for review.
    </p>
    ${subjects.map((r) => `
      <details class="subject-detail">
        <summary>
          <span>${esc(r.subject)}</span>
          <span class="badge badge-muted">${r.assessments.length} script${r.assessments.length === 1 ? '' : 's'}</span>
          <span style="margin-left:auto" class="mono">${r.awarded}/${r.max} · ${r.percent}%</span>
        </summary>
        <div class="body">
          ${r.assessments.map((a) => `
            <div style="margin-bottom:1rem">
              <div class="q-head">
                <strong>${esc(a.assessmentType)}</strong>
                <span class="mono muted">${a.awarded}/${a.max} · ${a.percent}%</span>
                ${a.flagged ? `<span class="badge badge-warn">${a.flagged} to review</span>` : ''}
                <span class="badge badge-ok">${esc(a.status)}</span>
              </div>
              ${a.feedback ? `<p class="small feedback">${esc(a.feedback)}</p>` : ''}
              ${a.questions.length ? `<table class="q-table">
                <thead><tr><th>Q</th><th>Topic</th><th class="right">Mark</th><th>Why</th></tr></thead>
                <tbody>${a.questions.map((q) => `<tr>
                  <td><strong>${esc(q.ref)}</strong></td>
                  <td>${esc(q.topic || '')}</td>
                  <td class="right mono">${q.awarded ?? '—'}/${q.max}${q.needsReview ? ` <span class="q-flag" title="${esc(q.reviewReason)}">⚑</span>` : ''}</td>
                  <td>${esc(q.rationale || '')}</td>
                </tr>`).join('')}</tbody>
              </table>` : ''}
            </div>`).join('')}
        </div>
      </details>`).join('')}
  </details>`;
}

/* ============================================================
   CONSOLE
   ============================================================ */

function consoleTabs(active) {
  const tabs = [
    ['#/teacher', 'Overview'],
    ['#/teacher/students', 'Students'],
    ['#/teacher/upload', 'Upload script'],
    ['#/teacher/results', 'Results & publishing'],
    ['#/teacher/settings', 'Settings'],
  ];
  return `<div class="tabs">${tabs.map(([href, label]) => `<a href="${href}" class="${active === href ? 'active' : ''}">${esc(label)}</a>`).join('')}</div>`;
}

async function loadOverview() {
  if (!state.overview) state.overview = await api('/api/teacher/overview');
  if (state.overview?.user) state.user = { ...state.user, ...state.overview.user };
  return state.overview;
}

/* ---------------- students ---------------- */

async function renderStudents() {
  view.className = 'view';
  mount(skeleton(3));
  const data = await api('/api/students');
  const classes = state.config.reporting.classes;

  const rows = data.students.map((s) => `
    <tr data-id="${esc(s.id)}">
      <td><strong>${esc(s.name)}</strong>
        <div class="muted small">${esc(s.email || 'no contact email')}</div>
        ${s.loginEmail ? `<div class="small login-line mono">${esc(s.loginEmail)}</div>` : ''}
      </td>
      <td class="mono small hide-sm">${esc(s.studentNumber)}</td>
      <td>${esc(s.className)}</td>
      <td class="num">${s.subjects}</td>
      <td class="num">${s.assessments}</td>
      <td class="actions">
        <button class="btn btn-ghost btn-sm" data-login="${esc(s.id)}">🔑 Login</button>
        <button class="btn btn-ghost btn-sm" data-edit="${esc(s.id)}">Edit</button>
        <button class="btn btn-danger btn-sm" data-del="${esc(s.id)}">Delete</button>
      </td>
    </tr>`).join('');

  mount(`
    <div class="page-head">
      <div>
        <h1>${esc(COPY.teacher.students.title)}</h1>
        <p class="sub">${esc(COPY.teacher.students.lead(data.students.length))}</p>
      </div>
      <div class="spacer"></div>
      <button class="btn btn-primary btn-sm" id="add-student">${esc(COPY.teacher.students.primary)}</button>
    </div>
    ${consoleTabs('#/teacher/students')}

    ${data.students.length === 0 ? `
      <div class="card empty">
        <div class="big">👩‍🎓</div>
        <h2 style="font-size:1rem;margin-bottom:.35rem">0 students</h2>
        <p class="small muted" style="max-width:44ch;margin:0 auto 1.1rem">
          Add the students you teach. Their scripts, marks and report cards stay private to your account —
          other accounts can't see or change them.
        </p>
        <button class="btn btn-primary btn-sm" id="add-student-empty">Add your first student</button>
      </div>` : `
      <div class="card">
        <div class="card-head">
          <h2>${data.students.length} student${data.students.length === 1 ? '' : 's'}</h2>
          <input class="search" id="student-search" placeholder="Search name or email…" aria-label="Search students" />
        </div>
        <div class="table-scroll">
          <table class="data" id="students-table">
            <thead><tr>
              <th>Student</th><th class="hide-sm">No.</th><th>Class</th>
              <th class="right">Subjects</th><th class="right">Scripts</th><th></th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`}`);

  const openAdd = () => studentModal({ classes, onSaved: () => { state.overview = null; renderStudents(); } });
  document.getElementById('add-student')?.addEventListener('click', openAdd);
  document.getElementById('add-student-empty')?.addEventListener('click', openAdd);

  const search = document.getElementById('student-search');
  if (search)
    search.addEventListener('input', () => {
      const q = search.value.toLowerCase();
      document.querySelectorAll('#students-table tbody tr').forEach((tr) => {
        tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    });

  document.querySelectorAll('[data-login]').forEach((b) =>
    b.addEventListener('click', () => {
      const s = data.students.find((x) => x.id === b.dataset.login);
      credentialsModal(s);
    })
  );

  document.querySelectorAll('[data-edit]').forEach((b) =>
    b.addEventListener('click', () => {
      const s = data.students.find((x) => x.id === b.dataset.edit);
      studentModal({ classes, student: s, onSaved: () => { state.overview = null; renderStudents(); } });
    })
  );

  document.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      const s = data.students.find((x) => x.id === b.dataset.del);
      const ok = await confirmDialog({
        title: `Remove ${s.name}?`,
        message: 'Their record and every script marked for them will be deleted from your account. This cannot be undone.',
        confirmLabel: 'Delete student',
        danger: true,
      });
      if (!ok) return;
      try {
        await api(`/api/students/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
        state.overview = null;
        toast(`${s.name} removed.`);
        renderStudents();
      } catch (err) { toast(err.message, true); }
    })
  );
}

function studentModal({ classes, student = null, onSaved }) {
  const editing = Boolean(student);
  const m = openModal({
    title: editing ? 'Edit student' : 'Add a student',
    body: `
      <form id="student-form">
        <div class="field">
          <label for="s-name">Full name</label>
          <input id="s-name" type="text" value="${esc(student?.name || '')}" placeholder="Amina Nakato" required />
        </div>
        <div class="field">
          <label for="s-email">Student's email <span class="muted">(optional)</span></label>
          <input id="s-email" type="email" inputmode="email" autocapitalize="none" spellcheck="false"
                 value="${esc(student?.email || '')}" placeholder="amina.nakato@gmail.com" />
          <div class="hint">Where their login details get sent. Their Volyx login is generated for them.</div>
        </div>
        <div class="grid grid-2" style="gap:0 1rem">
          <div class="field">
            <label for="s-class">Class</label>
            <select id="s-class">
              ${classes.map((c) => `<option value="${esc(c.id)}" ${student?.classId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label for="s-number">Student number <span class="muted">(optional)</span></label>
            <input id="s-number" type="text" value="${esc(student?.studentNumber || '')}" placeholder="S2/101" />
          </div>
        </div>
        <div id="student-error"></div>
      </form>`,
    actions: [
      { id: 'cancel', label: 'Cancel', class: 'btn-ghost' },
      { id: 'save', label: editing ? 'Save changes' : 'Add student', class: 'btn-primary' },
    ],
  });

  m.on('cancel', () => m.close());
  m.on('save', async () => {
    const errBox = m.body.querySelector('#student-error');
    const payload = {
      name: m.body.querySelector('#s-name').value.trim(),
      email: m.body.querySelector('#s-email').value.trim(),
      classId: m.body.querySelector('#s-class').value,
      studentNumber: m.body.querySelector('#s-number').value.trim(),
    };
    try {
      let created = null;
      if (editing) await api(`/api/students/${encodeURIComponent(student.id)}`, { method: 'PATCH', body: payload });
      else created = await api('/api/students', { method: 'POST', body: payload });
      m.close();
      if (created?.credentials) {
        // Fresh login details are shown once, right away.
        credentialsModal(created.student, { credentials: created.credentials, fresh: true });
        toast(`${created.student.name} added — login ready.`);
      } else {
        toast(editing ? 'Student updated.' : 'Student added.');
      }
      onSaved();
    } catch (err) {
      errBox.innerHTML = `<div class="notice notice-danger small" style="margin:0">${esc(err.message)}</div>`;
    }
  });

  setTimeout(() => m.body.querySelector('#s-name')?.focus(), 60);
}

/* ============================================================
   STUDENT CREDENTIALS (guardian side)
   The password exists only in the response that mints it, so the
   modal shows it once and then relies on re-issue.
   ============================================================ */

function credentialReveal({ student, credentials, fresh, deliveredNote = '' }) {
  return `
    <div class="cred-head">
      <div class="avatar lg">${esc(initials(student.name))}</div>
      <div>
        <strong>${esc(student.name)}</strong>
        <div class="small muted">${esc(student.className || '')} · student login</div>
      </div>
    </div>
    ${deliveredNote ? `<div class="notice notice-ok small">${esc(deliveredNote)}</div>` : ''}
    <div class="cred-box">
      <div class="cred-row">
        <span class="cred-label">Sign-in address</span>
        <code id="cred-email">${esc(credentials.loginEmail)}</code>
        <button class="btn btn-ghost btn-sm" data-copy="email">Copy</button>
      </div>
      <div class="cred-row">
        <span class="cred-label">Temporary password</span>
        <code id="cred-pass">${esc(credentials.password)}</code>
        <button class="btn btn-ghost btn-sm" data-copy="pass">Copy</button>
      </div>
    </div>
    <div class="notice notice-warn small">
      <strong>Shown once.</strong> We only store a hash of this password — if it's lost, issue a new one.
      ${credentials.expiresAt ? `It expires ${esc(fmtDate(credentials.expiresAt))}.` : ''}
    </div>
    <p class="small muted" style="margin:.7rem 0 0">
      ${fresh ? 'Share these with the student' : 'Any session they had open has been signed out'}, and they'll be asked to pick their own password.
      They sign in at <a href="#/auth">the normal sign-in screen</a>.
    </p>`;
}

function credentialsModal(student, { credentials = null, fresh = false } = {}) {
  const m = openModal({
    title: credentials ? 'Student login ready' : `Login for ${student.name}`,
    body: credentials
      ? credentialReveal({ student, credentials, fresh })
      : loadingBlock('Checking login…'),
    actions: credentials
      ? [{ id: 'close', label: 'Done', class: 'btn-primary' }]
      : [{ id: 'close', label: 'Close', class: 'btn-ghost' }],
    wide: true,
  });

  const wireCopy = () => {
    m.body.querySelectorAll('[data-copy]').forEach((b) =>
      b.addEventListener('click', () => {
        const which = b.dataset.copy === 'email' ? '#cred-email' : '#cred-pass';
        copyText(document.querySelector(which)?.textContent || '', 'Copied to clipboard.');
      })
    );
  };

  if (credentials) {
    wireCopy();
    m.on('close', () => m.close());
    return m;
  }

  const paint = async () => {
    const st = await api(`/api/students/${encodeURIComponent(student.id)}/credentials`);
    m.body.innerHTML = `
      <div class="cred-head">
        <div class="avatar lg">${esc(initials(student.name))}</div>
        <div>
          <strong>${esc(student.name)}</strong>
          <div class="small muted">${esc(st.loginEmail || 'no login yet')}</div>
        </div>
      </div>

      <div class="cred-status">
        <span class="chip ${st.hasLogin ? 'chip-ok' : 'chip-warn'}">${st.hasLogin ? 'Login active' : 'No login yet'}</span>
        ${st.temporaryPasswordActive ? '<span class="chip chip-warn">Temporary password in use</span>' : ''}
        ${st.passwordSetByStudent ? '<span class="chip chip-ok">Student set their own password</span>' : ''}
        ${st.activeSessions ? `<span class="chip">${st.activeSessions} open session${st.activeSessions === 1 ? '' : 's'}</span>` : ''}
      </div>

      <div class="kv"><span>Sign-in address</span><strong class="mono">${esc(st.loginEmail || '—')}</strong></div>
      <div class="kv"><span>Contact email</span><strong>${esc(st.contactEmail || 'not set')}</strong></div>
      <div class="kv"><span>Password</span><strong>${st.passwordSetByStudent ? 'Set by the student' : st.hasLogin ? 'Temporary — not readable' : '—'}</strong></div>
      <div class="kv"><span>Last sign-in</span><strong>${st.lastSignInAt ? esc(fmtDate(st.lastSignInAt)) : 'never'}</strong></div>

      <div class="cred-actions">
        <button class="btn btn-primary btn-sm" id="issue-new">Issue a new password</button>
        <button class="btn btn-ghost btn-sm" id="email-creds" ${st.contactEmail ? '' : 'disabled title="Add a contact email to this student first"'}>Email login details</button>
        ${st.loginEmail ? '<button class="btn btn-ghost btn-sm" id="copy-email">Copy address</button>' : ''}
      </div>
      <p class="small muted" style="margin:.8rem 0 0">
        Issuing a new password signs the student out everywhere and shows the password once.
        ${st.contactEmail ? `Emailing sends it to ${esc(st.contactEmail)}.` : 'Add a contact email to send it by mail.'}
      </p>`;

    m.body.querySelector('#issue-new').addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Issue a new password?',
        message: `${student.name}'s current password stops working immediately and any open session is signed out.`,
        confirmLabel: 'Issue new password',
      });
      if (!ok) return;
      try {
        const res = await api(`/api/students/${encodeURIComponent(student.id)}/credentials`, { method: 'POST' });
        m.body.innerHTML = credentialReveal({ student, credentials: res.credentials, fresh: false });
        wireCopy();
        toast('New password issued.');
      } catch (err) {
        toast(err.message, true);
      }
    });

    const emailBtn = m.body.querySelector('#email-creds');
    if (emailBtn && !emailBtn.disabled) {
      emailBtn.addEventListener('click', async () => {
        emailBtn.disabled = true;
        emailBtn.textContent = 'Sending…';
        try {
          const res = await api(`/api/students/${encodeURIComponent(student.id)}/credentials/email`, { method: 'POST' });
          m.body.innerHTML = credentialReveal({
            student,
            credentials: res.credentials,
            fresh: false,
            deliveredNote: res.delivered
              ? `Sent to ${res.to}.`
              : 'No mail server configured — share these details with the student yourself.',
          });
          wireCopy();
          toast(res.delivered ? `Login details sent to ${res.to}.` : 'Details ready to share.');
        } catch (err) {
          toast(err.message, true);
          emailBtn.disabled = false;
          emailBtn.textContent = 'Email login details';
        }
      });
    }

    const copyBtn = m.body.querySelector('#copy-email');
    if (copyBtn)
      copyBtn.addEventListener('click', () => copyText(st.loginEmail, 'Sign-in address copied.'));
  };

  m.on('close', () => m.close());
  paint().catch((err) => {
    m.body.innerHTML = `<div class="notice notice-danger small">${esc(err.message)}</div>`;
  });
  return m;
}

/* ---------------- overview ---------------- */

async function renderTeacherOverview() {
  clearTimeout(state.pollTimer);
  view.className = 'view';
  mount(skeleton(4));
  state.overview = null;
  const data = await loadOverview();
  const c = data.counts;

  const keyBox = data.demo
    ? `<div class="notice notice-warn"><strong>Demo mode.</strong> No GradeScriptUG key is connected, so uploads are simulated. <a href="#/teacher/settings">Connect your key →</a></div>`
    : `<div class="notice notice-ok">Connected to GradeScriptUG with key <span class="mono">${esc(data.key.hint)}</span>.</div>`;

  const emptyNote = c.students === 0
    ? `<div class="notice notice-info">
         <strong>You have 0 students.</strong> Add a student before uploading a script —
         <a href="#/teacher/students">go to Students →</a>
       </div>`
    : '';

  const recent = data.recent.length
    ? data.recent.map((g) => `
      <tr class="row-link" data-grading="${esc(g.id)}" tabindex="0">
        <td><strong>${esc(g.studentName)}</strong><div class="muted small">${esc(g.studentNumber)}</div></td>
        <td>${esc(g.subject)}</td>
        <td class="muted small hide-sm">${esc(g.assessmentType || '—')}</td>
        <td>${statusBadge(g.status)}</td>
        <td class="num mono">${g.percent !== null ? g.percent + '%' : '—'}</td>
        <td class="muted small nowrap hide-sm">${esc(fmtDate(g.updatedAt || g.createdAt))}</td>
      </tr>`).join('')
    : `<tr><td colspan="6" class="muted small" style="padding:1.5rem;text-align:center">No gradings yet. ${c.students ? '<a href="#/teacher/upload">Upload a script</a> to start.' : 'Add a student first.'}</td></tr>`;

  mount(`
    <div class="page-head">
      <div>
        <h1>${esc(COPY.teacher.overview.title((data.user?.name || state.user.name || '').split(' ')[0]))}</h1>
        <p class="sub">${esc(COPY.teacher.overview.lead)}</p>
      </div>
      <div class="spacer"></div>
      <button class="btn btn-ghost btn-sm" id="sync">Refresh</button>
      <a class="btn btn-primary btn-sm" href="#/teacher/upload">${esc(COPY.teacher.overview.primary)}</a>
    </div>
    ${consoleTabs('#/teacher')}
    ${keyBox}
    ${emptyNote}

    <div class="stat-grid">
      <div class="card stat-card"><div class="k">Students</div><div class="v">${c.students}</div><div class="s">on your account</div></div>
      <div class="card stat-card"><div class="k">In the marker</div><div class="v">${c.pending + c.processing}</div><div class="s">queued or running</div></div>
      <div class="card stat-card"><div class="k">Graded</div><div class="v">${c.completed}</div><div class="s">${c.partial} partly graded</div></div>
      ${c.failed ? `<div class="card stat-card is-alert"><div class="k">Failed</div><div class="v">${c.failed}</div><div class="s">need a retry</div></div>` : ''}
    </div>

    <div class="card">
      <div class="card-head">
        <h2>Recent gradings</h2>
        <span class="badge badge-muted">${c.gradings} total</span>
        <input class="search" id="grading-search" placeholder="Search student or subject…" aria-label="Search gradings" />
      </div>
      <div class="table-scroll">
        <table class="data" id="grading-table">
          <thead><tr><th>Student</th><th>Subject</th><th class="hide-sm">Assessment</th><th>Status</th><th class="right">Score</th><th class="hide-sm">Updated</th></tr></thead>
          <tbody>${recent}</tbody>
        </table>
      </div>
    </div>`);

  document.getElementById('sync').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const r = await api('/api/teacher/sync', { method: 'POST' });
      toast(`Refreshed ${r.refreshed} grading(s).`);
      renderTeacherOverview();
    } catch (err) {
      toast(err.message, true);
      e.target.disabled = false;
    }
  });

  document.querySelectorAll('#grading-table .row-link').forEach((row) => {
    const open = () => { location.hash = `#/teacher/grading/${encodeURIComponent(row.dataset.grading)}`; };
    row.addEventListener('click', open);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  });

  const gs = document.getElementById('grading-search');
  if (gs)
    gs.addEventListener('input', () => {
      const q = gs.value.toLowerCase();
      document.querySelectorAll('#grading-table tbody tr').forEach((tr) => {
        tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    });

  if (c.pending + c.processing > 0) {
    state.pollTimer = setTimeout(async () => {
      try { await api('/api/teacher/sync', { method: 'POST' }); } catch { /* ignore */ }
      if ((location.hash || '').split('?')[0] === '#/teacher') renderTeacherOverview();
    }, (state.config.pollSeconds || 6) * 1000);
  }
}


/* ---------------- upload ---------------- */

/* Any photo the browser can decode is turned into a PNG the marker accepts:
   phone scans and HEIC/GIF/BMP/TIFF files no longer dead-end on upload. */
const MARKER_ACCEPTS = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];

function markerAcceptsFile(file) {
  if (MARKER_ACCEPTS.includes(file.type)) return true;
  return /\.(pdf|png|jpe?g|webp)$/i.test(file.name || '');
}

function decodeImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('the browser could not read that image'));
    };
    img.src = url;
  });
}

async function asMarkerFile(file) {
  if (markerAcceptsFile(file)) return file;
  const isImage = (file.type || '').startsWith('image/') || /\.(heic|heif|gif|bmp|tif|tiff|avif)$/i.test(file.name || '');
  if (!isImage) {
    throw new Error(`${file.name} is not a PDF or an image — the marker only accepts PDF, PNG, JPEG or WEBP.`);
  }
  const img = await decodeImage(file);
  const scale = Math.min(1, 2200 / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round((img.naturalWidth || img.width) * scale));
  canvas.height = Math.max(1, Math.round((img.naturalHeight || img.height) * scale));
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('the image could not be converted'))), 'image/png')
  );
  const name = `${String(file.name || 'page').replace(/\.[^.]+$/, '')}.png`;
  return new File([blob], name, { type: 'image/png' });
}

async function renderTeacherUpload() {
  view.className = 'view';
  mount(skeleton(2));
  const data = await loadOverview();
  const subjects = state.config.reporting.subjects;

  mount(`
    <div class="page-head">
      <div>
        <h1>${esc(COPY.teacher.upload.title)}</h1>
        <p class="sub">${esc(COPY.teacher.upload.lead)}</p>
      </div>
    </div>
    ${consoleTabs('#/teacher/upload')}

    <div class="grid grid-2" style="align-items:start">
      <form class="card card-pad" id="upload-form">
        <div class="grid grid-2" style="gap:0 1rem">
          <div class="field">
            <label for="studentEmail">Student's email <span class="req-badge">required</span></label>
            <input id="studentEmail" name="studentEmail" type="email" inputmode="email" autocapitalize="none"
                   spellcheck="false" list="student-email-list" placeholder="amina.nakato@gmail.com" required />
            <datalist id="student-email-list">
              ${data.students.filter((s) => s.email).map((s) => `<option value="${esc(s.email)}">${esc(s.name)}</option>`).join('')}
            </datalist>
            <div class="hint">This is how the work reaches the student — any teacher can mark them.</div>
          </div>
          <div class="field">
            <label for="studentName">Student's name <span class="muted">(optional)</span></label>
            <input id="studentName" name="studentName" type="text" placeholder="Amina Nakato" />
            <div class="hint">Filled in automatically from your saved students.</div>
          </div>
          <div class="field">
            <label for="subject">Subject</label>
            <input id="subject" name="subject" list="subject-list" placeholder="Mathematics" required />
            <datalist id="subject-list">${subjects.map((s) => `<option value="${esc(s)}">`).join('')}</datalist>
          </div>
          <div class="field">
            <label for="assessmentType">Assessment type</label>
            <input id="assessmentType" name="assessmentType" value="End of term exam" />
          </div>
          <div class="field">
            <label for="termId">Term</label>
            <select id="termId" name="termId">
              ${data.terms.map((t) => `<option value="${esc(t.id)}" ${t.id === state.config.reporting.currentTerm ? 'selected' : ''}>${esc(t.name)} ${esc(t.year)}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label for="level">Level <span class="muted">(optional)</span></label>
            <input id="level" name="level" placeholder="S.2" />
          </div>
        </div>
        <div class="field">
          <label for="instructions">Instructions for the marker <span class="muted">(optional)</span></label>
          <textarea id="instructions" placeholder="Award method marks even when the final answer is wrong."></textarea>
        </div>
        <div class="field">
          <label>Script pages</label>
          <div class="dropzone" id="dropzone" tabindex="0">
            <div class="big">📄</div>
            <div style="font-weight:600;margin-top:.3rem">Drop pages here, or click to choose</div>
            <div class="small muted">PDF, PNG, JPEG or WEBP · one file per page, or a single PDF · max 20 MB each<br />
              Phone photos (HEIC, GIF, BMP, TIFF) are converted to PNG for you.</div>
            <input type="file" id="file-input" multiple accept=".pdf,.png,.jpg,.jpeg,.webp,.heic,.heif,.gif,.bmp,.tif,.tiff,image/*" hidden />
          </div>
          <ul class="filelist" id="filelist"></ul>
        </div>
        <div class="field">
          <label class="checkline"><input type="checkbox" id="add-guide" /> Add a marking guide — marks then follow the guide exactly</label>
          <input type="file" id="guide-input" accept=".pdf,.png,.jpg,.jpeg,.webp,.heic,.heif,.gif,.bmp,.tif,.tiff,image/*" hidden />
        </div>
        <div id="upload-error" class="notice notice-danger small" hidden></div>
        <div id="upload-ok" class="notice small" hidden></div>
        <button class="btn btn-primary btn-block" type="submit" id="submit-btn">${esc(COPY.teacher.upload.primary)}</button>
      </form>

      <div>
        <details class="card card-pad disclose" style="margin-bottom:1rem">
          <summary>${esc(COPY.teacher.upload.help)}</summary>
          <ol class="steps">
            <li>Your files go to <span class="mono">POST /grading</span> using the platform key — you never handle the key.</li>
            <li>GradeScriptUG returns <span class="mono">202 Accepted</span> and a grading id.</li>
            <li>The portal polls <span class="mono">GET /grading/{id}</span> until it is graded.</li>
            <li>The marks are filed under the student's email, so they show up in that email's account.</li>
          </ol>
        </details>
        <div class="notice notice-info small">
          <strong>Tip:</strong> send the marking guide whenever you have one. Without it the marker has to decide
          for itself what a correct answer is worth.
        </div>
        ${data.students.length ? `<div class="notice small" style="margin-top:.8rem">
          Pick from <strong>${data.students.length} saved student${data.students.length === 1 ? '' : 's'}</strong> by typing their email —
          or grade anyone by typing their address.
        </div>` : ''}
      </div>
    </div>`);

  /* Choosing a saved student fills their name in. */
  const emailInput = document.getElementById('studentEmail');
  const nameInput = document.getElementById('studentName');
  const byEmail = new Map(data.students.filter((s) => s.email).map((s) => [s.email.toLowerCase(), s]));
  emailInput.addEventListener('input', () => {
    const match = byEmail.get(emailInput.value.trim().toLowerCase());
    if (match && !nameInput.dataset.touched) nameInput.value = match.name;
  });
  nameInput.addEventListener('input', () => { nameInput.dataset.touched = '1'; });

  const files = [];
  let guide = null;
  const input = document.getElementById('file-input');
  const dropzone = document.getElementById('dropzone');
  const list = document.getElementById('filelist');
  const guideInput = document.getElementById('guide-input');
  const addGuide = document.getElementById('add-guide');

  const renderFiles = () => {
    const items = [
      ...files.map((f, i) => ({ f, i, type: 'SCRIPT' })),
      ...(guide ? [{ f: guide, i: -1, type: 'MARKING_GUIDE' }] : []),
    ];
    list.innerHTML = items.map((it) => `<li>
        <span class="badge ${it.type === 'SCRIPT' ? 'badge-info' : 'badge-warn'}">${it.type === 'SCRIPT' ? `Page ${it.i + 1}` : 'Guide'}</span>
        <span class="name">${esc(it.f.name)}</span>
        <span class="muted small">${(it.f.size / 1024 / 1024).toFixed(1)} MB</span>
        <button type="button" data-remove="${it.i}" aria-label="Remove">✕</button>
      </li>`).join('');
    list.querySelectorAll('button[data-remove]').forEach((b) =>
      b.addEventListener('click', () => {
        const idx = Number(b.dataset.remove);
        if (idx === -1) { guide = null; addGuide.checked = false; }
        else files.splice(idx, 1);
        renderFiles();
      })
    );
  };

  const addFiles = async (fileList) => {
    for (const f of [...fileList]) {
      if (f.size > 20 * 1024 * 1024) {
        toast(`${f.name} is over 20 MB and was skipped.`, true);
        continue;
      }
      if (markerAcceptsFile(f)) {
        files.push(f);
        continue;
      }
      try {
        const converted = await asMarkerFile(f);
        files.push(converted);
        toast(`${f.name} was converted to PNG so the marker can read it.`);
      } catch (err) {
        toast(`${f.name}: ${err.message}`, true);
      }
    }
    renderFiles();
  };

  dropzone.addEventListener('click', () => input.click());
  dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') input.click(); });
  input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });
  ['dragenter', 'dragover'].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('drag'); }));
  dropzone.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));

  addGuide.addEventListener('change', () => {
    if (addGuide.checked) guideInput.click();
    else { guide = null; renderFiles(); }
  });
  guideInput.addEventListener('change', async () => {
    const picked = guideInput.files[0] || null;
    guide = null;
    if (picked) {
      try {
        guide = await asMarkerFile(picked);
      } catch (err) {
        addGuide.checked = false;
        toast(`${picked.name}: ${err.message}`, true);
      }
    }
    if (!guide) addGuide.checked = false;
    renderFiles();
  });

  const errorBox = document.getElementById('upload-error');
  const okBox = document.getElementById('upload-ok');
  const showError = (html) => {
    if (!errorBox) return;
    errorBox.hidden = false;
    errorBox.innerHTML = html;
    if (okBox) okBox.hidden = true;
  };
  const showOk = (html) => {
    if (!okBox) return;
    okBox.hidden = false;
    okBox.innerHTML = html;
    if (errorBox) errorBox.hidden = true;
  };

  document.getElementById('upload-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = emailInput.value.trim();
    if (!email) {
      showError("Add the student's email first — that is how the marked work reaches them.");
      emailInput.focus();
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      showError(`“${esc(email)}” does not look like an email address.`);
      emailInput.focus();
      return;
    }
    if (!files.length) {
      showError('Attach at least one script page — PDF, PNG, JPEG or WEBP, or any photo.');
      return;
    }
    const btn = document.getElementById('submit-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Uploading…';
    if (errorBox) errorBox.hidden = true;

    const fd = new FormData();
    fd.append('studentEmail', email);
    fd.append('studentName', nameInput.value.trim());
    fd.append('subject', document.getElementById('subject').value.trim());
    fd.append('assessmentType', document.getElementById('assessmentType').value.trim());
    fd.append('termId', document.getElementById('termId').value);
    fd.append('level', document.getElementById('level').value.trim());
    fd.append('instructions', document.getElementById('instructions').value.trim());

    let n = 0;
    files.forEach((f) => {
      fd.append(`attachments[${n}][file]`, f, f.name);
      fd.append(`attachments[${n}][type]`, 'SCRIPT');
      fd.append(`attachments[${n}][index]`, String(n + 1));
      n += 1;
    });
    if (guide) {
      fd.append(`attachments[${n}][file]`, guide, guide.name);
      fd.append(`attachments[${n}][type]`, 'MARKING_GUIDE');
      n += 1;
    }

    try {
      const queued = await api('/api/teacher/gradings', { method: 'POST', body: fd });
      state.overview = null;
      const id = queued?.grading?.id;
      showOk(
        `Queued for <strong>${esc(email)}</strong> — the marker starts straight away and the marks land in their account. ` +
          (id ? `<a href="#/teacher/marked">Follow it under Marked work →</a>` : '')
      );
      toast(`Queued for ${email} — marks appear in their account automatically.`);
      setTimeout(() => {
        if (location.hash.startsWith('#/teacher/upload')) location.hash = '#/teacher';
      }, 1200);
    } catch (err) {
      const reason = err.message || 'The upload failed.';
      showError(
        `<strong>Grading was not queued.</strong> ${esc(reason)}` +
          (err.network
            ? '<br />Your files are still attached — press <em>Queue grading</em> again.'
            : '<br />Nothing was saved. Fix the point above and try again.') +
          (err.status === 413 ? '<br />That file is too large for the server — try fewer or smaller pages.' : '')
      );
      toast(reason, true);
      btn.disabled = false;
      btn.textContent = 'Queue grading';
    }
  });
}

/* ---------------- platform admin ---------------- */

async function renderAdminPlatform() {
  if (state.user?.role !== 'admin') {
    location.hash = '#/teacher';
    return;
  }
  view.className = 'view';
  mount(skeleton(3));
  const data = await api('/api/admin/overview');
  const k = data.key;
  const c = data.counts;

  const keyState = k.connected
    ? `<span class="chip chip-ok">Connected</span>`
    : `<span class="chip chip-warn">Demo mode</span>`;

  mount(`
    <div class="page-head">
      <div>
        <h1>${esc(COPY.admin.title)}</h1>
        <p class="sub">${esc(COPY.admin.lead)}</p>
      </div>
      <div class="spacer"></div>
      <a class="btn btn-ghost btn-sm" href="#/teacher">Go to my console →</a>
    </div>

    <div class="stats admin-stats">
      <div class="stat"><div class="n">${c.teachers}</div><div class="l">Teachers</div></div>
      <div class="stat"><div class="n">${c.students}</div><div class="l">Student accounts</div></div>
      <div class="stat"><div class="n">${c.completed}</div><div class="l">Scripts marked</div></div>
      <div class="stat"><div class="n">${c.emailsAddressed}</div><div class="l">Student emails addressed</div></div>
    </div>

    <div class="grid grid-2" style="align-items:start">
      <div class="card card-pad">
        <div style="display:flex;align-items:center;gap:.6rem;margin-bottom:.8rem">
          <h3 style="font-size:1rem;margin:0">GradeScriptUG platform key</h3>
          ${keyState}
        </div>

        <div class="keybox" style="margin-bottom:1rem">
          <span class="status-dot ${k.status === 'ok' ? 'dot-ok' : k.status === 'invalid' ? 'dot-warn' : 'dot-off'}"></span>
          <div style="flex:1">
            <div style="font-weight:600;font-size:.9375rem">
              ${k.connected ? `Active · <span class="mono">${esc(k.hint || 'from environment')}</span>` : 'No key connected'}
            </div>
            <div class="muted small">
              ${k.connected
                ? `Every teacher's uploads run on this key. ${k.setAt ? 'Saved ' + esc(fmtDate(k.setAt)) + '.' : ''}`
                : 'Uploads are simulated for everyone until you connect a key.'}
            </div>
          </div>
        </div>

        <form id="admin-key-form">
          <div class="field">
            <label for="adminApiKey">${k.connected ? 'Replace the key' : 'Connect the key'}</label>
            <input id="adminApiKey" type="password" placeholder="gsk_3f9a1c2e_5b8d0e7f…" autocomplete="off" spellcheck="false" />
            <div class="hint">Format <span class="mono">gsk_&lt;8 hex&gt;_&lt;32 hex&gt;</span>. Verified against the API, then stored server-side only.</div>
          </div>
          <div style="display:flex;gap:.5rem;flex-wrap:wrap">
            <button class="btn btn-primary" type="submit" id="admin-save-key">Verify &amp; save</button>
            ${k.connected && k.source === 'admin' ? '<button class="btn btn-danger" type="button" id="admin-remove-key">Disconnect</button>' : ''}
          </div>
        </form>
        ${k.source === 'environment' ? `
          <div class="notice notice-info small" style="margin-top:.9rem">
            The key comes from <span class="mono">GRADESCRIPT_API_KEY</span> in the environment, which takes priority over anything saved here.
          </div>` : ''}
      </div>

      <div>
        <div class="card card-pad" style="margin-bottom:1rem">
          <h3 style="font-size:1rem;margin-bottom:.6rem">How grading flows</h3>
          <ol class="steps">
            <li>A teacher uploads a script with the <strong>student's email</strong>.</li>
            <li>Volyx posts it to GradeScriptUG using <strong>your key</strong>.</li>
            <li>The marks are filed under that email address.</li>
            <li>The student signs up with that email and sees it — whoever marked it.</li>
          </ol>
        </div>

        <div class="card card-pad">
          <h3 style="font-size:1rem;margin-bottom:.6rem">Platform</h3>
          <div class="kv"><span>Administrator</span><strong>${esc(data.admin.email)}</strong></div>
          <div class="kv"><span>Accounts</span><strong>${c.accounts}</strong></div>
          <div class="kv"><span>Students tracked by teachers</span><strong>${c.studentsTracked}</strong></div>
          <div class="kv"><span>Gradings in flight</span><strong>${c.pending}</strong></div>
          <div class="kv"><span>Total gradings</span><strong>${c.gradings}</strong></div>
          <div class="kv"><span>Mode</span><strong>${data.demo ? 'Demo (no key)' : 'Live'}</strong></div>
        </div>
      </div>
    </div>`);

  document.getElementById('admin-key-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('admin-save-key');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Verifying…';
    try {
      const res = await api('/api/admin/key', {
        method: 'POST',
        body: { apiKey: document.getElementById('adminApiKey').value.trim() },
      });
      toast(res.message || 'Key saved.');
      state.config = await api('/api/config');
      renderAdminPlatform();
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false;
      btn.textContent = 'Verify & save';
    }
  });

  const rm = document.getElementById('admin-remove-key');
  if (rm)
    rm.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Disconnect the platform key?',
        message: 'Every teacher drops back to simulated marking until a key is connected again.',
        confirmLabel: 'Disconnect',
        danger: true,
      });
      if (!ok) return;
      await api('/api/admin/key', { method: 'DELETE' });
      toast('Disconnected. The platform is in demo mode.');
      state.config = await api('/api/config');
      renderAdminPlatform();
    });
}

/* ---------------- results ---------------- */

async function renderTeacherResults() {
  view.className = 'view';
  mount(skeleton(3));
  const data = await loadOverview();
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const termId = params.get('term') || state.config.reporting.currentTerm;
  const classId = params.get('class') || data.classes[0].id;

  const report = await api(`/api/teacher/reports?termId=${encodeURIComponent(termId)}&classId=${encodeURIComponent(classId)}`);

  const rows = [...report.students]
    .sort((a, b) => (b.average || 0) - (a.average || 0))
    .map((s) => `
    <tr data-search="${esc(`${s.name} ${s.email} ${s.studentNumber}`.toLowerCase())}">
      <td class="mono muted small">${s.position ?? '—'}</td>
      <td><strong>${esc(s.name)}</strong><div class="muted small">${esc(s.email)}</div></td>
      <td class="mono small hide-sm">${esc(s.studentNumber)}</td>
      <td class="num">${s.subjects}</td>
      <td class="num"><strong>${s.average ? s.average + '%' : '—'}</strong></td>
      <td>${s.flagged ? `<span class="badge badge-warn">${s.flagged} to review</span>` : '<span class="badge badge-ok">clear</span>'}</td>
      <td class="actions"><a class="btn btn-ghost btn-sm" href="#/teacher/report/${encodeURIComponent(s.id)}/${encodeURIComponent(termId)}">View</a></td>
    </tr>`).join('');

  mount(`
    <div class="page-head">
      <div>
        <h1>${esc(COPY.teacher.results.title)}</h1>
        <p class="sub">${esc(COPY.teacher.results.lead)}</p>
      </div>
    </div>
    ${consoleTabs('#/teacher/results')}

    <div class="card card-pad filter-bar">
      <div class="field" style="margin:0;min-width:170px">
        <label for="term">Term</label>
        <select id="term">${data.terms.map((t) => `<option value="${esc(t.id)}" ${t.id === termId ? 'selected' : ''}>${esc(t.name)} ${esc(t.year)}</option>`).join('')}</select>
      </div>
      <div class="field" style="margin:0;min-width:170px">
        <label for="class">Class</label>
        <select id="class">${data.classes.map((c) => `<option value="${esc(c.id)}" ${c.id === classId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
      </div>
      <div class="filter-actions">
        <span class="badge ${report.published ? 'badge-ok' : 'badge-muted'}">${report.published ? 'Published to students' : 'Not published'}</span>
        <button class="btn ${report.published ? 'btn-ghost' : 'btn-primary'} btn-sm" id="publish" type="button">
          ${report.published ? 'Unpublish' : 'Publish to students'}
        </button>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>${report.students.length} student${report.students.length === 1 ? '' : 's'}</h2>
        <input class="search" id="student-search" placeholder="Search a student…" aria-label="Search students" />
      </div>
      <div class="table-scroll">
        <table class="data" id="student-table">
          <thead><tr><th>Pos</th><th>Student</th><th class="hide-sm">No.</th><th class="right">Subjects</th><th class="right">Average</th><th>Review</th><th></th></tr></thead>
          <tbody>${rows || `<tr><td colspan="7" class="muted" style="text-align:center;padding:2rem">No students in this class. <a href="#/teacher/students">Add one →</a></td></tr>`}</tbody>
        </table>
      </div>
    </div>`);

  const go = () => {
    const t = document.getElementById('term').value;
    const cl = document.getElementById('class').value;
    location.hash = `#/teacher/results?term=${encodeURIComponent(t)}&class=${encodeURIComponent(cl)}`;
    renderTeacherResults();
  };
  document.getElementById('term').addEventListener('change', go);
  document.getElementById('class').addEventListener('change', go);

  const ss = document.getElementById('student-search');
  ss.addEventListener('input', () => {
    const q = ss.value.toLowerCase();
    document.querySelectorAll('#student-table tbody tr').forEach((tr) => {
      tr.style.display = (tr.dataset.search || '').includes(q) ? '' : 'none';
    });
  });

  document.getElementById('publish').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: report.published ? 'Unpublish these results?' : 'Publish results to students?',
      message: report.published
        ? 'Students in this class will no longer be able to open this term until you publish again.'
        : `Every student in this class will be able to open their ${termId} report card immediately.`,
      confirmLabel: report.published ? 'Unpublish' : 'Publish',
      danger: report.published,
    });
    if (!ok) return;
    try {
      await api('/api/teacher/publish', { method: 'POST', body: { termId, classId, published: !report.published } });
      toast(report.published ? 'Results hidden from students.' : 'Published — students can now see their report cards.');
      renderTeacherResults();
    } catch (err) { toast(err.message, true); }
  });
}

async function renderTeacherReport(studentId, termId) {
  view.className = 'view';
  mount(skeleton(4));
  const card = await api(`/api/teacher/report?studentId=${encodeURIComponent(studentId)}&termId=${encodeURIComponent(termId)}`);
  mount(`
    <div class="report-toolbar">
      <a class="btn btn-ghost btn-sm" href="#/teacher/results">← Back to class</a>
      <span class="badge ${card.published ? 'badge-ok' : 'badge-muted'}">${card.published ? 'Published' : 'Draft — student cannot see this'}</span>
      <div class="spacer"></div>
      <button class="btn btn-primary btn-sm" id="print-btn">Print / save as PDF</button>
    </div>
    ${reportCardHTML(card)}
    ${markingDetailHTML(card)}`);
  document.getElementById('print-btn').addEventListener('click', () => window.print());
}

/* ---------------- settings ---------------- */

async function renderTeacherSettings() {
  view.className = 'view';
  mount(skeleton(2));
  const data = await loadOverview();
  const k = data.key;
  const isAdmin = state.user?.role === 'admin';

  mount(`
    <div class="page-head"><div><h1>${esc(COPY.teacher.settings.title)}</h1><p class="sub">${esc(COPY.teacher.settings.lead)}</p></div></div>
    ${consoleTabs('#/teacher/settings')}

    <div class="grid grid-2" style="align-items:start">
      <div>
        <div class="card card-pad" style="margin-bottom:1rem">
          <h3 style="font-size:1rem;margin-bottom:.7rem">Account</h3>
          <div class="keybox">
            <div style="flex:1">
              <div style="font-weight:600;font-size:.9375rem">${esc(state.user.name || 'Account')}</div>
              <div class="muted small">${esc(state.user.email)} · verified ${state.user.emailVerified ? '✓' : '—'}</div>
            </div>
          </div>
          <p class="small muted" style="margin:.8rem 0 0">
            ${state.user.studentCount} student${state.user.studentCount === 1 ? '' : 's'} registered to this account.
            Other accounts cannot see them.
          </p>
        </div>

        <div class="card card-pad">
          <h3 style="font-size:1rem;margin-bottom:.7rem">GradeScriptUG connection</h3>
          <div class="keybox" style="margin-bottom:${isAdmin ? '1rem' : '0'}">
            <span class="status-dot ${k.status === 'ok' ? 'dot-ok' : k.status === 'invalid' ? 'dot-warn' : 'dot-off'}"></span>
            <div style="flex:1">
              <div style="font-weight:600;font-size:.9375rem">
                ${k.status === 'ok' ? `Connected · <span class="mono">${esc(k.hint)}</span>` : k.status === 'invalid' ? 'Key rejected by GradeScriptUG' : 'Demo mode — no platform key connected'}
              </div>
              <div class="muted small">${esc(k.message || (isAdmin ? 'Uploads are simulated until you connect a key.' : 'Uploads are simulated until the administrator connects a key.'))}</div>
            </div>
          </div>
          ${isAdmin ? `
          <form id="key-form">
            <div class="field">
              <label for="apiKey">Platform API key</label>
              <input id="apiKey" type="password" placeholder="gsk_3f9a1c2e_5b8d0e7f…" autocomplete="off" spellcheck="false" />
              <div class="hint">Format <span class="mono">gsk_&lt;8 hex&gt;_&lt;32 hex&gt;</span>. Held on the server and used for every teacher's uploads.</div>
            </div>
            <div style="display:flex;gap:.5rem">
              <button class="btn btn-primary" type="submit" id="save-key">Verify &amp; save</button>
              ${k.status === 'ok' ? '<button class="btn btn-danger" type="button" id="remove-key">Disconnect</button>' : ''}
            </div>
          </form>` : `
          <div class="notice notice-info small" style="margin:0">
            <strong>One key, managed centrally.</strong>
            The API key belongs to the platform administrator and is used for your uploads automatically —
            you never see or handle it. Ask them to connect it if marking is in demo mode.
          </div>`}
        </div>
      </div>

      <div>
        <div class="card card-pad" style="margin-bottom:1rem">
          <h3 style="font-size:1rem;margin-bottom:.6rem">Sign-in · Google</h3>
          <p class="small muted" style="margin-bottom:.6rem">
            Optional. Add a Google OAuth Client ID to let people sign in with Google instead of a password.
          </p>
          <form id="google-form">
            <div class="field" style="margin-bottom:.6rem">
              <label for="googleClientId">Google OAuth Client ID</label>
              <input id="googleClientId" type="text" spellcheck="false" autocomplete="off"
                     placeholder="1234567890-abc123.apps.googleusercontent.com"
                     value="${esc(state.config.googleClientId || '')}" />
            </div>
            <button class="btn btn-ghost btn-sm" type="submit" id="save-google">Save Client ID</button>
          </form>
        </div>

        <div class="card card-pad" style="margin-bottom:1rem">
          <h3 style="font-size:1rem;margin-bottom:.6rem">Your data</h3>
          <p class="small muted" style="margin-bottom:.7rem">
            Delete every script marked for your students and unpublish your terms. Other accounts are untouched.
          </p>
          <div style="display:flex;gap:.5rem;flex-wrap:wrap">
            <button class="btn btn-danger btn-sm" id="clear-results">Clear all results</button>
            <button class="btn btn-ghost btn-sm" id="reset-demo">Remove my students</button>
          </div>
        </div>

        <details class="card card-pad disclose" style="margin-bottom:1rem">
          <summary>Activity &amp; diagnostics</summary>
          <p class="small muted" style="margin:.5rem 0 .6rem">
            Recent uploads, refusals and browser errors. Copy this when something fails.
          </p>
          <pre id="diag-log" class="diag-log">Loading…</pre>
          <button class="btn btn-ghost btn-sm" id="diag-refresh" style="margin-top:.5rem">Refresh</button>
        </details>

        <div class="card card-pad">
          <h3 style="font-size:1rem;margin-bottom:.6rem">Mail</h3>
          <p class="small muted" style="margin:0">
            Verification codes are sent by <span class="mono">${esc(state.config.mailMode)}</span>${
              state.config.mailMode === 'dev' ? ' — in development the code is shown on screen and printed in the server log. Set RESEND_API_KEY to deliver real email.' : '.'
            }
          </p>
        </div>
      </div>
    </div>`);

  const loadDiag = async () => {
    const box = document.getElementById('diag-log');
    if (!box) return;
    try {
      const diag = await api('/api/diagnostics');
      const rows = (diag.entries || [])
        .filter((e) => e.kind !== 'http' || e.status >= 400)
        .slice(-25)
        .map((e) => {
          const at = String(e.at || '').slice(11, 19);
          if (e.kind === 'grading.queued') return `${at}  queued   ${e.id} · ${e.files} file(s) · ${e.mode}`;
          if (e.kind === 'grading.error') return `${at}  REFUSED  ${e.message}`;
          if (e.kind === 'client-error') return `${at}  browser  ${e.message} (${e.where})`;
          if (e.kind === 'http') return `${at}  ${String(e.method).padEnd(4)} ${e.path} ${e.status}`;
          return `${at}  ${e.kind}`;
        });
      box.textContent = rows.length
        ? `${rows.join('\n')}\n\nserver up ${diag.uptime}s · ${diag.demo ? 'demo mode' : 'live marking'}`
        : 'Nothing logged yet — queue a grading and refresh.';
    } catch (err) {
      box.textContent = `Could not read the log: ${err.message}`;
    }
  };
  loadDiag();
  document.getElementById('diag-refresh')?.addEventListener('click', loadDiag);

  const keyForm = document.getElementById('key-form');
  if (keyForm) keyForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('save-key');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Verifying…';
    try {
      const res = await api('/api/admin/key', { method: 'POST', body: { apiKey: document.getElementById('apiKey').value.trim() } });
      toast(res.message || 'Key saved.');
      state.overview = null;
      state.config = await api('/api/config');
      renderTeacherSettings();
    } catch (err) {
      toast(err.message, true);
      state.overview = null;
      state.config = await api('/api/config');
      renderTeacherSettings();
    }
  });

  const remove = document.getElementById('remove-key');
  if (remove)
    remove.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Disconnect the API key?',
        message: 'Volyx will go back to demo mode until you connect a key again.',
        confirmLabel: 'Disconnect',
        danger: true,
      });
      if (!ok) return;
      await api('/api/admin/key', { method: 'DELETE' });
      toast('Disconnected. Back to demo mode.');
      state.overview = null;
      state.config = await api('/api/config');
      renderTeacherSettings();
    });

  document.getElementById('google-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('save-google');
    btn.disabled = true;
    try {
      const res = await api('/api/settings/google', {
        method: 'POST',
        body: { clientId: document.getElementById('googleClientId').value.trim() },
      });
      state.config = await api('/api/config');
      toast(res.googleClientId ? 'Google sign-in enabled.' : 'Google sign-in removed.');
      renderTeacherSettings();
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false;
    }
  });

  document.getElementById('clear-results').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Delete all results?',
      message: 'Every grading recorded for your students will be deleted and your terms unpublished. Report cards become empty. This cannot be undone.',
      confirmLabel: 'Delete all results',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await api('/api/teacher/clear-results', { method: 'POST' });
      state.overview = null;
      toast(`Deleted ${res.removed} grading(s).`);
      renderTeacherSettings();
    } catch (err) { toast(err.message, true); }
  });

  document.getElementById('reset-demo').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Remove all your students?',
      message: 'Every student on your account, along with their gradings, will be deleted. Your account and API key stay.',
      confirmLabel: 'Remove my students',
      danger: true,
    });
    if (!ok) return;
    await api('/api/teacher/reset-demo', { method: 'POST' });
    state.overview = null;
    toast('Your students were removed.');
    renderTeacherSettings();
  });
}

/* ---------------- boot ---------------- */

async function boot() {
  applyTheme(store.get('volyx.theme') || (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  try {
    state.config = await api('/api/config');
    const me = await api('/api/me');
    state.user = me.user;
    if (!state.user && state.token) {
      store.del('volyx.token');
      state.token = '';
    }
    document.title = `${state.config.platform.name} · ${state.config.school.shortName}`;
  } catch (err) {
    view.innerHTML = `<div class="notice notice-danger">Cannot reach the server: ${esc(err.message)}</div>`;
    return;
  }
  renderTopbar();
  window.addEventListener('hashchange', route);
  route();
}

boot();
