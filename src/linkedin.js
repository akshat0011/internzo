/**
 * The LinkedIn-specific layer: URL construction, list enumeration, detail
 * extraction.
 *
 * LinkedIn rotates its CSS class names, so nothing here trusts a single
 * selector. Every field is read through a ladder of strategies — stable data
 * attributes first, then ARIA and semantic structure, then text heuristics —
 * and anything that still comes up empty is reported rather than guessed at.
 * `assertListRendered` in guard.js turns a total miss into a loud error instead
 * of a quiet "no jobs today".
 */
import { log } from './logger.js';
import { pause, sleep, humanClick, humanScrollContainer, rand } from './human.js';
import { jobIdFromUrl } from './extract.js';
import { normaliseCompany } from './config.js';

export const RESULTS_PER_PAGE = 25;

/** Candidate selectors for the scrollable results column, best first. */
const LIST_CONTAINERS = [
  '.jobs-search-results-list',
  '.scaffold-layout__list > div',
  '.scaffold-layout__list',
  'div[data-results-list-top-scroll-sentinel] + div',
  '.jobs-search__results-list',
];

/**
 * Candidate selectors for the detail pane's description body.
 *
 * The first entry is the redesigned surface (`/jobs/search-results/`), and it is
 * the only id on the page that means anything: `JobDetails_AboutTheJob_<jobId>`
 * carries the posting's real id, which is otherwise absent from the DOM until
 * the URL updates. Everything after it is the previous layout, kept because the
 * standalone `/jobs/view/` page and the older search still serve it.
 */
const DESCRIPTION_SELECTORS = [
  '[id^="JobDetails_AboutTheJob_"]',
  '#job-details',
  '.jobs-description__content',
  '.jobs-description-content__text',
  '.jobs-box__html-content',
  'article.jobs-description__container',
  '[class*="jobs-description"]',
];

/**
 * Build a job-search URL.
 *
 * Verified parameters: f_TPR=r86400 is "posted within the last 86400 seconds",
 * sortBy=DD is date-descending (R would be relevance), f_JT=I is internship,
 * and `start` pages in increments of 25. Combining a tight keyword with
 * f_TPR + sortBy=DD is the cheapest way to keep the page count — and therefore
 * the request count — low.
 */
export function buildSearchUrl(search, filters, { start = 0 } = {}) {
  const params = new URLSearchParams();

  // A company-id search carries no keywords at all: f_C already restricts the
  // results to those exact employers, and adding a keyword could only narrow
  // it further and drop postings that do not happen to contain the word.
  if (search.companyIds?.length) {
    params.set('f_C', search.companyIds.join(','));
    if (search.keywords) params.set('keywords', search.keywords);
  } else {
    params.set('keywords', search.keywords ?? '');
  }

  if (search.location) params.set('location', search.location);
  if (search.geoId) params.set('geoId', String(search.geoId));

  const seconds = Math.round((filters.postedWithinHours ?? 24) * 3600);
  params.set('f_TPR', `r${seconds}`);
  params.set('sortBy', filters.sortBy === 'relevance' ? 'R' : 'DD');

  if (filters.jobTypes?.length) {
    // LinkedIn codes: F full-time, P part-time, C contract, T temporary,
    // I internship, V volunteer, O other.
    const codes = filters.jobTypes.map((t) => (t.length === 1 ? t : t.toUpperCase()[0] === 'I' ? 'I' : t[0].toUpperCase()));
    params.set('f_JT', [...new Set(codes)].join(','));
  }
  if (search.workplaceTypes?.length) params.set('f_WT', search.workplaceTypes.join(','));
  if (search.distance) params.set('distance', String(search.distance));
  if (start > 0) params.set('start', String(start));

  return `https://www.linkedin.com/jobs/search/?${params.toString()}`;
}

export function jobUrl(jobId) {
  return `https://www.linkedin.com/jobs/view/${jobId}/`;
}

/**
 * The same posting, but rendered inside the search results' detail pane.
 *
 * `/jobs/view/<id>` is the right URL to *publish* — it is what a human should
 * be sent to. It is the wrong URL to *read*, because the standalone page uses a
 * different layout from the pane, and every selector in DESCRIPTION_SELECTORS
 * is tuned for the pane. Navigating to the standalone page returns a
 * description of zero characters: the extraction silently produces nothing, and
 * the posting ends up on the site as a bare title.
 *
 * `?currentJobId=` asks the search page to open with that job already selected,
 * which puts the description back in the markup the extractor knows how to read.
 */
export function jobPaneUrl(jobId) {
  return `https://www.linkedin.com/jobs/search/?currentJobId=${jobId}`;
}

/**
 * Navigate, retrying the failures that are about the network rather than the
 * page.
 *
 * A laptop changes networks, sleeps, and reconnects constantly, and Chromium
 * surfaces that as ERR_NETWORK_CHANGED / ERR_INTERNET_DISCONNECTED / a
 * navigation timeout. These used to end the whole run: one recorded failure was
 * ERR_NETWORK_CHANGED on the very first page, which threw away a 15-minute slot
 * over a wifi handover that had already recovered by the time it was logged.
 *
 * Deliberately narrow. A 4xx/5xx from LinkedIn, a challenge, or a rate-limit
 * banner is NOT retried here — those are answered by guard.js, and retrying
 * into them is exactly the behaviour that turns a rate limit into a ban.
 */
