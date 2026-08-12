#!/usr/bin/env node
/**
 * Read every discovered ATS board and store the internships found.
 *
 *   node bin/poll-ats.js              poll all boards, store, publish
 *   node bin/poll-ats.js --dry-run    show what would be stored, write nothing
 *   node bin/poll-ats.js --no-publish store, but do not regenerate the site
 *   node bin/poll-ats.js --company "Meesho"
 *
 * This is the cheap half. No browser, no login, no pacing, no rate-limit guard —
 * just JSON over HTTPS from endpoints that exist to be read. That is why it can
 * run far more often than the LinkedIn scan, and why being early here is a
 * property of the source rather than of how hard we push.
 *
 * Postings land in the same `jobs` table as the scraper's, so the site does not
 * know or care which collector found a role. `source` records which one did,
 * because when two collectors disagree you want to know who said what.
 */
import { loadConfig, matchCompany, matchTitle } from '../src/config.js';
import { Store } from '../src/store.js';
import { fetchBoard, fetchDetail, FIRST_PARTY_BOARDS } from '../src/ats.js';
import { classifyRole } from '../src/roles.js';
import { extractStipend, extractDuration, extractSkills, extractWorkplaceType, isIndianLocation } from '../src/extract.js';
import { summarize } from '../src/summarize.js';
import { publish } from '../src/publish.js';
import { log } from '../src/logger.js';

const ARGS = process.argv.slice(2);
const has = (f) => ARGS.includes(f);
const valueOf = (f) => { const i = ARGS.indexOf(f); return i >= 0 ? ARGS[i + 1] : null; };

const DRY_RUN = has('--dry-run');
const NO_PUBLISH = has('--no-publish');
const ONLY = valueOf('--company');
const CONCURRENCY = Number(valueOf('--concurrency') ?? 8);

const cfg = loadConfig();
const store = new Store();
store.ensureAtsTable();

/**
 * Assert the boards that cannot be discovered.
 *
 * Amazon and Microsoft run their own careers systems, so there is no token for
 * discovery to guess — probing Greenhouse and Lever slugs will never find a
 * board that was never there. Without this they exist only as a row somebody
 * inserted by hand once, and a fresh database loses them silently.
 *
 * Idempotent, and deliberately a repair rather than an insert: it also corrects
 * a company whose board was mis-identified by an earlier discovery run. Amazon
 * was filed under an unrelated Personio tenant that way, which would have
 * published a stranger's jobs under Amazon's name.
 */
for (const [company, [provider, token]] of Object.entries(FIRST_PARTY_BOARDS)) {
  const row = store.getAts(company);
  if (row?.provider === provider && row?.token === token) continue;
  store.saveAts(company, provider, token, row?.job_count ?? 0);
  log.info(`Seeded first-party board: ${company} → ${provider}:${token}${row?.provider ? ` (was ${row.provider}:${row.token})` : ''}`);
}

let boards = store.atsBoards();
if (ONLY) boards = boards.filter((b) => b.company.toLowerCase() === ONLY.toLowerCase());

/**
 * Workday is polled on rotation, not all at once.
 *
 * Every other provider here publishes its job-board API and is happy to be read.
 * Workday publishes nothing — the endpoint is the one its own careers pages
 * call — and reading 38 tenants every 15 minutes came to roughly 3,650 requests
 * a day, at which point it started answering every tenant with the careers-page
 * HTML instead of data. That is the same volume mistake the LinkedIn scraper is
 * built to avoid, arrived at from the other direction.
 *
 * So: a handful of the least-recently-read boards per run, in sequence rather
 * than in parallel. Each board still gets read several times a day, which is
 * ample for enterprise postings that stay open for weeks, at about a tenth of
 * the traffic.
 */
const WORKDAY_PER_RUN = 4;
const workdayAll = boards.filter((b) => b.provider === 'workday');
const others = boards.filter((b) => b.provider !== 'workday');
const workdayNow = ONLY ? workdayAll : [...workdayAll]
  .sort((a, b) => (a.last_polled ?? 0) - (b.last_polled ?? 0))
  .slice(0, WORKDAY_PER_RUN);
boards = others;

// Both lists, not just `boards`. Checking only the non-Workday half meant a
// database holding nothing but Workday tenants reported "no boards known" and
// exited without polling any of them.
if (!boards.length && !workdayNow.length) {
  console.log('No ATS boards known yet. Run `node bin/discover-ats.js` first.');
  store.close();
  process.exit(0);
}

/**
 * India only.
 *
 * These boards are global — a Greenhouse board carries every office — so
 * without this the site fills with roles no student here can take. The rule
 * itself lives in src/extract.js so that publish enforces exactly the same one
 * on rows captured earlier, and a location naming nowhere recognisably Indian
 * counts as foreign: the permissive version let "Bayan Lepas, my", "MSB,
 * Singapore" and "Hannover, de" through.
 *
 * Set ats.indiaOnly false in config.json to collect worldwide again.
 */
const INDIA_ONLY = cfg.ats?.indiaOnly !== false;

/**
 * How old a posting may be and still count as news.
 *
 * The scraper never needed this: LinkedIn is searched with a time window, so
 * stale roles are filtered at the source. An ATS board has no such window — it
 * lists whatever is still open, and companies leave roles open for months. The
 * first real poll surfaced postings 159 and 214 days old, which would have gone
 * onto a site whose entire promise is being early. Being first to a
 * seven-month-old listing is not a feature.
 */
