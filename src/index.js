#!/usr/bin/env node
/**
 * One scan of LinkedIn for new internships at the watchlist companies.
 * Invoked by launchd every 30 minutes, or by hand via `npm run`.
 */
import { loadConfig, matchCompany, matchTitle, resolveWindowHours, isBlockedCompany } from './config.js';
import { join } from 'node:path';
import { ensureDirs, PATHS, ROOT } from './paths.js';
import { log } from './logger.js';
import { Store } from './store.js';
import { launchBrave, closeBrave, releaseProfileLock } from './browser.js';
import { ensureHealthy, assertSignedIn, assertListRendered, RunAborted, State } from './guard.js';
import * as li from './linkedin.js';
import { resolveSearches } from './searches.js';
import { classifyRoles, classifyFromDescriptions, enrichJobs } from './ollama.js';
import { postNewJobs } from './telegram.js';
import { classifyRole, needsDescription, builtInPolarity } from './roles.js';
import { loadLearned, learnedVocabulary, learn, learnedPath } from './learned.js';
import { pause, sleep, idleFidget, humanDelay, pageAlive } from './human.js';
import { summarize } from './summarize.js';
import { extractStipend, extractDuration, extractSkills, extractWorkplaceType, parseRelativeTime } from './extract.js';
import { buildReport, writeReport } from './report.js';
import { publish } from './publish.js';
import { notify, open as openFile, pushToPhone } from './notify.js';

const ARGS = new Set(process.argv.slice(2));
const DRY_RUN = ARGS.has('--dry-run');
const NO_OPEN = ARGS.has('--no-open');
/** Set by bin/run.sh so scheduled runs can behave slightly differently. */
const SCHEDULED = ARGS.has('--scheduled');

/**
 * One-off numeric overrides, so a deep backfill does not require editing
 * config.json — which is the kind of change that gets left in by accident and
 * quietly triples every future run.
 *
 *   --window-days=30   look back 30 days instead of the adaptive window
 *   --window-hours=72  same, in hours
 *   --max-pages=40     pages per search
 *   --max-details=200  jobs opened this run
 *   --max-minutes=100  wall-clock budget
 *   --sort=relevance   order by LinkedIn's relevance instead of newest-first
 *   --start-page=15    begin pagination at page 15 (start=350), to resume a
 *                      backfill that stopped partway rather than re-walking
 *                      the pages already covered
 */
function numArg(name) {
  for (const a of ARGS) {
    const m = a.match(new RegExp(`^--${name}=(\\d+(?:\\.\\d+)?)$`));
    if (m) return Number(m[1]);
  }
  return null;
}

/** Non-numeric one-off overrides. */
function strArg(name) {
  for (const a of ARGS) {
    const m = a.match(new RegExp(`^--${name}=(.+)$`));
    if (m) return m[1];
  }
  return null;
}

const OVERRIDES = {
  sortBy: strArg('sort'),
  startPage: numArg('start-page'),
  windowHours: numArg('window-hours') ?? (numArg('window-days') != null ? numArg('window-days') * 24 : null),
  maxPages: numArg('max-pages'),
  maxDetails: numArg('max-details'),
  maxMinutes: numArg('max-minutes'),
};

function makeRunId() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/**
 * How much newer a card must look before it is treated as a relisting rather
 * than the posting we already hold under the same company and title.
 *
 * Generous on purpose. `parseRelativeTime` works from text like "19 hours ago",
 * so the same posting drifts by up to an hour between runs simply from
 * rounding; anything tighter than that would reopen every known card. A genuine
 * repost resets to minutes old, so it clears this by a wide margin.
 */
const REPOST_GAP_MS = 6 * 3_600_000;

/**
 * How far back past the last sweep a page may reach before it counts as ground
 * already covered.
 *
 * LinkedIn's date ordering is only approximately honest — promoted cards are
 * interleaved, and `parseRelativeTime` works from text like "2 hours ago", so a
 * card's computed age can be most of an hour out. This margin absorbs both.
 */
const COVERED_MARGIN_MS = 45 * 60_000;

/** Consecutive fully-covered pages before pagination gives up on a search. */
const COVERED_PAGES_BEFORE_STOP = 2;

/** Tracks the wall-clock ceiling so a run can never sprawl unattended. */
function budget(maxMinutes) {
  const start = Date.now();
  const deadline = start + maxMinutes * 60_000;
  return {
    exceeded: () => Date.now() > deadline,
    remainingMs: () => Math.max(0, deadline - Date.now()),
    remainingMinutes: () => Math.max(0, Math.round((deadline - Date.now()) / 60_000)),
    elapsedSeconds: () => Math.round((Date.now() - start) / 1000),
  };
}

/**
 * Load a .env file if one exists, so GEMINI_API_KEY can live in the project
 * rather than in a shell profile. launchd gives the job almost no environment,
 * so a key exported in .zshrc would never reach a scheduled run — this is the
 * only way it works both from a terminal and from the schedule.
 */
function loadEnv() {
  try {
    process.loadEnvFile(join(ROOT, '.env'));
  } catch {
    // No .env, or unreadable. Not an error: the classifier falls back offline.
  }
}

/**
 * Open jobs that were stored from card data alone and fetch what we skipped.
 *
 * A confidently non-tech title does not get its page opened during the scan —
 * that is a deliberate trade to keep the run's page budget on roles that need a
 * verdict. The side effect is a row with description NULL, and since
 * `needingEnrichment` requires a description, and a later scan skips the job as
 * already known, those rows never improve. They sit on the site as a bare title
 * with no stipend and no duration even though the posting plainly states both.
 *
 * This is the pass that closes that loop. It is deliberately small and last:
 * capped per run, and it stops the moment the run is out of time, so it can
 * only ever use the slack left over after the actual scan.
 */