// net::ERR_ABORTED is in here on purpose and is NOT the same as
// ERR_CONNECTION_ABORTED above. It is what Chromium reports when a second
// navigation supersedes the one we asked for — LinkedIn's own SPA redirect
// racing our goto — so it means "that load was replaced", not "the network
// failed". It was ending runs on the very first page load of the feed.
const TRANSIENT_NAV = /ERR_NETWORK_CHANGED|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_(RESET|CLOSED|TIMED_OUT|REFUSED|ABORTED)|ERR_ABORTED|ERR_ADDRESS_UNREACHABLE|ERR_QUIC_PROTOCOL_ERROR|ERR_HTTP2_PROTOCOL_ERROR|ERR_SOCKET_NOT_CONNECTED|ERR_EMPTY_RESPONSE|Timeout .* exceeded/i;

export async function gotoResilient(page, url, opts = {}, { attempts = 3, label = 'page' } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await page.goto(url, { waitUntil: 'domcontentloaded', ...opts });
    } catch (err) {
      lastErr = err;
      const first = err.message.split('\n')[0];
      if (!TRANSIENT_NAV.test(first) || attempt === attempts) throw err;
      log.warn(`Network hiccup loading ${label} (attempt ${attempt}/${attempts}): ${first}`);
      await sleep(2000 * attempt);
    }
  }
  throw lastErr;
}

/**
 * Start the session the way a person would: land on the feed, sit for a
 * moment, then move to jobs — rather than deep-linking straight into a
 * filtered search URL from a cold session.
 */
export async function warmUp(page, cfg) {
  log.info('Warming up on the feed…');
  // Non-fatal. The warm-up exists to look like a person arriving, not to
  // collect anything, so a feed that will not load is a reason to go straight
  // to the search — not to throw away the whole run before it has looked at a
  // single posting. This threw on ERR_ABORTED and killed runs outright.
  try {
    await gotoResilient(page, 'https://www.linkedin.com/feed/', {}, { label: 'the feed' });
    await pause(cfg.pacing.warmupOnFeed);
    await page.mouse.wheel(0, rand(300, 900));
    await pause(cfg.pacing.afterNavigation);
  } catch (err) {
    log.warn(`Warm-up skipped — ${err.message.split('\n')[0]}`);
  }
}

/** Navigate to a search URL and wait for the results column to exist. */
export async function gotoSearch(page, url, cfg) {
  const response = await gotoResilient(page, url, {}, { label: 'the results page' }).catch((err) => {
    log.warn(`Navigation problem: ${err.message.split('\n')[0]}`);
    return null;
  });

  // LinkedIn uses 999 as a non-standard "request denied"; 429 is the standard
  // rate limit. Either means stop, and guard.js will classify it next.
  const status = response?.status();
  if (status === 429 || status === 999) {
    log.error(`LinkedIn returned HTTP ${status} — backing off.`);
    return false;
  }

  await pause(cfg.pacing.afterNavigation);

  // Wait for any of the plausible list containers, or for a "no results" state.
  //
  // The third racer is the one that fires on the redesigned page: none of the
  // named containers exist there any more, and the single /jobs/view/ link it
  // does render belongs to the detail pane rather than the list, so it can
  // resolve before a single card has painted. A recency marker cannot — it is
  // card text, so seeing one means the results are actually on screen.
  const appeared = await Promise.race([
    page.waitForSelector(LIST_CONTAINERS.join(', '), { timeout: 25_000 }).then(() => true).catch(() => false),
    page.waitForSelector('a[href*="/jobs/view/"]', { timeout: 25_000 }).then(() => true).catch(() => false),
    page.waitForFunction(
      () => /Be an early applicant|Actively reviewing applicants|\d+\s+(minute|hour|day|week)s?\s+ago/i.test(document.body?.innerText ?? ''),
      null,
      { timeout: 25_000 },
    ).then(() => true).catch(() => false),
  ]);

  if (!appeared) {
    log.warn('No results container appeared within 25s.');
    return false;
  }

  await sleep(rand(800, 2000));
  return true;
}

/**
 * Find the job cards on the redesigned results page, in the page's own context.
 *
 * Deliberately self-contained — it is handed to `page.evaluate`, which
 * serialises the function and runs it in the browser, so it can reference
 * nothing from module scope. Both the list read and the click that follows go
 * through it, because two definitions of "a card" would drift apart.
 *
 * Anchoring on card TEXT rather than on classes is not a stylistic choice. The
 * August 2026 redesign of `/jobs/search-results/` removed every hook the old
 * code relied on: `data-job-id`, `data-occludable-job-id`,
 * `.jobs-search-results-list` and `.scaffold-layout__list` all return nothing,
 * cards are nested `<div>`s with hashed class names, and the page holds 16
 * `<li>` in total. What every card does still have is a logo, three or more
 * lines of text, and a recency marker.
 *
 * Every card is tagged `data-watcher-card="<index>"` on the way out, which is
 * how a card found here is clicked later. Matching is deliberately NOT done in
 * this function: `innerText` returns only what is currently laid out, so the
 * accessible label ("Intern - AI (Verified job)") is present on one scan and
 * absent on the next, and any comparison of raw lines between two scans fails.
 * The caller parses the rows instead, which folds both shapes to the same
 * company and title, and clicks the index it picks.
 */
