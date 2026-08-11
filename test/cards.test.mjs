/**
 * The search-card parser.
 *
 * Every case below is the verbatim line list of a real card, captured from
 * `/jobs/search-results/` on 11 Aug 2026 — the redesign that removed
 * `data-job-id`, the named list containers and the `<li>` wrappers, and left
 * card text as the only thing to read. Parsing that text is now the only path
 * from LinkedIn to the site, so it is checked against the real shapes rather
 * than against invented ones.
 */
import { parseCardLines, cardKey, cardIdentity } from '../src/linkedin.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n         got:  ${a}\n         want: ${e}`); }
}
function card(label, lines, want) {
  const p = parseCardLines(lines);
  check(label, {
    title: p.title, company: p.company, location: p.location,
    workplaceType: p.workplaceType, postedText: p.postedText,
    easyApply: p.easyApply, viewed: p.viewed,
  }, want);
}

console.log('\n== card shapes ==');

// The common shape: an accessible label repeating the title, then title,
// company, location, then metadata.
card('plain card', [
  'Technical Support Intern', 'Technical Support Intern', 'PIE MATRIX', 'Gurugram (On-site)',
  'Actively reviewing applicants', 'Be an early applicant', '·', 'Posted 2 minutes ago',
  '2 minutes ago', '·', 'Easy Apply',
], { title: 'Technical Support Intern', company: 'PIE MATRIX', location: 'Gurugram',
     workplaceType: 'On-site', postedText: '2 minutes ago', easyApply: true, viewed: false });

// "(Verified job)" is decoration on the label only — it must not reach the title.
card('verified badge stripped', [
  'Intern (Verified job)', 'Intern', 'IQVIA', 'Bengaluru (Hybrid)',
  'Viewed', '·', 'Be an early applicant', '·', 'Posted 19 hours ago', '19 hours ago',
], { title: 'Intern', company: 'IQVIA', location: 'Bengaluru',
     workplaceType: 'Hybrid', postedText: '19 hours ago', easyApply: false, viewed: true });

// The card LinkedIn has open in the pane gets a "Selected, " prefix as well.
card('selected card prefix stripped', [
  'Selected, Student Intern (Verified job)', 'Student Intern',
  'Foundation for Innovation and Technology Transfer, IIT Delhi', 'New Delhi (On-site)',
  'Actively reviewing applicants', 'Viewed', '·', 'Be an early applicant', '·',
  'Posted 26 minutes ago', '26 minutes ago', '·', 'Easy Apply',
], { title: 'Student Intern', company: 'Foundation for Innovation and Technology Transfer, IIT Delhi',
     location: 'New Delhi', workplaceType: 'On-site', postedText: '26 minutes ago',
     easyApply: true, viewed: true });

// No workplace mode in brackets, and no Easy Apply.
card('bare location', [
  'Intern - SQA (Verified job)', 'Intern - SQA', 'Silicon Labs', 'Hyderabad',
  'Viewed', '·', 'Be an early applicant', '·', 'Posted 14 hours ago', '14 hours ago',
], { title: 'Intern - SQA', company: 'Silicon Labs', location: 'Hyderabad',
     workplaceType: null, postedText: '14 hours ago', easyApply: false, viewed: true });

// A company name containing a comma and brackets must not be split or trimmed.
card('punctuated company', [
  'Intern, IT Operations (6-Month Term)', 'Intern, IT Operations (6-Month Term)',
  'Connor, Clark & Lunn Financial Group (CC&L)', 'Gurugram (Hybrid)',
  'Be an early applicant', '·', 'Posted 16 hours ago', '16 hours ago',
], { title: 'Intern, IT Operations (6-Month Term)', company: 'Connor, Clark & Lunn Financial Group (CC&L)',
     location: 'Gurugram', workplaceType: 'Hybrid', postedText: '16 hours ago',
     easyApply: false, viewed: false });

// A location that is itself a country, plus a pipe in the company name.
card('remote, piped company', [
  'X/Twitter Intern', 'X/Twitter Intern', 'FlowSet Hub | AI Services', 'India (Remote)',
  'Actively reviewing applicants', 'Be an early applicant', '·', 'Posted 19 hours ago',
  '19 hours ago', '·', 'Easy Apply',
], { title: 'X/Twitter Intern', company: 'FlowSet Hub | AI Services', location: 'India',
     workplaceType: 'Remote', postedText: '19 hours ago', easyApply: true, viewed: false });

console.log('\n== reading by line NUMBER is what breaks ==');
// Fixed indices work on a decorated card and quietly file metadata as the
// location on an undecorated one. These two differ by one line and must parse
// to the same fields.
const decorated = parseCardLines(['Growth Intern', 'Growth Intern', 'AscentDevs', 'India (Remote)', 'Be an early applicant', '·', '15 hours ago']);
const undecorated = parseCardLines(['Growth Intern', 'AscentDevs', 'India (Remote)', 'Be an early applicant', '·', '15 hours ago']);
check('label present or absent parses alike',
  [decorated.title, decorated.company, decorated.location],
  [undecorated.title, undecorated.company, undecorated.location]);
check('metadata never lands in the location', undecorated.location, 'India');

console.log('\n== the detail pane header is not a card ==');
// The pane's own header passes the "logo + three lines" test but reads
// company/title/facts, so it parses into nonsense. scanCardsInPage keeps it out
// by requiring a card to sit inside the results column; this records what gets
// published if that filter is ever dropped.
const paneHeader = parseCardLines([
  'PIE MATRIX', 'Technical Support Intern',
  'Gurugram, Haryana, India · 2 minutes ago · 0 applicants',
  'Promoted by hirer · Company review time is typically 1 week',
]);
check('pane header misreads company as title', paneHeader.title, 'PIE MATRIX');

console.log('\n== unreadable cards ==');
check('no lines', parseCardLines([]).title, '');
check('no lines gives no company', parseCardLines([]).company, '');
check('title but no company', parseCardLines(['Intern', 'Be an early applicant', '2 hours ago']).company, '');

console.log('\n== keys ==');
const a = { company: 'IQVIA', title: 'Intern', postedText: '19 hours ago' };
check('key is namespaced', cardKey(a), 'card:iqvia|intern|19 hours ago');
check('key is case and space insensitive',
  cardKey({ company: '  iqvia ', title: 'INTERN', postedText: '19  hours ago' }), cardKey(a));
// A relisting carries the same company and title but a fresh posted time. The
// skip-record key must separate them; the card_keys identity must not.
check('key separates a repost', cardKey({ ...a, postedText: '3 minutes ago' }) !== cardKey(a), true);
check('identity drops the time', cardIdentity(a), 'card:iqvia|intern');
check('identity survives ageing',
  cardIdentity({ ...a, postedText: '3 minutes ago' }), cardIdentity(a));

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
