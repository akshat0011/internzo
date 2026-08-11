/**
 * Local model, via Ollama on this machine.
 *
 * Drop-in for the three functions the run used to import from gemini.js, with
 * the same signatures and return shapes, so index.js and bin/enrich.js only
 * change which module they import.
 *
 * Why this exists: the Gemini free tier is a daily request cap, and the log
 * showed it spent by early morning every day — 36 of 280 technical postings in
 * the publish window had no bullets, which makes their page noindex, which
 * means 13% of the catalogue never reached Google. On-device there is no cap,
 * so the shape of the work changes completely:
 *
 *   - the WHOLE description is sent, not the first 3,500 characters (37% of
 *     stored descriptions are longer than that and were being cut mid-posting)
 *   - tech/non-tech gets a call of its own instead of sharing one reply with
 *     seven other fields, which measured 92% against 8/12 when batched
 *   - every posting can be retried, because a retry costs only time
 *
 * What has NOT changed is that none of this may ever delay a listing. A job
 * reaching the site minutes after it appears is the entire product; bullets are
 * a nice-to-have that arrive on this run or the next one. Every call here is
 * bounded by a timeout and every failure returns empty rather than throwing.
 */
import { log } from './logger.js';
import { classifyRole } from './roles.js';

const HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';

/* ------------------------------------------------------------------ plumbing */

/**
 * One request, with a hard ceiling on how long it may take.
 *
 * The ceiling is the whole point. Ollama holding a socket open while the model
 * is stuck would stall the run, and the run is what publishes; a slow reply is
 * worth strictly less than a listing that goes out on time.
 */
