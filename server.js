/* ============================================================
   VOLYX SERVER
   Dependency-free Node.js.

   1. Accounts: sign up with an email → 6-digit code by email →
      verify → login with email + password.
   2. Every student belongs to exactly one account (ownerId).
      All reads and writes are scoped to the signed-in account.
   ============================================================ */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { db, persist, uid, resetDb } from './lib/db.js';
import {
  seedDatabase,
  DEMO_EMAIL,
  DEMO_PASSWORD,
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
} from './lib/seed.js';
import { parseMultipart, getBoundary } from './lib/multipart.js';
import {
  SCHOOL,
  PLATFORM,
  GRADING_SCALE,
  DIVISIONS,
  REPORTING,
  GRADESCRIPT,
  STUDENT_LOGIN_DOMAIN,
  TEMP_PASSWORD_DAYS,
  PLATFORM_ADMIN_EMAIL,
} from './config/school.js';
import {
  isDemo,
  currentKey,
  keyHint,
  looksValidKey,
  verifyKey,
  createGrading,
  getGrading,
  retryGrading,
  deleteGrading,
  demoCreateGrading,
  advanceDemoGrading,
  markKeyStatus,
  ApiError,
} from './lib/gradescript.js';
import { buildReportCard, rankCohort, subjectRows, FINISHED } from './lib/report.js';
import {
  normEmail,
  validEmail,
  hashPassword,
  verifyPassword,
  passwordProblem,
  makeCode,
  hashCode,
  codeMatches,
  newToken,
  rateLimited,
  resetRateLimit,
  CODE_TTL_MINUTES,
  CODE_MAX_ATTEMPTS,
  SESSION_HOURS,
} from './lib/auth.js';
import { sendVerificationCode, sendStudentCredentials, mailMode, devCodeAllowed } from './lib/mailer.js';
import { buildLoginEmail, tempPassword, studentAccount } from './lib/credentials.js';
import { savePages, pagePath, contentTypeFor, removePages } from './lib/storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

/* ---------------- diagnostics log ----------------
   Everything that goes wrong with an upload is written here, so a failure
   can be explained after the fact instead of guessed at. */

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(ROOT_DIR, 'data');
const LOG_FILE = path.join(DATA_DIR, 'volyx.log');
const LOG_LIMIT = 2 * 1024 * 1024;

function syslog(kind, detail = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), kind, ...detail });
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    try {
      if (fs.statSync(LOG_FILE).size > LOG_LIMIT) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    } catch { /* no log yet */ }
    fs.appendFileSync(LOG_FILE, `${line}\n`);
  } catch { /* logging must never break a request */ }
  if (kind !== 'http' || detail.status >= 400) console.log(`[${kind}] ${line.slice(0, 220)}`);
}

function tailLog(limit = 60) {
  try {
    return fs
      .readFileSync(LOG_FILE, 'utf8')
      .trim()
      .split('\n')
      .slice(-limit)
      .map((l) => {
        try { return JSON.parse(l); } catch { return { raw: l }; }
      });
  } catch {
    return [];
  }
}

/* ---------------- boot ---------------- */

function boot() {
  const d = db();
  if (!d.users.length) {
    Object.assign(d, seedDatabase());
    persist();
  }

  // The platform administrator must always exist, and must be the only
  // account holding the role — the address in config/school.js decides.
  let admin = d.users.find((u) => String(u.email).toLowerCase() === ADMIN_EMAIL);
  if (!admin) {
    const { salt, hash } = hashPassword(ADMIN_PASSWORD);
    admin = {
      id: uid('u'),
      email: ADMIN_EMAIL,
      name: 'Platform Admin',
      role: 'admin',
      emailVerified: true,
      verifiedAt: new Date().toISOString(),
      passwordSalt: salt,
      passwordHash: hash,
      provider: 'password',
      isPlatformAdmin: true,
      createdAt: new Date().toISOString(),
    };
    d.users.push(admin);
    persist();
  } else if (admin.role !== 'admin') {
    admin.role = 'admin';
    admin.isPlatformAdmin = true;
    persist();
  }
  for (const u of d.users) {
    if (u.id !== admin.id && u.isPlatformAdmin) {
      u.isPlatformAdmin = false;
      if (u.role === 'admin') u.role = 'teacher';
      persist();
    }
  }
  if (process.env.GRADESCRIPT_API_KEY && looksValidKey(process.env.GRADESCRIPT_API_KEY)) {
    d.settings.apiKey = process.env.GRADESCRIPT_API_KEY.trim();
    persist();
  }
}
boot();

/* ---------------- helpers ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((pair) => {
    const i = pair.indexOf('=');
    if (i > 0) out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  });
  return out;
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Request too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON body'), { status: 400 });
  }
}

/* ---------------- sessions ---------------- */

function session(req) {
  const d = db();
  const sid = req.headers['x-session'] || parseCookies(req).sid;
  if (!sid) return null;
  const s = d.sessions[sid];
  if (!s) return null;
  if (new Date(s.expires) < new Date()) {
    delete d.sessions[sid];
    persist();
    return null;
  }
  return { ...s, sid };
}

function requireAuth(req, res) {
  const s = session(req);
  if (!s) {
    json(res, 401, { error: 'Please sign in.' });
    return null;
  }
  const user = db().users.find((u) => u.id === s.userId);
  if (!user) {
    json(res, 401, { error: 'Your account no longer exists.' });
    return null;
  }
  return { session: s, user };
}

/* ---------------- RBAC ---------------- */

/* Paths a student session may still call. Everything else is refused
   before a handler ever sees the request. */
const STUDENT_ALLOWED = [
  /^\/api\/student\//,          // their own read-only portal
  /^\/api\/me$/,
  /^\/api\/config$/,
  /^\/api\/health$/,
  /^\/api\/auth\//,            // logout, change-password, re-auth
];

const STUDENT_ONLY = /^\/api\/student\//;
const ADMIN_ONLY = /^\/api\/admin\//;

/**
 * Single choke point for role isolation. Returns false when the response
 * has already been written.
 */
function rbacGate(req, res) {
  const s = session(req);
  if (!s) return true; // no session: handlers answer 401 themselves
  const user = db().users.find((u) => u.id === s.userId);
  if (!user) return true;

  const role = roleOf(user);
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/api/client-error') return true;

  if (role === 'student') {
    const allowed = STUDENT_ALLOWED.some((rx) => rx.test(p));
    if (allowed) return true;
    json(res, 403, {
      error: 'Student accounts are read-only: they can only view results addressed to their own email.',
      code: 'read-only-role',
      role: 'student',
      home: '#/portal',
    });
    return false;
  }

  // Teachers and admins cannot impersonate the student portal.
  if (STUDENT_ONLY.test(p)) {
    json(res, 403, {
      error: "The student portal is for student accounts. Sign in with a student's email to see it.",
      code: 'teacher-not-student',
      role,
      home: '#/teacher',
    });
    return false;
  }

  // Only the platform administrator touches the platform key and settings.
  if (ADMIN_ONLY.test(p) && role !== 'admin') {
    json(res, 403, {
      error: 'Only the platform administrator can manage the GradeScriptUG key.',
      code: 'admin-only',
      role,
      home: '#/teacher',
    });
    return false;
  }

  return true;
}

function requireStudent(req, res) {
  const auth = requireAuth(req, res);
  if (!auth) return null;
  if (roleOf(auth.user) !== 'student') {
    json(res, 403, {
      error: "The student portal is for student accounts. Sign in with a student's email to see it.",
      code: 'teacher-not-student',
    });
    return null;
  }
  return { ...auth, emails: studentEmails(auth.user) };
}

function requireAdmin(req, res) {
  const auth = requireAuth(req, res);
  if (!auth) return null;
  if (roleOf(auth.user) !== 'admin') {
    json(res, 403, {
      error: 'Only the platform administrator can manage the GradeScriptUG key.',
      code: 'admin-only',
    });
    return null;
  }
  return auth;
}

function issueSession(userId) {
  const d = db();
  const sid = newToken();
  d.sessions[sid] = {
    userId,
    created: new Date().toISOString(),
    expires: new Date(Date.now() + SESSION_HOURS * 3600 * 1000).toISOString(),
  };
  persist();
  return sid;
}

function sessionCookie(sid) {
  return `sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS * 3600}${
    process.env.NODE_ENV === 'production' ? '; Secure' : ''
  }`;
}

/* ---------------- users & students ---------------- */

const ROLE_HOME = { admin: '#/teacher', teacher: '#/teacher', student: '#/portal' };

/* 'guardian' is the schema-3 name for the same thing as 'teacher'. */
function roleOf(user) {
  if (!user) return 'teacher';
  if (user.role === 'student') return 'student';
  if (user.role === 'admin' || user.isPlatformAdmin) return 'admin';
  return 'teacher';
}

