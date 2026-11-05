/* ============================================================
   GradeScriptUG API client
   ------------------------------------------------------------
   Base URL : https://api.gradescriptug.com/client/v1
   Auth     : Authorization: Bearer gsk_<keyID8>_<secret32>
   Flow     : POST /grading  ->  202 Accepted (id, PENDING)
              GET  /grading/{id}  until COMPLETED | PARTIAL | FAILED

   The key never leaves this server: browser requests to the
   GradeScript API are rejected by design, so every call is proxied.
   ============================================================ */

import { db, persist } from './db.js';
import { GRADESCRIPT } from '../config/school.js';
import { simulateGrading, abilityFor } from './simulator.js';

export class ApiError extends Error {
  constructor(message, status = 502, payload = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

export function currentKey() {
  return db().settings.apiKey || process.env.GRADESCRIPT_API_KEY || '';
}

export function isDemo() {
  return !currentKey();
}

export function keyHint(key = currentKey()) {
  if (!key) return '';
  const m = /^gsk_([0-9a-f]{8})_/i.exec(key);
  return m ? `gsk_${m[1]}••••` : '••••';
}

export function looksValidKey(key = '') {
  return /^gsk_[0-9a-f]{8}_[0-9a-f]{32}$/i.test(key.trim());
}

function normaliseList(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload) return [];
  for (const k of ['data', 'results', 'items', 'gradings']) {
    if (Array.isArray(payload[k])) return payload[k];
    if (payload[k] && typeof payload[k] === 'object') {
      for (const kk of ['data', 'results', 'items', 'gradings']) {
        if (Array.isArray(payload[k][kk])) return payload[k][kk];
      }
    }
  }
  return [];
}

async function call(path, { method = 'GET', body, apiKey = currentKey(), query } = {}) {
  if (!apiKey) throw new ApiError('No GradeScriptUG API key connected.', 401);

  const url = new URL(GRADESCRIPT.baseUrl + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    }
  }

  const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };
  if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(url, { method, headers, body });
  } catch (err) {
    throw new ApiError(`Could not reach GradeScriptUG: ${err.message}`, 502);
  }

  const text = await res.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { message: text };
  }

  if (!res.ok) {
    const msg =
      payload?.message ||
      payload?.error ||
      `${res.status} ${res.statusText}`;
    throw new ApiError(msg, res.status, payload);
  }
  return payload?.data !== undefined ? payload.data : payload;
}

/* ---------------- key management ---------------- */

export async function verifyKey(key) {
  if (!looksValidKey(key)) {
    return {
      ok: false,
      message: 'That does not look like a GradeScriptUG key. Expected gsk_<8 hex chars>_<32 hex chars>.',
    };
  }
  try {
    const data = await call('/grading', { apiKey: key.trim(), query: { limit: 1 } });
    const list = normaliseList(data);
    return { ok: true, message: `Key accepted — ${list.length} grading(s) visible.` };
  } catch (err) {
    return { ok: false, message: err.message, status: err.status };
  }
}

/* ---------------- gradings ---------------- */

export async function createGrading({ fields, files }) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null && v !== '') form.append(k, String(v));
  }
  files.forEach((f, i) => {
    const type = (f.type || (i === 0 ? 'SCRIPT' : 'SCRIPT')).toUpperCase();
    form.append(`attachments[${i}][type]`, type);
    if (f.index) form.append(`attachments[${i}][index]`, String(f.index));
    form.append(
      `attachments[${i}][file]`,
      new Blob([f.data], { type: f.contentType || 'application/pdf' }),
      f.filename || `file-${i + 1}`
    );
  });

  return call('/grading', { method: 'POST', body: form });
}

export async function getGrading(id) {
  return call(`/grading/${encodeURIComponent(id)}`);
}

export async function listGradings({ status } = {}) {
  const data = await call('/grading', { query: { status } });
  return normaliseList(data);
}

export async function retryGrading(id) {
  return call(`/grading/${encodeURIComponent(id)}/retry`, { method: 'PATCH' });
}

export async function deleteGrading(id) {
  return call(`/grading/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/* ---------------- demo mode ---------------- */

export function demoCreateGrading({ fields, files }) {
  const grading = simulateGrading({
    studentFullname: fields.studentFullname,
    studentNumber: fields.studentNumber || '',
    subject: fields.subject,
    level: fields.level || 'S.2',
    assessmentType: fields.assessmentType || 'Assessment',
    ability: abilityFor(fields.studentFullname),
    seedKey: `${fields.subject}|${fields.assessmentType}|${Date.now()}`,
    attachments: files,
  });
  // starts queued; the server ticker advances it like the real pipeline
  return {
    ...grading,
    status: 'PENDING',
    totalMark: null,
    maximumMark: null,
    questions: [],
    feedback: '',
    _demoPlan: { granted: grading, stage: 0 },
  };
}

export function advanceDemoGrading(grading) {
  const plan = grading._demoPlan;
  if (!plan) return grading;
  plan.stage += 1;
  if (plan.stage === 1) {
    grading.status = 'PROCESSING';
  } else if (plan.stage >= 2) {
    const g = plan.granted;
    Object.assign(grading, {
      status: plan.fail ? 'FAILED' : 'COMPLETED',
      title: g.title,
      description: g.description,
      feedback: g.feedback,
      totalMark: g.totalMark,
      maximumMark: g.maximumMark,
      questions: g.questions,
      annotations: g.annotations,
    });
    if (plan.fail) {
      grading.error = "We couldn't read the handwriting on the script pages.";
      grading.totalMark = null;
      grading.maximumMark = null;
    }
    delete grading._demoPlan;
  }
  grading.updatedAt = new Date().toISOString();
  return grading;
}

export function markKeyStatus(status, message) {
  const d = db();
  d.settings.keyStatus = status;
  d.settings.keyMessage = message || '';
  d.settings.keyCheckedAt = new Date().toISOString();
  persist();
}
