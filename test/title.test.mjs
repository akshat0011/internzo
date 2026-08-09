import { matchTitle } from '../src/config.js';

const TERMS = ['intern', 'internship', 'trainee', 'co-op', 'coop', 'summer analyst', 'apprentice'];

let pass = 0, fail = 0;
function check(title, expected) {
  const got = matchTitle(title, TERMS);
  if (got === expected) {
    pass++;
    console.log(`  ok    ${String(got).padEnd(5)} ${title}`);
  } else {
    fail++;
    console.log(`  FAIL  got ${got} want ${expected}  —  ${title}`);
  }
}

// The underscore is a \w character, so a \b boundary never fires next to one.
// Qualcomm posts every one of its IT internships as "Intern_<team>", and all of
// them were dropped as not-an-internship while Qualcomm sat on the watchlist.
console.log('\n== separators that are not spaces ==');
check('Interim Intern_OneIT', true);
check('Intern_SoftwareEngineering', true);
check('2026 Summer Intern_Hardware', true);
check('Trainee_Analytics', true);

console.log('\n== ordinary titles still match ==');
check('Software Engineer Intern', true);
check('Software Development Internship in Bangalore (Hybrid)', true);
check('Intern, Smart Factory Solutions', true);
check('Graduate Engineer Trainee', true);
check('Co-op Software Developer', true);
check('Summer Analyst - Technology', true);
check('Apprentice Technical Consultant', true);

console.log('\n== non-internships still rejected ==');
// The whole reason the boundary exists: a plain substring test matched these.
check('International Sales Manager', false);
check('Internal Audit Manager', false);
check('Senior Software Engineer', false);
check('Interim Finance Director', false);

console.log('\n== degenerate input ==');
for (const [label, v] of [['empty', ''], ['null', null], ['undefined', undefined]]) {
  const got = matchTitle(v, TERMS);
  if (got === false) { pass++; console.log(`  ok    false ${label}`); }
  else { fail++; console.log(`  FAIL  ${label} -> ${got}`); }
}
// No terms configured means the filter is off, so everything passes.
const off = matchTitle('Anything At All', []);
if (off === true) { pass++; console.log('  ok    true  empty term list disables the filter'); }
else { fail++; console.log(`  FAIL  empty term list -> ${off}`); }

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