function scanCardsInPage() {
  const MARK = /Be an early applicant|Actively reviewing applicants|\d+\s+(minute|hour|day|week)s?\s+ago/i;
  const linesOf = (el) => (el.innerText ?? '').split('\n').map((l) => l.trim()).filter(Boolean);

  // The innermost elements carrying a recency marker; each sits inside exactly
  // one card.
  //
  // This deliberately does NOT require a leaf. On 12 Aug LinkedIn started
  // rendering the stamp as `<time>2 minutes ago<span>Within the past 24
  // hours</span></time>`, so the element holding the marker gained a child and
  // every card in the results column stopped matching. The only leaf left was
  // the detail pane's own "· 2 minutes ago ·", which is exactly why discovery
  // collapsed to one card a page again.
  //
  // Innermost-match subsumes the old leaf rule — a matching leaf has no
  // matching descendant — so both shapes are covered and an A/B rollback needs
  // no further change here.
  const matching = [...document.querySelectorAll('*')].filter((e) => MARK.test(e.textContent ?? ''));
  const marks = matching.filter((e) => !matching.some((o) => o !== e && e.contains(o)));

  const found = new Set();
  for (const m of marks) {
    for (let e = m.parentElement; e; e = e.parentElement) {
      // The smallest ancestor that looks like a whole card: a logo, at least a
      // title/company/location, and not so much text that it is the list itself.
      if (e.querySelector('img') && linesOf(e).length >= 3 && (e.innerText ?? '').length < 420) {
        found.add(e);
        break;
      }
    }
  }
  // Drop any match that merely contains another — keep the innermost.
  let cards = [...found].filter((c) => ![...found].some((o) => o !== c && o.contains(c)));

  // The scrollable ancestor holding the most cards is the results column.
  const counts = new Map();
  for (const c of cards) {
    for (let e = c.parentElement; e && e !== document.body; e = e.parentElement) {
      if (e.scrollHeight > e.clientHeight + 50) {
        counts.set(e, (counts.get(e) ?? 0) + 1);
        break;
      }
    }
  }
  let container = null;
  let best = 0;
  for (const [el, n] of counts) if (n > best) { container = el; best = n; }

  // The detail pane's own header is a logo plus three short lines, so it passes
  // the card test — and its shape is company/title/"place · time · applicants",
  // which parses into nonsense. Restricting to the results column removes it,
  // and nothing else, so it never reaches the watchlist gate.
  if (container) {
    document.querySelectorAll('[data-watcher-list]').forEach((e) => e.removeAttribute('data-watcher-list'));
    container.setAttribute('data-watcher-list', '1');
    cards = cards.filter((c) => container.contains(c));
  }

  document.querySelectorAll('[data-watcher-card]').forEach((e) => e.removeAttribute('data-watcher-card'));

  const rows = cards.map((card, i) => {
    card.setAttribute('data-watcher-card', String(i));
    const logoEl = card.querySelector('img[src*="licdn.com"], img[alt*="logo" i], img');
    const logoUrl = logoEl?.getAttribute('src') || logoEl?.getAttribute('data-delayed-url') || '';
    // Still read, so a rolled-back or A/B-served layout that does carry an id
    // is used directly rather than being given a synthetic key it does not need.
    const href = card.querySelector('a[href*="/jobs/view/"], a[href*="currentJobId="]')?.getAttribute('href') ?? '';
    const idHolder = card.matches?.('[data-occludable-job-id], [data-job-id]')
      ? card
      : card.querySelector('[data-occludable-job-id], [data-job-id]');
    const jobId =
      idHolder?.getAttribute('data-occludable-job-id') ||
      idHolder?.getAttribute('data-job-id') ||
      (href.match(/\/jobs\/view\/(?:[^/?#]*-)?(\d+)/) || [])[1] ||
      (href.match(/currentJobId=(\d+)/) || [])[1] ||
      null;

    return {
      lines: linesOf(card),
      logoUrl: /^https?:\/\//.test(logoUrl) ? logoUrl : '',
      jobId,
      href: href.startsWith('http') ? href : href ? `https://www.linkedin.com${href}` : '',
    };
  });

  return { rows, hasContainer: !!container };
}

/** Strip the decorations LinkedIn adds to a card's accessible label. */
function undecorate(line) {
  return String(line ?? '')
    .replace(/^Selected,\s*/i, '')
    .replace(/\s*\((?:Verified job|Promoted)\)\s*$/i, '')
    .trim();
}

/** Lines that are card furniture rather than facts about the job. */
function isMetaLine(line) {
  const l = String(line ?? '').trim();
  if (!l || l === '·') return true;
  if (/^(viewed|easy apply|promoted|saved?|applied|new|actively reviewing applicants|be an early applicant|responses managed off linkedin|promoted by hirer|no response insights available yet)$/i.test(l)) return true;
  // "Posted 19 hours ago", "19 hours ago", "0 applicants", "Over 100 people clicked apply".
  if (/\b(ago|applicants?)\b/i.test(l) || /people clicked apply/i.test(l)) return true;
  if (/^company review time/i.test(l)) return true;
  return false;
}

/**
 * Turn one card's visible text into fields.
 *
 * A card reads: accessible label / title / company / location, then metadata.
 * The label repeats the title with "Selected, " and "(Verified job)" bolted on,
 * and it is absent on some cards — so the title is taken from the first line
 * with those decorations removed, the repeat is dropped wherever it lands, and
 * company and location are the first two lines left that are not furniture.
 * Reading by fixed line NUMBER looks like it works on the first few cards and
 * then silently files "Be an early applicant" as the location.
 *
 * Exported and pure so it can be tested against captured cards without a
 * browser — this parser is now the only thing standing between the redesign and
 * an empty board, and it is not something to verify by eye.
 */
export function parseCardLines(lines) {
  const clean = (lines ?? []).map((l) => String(l ?? '').trim()).filter(Boolean);
  const empty = { title: '', company: '', location: '', workplaceType: null, postedText: '', salaryText: null, easyApply: false, promoted: false, viewed: false };
  if (!clean.length) return empty;

  const title = undecorate(clean[0]);
  const key = title.toLowerCase();
  const facts = clean.slice(1)
    .filter((l) => undecorate(l).toLowerCase() !== key)
    .filter((l) => !isMetaLine(l));

  const rawLocation = facts[1] ?? '';
  const workplaceType = (rawLocation.match(/\((Remote|Hybrid|On-?site)\)\s*$/i) || [])[1] ?? null;

  const blob = clean.join(' | ');
  return {
    title,
    company: facts[0] ?? '',
    location: rawLocation.replace(/\s*\((?:Remote|Hybrid|On-?site)\)\s*$/i, '').trim(),
    workplaceType,
    postedText: (blob.match(/(just now|\d+\s*(?:minute|min|hour|hr|day|week|month)s?\s*ago)/i) || [])[1] || '',
    salaryText: (blob.match(/([₹$€£¥]\s?[\d,][\d,.\s]*(?:k|K|lakhs?|LPA)?(?:\s*(?:-|–|to)\s*[₹$€£¥]?\s?[\d,][\d,.\s]*(?:k|K|lakhs?|LPA)?)?(?:\s*(?:\/|per\s)\s*\w+)?)/) || [])[1] || null,
    easyApply: /easy apply/i.test(blob),
    promoted: /promoted/i.test(blob),
    // LinkedIn marks cards you have already opened.
    viewed: clean.some((l) => /^viewed$/i.test(l)),
  };
}

/**
 * A stand-in identity for a card that has no job id yet.
 *
 * The redesigned list carries no job id anywhere — every attribute on every
 * element was searched for an 8+ digit value and there were none — and the id
 * only appears once a card has been clicked. But the company gate, the title
 * gate and the staleness gate all run BEFORE the click, on purpose: they are
 * what keeps clicking down to watchlist matches. They need something to key
 * their skip records on, and this is it.
 *
 * `ats:` already marks a job id that did not come from LinkedIn; `card:` marks
 * one that is not a job id at all, so neither can be mistaken for the other or
 * for a real posting id in `seen_cards`.
 *
 * The posted text is part of the key on purpose. Without it a repost — the same
 * role relisted under a fresh id, which LinkedIn does constantly — would key
 * identically to the original and be skipped as already seen.
 */
export function cardKey({ company, title, postedText }) {
  const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  return `card:${norm(company)}|${norm(title)}|${norm(postedText)}`;
}

/**
 * The same card, identified without its posted time.
 *
 * `cardKey` deliberately includes the posted text so two listings of one role
 * never collapse into each other. That is right for a skip record, and wrong
 * for remembering what a card turned out to be: the text ages from "5 minutes
 * ago" to "2 hours ago" between runs, so a key containing it never matches
 * twice and the memory never pays off.
 *
 * This is the stable half, used only as the `card_keys` lookup. Reposts are
 * kept apart by comparing posted times at the point of use, not by the key.
 */
export function cardIdentity({ company, title }) {
  const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  return `card:${norm(company)}|${norm(title)}`;
}

/**
 * Read every job card on the current page without clicking any of them.
 *
 * LinkedIn virtualises the list — only the rows near the viewport are
 * populated — so the container has to be scrolled through before the cards can
 * all be read.
 */
export async function enumerateCards(page, cfg) {
  // Locate and tag the scrollable results column. The named containers are all
  // gone from the redesigned page, so the real work is done by scanCardsInPage,
  // which finds the column by asking which scrollable ancestor holds the cards.
  // They stay first because the standalone and older surfaces still serve them.
  const container = await page.evaluate((candidates) => {
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el && el.scrollHeight > el.clientHeight + 50) return sel;
    }
    return null;
  }, LIST_CONTAINERS);

  // A first pass purely to locate and tag the scrollable column.
  const located = await page.evaluate(scanCardsInPage);
  const listSelector = container ?? (located.hasContainer ? '[data-watcher-list="1"]' : null);

  if (listSelector) {
    await humanScrollContainer(page, listSelector, { steps: 14, stepPause: cfg.pacing.scrollStep });
    // Return to the top so the first card is the one nearest the pointer.
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) el.scrollTo({ top: 0, behavior: 'smooth' });
    }, listSelector).catch(() => {});
    await sleep(rand(600, 1400));
  } else {
    log.debug('No scrollable list container found; reading whatever is rendered.');
  }

  // Read AFTER the scroll, not before. The list is virtualised, so the pass
  // above sees only the rows that happened to be rendered on arrival, and the
  // scroll is what materialises the rest — reading first threw away everything
  // the scrolling was done to reveal.
  const scanned = await page.evaluate(scanCardsInPage);

  // The rows come back as raw text; the parsing happens here in Node so that
  // parseCardLines is an ordinary, testable function rather than a lambda
  // trapped inside page.evaluate.
  const seen = new Set();
  const identityCounts = new Map();
  const unidentified = [];
  const cards = [];

  scanned.rows.forEach((row, index) => {
    const parsed = parseCardLines(row.lines);

    // A card we cannot name is a card we cannot key, gate or record. Count and
    // report it rather than dropping it in silence — an invisible loss here is
    // indistinguishable from a posting that was never advertised, which is
    // exactly how an upGrad listing went missing without leaving a trace.
    if (!parsed.title || !parsed.company) {
      unidentified.push(String(parsed.title || parsed.company || row.lines[0] || '').slice(0, 60));
      return;
    }

    // A real id if the page happened to carry one, a synthetic key otherwise.
    const key = row.jobId ?? cardKey(parsed);

    // LinkedIn re-renders rows while the virtualised list scrolls, so the same
    // job can be captured twice in one pass.
    if (seen.has(key)) return;
    seen.add(key);

    // How to find this card again at click time: its company and title, plus
    // which occurrence it is when one company posts the same title twice.
    const identity = cardIdentity(parsed);
    const nth = identityCounts.get(identity) ?? 0;
    identityCounts.set(identity, nth + 1);

    cards.push({
      ...parsed,
      key,
      identity,
      jobId: row.jobId,
      index,
      nth,
      logoUrl: row.logoUrl,
      href: row.href,
    });
  });

  return { cards, unidentified };
}

