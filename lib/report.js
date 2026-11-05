/* ============================================================
   MARKS → REPORT CARD
   Turns finished GradeScriptUG gradings into the numbers a
   report card needs: per-subject percentages, letter grades,
   points, aggregate, division, class position and comments.
   ============================================================ */

import { GRADING_SCALE, DIVISIONS, REPORTING, SCHOOL } from '../config/school.js';

export const FINISHED = ['COMPLETED', 'PARTIAL'];

export function gradeFor(percent) {
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  const band =
    GRADING_SCALE.find((b) => p >= b.min && p <= b.max) ||
    GRADING_SCALE[GRADING_SCALE.length - 1];
  return { grade: band.grade, points: band.points, label: band.label };
}

export function divisionFor(aggregate) {
  if (aggregate === null || aggregate === undefined) return { division: '—', title: 'Not graded' };
  const d = DIVISIONS.find((x) => aggregate <= x.max) || DIVISIONS[DIVISIONS.length - 1];
  return { division: d.division, title: d.title };
}

const pct = (awarded, max) => (max > 0 ? Math.round((awarded / max) * 1000) / 10 : 0);

/** Group a student's finished gradings into one row per subject. */
export function subjectRows(gradings) {
  const bySubject = new Map();

  for (const g of gradings) {
    if (!FINISHED.includes(g.status)) continue;
    if (typeof g.totalMark !== 'number' || typeof g.maximumMark !== 'number' || g.maximumMark <= 0) continue;

    const subject = g.subject || 'Unspecified';
    if (!bySubject.has(subject)) bySubject.set(subject, []);
    bySubject.get(subject).push(g);
  }

  const rows = [];
  for (const [subject, items] of bySubject) {
    const awarded = items.reduce((n, g) => n + g.totalMark, 0);
    const max = items.reduce((n, g) => n + g.maximumMark, 0);
    const percent = pct(awarded, max);
    const { grade, points, label } = gradeFor(percent);
    const partial = items.some((g) => g.status === 'PARTIAL');

    rows.push({
      subject,
      assessments: items
        .map((g) => ({
          id: g.id,
          title: g.title || `${g.assessmentType || 'Assessment'} — ${subject}`,
          assessmentType: g.assessmentType || 'Assessment',
          awarded: g.totalMark,
          max: g.maximumMark,
          percent: pct(g.totalMark, g.maximumMark),
          status: g.status,
          feedback: g.feedback || '',
          questions: (g.questions || []).map((q) => ({
            ref: q.ref,
            topic: q.topic,
            awarded: q.awarded,
            max: q.max,
            rationale: q.rationale,
            needsReview: Boolean(q.needsReview),
            reviewReason: q.reviewReason || '',
            graded: q.graded !== false,
          })),
          flagged: (g.questions || []).filter((q) => q.needsReview || q.graded === false).length,
          date: g.updatedAt || g.createdAt || null,
        }))
        .sort((a, b) => String(a.date).localeCompare(String(b.date))),
      awarded,
      max,
      percent,
      grade,
      points,
      label,
      provisional: partial,
    });
  }

  return rows.sort((a, b) => a.subject.localeCompare(b.subject));
}

function aggregateOf(rows) {
  const taken = [...rows]
    .sort((a, b) => a.points - b.points || b.percent - a.percent)
    .slice(0, REPORTING.bestSubjects);
  return {
    subjectsCounted: taken.length,
    aggregate: taken.length ? taken.reduce((n, r) => n + r.points, 0) : null,
  };
}

function averageOf(rows) {
  if (!rows.length) return 0;
  return Math.round((rows.reduce((n, r) => n + r.percent, 0) / rows.length) * 10) / 10;
}

/* ---- comments ---- */

