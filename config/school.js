/* ============================================================
   SCHOOL CONFIG — edit this file to make the portal yours.
   Everything here is safe to expose to the browser
   (it is served through GET /api/config).
   ============================================================ */

export const PLATFORM = {
  name: 'Volyx',
  tagline: 'Marks in. Report cards out.',
  description:
    'Volyx turns scripts marked by GradeScriptUG into official report cards your students can open with their school email.',
  version: '1.0',
};

/* ============================================================
   PLATFORM ADMIN
   One account owns the GradeScriptUG API key and every grading
   in the platform runs on it. Nobody else can read or change it.

   The address is fixed here on purpose: signing up or signing in
   with it is the only way to become an administrator, so it can
   never be granted from the UI.
   ============================================================ */

export const PLATFORM_ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'ryanroject@gmail.com').trim().toLowerCase();

/* Password for the seeded admin account (change it after first sign-in). */
export const PLATFORM_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'volyx-admin-2026';

export const ROLES = {
  admin: 'admin',       // owns the platform key + grades like a teacher
  teacher: 'teacher',   // manages students, uploads scripts, publishes results
  student: 'student',   // read-only: everything addressed to their email
};

/* Login domain for auto-generated student accounts.
   Student logins look like amina.nakato@students.volyx.ug — they are real
   accounts inside Volyx, not mailboxes hosted anywhere. */
export const STUDENT_LOGIN_DOMAIN = 'students.volyx.ug';

/* How long an auto-generated temporary password stays usable, in days. */
export const TEMP_PASSWORD_DAYS = 30;

export const SCHOOL = {
  name: 'St. Brigid Secondary School',
  shortName: 'SBSS',
  motto: 'Knowledge · Integrity · Service',
  address: 'P.O. Box 4271, Kampala, Uganda',
  phone: '+256 700 000 000',
  email: 'results@stbrigids.ac.ug',
  logoText: 'SB',
  gradingNote:
    'This report is generated from scripts marked by GradeScriptUG. Marks for questions flagged for review are provisional.',
};

/* UNEB-style grading scale. points: lower is better (used for the aggregate). */
export const GRADING_SCALE = [
  { min: 80, max: 100, grade: 'A', points: 1, label: 'Excellent' },
  { min: 70, max: 79, grade: 'B', points: 2, label: 'Very good' },
  { min: 60, max: 69, grade: 'C', points: 3, label: 'Good' },
  { min: 50, max: 59, grade: 'D', points: 4, label: 'Fair' },
  { min: 40, max: 49, grade: 'E', points: 5, label: 'Weak' },
  { min: 0, max: 39, grade: 'F', points: 9, label: 'Needs support' },
];

/* Aggregate = sum of the best N subject points (lower is better). */
export const DIVISIONS = [
  { max: 24, division: 'I', title: 'Division I' },
  { max: 36, division: 'II', title: 'Division II' },
  { max: 48, division: 'III', title: 'Division III' },
  { max: 60, division: 'IV', title: 'Division IV' },
  { max: Infinity, division: 'U', title: 'Ungraded' },
];

export const REPORTING = {
  bestSubjects: 8, // how many subjects count toward the aggregate
  positionByPercent: true,
  terms: [
    { id: '2026-T1', name: 'Term I', year: 2026, starts: '2026-02-02', ends: '2026-05-01' },
    { id: '2026-T2', name: 'Term II', year: 2026, starts: '2026-05-24', ends: '2026-08-21' },
    { id: '2026-T3', name: 'Term III', year: 2026, starts: '2026-09-13', ends: '2026-12-04' },
  ],
  currentTerm: '2026-T3',
  classes: [
    { id: 's2-blue', name: 'S.2 Blue', level: 'S.2' },
    { id: 's2-gold', name: 'S.2 Gold', level: 'S.2' },
    { id: 's3-blue', name: 'S.3 Blue', level: 'S.3' },
  ],
  subjects: [
    'Mathematics',
    'English Language',
    'Biology',
    'Chemistry',
    'Physics',
    'History',
    'Geography',
    'Entrepreneurship',
  ],
};

/* Demo behaviour.
   seedGradings:false  → the app starts with the school register but NO results,
   so every report card is empty until real scripts are graded. */
export const DEMO = {
  seedStudents: false, // every account starts with 0 students
  seedGradings: false, // and therefore no results
};

export const GRADESCRIPT = {
  baseUrl: 'https://api.gradescriptug.com/client/v1',
  pollSeconds: 6,
};
