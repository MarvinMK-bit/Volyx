/* ============================================================
   AUTH PRIMITIVES
   Password hashing (scrypt), verification codes (hashed at rest),
   session tokens and simple in-process rate limiting.
   ============================================================ */

import crypto from 'node:crypto';

/* Normalise before validating: trim, lower-case, and drop the invisible
   characters that sneak in when an address is pasted (zero-width space,
   zero-width joiner, BOM, non-breaking space). */
export const normEmail = (e) =>
  String(e ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '');

/* Deliberately permissive: something@something.tld (2+ char TLD).
   Plus addressing, dots, apostrophes, hyphens and subdomains all pass. */
export const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normEmail(e));

/* ---------------- passwords ---------------- */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  }).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, salt, expectedHash) {
  if (!salt || !expectedHash) return false;
  try {
    const actual = crypto.scryptSync(String(password), salt, SCRYPT.keylen, {
      N: SCRYPT.N,
      r: SCRYPT.r,
      p: SCRYPT.p,
    });
    const expected = Buffer.from(expectedHash, 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function passwordProblem(password) {
  const pw = String(password ?? '');
  if (pw.length < 8) return 'Use at least 8 characters.';
  if (pw.length > 200) return 'That password is too long.';
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return 'Mix letters and numbers.';
  return '';
}

/* ---------------- verification codes ---------------- */

export const CODE_TTL_MINUTES = 15;
export const CODE_MAX_ATTEMPTS = 5;

export function makeCode() {
  return String(crypto.randomInt(100000, 1000000));
}

export function hashCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

export function codeMatches(code, storedHash) {
  if (!storedHash) return false;
  const a = Buffer.from(hashCode(code), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------------- sessions ---------------- */

export const SESSION_HOURS = 12;

export function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

/* ---------------- rate limiting (per process) ---------------- */

const buckets = new Map();

/**
 * @returns {boolean} true when the caller is over the limit
 */
export function rateLimited(key, max = 5, windowMs = 10 * 60 * 1000) {
  const now = Date.now();
  const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  hits.push(now);
  buckets.set(key, hits);
  if (buckets.size > 5000) buckets.clear();
  return hits.length > max;
}

export function resetRateLimit(key) {
  buckets.delete(key);
}
