/**
 * Role classification via Gemini, with the offline classifier underneath.
 *
 * Two design points worth knowing:
 *
 * 1. Every job is given a verdict by the offline classifier FIRST, so a job
 *    always has one. Gemini then refines the batch. If the key is missing, the
 *    quota is spent, the network is down, or the response is malformed, the
 *    offline verdict simply stands — there is no path where a job ends up
 *    unclassified because an API was unavailable.
 *
 * 2. Titles are sent as ONE batched call rather than one call per job. On a
 *    free tier the per-day request count is the scarce resource, and a run with
 *    forty candidates should cost one request, not forty.
 */
import { log } from './logger.js';
import { classifyRole } from './roles.js';
import { normaliseDegree } from './extract.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const TIMEOUT_MS = 30_000;
const MAX_TITLES_PER_CALL = 60;

/**
 * Every call here is schema-constrained labelling, not reasoning, and the 2.5
 * models spend their reply budget on thinking before they ever emit the JSON.
 * Measured on a batch of six postings: thinking on returned 1533 thought tokens
 * and zero parseable items; thinking off returned all six. Raising
 * maxOutputTokens did not help, so this is not truncation — the structured reply
 * simply does not survive the thinking pass. Off is also faster and cheaper.
 */
const NO_THINKING = { thinkingBudget: 0 };

/**
 * A 429 from Gemini means one of two very different things, and treating them the
 * same is why enrichment silently stopped working.
 *
 * Requests-per-MINUTE is a speed bump: wait a few seconds and the next call
 * succeeds. Requests-per-DAY is a wall: nothing will work until midnight Pacific.
 * A run fires several calls within a second or two — classify by title, classify
 * the ambiguous ones, then enrich — which trips the per-minute limit easily. The
 * old code reported every 429 as "daily free quota exhausted" and gave up for the
 * whole run, so a two-second wait turned into a day of unenriched jobs.
 *
 * Google puts the answer in the error body: a QuotaFailure violation naming
 * PerDay or PerMinute, and a RetryInfo with how long to wait.
 */
