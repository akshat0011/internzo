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

export const RESULTS_PER_PAGE = 25;

/** Candidate selectors for the scrollable results column, best first. */
const LIST_CONTAINERS = [
  '.jobs-search-results-list',
  '.scaffold-layout__list > div',
  '.scaffold-layout__list',
  'div[data-results-list-top-scroll-sentinel] + div',
  '.jobs-search__results-list',
];

/** Candidate selectors for the detail pane's description body. */
const DESCRIPTION_SELECTORS = [
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
  const appeared = await Promise.race([
    page.waitForSelector(LIST_CONTAINERS.join(', '), { timeout: 25_000 }).then(() => true).catch(() => false),
    page.waitForSelector('a[href*="/jobs/view/"]', { timeout: 25_000 }).then(() => true).catch(() => false),
  ]);

  if (!appeared) {
    log.warn('No results container appeared within 25s.');
    return false;
  }

  await sleep(rand(800, 2000));
  return true;
}

/**
 * Read every job card on the current page without clicking any of them.
 *
 * LinkedIn virtualises the list — only the rows near the viewport are
 * populated — so the container has to be scrolled through before the cards can
 * all be read.
 */
export async function enumerateCards(page, cfg) {
  const container = await page.evaluate((candidates) => {
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el && el.scrollHeight > el.clientHeight + 50) return sel;
    }
    // Fall back to whichever scrollable ancestor holds the most job links.
    const links = [...document.querySelectorAll('a[href*="/jobs/view/"]')];
    const counts = new Map();
    for (const a of links) {
      let node = a.parentElement;
      while (node && node !== document.body) {
        const style = getComputedStyle(node);
        if (/auto|scroll/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 50) {
          counts.set(node, (counts.get(node) ?? 0) + 1);
          break;
        }
        node = node.parentElement;
      }
    }
    let best = null; let bestCount = 0;
    for (const [node, n] of counts) if (n > bestCount) { best = node; bestCount = n; }
    if (!best) return null;
    // Tag it so the caller has something addressable to scroll.
    best.setAttribute('data-watcher-list', '1');
    return '[data-watcher-list="1"]';
  }, LIST_CONTAINERS);

  if (container) {
    await humanScrollContainer(page, container, { steps: 14, stepPause: cfg.pacing.scrollStep });
    // Return to the top so the first card is the one nearest the pointer.
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) el.scrollTo({ top: 0, behavior: 'smooth' });
    }, container).catch(() => {});
    await sleep(rand(600, 1400));
  } else {
    log.debug('No scrollable list container found; reading whatever is rendered.');
  }

  return page.evaluate(() => {
    const seenIds = new Set();
    const text = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

    /** Distinct visible text lines inside a card, de-duplicated in order. */
    const linesOf = (el) => {
      const raw = (el.innerText ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
      const seen = new Set();
      return raw.filter((l) => {
        const k = l.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    };

    // --- locate the cards -------------------------------------------------
    // Match the <li> wrappers first. A bare [data-job-id] also matches an
    // element nested *inside* each li, which yields every job twice.
    let cards = [...document.querySelectorAll('li[data-occludable-job-id], li[data-job-id]')];
    if (cards.length === 0) cards = [...document.querySelectorAll('[data-job-id]')];
    if (cards.length === 0) {
      // Every card contains exactly one /jobs/view/ link; walk up to the <li>.
      const seen = new Set();
      cards = [...document.querySelectorAll('a[href*="/jobs/view/"]')]
        .map((a) => a.closest('li') ?? a.closest('[class*="job-card"]') ?? a.parentElement)
        .filter((el) => el && !seen.has(el) && seen.add(el));
    }

    const unidentified = [];
    const rows = cards.map((card, index) => {
      const link = card.querySelector('a[href*="/jobs/view/"]');
      const href = link?.getAttribute('href') ?? '';

      // A card with no id is dropped further down, and until recently it was
      // dropped in complete silence — no counter, no log, no seen_cards row. It
      // is the only path that can lose a posting leaving no trace anywhere,
      // which is exactly what happened to an upGrad "Intern- AI Engineer" that
      // passed every filter we have. So look everywhere the id can hide:
      //
      //  - on a DESCENDANT rather than the <li> itself. Only the wrapper was
      //    read before, so a layout that puts data-job-id one level in yielded
      //    nothing at all.
      //  - in data-entity-urn, as urn:li:jobPosting:1234567890.
      //  - in any currentJobId link on the card, not only the /jobs/view/ one.
      //    A promoted card often links to the search URL with the job selected
      //    rather than to the canonical job page.
      const idHolder = card.matches?.('[data-occludable-job-id], [data-job-id]')
        ? card
        : card.querySelector('[data-occludable-job-id], [data-job-id]');
      const urn = card.getAttribute('data-entity-urn')
        || card.querySelector('[data-entity-urn]')?.getAttribute('data-entity-urn')
        || '';
      const anyHref = href
        || card.querySelector('a[href*="currentJobId="]')?.getAttribute('href')
        || '';

      const jobId =
        idHolder?.getAttribute('data-occludable-job-id') ||
        idHolder?.getAttribute('data-job-id') ||
        (urn.match(/jobPosting:(\d+)/) || [])[1] ||
        (anyHref.match(/\/jobs\/view\/(?:[^/?#]*-)?(\d+)/) || [])[1] ||
        (anyHref.match(/currentJobId=(\d+)/) || [])[1] ||
        null;

      // --- title ---
      // The card's link carries the title in aria-label or a nested strong.
      let title =
        text(link?.querySelector('strong')) ||
        text(card.querySelector('.job-card-list__title, .job-card-container__link, [class*="job-card"] strong')) ||
        (link?.getAttribute('aria-label') ?? '').replace(/^Job:\s*/i, '').replace(/,\s*(Verified|Promoted).*$/i, '') ||
        text(link);

      // --- company / location ---
      let company =
        text(card.querySelector('.artdeco-entity-lockup__subtitle, .job-card-container__primary-description, [class*="subtitle"]'));
      let location =
        text(card.querySelector('.artdeco-entity-lockup__caption, .job-card-container__metadata-item, [class*="caption"]'));

      const lines = linesOf(card);

      // Text-heuristic fallback: cards read title / company / location, with
      // metadata lines after. Used whenever the class-based lookup came up dry.
      if (!company || !location) {
        const titleIdx = lines.findIndex((l) => title && l.includes(title.slice(0, 24)));
        const rest = lines.slice(titleIdx >= 0 ? titleIdx + 1 : 1);
        const isMeta = (l) => /ago|applicant|easy apply|promoted|viewed|response|actively|be an early|hiring|\bsaved\b/i.test(l);
        const candidates = rest.filter((l) => !isMeta(l) && l.length > 1 && l.length < 90);
        if (!company && candidates[0]) company = candidates[0];
        // A location line usually carries a comma or a remote/hybrid marker.
        if (!location) {
          location = candidates.slice(1).find((l) => /,|remote|hybrid|on-?site|india|united states/i.test(l)) ?? candidates[1] ?? '';
        }
      }
      if (!title && lines[0]) title = lines[0];

      const blob = lines.join(' | ');

      // --- metadata ---
      // The <time> element carries trailing filter text ("16 minutes ago
      // Within the past 24 hours"), so pull out just the relative phrase.
      // The card carries the company logo as an <img>. Grabbing the URL here
      // costs nothing — the page is already loaded.
      const logoEl = card.querySelector('img[src*="licdn.com"], img[alt*="logo" i], img');
      const logoUrl = logoEl?.getAttribute('src') || logoEl?.getAttribute('data-delayed-url') || '';

      const timeEl = card.querySelector('time');
      const rawPosted = `${text(timeEl)} ${blob}`;
      const postedText =
        (rawPosted.match(/(just now|\d+\s*(?:minute|min|hour|hr|day|week|month)s?\s*ago)/i) || [])[1] ||
        timeEl?.getAttribute('datetime') ||
        '';

      const salaryText = (blob.match(/([₹$€£¥]\s?[\d,][\d,.\s]*(?:k|K|lakhs?|LPA)?(?:\s*(?:-|–|to)\s*[₹$€£¥]?\s?[\d,][\d,.\s]*(?:k|K|lakhs?|LPA)?)?(?:\s*(?:\/|per\s)\s*\w+)?)/) || [])[1] || null;

      return {
        jobId,
        index,
        title: title || '',
        company: company || '',
        location: location || '',
        postedText,
        salaryText,
        easyApply: /easy apply/i.test(blob),
        promoted: /promoted/i.test(blob),
        // LinkedIn marks cards you have already opened.
        viewed: /\bviewed\b/i.test(blob),
        logoUrl: /^https?:\/\//.test(logoUrl) ? logoUrl : '',
        href: href.startsWith('http') ? href : href ? `https://www.linkedin.com${href}` : '',
      };
    }).filter((c) => {
      // Belt-and-braces de-duplication: LinkedIn re-renders rows while the
      // virtualised list scrolls, so the same job can be captured twice.
      if (seenIds.has(c.jobId)) return false;
      if (!c.jobId) {
        // Kept, flagged, and counted rather than dropped. Discarding these in
        // silence is what made a lost posting indistinguishable from one that
        // was never advertised — there was no row, no counter and no log line
        // to look at. The scan still cannot process a card with no id, but at
        // least the run now says so out loud.
        unidentified.push(String(c.title ?? '').slice(0, 60));
        return false;
      }
      seenIds.add(c.jobId);
      return true;
    });

    return { cards: rows, unidentified };
  });
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
 */
export async function openAndExtract(page, card, cfg) {
  const before = page.url();

  // Prefer clicking the card itself; fall back to navigating if it has gone.
  const locator = page
    .locator(`li[data-occludable-job-id="${card.jobId}"], li[data-job-id="${card.jobId}"], [data-job-id="${card.jobId}"]`)
    .first();

  let clicked = false;
  if (await locator.count().catch(() => 0)) {
    const link = locator.locator('a[href*="/jobs/view/"]').first();
    const target = (await link.count().catch(() => 0)) ? link : locator;
    clicked = await humanClick(page, target);
  }

  if (!clicked) {
    log.debug(`Card ${card.jobId} was not clickable; navigating directly.`);
    // The pane URL, not the standalone view — see jobPaneUrl. This path is
    // taken both when a card scrolls out from under us mid-scan and for every
    // description backfill, so getting it wrong costs a silent empty read
    // rather than a visible error.
    await gotoResilient(page, jobPaneUrl(card.jobId), {}, { label: `job ${card.jobId}` });
  }

  // Wait for the pane to actually change rather than a fixed sleep.
  await Promise.race([
    page.waitForFunction(
      (id) => location.href.includes(id) || document.querySelector('#job-details, .jobs-description__content'),
      card.jobId,
      { timeout: 15_000 },
    ).catch(() => {}),
    sleep(6000),
  ]);
  await sleep(rand(700, 1600));

  await expandDescription(page);

  const detail = await page.evaluate((descSelectors) => {
    const text = (el) => (el?.textContent ?? '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    // innerText respects rendered line breaks; textContent runs every bullet
    // together into one unreadable string, which then wrecks the summary.
    const blockText = (el) => (el?.innerText ?? el?.textContent ?? '')
      .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

    // The detail pane is whichever container is not the results list.
    const pane =
      document.querySelector('.jobs-search__job-details, .jobs-details, .job-view-layout, .scaffold-layout__detail') ||
      document.body;

    let description = '';
    for (const sel of descSelectors) {
      const el = pane.querySelector(sel) ?? document.querySelector(sel);
      const t = blockText(el);
      if (t.length > description.length) description = t;
      if (description.length > 400) break;
    }

    const header = pane.querySelector('.jobs-unified-top-card, .job-details-jobs-unified-top-card, [class*="top-card"]') ?? pane;
    const headerText = (header.innerText ?? '').replace(/\s+/g, ' ').trim();

    const title =
      text(pane.querySelector('h1, .jobs-unified-top-card__job-title, [class*="top-card"] h1')) || '';
    // Class names here rotate often, so fall back to the first company link
    // that actually carries a name rather than a logo image.
    let company = text(pane.querySelector('.jobs-unified-top-card__company-name, .job-details-jobs-unified-top-card__company-name'));
    if (!company) {
      for (const a of pane.querySelectorAll('a[href*="/company/"]')) {
        const name = text(a);
        if (name && name.length < 80) { company = name; break; }
      }
    }

    // Applicant count and posted time live in the header's metadata strip.
    const applicants = (headerText.match(/(\d[\d,]*\s+applicants?|Over \d+ applicants?|Be among the first \d+ applicants?)/i) || [])[1] || null;
    const postedText = (headerText.match(/((?:just now|\d+\s*(?:minute|min|hour|hr|day|week|month)s?\s*ago))/i) || [])[1] || '';

    // Salary can appear as a badge in the header or as an insight chip.
    const salaryText =
      (headerText.match(/([₹$€£¥]\s?[\d,][\d,.\s]*(?:k|K)?(?:\s*(?:-|–|to)\s*[₹$€£¥]?\s?[\d,][\d,.\s]*(?:k|K)?)?(?:\s*(?:\/|per\s)\s*\w+)?)/) || [])[1] || null;

    const workplaceType = (headerText.match(/\b(Remote|Hybrid|On-site|Onsite)\b/i) || [])[1] || null;
    const location = (() => {
      const el = pane.querySelector('.jobs-unified-top-card__bullet, .job-details-jobs-unified-top-card__primary-description-container');
      return text(el).split('·')[0]?.trim() || '';
    })();

    // --- apply target ---
    const applyButton =
      pane.querySelector('.jobs-apply-button, button[class*="apply"], a[class*="apply"]') ||
      [...pane.querySelectorAll('button, a')].find((b) => /^(easy )?apply\b/i.test((b.innerText ?? '').trim()));

    const applyLabel = (applyButton?.innerText ?? '').replace(/\s+/g, ' ').trim();
    const easyApply = /easy apply/i.test(applyLabel) || !!pane.querySelector('.jobs-apply-button--top-card [class*="linkedin-bug"]');

    // For off-site applications LinkedIn sometimes exposes the destination as
    // an anchor href. When it does not, we leave this null and the report links
    // to the LinkedIn posting instead — clicking Apply there is what a person
    // would do anyway, and guessing a URL would be worse than not having one.
    let applyUrl = null;
    if (applyButton?.tagName === 'A') {
      const href = applyButton.getAttribute('href') ?? '';
      if (href && !href.startsWith('#')) applyUrl = href.startsWith('http') ? href : `https://www.linkedin.com${href}`;
    }

    const detailLogo = pane.querySelector('img[src*="licdn.com"]')?.getAttribute('src') ?? '';

    return { title, company, location, workplaceType, applicants, postedText, salaryText, description, easyApply, applyUrl, applyLabel,
             logoUrl: /^https?:\/\//.test(detailLogo) ? detailLogo : '' };
  }, DESCRIPTION_SELECTORS);

  if (!detail.description || detail.description.length < 60) {
    log.warn(`Description for ${card.jobId} came back very short (${detail.description?.length ?? 0} chars) — LinkedIn's markup may have shifted.`);
  }

  // Restore the URL context if we navigated away from the search results.
  if (!clicked && page.url() !== before) {
    await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await pause(cfg.pacing.afterNavigation);
  }

  return detail;
}