const canTeach = (role) => role === 'admin' || role === 'teacher';

/** Every address a student account answers to. */
function studentEmails(user) {
  const set = new Set([String(user.email || '').toLowerCase()]);
  for (const s of db().students) {
    if (!s.email) continue;
    if (s.accountId === user.id || s.id === user.studentId) set.add(String(s.email).toLowerCase());
  }
  return set;
}

function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    name: u.name || '',
    role: roleOf(u),
    emailVerified: Boolean(u.emailVerified),
    provider: u.provider || 'password',
    mustChangePassword: Boolean(u.mustChangePassword),
    createdAt: u.createdAt,
  };
}

/** The student profile a student account may view. Strictly one, by id. */
function linkedStudentFor(user) {
  if (!user) return null;
  const d = db();
  if (user.studentId) {
    const byId = d.students.find((s) => s.id === user.studentId);
    if (byId) return byId;
  }
  return d.students.find((s) => s.accountId === user.id) || null;
}

function meFor(user) {
  const linked = linkedStudentFor(user);
  const role = roleOf(user);
  const d = db();
  const addressed = role === 'student'
    ? d.gradings.filter((g) => gradingBelongsTo(g, studentEmails(user)) && FINISHED.includes(g.status)).length
    : 0;

  return {
    ...publicUser(user),
    role,
    home: ROLE_HOME[role],
    canManageKey: role === 'admin',
    canTeach: canTeach(role),
    linkedStudent: linked
      ? { id: linked.id, name: linked.name, className: linked.className, studentNumber: linked.studentNumber }
      : null,
    studentCount: role === 'student' ? 0 : d.students.filter((s) => s.ownerId === user.id).length,
    resultCount: addressed,
    keyStatus: role === 'student' ? undefined : d.settings.keyStatus,
  };
}

/**
 * Legacy-friendly linking: a verified account whose email is the contact
 * address on an unclaimed student profile becomes that student — but only
 * if the account does not already manage students of its own.
 */
function settleRole(user, accountType = '') {
  const email = String(user.email || '').toLowerCase();

  // The platform administrator is decided by address and nothing else.
  if (email === PLATFORM_ADMIN_EMAIL) {
    user.role = 'admin';
    user.isPlatformAdmin = true;
    persist();
    return user;
  }

  if (user.role && user.role !== 'guardian') return user;

  const d = db();

  // The explicit choice made at signup wins.
  if (String(accountType || '').toLowerCase() === 'student') {
    user.role = 'student';
    persist();
    return user;
  }

  // Anyone who already manages students is a teacher, full stop.
  if (d.students.some((s) => s.ownerId === user.id)) {
    user.role = 'teacher';
    persist();
    return user;
  }

  // A student who prefers their own email (password or Google) instead of the
  // generated school login: link them to the one profile carrying that
  // address — but never to a profile another account already speaks for.
  const claimable = d.students.filter((s) => {
    if (String(s.email || '').toLowerCase() !== email) return false;
    if (s.ownerId === user.id) return false;
    const acc = s.accountId ? d.users.find((u) => u.id === s.accountId) : null;
    return !acc || acc.id === user.id || acc.provider === 'temp-password';
  });

  if (claimable.length === 1) {
    user.role = 'student';
    user.studentId = claimable[0].id;
  } else {
    user.role = 'teacher';
  }
  persist();
  return user;
}

function publicStudent(s) {
  return {
    id: s.id,
    name: s.name,
    email: s.email,
    studentNumber: s.studentNumber,
    classId: s.classId,
    className: s.className,
    level: s.level,
    loginEmail: s.loginEmail || null,
    hasLogin: Boolean(s.accountId),
    credentialIssuedAt: s.credentialIssuedAt || null,
    credentialExpiresAt: s.credentialExpiresAt || null,
    createdAt: s.createdAt,
  };
}

/**
 * Mints (or rotates) a student login. The plain password is returned to the
 * caller exactly once — only its hash is stored.
 */
function issueStudentLogin(d, student, guardianId) {
  const now = new Date().toISOString();
  const taken = new Set(d.users.map((u) => u.email));
  const password = tempPassword();
  const { salt, hash } = hashPassword(password);

  let account = student.accountId ? d.users.find((u) => u.id === student.accountId) : null;

  if (!account) {
    const loginEmail = student.loginEmail || buildLoginEmail(student.name, STUDENT_LOGIN_DOMAIN, taken);
    account = studentAccount({
      student,
      guardianId,
      loginEmail,
      passwordSalt: salt,
      passwordHash: hash,
      now,
    });
    d.users.push(account);
    student.accountId = account.id;
    student.loginEmail = loginEmail;
  } else {
    account.passwordSalt = salt;
    account.passwordHash = hash;
    account.provider = 'temp-password';
    account.mustChangePassword = true;
    account.emailVerified = true;
    account.role = 'student';
    account.studentId = student.id;
    account.ownerId = guardianId;
    // Rotating a credential ends every session it opened.
    for (const sid of Object.keys(d.sessions)) {
      if (d.sessions[sid].userId === account.id) delete d.sessions[sid];
    }
  }

  student.credentialIssuedAt = now;
  student.credentialExpiresAt = new Date(Date.now() + TEMP_PASSWORD_DAYS * 864e5).toISOString();

  return {
    account,
    credentials: {
      loginEmail: account.email,
      password,
      mustChangePassword: true,
      issuedAt: now,
      expiresAt: student.credentialExpiresAt,
      expiresInDays: TEMP_PASSWORD_DAYS,
    },
  };
}

/** Only ever called with an authenticated owner. */
function ownedStudents(userId) {
  return db().students.filter((s) => s.ownerId === userId);
}

function findOwnedStudent(userId, studentId) {
  return db().students.find((s) => s.id === studentId && s.ownerId === userId) || null;
}

function publishedClasses(term, ownerId) {
  return (term.published && term.published[ownerId]) || [];
}

/* ---------------- student ↔ grading join ---------------- */

const teacherName = (ownerId) => {
  const u = db().users.find((x) => x.id === ownerId);
  return u?.name || u?.email || 'Teacher';
};

const teacherSummary = (gradings) => {
  const seen = new Map();
  for (const g of gradings) {
    if (!g.ownerId || seen.has(g.ownerId)) continue;
    seen.set(g.ownerId, { id: g.ownerId, name: teacherName(g.ownerId) });
  }
  return [...seen.values()];
};

/** Is this grading addressed to one of the student's addresses? */
function gradingBelongsTo(grading, emails) {
  const e = String(grading.studentEmail || '').toLowerCase();
  return Boolean(e) && emails.has(e);
}

/**
 * One marked script, in the shape the marking viewer needs: the marks, the
 * question breakdown, and every annotation with the page it belongs to.
 */
function gradingDetail(g, termName = '') {
  const d = db();
  const attachments = (g.attachments || []).map((a) => ({
    id: a.id,
    type: a.type,
    index: a.index,
    filename: a.filename || '',
  }));

  // annotation.attachmentID → the page number we stored for that attachment.
  // Pages are numbered over SCRIPT files only (guides are not kept).
  const pageForAttachment = new Map();
  attachments
    .filter((a) => a.type === 'SCRIPT')
    .forEach((a, i) => pageForAttachment.set(a.id, i + 1));

  const annotations = (g.annotations || []).map((a) => ({
    ...a,
    pageIndex: pageForAttachment.get(a.attachmentID) || a.page || 1,
  }));

  const maximum = Number(g.maximumMark) || 0;
  const total = Number(g.totalMark) || 0;
  const percent = maximum ? Math.round((total / maximum) * 1000) / 10 : 0;
  const band = GRADING_SCALE.find((b) => percent >= b.min && percent <= b.max);
  const term = d.terms.find((t) => t.id === g.termId);

  return {
    id: g.id,
    status: g.status,
    subject: g.subject,
    assessmentType: g.assessmentType || 'Assessment',
    title: g.title || '',
    description: g.description || '',
    termId: g.termId,
    termName: termName || (term ? `${term.name} ${term.year}` : ''),
    level: g.level || '',
    studentName: g.studentName || g.studentFullname || '',
    studentEmail: g.studentEmail || '',
    totalMark: total,
    maximumMark: maximum,
    percent,
    grade: band ? band.grade : '—',
    feedback: g.feedback || '',
    error: g.error || '',
    questions: g.questions || [],
    annotations,
    attachments,
    pages: (g.pages || []).map((p) => ({
      index: p.index,
      kind: p.kind,
      contentType: p.contentType,
      filename: p.filename,
    })),
    teacher: teacherName(g.ownerId),
    source: g.source || 'live',
    gradedAt: g.updatedAt || g.createdAt || '',
  };
}

