'use strict';
const ext = require('./extractor');

const keys = Object.keys(ext).join(', ');
console.log('exports:', keys);
['classifyDecisionPattern','computeDecisionPatternDiversity','computeSignalScore',
 'extract','extractConceptDecisions','extractConceptExcerpts','extractSessionNarrative'].forEach(k => {
  if (!ext[k]) throw new Error('MISSING export: ' + k);
});
console.log('all expected exports present');

const { classifyDecisionPattern, computeDecisionPatternDiversity, computeSignalScore } = ext;

// classifyDecisionPattern
const cdpTests = [
  ['We decided to use React',           'CHOICE'],
  ['going with TypeScript',             'CHOICE'],
  ['opted for Postgres',                'CHOICE'],
  ['we will use Redis',                 'CHOICE'],
  ["we'll use GraphQL here",            'CHOICE'],
  ['Avoid using jQuery',                'AVOIDANCE'],
  ["we don't use lodash here",          'AVOIDANCE'],
  ['not using moment.js',               'AVOIDANCE'],
  ['rejected that approach',            'AVOIDANCE'],
  ['We switched from Redux to Zustand', 'EVOLUTION'],
  ['migrated to Postgres',              'EVOLUTION'],
  ['moved away from Webpack',           'EVOLUTION'],
  ['deprecated the old API',            'EVOLUTION'],
  ['Confirmed, still using Postgres',   'CONFIRMATION'],
  ['sticking with the plan',            'CONFIRMATION'],
  ['continuing with TypeScript',        'CONFIRMATION'],
  ['works well for our use case',       'CONFIRMATION'],
  ['The sky is blue',                   null],
  ['just a random sentence',            null],
];
let cdpPassed = 0;
for (const [input, expected] of cdpTests) {
  const got = classifyDecisionPattern(input);
  if (got !== expected) throw new Error(`classifyDecisionPattern("${input}") => ${got}, expected ${expected}`);
  cdpPassed++;
}
console.log('classifyDecisionPattern: ' + cdpPassed + '/' + cdpTests.length + ' OK');

// computeDecisionPatternDiversity
const items = [
  { session: { id: '1', timestamp: new Date('2024-01-01'), source: 'claude' },
    extracted: { concepts: ['react'],
                 decisions: ['We decided to use React', 'Avoid jQuery', 'We switched from Vue'],
                 snippets: [] } },
  { session: { id: '2', timestamp: new Date('2024-02-01'), source: 'claude' },
    extracted: { concepts: ['react'],
                 decisions: ['Confirmed, still using React'],
                 snippets: [] } },
];
const diversity = computeDecisionPatternDiversity('react', items);
// 'We decided to use React' -> react matches -> CHOICE
// 'Avoid jQuery'            -> no react      -> skip
// 'We switched from Vue'    -> no react      -> skip
// 'Confirmed, still using React' -> react matches -> CONFIRMATION
// diversity = 2
if (diversity !== 2) throw new Error('diversity expected 2, got ' + diversity);
console.log('computeDecisionPatternDiversity: OK (' + diversity + ')');

// computeSignalScore
const score1 = computeSignalScore('react', items);
// sessionCount=2, decisionCount=2, codeCount=0, projects=1
// diversity=2, recency=0 (no allSessions)
// (2*2)+(2*5)+(0*3)+(1*4)+(2*2)+0 = 4+10+0+4+4+0 = 22
if (score1 !== 22) throw new Error('score1 expected 22, got ' + score1);
console.log('score without allSessions:', score1, 'OK');

// backward compat: small allSessions guard
const score2 = computeSignalScore('react', items, items);
if (score1 !== score2) throw new Error('small guard: expected ' + score1 + ', got ' + score2);
console.log('small allSessions guard: OK');

// recency with >= 20 sessions
const bigSessions = [];
const nowMs = Date.now();
for (let i = 0; i < 25; i++) {
  const ts = new Date(nowMs - (24 - i) * 86400000);
  bigSessions.push({
    session: { id: 'b' + i, timestamp: ts, source: 'claude' },
    extracted: { concepts: i < 5 ? ['react'] : ['vue'], decisions: [], snippets: [] }
  });
}
// Make the most recent session (index 24) also mention react
bigSessions[24].extracted.concepts = ['react'];
bigSessions[24].extracted.decisions = ['We will use React going forward'];
const reactItems = bigSessions.filter(s => s.extracted.concepts.includes('react'));
const score3 = computeSignalScore('react', reactItems, bigSessions);
const score3b = computeSignalScore('react', reactItems); // no allSessions
const diff = score3 - score3b;
if (Math.abs(diff - 1.5) > 0.0001) throw new Error('Expected recency diff of 1.5, got ' + diff);
console.log('recency bonus: +' + diff + ' OK');

console.log('\nAll smoke tests passed.');
