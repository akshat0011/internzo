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

console.log('\n== slug parity with the browser copy ==');
// web/public/app.js duplicates this function to link to the generated pages. If
// the two ever drift the site links to a 404, so the duplication is pinned here.
const appSrc = readFileSync(join(ROOT, 'web', 'public', 'app.js'), 'utf8');
const start = appSrc.indexOf('function jobPageSlug(job) {');
const end = appSrc.indexOf('\n}', start);
const browserSlug = new Function(`${appSrc.slice(start, end + 2)}; return jobPageSlug;`)();

for (const job of [ats, linkedin, { id: 'x', company: 'Ford & Co', title: 'Intern — Data' }]) {
  check(`parity: ${job.company}`, browserSlug(job), jobSlug(job));
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
check('posted date is rendered', withHttps.includes('<dd>2026-07-01</dd>'), true);
// A row with no dates at all must not abort the whole publish step.
check('undated job still renders', typeof renderJobPage({ ...linkedin, bullets: [] }), 'string');

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