async function backfillDescriptions(page, store, cfg, clock, counters) {
  const limit = cfg.enrich?.backfillPerRun ?? 6;
  if (limit <= 0) return;

  const pending = store.needingDescription(limit, cfg.publish?.maxAgeDays ?? 14);
  if (!pending.length) return;

  log.info(`Backfilling ${pending.length} posting${pending.length === 1 ? '' : 's'} that were listed without being opened…`);

  for (const row of pending) {
    if (clock.exceeded()) {
      log.info('Out of time — the rest keep their card data and are picked up next run.');
      break;
    }
    if (!(await pageAlive(page))) break;

    await pause(cfg.pacing.betweenCards);

    let detail;
    try {
      detail = await li.openAndExtract(page, { jobId: row.job_id }, cfg);
    } catch (err) {
      counters.failedDetails++;
      log.warn(`Could not backfill "${row.title}" — ${err.message.split('\n')[0]}`);
      await ensureHealthy(page, cfg, { context: `backfill ${row.job_id}`, remainingMs: clock.remainingMs() });
      continue;
    }

    await ensureHealthy(page, cfg, { context: `backfill ${row.job_id}`, remainingMs: clock.remainingMs() });

    const description = detail.description || '';
    if (description.length <= 200) {
      // Nothing worth storing. Leave description NULL so the row stays in the
      // queue rather than being marked done with an empty string.
      log.debug(`Backfill found no usable description for ${row.job_id}.`);
      continue;
    }

    const job = {
      description,
      salaryText: detail.salaryText ?? null,
      stipend: extractStipend(detail.salaryText, description),
      duration: extractDuration(description, detail.title || row.title),
      skills: extractSkills(description),
      applicants: detail.applicants ?? null,
      applyUrl: detail.applyUrl ?? null,
      workplaceType: detail.workplaceType || extractWorkplaceType(detail.location, description),
      logoUrl: detail.logoUrl ?? null,
      title: detail.title || row.title,
      company: detail.company || row.company,
    };
    job.summary = await summarize(job, description, cfg.summarizer);

    store.saveDescription(row.job_id, job);
    counters.descriptionsBackfilled++;
    log.ok(`  → backfilled ${row.company ?? ''} ${row.title}`.replace(/\s+/g, ' '));
  }
}

/**
 * Turn freshly scraped descriptions into card content: bullets, eligibility, key
 * skills, a stipend state, and a tech verdict judged on the description rather than
 * the title.
 *
 * Capped per run. This is the only step here that costs API quota, and a free tier
 * is a shared, exhaustible resource — spending it all on one unusually large run
 * would leave the next few runs with nothing. Anything skipped is picked up next
 * time, because needingEnrichment only ever returns rows that have no bullets yet.
 */
async function enrichNewJobs(store, cfg) {
  const limit = cfg.enrich?.perRunLimit ?? 24;
  const pending = store.needingEnrichment(limit);
  if (!pending.length) return;

  log.info(`Enriching ${pending.length} new posting${pending.length === 1 ? '' : 's'}\u2026`);
  const results = await enrichJobs(pending, cfg);
  if (!results.size) {
    log.info('Nothing enriched this run \u2014 those postings keep their plain summary.');
    return;
  }

  let flipped = 0;
  for (const [i, e] of results) {
    const row = pending[i];
    if (!row) continue;
    const before = store.db.prepare('SELECT is_tech FROM jobs WHERE job_id = ?').get(row.job_id)?.is_tech;
    store.saveEnrichment(row.job_id, e);
    if (typeof e.isTech === 'boolean' && before != null && !!before !== e.isTech) flipped++;
  }
  log.ok(`Enriched ${results.size}/${pending.length}${flipped ? ` \u00b7 ${flipped} changed tech verdict` : ''}.`);
}