/**
 * Is there another page of results?
 *
 * Returns true when LinkedIn's "Next" control is present and enabled, false
 * when it is absent or disabled (the last page), and null when no pagination
 * bar could be found at all — in which case the caller falls back to judging by
 * how many cards the page returned.
 *
 * The bar only renders once the results column is scrolled to the bottom, so
 * this scrolls there first.
 */
export async function hasNextPage(page) {
  await page.evaluate(() => {
    const list = document.querySelector('[data-watcher-list="1"], .jobs-search-results-list, .scaffold-layout__list');
    if (list) list.scrollTop = list.scrollHeight;
    window.scrollTo(0, document.body.scrollHeight);
  }).catch(() => {});
  await sleep(rand(900, 1800));

  return page.evaluate(() => {
    const isNext = (b) =>
      /view next page/i.test(b.getAttribute('aria-label') ?? '') ||
      (b.innerText ?? '').trim().toLowerCase() === 'next';

    const button =
      document.querySelector('.jobs-search-pagination__button--next, button[aria-label="View next page"]') ||
      [...document.querySelectorAll('button')].find(isNext);

    if (button) {
      return !button.disabled && button.getAttribute('aria-disabled') !== 'true';
    }
    // A pagination bar with no Next control means we are on the final page.
    if (document.querySelector('.jobs-search-pagination, .artdeco-pagination')) return false;
    return null;
  }).catch(() => null);
}

