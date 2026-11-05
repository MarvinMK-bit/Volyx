/* Seeds the school scaffolding (classes + terms) and ONE demo account.
   Students are never seeded: every new account — including the demo one —
   starts with zero students, so ownership and isolation are obvious. */

import { blank } from './db.js';
import {
  REPORTING,
  SCHOOL,
  DEMO,
  PLATFORM_ADMIN_EMAIL,
  PLATFORM_ADMIN_PASSWORD,
} from '../config/school.js';
import { hashPassword } from './auth.js';
import { simulateGrading, abilityFor } from './simulator.js';

export const DEMO_PASSWORD = 'volyx1234';
export const DEMO_EMAIL = 'robert.wamala@gmail.com';

export const ADMIN_EMAIL = PLATFORM_ADMIN_EMAIL;
export const ADMIN_PASSWORD = PLATFORM_ADMIN_PASSWORD;

export function seedDatabase() {
  const d = blank();

  d.classes = REPORTING.classes.map((c) => ({ ...c }));

  // Publishing is per account: term.published[ownerId] = [classIds]
  d.terms = REPORTING.terms.map((t) => ({ ...t, published: {} }));

  const now = new Date().toISOString();

  // The platform administrator: the only account that can hold the
  // GradeScriptUG key that every teacher's uploads run on.
  const adminPw = hashPassword(ADMIN_PASSWORD);
  const demoPw = hashPassword(DEMO_PASSWORD);

  d.users = [
    {
      id: 'u_admin',
      email: ADMIN_EMAIL,
      name: 'Platform Admin',
      role: 'admin',
      emailVerified: true,
      verifiedAt: now,
      passwordSalt: adminPw.salt,
      passwordHash: adminPw.hash,
      provider: 'password',
      isPlatformAdmin: true,
      createdAt: now,
    },
    {
      id: 'u_demo',
      email: DEMO_EMAIL,
      name: 'Robert Wamala',
      role: 'teacher',
      emailVerified: true,
      verifiedAt: now,
      passwordSalt: demoPw.salt,
      passwordHash: demoPw.hash,
      provider: 'password',
      createdAt: now,
    },
  ];

  // Zero students for a fresh account — this is the documented initial state.
  d.students = [];

  if (DEMO.seedGradings) {
    const subjects = REPORTING.subjects;
    const demo = d.students; // remains empty unless seedStudents is enabled
    let counter = 0;
    for (const term of d.terms) {
      for (const student of demo) {
        for (const subject of subjects) {
          counter += 1;
          const g = simulateGrading({
            studentFullname: student.name,
            studentNumber: student.studentNumber,
            subject,
            level: student.level,
            assessmentType: 'End of term exam',
            ability: abilityFor(`${student.name}-${subject}`),
            seedKey: `${term.id}-${student.id}-${subject}`,
          });
          const stamp = new Date(`${term.ends}T09:00:00Z`);
          stamp.setDate(stamp.getDate() - (20 - (counter % 15)));
          d.gradings.push({
            ...g,
            studentId: student.id,
            ownerId: student.ownerId,
            termId: term.id,
            createdAt: stamp.toISOString(),
            updatedAt: new Date(stamp.getTime() + 6 * 60 * 1000).toISOString(),
          });
        }
      }
    }
  }

  d.meta = {
    seeded: true,
    seededAt: new Date().toISOString(),
    demoNote: `Demo account for ${SCHOOL.name}.`,
  };

  return d;
}