function read429(bodyText) {
  try {
    const err = JSON.parse(bodyText)?.error ?? {};
    const details = err.details ?? [];
    const quota = details.find((d) => String(d['@type'] ?? '').includes('QuotaFailure'));
    const retry = details.find((d) => String(d['@type'] ?? '').includes('RetryInfo'));
    const ids = (quota?.violations ?? []).map((v) => `${v.quotaId ?? ''} ${v.quotaMetric ?? ''}`);
    const seconds = Number(String(retry?.retryDelay ?? '').replace(/[^0-9.]/g, ''));
    return {
      perDay: ids.some((id) => /per\s*day/i.test(id.replace(/([a-z])([A-Z])/g, '$1 $2'))),
      retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : null,
      message: String(err.message ?? '').slice(0, 160),
    };
  } catch {
    return { perDay: false, retryAfterMs: null, message: '' };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * POST to Gemini, retrying a per-minute rate limit rather than abandoning the run.
 *
 * @returns {Promise<{ok: true, payload: object} | {ok: false, reason: string, fatal: boolean}>}
 *          fatal means no later call in this run will succeed either — a spent daily
 *          quota or a rejected key — so the caller should stop rather than keep trying.
 */
async function geminiPost(model, body, { attempts = 3 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${API_BASE}/${model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (res.ok) return { ok: true, payload: await res.json() };

      if (res.status === 429) {
        const { perDay, retryAfterMs, message } = read429(await res.text());
        if (perDay) return { ok: false, reason: 'daily free quota exhausted', fatal: true };
        if (attempt === attempts) {
          return { ok: false, reason: `rate limited after ${attempts} attempts${message ? ` — ${message}` : ''}`, fatal: false };
        }
        // Google's own retryDelay when it gives one, otherwise 5s, 10s, 20s.
        const waitMs = retryAfterMs ?? 5_000 * 2 ** (attempt - 1);
        log.info(`Gemini rate limit — waiting ${Math.round(waitMs / 1000)}s and retrying (${attempt}/${attempts - 1}).`);
        clearTimeout(timer);
        await sleep(waitMs);
        continue;
      }

      if (res.status === 403) return { ok: false, reason: 'API key rejected', fatal: true };
      if (res.status === 400) {
        const text = (await res.text()).replace(/\s+/g, ' ').slice(0, 200);

        // thinkingConfig is not universally supported, and the failure is
        // opaque: the whole request is refused with "Request contains an
        // invalid argument", naming nothing. The gemini-3 models reject
        // thinkingBudget: 0 outright, so moving off the 20-per-day 2.5-flash
        // quota traded one silent enrichment failure for another. It is an
        // optimisation, not a requirement — requests are the scarce resource on
        // the free tier, not thought tokens — so drop it and send the call
        // again rather than losing the batch. Retried once, on the first
        // attempt only, so a genuinely malformed request still fails fast.
        if (body?.generationConfig?.thinkingConfig && attempt === 1) {
          log.debug('Gemini rejected thinkingConfig — retrying without it.');
          clearTimeout(timer);
          const { thinkingConfig, ...keep } = body.generationConfig;
          return geminiPost(model, { ...body, generationConfig: keep }, { attempts });
        }
        return { ok: false, reason: `HTTP 400: ${text}`, fatal: true };
      }
      // 500s are usually transient on Google's side; worth one more go.
      if (res.status >= 500 && attempt < attempts) {
        clearTimeout(timer);
        await sleep(2_000 * attempt);
        continue;
      }
      return { ok: false, reason: `HTTP ${res.status}`, fatal: false };
    } catch (err) {
      const why = err.name === 'AbortError' ? 'timed out' : err.message.split('\n')[0];
      if (attempt < attempts) {
        clearTimeout(timer);
        await sleep(2_000 * attempt);
        continue;
      }
      return { ok: false, reason: why, fatal: false };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, reason: 'exhausted attempts', fatal: false };
}

const DESC_SYSTEM = `You label internship postings for a software-internship board, using the description because the title alone is too generic to judge.

Decide whether the ACTUAL WORK is software or technology — writing code, building systems, working with data, designing software products, or engineering hardware/silicon.

Count as tech: software engineering of any kind, data science and analytics, machine learning and AI, infrastructure and DevOps and cloud, QA and test automation, cybersecurity, chip and hardware design, quantitative and algorithmic trading, and product management or UI/UX for software products.

Count as NOT tech: sales, business development, marketing, content, HR, recruiting, finance, accounting, legal, admin, operations, customer support, teaching, social work, media design and video, and non-software engineering such as mechanical, civil, electrical power, chemical or industrial plant work.

Judge by the primary work, not by the employer being a technology company. A finance internship at a software firm is still finance.

For each posting also return keyTerm: the single most decisive phrase, two to four words, copied EXACTLY as it appears in the title or description, that a future classifier could match on to reach the same conclusion. Prefer a phrase naming the discipline ("mechanical design", "backend services", "financial reporting") over a generic one ("good communication"). If nothing is decisive, return an empty keyTerm.`;

const DESC_SCHEMA = {
  type: 'OBJECT',
  properties: {
    verdicts: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id: { type: 'INTEGER' },
          isTech: { type: 'BOOLEAN' },
          keyTerm: { type: 'STRING' },
          reason: { type: 'STRING' },
        },
        required: ['id', 'isTech', 'keyTerm'],
      },
    },
  },
  required: ['verdicts'],
};

const SYSTEM = `You label job titles for a software-internship board.

For each title, decide whether it is a SOFTWARE or TECHNOLOGY role — something a computer-science or engineering student would take to write code, build systems, work with data, or design software products.

Count as tech (isTech = true):
- software engineering of any kind: backend, frontend, full stack, mobile, embedded, firmware, games
- data science, data engineering, analytics, machine learning, AI, computer vision, NLP
- infrastructure: DevOps, CloudOps, SRE, platform, cloud, networking, databases
- QA, SDET, test automation, cybersecurity
- hardware/chip design: VLSI, RTL, verification, silicon
- quantitative finance and algorithmic trading (these are programming-heavy)
- product management and UI/UX/product design for software products
- broad technical graduate schemes where the work is clearly engineering

Count as NOT tech (isTech = false):
- sales, business development, marketing, content, social media, SEO
- HR, recruiting, finance, accounting, legal, admin, operations, customer support
- teaching, counselling, social work
- graphic design, video, photography, animation for media
- non-software engineering: mechanical, civil, electrical power, chemical, industrial
- lab science, clinical, pharma

If a title mixes both, judge by the primary job. "Software Sales" is sales. "Technical Recruiter" is recruiting.
When genuinely ambiguous, prefer isTech = false.

Return one entry per input, using the same id you were given.`;

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    verdicts: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id: { type: 'INTEGER' },
          isTech: { type: 'BOOLEAN' },
          reason: { type: 'STRING' },
        },
        required: ['id', 'isTech'],
      },
    },
  },
  required: ['verdicts'],
};