async function post(path, body, timeoutMs) {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), timeoutMs);
  try {
    const res = await fetch(`${HOST}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: control.signal,
    });
    if (!res.ok) return { ok: false, reason: `http ${res.status}` };
    const payload = await res.json();
    if (payload.error) return { ok: false, reason: payload.error };
    return { ok: true, payload };
  } catch (err) {
    return { ok: false, reason: err.name === 'AbortError' ? `timed out after ${Math.round(timeoutMs / 1000)}s` : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask for one JSON object shaped by `schema`.
 *
 * `think: false` matters: Qwen3 reasons before answering by default, which on
 * this hardware turns a six-second reply into minutes of preamble nobody reads.
 * `format` is a real JSON-schema constraint applied during decoding, not a
 * request in the prompt, so the reply parses or the model could not emit it.
 */
async function chatJson({ model, system, user, schema, numCtx, timeoutMs, temperature = 0.2 }) {
  const res = await post('/api/chat', {
    model,
    think: false,
    stream: false,
    format: schema,
    options: { temperature, num_ctx: numCtx },
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  }, timeoutMs);

  if (!res.ok) return res;
  try {
    return { ok: true, value: JSON.parse(res.payload.message.content) };
  } catch (err) {
    return { ok: false, reason: `unparseable reply: ${err.message}` };
  }
}

/**
 * Context window big enough for this input, rounded up to something sane.
 *
 * Ollama defaults to 2048 tokens and silently drops whatever does not fit, so a
 * long posting would be truncated exactly as the old 3,500-character cap did —
 * the failure this module exists to remove. Sized per call because holding a
 * 32k window open for every short posting wastes memory this machine needs for
 * the browser.
 */
function ctxFor(chars, floor = 8192, ceiling = 32768) {
  const needed = Math.ceil((chars / 3.5) + 1500);
  return Math.min(ceiling, Math.max(floor, 2 ** Math.ceil(Math.log2(Math.max(needed, floor)))));
}

export async function ollamaAvailable(timeoutMs = 4000) {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), timeoutMs);
  try {
    const res = await fetch(`${HOST}/api/tags`, { signal: control.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------- grounding guards */

const flat = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ');

/**
 * Every spelling a qualification might appear under, because the check is a
 * substring test on the posting and "B.Tech" flattens to "b tech".
 */
const DEGREE_FORMS = {
  'b tech': ['b tech', 'btech', 'bachelor of technology'],
  'b e': ['b e', 'bachelor of engineering'],
  'm tech': ['m tech', 'mtech', 'master of technology'],
  'm e': ['m e', 'master of engineering'],
  'b sc': ['b sc', 'bsc', 'bachelor of science'],
  'm sc': ['m sc', 'msc', 'master of science'],
  'b com': ['b com', 'bcom'], mca: ['mca'], bca: ['bca'], mba: ['mba'], bba: ['bba'],
  phd: ['phd', 'doctoral', 'doctorate'], diploma: ['diploma'], ca: ['chartered accountant', ' ca '],
};

/** Words that show the posting discusses education at all. */
const ENROLMENT = ['degree', 'pursuing', 'graduat', 'bachelor', 'master', 'final year', 'undergraduate',
  'student', 'university', 'college', 'b tech', 'btech', 'mca', 'bca', 'diploma', 'engineering degree'];

/**
 * Strip anything the posting does not actually say.
 *
 * The prompt's one hard rule is to state only what the posting supports, and
 * this is the field where breaking it costs a real person something: an
 * invented "B.Tech" tells a BCA student they are ineligible for a job that
 * never asked for a degree. Measured on 20 postings, the model invented a
 * qualification on 13 of them; qwen3:14b was worse, not better, so this is a
 * prior baked into the weights rather than a capacity problem, and no model
 * upgrade removes it. A substring check against the source does, for free.
 */
export function groundEnrichment(item, description) {
  const d = flat(description);
  const out = { ...item };
  const dropped = [];

  if (out.degreeText) {
    const parts = out.degreeText.split('/').map((p) => flat(p).trim()).filter(Boolean);
    const grounded = parts.length > 0
      && parts.every((p) => (DEGREE_FORMS[p] ?? [p]).some((form) => d.includes(form)));
    if (!grounded) { dropped.push('degreeText'); out.degreeText = ''; }
  }

  if (out.degreeLevel && out.degreeLevel !== 'none' && !ENROLMENT.some((w) => d.includes(w))) {
    dropped.push('degreeLevel');
    out.degreeLevel = 'none';
  }

  const skills = out.keySkills ?? [];
  out.keySkills = skills.filter((s) => d.includes(flat(s).trim()));
  if (out.keySkills.length !== skills.length) dropped.push(`${skills.length - out.keySkills.length} skill(s)`);

  // "none" is the schema's way of saying absent; the column wants null.
  if (out.degreeLevel === 'none') out.degreeLevel = '';

  return { item: out, dropped };
}

/**
 * Sentence-case prose the model wrote in lower case.
 *
 * "lowercase" is stated in the prompt for keySkills, and the model generalises
 * it: on the same run one posting came back correctly capitalised while the
 * next read "this internship involves testing wireless connectivity devices".
 * Restating the rule did not hold it, and it is inconsistent rather than
 * uniform, so it is settled here instead of being argued with. Only a
 * lower-case letter at the start of the text or after a full stop is touched,
 * which leaves SQL, Python and B.Tech alone.
 */
export function sentenceCase(text) {
  const s = String(text ?? '').trim();
  if (!s) return '';
  return s
    .replace(/^([a-z])/, (m) => m.toUpperCase())
    .replace(/([.!?]\s+)([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
}

/**
 * Longest run of consecutive words the summary shares with the posting.
 *
 * The site publishes its own summary and links to the original precisely so it
 * never republishes the employer's copyrighted text. A model asked to rewrite
 * will occasionally lift a clause instead, so the claim is checked rather than
 * trusted — measured at 1 in 12 before this guard.
 */
export function longestSharedRun(summary, description, max = 12) {
  const a = flat(summary).split(' ').filter(Boolean);
  const b = flat(description).split(' ').filter(Boolean);
  if (a.length < 5 || b.length < 5) return 0;
  const windows = new Set();
  for (let n = 5; n <= max; n++) for (let i = 0; i + n <= b.length; i++) windows.add(b.slice(i, i + n).join(' '));
  let longest = 0;
  for (let n = 5; n <= max; n++) for (let i = 0; i + n <= a.length; i++) {
    if (windows.has(a.slice(i, i + n).join(' '))) longest = n;
  }
  return longest;
}

/* ------------------------------------------------------- tech / non-tech */

const TECH_SYSTEM = `You decide whether an internship is a TECHNOLOGY role.

The JOB TITLE is the strongest evidence and takes priority. A title that clearly names technical work settles the question even when the description is thin, missing, or full of company boilerplate. Use the description to confirm the title or to settle a title that is vague ("Intern", "Trainee", "Apprentice", "Summer Analyst").

Tech means the actual work is: writing code, building or testing software, data engineering, data science, machine learning or AI, DevOps, cloud or network infrastructure, cybersecurity, QA and test automation, embedded or firmware, chip and silicon design, or product management and UI/UX for a software product.

Not tech: sales, marketing, HR and recruiting, finance, accounting, audit, legal, admin, non-technical operations, non-technical customer support, content and copywriting, graphic and media design, and non-software engineering — mechanical, civil, electrical power, chemical, industrial and manufacturing process work.

Judge the WORK, not the employer. A software engineer at a bank is tech. A payroll apprentice at a software company is not.

Abbreviations that are commonly missed. Tech: SQA, QA, SDET, SRE, DevOps, MLOps, BI, ETL, VLSI, RTL, ASIC, FPGA, DFT, PCB firmware, NOC, SOC (security operations), IAM, API. Not tech: FP&A, TA (talent acquisition), AR/AP, GTM, CRM administration, SCM, EHS, QC on a production line.

Never answer "not tech" merely because the description is thin. If the description says nothing about the work, judge from the title alone and say so.

Return only JSON.`;

const TECH_SCHEMA = {
  type: 'object',
  properties: {
    isTech: { type: 'boolean' },
    basis: { type: 'string', enum: ['title', 'description', 'both'] },
    keyTerm: { type: 'string', description: 'the single word or phrase the decision hinged on' },
    reason: { type: 'string' },
  },
  required: ['isTech', 'basis', 'keyTerm', 'reason'],
};

async function classifyOne(job, { model, timeoutMs }) {
  const desc = String(job.description ?? '').trim();
  const user = `Job title: ${job.title}\nCompany: ${job.company ?? 'unknown'}\n\nDescription:\n${desc || '(the posting gives no description — judge from the title)'}`;
  return chatJson({
    model,
    system: TECH_SYSTEM,
    user,
    schema: TECH_SCHEMA,
    numCtx: ctxFor(desc.length + job.title.length),
    timeoutMs,
    temperature: 0,
  });
}

/**
 * Title-only verdicts. Offline vocabulary first so nothing depends on the model
 * being up, then the model decides only what the vocabulary could not.
 *
 * @returns {Promise<Array<{isTech: boolean, source: string, reason: string}>>}
 */
export async function classifyRoles(items, cfg) {
  const verdicts = items.map(({ title }) => {
    const r = classifyRole(title, {
      extraPositive: cfg.matching?.extraTechTerms ?? [],
      extraNegative: cfg.matching?.extraNonTechTerms ?? [],
    });
    return {
      isTech: r.verdict === 'tech',
      source: 'offline',
      reason: r.matched ? `matched "${r.matched}"` : 'no vocabulary match',
      settled: r.verdict === 'tech' || r.verdict === 'non-tech',
    };
  });

  if (!items.length) return verdicts.map(({ settled, ...v }) => v);
  if (cfg.roleClassifier?.useModel === false) return verdicts.map(({ settled, ...v }) => v);
  if (!(await ollamaAvailable())) {
    log.warn(`Ollama not reachable at ${HOST} — ${items.length} title(s) keep their offline verdict.`);
    return verdicts.map(({ settled, ...v }) => v);
  }

  const model = cfg.roleClassifier?.model || cfg.ollama?.model || 'qwen3:8b';
  const timeoutMs = (cfg.ollama?.timeoutSeconds ?? 90) * 1000;

  // Only the titles the vocabulary could not settle. Everything else is already
  // answered, instantly and identically to how it was answered last week.
  const unsettled = items.map((it, i) => ({ it, i })).filter(({ i }) => !verdicts[i].settled);
  let decided = 0;
  for (const { it, i } of unsettled) {
    const res = await classifyOne({ title: it.title, company: it.company, description: '' }, { model, timeoutMs });
    if (!res.ok) {
      log.debug(`  title verdict failed (${res.reason}) — "${it.title}" keeps its offline verdict.`);
      continue;
    }
    verdicts[i] = { isTech: !!res.value.isTech, source: 'model-title', reason: res.value.reason || res.value.keyTerm || '' };
    decided++;
  }
  if (decided) log.info(`Model settled ${decided} title(s) the vocabulary could not.`);
  return verdicts.map(({ settled, ...v }) => v);
}

/**
 * Decide ambiguous postings from the full description plus the title.
 *
 * @returns {Promise<Map<number, {isTech: boolean, keyTerm: string, reason: string}>|null>}
 *          null when the model is unavailable, so the caller keeps offline verdicts
 */
export async function classifyFromDescriptions(items, cfg) {
  if (!items.length) return new Map();
  if (cfg.roleClassifier?.useModelForAmbiguous === false) return null;
  if (!(await ollamaAvailable())) {
    log.warn(`Ollama not reachable — ${items.length} ambiguous role(s) keep their offline verdict.`);
    return null;
  }

  const model = cfg.roleClassifier?.model || cfg.ollama?.model || 'qwen3:8b';
  const timeoutMs = (cfg.ollama?.timeoutSeconds ?? 90) * 1000;
  const out = new Map();

  // One posting per call. Batching these was what produced 8-of-12 accuracy:
  // eight fields and five postings in one reply gives each posting a fraction
  // of the model's attention, and this is the field that decides whether a job
  // is published at all.
  for (const [i, it] of items.entries()) {
    const res = await classifyOne(it, { model, timeoutMs });
    if (!res.ok) {
      log.debug(`  description verdict failed (${res.reason}) for "${it.title}".`);
      continue;
    }
    out.set(i, {
      isTech: !!res.value.isTech,
      keyTerm: res.value.keyTerm || '',
      reason: res.value.reason || '',
    });
  }
  return out;
}

/* ---------------------------------------------------------------- enrichment */

const ENRICH_SYSTEM = `You turn an internship posting into a compact, scannable card for a student deciding whether to apply, plus a short original description of the role for its own page.

Return, for the posting:

bullets — 2 to 4 fragments, each at most 90 characters, no trailing period. Lead with what the intern actually DOES day to day, then the stack or tools, then anything concrete that affects the decision (team, product, duration). Ordinary prose starting with a capital letter. Write plainly, as a person would to a friend. Never open with company boilerplate ("About X, founded in..."), never use marketing language ("exciting opportunity", "fast-paced environment", "dynamic team"), and never repeat the job title back.

Never write a bullet ABOUT the posting itself — no "the posting is vague", "no duties listed", "details not specified". The reader wants the job, not a review of the advert. If the posting is too thin to yield two real bullets, return an empty bullets array.

summary — 40 to 70 words of original prose describing this specific internship, written for a student. This is published as the page's description and is the only prose a search engine sees, so it must read as one complete, natural paragraph. Rewrite in your own words: never copy a phrase from the posting. Say what the intern does, who it suits, and where it is based. Start with the work itself, not with "This internship offers". No marketing language and no company boilerplate. Empty string if the posting describes no actual work.

roleLabel — 2 to 4 words naming what this job ACTUALLY is, in plain terms: "Backend engineering", "Credit risk modelling", "Payroll operations". Many postings are titled only "Intern", "Apprentice" or "Trainee", which tells a reader nothing and makes ten different jobs at the same company look identical. This is the field that tells them apart. Name the work, never the seniority or the company, and do not repeat the job title back.

degreeLevel — who is eligible, judged ONLY from the text: "UG" for bachelor's-level study, "PG" for master's and above, "UG/PG" when either is explicitly acceptable, "Pursuing" when it requires a currently-enrolled student but names no level, "none" when the posting does not say. Never infer a degree from the word "intern", from the seniority, or from the industry. If the posting names no qualification and does not require enrolment, the answer is "none".

degreeText — the degree NAME ONLY, never the field of study: "B.Tech" not "B.Tech Computer Science". Short Indian forms: B.Tech, M.Tech, B.E, M.E, B.Sc, M.Sc, BCA, MCA, BBA, MBA, B.Com, PhD, Diploma, CA. At most two, separated by "/". Empty string unless the posting names one explicitly.

keySkills — 2 to 5 concrete skills or technologies NAMED IN THE POSTING: languages, frameworks, tools. Lowercase. Never soft skills, never vague nouns. Empty array if the posting names none.

stipendStatus — "paid" only if the posting states a stipend, salary or amount; "unpaid" only if it explicitly says unpaid; otherwise "unknown".

isTech — whether the ACTUAL WORK is software or technology. The job title is the strongest evidence. Product management and UI/UX for software products count. Sales, marketing, HR, finance, legal, admin, operations, support, content, media design and non-software engineering do not.

The single hard rule: state only what the posting supports. Never infer a qualification, a skill or a stipend that is not there. An empty field is correct and useful; an invented one sends a student to an application they are not eligible for.

Return only JSON.`;

const ENRICH_SCHEMA = {
  type: 'object',
  properties: {
    bullets: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    roleLabel: { type: 'string' },
    degreeLevel: { type: 'string', enum: ['UG', 'PG', 'UG/PG', 'Pursuing', 'none'] },
    degreeText: { type: 'string' },
    keySkills: { type: 'array', items: { type: 'string' } },
    stipendStatus: { type: 'string', enum: ['paid', 'unpaid', 'unknown'] },
    isTech: { type: 'boolean' },
  },
  // All of them required. Left optional, a local model simply omits roleLabel
  // and degreeText — measured empty on every posting of the first trial run —
  // whereas Gemini filled them anyway.
  required: ['bullets', 'summary', 'roleLabel', 'degreeLevel', 'degreeText', 'keySkills', 'stipendStatus', 'isTech'],
};

/**
 * Enrich postings one at a time, with the whole description.
 *
 * @returns {Promise<Map<number, object>>} keyed by index into `items`
 */
export async function enrichJobs(items, cfg = {}) {
  const out = new Map();
  if (!items.length) return out;
  if (cfg.enrich?.useModel === false) return out;
  if (!(await ollamaAvailable())) {
    log.warn(`Ollama not reachable at ${HOST} — ${items.length} posting(s) keep their plain-text summary.`);
    return out;
  }

  const model = cfg.enrich?.model || cfg.ollama?.model || 'qwen3:8b';
  const timeoutMs = (cfg.ollama?.timeoutSeconds ?? 120) * 1000;
  const budgetMs = (cfg.enrich?.budgetMinutes ?? 9) * 60_000;
  const started = Date.now();

  let guarded = 0;
  let copies = 0;

  for (const [i, job] of items.entries()) {
    // The run's clock outranks enrichment. Whatever is done by the deadline is
    // saved; the rest is picked up next run, because only postings without
    // bullets are ever selected. A listing is never held back for this.
    if (Date.now() - started > budgetMs) {
      log.info(`Enrichment budget spent — ${items.length - i} posting(s) left for the next run.`);
      break;
    }

    const description = String(job.description ?? '');
    const user = [
      `Title: ${job.title}`,
      `Company: ${job.company ?? 'unknown'}`,
      `Location: ${job.location ?? 'not stated'}`,
      `Stipend field: ${job.stipend ? String(job.stipend) : '(not captured)'}`,
      '',
      'Description:',
      description || '(none captured)',
    ].join('\n');

    const res = await chatJson({
      model,
      system: ENRICH_SYSTEM,
      user,
      schema: ENRICH_SCHEMA,
      numCtx: ctxFor(description.length),
      timeoutMs,
    });

    if (!res.ok) {
      log.debug(`  enrichment failed (${res.reason}) for "${job.title}".`);
      continue;
    }

    const { item, dropped } = groundEnrichment(res.value, description);

    // A posting with no description cannot justify OVERTURNING an existing tech
    // verdict. Bajaj Finserv's "Trainee Technology" carries 122 characters —
    // an office address and "this position is open with Bajaj Finance Ltd" —
    // and the model answered non-tech from that, which would have deleted a
    // live listing whose title says Technology. Withholding the field entirely
    // is what protects it: saveEnrichment writes is_tech through COALESCE, so a
    // missing value leaves the verdict the title classifier already reached.
    // Everything else about the posting is still saved.
    if (description.replace(/\s+/g, ' ').trim().length < 400 && item.isTech === false) {
      log.debug(`  keeping the existing tech verdict for "${job.title}" — its description is too thin to overturn one.`);
      delete item.isTech;
    }

    // Prose fields get their capitals back; keySkills stays lower case, which is
    // what the card expects and the only place the prompt actually wanted it.
    item.bullets = (item.bullets ?? []).map(sentenceCase).filter(Boolean);
    item.summary = sentenceCase(item.summary);
    item.roleLabel = sentenceCase(item.roleLabel);

    if (dropped.length) {
      guarded++;
      log.debug(`  guard dropped ${dropped.join(', ')} for "${job.title}" — not stated in the posting.`);
    }

    // A summary that lifts a clause from the posting is worse than none: the
    // site's promise is its own words plus a link to the original.
    if (item.summary && longestSharedRun(item.summary, description) >= 8) {
      copies++;
      log.debug(`  summary copied from the posting for "${job.title}" — dropped.`);
      item.summary = '';
    }

    out.set(i, item);
  }

  if (guarded) log.info(`Guard removed unstated details from ${guarded} posting(s).`);
  if (copies) log.info(`Dropped ${copies} summary(ies) that copied the posting.`);
  return out;
}
