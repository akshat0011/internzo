/**
 * The "did the job list actually render" guard.
 *
 * It exists for one failure: LinkedIn changes its markup, the card selectors
 * silently return nothing, and a broken scan looks exactly like a quiet day.
 * That is worth an alarm.
 *
 * What it must NOT alarm on is the tail of a result set. LinkedIn does not say
 * "no results" there — it serves a normal results page with the result count
 * and working pagination, pads it with "Expand your search" and "Top job picks
 * for you", and leaves whatever is left of the search on it. That can be a
 * single card, or one stamped "Viewed" with no recency marker at all;
 * scanCardsInPage finds cards BY that marker, so it correctly reports zero.
 *
 * Six runs died that way between 13 and 17 Aug 2026, every one on the page
 * straight after the last good one — page 3 after two pages of 47 cards, page 2
 * after one page of 20. The discriminator is that a selector break cannot
 * render 24 cards on page 1 and 0 on page 2.
 */
import { assertListRendered } from '../src/guard.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n         got:  ${a}\n         want: ${e}`); }
}

// Runs the guard's real page predicate against fake body text, and records
// whether a screenshot was attempted — noise this guard used to produce 26
// times over for pages that were perfectly healthy.
function stubPage(bodyText) {
  const calls = { screenshots: 0 };
  return {
    calls,
    screenshot: async () => { calls.screenshots++; throw new Error('no browser under test'); },
    evaluate: async (fn) => {
      globalThis.document = { body: { innerText: bodyText } };
      try { return fn(); } finally { delete globalThis.document; }
    },
  };
}

async function run(bodyText, cardCount, opts) {
  const page = stubPage(bodyText);
  let threw = null;
  try {
    await assertListRendered(page, cardCount, { pageIndex: 2, searchLabel: 'test', ...opts });
  } catch (err) { threw = err.message; }
  return { threw, screenshots: page.calls.screenshots };
}

// Verbatim from the 17 Aug screenshot: a real results page, 26 results, page 2,
// one "Viewed" card carrying no recency marker.
const TAIL_PAGE = '26 results\nMIS Ops Internship in Navi Mumbai\nBNM Business Solutions LLP\n'
  + 'Thane, Maharashtra, India (On-site)\nViewed\nSee jobs where you’re a top applicant\n'
  + 'Expand your search\nExpand date posted to past week\n+1,916 jobs\nRemove all filters\n'
  + 'Previous 1 2\nTop job picks for you';

console.log('\n== the tail of a result set is not an alarm ==');
{
  const r = await run(TAIL_PAGE, 0, { renderedEarlierPage: true });
  check('page 2 after a good page 1 does not throw', r.threw, null);
  check('and does not burn a screenshot', r.screenshots, 0);
}

console.log('\n== a real selector break still alarms ==');
{
  // Nothing has rendered yet, and the page is plainly a working results list.
  const r = await run('913 results\nSoftware Engineer Intern\nGoogle\nBengaluru\n2 hours ago', 0, { renderedEarlierPage: false });
  check('page 1 with 0 cards throws', typeof r.threw, 'string');
  check('and says what it suspects', /markup/.test(r.threw ?? ''), true);
  check('and captures the evidence', r.screenshots, 1);
}

console.log('\n== LinkedIn saying so outright is not an alarm ==');
// The curly apostrophe is the point, not an accident: LinkedIn writes
// "couldn’t" with U+2019, and the pattern is `couldn'?t`, so before the
// normalising fix this exact string threw.
for (const phrase of ['No matching jobs found.', 'No results found', 'We couldn’t find anything',
  "We couldn't find anything", '0 results', 'Try a different search']) {
  const r = await run(phrase, 0, { renderedEarlierPage: false });
  check(`"${phrase.slice(0, 24)}" is benign`, r.threw, null);
}

console.log('\n== cards present short-circuits everything ==');
{
  const r = await run('anything at all', 24, { renderedEarlierPage: false });
  check('no throw', r.threw, null);
  check('no screenshot', r.screenshots, 0);
}

console.log('\n== the flag defaults to the strict behaviour ==');
{
  // Omitted entirely: a caller that has not been updated must still get the alarm.
  const r = await run('913 results\nSoftware Engineer Intern', 0, {});
  check('missing flag still throws', typeof r.threw, 'string');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