/** Is a Gemini key configured at all? */
export function geminiAvailable() {
  return !!process.env.GEMINI_API_KEY;
}

async function classifyBatch(titles, model) {
  const numbered = titles.map((t, i) => `${i}. ${t.title}${t.company ? ` — ${t.company}` : ''}`).join('\n');

  try {
    const res = await geminiPost(model, {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: `Label these ${titles.length} job titles:\n\n${numbered}` }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 4_000,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
        thinkingConfig: NO_THINKING,
      },
    });

    if (!res.ok) {
      log.warn(`Gemini unavailable (${res.reason}) — using the offline classifier for this run.`);
      return null;
    }

    const payload = res.payload;
    if (payload.promptFeedback?.blockReason) {
      log.warn('Gemini refused the batch (content filter) — using the offline classifier.');
      return null;
    }

    const raw = (payload.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text).filter(Boolean).join('').trim();
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.verdicts)) return null;

    const byId = new Map();
    for (const v of parsed.verdicts) {
      if (Number.isInteger(v?.id) && typeof v.isTech === 'boolean') byId.set(v.id, v);
    }
    return byId;
  } catch (err) {
    // geminiPost handles transport failures; anything here is a malformed reply.
    log.warn(`Gemini reply unusable (${err.message.split('\n')[0]}) — using the offline classifier.`);
    return null;
  }
}

/**
 * Classify a list of { title, company } and return a verdict per item, in the
 * same order.
 *
 * @returns {Promise<Array<{isTech: boolean, source: 'gemini'|'offline', reason: string|null}>>}
 */
export async function classifyRoles(items, cfg) {
  // Offline first, so every item has a verdict no matter what happens next.
  const verdicts = items.map(({ title }) => {
    const r = classifyRole(title, {
      extraPositive: cfg.matching?.extraTechTerms ?? [],
      extraNegative: cfg.matching?.extraNonTechTerms ?? [],
    });
    return {
      // An undecidable title counts as non-tech: it still reaches the site, just
      // in the other section, so nothing is lost by being cautious here.
      isTech: r.verdict === 'tech',
      source: 'offline',
      reason: r.matched ? `matched "${r.matched}"` : 'no vocabulary match',
    };
  });

  if (!items.length) return verdicts;

  if (cfg.roleClassifier?.useGemini === false) return verdicts;
  if (!geminiAvailable()) {
    log.info('No GEMINI_API_KEY set — classifying roles with the offline vocabulary.');
    return verdicts;
  }

  const model = process.env.GEMINI_MODEL || cfg.roleClassifier?.model || 'gemini-2.5-flash';
  let refined = 0;
  let disagreed = 0;

  for (let start = 0; start < items.length; start += MAX_TITLES_PER_CALL) {
    const slice = items.slice(start, start + MAX_TITLES_PER_CALL);
    const byId = await classifyBatch(slice, model);
    if (!byId) break; // offline verdicts stand for the rest of the run

    for (let i = 0; i < slice.length; i++) {
      const v = byId.get(i);
      if (!v) continue;
      const target = verdicts[start + i];
      if (target.isTech !== v.isTech) disagreed++;
      target.isTech = v.isTech;
      target.source = 'gemini';
      target.reason = v.reason ?? null;
      refined++;
    }
  }

  if (refined) {
    log.ok(`Gemini classified ${refined}/${items.length} roles (${disagreed} differed from the offline guess).`);
  }
  return verdicts;
}

/**
 * Classify ambiguous postings from their descriptions, and report the term each
 * decision hinged on so the offline vocabulary can absorb it.
 *
 * Only called for titles the vocabulary could not settle — see needsDescription
 * in roles.js. That is what keeps this to a handful of postings per run rather
 * than every one.
 *
 * @returns {Promise<Map<number, {isTech: boolean, keyTerm: string, reason: string}>|null>}
 *          null when Gemini is unavailable, so the caller keeps its offline verdicts
 */