/** Expand a truncated description if a "see more" control is present. */
async function expandDescription(page) {
  const selectors = [
    'button[aria-label*="see more" i]',
    'button[aria-label*="Click to see more" i]',
    '.jobs-description__footer-button',
    'button.show-more-less-html__button--more',
  ];
  for (const sel of selectors) {
    const btn = page.locator(sel).first();
    if (await btn.count().catch(() => 0)) {
      if (await btn.isVisible().catch(() => false)) {
        await humanClick(page, btn, { timeout: 4000 });
        await sleep(rand(500, 1200));
        return true;
      }
    }
  }
  return false;
}

/**
 * Click a card and read the detail pane.
 *
 * Clicking the card (rather than navigating to the job URL) is both closer to
 * what a person does and cheaper — it updates the right-hand pane in place
 * instead of loading a whole new page.
 *
 * This is also where a card stops being anonymous. The redesigned list holds no
 * job id at all, so a card arrives here identified only by `card.key`, the
 * synthetic company|title|posted string built in enumerateCards. The click is
 * what makes LinkedIn reveal the real id — in `location.href` and in the
 * description block's own `JobDetails_AboutTheJob_<id>` — and the caller swaps
 * one for the other on the strength of the `jobId` returned here.
 *
 * The id is read from the description block first and the URL second. Both
 * carry it, but the URL can still show the previous job for a moment after the
 * pane has already repainted, and a posting stored under its predecessor's id
 * is worse than one not stored at all.
 */