function teacherComment({ average, division, rows, position, classSize, student }) {
  const name = (student.name || '').split(' ')[0] || 'The student';
  const best = [...rows].sort((a, b) => b.percent - a.percent)[0];
  const worst = [...rows].sort((a, b) => a.percent - b.percent)[0];

  let opening;
  if (average >= 70) opening = `${name} has had an excellent term, working consistently well across the subjects.`;
  else if (average >= 60) opening = `${name} has had a good term with steady, reliable effort.`;
  else if (average >= 50) opening = `${name} has had a fair term. The effort is there but the results are not yet matching it.`;
  else if (average >= 40) opening = `${name} has found the term difficult and several subjects need urgent attention.`;
  else opening = `${name} has had a very weak term and requires close support at home and in school.`;

  const strengths = best ? ` ${best.subject} is the strongest subject at ${best.percent}%` : '';
  const weakness =
    worst && worst.subject !== best?.subject
      ? `, while ${worst.subject} (${worst.percent}%) needs the most work before next term.`
      : '.';

  let closing;
  if (position && classSize) {
    const frac = position / classSize;
    if (frac <= 0.15) closing = ' Keep this position — the standard is high.';
    else if (frac <= 0.5) closing = ' Moving into the top half of the class is a realistic target next term.';
    else closing = ' A structured revision timetable is recommended before next term.';
  } else {
    closing = '';
  }

  return `${opening}${strengths}${weakness}${closing}`.trim();
}

function headTeacherComment({ average, division }) {
  if (average >= 70) return 'Excellent results. The school is proud of this performance.';
  if (average >= 60) return 'Good performance. Maintain the effort and aim higher next term.';
  if (average >= 50) return 'Fair performance. More consistent revision will improve these results.';
  if (average >= 40) return 'Below expectation. Parent/guardian is asked to meet the class teacher.';
  return `Division ${division} is not acceptable at this level. A meeting with the school administration is required.`;
}

/* ---- report card ---- */

export function buildReportCard({ student, term, gradings, cohort = [] }) {
  const rows = subjectRows(gradings);
  const average = averageOf(rows);
  const { aggregate, subjectsCounted } = aggregateOf(rows);
  const { division, title: divisionTitle } = divisionFor(aggregate);

  const myRank = cohort.find((c) => c.studentId === student.id);

  const cards = {
    student: {
      id: student.id,
      name: student.name,
      email: student.email,
      studentNumber: student.studentNumber,
      className: student.className || '',
      level: student.level || '',
      photoUrl: student.photoUrl || '',
    },
    school: {
      name: SCHOOL.name,
      motto: SCHOOL.motto,
      address: SCHOOL.address,
      phone: SCHOOL.phone,
      email: SCHOOL.email,
      logoText: SCHOOL.logoText,
    },
    term: { id: term.id, name: term.name, year: term.year, ends: term.ends },
    rows,
    summary: {
      subjects: rows.length,
      average,
      aggregate,
      subjectsCounted,
      division,
      divisionTitle,
      position: myRank?.position || null,
      classSize: myRank?.classSize || null,
      totalAwarded: rows.reduce((n, r) => n + r.awarded, 0),
      totalMax: rows.reduce((n, r) => n + r.max, 0),
      provisional: rows.some((r) => r.provisional),
    },
    comment: teacherComment({
      average,
      division,
      rows,
      position: myRank?.position,
      classSize: myRank?.classSize,
      student,
    }),
    headComment: headTeacherComment({ average, division }),
    gradingNote: SCHOOL.gradingNote,
    scale: GRADING_SCALE.map((b) => ({
      grade: b.grade,
      range: `${b.min}–${b.max}`,
      points: b.points,
      label: b.label,
    })),
    generatedAt: new Date().toISOString(),
  };

  return cards;
}

/** Rank the class for one term, so position and class size are consistent. */
export function rankCohort(classStudents, gradings, termId) {
  const rows = classStudents.map((s) => {
    const mine = gradings.filter(
      (g) => g.studentId === s.id && g.termId === termId && FINISHED.includes(g.status)
    );
    const subjectRowsForStudent = subjectRows(mine);
    return {
      studentId: s.id,
      name: s.name,
      average: averageOf(subjectRowsForStudent),
      subjects: subjectRowsForStudent.length,
    };
  });

  const ranked = rows
    .filter((r) => r.subjects > 0)
    .sort((a, b) => b.average - a.average)
    .map((r, i) => ({ ...r, position: i + 1, classSize: rows.filter((x) => x.subjects > 0).length }));

  return ranked;
}