export async function classifyFromDescriptions(items, cfg) {
  if (!items.length) return new Map();
  if (cfg.roleClassifier?.useGeminiForAmbiguous === false) return null;
  if (!geminiAvailable()) {
    log.info(`No GEMINI_API_KEY — ${items.length} ambiguous role(s) keep their offline verdict.`);
    return null;
  }

  const model = process.env.GEMINI_MODEL || cfg.roleClassifier?.model || 'gemini-2.5-flash';
  const out = new Map();

  // Descriptions are long, so batch far more conservatively than titles.
  const PER_CALL = 8;
  for (let start = 0; start < items.length; start += PER_CALL) {
    const slice = items.slice(start, start + PER_CALL);
    const body = slice.map((it, i) => [
      `### ${i}`,
      `Title: ${it.title}`,
      `Company: ${it.company ?? 'unknown'}`,
      `Description: ${String(it.description ?? '').slice(0, 3500) || '(none captured)'}`,
    ].join('\n')).join('\n\n');

    try {
      const res = await geminiPost(model, {
        systemInstruction: { parts: [{ text: DESC_SYSTEM }] },
        contents: [{ role: 'user', parts: [{ text: `Label these ${slice.length} postings:\n\n${body}` }] }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 3_000,
          responseMimeType: 'application/json',
          responseSchema: DESC_SCHEMA,
          thinkingConfig: NO_THINKING,
        },
      });

      if (!res.ok) {
        log.warn(`Gemini unavailable (${res.reason}) — remaining ambiguous roles keep their offline verdict.`);
        return out.size ? out : null;
      }

      const payload = res.payload;
      if (payload.promptFeedback?.blockReason) {
        log.warn('Gemini refused a batch (content filter) — offline verdicts stand for it.');
        continue;
      }

      const raw = (payload.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text).filter(Boolean).join('').trim();
      const parsed = JSON.parse(raw);
      for (const v of parsed.verdicts ?? []) {
        if (!Number.isInteger(v?.id) || typeof v.isTech !== 'boolean') continue;
        if (v.id < 0 || v.id >= slice.length) continue;
        out.set(start + v.id, { isTech: v.isTech, keyTerm: v.keyTerm ?? '', reason: v.reason ?? '' });
      }
    } catch (err) {
      log.warn(`Gemini reply unusable (${err.message.split('\n')[0]}) — offline verdicts stand for the rest.`);
      return out.size ? out : null;
    }
  }
  return out;
}

/* ---------------- per-job enrichment ---------------- */

const ENRICH_SYSTEM = `You turn an internship posting into a compact, scannable card for a student deciding whether to apply.

Return, for each posting:

bullets — 2 to 4 fragments, each at most 90 characters, no trailing period. Lead with what the intern actually DOES day to day, then the stack or tools, then anything concrete that affects the decision (team, product, duration). Write plainly, as a person would to a friend. Never open with the company boilerplate ("About X, founded in..."), never use marketing language ("exciting opportunity", "fast-paced environment", "dynamic team"), and never repeat the job title back.

Never write a bullet ABOUT the posting itself — no "the posting is vague", "no duties listed", "details not specified". The reader wants the job, not a review of the advert. If the posting is too thin to yield two real bullets, return an empty bullets array and the card will fall back to plain text.

roleLabel — 2 to 4 words naming what this job ACTUALLY is, in plain terms: "Backend engineering", "Credit risk modelling", "Payroll operations", "Product marketing". Many postings are titled only "Intern", "Apprentice" or "Trainee", which tells a reader nothing and makes ten different jobs at the same company look identical. This is the field that tells them apart. Name the work, never the seniority or the company. Do not repeat the job title back. Empty string only if the posting genuinely does not say what the work is.

degreeLevel — who is eligible, judged ONLY from the text:
  "UG" for bachelor's-level study (B.Tech, B.E., B.Sc, BCA)
  "PG" for master's-level and above (M.Tech, M.E., M.Sc, MCA, MBA, PhD)
  "UG/PG" when either is explicitly acceptable
  "Pursuing" when it requires a currently-enrolled student but names no level
  "none" when the posting genuinely does not say

degreeText — the degree NAME ONLY, never the field of study. Write "B.Tech", not "B.Tech Computer Science". Write "MBA", not "MBA in Finance". Write "B.E/B.Tech" when the posting accepts either. Use the short Indian forms: B.Tech, M.Tech, B.E, M.E, B.Sc, M.Sc, BCA, MCA, BBA, MBA, B.Com, PhD, Diploma, CA. At most two, separated by "/". The reader already knows what field they are searching in; the qualification is what decides whether they are eligible. Return an empty string for anything that is a status rather than a qualification ("recent graduates", "freshers", "any discipline") — degreeLevel already carries that.

keySkills — 2 to 5 concrete, specific skills or technologies named in the posting: languages, frameworks, tools, named methods. Lowercase. Never soft skills ("communication", "teamwork", "attention to detail"), never vague nouns ("technology", "software"). Empty array if the posting names none.

stipendStatus — "paid" only if the posting states a stipend, salary or amount; "unpaid" only if it explicitly says unpaid or that no stipend is provided; otherwise "unknown".

isTech — whether the ACTUAL WORK is software or technology: writing code, building systems, working with data, designing software products, or engineering silicon. Product management and UI/UX for software products count as tech. Sales, marketing, HR, finance, legal, admin, operations, support, content, media design, and non-software engineering (mechanical, civil, electrical power, chemical, industrial) do not. Judge by the primary work, not by the employer being a technology company.

The single hard rule: state only what the posting supports. Never infer a qualification, a skill or a stipend that is not there. An empty field is correct and useful; an invented one sends a student to an application they are not eligible for.`;

