#!/usr/bin/env node
/**
 * Remove a company — or a single posting — from the site and the watchlist.
 *
 *   node bin/remove-company.js "MedTourEasy"              preview, then confirm
 *   node bin/remove-company.js "MedTourEasy" --yes        no prompt
 *   node bin/remove-company.js "MedTourEasy" --dry-run    show, change nothing
 *   node bin/remove-company.js "Acme" --keep-watchlist    drop its jobs, keep watching
 *   node bin/remove-company.js --job 4446974886           one posting only
 *
 * Why this also writes to the blocklist by default:
 *
 * Deleting the rows and dropping the name from companies.json is not enough on
 * its own. Company matching is fuzzy and alias-aware, so a name can come back
 * through a route that has nothing to do with the watchlist — that is exactly
 * how MedTourEasy reached the site in the first place ("MedTourEasy Navi
 * Mumbai" contains the city Navi Mumbai, which the matcher read as the fintech
 * Navi). The blocklist is checked before every other rule, so it is the only
 * removal that actually holds. Pass --keep-watchlist if you want the company to
 * stay eligible and are only clearing out its current postings.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import { ROOT, PATHS } from '../src/paths.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { publish } from '../src/publish.js';
import { log } from '../src/logger.js';

const ARGS = process.argv.slice(2);
const has = (f) => ARGS.includes(f);
const DRY_RUN = has('--dry-run');
const YES = has('--yes') || has('-y');
const KEEP_WATCHLIST = has('--keep-watchlist');
const NO_PUBLISH = has('--no-publish');

function valueOf(flag) {
  const i = ARGS.indexOf(flag);
  return i >= 0 ? ARGS[i + 1] : null;
}

const JOB_ID = valueOf('--job');
const NAME = ARGS.find((a) => !a.startsWith('--') && a !== JOB_ID) ?? null;

if (!NAME && !JOB_ID) {
  console.error(`
Remove a company or a posting from Internzo.

  node bin/remove-company.js "Exact Company Name"
  node bin/remove-company.js "Exact Company Name" --yes
  node bin/remove-company.js --job <jobId>

Flags:
  --yes, -y          skip the confirmation prompt
  --dry-run          show what would change, write nothing
  --keep-watchlist   remove the postings but keep watching the company
                     (by default the company is blocklisted so it cannot return)
  --no-publish       update the database only; do not regenerate or push the site
`);
  process.exit(1);
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const db = new DatabaseSync(PATHS.db);
const all = (sql, ...a) => db.prepare(sql).all(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);

// ---------------------------------------------------------------------------
// Work out what is about to be removed, and show it before touching anything.
// ---------------------------------------------------------------------------
let jobs = [];
if (JOB_ID) {
  jobs = all('SELECT job_id, title, company, company_matched FROM jobs WHERE job_id = ?', String(JOB_ID));
  if (!jobs.length) {
    console.error(`No posting with id ${JOB_ID} is in the database.`);
    process.exit(1);
  }
} else {
  const target = norm(NAME);
  jobs = all('SELECT job_id, title, company, company_matched FROM jobs')
    .filter((j) => norm(j.company) === target || norm(j.company_matched) === target);

  if (!jobs.length) {
    // An exact-name tool that silently does nothing on a near miss is worse
    // than one that fails, so offer what it did find.
    const near = [...new Set(all('SELECT DISTINCT company FROM jobs WHERE company IS NOT NULL')
      .map((r) => r.company)
      .filter((c) => norm(c).includes(target) || target.includes(norm(c))))].slice(0, 10);
    console.error(`No postings stored under exactly "${NAME}".`);
    if (near.length) {
      console.error('\nDid you mean one of these?');
      for (const c of near) console.error(`   ${c}`);
    }
    if (!KEEP_WATCHLIST) {
      console.error('\n(The watchlist and blocklist are untouched. Re-run with an exact name above.)');
    }
    process.exit(1);
  }
}

// Watchlist entries that would be dropped.
const companiesPath = join(ROOT, 'companies.json');
const configPath = join(ROOT, 'config.json');
const companiesFile = JSON.parse(readFileSync(companiesPath, 'utf8'));
const configFile = JSON.parse(readFileSync(configPath, 'utf8'));

const removalName = JOB_ID ? null : NAME;
const watchlistHits = [];
if (removalName && !KEEP_WATCHLIST) {
  for (const [group, entries] of Object.entries(companiesFile)) {
    if (group === '_note' || !Array.isArray(entries)) continue;
    for (const e of entries) {
      const n = typeof e === 'string' ? e : e?.name;
      if (norm(n) === norm(removalName)) watchlistHits.push({ where: `companies.json → ${group}`, name: n });
    }
  }
  for (const e of configFile.companies ?? []) {
    const n = typeof e === 'string' ? e : e?.name;
    if (norm(n) === norm(removalName)) watchlistHits.push({ where: 'config.json → companies', name: n });
  }
}

const alreadyBlocked = (configFile.matching?.blocklist ?? []).some((b) => norm(b) === norm(removalName));

console.log('');
console.log(JOB_ID ? `Removing one posting (${JOB_ID}):` : `Removing "${NAME}":`);
console.log('');
console.log(`  ${jobs.length} posting${jobs.length === 1 ? '' : 's'} from the database and the site`);
for (const j of jobs.slice(0, 12)) console.log(`     · ${j.company ?? '?'} — ${j.title}`);
if (jobs.length > 12) console.log(`     · …and ${jobs.length - 12} more`);

if (removalName && !KEEP_WATCHLIST) {
  console.log('');
  if (watchlistHits.length) {
    for (const h of watchlistHits) console.log(`  watchlist entry removed: ${h.name}  (${h.where})`);
  } else {
    console.log('  watchlist: no exact entry found (it may have matched by alias or fuzzily)');
  }
  console.log(alreadyBlocked
    ? '  blocklist: already listed'
    : `  blocklist: "${NAME}" added, so it cannot come back through an alias or a fuzzy match`);
} else if (KEEP_WATCHLIST) {
  console.log('');
  console.log('  watchlist and blocklist: unchanged (--keep-watchlist)');
}
console.log('');

if (DRY_RUN) {
  console.log('--dry-run: nothing was changed.');
  process.exit(0);
}

if (!YES) {
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = (await rl.question('Go ahead? [y/N] ')).trim().toLowerCase();
  rl.close();
  if (answer !== 'y' && answer !== 'yes') {
    console.log('Cancelled. Nothing was changed.');
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// Apply.
// ---------------------------------------------------------------------------
const ids = jobs.map((j) => j.job_id);
const marks = ids.map(() => '?').join(',');

run(`DELETE FROM jobs WHERE job_id IN (${marks})`, ...ids);
// seen_cards would otherwise make a future run skip re-evaluating these ids,
// which is wrong if the company is ever un-blocked.
run(`DELETE FROM seen_cards WHERE job_id IN (${marks})`, ...ids);
console.log(`Deleted ${ids.length} posting${ids.length === 1 ? '' : 's'}.`);

if (removalName && !KEEP_WATCHLIST) {
  let changed = false;

  for (const [group, entries] of Object.entries(companiesFile)) {
    if (group === '_note' || !Array.isArray(entries)) continue;
    const before = entries.length;
    companiesFile[group] = entries.filter((e) => norm(typeof e === 'string' ? e : e?.name) !== norm(removalName));
    if (companiesFile[group].length !== before) changed = true;
  }
  if (changed) {
    writeFileSync(companiesPath, `${JSON.stringify(companiesFile, null, 2)}\n`);
    console.log('Removed from companies.json.');
  }

  const beforeCfg = (configFile.companies ?? []).length;
  configFile.companies = (configFile.companies ?? [])
    .filter((e) => norm(typeof e === 'string' ? e : e?.name) !== norm(removalName));

  configFile.matching ??= {};
  configFile.matching.blocklist ??= [];
  if (!alreadyBlocked) configFile.matching.blocklist.push(NAME);

  if (configFile.companies.length !== beforeCfg || !alreadyBlocked) {
    writeFileSync(configPath, `${JSON.stringify(configFile, null, 2)}\n`);
    console.log(alreadyBlocked ? 'Updated config.json.' : `Added "${NAME}" to the blocklist in config.json.`);
  }

  // company_ids is only a lookup cache; a stale row would send a future
  // company-mode search at an employer we just removed.
  try {
    run('DELETE FROM company_ids WHERE lower(name) = lower(?)', NAME);
  } catch { /* table shape differs; the cache is not load-bearing */ }
}

db.close();

// ---------------------------------------------------------------------------
// Regenerate the site so the posting actually disappears. publish() removes the
// stale job and company pages as part of writing the new set.
// ---------------------------------------------------------------------------
if (NO_PUBLISH) {
  console.log('\n--no-publish: the database is updated, but the site still shows the old data.');
  console.log('Run a scan, or `node -e "..."` publish, when you want it live.');
} else {
  console.log('\nRegenerating the site…');
  const cfg = loadConfig();
  const store = new Store();
  await publish(store, cfg, 0);
  console.log(cfg.publish?.autoPush === false
    ? 'Done. autoPush is off, so push when ready.'
    : 'Done — committed and pushed, so it is off the live site.');
}
