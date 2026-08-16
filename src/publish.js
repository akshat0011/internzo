import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from './paths.js';
import { log } from './logger.js';
import { formatStipend, isIndianLocation } from './extract.js';
import { matchCompany, isBlockedCompany } from './config.js';
import { syncLogos, logoPathFor, logoDirSize } from './logos.js';
import { writePages } from './pages.js';

const WEB_DATA_DIR = join(ROOT, 'web', 'public', 'data');
const JOBS_FILE = join(WEB_DATA_DIR, 'jobs.json');

/**
 * Shape a stored job into what the public site shows.
 *
 * Full descriptions are deliberately left out by default. They are the posting
 * company's copyrighted text, and republishing them wholesale is a far bigger
 * exposure than showing our own summary and linking to the source. Students get
 * the summary plus every hard fact they need to decide; the Apply link takes
 * them to the real posting.
 */
/** Stored as a JSON string; a row written before enrichment existed has null. */
function parseJsonArray(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s) : [];
  } catch {
    return [];
  }
}

function toPublicJob(row, { includeFullDescription, matchedNow, logoIndex }) {
  const stipend = formatStipend({
    min: row.stipend_min, max: row.stipend_max,
    currency: row.stipend_currency, period: row.stipend_period,
  }) || row.salary_text || null;

  return {
    id: row.job_id,
    // The company shown publicly is the one on the posting, not our watchlist
    // label. A mislabelled employer on a public site is worse than no label.
    title: row.title,
    company: row.company || matchedNow || 'Unknown',
    matchedWatchlist: matchedNow,
    // null means the verdict pass has not run for this row yet; the site treats
    // an unknown verdict as non-tech rather than hiding the job.
    isTech: row.is_tech == null ? null : !!row.is_tech,
    roleSource: row.role_source ?? null,
    // Local path, never LinkedIn's CDN — see src/logos.js for why.
    logo: logoPathFor(row.company || matchedNow || '', logoIndex),
    location: row.location || null,
    workplaceType: row.workplace_type || null,
    stipend,
    duration: row.duration || null,
    applicants: row.applicants || null,
    easyApply: !!row.easy_apply,
    skills: row.skills || [],
    summary: row.summary || null,
    // Gemini enrichment. bullets is the card's primary body; an empty array means
    // the posting has not been enriched yet and the card falls back to summary.
    bullets: parseJsonArray(row.bullets),
    roleLabel: row.role_label || null,
    degreeLevel: row.degree_level || null,
    degreeText: row.degree_text || null,
    keySkills: parseJsonArray(row.key_skills),
    stipendStatus: row.stipend_status || (stipend ? 'paid' : 'unknown'),
    postedText: row.posted_text || null,
    postedAt: row.posted_at || row.first_seen_at,
    firstSeenAt: row.first_seen_at,
    url: row.job_url,
    applyUrl: row.apply_url || row.job_url,
    // Only carried when explicitly enabled; the tailor endpoint works fine
    // from the summary and skills alone.
    description: includeFullDescription ? row.description : null,
  };
}