const ENRICH_SCHEMA = {
  type: 'OBJECT',
  properties: {
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id: { type: 'INTEGER' },
          bullets: { type: 'ARRAY', items: { type: 'STRING' } },
          roleLabel: { type: 'STRING' },
          // "none" rather than "": the API rejects an empty string inside an enum.
          degreeLevel: { type: 'STRING', enum: ['UG', 'PG', 'UG/PG', 'Pursuing', 'none'] },
          degreeText: { type: 'STRING' },
          keySkills: { type: 'ARRAY', items: { type: 'STRING' } },
          stipendStatus: { type: 'STRING', enum: ['paid', 'unpaid', 'unknown'] },
          isTech: { type: 'BOOLEAN' },
        },
        required: ['id', 'bullets', 'degreeLevel', 'keySkills', 'stipendStatus', 'isTech'],
      },
    },
  },
  required: ['items'],
};

/**
 * Let the offline vocabulary overrule a model verdict, in one direction only.
 *
 * If the configured terms confidently call a title non-engineering, that stands
 * whatever the model thinks. Those terms are added deliberately, in response to
 * something wrong actually reaching the site, so they are evidence rather than
 * opinion. The reverse is not true: a title the vocabulary cannot settle is
 * exactly what the model is here to decide.
 */
export function vetoNonTech(title, roleLabel, modelVerdict, cfg = {}) {
  const options = {
    extraPositive: cfg.matching?.extraTechTerms ?? [],
    extraNegative: cfg.matching?.extraNonTechTerms ?? [],
  };
  const verdictOf = (t) => (typeof t === 'string' && t.trim()
    ? classifyRole(t, options).verdict
    : 'uncertain');

  const fromTitle = verdictOf(title);
  if (fromTitle === 'non-tech') return false;

  // The role label is a FALLBACK, consulted only when the title settles
  // nothing. American Express posts every one of its internships as the single
  // word "Apprentice", so the title can never decide and the description does;
  // that is how "Credit Risk Analyst" reached an engineering board.
  //
  // It must not outrank a title that is already confidently technical. The
  // label names the business domain as often as the work — BNP Paribas'
  // "Data Science Intern" is labelled "Financial NLP modelling", and
  // `financial` is a negative term. Letting the label veto that would drop a
  // real data science role to protect against a credit risk one.
  if (fromTitle === 'uncertain' && verdictOf(roleLabel) === 'non-tech') return false;

  return typeof modelVerdict === 'boolean' ? modelVerdict : null;
}

/** Trim, drop empties, cap length and count — the model is asked for this shape, not trusted for it. */
function tidyList(value, { max, maxLen, lower = false }) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    let s = raw.trim().replace(/\s+/g, ' ').replace(/[.;]+$/, '');
    if (lower) s = s.toLowerCase();
    if (!s || s.length > maxLen) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length === max) break;
  }
  return out;
}

