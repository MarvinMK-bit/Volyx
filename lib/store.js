/* ============================================================
   VOLYX STORE — SQLite
   ============================================================

   Why SQLite:
     · every write is a transaction — a crash mid-save can no longer
       leave a half-written database behind;
     · only rows that actually changed are written (the old JSON file
       rewrote the whole database on every single persist() call);
     · sessions, codes and gradings are indexed, so pruning and lookups
       by email / owner / term are cheap;
     · an append-only audit_log table gives the platform a real history.

   Shape of the data:
     The application keeps working with one in-memory object graph
     (db()), exactly as before, so no route had to be rewritten. Each
     entity is stored as a JSON document in a `data` column, next to a
     handful of real columns (email, role, owner_id, student_email,
     term_id, status, expires …) that exist so SQL can index and filter
     without parsing JSON.

     Two things are genuinely relational and live only in SQL:
       · audit_log — append-only, never loaded into memory;
       · every count / streak on the admin screens.

   Files:
     data/volyx.db        the database (WAL mode)
     data/backups/*.db    one snapshot per day, last 7 kept
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

/* Where the database, backups and uploads live.
   Local runs use ./data. A host with an attached disk (Render, Fly, a VPS)
   points VOLYX_DATA_DIR at the mount, so everything survives a redeploy. */
export const DATA_DIR = process.env.VOLYX_DATA_DIR
  ? path.resolve(process.env.VOLYX_DATA_DIR)
  : path.join(ROOT, 'data');

