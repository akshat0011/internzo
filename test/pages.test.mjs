import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jobSlug, slugify, renderJobPage, renderCompanyPage, renderCompanyIndex, writePages } from '../src/pages.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n         got:  ${a}\n         want: ${e}`); }
}

const ats = { id: 'ats:greenhouse:alphagrepsecurities:8622004002', company: 'AlphaGrep Securities', title: 'Software Development Intern' };
const linkedin = { id: '4441247638', company: 'Adobe', title: 'AI Engineer Apprentice' };

console.log('\n== job slugs ==');
// A colon in the filename is what makes a Windows checkout of this repo fail.
check('ats id carries no colon', jobSlug(ats).includes(':'), false);
check('ats id is fully slugified', jobSlug(ats),
  'alphagrep-securities-software-development-intern-ats-greenhouse-alphagrepsecurities-8622004002');
// A numeric id survives slugify untouched, so no existing LinkedIn URL moves.
check('linkedin url is unchanged', jobSlug(linkedin), 'adobe-ai-engineer-apprentice-4441247638');
check('slug is filesystem-safe', /^[a-z0-9-]+$/.test(jobSlug(ats)), true);
check('missing id does not produce a trailing dash', jobSlug({ id: null, company: 'X', title: 'Y' }), 'x-y-role');
// Two Workday requisitions from one tenant differ only in their last characters.
// Capping the id at slugify's 70 would collide them onto a single page.
const wd = (n) => ({ company: 'Piramal Pharma', title: 'Intern', id: `ats:workday:piramalpharma:wd102:PIRAMAL_EXTERNAL_CAREERS:R0000${n}` });
check('long ids are not truncated', jobSlug(wd(2295)) !== jobSlug(wd(2296)), true);
check('long id survives in full', jobSlug(wd(2295)).endsWith('r00002295'), true);

console.log('\n== slug parity with the browser copies ==');
// app.js and page.js each duplicate this function to link to the generated
// pages. If any copy drifts the site links to a 404, so all three are pinned.
function slugFrom(file) {
  const src = readFileSync(join(ROOT, 'web', 'public', file), 'utf8');
  const start = src.indexOf('function jobPageSlug(job) {');
  const end = src.indexOf('\n}', start);
  return new Function(`${src.slice(start, end + 2)}; return jobPageSlug;`)();
}

for (const file of ['app.js', 'page.js']) {
  const browserSlug = slugFrom(file);
  for (const job of [ats, linkedin, { id: 'x', company: 'Ford & Co', title: 'Intern — Data' }]) {
    check(`parity ${file}: ${job.company}`, browserSlug(job), jobSlug(job));
  }
}

console.log('\n== slugify ==');
check('ampersand becomes and', slugify('Ford & Co'), 'ford-and-co');
check('collapses punctuation', slugify('Intern — Data (Remote)'), 'intern-data-remote');
check('empty falls back', slugify(''), 'role');
check('caps length', slugify('a'.repeat(200)).length, 70);

console.log('\n== apply links ==');
const page = { ...linkedin, postedAt: Date.UTC(2026, 6, 1), firstSeenAt: Date.UTC(2026, 6, 1), bullets: ['a', 'b'] };
const withJs = renderJobPage({ ...page, applyUrl: 'javascript:alert(1)' });
check('javascript: url is not rendered', withJs.includes('javascript:alert(1)'), false);
check('no empty apply href', withJs.includes('href=""'), false);
const withHttps = renderJobPage({ ...page, applyUrl: 'https://www.linkedin.com/jobs/view/1' });
check('https url is rendered', withHttps.includes('href="https://www.linkedin.com/jobs/view/1"'), true);
// Checked on the machine-readable attribute, not the visible string: the
// visible one is a human date ("1 Jul 2026") and page.js rewrites the pill
// above it to a relative age, so pinning display text pins the design.
check('posted date is rendered', withHttps.includes('datetime="2026-07-01"'), true);
// The trap this whole file exists downstream of: postedText is frozen at scrape
// time and never ages, so a day-old posting kept reading "4 minutes ago".
check('postedText never reaches the page',
  renderJobPage({ ...page, postedText: '4 minutes ago' }).includes('4 minutes ago'), false);
