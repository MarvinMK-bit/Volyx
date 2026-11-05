/* Tiny JSON-file database. No dependencies.
   Everything lives in data/db.json and is written atomically.

   Schema 2 introduced accounts:
   users[]            an account, linked to one verified email address
   students[]         owned by exactly one user (ownerId)
   codes{}            hashed verification codes, keyed "<purpose>:<email>"

   Schema 4 adds the platform model:
   users[].role       'admin' | 'teacher' | 'student'
   gradings[].studentEmail  the address a script belongs to — this is the
                      key that lets any teacher's marking reach a student
   settings.apiKey    the ONE platform key, writable only by the admin

   Schema 3 added roles (RBAC):
   users[].role       'guardian' (owns student profiles) | 'student' (read-only)
   users[].studentId  for student accounts: the profile they may view
   users[].ownerId    for student accounts: the guardian who manages the login
   students[].accountId  the student login generated for that profile
   students[].loginEmail the generated address (amina.nakato@students.…)
*/

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
export const SCHEMA = 4;

let cache = null;

export function db() {
  if (cache) return cache;
  fs.mkdirSync(DATA_DIR, { recursive: true });

  if (fs.existsSync(DB_FILE)) {
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch {
      parsed = null;
    }
    if (parsed && parsed.schema === SCHEMA) {
      cache = parsed;
      return cache;
    }
    if (parsed && parsed.schema === 3) {
      cache = migrateFrom3(parsed);
      persist();
      console.log('[db] migrated schema 3 → 4 (teachers, admin key, student email on gradings)');
      return cache;
    }
    if (parsed && parsed.schema === 2) {
      cache = migrateFrom2(parsed);
      persist();
      console.log('[db] migrated schema 2 → 3 (roles + student logins)');
      return cache;
    }
    // Older schema: keep a copy, start clean.
    const backup = path.join(DATA_DIR, `db.legacy-${Date.now()}.json`);
    if (parsed) fs.copyFileSync(DB_FILE, backup);
    console.warn(`[db] upgrading database schema → ${SCHEMA}. Previous file kept at ${path.basename(backup)}`);
    cache = blank();
    persist();
    return cache;
  }

  cache = blank();
  persist();
  return cache;
}

/* Schema 3 → 4: guardians become teachers, and every grading is given the
   student email it belongs to (taken from its student record). */
function migrateFrom3(prev) {
  const next = { ...blank(), ...prev, schema: SCHEMA };
  next.settings = { ...blank().settings, ...(prev.settings || {}) };
  next.users = (prev.users || []).map((u) => ({
    ...u,
    role: u.role === 'student' ? 'student' : 'teacher',
  }));
  next.students = prev.students || [];
  const byId = new Map(next.students.map((s) => [s.id, s]));
  next.gradings = (prev.gradings || []).map((g) => {
    const student = byId.get(g.studentId);
    return {
      ...g,
      studentEmail: String(g.studentEmail || student?.email || '').toLowerCase(),
      studentName: g.studentName || student?.name || g.studentFullname || '',
    };
  });
  next.sessions = prev.sessions || {};
  next.codes = prev.codes || {};
  next.meta = { ...(prev.meta || {}), migratedFrom: 3, migratedAt: new Date().toISOString() };
  return next;
}

/* Schema 2 → 3: every existing account becomes a guardian, and student
   profiles simply have no login yet (one is generated on demand). */
function migrateFrom2(prev) {
  const next = { ...blank(), ...prev, schema: SCHEMA };
  next.settings = { ...blank().settings, ...(prev.settings || {}) };
  next.users = (prev.users || []).map((u) => ({
    role: 'guardian',
    ...u,
  }));
  next.students = (prev.students || []).map((s) => ({
    accountId: null,
    loginEmail: null,
    credentialIssuedAt: null,
    ...s,
  }));
  next.sessions = prev.sessions || {};
  next.codes = prev.codes || {};
  next.meta = { ...(prev.meta || {}), migratedFrom: 2, migratedAt: new Date().toISOString() };
  return next;
}

export function blank() {
  return {
    schema: SCHEMA,
    createdAt: new Date().toISOString(),
    settings: {
      apiKey: '',            // server-side only — never sent to the browser
      apiKeyHint: '',
      keyStatus: 'missing',  // missing | unverified | ok | invalid
      keyCheckedAt: null,
      keyMessage: '',
      googleClientId: '',
    },
    users: [],
    students: [],
    classes: [],
    terms: [],
    gradings: [],
    sessions: {},
    codes: {},
    meta: {},
  };
}

export function persist() {
  if (!cache) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

export function resetDb(next) {
  cache = next || blank();
  persist();
  return cache;
}

export const uid = (prefix = 'id') =>
  `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