/** Finished gradings addressed to any of this student's addresses. */
function mineFor(user, emails) {
  return db()
    .gradings.filter((g) => FINISHED.includes(g.status) && gradingBelongsTo(g, emails))
    .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
}

/* ---------------- verification codes ---------------- */

async function issueCode({ email, purpose, user }) {
  const d = db();
  const code = makeCode();
  d.codes[`${purpose}:${email}`] = {
    hash: hashCode(code),
    expires: new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000).toISOString(),
    attempts: 0,
    createdAt: new Date().toISOString(),
  };
  persist();

  const delivery = await sendVerificationCode({
    to: email,
    code,
    purpose,
    schoolName: SCHOOL.name,
  });

  return {
    delivered: delivery.delivered,
    transport: delivery.transport,
    // In development there is no mail server, so the code is returned to the
    // client and printed in the console. Never happens once Resend is wired up.
    devCode: delivery.delivered ? undefined : code,
  };
}

function checkCode({ email, purpose, code }) {
  const d = db();
  const key = `${purpose}:${email}`;
  const entry = d.codes[key];
  if (!entry) return { ok: false, status: 400, error: 'Request a new code.' };
  if (new Date(entry.expires) < new Date()) {
    delete d.codes[key];
    persist();
    return { ok: false, status: 400, error: 'That code has expired. Request a new one.' };
  }
  if (entry.attempts >= CODE_MAX_ATTEMPTS) {
    delete d.codes[key];
    persist();
    return { ok: false, status: 429, error: 'Too many attempts. Request a new code.' };
  }
  if (!codeMatches(code, entry.hash)) {
    entry.attempts += 1;
    persist();
    return {
      ok: false,
      status: 400,
      error: `That code is not right. ${Math.max(0, CODE_MAX_ATTEMPTS - entry.attempts)} attempt(s) left.`,
    };
  }
  delete d.codes[key];
  persist();
  return { ok: true };
}

/* ---------------- Google ---------------- */

function googleClientId() {
  return db().settings.googleClientId || process.env.GOOGLE_CLIENT_ID || '';
}

async function verifyGoogleCredential(credential) {
  const aud = googleClientId();
  if (!aud) {
    throw Object.assign(new Error('Google sign-in is not set up yet. Use email and password.'), { status: 400 });
  }
  let res;
  try {
    res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
  } catch {
    throw Object.assign(new Error('Could not reach Google to verify that sign-in. Try again.'), { status: 502 });
  }
  if (!res.ok) throw Object.assign(new Error('Google rejected that sign-in. Please try again.'), { status: 401 });

  const info = await res.json();
  if (info.aud !== aud) throw Object.assign(new Error('That Google sign-in was issued for a different app.'), { status: 401 });
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(String(info.iss || ''))) {
    throw Object.assign(new Error('Unexpected token issuer.'), { status: 401 });
  }
  if (Number(info.exp) * 1000 < Date.now()) throw Object.assign(new Error('That Google sign-in has expired.'), { status: 401 });
  if (String(info.email_verified) !== 'true') throw Object.assign(new Error('Your Google email is not verified.'), { status: 401 });
  return info;
}

/* ---------------- demo pipeline ticker ---------------- */

setInterval(() => {
  try {
    const d = db();
    let changed = false;
    for (const g of d.gradings) {
      if (g.source === 'demo' && (g.status === 'PENDING' || g.status === 'PROCESSING')) {
        advanceDemoGrading(g);
        changed = true;
      }
    }
    if (changed) persist();
  } catch (err) {
    // A bad record must never take the whole server (and everyone's uploads) down.
    console.error('[demo ticker]', err.message);
  }
}, 5000);

setInterval(async () => {
  try {
  if (isDemo()) return;
  const d = db();
  const live = d.gradings.filter(
    (g) => g.source !== 'demo' && (g.status === 'PENDING' || g.status === 'PROCESSING')
  );
  if (!live.length) return;
  let changed = false;
  for (const g of live.slice(0, 10)) {
    try {
      const fresh = await getGrading(g.id);
      Object.assign(g, fresh, {
        studentId: g.studentId,
        ownerId: g.ownerId,
        termId: g.termId,
        source: g.source,
        updatedAt: new Date().toISOString(),
      });
      changed = true;
    } catch { /* retry next tick */ }
  }
  if (changed) persist();
  } catch (err) {
    console.error('[live ticker]', err.message);
  }
}, 15000);

/* ============================================================
   ROUTES
   ============================================================ */

