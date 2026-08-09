import { compose } from '../src/telegram.js';

let pass = 0, fail = 0;
function ok(label, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra ? ' — ' + extra : ''}`); }
}

const job = (over = {}) => ({
  job_id: '4449259269', company: 'NoBroker.com',
  title: 'Engineering Intern', location: 'Bengaluru', workplace_type: 'On-site', ...over,
});

console.log('\n== one message per run ==');
const three = compose([job(), job({ job_id: '2', title: 'Backend Intern' }), job({ job_id: '3', title: 'QA Intern' })]);
ok('header counts the batch', three.includes('<b>3 new internships</b>'));
ok('singular when there is one', compose([job()]).includes('<b>1 new internship</b>'));
ok('every role is named', ['Engineering Intern', 'Backend Intern', 'QA Intern'].every((t) => three.includes(t)));

console.log('\n== links point at the site, not LinkedIn ==');
ok('links to the job page on internzo.in', three.includes('https://www.internzo.in/jobs/nobroker-com-engineering-intern-4449259269'));
ok('closes with a link to the feed', three.includes('>See every live role →</a>'));
ok('no linkedin.com links', !three.includes('linkedin.com'));

console.log('\n== untrusted text is escaped ==');
// A real posting title with an ampersand; unescaped it makes Telegram 400 the
// whole message, silently dropping every job in the batch.
const nasty = compose([job({ company: 'Tom & Jerry <Labs>', title: 'Dev & Ops Intern' })]);
ok('ampersands escaped', nasty.includes('Tom &amp; Jerry'));
ok('angle brackets escaped', nasty.includes('&lt;Labs&gt;'));
ok('no raw < from the data survives', !/Jerry <Labs/.test(nasty));

console.log('\n== stays inside Telegram limits ==');
const many = Array.from({ length: 40 }, (_, i) =>
  job({ job_id: String(i), title: 'A very long internship title that goes on '.repeat(4) + i }));
const big = compose(many);
ok('under the 4096-char hard limit', big.length < 4096, `${big.length} chars`);
ok('says how many were not listed', /and \d+ more on the site/.test(big));
ok('does not truncate mid-tag', (big.match(/<a /g) || []).length === (big.match(/<\/a>/g) || []).length);

console.log('\n== degenerate input ==');
ok('missing location does not print a stray dash', !compose([job({ location: null, workplace_type: null })]).includes(' — \n'));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