/**
 * Summarise and label a batch of postings from their descriptions.
 *
 * Shares the resilience contract of the classifiers above: a failure anywhere
 * leaves the caller's existing fields untouched rather than blanking them, so a
 * spent quota degrades the cards back to plain text instead of emptying them.
 *
 * @param {Array<{title: string, company?: string, description?: string, stipend?: string|null}>} items
 * @returns {Promise<Map<number, {bullets: string[], degreeLevel: string, degreeText: string,
 *                                keySkills: string[], stipendStatus: string, isTech: boolean}>>}
 */
export async function enrichJobs(items, cfg = {}) {
  const out = new Map();
  if (!items.length) return out;
  if (cfg.enrich?.useGemini === false) return out;
  if (!geminiAvailable()) {
    log.info(`No GEMINI_API_KEY — ${items.length} posting(s) keep their plain-text summary.`);
    return out;
  }

  const model = process.env.GEMINI_MODEL || cfg.enrich?.model || 'gemini-2.5-flash';
  // The free tier allows 20 requests per day per model — measured, not guessed:
  // the 429 body names GenerateRequestsPerDayPerProjectPerModel-FreeTier with
  // value 20. Requests, not tokens, are therefore the scarce resource, so each one
  // should carry as much work as it can. Eighteen postings at ~3k characters each
  // is roughly 54k characters in, well inside the model's context, and turns the
  // day's whole budget into ~360 postings instead of ~120.
  const PER_CALL = 18;

  for (let start = 0; start < items.length; start += PER_CALL) {
    const slice = items.slice(start, start + PER_CALL);
    const body = slice.map((it, i) => [
      `### ${i}`,
      `Title: ${it.title}`,
      `Company: ${it.company ?? 'unknown'}`,
      `Stipend field: ${it.stipend ? String(it.stipend) : '(not captured)'}`,
      `Description: ${String(it.description ?? '').slice(0, 3500) || '(none captured)'}`,
    ].join('\n')).join('\n\n');

    try {
      const res = await geminiPost(model, {
        systemInstruction: { parts: [{ text: ENRICH_SYSTEM }] },
        contents: [{ role: 'user', parts: [{ text: `Summarise these ${slice.length} postings:\n\n${body}` }] }],
        generationConfig: {
          temperature: 0.2,
          // Eighteen postings of bullets, skills and labels do not fit in 4,000
          // tokens. The reply was cut mid-JSON, the parse threw, and the batch
          // was dropped without a word — the quiet half of why 122 of 198
          // published jobs had no bullets. Headroom is nearly free here:
          // requests are the metered resource on this tier, not output tokens.
          maxOutputTokens: 8_000,
          responseMimeType: 'application/json',
          responseSchema: ENRICH_SCHEMA,
          thinkingConfig: NO_THINKING,
        },
      });

      if (!res.ok) {
        log.warn(`Gemini unavailable (${res.reason}) — ${items.length - out.size} posting(s) keep their plain-text summary.`);
        // A per-minute limit that survived the retries may still clear before the next
        // batch; a spent daily quota or a bad key will not, so stop asking.
        if (res.fatal) return out;
        continue;
      }

      const payload = res.payload;
      if (payload.promptFeedback?.blockReason) {
        log.warn('Gemini refused a batch (content filter) — those postings keep their plain-text summary.');
        continue;
      }

      const candidate = payload.candidates?.[0];
      const raw = (candidate?.content?.parts ?? [])
        .map((p) => p.text).filter(Boolean).join('').trim();

      // Say why a batch produced nothing. Both of these used to `continue` in
      // silence, so a run reported "nothing enriched" with no cause to chase.
      if (candidate?.finishReason && candidate.finishReason !== 'STOP') {
        log.warn(`Gemini stopped early (${candidate.finishReason}) on a batch of ${slice.length} — lower enrich PER_CALL or raise maxOutputTokens.`);
      }
      if (!raw) {
        log.warn(`Gemini returned an empty body for a batch of ${slice.length} posting(s).`);
        continue;
      }

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        log.warn(`Gemini returned unparseable JSON (${raw.length} chars) for a batch of ${slice.length} — batch skipped.`);
        continue;
      }
      // Counted so a batch that comes back full and still stores nothing says
      // which rule ate it. Enriching "2 of 19" with no further explanation is
      // indistinguishable from the API being down.
      let badId = 0;
      let tooThin = 0;

      for (const v of parsed.items ?? []) {
        if (!Number.isInteger(v?.id) || v.id < 0 || v.id >= slice.length) { badId++; continue; }

        // The model still occasionally reviews the advert instead of describing
        // the job ("this posting is incomplete"). Useless to a student, so drop it.
        const bullets = tidyList(v.bullets, { max: 4, maxLen: 110 })
          .filter((b) => !/\b(this )?(posting|advert|listing|description)\b.*\b(incomplete|vague|unclear|does not|doesn't|no specific|not specified|lacks)\b/i.test(b));

        // Fewer than two bullets means the posting had nothing to summarise —
        // Valeo's "Facilities Trainee" is 1,252 characters of corporate blurb,
        // Aptiv's "Machinist Trainee" is one line and a privacy notice. The
        // model is right to return nothing and the card is right to refuse it.
        //
        // But it is still RECORDED, with empty bullets, so the row leaves the
        // queue. Skipping it outright left bullets NULL, needingEnrichment
        // returned the same postings on every run, and the whole daily
        // allowance went on re-asking about descriptions that can never yield
        // an answer. The queue jammed at the head and nothing behind it was
        // ever reached — which is why 122 of 198 published jobs had no bullets
        // while the log claimed the quota was simply spent.
        if (bullets.length < 2) {
          tooThin++;
          out.set(start + v.id, {
            bullets: [],
            roleLabel: '',
            degreeLevel: '',
            degreeText: '',
            keySkills: [],
            stipendStatus: slice[v.id].stipend ? 'paid' : 'unknown',
            isTech: typeof v.isTech === 'boolean' ? v.isTech : null,
          });
          continue;
        }

        // "none" is the schema's stand-in for "not stated"; normalise it back to empty.
        const level = ['UG', 'PG', 'UG/PG', 'Pursuing'].includes(v.degreeLevel) ? v.degreeLevel : '';
        // The prompt asks for the degree name alone, but the model reliably volunteers
        // the field of study too. Strip it here rather than trusting the instruction.
        const degreeText = level ? normaliseDegree(v.degreeText) : '';
        // A captured amount outranks the model: the scraper read it off the posting.
        const stipendStatus = slice[v.id].stipend ? 'paid'
          : ['paid', 'unpaid', 'unknown'].includes(v.stipendStatus) ? v.stipendStatus
          : 'unknown';

        // Four words is the ceiling: this sits beside the title on one line, and a
        // label that wraps is a label that has stopped being a label.
        const roleLabel = typeof v.roleLabel === 'string'
          ? v.roleLabel.trim().replace(/\s+/g, ' ').replace(/[.]+$/, '').split(' ').slice(0, 4).join(' ')
          : '';

        out.set(start + v.id, {
          bullets,
          roleLabel,
          degreeLevel: level,
          degreeText,
          keySkills: tidyList(v.keySkills, { max: 5, maxLen: 24, lower: true }),
          stipendStatus,
          // The vocabulary has a veto. saveEnrichment writes this straight over
          // whatever the role verdict was, so without this the model quietly
          // reinstated seven "Technical Support Representative Intern" cards
          // minutes after the vocabulary had ruled them out. Same principle as
          // builtInPolarity in roles.js: a hand-written rule with tests behind
          // it outranks a model's opinion. The veto is one-way — the model may
          // still promote a role the vocabulary was merely unsure about.
          //
          // The role label is checked alongside the title because employers who
          // post everything under one generic title ("Apprentice", "Graduate
          // Trainee") give the vocabulary nothing to bite on otherwise.
          isTech: vetoNonTech(slice[v.id].title, roleLabel, v.isTech, cfg),
        });
      }

      const returned = (parsed.items ?? []).length;
      if (returned < slice.length || badId || tooThin) {
        log.info(`  batch of ${slice.length}: model returned ${returned}`
          + (badId ? `, ${badId} with an out-of-range id` : '')
          + (tooThin ? `, ${tooThin} with fewer than 2 usable bullets` : ''));
        if (tooThin) log.debug(`  sample bullets: ${JSON.stringify((parsed.items ?? [])[0]?.bullets)}`);
      }
    } catch (err) {
      // Transport is geminiPost's job; a throw here is a malformed reply, which is
      // specific to this batch — the next one may parse fine.
      log.warn(`Gemini reply unusable (${err.message.split('\n')[0]}) — that batch keeps its plain-text summary.`);
      continue;
    }
  }

  return out;
}
