/* ============================================================
   STUDENT CREDENTIALS
   When a guardian adds a student profile we mint a login for that
   student automatically: a school-style address plus a temporary
   password. The password is shown once and stored only as a hash.

   Nothing here touches the network — it is pure string building so
   it stays easy to reason about and to test.
   ============================================================ */

import { uid } from './db.js';

const LOWER = 'abcdefghijkmnpqrstuvwxyz';        // no l, no o
const DIGITS = '23456789';                        // no 0, no 1
const pick = (set, n) =>
  Array.from({ length: n }, () => set[Math.floor(Math.random() * set.length)]).join('');

/** "Amina Nakato" → "amina.nakato" */
export function slugifyName(name) {
  const parts = String(name || '')
    .normalize('NFKD')
    .replace(/[^\w\s.-]/g, '')
    .trim()
    .toLowerCase()
    .split(/[\s._-]+/)
    .filter(Boolean);
  if (!parts.length) return 'student';
  return parts.slice(0, 2).join('.');
}

/**
 * Builds a unique student login address.
 * @param {string} name        student full name
 * @param {string} domain      e.g. students.volyx.ug
 * @param {Set<string>} taken  every address already in use
 */
export function buildLoginEmail(name, domain, taken = new Set()) {
  const slug = slugifyName(name);
  let candidate = `${slug}@${domain}`;
  let n = 2;
  while (taken.has(candidate)) {
    candidate = `${slug}${n}@${domain}`;
    n += 1;
  }
  return candidate;
}

/**
 * Temporary password in a shape people can read aloud:
 * kq4t-m2rz-8x  (prefixed so it is obviously a Volyx credential)
 */
export function tempPassword() {
  return `Vx-${pick(LOWER + DIGITS, 4)}-${pick(LOWER + DIGITS, 4)}-${pick(DIGITS, 2)}`;
}

/** The account object for a student profile. Password is hashed by the caller. */
export function studentAccount({ student, guardianId, loginEmail, passwordSalt, passwordHash, now }) {
  return {
    id: uid('u'),
    email: loginEmail,
    name: student.name,
    role: 'student',
    emailVerified: true,               // credentials were issued by the guardian
    verifiedAt: now,
    verifiedBy: 'guardian',
    passwordSalt,
    passwordHash,
    provider: 'temp-password',
    mustChangePassword: true,
    studentId: student.id,
    ownerId: guardianId,               // the guardian who may manage this login
    createdAt: now,
  };
}
