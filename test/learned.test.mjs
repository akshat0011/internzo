/**
 * The learned-vocabulary guard.
 *
 * `learn()` writes to the real state file, so every case here is one that is
 * refused — those return before the first save and cannot touch the vocabulary
 * on disk. The store is asserted empty at the end to keep it that way.
 *
 * What this pins down is the 12 Aug poisoning: `intern`, `trainee`,
 * `apprentice` and `summer analyst` had all been learned as NON-tech. They are
 * the terms the search is built from, so every card LinkedIn returns contains
 * one by construction and they carry no signal at all. Because only a
 * multi-word positive outranks a negative, single-word tech signals could not
 * survive one — `Flutter Developer Intern` was refused before it was ever
 * opened. It ran for a week and was still growing when it was found.
 */
import { learn } from '../src/learned.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n         got:  ${a}\n         want: ${e}`); }
}

// config.matching.titleMustMatch, which is what src/index.js passes in.
const BLOCKED = ['intern', 'internship', 'trainee', 'co-op', 'coop', 'summer analyst', 'apprentice'];

// Every blocked term genuinely appears here, so nothing below is refused for
// merely being absent from the posting — the blocklist is what fires.
const posting = {
  title: 'Flutter Developer Intern',
  description: 'A paid internship building Flutter apps. Trainee and apprentice '
    + 'tracks run alongside the summer analyst cohort; co-op placements welcome.',
  company: 'Example',
};

const store = { version: 1, terms: {} };
const noBuiltIns = new Map();
const why = (term, opts = {}) => learn(
  store,
  { term, isTech: false, ...posting },
  opts.builtIns ?? noBuiltIns,
  opts.blocked ?? BLOCKED,
).why;

console.log('\n== the terms the search is built from are refused ==');
for (const term of BLOCKED) {
  check(`refuses "${term}"`, why(term), 'a term the search is built from, so every posting contains it');
}

console.log('\n== the term is normalised before it is checked ==');
check('uppercase', why('INTERN'), 'a term the search is built from, so every posting contains it');
check('padded', why('  intern  '), 'a term the search is built from, so every posting contains it');
check('collapsed whitespace', why('summer   analyst'), 'a term the search is built from, so every posting contains it');

console.log('\n== the blocklist does not swallow real vocabulary ==');
// Refused for being absent from the posting, NOT by the blocklist — proves a
// term merely containing a blocked word still reaches the later checks.
check('a longer term containing one', why('research intern programme'), 'not present in the posting');
check('an unrelated term', why('kubernetes'), 'not present in the posting');

console.log('\n== the blocklist is what does the blocking ==');
// Same inputs, empty list: execution must reach the built-in check below it.
check('empty list lets "intern" through',
  why('intern', { blocked: [], builtIns: new Map([['intern', true]]) }),
  'contradicts the built-in vocabulary');
check('omitted list defaults to empty',
  learn(store, { term: 'intern', isTech: false, ...posting }, new Map([['intern', true]])).why,
  'contradicts the built-in vocabulary');

console.log('\n== nothing was written ==');
check('the vocabulary is untouched', Object.keys(store.terms), []);

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
