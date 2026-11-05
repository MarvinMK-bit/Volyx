/* ============================================================
   DEMO SIMULATOR
   Produces gradings shaped exactly like GradeScriptUG's
   GET /grading/{id} response, so the whole portal (upload →
   poll → report card) can be clicked through before a real
   API key is connected. Nothing here runs when a live key is set.
   ============================================================ */

const BANK = {
  Mathematics: [
    ['Linear equations', 'Solve for x: 3x − 7 = 11, showing your working'],
    ['Algebraic fractions', 'Simplify (x² − 9) / (x + 3)'],
    ['Simultaneous equations', 'Solve 2x + y = 11 and x − y = 1'],
    ['Pythagoras', 'A ladder leans 4 m from a wall and reaches 3 m up. Find its length'],
    ['Statistics', 'Find the median of 4, 7, 7, 9, 12, 15'],
    ['Geometry', 'Find the interior angle sum of a regular hexagon'],
  ],
  'English Language': [
    ['Comprehension', 'Explain, in your own words, why the writer describes the town as "restless"'],
    ['Grammar', 'Rewrite in reported speech: "I will come tomorrow," she said'],
    ['Punctuation', 'Punctuate: the teacher asked where have you been'],
    ['Composition', 'Describe a market day in your town (one paragraph)'],
    ['Vocabulary', 'Give a synonym and an antonym for "generous"'],
    ['Summary', 'Summarise the passage in not more than 40 words'],
  ],
  Biology: [
    ['Cell structure', 'State two differences between plant and animal cells'],
    ['Photosynthesis', 'Write the word equation for photosynthesis'],
    ['Digestion', 'Name the enzyme that digests starch and state where it acts'],
    ['Respiration', 'Explain the difference between aerobic and anaerobic respiration'],
    ['Excretion', 'Name the main waste products removed by the kidneys'],
    ['Ecology', 'Explain one effect of deforestation on a food chain'],
  ],
  Chemistry: [
    ['Atomic structure', 'State the number of protons, neutrons and electrons in ²³Na'],
    ['Acids and bases', 'Explain why sodium hydroxide solution turns litmus blue'],
    ['Bonding', 'Describe the bonding in sodium chloride'],
    ['Reactions', 'Balance: Fe + O₂ → Fe₂O₃'],
    ['Separation', 'Describe how to separate sand from a salt solution'],
    ['The periodic table', 'Explain the trend in reactivity down Group I'],
  ],
  Physics: [
    ['Pressure', 'Calculate the pressure of a 60 N force acting on 0.2 m²'],
    ['Electricity', 'State the relationship between current, voltage and resistance'],
    ['Forces', "State Newton's third law in your own words"],
    ['Light', 'Define the focal point of a concave mirror'],
    ['Heat', 'Explain why metal conducts heat better than wood'],
    ['Waves', 'State two differences between transverse and longitudinal waves'],
  ],
  History: [
    ['Pre-colonial states', 'Name two coastal states that traded with Arab merchants'],
    ['Colonial rule', 'Explain one effect of indirect rule on Uganda'],
    ['Independence', 'State two contributions of the 1960 Lancaster Conference'],
    ['World wars', 'Explain one cause of the Second World War'],
    ['Economy', 'Describe the role of the Buganda Agreement in land ownership'],
    ['Rights', 'Name two rights guaranteed by the 1995 Constitution'],
  ],
  Geography: [
    ['Map work', 'State the bearing of the school from the river'],
    ['Climate', 'Explain how relief affects rainfall'],
    ['Population', 'With reasons, which region has the highest population density'],
    ['Agriculture', 'Name two problems facing coffee farming'],
    ['Erosion', 'Explain one method used to control soil erosion'],
    ['Water', 'Describe two uses of wetlands'],
  ],
  Entrepreneurship: [
    ['Business plan', 'State three components of a business plan'],
    ['Costing', 'A trader buys at UGX 2,000 and sells at UGX 2,500. Find the profit margin'],
    ['Records', 'Explain why a business keeps a cash book'],
    ['Marketing', 'Describe one advantage of advertising on radio'],
    ['Finance', 'Name two sources of short-term finance for an SME'],
    ['Ethics', 'State two ways to build customer loyalty'],
  ],
};

const RATIONALE_GOOD = [
  'Correct working shown throughout.',
  'Method is right and the final answer is correct.',
  'Clear and complete answer.',
];
const RATIONALE_PARTIAL = [
  'Right method, but an arithmetic slip in the last line.',
  'Two of the three required points given.',
  'Answer is correct but the working is not shown.',
  'Most steps correct; the final simplification is wrong.',
];
const RATIONALE_POOR = [
  'Does not address what the question asks.',
  'Working shown is confused and the answer is wrong.',
  'No answer given.',
  'Left blank.',
];
const RATIONALE_BLANK = ['Left blank.'];

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (arr, r) => arr[Math.floor(r() * arr.length) % arr.length];