export async function openAndExtract(page, card, cfg) {
  const before = page.url();

  // Whatever the pane was showing before the click, so the wait below can tell
  // "the new job has rendered" from "the old one is still on screen".
  const previousAboutId = await page
    .evaluate(() => document.querySelector('[id^="JobDetails_AboutTheJob_"]')?.id ?? null)
    .catch(() => null);

  let clicked = false;

  if (card.jobId) {
    // A real id: either a surface that still publishes one, or a description
    // backfill working from a stored row. Both can be addressed directly.
    const locator = page
      .locator(`li[data-occludable-job-id="${card.jobId}"], li[data-job-id="${card.jobId}"], [data-job-id="${card.jobId}"]`)
      .first();
    if (await locator.count().catch(() => 0)) {
      const link = locator.locator('a[href*="/jobs/view/"]').first();
      const target = (await link.count().catch(() => 0)) ? link : locator;
      clicked = await humanClick(page, target);
    }
  } else if (card.identity) {
    // Re-find the card by its parsed identity rather than trusting a handle
    // taken earlier. Without an id there is no URL that reaches this posting,
    // so if the element cannot be found the card cannot be opened at all.
    //
    // The scan and the match are split across the process boundary on purpose:
    // parsing in Node means the same parseCardLines folds "Intern - AI
    // (Verified job)" and "Intern - AI" to one title, which raw line matching
    // could not — innerText renders that label only sometimes, and comparing
    // lines between two scans failed for 17 of 23 cards.
    const look = async () => {
      const { rows } = await page.evaluate(scanCardsInPage).catch(() => ({ rows: [] }));
      let seen = 0;
      for (let i = 0; i < rows.length; i++) {
        if (cardIdentity(parseCardLines(rows[i].lines)) !== card.identity) continue;
        if (seen++ === (card.nth ?? 0)) return i;
      }
      return -1;
    };

    let tagged = await look();

    // The list is virtualised: it only keeps the rows near the scroll position
    // in the DOM. enumerateCards materialises all of them by scrolling through,
    // but opening a card re-renders the list, and every row below the fold is
    // recycled — which silently lost four of five watchlist matches on a page,
    // each reported only as "could not be found to click". So walk the list
    // down the way somebody scrolling to a posting would, checking as we go.
    if (tagged < 0) {
      await page.evaluate(() => document.querySelector('[data-watcher-list="1"]')?.scrollTo({ top: 0 })).catch(() => {});
      await sleep(rand(300, 700));
      for (let step = 0; step < 24 && tagged < 0; step++) {
        const moved = await page.evaluate(() => {
          const el = document.querySelector('[data-watcher-list="1"]');
          if (!el) return false;
          const before = el.scrollTop;
          el.scrollBy(0, Math.max(280, el.clientHeight * 0.7));
          return el.scrollTop !== before;
        }).catch(() => false);
        await sleep(rand(300, 700));
        tagged = await look();
        if (!moved) break;
      }
    }

    if (tagged >= 0) {
      clicked = await humanClick(page, page.locator(`[data-watcher-card="${tagged}"]`).first());
    }
  }

  if (!clicked) {
    if (!card.jobId) {
      // Nothing else to try. Without an id there is no URL that reaches this
      // posting, so it cannot be opened by any other route this run. Say so and
      // let the caller count it — the card will be on the list again next run.
      log.warn(`Card "${card.title}" (${card.company}) could not be found to click; it will be picked up next run.`);
      return { jobId: null, description: '', unopenable: true };
    }
    log.debug(`Card ${card.jobId} was not clickable; navigating directly.`);
    // The pane URL, not the standalone view — see jobPaneUrl. This path is
    // taken both when a card scrolls out from under us mid-scan and for every
    // description backfill, so getting it wrong costs a silent empty read
    // rather than a visible error.
    await gotoResilient(page, jobPaneUrl(card.jobId), {}, { label: `job ${card.jobId}` });
  }

  // Wait for the pane to actually change, and take no answer for an answer.
  //
  // This used to race the wait against a flat six-second sleep, so a pane that
  // had not finished loading was read anyway — and on the redesign that means
  // reading the PREVIOUS posting, whose description block is still on screen
  // under its own id. It attributed a HARMAN internship to Valeo's job id:
  // clicking is now the only way to learn which posting a card is, so a stale
  // read does not produce a missing field, it produces a confident wrong
  // answer. Better to skip the card and pick it up next run.
  const paneChanged = await page.waitForFunction(
    ({ id, prevAbout }) => {
      const about = document.querySelector('[id^="JobDetails_AboutTheJob_"]');
      if (about) return about.id !== prevAbout;
      if (id) return location.href.includes(id);
      return !!document.querySelector('#job-details, .jobs-description__content');
    },
    { id: card.jobId ?? null, prevAbout: previousAboutId },
    { timeout: 15_000 },
  ).then(() => true).catch(() => false);

  // A pane that has not repainted within the timeout is not proof of a wrong
  // read — five of eighteen opens on a catch-up sweep were simply slow, and
  // discarding them threw away real postings. What actually matters is checked
  // after extraction: that the pane is showing the employer we clicked.
  if (!paneChanged) await sleep(rand(1500, 2500));

  await sleep(rand(700, 1600));

  await expandDescription(page);

  const detail = await page.evaluate((descSelectors) => {
    const text = (el) => (el?.textContent ?? '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    // innerText respects rendered line breaks; textContent runs every bullet
    // together into one unreadable string, which then wrecks the summary.
    const blockText = (el) => (el?.innerText ?? el?.textContent ?? '')
      .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

    const about = document.querySelector('[id^="JobDetails_AboutTheJob_"]');
    // The description block is named after the posting it belongs to, which
    // makes it the most trustworthy id on the page — it cannot lag the render
    // the way the URL can.
    const jobId = (about?.id.match(/_(\d+)$/) || [])[1]
      || (location.href.match(/currentJobId=(\d+)/) || [])[1]
      || null;

    // The detail pane is whichever container is not the results list. On the
    // redesign nothing is named, so it is found by walking out from the
    // description until an ancestor also carries the header above it.
    //
    // "Has some text above the description" is NOT enough to stop on. LinkedIn
    // wraps the description in a match-insights block first ("Your profile and
    // resume are missing some required qualifications"), which satisfies that
    // test and yields a header with no company, title, location or Apply button
    // in it. The header proper is identified by the line it always carries:
    // location · posted · applicants. Stopping at the first ancestor holding
    // that line lands on the pane column and not on the whole page.
    let pane = null;
    if (about) {
      for (let e = about.parentElement; e && e !== document.body; e = e.parentElement) {
        const t = e.innerText ?? '';
        const cut = t.indexOf('About the job');
        if (cut <= 0) continue;
        const head = t.slice(0, cut);
        if (head.split('\n').some((l) => l.includes('·') && /\bago\b|applicants?|clicked apply/i.test(l))) {
          pane = e;
          break;
        }
      }
    }
    pane = pane
      || document.querySelector('.jobs-search__job-details, .jobs-details, .job-view-layout, .scaffold-layout__detail')
      || document.body;

    let description = '';
    for (const sel of descSelectors) {
      const el = pane.querySelector(sel) ?? document.querySelector(sel);
      const t = blockText(el);
      if (t.length > description.length) description = t;
      if (description.length > 400) break;
    }
    // The block leads with its own heading, which is not part of the posting.
    description = description.replace(/^About the job\s*/i, '').trim();

    // Everything above the description is the header. The old layout had a
    // named top-card and an <h1>; the redesign has neither — the page carries
    // no <h1> at all — so the header is read as the text preceding the
    // description, line by line.
    const paneText = pane.innerText ?? '';
    const cut = paneText.indexOf('About the job');
    const headerLines = (cut > 0 ? paneText.slice(0, cut) : '')
      .split('\n').map((l) => l.trim()).filter(Boolean);
    const headerText = headerLines.join(' ').replace(/\s+/g, ' ').trim();

    // "Bengaluru, Karnataka, India · 19 hours ago · Over 100 people clicked apply"
    const factsLine = headerLines.find((l) => l.includes('·')) ?? '';
    const factParts = factsLine.split('·').map((s) => s.trim()).filter(Boolean);
    const factsTail = factParts.slice(1).join(' ');

    // Everything in the header that is furniture rather than a fact about the
    // posting. The list is long because the redesign packs the header with
    // controls and insight copy, and any one of them reads as a plausible
    // company name if it is the first line left standing.
    const isChrome = (l) =>
      l.includes('·') ||
      /^(apply|save|saved|easy apply|show match details|show more|show less|see more|learn more|follow|following|more|beta|is this information helpful|your profile and resume|responses managed off linkedin|no response insights|promoted by hirer|about the job)/i.test(l) ||
      /^(remote|hybrid|on-?site|full-time|part-time|contract|internship|temporary|entry level|internship level)$/i.test(l) ||
      /^\d[\d,]*\s+(followers?|employees?|connections?)/i.test(l);

    // The header reads company, then title, then the facts line. There is no
    // <h1> on this page at all, and the named top-card classes are gone, so
    // position within the header is what identifies them — but position AFTER
    // the furniture has been removed, never a raw line number.
    const headerFacts = headerLines.filter((l) => !isChrome(l) && l.length < 200);

    let company = text(pane.querySelector('.jobs-unified-top-card__company-name, .job-details-jobs-unified-top-card__company-name'))
      || headerFacts[0] || '';
    if (!company) {
      for (const a of pane.querySelectorAll('a[href*="/company/"]')) {
        const name = text(a);
        // "IQVIA 2,678,778 followers" is the same link with the count appended,
        // and "Show more" is a link to the company page too.
        if (name && name.length < 80 && !/followers?$/i.test(name) && !isChrome(name)) { company = name; break; }
      }
    }

    let title = text(pane.querySelector('h1, .jobs-unified-top-card__job-title, [class*="top-card"] h1'));
    if (!title) {
      const after = headerFacts.indexOf(company);
      title = (after >= 0 ? headerFacts.slice(after + 1) : headerFacts.slice(1))[0] ?? '';
    }

    const applicants =
      (factsTail.match(/(\d[\d,]*\s+applicants?|Over \d+\s+(?:applicants?|people clicked apply)|Be among the first \d+ applicants?|\d[\d,]*\s+people clicked apply)/i) || [])[1]
      || (headerText.match(/(\d[\d,]*\s+applicants?|Over \d+ applicants?|Be among the first \d+ applicants?)/i) || [])[1]
      || null;

    const postedText =
      (factsTail.match(/(just now|\d+\s*(?:minute|min|hour|hr|day|week|month)s?\s*ago)/i) || [])[1]
      || (headerText.match(/(just now|\d+\s*(?:minute|min|hour|hr|day|week|month)s?\s*ago)/i) || [])[1]
      || '';

    // Salary can appear as a badge in the header or as an insight chip.
    const salaryText =
      (headerText.match(/([₹$€£¥]\s?[\d,][\d,.\s]*(?:k|K)?(?:\s*(?:-|–|to)\s*[₹$€£¥]?\s?[\d,][\d,.\s]*(?:k|K)?)?(?:\s*(?:\/|per\s)\s*\w+)?)/) || [])[1] || null;

    const workplaceType = (headerText.match(/\b(Remote|Hybrid|On-site|Onsite)\b/i) || [])[1] || null;
    // NOT named `location`. A `const location` here is scoped to the whole
    // page.evaluate callback, which puts the page's own `location` in the
    // temporal dead zone for every line above — including the `location.href`
    // fallback that reads currentJobId when the description block is missing.
    // That fallback could therefore never run: it threw "Cannot access
    // 'location' before initialization" and lost the posting entirely.
    const locationText = factParts[0]
      || text(pane.querySelector('.jobs-unified-top-card__bullet, .job-details-jobs-unified-top-card__primary-description-container')).split('·')[0]?.trim()
      || '';

    // --- apply target ---
    // Matched on the control's OWN label, anchored at the start. A loose
    // /apply/i also matches a recruiter's "apply now" post further down the
    // pane, and following that would publish a link to somebody's feed update.
    const controls = [...pane.querySelectorAll('button, a')];
    const applyButton =
      controls.find((b) => /^(easy )?apply\b/i.test((b.innerText ?? '').trim()))
      || controls.find((b) => /^apply on/i.test(b.getAttribute('aria-label') ?? ''))
      || pane.querySelector('.jobs-apply-button');

    const applyLabel = (applyButton?.innerText ?? '').replace(/\s+/g, ' ').trim();
    const easyApply = /easy apply/i.test(applyLabel) || !!pane.querySelector('.jobs-apply-button--top-card [class*="linkedin-bug"]');

    // For off-site applications LinkedIn sometimes exposes the destination as
    // an anchor href. When it does not, we leave this null and the report links
    // to the LinkedIn posting instead — clicking Apply there is what a person
    // would do anyway, and guessing a URL would be worse than not having one.
    let applyUrl = null;
    if (applyButton?.tagName === 'A') {
      const href = applyButton.getAttribute('href') ?? '';
      if (href && !href.startsWith('#')) {
        applyUrl = href.startsWith('http') ? href : `https://www.linkedin.com${href}`;
        // The redesign wraps every off-site apply in an interstitial:
        // /safety/go/?url=<encoded>. Storing the wrapper would publish a
        // LinkedIn redirect where the employer's own application page belongs.
        const wrapped = applyUrl.match(/\/safety\/go\/?\?(?:.*&)?url=([^&]+)/);
        if (wrapped) {
          try { applyUrl = decodeURIComponent(wrapped[1]); } catch { /* keep the wrapper */ }
        }
      }
    }

    const detailLogo = pane.querySelector('img[src*="licdn.com"]')?.getAttribute('src') ?? '';

    return { jobId, title, company, location: locationText, workplaceType, applicants, postedText, salaryText, description, easyApply, applyUrl, applyLabel,
             logoUrl: /^https?:\/\//.test(detailLogo) ? detailLogo : '' };
  }, DESCRIPTION_SELECTORS);

  // Is the pane actually showing the card we clicked?
  //
  // This is the check that matters, and it replaces "did the id change in
  // fifteen seconds" — which rejected slow-but-correct loads while proving
  // nothing about correctness. Clicking is now the only way to learn which
  // posting a card is, so reading the wrong pane does not produce a missing
  // field, it files one employer's internship under another's id. Comparing the
  // employer catches that directly: the normalised names must agree, allowing
  // for the pane saying "HARMAN" where the card said "HARMAN India".
  if (!card.jobId && detail.company && card.company) {
    const paneCo = normaliseCompany(detail.company);
    const cardCo = normaliseCompany(card.company);
    const agrees = paneCo && cardCo && (paneCo.includes(cardCo) || cardCo.includes(paneCo));
    if (!agrees) {
      log.warn(`Opened "${card.title}" at ${card.company} but the pane is showing ${detail.company} — skipping rather than filing it under the wrong employer.`);
      return { jobId: null, description: '', unopenable: true };
    }
  }

  const label = detail.jobId ?? card.jobId ?? card.key ?? 'unknown';
  if (!detail.description || detail.description.length < 60) {
    log.warn(`Description for ${label} came back very short (${detail.description?.length ?? 0} chars) — LinkedIn's markup may have shifted.`);
  }
  if (!detail.jobId && !card.jobId) {
    log.warn(`Opened "${card.title}" but LinkedIn never revealed a job id — it cannot be stored.`);
  }

  // Restore the URL context if we navigated away from the search results.
  if (!clicked && page.url() !== before) {
    await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await pause(cfg.pacing.afterNavigation);
  }

  // A real id from the page wins; the caller's own is the fallback so the
  // description-backfill path keeps working against the row it started from.
  return { ...detail, jobId: detail.jobId ?? card.jobId ?? null };
}