// A row with no dates at all must not abort the whole publish step.
check('undated job still renders', typeof renderJobPage({ ...linkedin, bullets: [] }), 'string');

// ONE apply button, in the rail, plus the mobile dock's copy of it — and that
// is all. The rail is sticky on a desktop and the dock catches a phone reader
// who has scrolled past it, so a third copy in the how-to-apply band was never
// reachable at a moment neither of these was. Two identical primary buttons in
// the same column also cost the first one its weight.
check('exactly two apply buttons: the rail and the dock',
  withHttps.split('class="btn-apply"').length - 1, 2);
// Bounded at the rail, because both surviving buttons sit after the band in
// source order and an open-ended slice catches them.
const band = withHttps.slice(withHttps.indexOf('apply-band'), withHttps.indexOf('<aside class="jp-side"'));
check('the how-to-apply band carries no button', band.includes('btn-apply'), false);
check('but it still gives the advice', band.includes('applying early matters'), true);

console.log('\n== the page shows our summary, and only clean facts ==');

// The summary is our own writing about the posting — the field was in the data
// and unused, and it is the paragraph that decides whether anyone reads on.
const summarised = renderJobPage({ ...page, summary: 'Builds the payments API.' });
check('the summary is rendered', summarised.includes('Builds the payments API.'), true);
check('and it is escaped', renderJobPage({ ...page, summary: '<img src=x onerror=1>' })
  .includes('<img src=x'), false);

// Both fields carry mis-parsed values: "2,026" is a year that reached the money
// slot, and "0 to 3 years" is an experience requirement that reached the
// duration slot. Neither belongs in front of a student.
check('a stipend with no currency is dropped',
  renderJobPage({ ...page, stipend: '2,026' }).includes('2,026'), false);
check('a real stipend is kept',
  renderJobPage({ ...page, stipend: '\u20b925,000 / month' }).includes('25,000 / month'), true);
check('an experience range is not shown as a duration',
  renderJobPage({ ...page, duration: '0 to 3 years' }).includes('0 to 3 years'), false);
check('a real duration is kept',
  renderJobPage({ ...page, duration: '6 months' }).includes('6 months'), true);

console.log('\n== a job page offers somewhere else to go ==');

// The reason this exists: somebody arriving from a search has either applied or
// decided not to, and in both cases the next useful thing is another role.
const sibling = { id: '999', company: 'Adobe', title: 'Data Intern', bullets: ['a', 'b'],
  postedAt: Date.UTC(2026, 6, 2), firstSeenAt: Date.UTC(2026, 6, 2) };
const withSiblings = renderJobPage(page, [page, sibling]);
check('the employer\u2019s other role is linked',
  withSiblings.includes(`/jobs/${jobSlug(sibling)}`), true);
check('the page does not link to itself in that strip',
  withSiblings.split(`href="/jobs/${jobSlug(page)}"`).length - 1, 0);
check('the hub is always linked', withSiblings.includes('/companies/adobe'), true);
// The default has to keep working: the tests above all call it with one arg.
check('siblings are optional', typeof renderJobPage(page), 'string');

//==============================================================================
// Company hubs are PERMANENT.
//
// They used to be built only from live jobs and deleted the moment an
// employer's last posting aged out. 198 distinct hubs had been deleted against
// 83 live, and several flapped — piramal-pharma and bain-and-company were each
// deleted four times and rebuilt five. Every cycle 404s a URL Google has
// indexed and discards the ranking it had accrued.
//
// Job pages still expire; Google's JobPosting rules require that. Only the hub
// survives, carrying past roles so an empty one is not thin content.
//==============================================================================
console.log('\n== company hubs survive their postings ==');

const live = (title) => ({ id: `${title}-1`, company: 'Qualcomm', title, bullets: ['a', 'b'],
  postedAt: Date.UTC(2026, 7, 1), firstSeenAt: Date.UTC(2026, 7, 1) });
