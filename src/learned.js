/**
 * Vocabulary learned from Gemini.
 *
 * When a title is too generic to judge — "Graduate Trainee", "Apprentice",
 * "Intern" — Gemini reads the description and decides. It also names the single
 * term its decision hinged on, and that term is stored here. Next time a title
 * contains it, the offline classifier answers instantly and no API call happens.
 * So the run gets cheaper and faster the longer it operates.
 *
 * Every learned term is checked before being accepted:
 *   - it must actually appear in the title or description it came from, so the
 *     model cannot invent vocabulary out of nothing
 *   - it must not contradict a built-in term, because a hand-written rule that
 *     has tests behind it outranks a model's guess
 *   - it must be a sane length, to keep single letters and whole sentences out
 *
 * The file lives in the state directory rather than the repo: it is derived
 * data, it changes most runs, and it should never produce git noise or a push
 * conflict. `node bin/show-report.js --learned` prints it.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS, ensureDirs } from './paths.js';
import { log } from './logger.js';

const FILE = join(PATHS.state, 'learned-roles.json');
const MIN_LEN = 3;
const MAX_LEN = 40;

export function loadLearned() {
  if (!existsSync(FILE)) return { version: 1, terms: {} };
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf8'));
    return parsed?.terms ? parsed : { version: 1, terms: {} };
  } catch {
    log.warn('learned-roles.json is unreadable — starting a fresh vocabulary.');
    return { version: 1, terms: {} };
  }
}

function save(store) {
  ensureDirs();
  writeFileSync(FILE, `${JSON.stringify(store, null, 1)}\n`);
}

/** Learned terms, split into the shape classifyRole expects. */
export function learnedVocabulary(store = loadLearned()) {
  const positive = [];
  const negative = [];
  for (const [term, meta] of Object.entries(store.terms)) {
    (meta.isTech ? positive : negative).push(term);
  }
  return { positive, negative };
}

/**
 * Record what Gemini taught us.
 *
 * @param {object} store          from loadLearned()
 * @param {object} lesson         { term, isTech, title, description, company }
 * @param {Set<string>} builtIns  lowercase built-in terms, with their polarity,
 *                                as "term|tech" / "term|other"
 * @returns {'added'|'reinforced'|'rejected'} and why, for logging
 */
export function learn(store, lesson, builtInPolarity, blockedTerms = []) {
  const term = String(lesson.term ?? '').toLowerCase().trim().replace(/\s+/g, ' ');
  if (term.length < MIN_LEN || term.length > MAX_LEN) return { result: 'rejected', why: 'implausible length' };
  if (!/[a-z]/.test(term)) return { result: 'rejected', why: 'no letters' };

  // A term the search is BUILT FROM says nothing about what a role is: every
  // card LinkedIn returns matches one of them by construction. The model
  // proposes them anyway, and the damage is one-sided — once "intern" was
  // stored as non-tech it fired on ~100% of titles, and because only
  // multi-word positives outrank a negative (roles.js), single-word tech
  // signals could not save them. "Flutter Developer Intern" and "DevOps Intern
  // (AWS & GitOps)" were both refused before they were ever opened; 34
  // watchlist matches went that way on 12 Aug alone, and the count had been
  // climbing for a week as more of these terms were learned.
  //
  // Sourced from config.matching.titleMustMatch by the caller so this list and
  // the query cannot drift apart.
  if (blockedTerms.includes(term)) {
    return { result: 'rejected', why: 'a term the search is built from, so every posting contains it' };
  }

  // The term has to come from the text it supposedly explains.
  const haystack = `${lesson.title ?? ''} ${lesson.description ?? ''}`.toLowerCase();
  if (!haystack.includes(term)) return { result: 'rejected', why: 'not present in the posting' };

  // A built-in rule with tests behind it beats a model suggestion.
  const opposite = builtInPolarity.get(term);
  if (opposite !== undefined && opposite !== lesson.isTech) {
    return { result: 'rejected', why: `contradicts the built-in vocabulary` };
  }

  const existing = store.terms[term];
  if (existing) {
    if (existing.isTech !== lesson.isTech) {
      // Gemini has changed its mind about this term. Drop it rather than
      // letting the vocabulary flip-flop between runs.
      delete store.terms[term];
      save(store);
      return { result: 'rejected', why: 'conflicts with what was learned before; removed' };
    }
    existing.n = (existing.n ?? 1) + 1;
    existing.lastSeenAt = Date.now();
    save(store);
    return { result: 'reinforced', why: `seen ${existing.n}x` };
  }

  store.terms[term] = {
    isTech: !!lesson.isTech,
    n: 1,
    learnedAt: Date.now(),
    lastSeenAt: Date.now(),
    from: `${lesson.company ?? '?'} — ${String(lesson.title ?? '').slice(0, 70)}`,
  };
  save(store);
  return { result: 'added', why: 'new term' };
}

export function learnedPath() {
  return FILE;
}