async function main() {
  loadEnv();
  ensureDirs();
  const cfg = loadConfig();

  // Everything Gemini has taught us so far joins the offline vocabulary, so a
  // term learned once is answered instantly and for free from then on.
  const learnedStore = loadLearned();
  const learnedVocab = learnedVocabulary(learnedStore);
  cfg.matching.extraTechTerms = [...(cfg.matching.extraTechTerms ?? []), ...learnedVocab.positive];
  cfg.matching.extraNonTechTerms = [...(cfg.matching.extraNonTechTerms ?? []), ...learnedVocab.negative];
  if (learnedVocab.positive.length || learnedVocab.negative.length) {
    log.info(`Learned vocabulary: ${learnedVocab.positive.length} tech, ${learnedVocab.negative.length} non-tech terms in play.`);
  }

  if (OVERRIDES.maxPages) cfg.limits.maxPagesPerSearch = OVERRIDES.maxPages;
  if (OVERRIDES.maxDetails) cfg.limits.maxDetailsPerRun = OVERRIDES.maxDetails;
  if (OVERRIDES.maxMinutes) cfg.limits.maxRuntimeMinutes = OVERRIDES.maxMinutes;
  if (OVERRIDES.sortBy) {
    // Relevance matters for a deep backfill: LinkedIn caps a search at ~1000
    // results, so newest-first would return only the last couple of days of a
    // 30-day window. Relevance spreads the sample across the whole period.
    cfg.filters.sortBy = OVERRIDES.sortBy;
  }
  if (OVERRIDES.windowHours) {
    // An explicit window beats the adaptive calculation entirely.
    cfg.filters.adaptiveWindow = false;
    cfg.filters.postedWithinHours = OVERRIDES.windowHours;
  }
  if (Object.values(OVERRIDES).some((v) => v != null)) {
    log.warn(`One-off overrides active: ${Object.entries(OVERRIDES).filter(([, v]) => v != null).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  }

  // Company batches or role keywords, per config.searchMode.
  const allSearches = resolveSearches(cfg);

  if (DRY_RUN) {
    log.warn('DRY RUN — one search, one page, at most 3 job details.');
    allSearches.splice(1);
    cfg.limits = { ...cfg.limits, maxPagesPerSearch: 1, maxDetailsPerRun: 3, maxRuntimeMinutes: Math.min(cfg.limits.maxRuntimeMinutes, 15) };
  }

  const runId = makeRunId();
  const store = new Store();

  // Refuse to start while another run holds the lock. Hourly slots plus a
  // 45-minute budget leave little headroom, and two runs would fight over the
  // Brave profile lock and double the request rate. The lock self-expires after
  // the runtime budget so a crashed run cannot wedge the schedule forever.
  const LOCK_KEY = 'run_started_at';
  // The lock has to outlive the SCAN budget, not equal it.
  //
  // maxRuntimeMinutes bounds the scan loop only — classification, enrichment,
  // the report and the publish all happen after the clock is spent, so an
  // entirely healthy run finishes somewhat later than its budget. Expiring the
  // lock at exactly the budget therefore declared live runs dead: the next slot
  // cleared the lock, started while the previous Brave still owned the profile,
  // and died on a launch timeout. That is the failure that filled the runs table
  // with "launchPersistentContext: Timeout" errors.
  const LOCK_GRACE_MIN = 8;
  const lockExpiryMin = cfg.limits.maxRuntimeMinutes + LOCK_GRACE_MIN;
  const heldSince = Number(store.getSetting(LOCK_KEY) ?? 0);
  const lockAgeMin = heldSince ? (Date.now() - heldSince) / 60_000 : Infinity;
  if (heldSince && lockAgeMin < lockExpiryMin && !ARGS.has('--force')) {
    log.warn(`Another run started ${lockAgeMin.toFixed(0)} min ago and is still going. Skipping this slot.`);
    store.close();
    return;
  }
  if (heldSince && lockAgeMin >= lockExpiryMin) {
    log.warn(`Clearing a stale run lock (${lockAgeMin.toFixed(0)} min old — the previous run probably crashed).`);
    // A run that overran its lock may still have a Brave alive on the profile.
    // Ending it here is what stops this run inheriting the same launch timeout.
    releaseProfileLock();
  }

  // Refuse to run while a cooldown from a previous rate limit is in force.
  const cooldown = store.activeCooldown();
  if (cooldown && !ARGS.has('--force')) {
    const hours = ((cooldown.until - Date.now()) / 3_600_000).toFixed(1);
    log.warn(`Skipping this run: cooling down for another ${hours}h after ${cooldown.reason}.`);
    log.info('Override with `node src/index.js --force` if you are sure.');
    store.close();
    return;
  }

  // Claim the lock BEFORE the jitter sleep, not after.
  //
  // The sleep below is up to a minute long, and it used to sit between the
  // "is anyone else running?" check above and this line. Two runs starting
  // inside that minute therefore both saw an unheld lock, both slept, and both
  // carried on — then fought over the same Brave profile, and one killed the
  // other's browser mid-page. That is the "Target page, context or browser has
  // been closed" followed by a soft_block abort 37 seconds into a run. launchd
  // makes it easy to hit: after the machine wakes it fires the slots it missed,
  // which can be two starts ten seconds apart.
  //
  // Writing the timestamp first makes the window as small as SQLite's own
  // write, so the second run reads a held lock and stands down properly.
  store.setSetting(LOCK_KEY, Date.now());

  // Land at a slightly different minute each day rather than exactly 12:00:00.
  if (SCHEDULED && !DRY_RUN && cfg.pacing.startupJitter) {
    const jitter = humanDelay(cfg.pacing.startupJitter);
    if (jitter > 1000) {
      log.info(`Waiting ${Math.round(jitter / 60_000)} min before starting (schedule jitter).`);
      await sleep(jitter);
      // Re-stamp so the lock's age is measured from real work starting, not
      // from a run that has spent its first minute asleep.
      store.setSetting(LOCK_KEY, Date.now());
    }
  }

  store.startRun(runId);

  // Size the lookback from the gap since the last successful run. A fixed wide
  // window would make every hourly run re-paginate a day of postings to find
  // the newest hour; a fixed narrow one would lose everything posted while the
  // lid was shut. This does both jobs.
  const lastRun = store.lastFullSweep();
  cfg.filters.postedWithinHours = resolveWindowHours(lastRun?.started_at ?? null, cfg.filters);
  log.info(lastRun?.started_at
    ? `Lookback window: ${cfg.filters.postedWithinHours}h (last run ${((Date.now() - lastRun.started_at) / 3_600_000).toFixed(1)}h ago).`
    : `Lookback window: ${cfg.filters.postedWithinHours}h (no previous run to measure from).`);

  // Everything older than this was already walked by an earlier sweep.
  //
  // The window has a 3-hour floor while the loop runs every half hour, so a
  // scan re-paginates hours of postings to reach the few minutes of genuinely
  // new ones. Measured over the scheduled runs: 873 page loads produced 16
  // opens, and every one but a single card sat on pages 1-3. The rest was the
  // same junk re-read, and page loads are the request budget that a rate limit
  // is eventually spent on.
  //
  // Deliberately NOT applied when --window-hours was passed: that override
  // exists to walk deliberately deep after an outage, and stopping early would
  // defeat the one job it has.
  const coveredHorizon = (!OVERRIDES.windowHours && lastRun?.started_at)
    ? lastRun.started_at - COVERED_MARGIN_MS
    : null;

  const clock = budget(cfg.limits.maxRuntimeMinutes);
  const notes = [];
  const counters = { pagesScanned: 0, cardsSeen: 0, detailsExtracted: 0, newJobs: 0, skippedStale: 0, skippedCompany: 0, skippedTitle: 0, techRoles: 0, nonTechRoles: 0, geminiJudged: 0, termsLearned: 0, nearMisses: 0, skippedViewed: 0, listedWithoutOpening: 0, logosBackfilled: 0, skippedKnown: 0, failedDetails: 0, descriptionsBackfilled: 0, cardsWithoutId: 0, cardKeysMigrated: 0 };

  log.section(`Run ${runId}`);
  log.info(`${cfg.watchlist.length} watchlist terms across ${cfg.uniqueCompanyCount} companies · mode "${cfg.searchMode ?? 'companies'}" · ${allSearches.length} searches · budget ${cfg.limits.maxRuntimeMinutes}m`);

  let session;
  let status = 'ok';
  let fatalError = null;
  let searchesDone = 0;
  let searchStart = 0;

  try {
    session = await launchBrave(cfg);
    const { page, context } = session;

    await li.warmUp(page, cfg);
    await ensureHealthy(page, cfg, { context: 'warm-up', remainingMs: clock.remainingMs() });
    await assertSignedIn(page, context, cfg);
    log.ok('Signed in.');

    // Rotate the starting point. With a long keyword list one run cannot
    // always reach the end, and starting from index 0 every time would mean
    // the tail never runs at all. Picking up where the last run stopped gives
    // every keyword its turn across consecutive runs.
    const cursor = DRY_RUN ? 0 : Number(store.getSetting('search_cursor') ?? 0) % allSearches.length;
    // Recorded here rather than after the loop. A run that aborts mid-walk
    // never reaches the far side of the loop, and leaving this at 0 made the
    // next cursor `0 + searchesDone` — rewinding the rotation to searches that
    // had just been covered and skipping the ones still waiting for their turn.
    searchStart = cursor;
    const ordered = [...allSearches.slice(cursor), ...allSearches.slice(0, cursor)];
    if (cursor > 0) {
      log.info(`Resuming the rotation at position ${cursor + 1} of ${allSearches.length}.`);
    }

    searchLoop:
    for (const [searchIndex, search] of ordered.entries()) {
      const label = search.label
        ? `${search.label} (${search.companyCount} companies)`
        : `${search.keywords}${search.location ? ` @ ${search.location}` : ''}`;
      log.section(`Search: ${label} — ${searchIndex + 1}/${ordered.length}`);

      // Resuming a partial backfill starts deeper into the result set. The page
      // budget counts from there, and LinkedIn's own Next control still decides
      // where the results actually end.
      const firstPage = OVERRIDES.startPage ? OVERRIDES.startPage - 1 : 0;
      const lastPage = firstPage + cfg.limits.maxPagesPerSearch;
      let coveredPages = 0;
      // Whether any page of THIS search has rendered cards. Once one has, an
      // empty page is the end of the results rather than a selector break —
      // see assertListRendered.
      let renderedEarlierPage = false;

      for (let pageIndex = firstPage; pageIndex < lastPage; pageIndex++) {
        // Checked here, before navigating, not only inside the card loop below.
        // A run overran its 12-minute budget by five minutes because both the
        // slow goto and the stall that followed happened before execution ever
        // reached a card, so nothing ever asked whether there was time left.
        if (clock.exceeded()) {
          notes.push('Ran out of time partway through, so this scan stopped early. The next run resumes from here.');
          log.warn(`Out of time after ${clock.elapsedSeconds()}s — stopping the scan.`);
          status = 'partial';
          break searchLoop;
        }

        if (counters.detailsExtracted >= cfg.limits.maxDetailsPerRun) {
          notes.push(`Hit the ${cfg.limits.maxDetailsPerRun}-job limit for one run. Any further matches were left for the next run.`);
          status = 'partial';
          break searchLoop;
        }

        const url = li.buildSearchUrl(search, cfg.filters, { start: pageIndex * li.RESULTS_PER_PAGE });
        log.info(`Page ${pageIndex + 1} — ${url}`);

        const navigated = await li.gotoSearch(page, url, cfg);
        await ensureHealthy(page, cfg, { context: `search "${label}" page ${pageIndex + 1}`, remainingMs: clock.remainingMs() });
        if (!navigated) {
          notes.push(`The job list never finished loading for "${label}" page ${pageIndex + 1}; skipped it.`);
          break;
        }

        const { cards, unidentified } = await li.enumerateCards(page, cfg);
        if (unidentified?.length) {
          counters.cardsWithoutId += unidentified.length;
          log.warn(`${unidentified.length} card(s) on this page had no readable company or title and could not be processed: ${unidentified.filter(Boolean).slice(0, 3).join(' | ')}`);
        }
        await assertListRendered(page, cards.length, { pageIndex: pageIndex + 1, searchLabel: label, renderedEarlierPage });
        if (cards.length) renderedEarlierPage = true;
        counters.pagesScanned++;
        counters.cardsSeen += cards.length;
        log.info(`Found ${cards.length} job cards.`);

        if (cards.length === 0) break;

        const cutoff = Date.now() - cfg.filters.postedWithinHours * 3_600_000;
        let openedOnThisPage = 0;

        for (const card of cards) {
          if (clock.exceeded() || counters.detailsExtracted >= cfg.limits.maxDetailsPerRun) break;
          if (!card.key) continue;

          // --- cheap local filters, in priority order ----------------------
          // Skip records key on card.identity, NOT card.key. The key carries the
          // posted text, which changes every time LinkedIn's relative clock ticks
          // over, so a card refused once produced a fresh seen_cards row roughly
          // every quarter of an hour it stayed on the page — 3997 rows for 1154
          // distinct postings in one afternoon. That inflates topSkippedCompanies
          // by ~3.5x and turns it from "how many postings did this employer make"
          // into "how long were they on screen", which is the wrong question to
          // tune a watchlist against. Nothing reads these before gating, so
          // dropping the timestamp costs nothing.
          //
          // Everything in this block runs BEFORE the card is clicked, and since
          // the redesign that means it runs before LinkedIn has told us the job
          // id. It works off the card's own text instead, which is what keeps
          // the click budget on watchlist matches rather than spending it
          // discovering the ids of postings we would have thrown away.
          //
          // "Do we already hold this?" is the one gate that genuinely needs the
          // real id, so it is answered from what an earlier click recorded.
          // Location became part of the identity on 16 Aug 2026, so a row
          // written before that is found under the old two-part key and moved
          // across the first time it is hit. Migrating lazily, one card at a
          // time, is what keeps this from re-opening the whole board in a
          // single sweep — the old keys cannot be rewritten in bulk because
          // they hold the card's location text and the jobs table holds the
          // detail pane's.
          let known = store.jobIdForCard(card.identity);
          if (!known) {
            const legacy = store.jobIdForCard(li.legacyCardIdentity(card));
            if (legacy) {
              store.migrateCardKey(li.legacyCardIdentity(card), card.identity, legacy.job_id, legacy.posted_at);
              known = legacy;
              counters.cardKeysMigrated++;
            }
          }
          if (known && store.hasJob(known.job_id)) {
            const cardPostedAt = parseRelativeTime(card.postedText);
            // Same company, same title — but LinkedIn relists roles under a
            // fresh id constantly, and a relisted posting reads as hours newer
            // than the one this maps to. Treating that as already-seen is how a
            // stale copy stays on the board while the live one is never opened.
            const isRepost = cardPostedAt && known.posted_at
              && cardPostedAt - known.posted_at > REPOST_GAP_MS;
            if (!isRepost) {
              counters.skippedKnown++;
              store.touchJob(known.job_id);
              if (store.backfillLogo(known.job_id, card.logoUrl)) counters.logosBackfilled++;
              continue;
            }
            log.debug(`"${card.title}" at ${card.company} looks relisted (${card.postedText}) — opening it rather than trusting the old id.`);
          }

          // A blocked employer is unreachable by any route. This is checked on
          // its own rather than relying on matchCompany returning null, because
          // that returns null for "unknown" and "banned" alike — and once the
          // watchlist stopped being a hard gate, unknown became publishable.
          // MedTourEasy, on the blocklist for being a reported scam, turned up
          // 304 times in one week as a card the old gate happened to drop.
          if (isBlockedCompany(card.company)) {
            counters.skippedCompany++;
            store.noteSkippedCard(card.identity, 'blocked employer', card.company, card.title);
            continue;
          }

          // COMPANY IS THE FIRST GATE. If the employer is not one we care
          // about, nothing else about the posting matters — no title parsing,
          // no role classification, and above all no Gemini call. This is what
          // keeps the classifier budget spent only on jobs that could actually
          // be published, and it is the only thing standing between the site
          // and the unpaid "training & internship" listings that fill a broad
          // search. New employers are added to companies.json by hand, on
          // purpose: a name on the list is a name somebody vouched for.
          const matched = matchCompany(card.company, cfg.watchlist);
          if (cfg.matching.requireCompanyMatch && !matched) {
            counters.skippedCompany++;
            store.noteSkippedCard(card.identity, 'company not on watchlist', card.company, card.title);
            continue;
          }

          const postedAt = parseRelativeTime(card.postedText);
          // Only reject on a *confidently* old timestamp; unparseable text is
          // given the benefit of the doubt rather than silently dropped.
          if (postedAt && postedAt < cutoff) {
            counters.skippedStale++;
            store.noteSkippedCard(card.identity, 'older than window', card.company, card.title);
            continue;
          }

          // The title is the only internship signal left, since LinkedIn's
          // employment-type tag proved unreliable. A watchlist company whose
          // title lacks an internship word is a near miss worth reporting.
          if (!matchTitle(card.title, cfg.titleTerms)) {
            counters.skippedTitle++;
            counters.nearMisses++;
            store.noteSkippedCard(
              card.identity,
              'title lacks intern (watchlist tech role)',
              card.company,
              card.title,
            );
            continue;
          }

          if (cfg.matching.skipViewedCards && card.viewed) {
            counters.skippedViewed++;
            store.noteSkippedCard(card.identity, 'already viewed on LinkedIn', card.company, card.title);
            continue;
          }

          // Decide tech vs non-tech from the title BEFORE deciding whether to
          // open the job. A real backfill came back 11 tech / 46 non-tech, so
          // opening everything spent ~80% of the run's page loads on roles that
          // only need to appear in a list. Non-tech gets stored from card data.
          const titleVerdict = classifyRole(card.title, {
            extraPositive: cfg.matching.extraTechTerms ?? [],
            extraNegative: cfg.matching.extraNonTechTerms ?? [],
          });
          // Only a CONFIDENT non-tech verdict skips the page open. An
          // ambiguous title ("Intern (Bachelor's)", "Intern-Product Analyst")
          // is exactly the case where the description decides, so it is still
          // opened. On the observed backfill that is 4 opens out of 12 rather
          // than 12, while keeping recall on the ones that matter.
          const confidentlyNonTech = titleVerdict.verdict === 'non-tech';

          // The site is engineering-only, so a confidently non-technical title
          // is dropped here rather than stored. It is still recorded in
          // seen_cards, which is what stops the next run re-deciding the same
          // card and gives an honest count of what the sweep discarded.
          if (confidentlyNonTech && cfg.matching.storeNonTechRoles === false) {
            counters.nonTechRoles++;
            store.noteSkippedCard(card.identity, 'non-engineering role', card.company, card.title);
            continue;
          }

          // Listing a role from card data alone needs a job id, and since the
          // redesign there is none until the card is opened. A row stored under
          // a synthetic key could never be linked to, applied to, or matched
          // against LinkedIn again, so the optimisation is simply unavailable
          // here — the card is opened instead. Unreachable under the shipped
          // config, where storeNonTechRoles false has already skipped it above.
          if (confidentlyNonTech && cfg.matching.openNonTechRoles === false && card.jobId) {
            const stipend = extractStipend(card.salaryText);
            const isNew = store.upsertJob({
              jobId: card.jobId,
              title: card.title,
              company: card.company,
              companyMatched: matched,
              location: card.location,
              workplaceType: extractWorkplaceType(card.location),
              postedText: card.postedText,
              postedAt: parseRelativeTime(card.postedText),
              salaryText: card.salaryText,
              stipend,
              easyApply: card.easyApply,
              jobUrl: li.jobUrl(card.jobId),
              logoUrl: card.logoUrl || null,
              searchKeywords: search.label ?? search.keywords,
              // Already decided; the batch pass will leave it alone.
              isTech: false,
              roleSource: 'offline-card',
            }, runId);
            if (isNew) {
              counters.newJobs++;
              counters.listedWithoutOpening++;
            }
            continue;
          }

          // --- worth opening ------------------------------------------------
          log.ok(`Opening: ${card.title} — ${card.company}${matched ? ` [${matched}]` : ''} (${card.postedText || 'no date'})`);

          await pause(cfg.pacing.betweenCards);
          await idleFidget(page);

          // Brave can die mid-run (it crashed once under memory pressure). Say
          // so plainly and stop, rather than failing on whatever call happened
          // to touch the dead page next.
          if (!(await pageAlive(page))) {
            notes.push('Brave closed unexpectedly partway through the run. Everything captured before that point was kept and published.');
            log.error('Brave is no longer responding — ending the run and keeping what was collected.');
            status = 'partial';
            break searchLoop;
          }

          let detail;
          try {
            detail = await li.openAndExtract(page, card, cfg);
          } catch (err) {
            counters.failedDetails++;
            log.warn(`Could not read "${card.title}" — ${err.message.split('\n')[0]}`);
            await ensureHealthy(page, cfg, { context: `card ${card.key}`, remainingMs: clock.remainingMs() });
            continue;
          }

          // The click is what makes LinkedIn name the posting, so this is the
          // point where the synthetic key is exchanged for the real job id.
          const jobId = detail.jobId;
          if (!jobId) {
            counters.failedDetails++;
            if (!detail.unopenable) {
              log.warn(`Opened "${card.title}" at ${card.company} but no job id appeared — skipping it this run.`);
            }
            await ensureHealthy(page, cfg, { context: `card ${card.key}`, remainingMs: clock.remainingMs() });
            continue;
          }

          await ensureHealthy(page, cfg, { context: `job ${jobId}`, remainingMs: clock.remainingMs() });
          counters.detailsExtracted++;
          openedOnThisPage++;

          const description = detail.description || '';
          const detailPostedAt = parseRelativeTime(detail.postedText || card.postedText);

          // Remember what this card turned out to be, so the next run answers
          // "do we already hold it?" without opening the page again. Written
          // before the store decision below, because it is just as useful for a
          // posting we already have as for a new one.
          store.mapCard(card.identity, jobId, detailPostedAt);

          // Known after all — the id could not be checked before the click.
          if (store.hasJob(jobId)) {
            counters.skippedKnown++;
            store.touchJob(jobId);
            if (store.backfillLogo(jobId, detail.logoUrl || card.logoUrl)) counters.logosBackfilled++;
            continue;
          }

          const job = {
            jobId,
            title: detail.title || card.title,
            company: detail.company || card.company,
            companyMatched: matched,
            location: detail.location || card.location,
            workplaceType: detail.workplaceType || extractWorkplaceType(detail.location, card.location, description),
            postedText: detail.postedText || card.postedText,
            postedAt: detailPostedAt,
            salaryText: detail.salaryText || card.salaryText,
            stipend: extractStipend(detail.salaryText, card.salaryText, description),
            applicants: detail.applicants,
            easyApply: detail.easyApply ?? card.easyApply,
            applyUrl: detail.applyUrl,
            jobUrl: li.jobUrl(jobId),
            duration: extractDuration(description, detail.title || card.title),
            skills: extractSkills(description),
            description,
            searchKeywords: search.label ?? search.keywords,
            // Detail-pane logo is higher resolution; fall back to the card's.
            logoUrl: detail.logoUrl || card.logoUrl || null,
          };
          job.summary = await summarize(job, description, cfg.summarizer);
          // Verdict is filled in by one batched classifier pass after the walk.
          job.isTech = null;
          job.roleSource = null;

          if (store.upsertJob(job, runId)) {
            counters.newJobs++;
            log.ok(`  → saved (${counters.newJobs} new so far)`);
          }

          if (counters.detailsExtracted > 0 && counters.detailsExtracted % cfg.pacing.longBreakEvery === 0) {
            log.info('Taking a longer break to keep the request rate low…');
            await pause(cfg.pacing.longBreak);
          }
        }

        log.info(`Page ${pageIndex + 1} done — opened ${openedOnThisPage} of ${cards.length} cards.`);

        // Results are date-descending, so once a whole page carries nothing
        // newer than the last sweep covered, everything past it is older still.
        // A card whose posted text will not parse counts as fresh — the same
        // benefit of the doubt the staleness gate gives it.
        if (coveredHorizon && cards.length) {
          const anyFresh = cards.some((c) => {
            const at = parseRelativeTime(c.postedText);
            return !at || at >= coveredHorizon;
          });
          if (anyFresh) {
            coveredPages = 0;
          } else if (++coveredPages >= COVERED_PAGES_BEFORE_STOP) {
            log.ok(`Page ${pageIndex + 1} and the one before it were entirely older than the last sweep — stopping "${label}" here.`);
            break;
          }
        }

        // Keep paging until LinkedIn's own "Next" control says there is no
        // more, which is the only reliable signal that the result set is
        // exhausted. Fall back to the short-page heuristic only when no
        // pagination bar could be found.
        const more = await li.hasNextPage(page);
        if (more === false) {
          log.ok(`No Next button — all ${pageIndex + 1} pages of "${label}" have been searched.`);
          break;
        }
        if (more === null && cards.length < li.RESULTS_PER_PAGE) {
          log.info(`No pagination control and a short page — treating page ${pageIndex + 1} as the last.`);
          break;
        }
        if (pageIndex === lastPage - 1) {
          notes.push(`Stopped at the ${cfg.limits.maxPagesPerSearch}-page safety cap for "${label}", and LinkedIn still had a Next page. Raise limits.maxPagesPerSearch in config.json to go deeper.`);
          log.warn(`Hit the ${cfg.limits.maxPagesPerSearch}-page cap for "${label}" with more pages still available.`);
        }
        await pause(cfg.pacing.betweenPages);
      }

      searchesDone++;

      if (searchIndex < ordered.length - 1) {
        log.info('Pausing between searches…');
        await pause(cfg.pacing.betweenSearches);
      }
    }

    // ---- backfill descriptions we never fetched ----------------------------
    // Must happen here, inside the browser session: the `finally` below closes
    // Brave, and enrichment further down has no page to work with.
    await backfillDescriptions(page, store, cfg, clock, counters);
  } catch (err) {
    if (err instanceof RunAborted) {
      status = counters.newJobs > 0 ? 'partial' : 'aborted';
      fatalError = err.message;

      // A rate limit means back off hard rather than trying again in six hours.
      if (err.state === State.RATE_LIMITED && cfg.safety.cooldownHoursAfterRateLimit > 0) {
        const until = Date.now() + cfg.safety.cooldownHoursAfterRateLimit * 3_600_000;
        store.setCooldown(until, 'a LinkedIn rate limit');
        notes.push(`Runs are paused for ${cfg.safety.cooldownHoursAfterRateLimit}h after that rate limit. Override with \`node src/index.js --force\`.`);
        log.warn(`Cooling down until ${new Date(until).toLocaleString('en-IN')}.`);
      }

      notes.push(
        err.state === State.CHALLENGE ? 'A LinkedIn security check went unsolved, so the scan stopped early. Whatever was found before that is below.'
        : err.state === State.LOGGED_OUT ? 'The LinkedIn session expired mid-run. Run `npm run login` to sign in again.'
        : err.state === State.BROWSER_GONE ? 'The browser closed part way through, so the scan stopped there. Nothing to do with LinkedIn — usually the window was closed by hand, or a second run started and took the profile. Whatever was collected first was kept.'
        : 'LinkedIn started rate limiting, so the scan stopped early to protect the account.',
      );
      log.error(err.message);
    } else {
      status = 'error';
      fatalError = err.message;
      log.error(`Run failed: ${err.stack ?? err.message}`);
      notes.push(`The run failed: ${err.message}`);
      if (cfg.notifications.onError) {
        await notify('Internship watcher failed', err.message.slice(0, 180), { sound: 'Basso' });
      }
    }
  } finally {
    if (session) await closeBrave(session);
  }

  // ---- report ---------------------------------------------------------------

  // ---- classify the roles we captured, in one batch ------------------------
  // Deliberately after the walk rather than during it: on a free tier the
  // request count is the scarce resource, so forty candidates should cost one
  // call rather than forty. Nothing here gates publication — a non-tech role
  // still reaches the site, just in the other section.
  // Everything still lacking a verdict, not merely this run's catch. A row
  // stored before the verdict column existed would otherwise sit in the wrong
  // tab forever — which is exactly what happened on the first run after this
  // shipped: five real jobs, all filed as "other", tech tab empty.
  const publishWindowMs = (cfg.publish?.maxAgeDays ?? 14) * 86_400_000;
  const unclassified = store.jobsNeedingRoleVerdict(Date.now() - publishWindowMs);

  if (unclassified.length) {
    const roleOpts = {
      extraPositive: cfg.matching.extraTechTerms,
      extraNegative: cfg.matching.extraNonTechTerms,
    };

    // Only titles the vocabulary cannot settle — generic ones like "Trainee",
    // or ones resting on nothing but the word "Engineer" — are worth an API
    // call. Everything else is decided offline for free.
    const ambiguous = [];
    const clear = [];
    for (const job of unclassified) {
      (needsDescription(job.title, roleOpts) ? ambiguous : clear).push(job);
    }

    for (const job of clear) {
      const r = classifyRole(job.title, roleOpts);
      const isTech = r.verdict === 'tech';
      store.setRoleVerdict(job.job_id, isTech, 'offline');
      if (isTech) counters.techRoles++; else counters.nonTechRoles++;
    }

    if (ambiguous.length) {
      log.info(`${ambiguous.length} title(s) too generic to judge — reading their descriptions.`);
      const withDesc = ambiguous.map((j) => ({
        title: j.title,
        company: j.company,
        description: store.descriptionFor(j.job_id),
      }));
      const answers = await classifyFromDescriptions(withDesc, cfg);
      const polarity = builtInPolarity();

      ambiguous.forEach((job, i) => {
        const a = answers?.get(i);
        if (a) {
          store.setRoleVerdict(job.job_id, a.isTech, 'model-description');
          if (a.isTech) counters.techRoles++; else counters.nonTechRoles++;
          counters.geminiJudged++;

          if (a.keyTerm) {
            const { result, why } = learn(learnedStore, {
              term: a.keyTerm,
              isTech: a.isTech,
              title: job.title,
              description: withDesc[i].description,
              company: job.company,
            }, polarity, cfg.matching.titleMustMatch ?? []);
            if (result === 'added') {
              counters.termsLearned++;
              log.ok(`  learned "${a.keyTerm.toLowerCase()}" -> ${a.isTech ? 'tech' : 'other'}`);
            } else if (result === 'rejected') {
              log.debug(`  did not learn "${a.keyTerm}" (${why})`);
            }
          }
        } else {
          // Gemini unavailable — decide offline and publish anyway.
          //
          // A posting must never sit unpublished waiting for a quota to reset.
          // Being early is the entire product, and an internship held back for
          // six hours pending a classifier is as good as missed.
          //
          // So an UNCERTAIN title counts as technical rather than being held or
          // buried. That is deliberately the generous direction: showing one
          // borderline role costs a student a moment's reading, while hiding a
          // real engineering internship costs them the application. The company
          // watchlist and the title filter have already run, so what reaches
          // here is an internship at a company we track.
          //
          // The verdict is marked 'offline-uncertain' rather than 'offline', and
          // store.jobsNeedingRoleVerdict re-queries exactly that source, so once
          // quota returns Gemini reads the description and upgrades the guess.
          // It publishes now and gets more accurate later.
          //
          // Safe to be generous because the company gate has already run: every
          // row reaching here is an internship at an employer on the watchlist.
          const r = classifyRole(job.title, roleOpts);
          const isTech = r.verdict !== 'non-tech';
          store.setRoleVerdict(job.job_id, isTech, r.verdict === 'uncertain' ? 'offline-uncertain' : 'offline-fallback');
          if (isTech) counters.techRoles++; else counters.nonTechRoles++;
        }
      });
    }

    log.info(`Classified ${unclassified.length} role(s): ${counters.techRoles} tech, ${counters.nonTechRoles} other · ${clear.length} offline, ${counters.geminiJudged} from descriptions`);
    if (counters.termsLearned) {
      log.ok(`Learned ${counters.termsLearned} new term(s) — future runs decide these offline. ${learnedPath().replace(process.env.HOME ?? '', '~')}`);
    }
  }

  const summaryLine =
    `${counters.cardsSeen} cards scanned · ${counters.detailsExtracted} opened · ${counters.newJobs} new · ` +
    `skipped ${counters.skippedCompany} off-watchlist, ${counters.skippedTitle} title not an internship, ` +
    `${counters.skippedStale} older than ${cfg.filters.postedWithinHours}h, ${counters.skippedKnown} already known, ` +
    `${counters.skippedViewed} already viewed · ${counters.listedWithoutOpening} listed without opening` +
    (counters.descriptionsBackfilled ? ` · ${counters.descriptionsBackfilled} descriptions backfilled` : '') +
    (counters.failedDetails ? ` · ${counters.failedDetails} failed to read` : '') +
    (counters.cardsWithoutId ? ` · ${counters.cardsWithoutId} cards could not be read` : '') +
    // Only while the pre-location card keys are still being moved across. Once
    // this stops appearing the migration is done and it can be dropped.
    (counters.cardKeysMigrated ? ` · ${counters.cardKeysMigrated} card keys migrated` : '');

  log.section('Summary');
  log.info(summaryLine);
  log.info(`Took ${clock.elapsedSeconds()}s`);

  // Persist the rotation cursor on every path, including an aborted run —
  // searches that did complete should not be repeated at the expense of ones
  // that never got their turn.
  if (!DRY_RUN && allSearches.length > 0) {
    const next = searchesDone >= allSearches.length
      ? 0
      : (searchStart + searchesDone) % allSearches.length;
    store.setSetting('search_cursor', next);

    if (searchesDone >= allSearches.length) {
      log.ok(`Covered all ${allSearches.length} searches — every watchlist company was queried.`);
    } else {
      const remaining = allSearches.length - searchesDone;
      notes.push(`Covered ${searchesDone} of ${allSearches.length} searches this run. The other ${remaining} are first in the queue next time, so no company batch is permanently skipped.`);
      log.info(`Covered ${searchesDone}/${allSearches.length} searches — next run resumes at position ${next + 1}.`);
    }
  }

  // "0 new jobs, 97 off-watchlist" invites the question "which 97?". Answer it
  // here, so the watchlist can be tuned from evidence rather than guesswork.
  if (counters.nearMisses > 0) {
    log.warn(`${counters.nearMisses} tech role(s) at watchlist companies were skipped only because the title lacks an internship word.`);
    log.info('Review them with `node bin/show-report.js --roles` — they may be internships titled unconventionally.');
  }

  if (counters.newJobs === 0 && counters.skippedCompany > 0) {
    const top = store.topSkippedCompanies(8, Date.now() - 7 * 86_400_000);
    if (top.length) {
      log.info('Most frequent companies skipped as off-watchlist (last 7 days):');
      for (const { company, n } of top) log.info(`    ${String(n).padStart(3)}×  ${company}`);
      log.info('Add any of these to config.json, or see the full list with `node bin/show-report.js --skipped`.');
    }
  }

  // A run that navigated nowhere and saw nothing did not succeed, whatever the
  // absence of an exception suggests. Reporting it as ok made the runs table
  // useless for spotting trouble: three of the worst runs today were logged
  // green while scanning zero pages.
  if (status === 'ok' && counters.pagesScanned === 0 && !DRY_RUN) {
    status = 'partial';
    notes.push('This run reached LinkedIn but never scanned a results page.');
  }

  // A rendered page of results is 20-25 cards. A sweep averaging a handful per
  // page has not found a quiet search — it has found a session LinkedIn has
  // stopped serving results to, which draws the list as the single job in the
  // detail pane and nothing else.
  //
  // assertListRendered cannot see this: it only fires on a count of exactly 0,
  // so one card per page walks straight past it. Five runs on 12 Aug reported
  // ok at 1 card a page, collecting 3 cards where the same search had been
  // returning 250. Nothing in the runs table looked wrong.
  //
  // Marking it partial is what makes it recoverable, not just visible:
  // lastFullSweep() reads 'ok' only, so an ok here becomes the new baseline and
  // pins the next lookback to its 3h minimum, leaving the missed postings
  // behind for good. As partial, the baseline stays put and the window stretches
  // over the gap (to maxWindowHours) on the next healthy run.
  const CARDS_PER_PAGE_FLOOR = 5;
  if (
    status === 'ok' && !DRY_RUN &&
    counters.pagesScanned > 0 &&
    counters.cardsSeen / counters.pagesScanned < CARDS_PER_PAGE_FLOOR
  ) {
    status = 'partial';
    notes.push(
      `Only ${counters.cardsSeen} card(s) across ${counters.pagesScanned} page(s) — the results list did not ` +
      'render. The LinkedIn session is the usual cause; check it with `npm run login`.',
    );
  }

  store.finishRun(runId, {
    status,
    pagesScanned: counters.pagesScanned,
    cardsSeen: counters.cardsSeen,
    detailsExtracted: counters.detailsExtracted,
    newJobs: counters.newJobs,
    skippedNote: summaryLine,
    error: fatalError,
  });

  // Enrich before the report and the publish, so a job reaches the site with its
  // bullets, eligibility and skills already attached. Doing this only in bin/enrich.js
  // meant every freshly scraped job appeared as a boilerplate paragraph until the next
  // manual run — the newest listings, which are the ones anyone actually looks at.
  if (!DRY_RUN) await enrichNewJobs(store, cfg);

  const newJobs = store.jobsForRun(runId);
  const html = buildReport({
    jobs: newJobs,
    run: { runId, startedAt: Date.now() - clock.elapsedSeconds() * 1000, finishedAt: Date.now(), ...counters },
    notes,
    stats: store.stats(),
  });
  const file = writeReport(html, runId);
  log.ok(`Report: ${file}`);

  if (newJobs.length) {
    store.markReported(newJobs.map((j) => j.job_id));
    if (cfg.notifications.onNewJobs) {
      const top = newJobs.slice(0, 3).map((j) => `${j.company}: ${j.title}`).join('\n');
      await notify(
        `${newJobs.length} new internship${newJobs.length === 1 ? '' : 's'}`,
        top + (newJobs.length > 3 ? `\n…and ${newJobs.length - 3} more` : ''),
        { sound: 'Ping', subtitle: 'Click to open the report' },
      );
    }
    if (cfg.notifications.openReportWhenDone && !NO_OPEN) {
      await openFile(file);
    }

    // The phone is the point: a banner on a sleeping Mac is a notification nobody
    // sees, and this whole project is about applying in the first hour.
    const tech = newJobs.filter((j) => j.is_tech);
    const lead = (tech.length ? tech : newJobs).slice(0, 4);
    await pushToPhone(
      `${newJobs.length} new internship${newJobs.length === 1 ? '' : 's'}`,
      lead.map((j) => `${j.company} — ${j.title}`).join('\n')
        + (newJobs.length > lead.length ? `\n…and ${newJobs.length - lead.length} more` : ''),
      { url: 'https://www.internzo.in/', tags: ['satellite'], priority: 4 },
    );
  } else {
    log.info('No new matching internships this run.');
  }

  // Push the public job list. Runs even with 0 new jobs so the site drops
  // listings that have aged out of the window.
  if (!DRY_RUN) await publish(store, cfg, newJobs.length);

  // The channel post goes AFTER publish, deliberately. Every listing in it
  // links to that job's page on the site, and those pages are written by
  // publish — posting first would send the channel a burst of links that 404
  // for however long the deploy takes.
  if (!DRY_RUN && newJobs.length) await postNewJobs(newJobs, cfg);

  store.setSetting(LOCK_KEY, 0);
  store.close();
  process.exitCode = status === 'error' ? 1 : 0;
}

// Make sure an unexpected crash still leaves a trace in the log file.
main().catch((err) => {
  log.error(`Unhandled: ${err.stack ?? err.message}`);
  process.exitCode = 1;
});