async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method.toUpperCase();
  if (rbacGate(req, res) === false) return;
  const d = db();

  if (p === '/api/health') {
    return json(res, 200, { ok: true, demo: isDemo(), uptime: Math.round(process.uptime()) });
  }

  /* A browser-side error, reported by the app itself. */
  if (p === '/api/client-error' && method === 'POST') {
    let body = {};
    try { body = await readJson(req); } catch { body = {}; }
    syslog('client-error', {
      message: String(body.message || '').slice(0, 400),
      where: String(body.where || '').slice(0, 200),
      stack: String(body.stack || '').slice(0, 800),
      route: String(body.route || '').slice(0, 120),
    });
    return json(res, 200, { ok: true });
  }

  /* What happened lately — the fastest way to explain "it just fails". */
  if (p === '/api/diagnostics' && method === 'GET') {
    const auth = requireAuth(req, res);
    if (!auth) return;
    return json(res, 200, {
      demo: isDemo(),
      uptime: Math.round(process.uptime()),
      logFile: LOG_FILE,
      entries: tailLog(80),
    });
  }

  if (p === '/api/config' && method === 'GET') {
    return json(res, 200, {
      platform: PLATFORM,
      school: SCHOOL,
      scale: GRADING_SCALE,
      divisions: DIVISIONS.map((x) => ({ division: x.division, title: x.title, max: x.max === Infinity ? null : x.max })),
      reporting: REPORTING,
      demo: isDemo(),
      googleClientId: googleClientId(),
      mailMode: mailMode(),
      devCodes: devCodeAllowed(),
      key: { status: d.settings.keyStatus, hint: keyHint(), checkedAt: d.settings.keyCheckedAt, message: d.settings.keyMessage },
      pollSeconds: GRADESCRIPT.pollSeconds,
      baseUrl: GRADESCRIPT.baseUrl,
    });
  }

  /* ================= AUTH ================= */

  if (p === '/api/auth/signup' && method === 'POST') {
    const body = await readJson(req);
    const email = normEmail(body.email);
    const password = String(body.password || '');
    const name = String(body.name || '').trim().slice(0, 120);
    const accountType = String(body.accountType || body.role || '').toLowerCase();

    if (!validEmail(email)) return json(res, 400, { error: 'Enter a valid email address.' });
    const pwProblem = passwordProblem(password);
    if (pwProblem) return json(res, 400, { error: pwProblem });

    const existing = d.users.find((u) => u.email === email);
    if (existing && existing.emailVerified) {
      return json(res, 409, { error: 'An account with that email already exists. Sign in instead.' });
    }

    const { salt, hash } = hashPassword(password);
    let user = existing;
    if (user) {
      user.passwordSalt = salt;
      user.passwordHash = hash;
      user.name = name || user.name;
      if (accountType === 'student' || accountType === 'teacher') user.accountType = accountType;
    } else {
      user = {
        id: uid('u'),
        email,
        name,
        // role is decided once the address is verified (settleRole):
        // guardians own students, students are linked to exactly one profile.
        emailVerified: false,
        passwordSalt: salt,
        passwordHash: hash,
        provider: 'password',
        accountType: accountType || 'teacher',
        createdAt: new Date().toISOString(),
      };
      d.users.push(user);
    }
    persist();

    const delivery = await issueCode({ email, purpose: 'verify' });
    return json(res, 200, {
      ok: true,
      email,
      needsVerification: true,
      delivery,
      message: delivery.delivered
        ? `We sent a 6-digit code to ${email}.`
        : 'No mail server is configured, so the code is shown here and printed in the server log.',
    });
  }

  if (p === '/api/auth/verify-email' && method === 'POST') {
    const body = await readJson(req);
    const email = normEmail(body.email);
    const user = d.users.find((u) => u.email === email);
    if (!user) return json(res, 404, { error: 'Start again — that account no longer exists.' });

    const check = checkCode({ email, purpose: 'verify', code: String(body.code || '').trim() });
    if (!check.ok) return json(res, check.status, { error: check.error });

    user.emailVerified = true;
    user.verifiedAt = new Date().toISOString();
    persist();
    resetRateLimit(`code:${email}`);
    settleRole(user, user.accountType);

    const sid = issueSession(user.id);
    res.setHeader('Set-Cookie', sessionCookie(sid));
    return json(res, 200, { ok: true, token: sid, user: meFor(user), home: ROLE_HOME[roleOf(user)] });
  }

  /* Sends a fresh 6-digit code. Used by the sign-in form ("Email me a code")
     as well as by the resend button on the verification screen.
     Purpose is 'verify' while the address is unconfirmed, 'login' once it is. */
  if ((p === '/api/auth/request-code' || p === '/api/auth/resend-code') && method === 'POST') {
    const body = await readJson(req);
    const email = normEmail(body.email);

    if (!validEmail(email)) return json(res, 400, { error: 'Enter a valid email address.' });
    if (rateLimited(`code:${email}`, 5)) {
      return json(res, 429, { error: 'Too many codes requested. Wait a few minutes and try again.' });
    }

    const user = d.users.find((u) => u.email === email);
    if (!user) {
      // request-code is for existing accounts; signup creates them.
      if (p === '/api/auth/request-code') {
        return json(res, 404, {
          error: 'No account uses that email yet. Create one first.',
          code: 'no-account',
        });
      }
      return json(res, 200, { ok: true, message: 'If that account exists, a code is on its way.' });
    }

    const purpose = user.emailVerified ? 'login' : 'verify';
    const delivery = await issueCode({ email, purpose });

    return json(res, 200, {
      ok: true,
      email,
      purpose,
      delivery,
      message: delivery.delivered
        ? `We sent a 6-digit code to ${email}.`
        : 'No mail server is configured, so the code is shown here and printed in the server log.',
    });
  }

  /* Completes a code-based sign-in (or activates an account) with the code. */
  if (p === '/api/auth/verify-code' && method === 'POST') {
    const body = await readJson(req);
    const email = normEmail(body.email);
    const code = String(body.code || '').trim();

    if (!validEmail(email)) return json(res, 400, { error: 'Enter a valid email address.' });
    if (!/^\d{6}$/.test(code)) return json(res, 400, { error: 'The code is 6 digits.' });

    const user = d.users.find((u) => u.email === email);
    if (!user) return json(res, 400, { error: 'Request a new code.' });

    // Accept a login code or a verification code — whichever is live.
    let result = checkCode({ email, purpose: 'login', code });
    if (!result.ok) result = checkCode({ email, purpose: 'verify', code });
    if (!result.ok) return json(res, result.status, { error: result.error });

    if (!user.emailVerified) {
      user.emailVerified = true;
      user.verifiedAt = new Date().toISOString();
      persist();
    }
    resetRateLimit(`code:${email}`);
    settleRole(user, user.accountType);

    const sid = issueSession(user.id);
    res.setHeader('Set-Cookie', sessionCookie(sid));
    return json(res, 200, { ok: true, method: 'code', token: sid, user: meFor(user), home: ROLE_HOME[roleOf(user)] });
  }

  if (p === '/api/auth/login' && method === 'POST') {
    const body = await readJson(req);
    const email = normEmail(body.email);
    const password = String(body.password || '');
    const user = d.users.find((u) => u.email === email);

    if (rateLimited(`login:${email}`, 10)) {
      return json(res, 429, { error: 'Too many attempts. Wait a few minutes and try again.' });
    }
    if (!user) return json(res, 401, { error: 'Email or password is incorrect.' });

    if (!user.emailVerified) {
      return json(res, 403, {
        error: 'Verify your email first — check your inbox for the 6-digit code.',
        needsVerification: true,
        email,
      });
    }
    if (!user.passwordHash) {
      return json(res, 400, {
        error: 'This account signs in with Google. Use “Continue with Google”, or reset a password.',
        provider: user.provider,
      });
    }
    if (!verifyPassword(password, user.passwordSalt, user.passwordHash)) {
      return json(res, 401, { error: 'Email or password is incorrect.' });
    }

    resetRateLimit(`login:${email}`);
    settleRole(user, user.accountType);
    user.lastSignInAt = new Date().toISOString();
    const sid = issueSession(user.id);
    res.setHeader('Set-Cookie', sessionCookie(sid));
    return json(res, 200, { ok: true, token: sid, user: meFor(user), home: ROLE_HOME[roleOf(user)] });
  }

  if (p === '/api/auth/forgot' && method === 'POST') {
    const body = await readJson(req);
    const email = normEmail(body.email);
    if (rateLimited(`code:${email}`, 5)) {
      return json(res, 429, { error: 'Too many codes requested. Wait a few minutes.' });
    }
    const user = d.users.find((u) => u.email === email);
    if (!user) {
      // Do not leak which addresses exist.
      return json(res, 200, { ok: true, message: 'If that account exists, a reset code is on its way.' });
    }
    const delivery = await issueCode({ email, purpose: 'reset' });
    return json(res, 200, { ok: true, delivery, message: 'If that account exists, a reset code is on its way.' });
  }

  if (p === '/api/auth/reset' && method === 'POST') {
    const body = await readJson(req);
    const email = normEmail(body.email);
    const password = String(body.password || '');
    const user = d.users.find((u) => u.email === email);
    if (!user) return json(res, 400, { error: 'Request a new code.' });

    const pwProblem = passwordProblem(password);
    if (pwProblem) return json(res, 400, { error: pwProblem });

    const check = checkCode({ email, purpose: 'reset', code: String(body.code || '').trim() });
    if (!check.ok) return json(res, check.status, { error: check.error });

    const { salt, hash } = hashPassword(password);
    user.passwordSalt = salt;
    user.passwordHash = hash;
    user.provider = 'password';
    user.emailVerified = true;
    persist();

    const sid = issueSession(user.id);
    res.setHeader('Set-Cookie', sessionCookie(sid));
    return json(res, 200, { ok: true, token: sid, user: meFor(user) });
  }

  if (p === '/api/auth/google' && method === 'POST') {
    const { credential, accountType } = await readJson(req);
    if (!credential) return json(res, 400, { error: 'Missing Google credential.' });

    let info;
    try {
      info = await verifyGoogleCredential(credential);
    } catch (err) {
      return json(res, err.status || 401, { error: err.message });
    }

    const email = normEmail(info.email);
    let user = d.users.find((u) => u.email === email);
    if (!user) {
      user = {
        id: uid('u'),
        email,
        name: String(info.name || '').slice(0, 120),
        emailVerified: true,
        verifiedAt: new Date().toISOString(),
        provider: 'google',
        accountType: String(accountType || '').toLowerCase() === 'student' ? 'student' : 'teacher',
        createdAt: new Date().toISOString(),
      };
      d.users.push(user);
      settleRole(user, user.accountType);
      persist();
    } else if (!user.emailVerified) {
      user.emailVerified = true;
      user.verifiedAt = new Date().toISOString();
      persist();
    }

    settleRole(user, user.accountType);
    const sid = issueSession(user.id);
    res.setHeader('Set-Cookie', sessionCookie(sid));
    return json(res, 200, { ok: true, token: sid, user: meFor(user), home: ROLE_HOME[roleOf(user)] });
  }

  /* Change your own password — the only write a student account may make.
     Also how a temporary student password gets replaced. */
  if (p === '/api/auth/change-password' && method === 'POST') {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const body = await readJson(req);
    const { user } = auth;
    const current = String(body.currentPassword || '');
    const next = String(body.newPassword || '');

    if (user.passwordHash && !verifyPassword(current, user.passwordSalt, user.passwordHash)) {
      return json(res, 400, { error: 'That current password is not right.' });
    }
    const problem = passwordProblem(next);
    if (problem) return json(res, 400, { error: problem });
    if (user.passwordHash && verifyPassword(next, user.passwordSalt, user.passwordHash)) {
      return json(res, 400, { error: 'Choose a password you have not used before.' });
    }

    const { salt, hash } = hashPassword(next);
    user.passwordSalt = salt;
    user.passwordHash = hash;
    user.provider = 'password';
    user.mustChangePassword = false;
    user.passwordChangedAt = new Date().toISOString();
    persist();

    // Rotating a password ends every other session for that account.
    const d = db();
    for (const [sid, sess] of Object.entries(d.sessions)) {
      if (sess.userId === user.id && sid !== auth.session.sid) delete d.sessions[sid];
    }
    persist();
    return json(res, 200, { ok: true, user: meFor(user) });
  }

  if (p === '/api/auth/logout' && method === 'POST') {
    const s = session(req);
    if (s) {
      delete d.sessions[s.sid];
      persist();
    }
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    return json(res, 200, { ok: true });
  }

  if (p === '/api/me' && method === 'GET') {
    const s = session(req);
    if (!s) return json(res, 200, { user: null, demo: isDemo() });
    const user = d.users.find((u) => u.id === s.userId);
    if (!user) return json(res, 200, { user: null, demo: isDemo() });
    return json(res, 200, { user: meFor(user), demo: isDemo() });
  }

  /* ================= STUDENTS (owner-scoped) ================= */

  if (p === '/api/students' && method === 'GET') {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const mine = ownedStudents(auth.user.id);
    return json(res, 200, {
      students: mine.map((s) => ({
        ...publicStudent(s),
        assessments: d.gradings.filter((g) => g.studentId === s.id && g.ownerId === auth.user.id).length,
        subjects: subjectRows(
          d.gradings.filter((g) => g.studentId === s.id && g.ownerId === auth.user.id)
        ).length,
      })),
    });
  }

  if (p === '/api/students' && method === 'POST') {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const body = await readJson(req);

    const name = String(body.name || '').trim().slice(0, 120);
    const email = normEmail(body.email);
    const classId = String(body.classId || d.classes[0]?.id || '');
    const cls = d.classes.find((c) => c.id === classId);

    if (name.length < 2) return json(res, 400, { error: "Enter the student's full name." });
    if (email && !validEmail(email)) return json(res, 400, { error: 'Enter a valid email address for the student.' });
    if (!cls) return json(res, 400, { error: 'Choose a class.' });

    const clash = email && ownedStudents(auth.user.id).find((s) => String(s.email).toLowerCase() === email);
    if (clash) return json(res, 409, { error: `${email} is already one of your students.` });

    const count = ownedStudents(auth.user.id).length;
    const student = {
      id: uid('st'),
      ownerId: auth.user.id,
      name,
      email,
      studentNumber: String(body.studentNumber || '').trim().slice(0, 40) || `${cls.level.replace('.', '')}/${100 + count + 1}`,
      classId: cls.id,
      className: cls.name,
      level: cls.level,
      createdAt: new Date().toISOString(),
    };
    d.students.push(student);

    // Credentials are generated with the profile — never asked for.
    const { account, credentials } = issueStudentLogin(d, student, auth.user.id);
    persist();

    return json(res, 201, {
      ok: true,
      student: publicStudent(student),
      credentials,
      account: { email: account.email, role: 'student', mustChangePassword: true },
      message: `${student.name} can sign in with ${account.email}. Show or email the temporary password once — it is not stored in readable form.`,
    });
  }

  const studentMatch = /^\/api\/students\/([^/]+)$/.exec(p);

  if (studentMatch && method === 'PATCH') {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const student = findOwnedStudent(auth.user.id, studentMatch[1]);
    if (!student) return json(res, 404, { error: 'Student not found.' });

    const body = await readJson(req);
    if (body.name !== undefined) {
      const name = String(body.name).trim().slice(0, 120);
      if (name.length < 2) return json(res, 400, { error: "Enter the student's full name." });
      student.name = name;
    }
    if (body.email !== undefined) {
      const email = normEmail(body.email);
      if (!validEmail(email)) return json(res, 400, { error: 'Enter a valid email for the student.' });
      const clash = ownedStudents(auth.user.id).find(
        (s) => s.id !== student.id && String(s.email).toLowerCase() === email
      );
      if (clash) return json(res, 409, { error: `${email} is already one of your students.` });
      student.email = email;
    }
    if (body.studentNumber !== undefined) {
      student.studentNumber = String(body.studentNumber).trim().slice(0, 40);
    }
    if (body.classId !== undefined) {
      const cls = d.classes.find((c) => c.id === body.classId);
      if (!cls) return json(res, 400, { error: 'Unknown class.' });
      student.classId = cls.id;
      student.className = cls.name;
      student.level = cls.level;
    }
    persist();
    return json(res, 200, { ok: true, student: publicStudent(student) });
  }

  if (studentMatch && method === 'DELETE') {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const student = findOwnedStudent(auth.user.id, studentMatch[1]);
    if (!student) return json(res, 404, { error: 'Student not found.' });

    d.students = d.students.filter((s) => s.id !== student.id);
    d.gradings = d.gradings.filter((g) => !(g.studentId === student.id && g.ownerId === auth.user.id));
    // Deleting the profile deletes the login that belonged to it.
    if (student.accountId) d.users = d.users.filter((u) => u.id !== student.accountId);
    persist();
    return json(res, 200, { ok: true, removed: student.id });
  }

  /* ================= STUDENT CREDENTIALS (guardian only) =================
     The plain password exists only in the response that mints it — never in
     the database, never in a later read. */

  const credMatch = /^\/api\/students\/([^/]+)\/credentials(\/email)?$/.exec(p);

  if (credMatch && method === 'GET' && !credMatch[2]) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const student = findOwnedStudent(auth.user.id, credMatch[1]);
    if (!student) return json(res, 404, { error: 'Student not found.' });

    const account = student.accountId ? d.users.find((u) => u.id === student.accountId) : null;
    const sessions = account ? Object.values(d.sessions).filter((x) => x.userId === account.id).length : 0;
    const expired = student.credentialExpiresAt ? new Date(student.credentialExpiresAt) < new Date() : false;

    return json(res, 200, {
      studentId: student.id,
      name: student.name,
      contactEmail: student.email || '',
      loginEmail: account?.email || student.loginEmail || null,
      hasLogin: Boolean(account),
      mustChangePassword: Boolean(account?.mustChangePassword),
      temporaryPasswordActive: Boolean(account && account.mustChangePassword && !expired),
      temporaryPasswordExpired: Boolean(account && account.mustChangePassword && expired),
      passwordSetByStudent: Boolean(account && !account.mustChangePassword),
      issuedAt: student.credentialIssuedAt || null,
      expiresAt: student.credentialExpiresAt || null,
      lastSignInAt: account?.lastSignInAt || null,
      activeSessions: sessions,
    });
  }

  if (credMatch && method === 'POST' && !credMatch[2]) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const student = findOwnedStudent(auth.user.id, credMatch[1]);
    if (!student) return json(res, 404, { error: 'Student not found.' });

    const { credentials } = issueStudentLogin(d, student, auth.user.id);
    persist();
    return json(res, 200, {
      ok: true,
      credentials,
      message: `New temporary password issued. Any session ${student.name} had open has been signed out.`,
    });
  }

  if (credMatch && method === 'POST' && credMatch[2]) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const student = findOwnedStudent(auth.user.id, credMatch[1]);
    if (!student) return json(res, 404, { error: 'Student not found.' });
    if (!student.email) {
      return json(res, 400, {
        error: 'Add an email address for this student first, or copy the details and share them yourself.',
        code: 'no-contact-email',
      });
    }

    const { credentials } = issueStudentLogin(d, student, auth.user.id);
    const delivery = await sendStudentCredentials({
      to: student.email,
      studentName: student.name,
      loginEmail: credentials.loginEmail,
      password: credentials.password,
      schoolName: SCHOOL.name,
      guardianName: auth.user.name || auth.user.email,
      signInUrl: `${req.headers.origin || `http://${req.headers.host || 'localhost:3000'}`}/#/auth`,
      days: TEMP_PASSWORD_DAYS,
    });
    persist();

    return json(res, 200, {
      ok: true,
      delivered: delivery.delivered,
      transport: delivery.transport,
      to: student.email,
      credentials,
      message: delivery.delivered
        ? `Login details sent to ${student.email}.`
        : 'No mail server is configured, so the details are shown here instead — copy them across.',
    });
  }

  /* ================= STUDENT PORTAL (read-only, email-addressed) =================
     A student account sees every finished grading whose studentEmail matches
     one of its own addresses — whoever the teacher was. Nothing else. */

  if (p === '/api/student/me' && method === 'GET') {
    const auth = requireStudent(req, res);
    if (!auth) return;
    const { user, emails } = auth;
    const mine = mineFor(user, emails);
    const linked = linkedStudentFor(user);
    const latest = mine[0];
    const terms = new Set(mine.map((g) => g.termId));

    return json(res, 200, {
      readOnly: true,
      role: 'student',
      student: {
        id: linked?.id || user.id,
        name: linked?.name || latest?.studentName || user.name || String(user.email).split('@')[0],
        email: user.email,
        emails: [...emails],
        className: linked?.className || '',
        studentNumber: linked?.studentNumber || '',
      },
      teachers: teacherSummary(mine),
      termCount: terms.size,
      assessmentCount: mine.length,
      mustChangePassword: Boolean(user.mustChangePassword),
      canManageStudents: false,
      permissions: { viewOwnResults: true, editAnything: false, viewOtherStudents: false, systemSettings: false },
    });
  }

  /* Every mark on record, newest first, with the teacher who marked it. */
  if ((p === '/api/student/results' || p === '/api/student/assessments') && method === 'GET') {
    const auth = requireStudent(req, res);
    if (!auth) return;
    const mine = mineFor(auth.user, auth.emails);

    const rows = mine.map((g) => {
      const maximum = Number(g.maximumMark) || 0;
      const total = Number(g.totalMark) || 0;
      const percent = maximum ? Math.round((total / maximum) * 1000) / 10 : 0;
      const band = GRADING_SCALE.find((b) => percent >= b.min && percent <= b.max);
      const term = d.terms.find((t) => t.id === g.termId);
      return {
        id: g.id,
        subject: g.subject,
        assessmentType: g.assessmentType || 'Assessment',
        termId: g.termId,
        termName: term ? `${term.name} ${term.year}` : '',
        totalMark: total,
        maximumMark: maximum,
        percent,
        grade: band ? band.grade : '—',
        status: g.status,
        teacher: teacherName(g.ownerId),
        gradedAt: g.updatedAt || g.createdAt,
      };
    });

    return json(res, 200, { readOnly: true, assessments: rows, results: rows, teachers: teacherSummary(mine) });
  }

  /* One marked script in full: the marks, the questions, the annotations. */
  const studentResultMatch = /^\/api\/student\/results\/([^/]+)$/.exec(p);
  if (studentResultMatch && method === 'GET') {
    const auth = requireStudent(req, res);
    if (!auth) return;
    const g = d.gradings.find((x) => x.id === studentResultMatch[1]);
    if (!g || !gradingBelongsTo(g, auth.emails)) {
      return json(res, 404, { error: 'That result is not on your account.' });
    }
    const term = d.terms.find((t) => t.id === g.termId);
    return json(res, 200, {
      readOnly: true,
      grading: gradingDetail(g, term ? `${term.name} ${term.year}` : g.termId),
    });
  }

  if (p === '/api/student/terms' && method === 'GET') {
    const auth = requireStudent(req, res);
    if (!auth) return;
    const mine = mineFor(auth.user, auth.emails);

    const termIds = [...new Set(mine.map((g) => g.termId))];
    const terms = termIds
      .map((id) => {
        const term = d.terms.find((t) => t.id === id);
        const rows = mine.filter((g) => g.termId === id);
        const subjects = subjectRows(rows);
        const average = subjects.length
          ? Math.round((subjects.reduce((n, r) => n + r.percent, 0) / subjects.length) * 10) / 10
          : 0;
        return {
          id,
          name: term?.name || id,
          year: term?.year || '',
          ends: term?.ends || '',
          subjects: subjects.length,
          average,
          assessments: rows.length,
          teachers: teacherSummary(rows).length,
          published: Boolean(term && Object.values(term.published || {}).some((ids) => ids?.length)),
        };
      })
      .reverse();

    return json(res, 200, { readOnly: true, terms });
  }

  if (p.startsWith('/api/student/report/') && method === 'GET') {
    const auth = requireStudent(req, res);
    if (!auth) return;
    const termId = decodeURIComponent(p.split('/').pop());
    const term = d.terms.find((t) => t.id === termId);
    if (!term) return json(res, 404, { error: 'Term not found.' });

    const mine = mineFor(auth.user, auth.emails).filter((g) => g.termId === termId);
    if (!mine.length) return json(res, 404, { error: 'No marked work for this term yet.' });

    const linked = linkedStudentFor(auth.user);
    const latest = mine[0];
    const student = {
      id: linked?.id || auth.user.id,
      name: linked?.name || latest.studentName || auth.user.name,
      email: auth.user.email,
      studentNumber: linked?.studentNumber || '',
      className: linked?.className || '',
      level: linked?.level || latest.level || '',
    };

    // Class position only exists when a teacher has a class for this student.
    let cohort = [];
    if (linked) {
      const classStudents = d.students.filter(
        (x) => x.classId === linked.classId && x.ownerId === linked.ownerId
      );
      const ownerGradings = d.gradings.filter((g) => g.ownerId === linked.ownerId);
      cohort = rankCohort(classStudents, ownerGradings, termId);
    }

    const card = buildReportCard({ student, term, gradings: mine, cohort });

    // Attach who marked each subject — work can come from several teachers.
    card.rows = card.rows.map((row) => {
      const rows = mine.filter((g) => (g.subject || 'Unspecified') === row.subject);
      return {
        ...row,
        teachers: [...new Set(rows.map((g) => teacherName(g.ownerId)))],
      };
    });
    card.teachers = teacherSummary(mine);
    card.readOnly = true;

    return json(res, 200, card);
  }


  /* ================= ACCOUNT CONSOLE (was /api/teacher/*) ================= */

  if (p === '/api/teacher/overview' && method === 'GET') {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const owner = auth.user;
    const mine = ownedStudents(owner.id);
    const myGradings = d.gradings.filter((g) => g.ownerId === owner.id);

    return json(res, 200, {
      demo: isDemo(),
      user: meFor(owner),
      key: { status: d.settings.keyStatus, hint: keyHint(), message: d.settings.keyMessage, checkedAt: d.settings.keyCheckedAt },
      counts: {
        students: mine.length,
        gradings: myGradings.length,
        pending: myGradings.filter((g) => g.status === 'PENDING').length,
        processing: myGradings.filter((g) => g.status === 'PROCESSING').length,
        completed: myGradings.filter((g) => g.status === 'COMPLETED').length,
        partial: myGradings.filter((g) => g.status === 'PARTIAL').length,
        failed: myGradings.filter((g) => g.status === 'FAILED').length,
      },
      terms: d.terms.map((t) => ({
        id: t.id,
        name: t.name,
        year: t.year,
        publishedClasses: publishedClasses(t, owner.id),
      })),
      classes: d.classes,
      students: mine.map(publicStudent),
      recent: myGradings
        .slice()
        .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))
        .slice(0, 12)
        .map(compactGrading),
    });
  }

  if ((p === '/api/key' || p === '/api/admin/key') && method === 'POST') {
    const auth = requireAdmin(req, res);
    if (!auth) return;
    const body = await readJson(req);
    const key = String(body.apiKey || '').trim();
    if (!looksValidKey(key)) {
      markKeyStatus('invalid', 'Malformed key — expected gsk_<8 hex>_<32 hex>.');
      return json(res, 400, {
        error: 'That does not look like a GradeScriptUG key. Expected gsk_<8 hex chars>_<32 hex chars>.',
        key: { status: db().settings.keyStatus, hint: keyHint() },
      });
    }
    const check = await verifyKey(key);
    // Only a key GradeScriptUG actually accepts is stored: a bad key must not
    // knock every teacher out of demo mode.
    if (check.ok) {
      d.settings.apiKey = key;
      d.settings.apiKeyHint = keyHint(key);
      d.settings.apiKeySetBy = auth.user.email;
      d.settings.apiKeySetAt = new Date().toISOString();
      persist();
    }
    markKeyStatus(check.ok ? 'ok' : 'invalid', check.message);
    return json(res, check.ok ? 200 : 400, {
      ok: check.ok,
      message: check.ok
        ? `${check.message} Every teacher's uploads now run on this key, and it never leaves the server.`
        : `${check.message} The key was not saved — marking stays in demo mode.`,
      key: { status: db().settings.keyStatus, hint: keyHint() },
    });
  }

  if ((p === '/api/key' || p === '/api/admin/key') && method === 'DELETE') {
    const auth = requireAdmin(req, res);
    if (!auth) return;
    d.settings.apiKey = '';
    d.settings.apiKeyHint = '';
    d.settings.keyStatus = 'missing';
    d.settings.keyMessage = '';
    persist();
    return json(res, 200, { ok: true, demo: true });
  }

  /* ================= PLATFORM ADMIN ================= */

  if (p === '/api/admin/overview' && method === 'GET') {
    const auth = requireAdmin(req, res);
    if (!auth) return;

    const teachers = d.users.filter((u) => roleOf(u) === 'teacher');
    const students = d.users.filter((u) => roleOf(u) === 'student');
    const completed = d.gradings.filter((g) => FINISHED.includes(g.status));

    return json(res, 200, {
      ok: true,
      admin: { email: auth.user.email, name: auth.user.name },
      key: {
        status: d.settings.keyStatus,
        hint: keyHint(),
        connected: Boolean(currentKey()),
        source: process.env.GRADESCRIPT_API_KEY ? 'environment' : d.settings.apiKey ? 'admin' : 'none',
        setBy: d.settings.apiKeySetBy || null,
        setAt: d.settings.apiKeySetAt || null,
        checkedAt: d.settings.keyCheckedAt || null,
        message: d.settings.keyMessage || '',
      },
      counts: {
        teachers: teachers.length,
        students: students.length,
        accounts: d.users.length,
        studentsTracked: d.students.length,
        gradings: d.gradings.length,
        completed: completed.length,
        pending: d.gradings.filter((g) => g.status === 'PENDING' || g.status === 'PROCESSING').length,
        emailsAddressed: new Set(d.gradings.map((g) => g.studentEmail).filter(Boolean)).size,
      },
      demo: isDemo(),
    });
  }

  // Who is signed in, what they may do, and — for admin only — the key.
  if (p === '/api/admin/key' && method === 'GET') {
    const auth = requireAdmin(req, res);
    if (!auth) return;
    return json(res, 200, {
      key: {
        status: d.settings.keyStatus,
        hint: keyHint(),
        connected: Boolean(currentKey()),
        setAt: d.settings.apiKeySetAt || null,
        checkedAt: d.settings.keyCheckedAt || null,
        message: d.settings.keyMessage || '',
      },
      demo: isDemo(),
    });
  }

  if (p === '/api/settings/google' && method === 'POST') {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const { clientId } = await readJson(req);
    const clean = String(clientId || '').trim();
    if (clean && !/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/i.test(clean)) {
      return json(res, 400, {
        error: 'That does not look like a Google OAuth Client ID. It ends in .apps.googleusercontent.com',
      });
    }
    d.settings.googleClientId = clean;
    persist();
    return json(res, 200, { ok: true, googleClientId: clean });
  }

  if (p === '/api/teacher/gradings' && method === 'GET') {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const status = url.searchParams.get('status');
    const studentId = url.searchParams.get('studentId');
    let list = d.gradings.filter((g) => g.ownerId === auth.user.id);
    if (status) list = list.filter((g) => g.status === status);
    if (studentId) list = list.filter((g) => g.studentId === studentId);
    list.sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
    return json(res, 200, { gradings: list.slice(0, 300).map(compactGrading) });
  }

  if (p === '/api/teacher/gradings' && method === 'POST') {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const boundary = getBoundary(req.headers['content-type'] || '');
    if (!boundary) return json(res, 400, { error: 'Expected a multipart/form-data upload.' });

    const raw = await readBody(req, 70 * 1024 * 1024);
    const { fields, files } = parseMultipart(raw, boundary);

    /* Who is this script for? The student's email address is what connects a
       teacher's marking to the student's own account — any teacher's. */
    const saved = fields.studentId ? findOwnedStudent(auth.user.id, fields.studentId) : null;
    if (fields.studentId && !saved) return json(res, 400, { error: 'Choose one of your students.' });

    const typedEmail = normEmail(fields.studentEmail || '');
    const studentEmail = saved?.email ? String(saved.email).toLowerCase() : typedEmail;
    const typedName = String(fields.studentName || '').trim().slice(0, 120);

    if (!studentEmail) {
      return json(res, 400, {
        error: "Add the student's email — that is how they will see this work in their own account.",
        field: 'studentEmail',
      });
    }
    if (!validEmail(studentEmail)) {
      return json(res, 400, { error: 'Enter a valid email address for the student.', field: 'studentEmail' });
    }

    const studentName =
      saved?.name ||
      typedName ||
      String(fields.studentFullname || '').trim() ||
      studentEmail
        .split('@')[0]
        .replace(/[._-]+/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());

    const subject = String(fields.subject || '').trim();
    if (!subject) return json(res, 400, { error: 'subject is required!' });

    const attachParts = files.filter((f) => f.filename);
    if (!attachParts.length) return json(res, 400, { error: 'Attach at least one SCRIPT!' });

    const allowed = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
    for (const f of attachParts) {
      const ext = path.extname(f.filename || '').toLowerCase();
      if (!allowed.includes(f.contentType) && !['.pdf', '.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
        return json(res, 400, { error: `${f.filename} must be a PDF, PNG, JPEG or WEBP file!` });
      }
      if (f.data.length > 20 * 1024 * 1024) {
        return json(res, 400, { error: `${f.filename} is over 20 MB.` });
      }
    }
    if (raw.length > 60 * 1024 * 1024) return json(res, 400, { error: 'A grading can be at most 60 MB.' });

    const termId = d.terms.find((t) => t.id === fields.termId) ? fields.termId : REPORTING.currentTerm;

    const gsFields = {
      studentFullname: studentName,
      studentNumber: saved?.studentNumber || String(fields.studentNumber || '').trim(),
      subject,
      level: saved?.level || String(fields.level || '').trim(),
      assessmentType: fields.assessmentType || 'Assessment',
      instructions: fields.instructions || '',
    };

    const attachments = attachParts.map((f, i) => ({
      type: String(fields[`attachments[${i}][type]`] || 'SCRIPT').toUpperCase(),
      index: i + 1,
      filename: f.filename,
      contentType: f.contentType,
      data: f.data,
    }));

    try {
      const created = isDemo()
        ? demoCreateGrading({ fields: gsFields, files: attachments })
        : await createGrading({ fields: gsFields, files: attachments });

      const record = {
        ...created,
        studentId: saved?.id || null,
        studentEmail,
        studentName,
        ownerId: auth.user.id,
        termId,
        subject,
        assessmentType: gsFields.assessmentType,
        source: isDemo() ? 'demo' : 'live',
        uploadedAt: new Date().toISOString(),
      };
      if (!record.createdAt) record.createdAt = new Date().toISOString();
      if (!record.updatedAt) record.updatedAt = record.createdAt;

      /* Our own copy of the pages, so annotations can be drawn over them.
         The API returns marks, never the files it marked. */
      record.pages = savePages(record.id, attachments.filter((a) => a.type === 'SCRIPT'));

      d.gradings.push(record);
      persist();

      syslog('grading.queued', {
        id: record.id,
        owner: auth.user.email,
        subject,
        files: attachments.length,
        pages: record.pages.length,
        bytes: raw.length,
        mode: isDemo() ? 'demo' : 'live',
      });

      return json(res, 202, {
        ok: true,
        message: isDemo() ? 'Queued in demo mode.' : 'Grading queued successfully!',
        grading: compactGrading(record),
      });
    } catch (err) {
      syslog('grading.error', {
        owner: auth.user.email,
        message: String(err.message || 'unknown').slice(0, 300),
        status: err.status || 0,
        files: attachments.length,
        mode: isDemo() ? 'demo' : 'live',
      });
      return json(res, err instanceof ApiError && err.status === 401 ? 401 : 400, {
        error: err.message || 'The grading could not be queued.',
      });
    }
  }

  const retryMatch = /^\/api\/teacher\/gradings\/([^/]+)\/retry$/.exec(p);
  if (retryMatch && method === 'POST') {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const g = d.gradings.find((x) => x.id === retryMatch[1] && x.ownerId === auth.user.id);
    if (!g) return json(res, 404, { error: 'Grading not found.' });
    try {
      if (g.source === 'demo') {
        const fresh = demoCreateGrading({
          fields: {
            studentFullname: g.studentFullname,
            studentNumber: g.studentNumber,
            subject: g.subject,
            level: g.level,
            assessmentType: g.assessmentType,
          },
          files: [],
        });
        Object.assign(g, fresh, { id: g.id, studentId: g.studentId, ownerId: g.ownerId, termId: g.termId });
      } else {
        await retryGrading(g.id);
        g.status = 'PENDING';
        g.error = '';
      }
      g.updatedAt = new Date().toISOString();
      persist();
      return json(res, 200, { ok: true, grading: compactGrading(g) });
    } catch (err) {
      return json(res, err.status || 400, { error: err.message });
    }
  }

  const gradingMatch = /^\/api\/teacher\/gradings\/([^/]+)$/.exec(p);

  if (gradingMatch && method === 'DELETE') {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const idx = d.gradings.findIndex((x) => x.id === gradingMatch[1] && x.ownerId === auth.user.id);
    if (idx === -1) return json(res, 404, { error: 'Grading not found.' });
    const g = d.gradings[idx];
    if (g.source !== 'demo') {
      try {
        await deleteGrading(g.id);
      } catch (err) {
        if (err.status !== 404) return json(res, err.status || 400, { error: err.message });
      }
    }
    d.gradings.splice(idx, 1);
    removePages(g.id);
    persist();
    return json(res, 200, { ok: true });
  }

  const pageMatch = /^\/api\/(teacher\/gradings|student\/results)\/([^/]+)\/pages\/(\d+)$/.exec(p);

  if (pageMatch && method === 'GET') {
    const [, scope, gradingId, pageNo] = pageMatch;
    let grading = null;

    if (scope === 'teacher/gradings') {
      const auth = requireAuth(req, res);
      if (!auth) return;
      grading = d.gradings.find((g) => g.id === gradingId && g.ownerId === auth.user.id) || null;
    } else {
      const auth = requireStudent(req, res);
      if (!auth) return;
      grading = d.gradings.find((g) => g.id === gradingId && gradingBelongsTo(g, auth.emails)) || null;
    }
    if (!grading) return json(res, 404, { error: 'Not found.' });

    // The API numbers attachment ids; ours are stored by script order.
    const attachment = (grading.attachments || []).find((a) => a.index === Number(pageNo) && a.type !== 'MARKING_GUIDE');
    const stored = pagePath(grading.id, Number(pageNo));
    if (!stored) return json(res, 404, { error: 'That page was not kept for this script.' });

    const body = fs.readFileSync(stored);
    res.writeHead(200, {
      'Content-Type': contentTypeFor(stored),
      'Content-Length': body.length,
      'Cache-Control': 'private, max-age=3600',
      'Content-Disposition': `inline; filename="${(attachment?.filename || 'page').replace(/[^\w.-]/g, '_')}"`,
    });
    res.end(body);
    return;
  }

  if (gradingMatch && method === 'GET') {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const g = d.gradings.find((x) => x.id === gradingMatch[1] && x.ownerId === auth.user.id);
    if (!g) return json(res, 404, { error: 'Grading not found.' });
    const st = d.students.find((x) => x.id === g.studentId && x.ownerId === auth.user.id);
    return json(res, 200, {
      grading: gradingDetail(g),
      student: st ? publicStudent(st) : null,
    });
  }

  if (p === '/api/teacher/sync' && method === 'POST') {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const mine = d.gradings.filter(
      (g) => g.ownerId === auth.user.id && (g.status === 'PENDING' || g.status === 'PROCESSING')
    );
    if (isDemo()) {
      mine.forEach(advanceDemoGrading);
      persist();
      return json(res, 200, { ok: true, refreshed: mine.length, demo: true });
    }
    let refreshed = 0;
    for (const g of mine) {
      try {
        const fresh = await getGrading(g.id);
        Object.assign(g, fresh, { studentId: g.studentId, ownerId: g.ownerId, termId: g.termId, source: g.source });
        refreshed += 1;
      } catch { /* ignore */ }
    }
    persist();
    return json(res, 200, { ok: true, refreshed });
  }

  if (p === '/api/teacher/reports' && method === 'GET') {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const owner = auth.user;
    const termId = url.searchParams.get('termId') || REPORTING.currentTerm;
    const classId = url.searchParams.get('classId') || d.classes[0]?.id;
    const term = d.terms.find((t) => t.id === termId);
    const classStudents = ownedStudents(owner.id).filter((s) => s.classId === classId);
    const ownerGradings = d.gradings.filter((g) => g.ownerId === owner.id);
    const cohort = rankCohort(classStudents, ownerGradings, termId);

    return json(res, 200, {
      termId,
      classId,
      published: term ? publishedClasses(term, owner.id).includes(classId) : false,
      students: classStudents.map((st) => {
        const rank = cohort.find((c) => c.studentId === st.id);
        const rows = subjectRows(
          ownerGradings.filter((g) => g.studentId === st.id && g.termId === termId && FINISHED.includes(g.status))
        );
        return {
          ...publicStudent(st),
          subjects: rows.length,
          average: rank?.average ?? 0,
          position: rank?.position ?? null,
          classSize: rank?.classSize ?? null,
          flagged: rows.reduce((n, r) => n + r.assessments.reduce((m, a) => m + a.flagged, 0), 0),
        };
      }),
    });
  }

  if (p === '/api/teacher/report' && method === 'GET') {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const studentId = url.searchParams.get('studentId');
    const termId = url.searchParams.get('termId') || REPORTING.currentTerm;
    const student = findOwnedStudent(auth.user.id, studentId);
    const term = d.terms.find((t) => t.id === termId);
    if (!student || !term) return json(res, 404, { error: 'Not found.' });

    const classStudents = ownedStudents(auth.user.id).filter((x) => x.classId === student.classId);
    const ownerGradings = d.gradings.filter((g) => g.ownerId === auth.user.id);
    const cohort = rankCohort(classStudents, ownerGradings, termId);
    const mine = ownerGradings.filter((g) => g.studentId === student.id && g.termId === termId);
    const card = buildReportCard({ student, term, gradings: mine, cohort });
    return json(res, 200, {
      ...card,
      published: publishedClasses(term, auth.user.id).includes(student.classId),
    });
  }

  if (p === '/api/teacher/publish' && method === 'POST') {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const { termId, classId, published } = await readJson(req);
    const term = d.terms.find((t) => t.id === termId);
    if (!term) return json(res, 404, { error: 'Term not found.' });

    term.published = term.published || {};
    const mine = term.published[auth.user.id] || [];
    if (published && !mine.includes(classId)) mine.push(classId);
    if (!published) term.published[auth.user.id] = mine.filter((c) => c !== classId);
    else term.published[auth.user.id] = mine;
    persist();
    return json(res, 200, { ok: true, term });
  }

  if (p === '/api/teacher/clear-results' && method === 'POST') {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const before = d.gradings.length;
    d.gradings.filter((g) => g.ownerId === auth.user.id).forEach((g) => removePages(g.id));
    d.gradings = d.gradings.filter((g) => g.ownerId !== auth.user.id);
    d.terms.forEach((t) => {
      if (t.published) delete t.published[auth.user.id];
    });
    persist();
    return json(res, 200, { ok: true, removed: before - d.gradings.length });
  }

  if (p === '/api/teacher/reset-demo' && method === 'POST') {
    const auth = requireAuth(req, res);
    if (!auth) return;
    // Only resets this account's students, never anyone else's.
    const removed = d.gradings.filter((g) => g.ownerId === auth.user.id).length;
    d.gradings.filter((g) => g.ownerId === auth.user.id).forEach((g) => removePages(g.id));
    d.gradings = d.gradings.filter((g) => g.ownerId !== auth.user.id);
    d.students = d.students.filter((s) => s.ownerId !== auth.user.id);
    d.terms.forEach((t) => {
      if (t.published) delete t.published[auth.user.id];
    });
    persist();
    return json(res, 200, { ok: true, removed });
  }

  return json(res, 404, { error: 'Unknown endpoint.' });
}