const past = (title, y, m) => ({ company: 'Qualcomm', title, roleLabel: '', postedAt: Date.UTC(y, m, 3) });

const emptyHub = renderCompanyPage('Qualcomm', [], [past('Systems Intern', 2026, 6), past('SW Intern', 2026, 5)]);
check('a hub with no live roles still renders', typeof emptyHub, 'string');
check('and names the employer', emptyHub.includes('Qualcomm internships in India'), true);
check('and shows what they have posted before', emptyHub.includes('Previously posted'), true);
check('and lists the past titles', emptyHub.includes('Systems Intern'), true);
check('and dates them to the month', emptyHub.includes('Jul 2026'), true);

// The whole point of keeping the page: it must still be indexable, or Google
// drops it just as surely as a 404 did.
check('two past roles is enough to index', emptyHub.includes('noindex'), false);
// ...but a hub with nothing behind it is thin, and thin is its own penalty.
const thinHub = renderCompanyPage('Qualcomm', [], [past('Systems Intern', 2026, 6)]);
check('a single past role is not', thinHub.includes('noindex'), true);
check('and neither is nothing at all', renderCompanyPage('Qualcomm', [], []).includes('noindex'), true);

console.log('\n== expired roles carry no JobPosting markup ==');
// Marking up a closed posting as a JobPosting is what earns a structured-data
// manual action, and that lands on the whole domain.
check('no JobPosting on a history-only hub', /JobPosting/.test(emptyHub), false);
check('past roles are not linked', /href="\/jobs\//.test(emptyHub), false);
// ItemList is only emitted for live roles.
check('no ItemList without live roles', /ItemList/.test(emptyHub), false);

console.log('\n== live and past do not duplicate ==');
const mixed = renderCompanyPage('Qualcomm', [live('Systems Intern')],
  [past('Systems Intern', 2026, 6), past('Older Intern', 2026, 4)]);
// Compare only the "Previously posted" section — the live title legitimately
// appears several times above it, in the list, the ItemList and the meta tags.
const pastSection = mixed.slice(mixed.indexOf('Previously posted'));
check('a title that is live is not repeated as past', pastSection.includes('Systems Intern'), false);
check('a genuinely past title still shows', pastSection.includes('Older Intern'), true);
check('a live hub does carry ItemList', /ItemList/.test(mixed), true);

console.log('\n== the index lists employers that are not hiring today ==');
const idx = renderCompanyIndex(
  new Map([['Adobe', [live('AI Intern')]]]),
  new Map([['Qualcomm', [past('a', 2026, 6), past('b', 2026, 5)]]]),
);
check('the hiring employer is listed', idx.includes('Adobe'), true);
check('so is the quiet one', idx.includes('Qualcomm'), true);
check('and it is labelled honestly', idx.includes('no live roles'), true);

console.log('\n== writePages keeps a hub whose jobs have all expired ==');
{
  const dir = mkdtempSync(join(tmpdir(), 'internzo-pages-'));
  // Sweep one: the employer is hiring.
  writePages([live('Systems Intern')], dir, [past('Systems Intern', 2026, 6), past('Older', 2026, 4)]);
  const hub = join(dir, 'companies', 'qualcomm.html');
  check('hub written while hiring', existsSync(hub), true);

  // Sweep two: every posting has aged out of the live set. This is the exact
  // moment the file used to be deleted.
  writePages([], dir, [past('Systems Intern', 2026, 6), past('Older', 2026, 4)]);
  check('hub survives when nothing is live', existsSync(hub), true);
  check('and the expired job page is gone', existsSync(join(dir, 'jobs', 'qualcomm-systems-intern-systems-intern-1.html')), false);
  check('sitemap still carries the hub',
    readFileSync(join(dir, 'sitemap.xml'), 'utf8').includes('/companies/qualcomm'), true);

  // A company we have never published must not gain a page.
  check('no hub for an employer with no history', existsSync(join(dir, 'companies', 'adobe.html')), false);
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