/** Write the public jobs payload. Returns { count, path, changed }. */
export async function writeJobsFile(store, cfg) {
  const maxAgeMs = (cfg.publish?.maxAgeDays ?? 14) * 86_400_000;
  const includeFullDescription = !!cfg.publish?.includeFullDescription;

  const techOnly = cfg.publish?.techRolesOnly !== false;

  let dropped = 0;
  let droppedForeign = 0;
  let droppedNonTech = 0;
  const jobs = store
    .recentJobs(Date.now() - maxAgeMs)
    // Re-run the company match at publish time instead of trusting what was
    // stored. Rows captured before a matcher fix can carry a stale, wrong
    // label — an early bug filed "SolarSquare" under "Ola" — and publishing
    // that to students would be worse than dropping it.
    .map((row) => ({ row, matchedNow: matchCompany(row.company, cfg.watchlist) }))
    // A blocked employer never reaches the site, however it got into the table.
    // This is the last line rather than the only one — the scan refuses them too
    // — but it is the line that matters, because it also catches rows captured
    // before a name was blocked. Checked explicitly and not via matchCompany,
    // which returns null for "unknown" and "banned" alike.
    .filter(({ row }) => {
      if (!isBlockedCompany(row.company)) return true;
      dropped++;
      log.warn(`Not publishing "${row.title}" — "${row.company}" is on the blocklist.`);
      return false;
    })
    .filter(({ row, matchedNow }) => {
      if (!cfg.matching?.requireCompanyMatch) return true;
      if (matchedNow) return true;
      dropped++;
      log.debug(`Not publishing "${row.title}" — "${row.company}" no longer matches the watchlist.`);
      return false;
    })
    // India only, enforced HERE and not just at collection. The collectors gate
    // what is stored, but the table already held roles in Singapore, Malaysia
    // and Hannover from when that gate was open — 90 of 174 published. Applying
    // it at publish means those stop appearing without deleting anything, and
    // one flag brings them all back.
    .filter(({ row }) => {
      if (cfg.publish?.indiaOnly === false) return true;
      if (isIndianLocation(row.location)) return true;
      droppedForeign++;
      return false;
    })
    // Engineering only. Applied here rather than in the SQL so that older rows
    // stored back when the site carried every role simply stop appearing, with
    // no migration and nothing deleted — flip techRolesOnly to false and they
    // all come back.
    //
    // Note the test is `=== 1`, not truthiness: is_tech is NULL for a row whose
    // verdict pass has not run yet, and an unclassified job must not be
    // published on the assumption that it might be technical.
    .filter(({ row }) => {
      if (!techOnly) return true;
      if (row.is_tech === 1) return true;
      droppedNonTech++;
      return false;
    })
    .map(({ row, matchedNow }) => ({ row, matchedNow }));

  // ---- one posting, two collectors -----------------------------------------
  // The scraper and the ATS poller find the same role independently: a company
  // posts to its ATS, and the LinkedIn copy appears later. Both are stored,
  // because each is the truth about where it was seen — but the site must show
  // it once.
  //
  // The ATS row wins on a tie. It carries the employer's real apply URL rather
  // than a LinkedIn redirect, and its posted date is the actual publish time
  // rather than "3 days ago" parsed from a card.
  //
  // But only when the two are plausibly the SAME posting. That preference used
  // to be unconditional, and it is a preference between collectors, not between
  // postings — so a months-old ATS row silently suppressed a fresh relisting of
  // the same role. Stripe's "Software Engineer, Intern" was scraped 11 minutes
  // after going up on 14 Aug and did not reach the site for 9h46m: a Greenhouse
  // row for the same role, posted 22 Jul, held the slot. It was not fixed, it
  // expired — the ATS row left the 14-day window at 05:21 on 15 Aug and the
  // next run published the LinkedIn one at 05:50.
  //
  // Beyond this gap they are two postings, not two views of one, and the newer
  // is the one still open. Three days is deliberately generous: the ATS copy
  // goes up first and LinkedIn's follows within hours, so a genuine pair stays
  // well inside it and keeps the better apply URL.
  const SAME_POSTING_MS = 3 * 24 * 3_600_000;
  //
  // Where neither is from an ATS, the NEWEST posting wins. This used to keep the
  // row we saw first, on the reasoning that the freshness label stays honest —
  // but the duplicates it actually meets are LinkedIn reposts of one role under
  // a new job_id, and keeping the earliest inverted the thing it was protecting.
  // Intuit reposted "Intern, Software Engineering" in Bengaluru on 9 Aug; the
  // site went on showing the 4 Aug copy, six days stale, while the fresh row sat
  // in the table unpublished. Fourteen live cards were doing this at once.
  //
  // Company and title alone are not enough to call two rows the same job.
  // Bajaj Finserv lists "Functional Trainee" in Ranchi, Sandila, Rasulpur,
  // Lucknow, Pune, Bareilly, Bengaluru and Bhopal — eight real vacancies a
  // student would choose between, and keying on company+title would silently
  // publish one and throw seven away.
  //
  // But the city has to be compared loosely, because the two collectors write it
  // differently: the ATS says "Bangalore" where LinkedIn says "Bengaluru,
  // Karnataka, India". So the key uses a canonical city rather than the raw
  // string, and falls back to the whole normalised location when the city is not
  // one we recognise.
  const CITY_ALIASES = new Map(Object.entries({
    bangalore: 'bengaluru', bengaluru: 'bengaluru',
    gurgaon: 'gurugram', gurugram: 'gurugram',
    bombay: 'mumbai', mumbai: 'mumbai',
    'new delhi': 'delhi', delhi: 'delhi', noida: 'noida',
    calcutta: 'kolkata', kolkata: 'kolkata',
    madras: 'chennai', chennai: 'chennai',
    hyderabad: 'hyderabad', pune: 'pune', ahmedabad: 'ahmedabad',
    jaipur: 'jaipur', indore: 'indore', kochi: 'kochi', chandigarh: 'chandigarh',
    mysore: 'mysuru', mysuru: 'mysuru',
    trivandrum: 'thiruvananthapuram', thiruvananthapuram: 'thiruvananthapuram',
    vizag: 'visakhapatnam', visakhapatnam: 'visakhapatnam',
    coimbatore: 'coimbatore', nagpur: 'nagpur', bhopal: 'bhopal',
    lucknow: 'lucknow', ranchi: 'ranchi', bareilly: 'bareilly',
    bhubaneswar: 'bhubaneswar', remote: 'remote',
  }));

  const cityOf = (location) => {
    const flat = String(location ?? '').toLowerCase();
    if (!flat.trim()) return '';
    for (const [alias, canonical] of CITY_ALIASES) {
      if (new RegExp(`\\b${alias}\\b`).test(flat)) return canonical;
    }
    return flat.replace(/[^a-z0-9]+/g, ' ').trim();
  };

  const dedupeKey = (row) => {
    const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    return `${norm(row.company_matched || row.company)}|${norm(row.title)}|${cityOf(row.location)}`;
  };
  const isAts = (row) => String(row.job_id ?? '').startsWith('ats:');
  // Same fallback the public card uses, so the row that wins here is the row
  // carrying the date the site will actually print.
  const postedAtOf = (row) => row.posted_at || row.first_seen_at || 0;

  const bestByKey = new Map();
  for (const entry of jobs) {
    const key = dedupeKey(entry.row);
    const existing = bestByKey.get(key);
    if (!existing) { bestByKey.set(key, entry); continue; }

    const gap = Math.abs(postedAtOf(entry.row) - postedAtOf(existing.row));
    const challengerWins = isAts(entry.row) !== isAts(existing.row) && gap <= SAME_POSTING_MS
      ? isAts(entry.row)
      : postedAtOf(entry.row) > postedAtOf(existing.row);

    if (challengerWins) bestByKey.set(key, entry);
  }
  const deduped = [...bestByKey.values()];
  const collapsed = jobs.length - deduped.length;
  if (collapsed) {
    log.info(`Collapsed ${collapsed} duplicate posting${collapsed === 1 ? '' : 's'} found by both collectors.`);
  }
  jobs.length = 0;
  jobs.push(...deduped);

  // Fetch any logo we do not already hold, then resolve every job to a local path.
  const logoIndex = await syncLogos(
    jobs.map(({ row, matchedNow }) => ({ company: row.company || matchedNow || '', logoUrl: row.logo_url })),
  );

  const publicJobs = jobs
    .map(({ row, matchedNow }) => toPublicJob(row, { includeFullDescription, matchedNow, logoIndex }))
    .sort((a, b) => (b.postedAt ?? 0) - (a.postedAt ?? 0));

  if (droppedForeign) {
    log.info(`Held back ${droppedForeign} posting${droppedForeign === 1 ? '' : 's'} outside India.`);
  }

  if (droppedNonTech) {
    log.info(`Held back ${droppedNonTech} non-engineering posting${droppedNonTech === 1 ? '' : 's'} — the site is engineering-only.`);
  }

  if (dropped) {
    log.warn(`Held back ${dropped} stored job${dropped === 1 ? '' : 's'} whose company no longer matches the watchlist.`);
  }

  const techCount = publicJobs.filter((j) => j.isTech).length;
  const payload = {
    generatedAt: Date.now(),
    count: publicJobs.length,
    techCount,
    otherCount: publicJobs.length - techCount,
    companies: [...new Set(publicJobs.map((j) => j.company))].sort(),
    locations: [...new Set(publicJobs.map((j) => j.location).filter(Boolean))].sort(),
    jobs: publicJobs,
  };

  mkdirSync(WEB_DATA_DIR, { recursive: true });

  const next = `${JSON.stringify(payload, null, 1)}\n`;
  writeFileSync(JOBS_FILE, next);

  // Static pages for search engines. The JSON above serves the app; these serve
  // crawlers, which cannot run the JavaScript that turns it into listings.
  const pages = writePages(publicJobs, join(ROOT, 'web', 'public'));

  const withLogo = publicJobs.filter((j) => j.logo).length;
  return { count: publicJobs.length, techCount, path: JOBS_FILE, withLogo, logoBytes: logoDirSize(), pages };
}

