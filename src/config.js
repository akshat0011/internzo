import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS, ROOT } from './paths.js';

/** Strip the `_comment` / `_*_note` documentation keys before use. */
function stripNotes(value) {
  if (Array.isArray(value)) return value.map(stripNotes);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !k.startsWith('_'))
        .map(([k, v]) => [k, stripNotes(v)]),
    );
  }
  return value;
}

const DEFAULTS = {
  companies: [],
  defaultLocation: '',
  searches: [{ keywords: 'software engineer intern', location: '' }],
  filters: { postedWithinHours: 24, sortBy: 'recent', jobTypes: [] },
  matching: { requireCompanyMatch: true, titleMustMatch: [] },
  pacing: {
    betweenCards: [4000, 9000],
    betweenPages: [8000, 16000],
    betweenSearches: [20000, 40000],
    scrollStep: [500, 1400],
    afterNavigation: [3000, 6000],
    warmupOnFeed: [6000, 12000],
    longBreakEvery: 12,
    longBreak: [45000, 90000],
  },
  limits: { maxRuntimeMinutes: 90, maxPagesPerSearch: 40, maxDetailsPerRun: 100 },
  notifications: { onCaptcha: true, onNewJobs: true, onError: true, openReportWhenDone: true },
  browser: {
    headed: true,
    windowSize: [1512, 950],
    windowPosition: [40, 40],
    returnFocus: true,
    disableBraveShields: true,
  },
  safety: { cooldownHoursAfterRateLimit: 24, pauseOnChallenge: true },
  summarizer: { mode: 'offline', model: 'claude-haiku-4-5-20251001' },
};

function deepMerge(base, override) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Normalise a company name for comparison: lowercase, drop legal suffixes and
 * punctuation, collapse whitespace. "Razorpay Software Pvt. Ltd." -> "razorpay".
 */