const DB_FILE = process.env.VOLYX_DB || path.join(DATA_DIR, 'volyx.db');
const JSON_FILE = path.join(DATA_DIR, 'db.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

export const SCHEMA = 5;

let sqlite = null;
let cache = null;
/** table → Map(id → JSON) of what is currently on disk */
const shadow = new Map();
let dirtyKv = new Set();

/* ------------------------------------------------------------
   Schema
   ------------------------------------------------------------ */

const DDL = `
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  email          TEXT,
  role           TEXT,
  created_at     TEXT,
  data           TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users(email);
CREATE INDEX IF NOT EXISTS users_role ON users(role);

CREATE TABLE IF NOT EXISTS students (
  id             TEXT PRIMARY KEY,
  owner_id       TEXT,
  email          TEXT,
  class_id       TEXT,
  data           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS students_owner ON students(owner_id);
CREATE INDEX IF NOT EXISTS students_email ON students(email);

CREATE TABLE IF NOT EXISTS sessions (
  sid            TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  created        TEXT,
  expires        TEXT,
  ip             TEXT,
  user_agent     TEXT,
  last_seen      TEXT,
  data           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires);

CREATE TABLE IF NOT EXISTS codes (
  k              TEXT PRIMARY KEY,
  email          TEXT,
  purpose        TEXT,
  expires        TEXT,
  attempts       INTEGER DEFAULT 0,
  data           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS codes_expires ON codes(expires);

CREATE TABLE IF NOT EXISTS gradings (
  id             TEXT PRIMARY KEY,
  owner_id       TEXT,
  student_id     TEXT,
  student_email  TEXT,
  term_id        TEXT,
  subject        TEXT,
  status         TEXT,
  created_at     TEXT,
  updated_at     TEXT,
  data           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS gradings_owner ON gradings(owner_id);
CREATE INDEX IF NOT EXISTS gradings_email ON gradings(student_email);
CREATE INDEX IF NOT EXISTS gradings_term ON gradings(term_id);
CREATE INDEX IF NOT EXISTS gradings_status ON gradings(status);

CREATE TABLE IF NOT EXISTS terms (
  id             TEXT PRIMARY KEY,
  data           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS classes (
  id             TEXT PRIMARY KEY,
  data           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  at             TEXT NOT NULL,
  actor_id       TEXT,
  actor_email    TEXT,
  role           TEXT,
  action         TEXT NOT NULL,
  target         TEXT,
  ip             TEXT,
  detail         TEXT
);
CREATE INDEX IF NOT EXISTS audit_at ON audit_log(at DESC);
CREATE INDEX IF NOT EXISTS audit_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS audit_actor ON audit_log(actor_id);
`;

/* ------------------------------------------------------------
   Open / close
   ------------------------------------------------------------ */

function open() {
  if (sqlite) return sqlite;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  sqlite = new Database(DB_FILE);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 4000');
  sqlite.exec(DDL);
  return sqlite;
}

export function dbPath() {
  return DB_FILE;
}

/** Flush everything and close cleanly (used on SIGTERM / SIGINT). */
export function closeStore() {
  if (!sqlite) return;
  try {
    persist();
    sqlite.pragma('wal_checkpoint(TRUNCATE)');
    sqlite.close();
  } catch (err) {
    console.error('[store] close failed:', err.message);
  }
  sqlite = null;
  cache = null;
  shadow.clear();
}

/* ------------------------------------------------------------
   The shape the application has always used
   ------------------------------------------------------------ */

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

const getKv = (k, fallback) => {
  const row = open().prepare('SELECT v FROM kv WHERE k = ?').get(k);
  if (!row) return fallback;
  try { return JSON.parse(row.v); } catch { return fallback; }
};

const readRows = (table, order = '') =>
  open()
    .prepare(`SELECT data FROM ${table} ${order}`)
    .all()
    .map((r) => JSON.parse(r.data));

function hydrate(d) {
  d.settings = { ...blank().settings, ...getKv('settings', {}) };
  d.meta = getKv('meta', {});
  d.createdAt = getKv('createdAt', d.createdAt);

  d.users = readRows('users');
  d.students = readRows('students');
  d.classes = readRows('classes');
  d.terms = readRows('terms');
  d.gradings = readRows('gradings', 'ORDER BY rowid');

  d.sessions = {};
  for (const s of readRows('sessions')) d.sessions[s.sid || s.id] = s;
  d.codes = {};
  for (const c of readRows('codes')) d.codes[c.k || c.key] = c;
  return d;
}

/* ------------------------------------------------------------
   db() — the one object graph everyone shares
   ------------------------------------------------------------ */

export function db() {
  if (cache) return cache;
  open();
  cache = hydrate(blank());
  snapshot(cache);
  importLegacyJson(cache);
  return cache;
}

/* ------------------------------------------------------------
   Writes — diffed, transactional
   ------------------------------------------------------------ */

const KEEP = new Set(['settings', 'meta', 'createdAt', 'schema']);

/** Remember what is on disk right now, so persist() only writes deltas. */
function snapshot(d) {
  shadow.clear();
  dirtyKv = new Set();
  const tables = {
    users: d.users,
    students: d.students,
    sessions: Object.entries(d.sessions || {}).map(([sid, v]) => ({ ...v, sid: v.sid || sid })),
    codes: Object.entries(d.codes || {}).map(([k, v]) => ({ ...v, k: v.k || k })),
    gradings: d.gradings,
    terms: d.terms,
    classes: d.classes,
  };
  for (const [table, list] of Object.entries(tables)) {
    const m = new Map();
    for (const item of list || []) {
      const id = rowId(table, item);
      if (id) m.set(id, JSON.stringify(item));
    }
    shadow.set(table, m);
  }
  shadow.set('kv', new Map([
    ['settings', JSON.stringify(d.settings || {})],
    ['meta', JSON.stringify(d.meta || {})],
    ['createdAt', JSON.stringify(d.createdAt || '')],
  ]));
}

function rowId(table, item) {
  if (table === 'sessions') return item.sid || item.id;
  if (table === 'codes') return item.k || item.key;
  return item.id;
}

/* One upsert statement per table, prepared once. */
const UPSERT = {
  users: `INSERT INTO users (id, email, role, created_at, data) VALUES (@id, @email, @role, @created_at, @data)
          ON CONFLICT(id) DO UPDATE SET email=excluded.email, role=excluded.role,
          created_at=excluded.created_at, data=excluded.data`,
  students: `INSERT INTO students (id, owner_id, email, class_id, data) VALUES (@id, @owner_id, @email, @class_id, @data)
             ON CONFLICT(id) DO UPDATE SET owner_id=excluded.owner_id, email=excluded.email,
             class_id=excluded.class_id, data=excluded.data`,
  sessions: `INSERT INTO sessions (sid, user_id, created, expires, ip, user_agent, last_seen, data)
             VALUES (@sid, @user_id, @created, @expires, @ip, @user_agent, @last_seen, @data)
             ON CONFLICT(sid) DO UPDATE SET user_id=excluded.user_id, created=excluded.created,
             expires=excluded.expires, ip=excluded.ip, user_agent=excluded.user_agent,
             last_seen=excluded.last_seen, data=excluded.data`,
  codes: `INSERT INTO codes (k, email, purpose, expires, attempts, data)
          VALUES (@k, @email, @purpose, @expires, @attempts, @data)
          ON CONFLICT(k) DO UPDATE SET email=excluded.email, purpose=excluded.purpose,
          expires=excluded.expires, attempts=excluded.attempts, data=excluded.data`,
  gradings: `INSERT INTO gradings (id, owner_id, student_id, student_email, term_id, subject, status, created_at, updated_at, data)
             VALUES (@id, @owner_id, @student_id, @student_email, @term_id, @subject, @status, @created_at, @updated_at, @data)
             ON CONFLICT(id) DO UPDATE SET owner_id=excluded.owner_id, student_id=excluded.student_id,
             student_email=excluded.student_email, term_id=excluded.term_id, subject=excluded.subject,
             status=excluded.status, created_at=excluded.created_at, updated_at=excluded.updated_at, data=excluded.data`,
  terms: `INSERT INTO terms (id, data) VALUES (@id, @data)
          ON CONFLICT(id) DO UPDATE SET data=excluded.data`,
  classes: `INSERT INTO classes (id, data) VALUES (@id, @data)
            ON CONFLICT(id) DO UPDATE SET data=excluded.data`,
};

const CODE_COLUMN = {
  users: 'id', students: 'id', sessions: 'sid', codes: 'k', gradings: 'id', terms: 'id', classes: 'id',
};

function columnsFor(table, item) {
  const j = (v) => (v === undefined || v === null ? null : String(v));
  switch (table) {
    case 'users':
      return { id: item.id, email: norm(item.email), role: j(item.role), created_at: j(item.createdAt), data: JSON.stringify(item) };
    case 'students':
      return { id: item.id, owner_id: j(item.ownerId), email: norm(item.email), class_id: j(item.classId), data: JSON.stringify(item) };
    case 'sessions':
      return {
        sid: item.sid || item.id,
        user_id: j(item.userId),
        created: j(item.created),
        expires: j(item.expires),
        ip: j(item.ip),
        user_agent: j(item.userAgent),
        last_seen: j(item.lastSeen),
        data: JSON.stringify(item),
      };
    case 'codes':
      return {
        k: item.k || item.key,
        email: norm(item.email),
        purpose: j(item.purpose),
        expires: j(item.expires),
        attempts: Number(item.attempts || 0),
        data: JSON.stringify(item),
      };
    case 'gradings':
      return {
        id: item.id,
        owner_id: j(item.ownerId),
        student_id: j(item.studentId),
        student_email: norm(item.studentEmail),
        term_id: j(item.termId),
        subject: j(item.subject),
        status: j(item.status),
        created_at: j(item.createdAt),
        updated_at: j(item.updatedAt),
        data: JSON.stringify(item),
      };
    default:
      return { id: item.id, data: JSON.stringify(item) };
  }
}

const norm = (v) => (v ? String(v).trim().toLowerCase() : null);

/**
 * Write every change since the last persist, inside one transaction.
 * Cheap to call often: unchanged rows are skipped entirely.
 * @returns {{written:number, deleted:number, ms:number}}
 */
export function persist() {
  const started = Date.now();
  if (!cache || !sqlite) return { written: 0, deleted: 0, ms: 0 };

  const lists = {
    users: cache.users,
    students: cache.students,
    sessions: Object.entries(cache.sessions || {}).map(([sid, v]) => ({ ...v, sid: v.sid || sid })),
    codes: Object.entries(cache.codes || {}).map(([k, v]) => ({ ...v, k: v.k || k })),
    gradings: cache.gradings,
    terms: cache.terms,
    classes: cache.classes,
  };

  const ops = { write: [], del: [] };
  for (const [table, list] of Object.entries(lists)) {
    const seen = new Set();
    const disk = shadow.get(table) || new Map();
    for (const item of list || []) {
      const id = rowId(table, item);
      if (!id) continue;
      seen.add(id);
      const json = JSON.stringify(item);
      if (disk.get(id) === json) continue;
      ops.write.push({ table, row: columnsFor(table, item) });
      disk.set(id, json);
    }
    for (const id of disk.keys()) {
      if (!seen.has(id)) {
        ops.del.push({ table, id });
        disk.delete(id);
      }
    }
    shadow.set(table, disk);
  }

  const kvDisk = shadow.get('kv') || new Map();
  const kvNow = {
    settings: JSON.stringify(cache.settings || {}),
    meta: JSON.stringify(cache.meta || {}),
    createdAt: JSON.stringify(cache.createdAt || ''),
  };
  for (const [k, v] of Object.entries(kvNow)) {
    if (kvDisk.get(k) !== v) {
      ops.write.push({ table: 'kv', row: { k, v } });
      kvDisk.set(k, v);
    }
  }
  shadow.set('kv', kvDisk);

  if (!ops.write.length && !ops.del.length) return { written: 0, deleted: 0, ms: Date.now() - started };

  const run = sqlite.transaction(() => {
    for (const { table, row } of ops.write) {
      if (table === 'kv') {
        sqlite.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(row.k, row.v);
      } else {
        sqlite.prepare(UPSERT[table]).run(row);
      }
    }
    for (const { table, id } of ops.del) {
      sqlite.prepare(`DELETE FROM ${table} WHERE ${CODE_COLUMN[table]} = ?`).run(id);
    }
  });
  run();

  return { written: ops.write.length, deleted: ops.del.length, ms: Date.now() - started };
}

export function resetDb(next) {
  open();
  const fresh = next || blank();
  sqlite.transaction(() => {
    for (const t of ['users', 'students', 'sessions', 'codes', 'gradings', 'terms', 'classes', 'kv']) {
      sqlite.prepare(`DELETE FROM ${t}`).run();
    }
  })();
  cache = fresh;
  snapshot(cache);
  persist();
  return cache;
}

/* ------------------------------------------------------------
   Session + code housekeeping
   ------------------------------------------------------------ */

/**
 * Drop expired sessions and verification codes. Called on a timer and at
 * boot, so neither table can grow without limit.
 */
export function pruneExpired() {
  open();
  if (!cache) return { sessions: 0, codes: 0 };

  const now = new Date().toISOString();
  let sessions = 0;
  let codes = 0;
  for (const [sid, s] of Object.entries(cache.sessions || {})) {
    if (!s || !s.expires || s.expires < now) {
      delete cache.sessions[sid];
      sessions += 1;
    }
  }
  for (const [k, c] of Object.entries(cache.codes || {})) {
    const used = c && (c.usedAt || Number(c.attempts || 0) >= 5);
    if (!c || used || (c.expires && c.expires < now)) {
      delete cache.codes[k];
      codes += 1;
    }
  }
  if (sessions || codes) persist();
  return { sessions, codes };
}

/** Sessions for one account, newest first — for "where am I signed in?". */
export function sessionsFor(userId) {
  open();
  return open()
    .prepare('SELECT sid, created, expires, ip, user_agent, last_seen FROM sessions WHERE user_id = ? ORDER BY created DESC')
    .all(userId);
}

/* ------------------------------------------------------------
   Audit log (append-only, SQL only)
   ------------------------------------------------------------ */

/**
 * @param {{action:string, actor?:object, actorId?:string, role?:string, target?:string, ip?:string, detail?:object}} entry
 */
export function audit(entry = {}) {
  try {
    open()
      .prepare(
        `INSERT INTO audit_log (at, actor_id, actor_email, role, action, target, ip, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        entry.at || new Date().toISOString(),
        entry.actorId || entry.actor?.id || null,
        norm(entry.actor?.email || entry.actorEmail),
        entry.role || entry.actor?.role || null,
        String(entry.action || 'unknown').slice(0, 80),
        entry.target === undefined || entry.target === null ? null : String(entry.target).slice(0, 200),
        entry.ip || null,
        entry.detail ? JSON.stringify(entry.detail).slice(0, 4000) : null
      );
  } catch (err) {
    console.error('[audit] could not record:', err.message);
  }
}

export function readAudit({ limit = 50, offset = 0, action = '', actorId = '' } = {}) {
  open();
  const where = [];
  const args = [];
  if (action) { where.push('action = ?'); args.push(action); }
  if (actorId) { where.push('actor_id = ?'); args.push(actorId); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = open()
    .prepare(`SELECT * FROM audit_log ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...args, Math.min(Number(limit) || 50, 500), Math.max(Number(offset) || 0, 0));
  const total = open().prepare(`SELECT COUNT(*) AS n FROM audit_log ${clause}`).get(...args).n;
  return {
    total,
    entries: rows.map((r) => ({
      id: r.id,
      at: r.at,
      actorId: r.actor_id,
      actorEmail: r.actor_email,
      role: r.role,
      action: r.action,
      target: r.target,
      ip: r.ip,
      detail: r.detail ? safeJson(r.detail) : null,
    })),
  };
}

export function auditActions() {
  open();
  return open().prepare('SELECT action, COUNT(*) AS n FROM audit_log GROUP BY action ORDER BY n DESC').all();
}

const safeJson = (s) => { try { return JSON.parse(s); } catch { return s; } };

/* ------------------------------------------------------------
   Health, stats, backups
   ------------------------------------------------------------ */

export function stats() {
  if (!sqlite) return { engine: 'sqlite', ready: false };
  const counts = {};
  for (const t of ['users', 'students', 'gradings', 'sessions', 'codes', 'audit_log']) {
    counts[t] = sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  }
  let bytes = 0;
  try { bytes = fs.statSync(DB_FILE).size; } catch { /* not there yet */ }
  return {
    engine: 'sqlite',
    ready: true,
    file: path.basename(DB_FILE),
    bytes,
    journal: sqlite.pragma('journal_mode', { simple: true }),
    counts,
  };
}

export function integrity() {
  if (!sqlite) return 'not-open';
  try {
    return sqlite.pragma('quick_check', { simple: true });
  } catch (err) {
    return `error: ${err.message}`;
  }
}

/** One snapshot per process start; older ones are pruned (last 7 kept). */
export function backupNow(tag = 'auto') {
  if (!sqlite) return null;
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    const dest = path.join(BACKUP_DIR, `volyx-${stamp}.db`);
    if (tag === 'manual' || !fs.existsSync(dest)) {
      fs.copyFileSync(DB_FILE, dest);
    }
    const files = fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => f.endsWith('.db'))
      .sort();
    while (files.length > 7) {
      const old = files.shift();
      fs.rmSync(path.join(BACKUP_DIR, old), { force: true });
    }
    return dest;
  } catch (err) {
    console.error('[store] backup failed:', err.message);
    return null;
  }
}