function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    if (allowFail) return null;
    throw new Error(`git ${args[0]} failed: ${(err.stderr || err.message).toString().split('\n')[0]}`);
  }
}

/** Block the run for a moment. pushToSite is synchronous all the way down. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Push, retrying a network failure.
 *
 * The push is one HTTPS round trip, and a few seconds of dead network is enough
 * to lose it. On 10 Aug a HARMAN internship was scraped, classified, enriched
 * and written — and then the push hit seven seconds of no route to github.com.
 * The listing did not reach the site for another thirteen minutes, by which time
 * the Telegram channel, the phone push and the opened report had all announced
 * it. Somebody applied from an announcement for a job the site did not show.
 *
 * Only connectivity errors are retried. A rejected non-fast-forward or a
 * credential failure will not fix itself, and retrying those just burns the
 * remaining run budget.
 */
function pushWithRetry(branch, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      git(['push', 'origin', branch]);
      if (attempt > 1) log.ok(`Push succeeded on attempt ${attempt}.`);
      return;
    } catch (err) {
      const transient = /could not resolve host|failed to connect|couldn't connect|timed out|connection reset|network is unreachable|unable to access/i
        .test(err.message);
      if (!transient || attempt >= attempts) throw err;
      const wait = attempt * 5;
      log.warn(`Push attempt ${attempt} failed on the network — retrying in ${wait}s.`);
      sleepSync(wait * 1000);
    }
  }
}