function compactGrading(g) {
  const student = db().students.find((s) => s.id === g.studentId);
  return {
    id: g.id,
    status: g.status,
    subject: g.subject,
    level: g.level,
    assessmentType: g.assessmentType,
    termId: g.termId,
    title: g.title,
    studentId: g.studentId,
    studentName: student?.name || g.studentName || g.studentFullname || '',
    studentEmail: g.studentEmail || student?.email || '',
    studentNumber: g.studentNumber || student?.studentNumber || '',
    totalMark: typeof g.totalMark === 'number' ? g.totalMark : null,
    maximumMark: typeof g.maximumMark === 'number' ? g.maximumMark : null,
    percent:
      typeof g.totalMark === 'number' && g.maximumMark
        ? Math.round((g.totalMark / g.maximumMark) * 1000) / 10
        : null,
    error: g.error || '',
    feedback: g.feedback || '',
    questions: g.questions?.length || 0,
    pageCount: (g.attachments || []).filter((a) => a.type === 'SCRIPT').length,
    keptPages: (g.pages || []).length,
    annotationCount: (g.annotations || []).length,
    source: g.source || 'live',
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
    uploadedAt: g.uploadedAt,
  };
}

/* ---------------- static ---------------- */

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      // HTML/JS/CSS must never be served stale: an old bundle can call routes
      // that no longer exist. Assets are small, so no-store costs nothing here.
      'Cache-Control': ['.html', '.js', '.css'].includes(ext) ? 'no-store' : 'public, max-age=3600',
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const startedAt = Date.now();
  const apiPath = (req.url || '').split('?')[0];
  if (apiPath.startsWith('/api/')) {
    res.on('finish', () => {
      syslog('http', {
        method: req.method,
        path: apiPath,
        status: res.statusCode,
        ms: Date.now() - startedAt,
        bytes: Number(req.headers['content-length'] || 0) || undefined,
      });
    });
  }
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (err) {
    console.error('[error]', err);
    if (!res.headersSent) json(res, err.status || 500, { error: err.message || 'Something went wrong.' });
  }
});

/* Keep serving: a stray error in one request must not stop marking for everyone. */
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err && err.message ? err.message : err);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack ? err.stack : err);
});

server.listen(PORT, HOST, () => {
  const d = db();
  console.log(`\n  ${PLATFORM.name} · ${SCHOOL.name}`);
  console.log(`  http://localhost:${PORT}`);
  const teachers = d.users.filter((u) => roleOf(u) === 'teacher').length;
  const students = d.users.filter((u) => roleOf(u) === 'student').length;
  console.log(
    `  Accounts: ${d.users.length} (${teachers} teachers · ${students} students) · Students tracked: ${d.students.length} · Gradings: ${d.gradings.length}`
  );
  console.log(`  GradeScriptUG: ${isDemo() ? 'DEMO MODE (no platform key connected)' : `LIVE (${keyHint()})`}`);
  console.log(`  Platform key owner: ${ADMIN_EMAIL}`);
  console.log(`  Mail: ${mailMode()}${mailMode() === 'dev' ? ' — verification codes print here and on screen' : ''}`);
  console.log(`  Admin account:  ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
  console.log(`  Demo teacher:   ${DEMO_EMAIL} / ${DEMO_PASSWORD}\n`);
});