export function vacuum() {
  if (!sqlite) return false;
  try {
    sqlite.exec('VACUUM');
    return true;
  } catch (err) {
    console.error('[store] vacuum failed:', err.message);
    return false;
  }
}

/* ------------------------------------------------------------
   Import an existing data/db.json the first time we open
   ------------------------------------------------------------ */

function importLegacyJson(target) {
  if (getKv('imported', false)) return;
  if (!fs.existsSync(JSON_FILE)) {
    cache.meta = { ...(cache.meta || {}), storage: 'sqlite', storageSince: new Date().toISOString() };
    snapshot(cache);
    persist();
    return;
  }
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8'));
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object') {
    console.warn('[store] data/db.json could not be read — starting with an empty database');
    return;
  }

  const upgraded = upgradeLegacy(parsed);    // complete, blank()-shaped object
  cache.settings = upgraded.settings;
  cache.users = upgraded.users || [];
  cache.students = upgraded.students || [];
  cache.classes = upgraded.classes || [];
  cache.terms = upgraded.terms || [];
  cache.gradings = upgraded.gradings || [];
  cache.sessions = upgraded.sessions || {};
  cache.codes = upgraded.codes || {};
  cache.createdAt = upgraded.createdAt || cache.createdAt;
  shadow.clear();                            // nothing is on disk yet — write it all
  cache.meta = {
    ...(upgraded.meta || {}),
    storage: 'sqlite',
    storageSince: new Date().toISOString(),
    importedFrom: 'db.json',
  };
  persist();

  try {
    const keep = path.join(DATA_DIR, `db.imported-${Date.now()}.json`);
    fs.renameSync(JSON_FILE, keep);
    console.log(`[store] imported data/db.json → ${path.basename(DB_FILE)} (old file kept as ${path.basename(keep)})`);
  } catch { /* the database is what matters */ }

  sqlite.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v')
    .run('imported', 'true');
}

/* Bring any older JSON schema up to the current one. */
function upgradeLegacy(prev) {
  let next = { ...prev };
  if (Number(prev.schema || 0) < 3) {
    next.users = (prev.users || []).map((u) => ({ role: 'teacher', ...u }));
    next.students = (prev.students || []).map((s) => ({
      accountId: null, loginEmail: null, credentialIssuedAt: null, ...s,
    }));
  }
  if (Number(prev.schema || 0) < 4) {
    next.users = (next.users || []).map((u) => ({
      ...u,
      role: u.role === 'student' ? 'student' : u.role === 'admin' ? 'admin' : 'teacher',
    }));
    const byId = new Map((next.students || []).map((s) => [s.id, s]));
    next.gradings = (next.gradings || []).map((g) => {
      const st = byId.get(g.studentId);
      return {
        ...g,
        studentEmail: String(g.studentEmail || st?.email || '').toLowerCase(),
        studentName: g.studentName || st?.name || '',
      };
    });
  }
  next = { ...blank(), ...next, schema: SCHEMA };
  next.settings = { ...blank().settings, ...(prev.settings || {}) };
  next.sessions = prev.sessions || {};
  next.codes = prev.codes || {};
  return next;
}

export const uid = (prefix = 'id') =>
  `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
