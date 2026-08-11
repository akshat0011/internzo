import { DatabaseSync } from 'node:sqlite';
import { PATHS, ensureDirs } from './paths.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  job_id            TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  company           TEXT,
  company_matched   TEXT,
  location          TEXT,
  workplace_type    TEXT,
  posted_text       TEXT,
  posted_at         INTEGER,
  salary_text       TEXT,
  stipend_min       REAL,
  stipend_max       REAL,
  stipend_currency  TEXT,
  stipend_period    TEXT,
  applicants        TEXT,
  easy_apply        INTEGER DEFAULT 0,
  apply_url         TEXT,
  job_url           TEXT,
  duration          TEXT,
  skills            TEXT,
  description       TEXT,
  summary           TEXT,
  bullets           TEXT,
  role_label        TEXT,
  degree_level      TEXT,
  degree_text       TEXT,
  key_skills        TEXT,
  stipend_status    TEXT,
  logo_url          TEXT,
  is_tech           INTEGER,
  role_source       TEXT,
  search_keywords   TEXT,
  first_seen_at     INTEGER NOT NULL,
  last_seen_at      INTEGER NOT NULL,
  first_run_id      TEXT,
  reported          INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_jobs_first_seen ON jobs(first_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_reported   ON jobs(reported, first_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_company    ON jobs(company_matched);

CREATE TABLE IF NOT EXISTS runs (
  run_id            TEXT PRIMARY KEY,
  started_at        INTEGER NOT NULL,
  finished_at       INTEGER,
  status            TEXT,
  pages_scanned     INTEGER DEFAULT 0,
  cards_seen        INTEGER DEFAULT 0,
  details_extracted INTEGER DEFAULT 0,
  new_jobs          INTEGER DEFAULT 0,
  skipped_note      TEXT,
  error             TEXT
);

CREATE TABLE IF NOT EXISTS seen_cards (
  job_id       TEXT PRIMARY KEY,
  last_seen_at INTEGER NOT NULL,
  reason       TEXT,
  company      TEXT,
  title        TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Cache of watchlist company name -> LinkedIn numeric company id, so the
-- expensive resolution pass happens once rather than every run. The status
-- column lets a name that genuinely cannot be resolved be remembered as such
-- instead of being retried forever.
CREATE TABLE IF NOT EXISTS company_ids (
  name        TEXT PRIMARY KEY,
  display     TEXT,
  linkedin_id TEXT,
  slug        TEXT,
  matched_as  TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',
  attempts    INTEGER NOT NULL DEFAULT 0,
  resolved_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_company_ids_status ON company_ids(status);
`;

export class Store {
  constructor() {
    ensureDirs();
    this.db = new DatabaseSync(PATHS.db);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
    this.#migrate();
  }

  /** Additive migrations for databases created by an earlier version. */
  #migrate() {
    const seenCols = this.db.prepare('PRAGMA table_info(seen_cards)').all().map((c) => c.name);
    for (const [name, type] of [['company', 'TEXT'], ['title', 'TEXT']]) {
      if (!seenCols.includes(name)) {
        this.db.exec(`ALTER TABLE seen_cards ADD COLUMN ${name} ${type}`);
      }
    }

    const jobCols = this.db.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name);
    for (const [name, type] of [
      ['logo_url', 'TEXT'], ['is_tech', 'INTEGER'], ['role_source', 'TEXT'],
      // Gemini enrichment. bullets and key_skills hold JSON arrays; they stay NULL
      // until a posting has been enriched, which is what the card falls back on.
      ['bullets', 'TEXT'], ['role_label', 'TEXT'], ['degree_level', 'TEXT'], ['degree_text', 'TEXT'],
      ['key_skills', 'TEXT'], ['stipend_status', 'TEXT'],
    ]) {
      if (!jobCols.includes(name)) {
        this.db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${type}`);
      }
    }
  }

  /**
   * Which ATS board each company uses, if any.
   *
   * Created on demand rather than in SCHEMA so that an existing database picks
   * it up without a migration step — same additive-only rule as everywhere else.
   * A row with provider NULL is a recorded miss, not missing data: it stops the
   * next discovery run re-probing a company that has no public board.
   */
  ensureAtsTable() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS company_ats (
        company     TEXT PRIMARY KEY,
        provider    TEXT,
        token       TEXT,
        job_count   INTEGER DEFAULT 0,
        checked_at  INTEGER NOT NULL,
        last_polled INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_ats_provider ON company_ats(provider);
    `);
  }

  getAts(company) {
    return this.db.prepare('SELECT * FROM company_ats WHERE lower(company) = lower(?)').get(company) ?? null;
  }

  saveAts(company, provider, token, jobCount) {
    this.db.prepare(`
      INSERT INTO company_ats (company, provider, token, job_count, checked_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(company) DO UPDATE SET
        provider = excluded.provider,
        token = excluded.token,
        job_count = excluded.job_count,
        checked_at = excluded.checked_at
    `).run(company, provider, token, jobCount ?? 0, Date.now());
  }

  /** Every company with a board worth polling. */
  atsBoards() {
    return this.db.prepare(
      'SELECT company, provider, token, job_count, last_polled FROM company_ats WHERE provider IS NOT NULL ORDER BY company',
    ).all();
  }

  markAtsPolled(company) {
    this.db.prepare('UPDATE company_ats SET last_polled = ? WHERE lower(company) = lower(?)').run(Date.now(), company);
  }

  atsStats() {
    const total = this.db.prepare('SELECT COUNT(*) n FROM company_ats').get().n;
    const resolved = this.db.prepare('SELECT COUNT(*) n FROM company_ats WHERE provider IS NOT NULL').get().n;
    return { total, resolved };
  }

  /** Postings that still need a Gemini pass — enriched rows are never re-sent. */
  needingEnrichment(limit = 500) {
    return this.db.prepare(`
      SELECT job_id, title, company, description, salary_text AS stipend
      FROM jobs
      WHERE bullets IS NULL AND length(description) > 200
      ORDER BY first_seen_at DESC
      LIMIT ?
    `).all(limit);
  }

  /**
   * Jobs that were stored without their page ever being opened, and so have no
   * description — nothing for `needingEnrichment` to work from, and nothing a
   * later scan will fix, because `hasJob` short-circuits a known job before it
   * is ever re-opened. Without this query such a row is stuck forever: no
   * bullets, no stipend, no duration, published as a bare title.
   *
   * Two conditions matter, and both were wrong before:
   *
   * - `is_tech = 1` alone never matched anything. Every card-only row is written
   *   with is_tech = 0 (see the openNonTechRoles branch in src/index.js), and
   *   with storeNonTechRoles = false those rows are not stored at all — so the
   *   whole pass was a no-op against a live database of 444 jobs. A NULL verdict
   *   is included instead: that row has no description AND no verdict, and the
   *   classification pass later in the same run reads exactly this description
   *   to settle it. Non-tech stays excluded — it can never be published, so
   *   opening it spends a page load on nobody's behalf.
   *
   * - ATS rows must be excluded outright. Their job_id is `ats:provider:token:n`,
   *   which is not a LinkedIn job id; handing one to li.openAndExtract navigates
   *   to a nonexistent posting, burns a page open and logs a failure. An ATS row
   *   missing its description has to be re-polled, not scraped.
   *
   * Restricted to rows still inside the publish window — backfilling a job that
   * has already dropped off the site helps nobody.
   */
  needingDescription(limit = 8, maxAgeDays = 14) {
    return this.db.prepare(`
      SELECT job_id, title, company
      FROM jobs
      WHERE description IS NULL
        AND (is_tech = 1 OR is_tech IS NULL)
        AND job_id NOT LIKE 'ats:%'
        AND first_seen_at > ?
      ORDER BY first_seen_at DESC
      LIMIT ?
    `).all(Date.now() - maxAgeDays * 86_400_000, limit);
  }

  /**
   * Fill in a row that was originally stored from card data alone.
   *
   * COALESCE on every optional column so a backfill can only ever add: if the
   * detail pane does not mention a duration, the card's value stays. The one
   * exception is `description` itself, which is what we came for.
   *
   * Deliberately does NOT touch first_seen_at. That column is the site's sort
   * order and its freshness label, so moving it would push a week-old posting
   * back to the top of the list purely because we got around to reading it.
   */
  saveDescription(jobId, job) {
    this.db.prepare(`
      UPDATE jobs SET
        description      = ?,
        summary          = COALESCE(?, summary),
        duration         = COALESCE(?, duration),
        skills           = COALESCE(?, skills),
        salary_text      = COALESCE(?, salary_text),
        stipend_min      = COALESCE(?, stipend_min),
        stipend_max      = COALESCE(?, stipend_max),
        stipend_currency = COALESCE(?, stipend_currency),
        stipend_period   = COALESCE(?, stipend_period),
        applicants       = COALESCE(?, applicants),
        apply_url        = COALESCE(?, apply_url),
        workplace_type   = COALESCE(?, workplace_type),
        logo_url         = COALESCE(logo_url, ?),
        last_seen_at     = ?
      WHERE job_id = ?
    `).run(
      job.description ?? null,
      job.summary ?? null,
      job.duration ?? null,
      job.skills?.length ? JSON.stringify(job.skills) : null,
      job.salaryText ?? null,
      job.stipend?.min ?? null,
      job.stipend?.max ?? null,
      job.stipend?.currency ?? null,
      job.stipend?.period ?? null,
      job.applicants ?? null,
      job.applyUrl ?? null,
      job.workplaceType ?? null,
      job.logoUrl ?? null,
      Date.now(),
      jobId,
    );
  }

  /**
   * Persist one enrichment result. isTech is only overwritten when the caller
   * actually produced one.
   *
   * `source` records who wrote the row. It is not cosmetic: a verdict from the
   * model and a verdict from a one-off backfill should be distinguishable when
   * you later ask why a job is filed where it is.
   */
  saveEnrichment(jobId, e, source = 'model-enrich') {
    this.db.prepare(`
      UPDATE jobs SET
        bullets = ?, role_label = ?, degree_level = ?, degree_text = ?, key_skills = ?, stipend_status = ?,
        is_tech = COALESCE(?, is_tech),
        -- Only replace the summary when a rewritten one was actually produced.
        -- The column already holds the extractive plain-text summary, which is
        -- what the card falls back to; overwriting it with an empty string when
        -- the model returns nothing, or when the copy check rejects the rewrite,
        -- would leave the page with no prose at all.
        summary = COALESCE(?, summary),
        role_source = CASE WHEN ? IS NULL THEN role_source ELSE ? END
      WHERE job_id = ?
    `).run(
      JSON.stringify(e.bullets ?? []),
      e.roleLabel || null,
      e.degreeLevel || null,
      e.degreeText || null,
      JSON.stringify(e.keySkills ?? []),
      e.stipendStatus || 'unknown',
      typeof e.isTech === 'boolean' ? (e.isTech ? 1 : 0) : null,
      e.summary?.trim() ? e.summary.trim() : null,
      typeof e.isTech === 'boolean' ? 1 : null,
      source,
      jobId,
    );
  }

  close() {
    try { this.db.close(); } catch { /* already closed */ }
  }

  // ---- runs -----------------------------------------------------------------

  startRun(runId) {
    this.db.prepare('INSERT INTO runs (run_id, started_at, status) VALUES (?, ?, ?)')
      .run(runId, Date.now(), 'running');
  }

  finishRun(runId, { status, pagesScanned = 0, cardsSeen = 0, detailsExtracted = 0, newJobs = 0, skippedNote = null, error = null }) {
    this.db.prepare(`
      UPDATE runs SET finished_at = ?, status = ?, pages_scanned = ?, cards_seen = ?,
                      details_extracted = ?, new_jobs = ?, skipped_note = ?, error = ?
      WHERE run_id = ?
    `).run(Date.now(), status, pagesScanned, cardsSeen, detailsExtracted, newJobs, skippedNote, error, runId);
  }

  /**
   * The last run that actually finished its sweep — 'ok' only, never 'partial'.
   *
   * This is the baseline the next lookback window is measured from, and
   * including 'partial' here silently lost postings. A partial run is one that
   * stopped at its time or details limit PART WAY THROUGH the window it was
   * given. Treating it as the new baseline means the next run starts from where
   * that run BEGAN, so everything it never paginated to is never looked at by
   * anything, ever. Twenty-nine of the last two hundred runs ended partial.
   *
   * With this restricted to 'ok', an incomplete sweep leaves the baseline where
   * it was and the next run re-covers the same window. The cost is re-walking
   * pages already seen, which is cheap — hasJob skips them before any page is
   * opened — and filters.maxWindowHours still caps how far back it can stretch.
   */
  lastFullSweep() {
    return this.db.prepare(
      "SELECT * FROM runs WHERE status = 'ok' ORDER BY started_at DESC LIMIT 1",
    ).get();
  }

  recentRuns(limit = 10) {
    return this.db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?').all(limit);
  }

  // ---- settings / cooldown --------------------------------------------------

  setSetting(key, value) {
    this.db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, String(value));
  }

  getSetting(key) {
    return this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
  }

  /**
   * After LinkedIn rate-limits or restricts the session, refuse to run again
   * until this timestamp. Walking straight back into a rate limit on the next
   * scheduled run is how a temporary block becomes a permanent one.
   */
  setCooldown(untilMs, reason) {
    this.setSetting('cooldown_until', untilMs);
    this.setSetting('cooldown_reason', reason);
  }

  /** Returns { until, reason } while a cooldown is active, else null. */
  activeCooldown() {
    const until = Number(this.getSetting('cooldown_until') ?? 0);
    if (!until || until <= Date.now()) return null;
    return { until, reason: this.getSetting('cooldown_reason') ?? 'unspecified' };
  }

  clearCooldown() {
    this.setSetting('cooldown_until', 0);
  }

  // ---- company id cache -----------------------------------------------------

  /** Register every watchlist name so the resolver has a work queue. */
  seedCompanyNames(entries) {
    const stmt = this.db.prepare(`
      INSERT INTO company_ids (name, display, status) VALUES (?, ?, 'pending')
      ON CONFLICT(name) DO NOTHING
    `);
    let added = 0;
    for (const { name, display } of entries) {
      const before = this.db.prepare('SELECT 1 FROM company_ids WHERE name = ?').get(name);
      stmt.run(name, display ?? name);
      if (!before) added++;
    }
    return added;
  }

  recordCompanyId(name, { linkedinId, slug, matchedAs }) {
    this.db.prepare(`
      UPDATE company_ids
      SET linkedin_id = ?, slug = ?, matched_as = ?, status = 'resolved',
          attempts = attempts + 1, resolved_at = ?
      WHERE name = ?
    `).run(linkedinId ?? null, slug ?? null, matchedAs ?? null, Date.now(), name);
  }

  /**
   * Mark a name as unresolvable. Kept distinct from 'pending' so the resolver
   * does not spend every future run retrying the same hopeless lookups; three
   * failures is treated as settled.
   */
  markCompanyUnresolved(name, reason) {
    this.db.prepare(`
      UPDATE company_ids
      SET attempts = attempts + 1,
          matched_as = ?,
          status = CASE WHEN attempts + 1 >= 3 THEN 'unresolved' ELSE 'pending' END
      WHERE name = ?
    `).run(reason ?? null, name);
  }

  pendingCompanyNames(limit = 150) {
    return this.db.prepare(
      "SELECT name, display, attempts FROM company_ids WHERE status = 'pending' ORDER BY attempts ASC, rowid ASC LIMIT ?",
    ).all(limit);
  }

  resolvedCompanyIds() {
    return this.db.prepare(
      "SELECT name, display, linkedin_id FROM company_ids WHERE status = 'resolved' AND linkedin_id IS NOT NULL ORDER BY rowid",
    ).all();
  }

  companyIdStats() {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM company_ids GROUP BY status').all();
    const out = { pending: 0, resolved: 0, unresolved: 0, total: 0 };
    for (const { status, n } of rows) {
      out[status] = n;
      out.total += n;
    }
    return out;
  }

  /**
   * Jobs still lacking a role verdict.
   *
   * Not just this run's: a row stored before the verdict column existed, or one
   * whose classification pass was skipped, must still be labelled or it lands
   * in the wrong tab forever. Classifying by "needs a verdict" rather than "was
   * captured this run" is what keeps the site correct.
   *
   * 'offline-uncertain' rows are re-queried too. Those were published on a
   * guess because the classifier API was unavailable and a posting must not
   * wait on a quota reset. They already have a verdict, so NULL alone would
   * never return them, and the guess would stand forever. Including them here
   * means Gemini reads the description and corrects the record as soon as it
   * can — publish first, get accurate second.
   */
  jobsNeedingRoleVerdict(sinceMs) {
    return this.db.prepare(`
      SELECT job_id, title, company FROM jobs
      WHERE (is_tech IS NULL OR role_source = 'offline-uncertain')
        AND first_seen_at >= ?
      ORDER BY first_seen_at DESC
    `).all(sinceMs);
  }

  /** The stored description, for classifying an ambiguous title. */
  descriptionFor(jobId) {
    return this.db.prepare('SELECT description FROM jobs WHERE job_id = ?').get(jobId)?.description ?? '';
  }

  /** Record a role verdict once the batch classifier has run. */
  setRoleVerdict(jobId, isTech, source) {
    this.db.prepare('UPDATE jobs SET is_tech = ?, role_source = ? WHERE job_id = ?')
      .run(isTech ? 1 : 0, source, jobId);
  }

  // ---- cards ----------------------------------------------------------------

  /** Have we already fully extracted this job in an earlier run? */
  hasJob(jobId) {
    return !!this.db.prepare('SELECT 1 FROM jobs WHERE job_id = ?').get(jobId);
  }

  /**
   * Cheap record of a card we saw but chose not to open (wrong company, wrong
   * title). Lets later runs skip re-evaluating it and gives us honest counts.
   */
  noteSkippedCard(jobId, reason, company = null, title = null) {
    this.db.prepare(`
      INSERT INTO seen_cards (job_id, last_seen_at, reason, company, title)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
    `).run(jobId, Date.now(), reason, company, title);
  }

  /**
   * Titles the role classifier could not decide, plus ones it rejected.
   *
   * These are the evidence for tuning `extraTechTerms` / `extraNonTechTerms`.
   * A software role sitting in the 'role unclear' list is a miss, and this is
   * the only way to notice it.
   */
  skippedByRole(reason = 'role unclear', limit = 60) {
    return this.db.prepare(`
      SELECT title, company, last_seen_at
      FROM seen_cards
      WHERE reason = ? AND title IS NOT NULL AND title != ''
      ORDER BY last_seen_at DESC
      LIMIT ?
    `).all(reason, limit);
  }

  /**
   * Which companies keep turning up and getting skipped.
   *
   * When a run reports "0 new jobs, 97 off-watchlist", this is the answer to
   * the obvious next question — who were those 97? Without it the watchlist is
   * impossible to tune from evidence.
   */
  topSkippedCompanies(limit = 30, sinceMs = 0) {
    return this.db.prepare(`
      SELECT company, COUNT(*) AS n
      FROM seen_cards
      WHERE reason = 'company not on watchlist'
        AND company IS NOT NULL AND company != ''
        AND last_seen_at >= ?
      GROUP BY LOWER(company)
      ORDER BY n DESC, company ASC
      LIMIT ?
    `).all(sinceMs, limit);
  }

  wasSkipped(jobId) {
    return !!this.db.prepare('SELECT 1 FROM seen_cards WHERE job_id = ?').get(jobId);
  }

  touchJob(jobId) {
    this.db.prepare('UPDATE jobs SET last_seen_at = ? WHERE job_id = ?').run(Date.now(), jobId);
  }

  /**
   * Fill in a logo for a job we already hold.
   *
   * An already-known job is skipped without being opened, so upsertJob never
   * runs for it — meaning rows stored before logo capture existed would never
   * acquire one. Their card still carries the URL, so take it from there. Only
   * writes when the column is empty.
   */
  backfillLogo(jobId, logoUrl) {
    if (!logoUrl) return false;
    const changes = this.db.prepare(
      'UPDATE jobs SET logo_url = ? WHERE job_id = ? AND (logo_url IS NULL OR logo_url = \'\')',
    ).run(logoUrl, jobId).changes;
    return changes > 0;
  }

  // ---- jobs -----------------------------------------------------------------

  /** Insert a newly extracted job. Returns true if it was genuinely new. */
  upsertJob(job, runId) {
    const now = Date.now();
    const existing = this.db.prepare('SELECT job_id FROM jobs WHERE job_id = ?').get(job.jobId);

    if (existing) {
      this.db.prepare(`
        UPDATE jobs SET last_seen_at = ?, salary_text = COALESCE(?, salary_text),
                        applicants = COALESCE(?, applicants), apply_url = COALESCE(?, apply_url),
                        logo_url = COALESCE(logo_url, ?)
        WHERE job_id = ?
      `).run(now, job.salaryText ?? null, job.applicants ?? null, job.applyUrl ?? null, job.logoUrl ?? null, job.jobId);
      return false;
    }

    this.db.prepare(`
      INSERT INTO jobs (
        job_id, title, company, company_matched, location, workplace_type,
        posted_text, posted_at, salary_text, stipend_min, stipend_max,
        stipend_currency, stipend_period, applicants, easy_apply, apply_url,
        job_url, duration, skills, description, summary, search_keywords,
        logo_url, is_tech, role_source, first_seen_at, last_seen_at, first_run_id, reported
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)
    `).run(
      job.jobId,
      job.title ?? '(untitled)',
      job.company ?? null,
      job.companyMatched ?? null,
      job.location ?? null,
      job.workplaceType ?? null,
      job.postedText ?? null,
      job.postedAt ?? null,
      job.salaryText ?? null,
      job.stipend?.min ?? null,
      job.stipend?.max ?? null,
      job.stipend?.currency ?? null,
      job.stipend?.period ?? null,
      job.applicants ?? null,
      job.easyApply ? 1 : 0,
      job.applyUrl ?? null,
      job.jobUrl ?? null,
      job.duration ?? null,
      job.skills ? JSON.stringify(job.skills) : null,
      job.description ?? null,
      job.summary ?? null,
      job.searchKeywords ?? null,
      job.logoUrl ?? null,
      job.isTech == null ? null : (job.isTech ? 1 : 0),
      job.roleSource ?? null,
      now,
      now,
      runId,
    );
    return true;
  }

  jobsForRun(runId) {
    return this.db.prepare(
      'SELECT * FROM jobs WHERE first_run_id = ? ORDER BY posted_at DESC NULLS LAST, first_seen_at DESC',
    ).all(runId).map(hydrate);
  }

  unreportedJobs() {
    return this.db.prepare(
      'SELECT * FROM jobs WHERE reported = 0 ORDER BY posted_at DESC NULLS LAST, first_seen_at DESC',
    ).all().map(hydrate);
  }

  markReported(jobIds) {
    const stmt = this.db.prepare('UPDATE jobs SET reported = 1 WHERE job_id = ?');
    for (const id of jobIds) stmt.run(id);
  }

  recentJobs(sinceMs) {
    return this.db.prepare(
      'SELECT * FROM jobs WHERE first_seen_at >= ? ORDER BY first_seen_at DESC',
    ).all(sinceMs).map(hydrate);
  }

  stats() {
    const total = this.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n;
    const companies = this.db.prepare('SELECT COUNT(DISTINCT company_matched) AS n FROM jobs').get().n;
    const skipped = this.db.prepare('SELECT COUNT(*) AS n FROM seen_cards').get().n;
    return { total, companies, skipped };
  }
}

function hydrate(row) {
  return { ...row, skills: row.skills ? JSON.parse(row.skills) : [], easy_apply: !!row.easy_apply };
}