function feedbackFor(subject, level, percent, weakest, strongest) {
  const band =
    percent >= 75 ? 'strong' : percent >= 60 ? 'steady' : percent >= 45 ? 'improving' : 'weak';
  const open = {
    strong: `You showed a very strong grasp of ${subject} this term.`,
    steady: `A dependable performance in ${subject} this term.`,
    improving: `You are making progress in ${subject}, though some topics still need work.`,
    weak: `This term was difficult in ${subject}, and the work needs to be done again.`,
  }[band];
  const detail =
    weakest && weakest !== strongest
      ? ` Revise "${weakest}" before the next assessment — it cost you the most marks.`
      : '';
  const close = {
    strong: ' Keep up this standard and push into the extension questions.',
    steady: ' Focus on showing every step of your working to secure the marks you already earn.',
    improving: ' Use the marked script feedback, redo the flagged questions, and bring them to me.',
    weak: ' Please attend the remedial sessions and resubmit corrected work.',
  }[band];
  return `${open}${detail}${close} You scored ${percent}% at ${level}.`;
}

export function simulateGrading({
  studentFullname,
  studentNumber = '',
  subject,
  level = 'S.2',
  assessmentType = 'End of term exam',
  ability = 0.6,
  seedKey = '',
  attachments = [],
}) {
  const r = rng(hashString(`${studentFullname}|${subject}|${assessmentType}|${seedKey}`));
  const bank = BANK[subject] || [
    ['General', `Explain one key idea from ${subject} covered this term`],
    ['Application', `Apply ${subject} to a real situation and explain your answer`],
    ['Reasoning', `Give two reasons to support your answer in ${subject}`],
    ['Recall', `Define the main term studied in ${subject}`],
  ];

  const questions = bank.map(([topic, questionText], i) => {
    const max = [2, 3, 2, 4, 3, 2][i % 6];
    const attempted = r() > 0.06;
    const skill = Math.min(1, Math.max(0.05, ability + (r() - 0.5) * 0.45));
    let awarded = attempted ? Math.round(max * skill * 2) / 2 : 0;
    awarded = Math.min(max, Math.max(0, awarded));
    const ratio = max ? awarded / max : 0;
    const graded = attempted ? r() > 0.04 : true;
    return {
      ref: String(i + 1),
      questionText,
      topic,
      awarded: graded ? awarded : null,
      max,
      rationale: !attempted
        ? pick(RATIONALE_BLANK, r)
        : ratio >= 0.85
          ? pick(RATIONALE_GOOD, r)
          : ratio >= 0.45
            ? pick(RATIONALE_PARTIAL, r)
            : pick(RATIONALE_POOR, r),
      attempted,
      graded,
      needsReview: !graded ? true : ratio > 0 && ratio < 0.5 ? r() > 0.75 : false,
      reviewReason: '',
    };
  });

  questions.forEach((q) => {
    if (q.needsReview && !q.reviewReason) {
      q.reviewReason = 'Handwriting unclear at the answer line — confirm the mark.';
    }
  });

  const maxTotal = questions.reduce((n, q) => n + q.max, 0);
  const awardedTotal = questions.reduce((n, q) => n + (q.awarded ?? 0), 0);
  const percent = maxTotal ? Math.round((awardedTotal / maxTotal) * 100) : 0;

  const weak = [...questions].sort((a, b) => (a.awarded ?? 0) / a.max - (b.awarded ?? 0) / b.max)[0];
  const strong = [...questions].sort((a, b) => (b.awarded ?? 0) / b.max - (a.awarded ?? 0) / a.max)[0];

  const annotations = questions.slice(0, 4).map((q, i) => ({
    attachmentID: 'att_demo_1',
    page: 1,
    type:
      (q.awarded ?? 0) === 0
        ? 'CROSS'
        : (q.awarded ?? 0) >= q.max
          ? 'TICK'
          : 'PARTIAL',
    x: 0.12,
    y: 0.14 + i * 0.19,
    width: 0.36,
    height: 0.1,
    questionRef: q.ref,
    comment: (q.awarded ?? 0) >= q.max ? '' : q.rationale,
    markAwarded: q.awarded,
    maximumMark: q.max,
    needsReview: q.needsReview,
    reviewReason: q.reviewReason,
  }));

  const topics = questions.map((q) => q.topic).slice(0, 3).join(', ');
  const title = `${level} ${subject}: ${topics}`;

  return {
    id: `sim_${hashString(`${studentFullname}|${subject}|${assessmentType}|${seedKey}`).toString(16)}`,
    status: 'COMPLETED',
    pipeline: 'STANDARD',
    apiKeyID: 'demo-key',
    studentFullname,
    studentNumber,
    subject,
    level,
    assessmentType,
    instructions: '',
    title,
    description: `${assessmentType} for ${level} ${subject}, covering ${topics}.`,
    feedback: feedbackFor(subject, level, percent, weak?.topic, strong?.topic),
    error: '',
    totalMark: awardedTotal,
    maximumMark: maxTotal,
    questions,
    annotations,
    attachments:
      attachments.length > 0
        ? attachments.map((a, i) => ({
            id: `att_demo_${i + 1}`,
            type: a.type || 'SCRIPT',
            index: a.index || i + 1,
            filename: a.filename || `script-${i + 1}.pdf`,
          }))
        : [{ id: 'att_demo_1', type: 'SCRIPT', index: 1, filename: 'script.pdf' }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: 'demo',
  };
}

export function abilityFor(name) {
  // stable per-student ability between 0.42 and 0.94
  const r = rng(hashString(name));
  return 0.42 + r() * 0.52;
}