const MAX_POSTING_AGE_DAYS = Number(valueOf('--max-age-days') ?? cfg.ats?.maxPostingAgeDays ?? 30);
const OLDEST_ACCEPTABLE = Date.now() - MAX_POSTING_AGE_DAYS * 86_400_000;

let checked = 0;
let stored = 0;
let skippedNonIntern = 0;
let skippedNonIndia = 0;
let skippedNonTech = 0;
let skippedStale = 0;
let failed = 0;
const preview = [];

async function pollOne(board) {
  let jobs;
  try {
    jobs = await fetchBoard(board.provider, board.token);
  } catch (err) {
    failed++;
    log.debug(`${board.company}: ${err.message}`);
    return;
  }
  checked++;
  // Name the board here too. A provider that answers with no usable payload
  // counts as failed but threw nothing, so this branch was the one failure in
  // "174/174 boards read, 1 failed" that left no way to tell which board it was.
  if (!jobs) { failed++; log.debug(`${board.company}: the board returned no jobs payload.`); return; }

  for (const j of jobs) {
    if (!matchTitle(j.title, cfg.titleTerms)) { skippedNonIntern++; continue; }
    if (INDIA_ONLY && !isIndianLocation(j.location)) { skippedNonIndia++; continue; }
    // A posting with no date is kept — some providers omit it — but a known-old
    // one is not, however open it still is.
    if (j.postedAt && j.postedAt < OLDEST_ACCEPTABLE) { skippedStale++; continue; }

    const verdict = classifyRole(j.title, {
      extraPositive: cfg.matching.extraTechTerms ?? [],
      extraNegative: cfg.matching.extraNonTechTerms ?? [],
    });
    // Same rule as the scraper: engineering only, but an ambiguous title is not
    // thrown away on the title alone.
    if (verdict.verdict === 'non-tech') { skippedNonTech++; continue; }
    const isTech = verdict.verdict === 'tech' ? true : null;

    // Some providers only expose the description and the real posting date on a
    // per-job endpoint. Fetch it now, after the filters, so the cost is one
    // request per internship kept rather than one per posting seen.
    const extra = await fetchDetail(board.provider, board.token, j);
    if (extra?.description) j.description = extra.description;
    if (extra?.postedAt) j.postedAt = extra.postedAt;

    // Re-apply staleness with the real date, which we may only now have. A
    // Workday listing shows "Posted 2 Days Ago" in the list and its true
    // startDate only here, so this is the first honest chance to judge it.
    if (j.postedAt && j.postedAt < OLDEST_ACCEPTABLE) { skippedStale++; continue; }

    // Prefixed so an ATS id can never collide with a LinkedIn numeric job id.
    const jobId = `ats:${board.provider}:${board.token}:${j.id}`;

    if (DRY_RUN) {
      preview.push(`${board.company} — ${j.title}${j.location ? ` (${j.location})` : ''}`);
      stored++;
      continue;
    }

    const isNew = store.upsertJob({
      jobId,
      title: j.title,
      company: board.company,
      companyMatched: matchCompany(board.company, cfg.watchlist) ?? board.company,
      location: j.location,
      workplaceType: j.remote || extractWorkplaceType(j.location),
      postedAt: j.postedAt,
      postedText: null,
      salaryText: null,
      stipend: extractStipend(j.description ?? '', j.title),
      duration: extractDuration(j.description ?? '', j.title),
      skills: extractSkills(j.description ?? ''),
      description: j.description ?? null,
      summary: j.description ? await summarize({ title: j.title, company: board.company }, j.description, cfg.summarizer) : null,
      jobUrl: j.url,
      applyUrl: j.url,
      searchKeywords: `ats:${board.provider}`,
      isTech,
      roleSource: `ats-${board.provider}`,
    }, `ats-${new Date().toISOString().slice(0, 10)}`);

    if (isNew) {
      stored++;
      log.ok(`  + ${board.company} — ${j.title}${j.location ? ` (${j.location})` : ''}`);
    }
  }

  if (!DRY_RUN) store.markAtsPolled(board.company);
}

console.log(`Polling ${boards.length} ATS board${boards.length === 1 ? '' : 's'}…\n`);

const queue = [...boards];
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (queue.length) {
    const b = queue.shift();
    if (b) await pollOne(b);
  }
}));

// Sequential, with a gap. Concurrent bursts are what drew the block.
if (workdayNow.length) {
  console.log(`\nWorkday: ${workdayNow.length} of ${workdayAll.length} boards this run (least recently read)…`);
  for (const b of workdayNow) {
    await pollOne(b);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

console.log(`\n=== ${checked}/${boards.length + workdayNow.length} boards read${failed ? `, ${failed} failed` : ''} ===`);
console.log(`  ${stored} new internship${stored === 1 ? '' : 's'} stored`);
console.log(`  skipped: ${skippedNonIntern} not an internship · ${skippedNonIndia} outside India · ${skippedStale} older than ${MAX_POSTING_AGE_DAYS}d · ${skippedNonTech} non-engineering`);

if (DRY_RUN) {
  console.log('\n--dry-run, nothing written. Would have stored:');
  for (const p of preview.slice(0, 40)) console.log('   ' + p);
  if (preview.length > 40) console.log(`   …and ${preview.length - 40} more`);
} else if (stored && !NO_PUBLISH) {
  console.log('\nPublishing…');
  await publish(store, cfg, stored);
}

store.close();