/**
 * Commit and push the jobs file. Vercel is watching the repo, so the push is
 * what makes the site update — usually live within a minute.
 */
export function pushToSite(newJobCount) {
  if (!existsSync(join(ROOT, '.git'))) {
    log.warn('Not a git repository — skipping publish. Run `git init` and connect the GitHub remote first.');
    return false;
  }

  // Everything publish regenerates. Narrow on purpose — never `git add .`, or an
  // unattended run would commit whatever source edit happened to be in progress.
  // index.html is here because publish now writes the listings into it — only
  // the region between the LISTINGS markers, everything else is hand-authored.
  const PUBLISHED = ['web/public/data', 'web/public/logos', 'web/public/jobs',
    'web/public/companies', 'web/public/sitemap.xml', 'web/public/robots.txt',
    'web/public/feed.xml', 'web/public/feed.json', 'web/public/index.html'];

  const status = git(['status', '--porcelain', ...PUBLISHED], { allowFail: true });
  if (!status) {
    log.info('Job list is unchanged — nothing to publish.');
    return false;
  }

  const remote = git(['remote'], { allowFail: true });
  if (!remote) {
    log.warn('No git remote configured — the jobs file was written but not published.');
    return false;
  }

  try {
    git(['add', ...PUBLISHED]);
    const message = newJobCount > 0
      ? `Add ${newJobCount} new internship${newJobCount === 1 ? '' : 's'}`
      : 'Refresh job listings';
    // The pathspec is the point. `git add` is narrow, but a bare `git commit`
    // takes the whole index with it — so anything already staged when the timer
    // fired (a half-finished source edit, staged and left) rode along into an
    // unattended commit and got pushed. With the pathspec, only these paths are
    // committed and the rest of the index is left exactly as it was.
    git(['commit', '-m', message, '--', ...PUBLISHED]);

    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    pushWithRetry(branch);
    log.ok(`Published to the site — Vercel will redeploy within a minute.`);
    return true;
  } catch (err) {
    // A publish failure must never fail the scrape; the data is safe locally.
    log.warn(`Could not publish: ${err.message}`);
    // Say what this costs, because the alerts have already gone out by now and
    // the gap between them and the site is the part that misleads somebody.
    log.warn('The commit is local and unpushed. Alerts for these jobs have already been sent, '
      + 'so the site is behind them until the next run pushes — `git push` now to close the gap.');
    return false;
  }
}

/** Full publish step, called at the end of a run. */
export async function publish(store, cfg, newJobCount) {
  if (cfg.publish?.enabled === false) return;

  try {
    const { count, techCount, path, withLogo, logoBytes, pages } = await writeJobsFile(store, cfg);
    log.info(`Wrote ${count} jobs (${techCount} tech, ${count - techCount} other) to ${path.replace(ROOT, '.')} — ${withLogo} with a logo, ${Math.round(logoBytes / 1024)} KB stored`);
    log.info(`Generated ${pages.jobPages} job pages and ${pages.companyPages} company pages (${pages.indexable} indexable${pages.removed ? `, ${pages.removed} stale removed` : ''}).`);
    log.info(`Homepage carries ${pages.homeLinks} crawlable listing link${pages.homeLinks === 1 ? '' : 's'}.`);
    if (cfg.publish?.autoPush !== false) pushToSite(newJobCount);
  } catch (err) {
    log.warn(`Publish step failed: ${err.message}`);
  }
}