export function normaliseCompany(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[‘’“”]/g, '')
    .replace(/\b(inc|llc|ltd|limited|pvt|private|plc|gmbh|corp|corporation|co|company|technologies|technology|labs|india|group|holdings|solutions|services|systems|software)\b/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Read the grouped company file and flatten it. Groups exist only so the list
 * stays navigable by hand; the tool treats it as one flat watchlist.
 */
function loadCompanyFile(fileName) {
  const path = join(ROOT, fileName);
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Could not read ${fileName} — ${err.message}`);
  }
  const out = [];
  for (const [group, entries] of Object.entries(raw)) {
    if (group.startsWith('_') || !Array.isArray(entries)) continue;
    out.push(...entries);
  }
  return out;
}

export function loadConfig() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(PATHS.config, 'utf8'));
  } catch (err) {
    throw new Error(`Could not read config.json — ${err.message}`);
  }

  const cfg = deepMerge(DEFAULTS, stripNotes(raw));

  if (cfg.companiesFile) {
    cfg.companies = [...loadCompanyFile(cfg.companiesFile), ...(cfg.companies ?? [])];
  }

  // Flatten into normalised match terms, remembering which canonical display
  // name each alias belongs to. Duplicate terms are dropped — a company can
  // legitimately appear in two groups (Ola is both consumer and deeptech).
  cfg.watchlist = [];
  const seenTerms = new Set();
  const seenCompanies = new Set();
  for (const entry of cfg.companies) {
    const company = typeof entry === 'string' ? { name: entry } : entry;
    if (!company?.name) continue;
    seenCompanies.add(company.name.toLowerCase());
    const names = [company.name, ...(company.aliases || [])].filter(Boolean);
    for (const n of names) {
      const norm = normaliseCompany(n);
      if (norm && !seenTerms.has(norm)) {
        seenTerms.add(norm);
        cfg.watchlist.push({ display: company.name, term: norm });
      }
    }
  }
  cfg.uniqueCompanyCount = seenCompanies.size;

  // A search may be written as a bare keyword string, which picks up
  // defaultLocation — 50 entries are far more readable that way.
  cfg.searches = (cfg.searches ?? []).map((entry) =>
    typeof entry === 'string'
      ? { keywords: entry, location: cfg.defaultLocation ?? '' }
      : { ...entry, location: entry.location ?? cfg.defaultLocation ?? '' },
  );

  cfg.titleTerms = (cfg.matching.titleMustMatch || []).map((t) => t.toLowerCase());

  // Module-level so matchCompany can consult it without every caller threading it
  // through — publish.js and the scrape filter both go through matchCompany, so
  // setting it once here blocks an employer on both paths.
  setCompanyBlocklist(cfg.matching.blocklist ?? []);

  validate(cfg);
  return cfg;
}

function validate(cfg) {
  const problems = [];

  if (!Array.isArray(cfg.searches) || cfg.searches.length === 0) {
    problems.push('`searches` must contain at least one { keywords, location } entry.');
  }
  if (cfg.matching.requireCompanyMatch && cfg.watchlist.length === 0) {
    problems.push('`matching.requireCompanyMatch` is true but `companies` is empty — nothing could ever match. Add companies, or set requireCompanyMatch to false.');
  }
  if (cfg.browser.headed === false) {
    problems.push('browser.headed must be true — headless browsers are trivially detectable and you could not solve a CAPTCHA in a window you cannot see.');
  }
  for (const key of ['betweenCards', 'betweenPages', 'betweenSearches', 'scrollStep', 'afterNavigation', 'longBreak', 'warmupOnFeed']) {
    const pair = cfg.pacing[key];
    if (!Array.isArray(pair) || pair.length !== 2 || pair[0] > pair[1]) {
      problems.push(`pacing.${key} must be a [min, max] pair with min <= max.`);
    }
  }
  if (cfg.pacing.betweenCards[0] < 1500) {
    problems.push('pacing.betweenCards minimum is below 1.5s — that is fast enough to look automated. Raise it.');
  }
  if (cfg.summarizer.mode === 'claude' && !process.env.ANTHROPIC_API_KEY) {
    problems.push('summarizer.mode is "claude" but ANTHROPIC_API_KEY is not set in the environment.');
  }

  if (problems.length) {
    throw new Error(`config.json problems:\n  - ${problems.join('\n  - ')}`);
  }
}

const boundaryCache = new Map();

/**
 * Whole-word containment. Plain substring matching is not safe here: "ola" is
 * inside "solar", "ibm" is inside "acibmed", "hcl" is inside "hcltech" (fine)
 * but also inside unrelated tokens. Requiring word boundaries keeps
 * "Ola Electric" matching while "Solar Industries" does not.
 */
function containsWord(haystack, needle) {
  if (!haystack || !needle || needle.length < 2) return false;
  let re = boundaryCache.get(needle);
  if (!re) {
    re = new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    boundaryCache.set(needle, re);
  }
  return re.test(haystack);
}

/**
 * Does this company name match the watchlist?
 *
 * Exact normalised equality first, then whole-word containment in either
 * direction, so "Stripe" hits "Stripe Payments India" and "JPMorgan Chase"
 * hits a card that just says "JPMorgan". Returns the canonical display name,
 * or null.
 */
/**
 * Employers never to publish, whatever the watchlist says.
 *
 * Set by loadConfig from matching.blocklist. This is the last word: a blocked
 * employer is dropped before any watchlist term is considered, so a bad match
 * cannot resurrect it. Matching is on the normalised name and is a containment
 * test, so one entry covers "MedTourEasy", "MedTourEasy Navi Mumbai" and
 * "MedTourEasy Pvt Ltd" without needing all three spelled out.
 */
let blocklist = [];

export function setCompanyBlocklist(names) {
  blocklist = (names ?? [])
    .map((n) => normaliseCompany(n))
    .filter(Boolean);
}

/** Is this employer on the blocklist? Exported so callers can report it. */
export function isBlockedCompany(companyName) {
  const norm = normaliseCompany(companyName);
  if (!norm) return false;
  return blocklist.some((b) => norm === b || norm.includes(b));
}

export function matchCompany(companyName, watchlist) {
  const norm = normaliseCompany(companyName);
  if (!norm) return null;

  // Before anything else. A blocked employer must not be reachable through an
  // exact hit, a fuzzy hit, or an alias.
  if (isBlockedCompany(companyName)) return null;

  for (const { display, term } of watchlist) {
    if (norm === term) return display;
  }
  for (const { display, term } of watchlist) {
    // Single-word terms under 4 characters are too collision-prone to match
    // as a substring of a longer name; they must match exactly (handled above).
    if (term.length < 4 && !term.includes(' ')) continue;
    if (containsWord(norm, term) || containsWord(term, norm)) return display;
  }
  return null;
}

/**
 * Does this job title look like an internship, per config?
 *
 * Bounded with a small suffix allowance, so "intern" matches "Intern",
 * "Interns" and "Internship" but not "International Sales Manager" — a plain
 * substring test made that mistake.
 *
 * The bound is "not a letter or digit" rather than \b, because \w counts the
 * underscore as a word character, so \b never fires between "n" and "_".
 * Qualcomm posts as "Interim Intern_OneIT" and every one of those was dropped
 * as not-an-internship — the company was on the watchlist the whole time.
 */
const titleRegexCache = new Map();

function titleRegex(term) {
  let re = titleRegexCache.get(term);
  if (!re) {
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(`(?<![a-z0-9])${esc}(?:s|es|ship|ships)?(?![a-z0-9])`, 'i');
    titleRegexCache.set(term, re);
  }
  return re;
}

export function matchTitle(title, titleTerms) {
  if (!titleTerms?.length) return true;
  const t = String(title || '');
  return titleTerms.some((term) => titleRegex(term).test(t));
}

/**
 * How many hours back a run should look.
 *
 * Derived from the gap since the last successful run rather than fixed. With
 * hourly runs a fixed 30-hour window means re-paginating a day of postings
 * every time to find the newest hour; a fixed 3-hour one loses everything
 * posted while the lid was shut. Two hours of slack keeps a posting sitting
 * right on the boundary from slipping through.
 *
 * @param {number|null} lastRunStartedAt epoch ms, or null if there is none
 * @param {object} filters config.filters
 * @param {number} now epoch ms
 */
export function resolveWindowHours(lastRunStartedAt, filters, now = Date.now()) {
  const min = filters.minWindowHours ?? 3;
  const max = filters.maxWindowHours ?? 36;

  if (!filters.adaptiveWindow) return filters.postedWithinHours ?? 24;
  if (!lastRunStartedAt) return max;

  const gapHours = (now - lastRunStartedAt) / 3_600_000;
  // A clock skew or a future timestamp must not produce a negative window.
  if (!Number.isFinite(gapHours) || gapHours < 0) return max;

  return Math.round(Math.min(max, Math.max(min, gapHours + 2)));
}
