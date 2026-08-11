/* Internzo — listings browser + resume tailoring */

// pdf.js is served from this origin, not a CDN.
//
// It runs on the one page where students hand over a resume, and the site
// promises that file never leaves their device. A script fetched from someone
// else's server at page load is the one thing that could quietly break that
// promise: whoever controls that host controls code running next to the file.
// Vendored at 4.6.82, verified byte-identical to the CDN copy at the time.
const PDFJS_BASE = '/vendor/pdfjs';
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const HOT_MS = 60 * 60 * 1000;      // "just posted"
const FRESH_MS = 24 * 60 * 60 * 1000; // "new"

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const state = {
  jobs: [],
  // Which tab is showing. A job with an unknown verdict counts as "other" so it
  // is still reachable rather than hidden.
  filtered: [],
  selectedId: null,
  resumeText: '',
  tailored: null,
  generatedAt: null,
};

/* ---------------- theme ---------------- */

function initTheme() {
  const saved = localStorage.getItem('theme');
  if (saved) document.documentElement.dataset.theme = saved;

  $('theme-toggle').addEventListener('click', () => {
    const isDark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    const next = isDark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('theme', next);
  });
}

/* ---------------- helpers ---------------- */

/** Compact, monospace-friendly age: 12m, 4h, 3d. */
function shortAge(ms) {
  if (!ms) return '—';
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 60) return `${Math.max(1, mins)}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.round(hrs / 24)}d`;
}

function relTime(ms) {
  if (!ms) return '';
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}

/**
 * The company's real logo when we have one, initials when we don't.
 *
 * The initials are rendered underneath rather than instead: if the image fails
 * to load for any reason, removing it reveals the fallback with no layout shift
 * and no flash of nothing.
 */
function companyBadge(job) {
  const badge = el('div', 'crest', companyInitials(job.company));

  if (job.logo) {
    const img = el('img', 'crest-img');
    img.src = job.logo;
    img.alt = '';               // decorative: the company name is right beside it
    img.loading = 'lazy';
    img.decoding = 'async';
    img.addEventListener('load', () => badge.classList.add('lit'));
    img.addEventListener('error', () => img.remove());
    badge.append(img);
  }
  return badge;
}

function companyInitials(name) {
  const words = String(name).replace(/[^\w\s]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function toast(message) {
  const t = $('toast');
  t.textContent = message;

  // Cancel a pending hide before unhiding. Without this, a toast arriving
  // during the previous one's fade-out would be hidden by that toast's timer
  // a moment after appearing.
  clearTimeout(toast._hide);
  t.hidden = false;

  // Commit the "down" state before flipping to "up", or the browser coalesces
  // both into one style change, finds nothing to transition from, and the toast
  // just appears. Reading offsetWidth forces that flush synchronously.
  //
  // Deliberately not requestAnimationFrame: rAF does not run in a backgrounded
  // tab, which would leave the toast unhidden but stuck at opacity 0 — visible
  // to a screen reader, invisible on screen.
  void t.offsetWidth;
  t.classList.add('is-up');

  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    t.classList.remove('is-up');
    // Stay in the DOM until it has faded, or it would vanish instantly.
    clearTimeout(toast._hide);
    toast._hide = setTimeout(() => { t.hidden = true; }, 300);
  }, 2600);
}

/* ---------------- data ---------------- */

async function loadJobs() {
  try {
    const res = await fetch(`/data/jobs.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    state.jobs = data.jobs ?? [];
    state.generatedAt = data.generatedAt ?? null;
  } catch {
    state.jobs = [];
    state.generatedAt = null;
  }
}

function renderFreshness() {
  $('freshness-text').textContent = state.generatedAt
    ? `swept ${relTime(state.generatedAt)}`
    : 'standing by';
}

function renderTotal() {
  const el = $('n-total');
  if (el) el.textContent = state.jobs.length;
}

function populateFilters() {
  const companies = [...new Set(state.jobs.map((j) => j.company))].sort((a, b) => a.localeCompare(b));
  const locations = [...new Set(state.jobs.map((j) => j.location).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  for (const c of companies) $('f-company').append(new Option(c, c));
  for (const l of locations.slice(0, 200)) $('f-location').append(new Option(l, l));
}

/* ---------------- filtering ---------------- */

function applyFilters() {
  const q = $('q').value.trim().toLowerCase();
  const company = $('f-company').value;
  const location = $('f-location').value;
  const mode = $('f-mode').value;
  const sort = $('f-sort').value;
  const easyOnly = $('f-easy').getAttribute('aria-pressed') === 'true';

  const list = state.jobs.filter((j) => {
    if (company && j.company !== company) return false;
    if (location && j.location !== location) return false;
    if (mode && (j.workplaceType ?? '').toLowerCase() !== mode.toLowerCase()) return false;
    if (easyOnly && !j.easyApply) return false;
    if (q) {
      const blob = [j.title, j.company, j.location, j.summary, (j.skills || []).join(' ')]
        .filter(Boolean).join(' ').toLowerCase();
      if (!blob.includes(q)) return false;
    }
    return true;
  });

  if (sort === 'company') list.sort((a, b) => a.company.localeCompare(b.company));
  else list.sort((a, b) => (b.postedAt ?? 0) - (a.postedAt ?? 0));

  state.filtered = list;
  renderList();
  syncStickyOffset();
}

function anyFilterActive() {
  return $('q').value.trim() || $('f-company').value || $('f-location').value ||
    $('f-mode').value || $('f-easy').getAttribute('aria-pressed') === 'true';
}

/* ---------------- rendering ---------------- */

/**
 * The URL of a job's generated page.
 *
 * Must produce byte-identical output to slugify/jobSlug in src/pages.js, which is
 * what actually names the files at publish time. If the two ever drift, this links
 * to a 404 — so any change to one has to be made in both.
 */
function jobPageSlug(job) {
  const slug = (s, max = 70) => String(s ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'role';
  // The id is never truncated — see the note on jobSlug in src/pages.js.
  return `${slug(job.company)}-${slug(job.title)}-${slug(job.id, Infinity)}`;
}

/**
 * An href we are willing to put in front of a reader. The apply URL comes from
 * the posting, and `javascript:` is a perfectly valid href — so only http(s)
 * links are ever assigned. Mirrors safeUrl() in src/pages.js.
 */
function safeUrl(url) {
  const raw = String(url ?? '').trim();
  return /^https?:\/\//i.test(raw) ? raw : '';
}

/** Has this posting been through the Gemini pass yet? */
function enriched(job) {
  return (job.bullets ?? []).length > 0;
}

/**
 * Who can apply. Highlighted because eligibility is the one fact that makes the
 * rest of the card irrelevant, and it is absent from most postings — so when it
 * IS known it deserves to be the loudest thing in the row.
 */
function degreeTag(job) {
  if (!job.degreeLevel) return null;
  const tag = el('span', 'elig');
  tag.append(el('b', null, job.degreeLevel));
  if (job.degreeText) tag.append(el('i', null, job.degreeText));
  return tag;
}

/**
 * Words that describe the shape of a job rather than the work in it. A title made
 * only of these tells a reader nothing.
 */
const FILLER_TITLE_WORDS = new Set([
  'intern', 'interns', 'internship', 'internships', 'apprentice', 'apprenticeship',
  'trainee', 'traineeship', 'graduate', 'grad', 'summer', 'winter', 'management',
  'program', 'programme', 'role', 'position', 'opportunity', 'hiring', 'new',
  'full', 'time', 'part', 'fresher', 'freshers', 'entry', 'level', 'junior',
]);

/**
 * Does this title distinguish the job from the others at the same company?
 *
 * A quarter of postings are titled only "Apprentice", "Intern" or "Trainee".
 * American Express alone has 25 of them — 25 genuinely different jobs, from GenAI
 * automation to credit-loss modelling, all sharing one useless label. Stacked in a
 * feed they read as duplicates.
 */
function titleIsGeneric(title) {
  const meaningful = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !FILLER_TITLE_WORDS.has(w) && !/^\d+$/.test(w));
  return meaningful.length <= 1;
}

/**
 * What the job actually is, for titles that do not say.
 *
 * Prefers Gemini's short label. Falls back to the opening of the first bullet,
 * which already describes the work — worse than a real label, but it needs no extra
 * API call and it works for every posting enriched before roleLabel existed.
 *
 * Returns whether the bullet was consumed, because the caller must then not print
 * that same bullet three lines further down. The first draft did, and a card read
 * "Apprentice · analyze data to identify trends…" directly above a bullet saying
 * "Analyze data to identify trends into clear reports".
 *
 * @returns {{text: string, usedFirstBullet: boolean}|null}
 */
function roleQualifier(job) {
  if (job.roleLabel) return { text: job.roleLabel, usedFirstBullet: false };
  const first = (job.bullets ?? [])[0];
  if (!first) return null;
  const clipped = first.length > 58 ? `${first.slice(0, 57).replace(/[\s,;:.]+\S*$/, '')}…` : first;
  return { text: clipped.charAt(0).toLowerCase() + clipped.slice(1), usedFirstBullet: true };
}

/**
 * The role line, plus what the job is when the title hides it.
 * @returns {{node: HTMLElement, usedFirstBullet: boolean}}
 */
function roleLine(job) {
  // An h3, not a p: the role is the card's heading. It used to be a paragraph
  // under an h3 of the company name, which told a screen reader (and a crawler)
  // that the employer was the subject and the job was a detail.
  const p = el('h3', 'role', job.title);
  if (!titleIsGeneric(job.title)) return { node: p, usedFirstBullet: false };
  const q = roleQualifier(job);
  if (!q) return { node: p, usedFirstBullet: false };
  p.append(el('span', 'qual', q.text));
  return { node: p, usedFirstBullet: q.usedFirstBullet };
}

function jobCard(job, index) {
  const li = document.createElement('li');
  const row = el('article', 'row');
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.dataset.id = job.id;
  row.style.animationDelay = `${Math.min(index, 14) * 32}ms`;
  if (job.id === state.selectedId) row.setAttribute('aria-current', 'true');

  const age = job.postedAt ? Date.now() - job.postedAt : null;
  const blazing = age != null && age < HOT_MS;
  if (blazing) row.classList.add('is-hot');

  // No rank number. It was decoration: the position of a row in a list the
  // reader is already looking at, restated. It cost a grid column on every card.
  row.append(companyBadge(job));

  const mid = el('div');
  // Company first in the DOM but styled as an eyebrow — the role is the heading.
  mid.append(el('div', 'co', job.company));
  const role = roleLine(job);
  mid.append(role.node);

  // Eligibility leads. A student's first question is "can I even apply", and
  // that used to be buried in the description while the card spent its
  // most-read line on a city they had already filtered by.
  const meta = el('div', 'meta');
  const degree = degreeTag(job);
  if (degree) meta.append(degree);

  // Enrichment runs against a daily API quota, so at any moment some postings have
  // eligibility and skills and some do not. Where they do, that is the row. Where
  // they do not, fall back to city and work mode so the row is not left empty.
  if (!enriched(job)) {
    if (job.location) meta.append(el('span', null, job.location));
    if (job.workplaceType) meta.append(el('span', null, job.workplaceType));
  }
  if (job.duration) meta.append(el('span', null, job.duration));
  if (job.easyApply) meta.append(el('span', 'ea', 'easy apply'));
  if (meta.children.length) mid.append(meta);

  const skills = (job.keySkills ?? []).slice(0, 4);
  if (skills.length) {
    const box = el('div', 'skills');
    for (const s of skills) box.append(el('span', 'skill', s));
    mid.append(box);
  }

  // The role line may have consumed the first bullet as its qualifier; printing it
  // again here would say the same sentence twice on one card.
  const bullets = (job.bullets ?? []).slice(role.usedFirstBullet ? 1 : 0);
  if (bullets.length) {
    const ul = el('ul', 'gist-list');
    for (const b of bullets) ul.append(el('li', null, b));
    mid.append(ul);
  } else if (job.summary) {
    // Not yet enriched — the original blurb still beats an empty card.
    mid.append(el('p', 'gist', job.summary));
  }
  row.append(mid);

  // Age, plus a bar that drains over the first 24 hours. Turning "how long do I
  // have" into something you can see at a glance is the whole point of the site.
  const ageBox = el('div', `age${blazing ? ' blazing' : age != null && age < FRESH_MS ? ' fresh' : ''}`);
  ageBox.append(el('b', null, blazing ? 'JUST NOW' : shortAge(job.postedAt)));
  if (age != null && age < FRESH_MS) {
    const bar = el('s');
    const fill = el('i');
    fill.style.width = `${Math.max(4, Math.round((1 - age / FRESH_MS) * 100))}%`;
    bar.append(fill);
    ageBox.append(bar);
  }
  // Age and Apply share a footer strip. Applying used to cost two taps and a
  // full-screen context switch — open the role, then find the button — and the
  // detail pane exists to answer questions, not to gate the one action every
  // visitor came to take.
  const foot = el('div', 'card-foot');
  foot.append(ageBox);

  const applyHref = safeUrl(job.applyUrl) || safeUrl(job.url);
  if (applyHref) {
    const go = el('a', 'card-go');
    go.href = applyHref;
    go.target = '_blank';
    go.rel = 'noopener noreferrer';
    go.append(el('span', 'card-go-t', 'Apply'), el('i', 'card-go-a'));
    go.setAttribute('aria-label', `Apply for ${job.title} at ${job.company}`);
    // The whole card is clickable. Without this, applying would also fire the
    // card's handler and slide the detail pane up behind the new tab.
    go.addEventListener('click', (e) => e.stopPropagation());
    foot.append(go);
  }
  row.append(foot);

  row.addEventListener('click', () => selectJob(job.id));
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectJob(job.id); }
  });

  li.append(row);
  return li;
}

function renderList() {
  const list = $('joblist');

  // The entrance animation belongs to the first paint and nowhere else.
  //
  // Every filter change rebuilds this list through replaceChildren(), and the
  // search box reruns on `input` — so typing one character re-created up to 140
  // cards and restarted a keyframe on all of them. Keyframes restart from zero
  // rather than retargeting, so a fast typist saw a list that never settled.
  // Searching is a hundred-times-a-day action; it should not animate at all.
  list.classList.toggle('intro', !renderList.painted);
  renderList.painted = true;

  list.replaceChildren();

  const n = state.filtered.length;
  $('result-count').textContent = state.jobs.length === 0
    ? 'nothing on the radar yet'
    : `${n} ${n === 1 ? 'role' : 'roles'}${anyFilterActive() ? ` / ${state.jobs.length}` : ''}`;
  $('reset').hidden = !anyFilterActive();

  const empty = $('empty');
  if (n === 0) {
    empty.hidden = false;
    if (state.jobs.length === 0) {
      $('empty-title').textContent = 'Warming up';
      $('empty-body').textContent = 'No listings have been published here yet. New roles appear within minutes of going live.';
    } else if (!anyFilterActive()) {
      $('empty-title').textContent = 'No engineering roles yet';
      $('empty-body').textContent = 'Nothing software-side has been posted in this window. New roles appear within minutes of going live.';
    } else {
      $('empty-title').textContent = 'Radar clear';
      $('empty-body').textContent = 'Nothing matches those filters. Try clearing the search or widening the company filter.';
    }
    return;
  }
  empty.hidden = true;

  const frag = document.createDocumentFragment();
  state.filtered.forEach((job, i) => frag.append(jobCard(job, i)));
  list.append(frag);
}

function selectJob(id, { silent = false } = {}) {
  state.selectedId = id;
  const job = state.jobs.find((j) => j.id === id);
  if (!job) return;

  for (const card of document.querySelectorAll('.row')) {
    if (card.dataset.id === id) card.setAttribute('aria-current', 'true');
    else card.removeAttribute('aria-current');
  }

  renderDetail(job);
  // A selection the reader did not make should not claim the URL — otherwise
  // copying the address gives someone a link to a job they never chose.
  if (!silent) history.replaceState(null, '', `#job-${id}`);

  if (matchMedia('(max-width: 1000px)').matches) {
    $('detail-col').classList.add('open');
    document.body.style.overflow = 'hidden';
  }
}

function closeDetail() {
  const col = $('detail-col');
  document.body.style.overflow = '';

  // display:none cannot be transitioned, so the pane has to finish its exit
  // animation before it is hidden. Falling back on a timer as well as the event
  // matters: if the animation is suppressed — prefers-reduced-motion, or the
  // desktop layout where the pane is not an overlay — animationend never fires
  // and the pane would be left stuck open.
  if (!col.classList.contains('open')) return;
  col.classList.add('closing');
  const done = () => {
    col.classList.remove('open', 'closing');
    col.removeEventListener('animationend', done);
  };
  col.addEventListener('animationend', done);
  setTimeout(done, 260);
}

function renderDetail(job) {
  const d = $('detail');
  $('detail-placeholder').hidden = true;
  d.hidden = false;
  d.replaceChildren();
  d.scrollTop = 0;
  // Replay the entrance animation on every selection. Dropping the class and
  // re-adding it on the next frame restarts it; reassigning style.animation
  // did not, and left the pane stuck at opacity 0.
  d.classList.remove('is-in');
  requestAnimationFrame(() => d.classList.add('is-in'));

  const back = el('button', 'back');
  back.type = 'button';
  back.textContent = '\u2190 all roles';
  back.addEventListener('click', closeDetail);
  d.append(back);

  d.append(el('div', 'p-co', job.company));
  d.append(el('p', 'p-role', job.title));
  if (job.location) d.append(el('div', 'p-loc', job.location));

  const actions = el('div', 'p-acts');
  const applyHref = safeUrl(job.applyUrl) || safeUrl(job.url);
  if (applyHref) {
    // Label the destination honestly: ATS listings and, since LinkedIn's
    // redesign, plenty of LinkedIn ones too, apply on the employer's own site.
    const host = (applyHref.match(/^https?:\/\/([^/?#]+)/i) || [])[1] || '';
    const where = /(^|\.)linkedin\.com$/i.test(host) ? 'LinkedIn' : 'company site';
    const apply = el('a', 'go', 'Apply on ' + where + ' \u2192');
    apply.href = applyHref;
    apply.target = '_blank';
    apply.rel = 'noopener noreferrer';
    actions.append(apply);
  }

  const tailorBtn = el('button', 'alt');
  tailorBtn.type = 'button';
  tailorBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" '
    + 'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8l1.4 1.4M17.8 6.2l1.4-1.4M12.2 11.8l-1.4 1.4M3 21l9-9"/>'
    + '<circle cx="15" cy="9" r="3"/></svg>';
  tailorBtn.append(document.createTextNode('Tailor my resume'));
  tailorBtn.addEventListener('click', () => openTailor(job));
  actions.append(tailorBtn);

  // The job's own page. Two reasons it belongs here: it is the only way to get a
  // link to one role that survives being pasted into a WhatsApp group, and it is
  // the internal link that lets a crawler reach a page the feed otherwise hides
  // behind JavaScript.
  const page = el('a', 'alt', 'Open full page ↗');
  page.href = `/jobs/${jobPageSlug(job)}`;
  actions.append(page);

  d.append(actions);

  const facts = el('dl', 'facts');
  const addFact = (label, value, cls) => {
    if (!value) return;
    const f = el('div', 'fact');
    f.append(el('dt', null, label), el('dd', cls, value));
    facts.append(f);
  };
  addFact('mode', job.workplaceType || '\u2014');
  addFact('duration', job.duration || '\u2014');
  addFact('posted', job.postedText || relTime(job.postedAt));
  if (job.applicants) addFact('applicants', job.applicants);
  d.append(facts);

  if (job.summary) {
    d.append(el('h3', null, 'the role'));
    d.append(el('p', 'p-gist', job.summary));
  }

  if (job.skills?.length) {
    d.append(el('h3', null, 'skills'));
    const row = el('div', 'chips');
    for (const s of job.skills) row.append(el('span', 'chip', s));
    d.append(row);
  }

  const note = el('p', 'src');
  note.append(document.createTextNode('This is an automatic summary. '));
  const sourceHref = safeUrl(job.url);
  if (sourceHref) {
    const link = el('a', null, 'Read the full posting on LinkedIn');
    link.href = sourceHref;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    note.append(link, document.createTextNode(' before you apply — it is the source of truth.'));
  } else {
    note.append(document.createTextNode('Check the original posting before you apply — it is the source of truth.'));
  }
  d.append(note);
}

/* ---------------- resume tailoring ---------------- */

let activeJob = null;

function openTailor(job) {
  activeJob = job;
  $('tailor-job').textContent = `${job.company} · ${job.title}`;
  showStep('upload');
  $('tailor-backdrop').hidden = false;
  $('tailor').hidden = false;
  document.body.style.overflow = 'hidden';
  $('tailor-close').focus();
}

function closeTailor() {
  $('tailor').hidden = true;
  $('tailor-backdrop').hidden = true;
  if (!$('detail-col').classList.contains('open')) document.body.style.overflow = '';
}

function showStep(name) {
  for (const s of ['upload', 'working', 'result', 'error']) {
    $(`step-${s}`).hidden = s !== name;
  }
}

function setResumeText(text, label, ok = true) {
  state.resumeText = ok ? text : '';
  const box = $('file-state');
  box.hidden = false;
  box.classList.toggle('bad', !ok);
  box.replaceChildren(el('span', null, ok
    ? `${label} · ${text.length.toLocaleString()} characters read`
    : label));
  $('do-tailor').disabled = !ok || text.trim().length < 200;
}

async function extractPdfText(file) {
  const pdfjs = await import(`${PDFJS_BASE}/pdf.min.mjs`);
  pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/pdf.worker.min.mjs`;

  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = [];

  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();

    // Rebuild line structure from glyph positions — a flat join loses the line
    // breaks that make a resume readable to the model.
    let lastY = null;
    let line = [];
    const lines = [];
    for (const item of content.items) {
      if (!item.str) continue;
      const y = Math.round(item.transform[5]);
      if (lastY !== null && Math.abs(y - lastY) > 2) {
        lines.push(line.join(' ').replace(/\s+/g, ' ').trim());
        line = [];
      }
      line.push(item.str);
      lastY = y;
    }
    if (line.length) lines.push(line.join(' ').replace(/\s+/g, ' ').trim());
    pages.push(lines.filter(Boolean).join('\n'));
  }
  return pages.join('\n\n').trim();
}

async function handleFile(file) {
  if (!file) return;
  if (file.size > MAX_FILE_BYTES) {
    setResumeText('', 'That file is over 5 MB. Try exporting a smaller PDF.', false);
    return;
  }

  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  const isTxt = file.type === 'text/plain' || /\.txt$/i.test(file.name);
  if (!isPdf && !isTxt) {
    setResumeText('', 'Please upload a PDF (or a .txt file).', false);
    return;
  }

  setResumeText('', `Reading ${file.name}…`, false);
  $('file-state').classList.remove('bad');

  try {
    const text = isTxt ? await file.text() : await extractPdfText(file);
    if (text.trim().length < 200) {
      setResumeText('', 'Almost no text could be read. If this is a scanned or image-based PDF, paste your resume as text instead.', false);
      return;
    }
    setResumeText(text, file.name, true);
  } catch {
    setResumeText('', 'That PDF could not be read. Try the paste-as-text option below.', false);
  }
}

async function runTailor() {
  const resumeText = state.resumeText || $('resume-paste').value.trim();
  if (resumeText.trim().length < 200) {
    setResumeText('', 'Please provide a bit more of your resume — at least a couple of hundred characters.', false);
    return;
  }

  showStep('working');
  const labels = ['Reading your resume…', 'Comparing it to the role…', 'Rewriting for this job…', 'Almost there…'];
  let i = 0;
  const tick = setInterval(() => {
    i = Math.min(i + 1, labels.length - 1);
    $('working-label').textContent = labels[i];
  }, 4200);

  try {
    const res = await fetch('/api/tailor', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resumeText, job: activeJob }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'The service is unavailable right now.');

    state.tailored = data.tailored;
    renderTailored(data.tailored);
    showStep('result');
    toast('resume tailored');
  } catch (err) {
    $('error-text').textContent = err.message;
    showStep('error');
  } finally {
    clearInterval(tick);
  }
}

function renderTailored(t) {
  const removed = $('removed-note');
  if (t.removedSkills?.length) {
    removed.hidden = false;
    removed.replaceChildren(
      el('b', null, 'Some skills were removed'),
      el('span', null, `These appeared in the draft but not in your resume, so they were stripped out rather than left in as claims you cannot back up: ${t.removedSkills.join(', ')}.`),
    );
  } else {
    removed.hidden = true;
  }

  const gaps = $('gaps-note');
  if (t.gaps?.length) {
    gaps.hidden = false;
    gaps.replaceChildren(el('b', null, 'What this role wants that your resume does not show'));
    const ul = el('ul');
    for (const g of t.gaps) ul.append(el('li', null, g));
    gaps.append(ul);
  } else {
    gaps.hidden = true;
  }

  const changes = $('changes');
  changes.replaceChildren();
  if (t.changeNotes?.length) {
    changes.append(el('h4', null, 'What changed'));
    const ul = el('ul');
    for (const c of t.changeNotes) ul.append(el('li', null, c));
    changes.append(ul);
  }

  const p = $('resume-preview');
  p.replaceChildren();
  if (t.name) p.append(el('div', 'r-name', t.name));
  if (t.contact) p.append(el('div', 'r-contact', t.contact));
  if (t.summary) p.append(el('p', 'r-summary', t.summary));

  for (const section of t.sections ?? []) {
    const sec = el('section', 'r-sec');
    sec.append(el('h5', null, section.heading));
    for (const item of section.items ?? []) {
      const box = el('div', 'r-item');
      const head = el('div', 'r-item-head');
      const left = el('div');
      if (item.title) left.append(el('span', 'r-role', item.title));
      if (item.org) {
        left.append(document.createTextNode(' — '));
        left.append(el('span', 'r-org', item.org));
      }
      head.append(left);
      if (item.dates) head.append(el('span', 'r-dates', item.dates));
      box.append(head);
      if (item.bullets?.length) {
        const ul = el('ul');
        for (const b of item.bullets) ul.append(el('li', null, b));
        box.append(ul);
      }
      sec.append(box);
    }
    p.append(sec);
  }

  if (t.skills?.length) {
    const sec = el('section', 'r-sec');
    sec.append(el('h5', null, 'Skills'));
    sec.append(el('div', 'r-skills', t.skills.join(' · ')));
    p.append(sec);
  }
}

function resumeAsText(t) {
  const out = [t.name, t.contact, '', t.summary, ''];
  for (const s of t.sections ?? []) {
    out.push(String(s.heading || '').toUpperCase(), '');
    for (const item of s.items ?? []) {
      out.push([item.title, item.org].filter(Boolean).join(' — ') + (item.dates ? `  (${item.dates})` : ''));
      for (const b of item.bullets ?? []) out.push(`  • ${b}`);
      out.push('');
    }
  }
  if (t.skills?.length) out.push('SKILLS', '', t.skills.join(' · '));
  return out.filter((l) => l !== undefined).join('\n');
}

/* ---------------- wiring ---------------- */

/**
 * The filter strip scrolls sideways on a phone and is faded at its right edge
 * so the overflow reads as "more this way" rather than as a clipped layout.
 * Once you reach the end there is nothing more to hint at, so the fade is
 * removed — otherwise the last chip looks permanently faded out.
 */
function wireFilterStrip() {
  const strip = document.querySelector('.picks');
  if (!strip) return;
  const sync = () => {
    const atEnd = strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 2;
    strip.classList.toggle('at-end', atEnd);
  };
  strip.addEventListener('scroll', sync, { passive: true });
  addEventListener('resize', sync, { passive: true });
  sync();
}

function wireControls() {
  const rerun = () => applyFilters();
  wireFilterStrip();
  $('q').addEventListener('input', () => {
    $('clear-q').hidden = !$('q').value;
    rerun();
  });
  $('clear-q').addEventListener('click', () => {
    $('q').value = '';
    $('clear-q').hidden = true;
    rerun();
    $('q').focus();
  });
  for (const id of ['f-company', 'f-location', 'f-mode', 'f-sort']) {
    $(id).addEventListener('change', rerun);
  }
  for (const id of ['f-easy']) {
    $(id).addEventListener('click', () => {
      const btn = $(id);
      btn.setAttribute('aria-pressed', btn.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
      rerun();
    });
  }

  $('reset').addEventListener('click', () => {
    $('q').value = '';
    $('clear-q').hidden = true;
    for (const id of ['f-company', 'f-location', 'f-mode']) $(id).value = '';
    $('f-sort').value = 'new';
    $('f-easy').setAttribute('aria-pressed', 'false');
    rerun();
  });
}

function wireTailor() {
  $('tailor-close').addEventListener('click', closeTailor);
  $('tailor-backdrop').addEventListener('click', closeTailor);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('tailor').hidden) closeTailor();
    else if ($('detail-col').classList.contains('open')) closeDetail();
  });

  const zone = $('dropzone');
  const input = $('resume-file');
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });
  input.addEventListener('change', () => handleFile(input.files[0]));

  for (const type of ['dragenter', 'dragover']) {
    zone.addEventListener(type, (e) => { e.preventDefault(); zone.classList.add('over'); });
  }
  for (const type of ['dragleave', 'drop']) {
    zone.addEventListener(type, (e) => { e.preventDefault(); zone.classList.remove('over'); });
  }
  zone.addEventListener('drop', (e) => handleFile(e.dataTransfer?.files?.[0]));

  $('resume-paste').addEventListener('input', (e) => {
    const v = e.target.value.trim();
    state.resumeText = v;
    $('do-tailor').disabled = v.length < 200;
    if (v.length >= 200) setResumeText(v, 'Pasted resume', true);
  });

  $('do-tailor').addEventListener('click', runTailor);
  $('error-retry').addEventListener('click', () => showStep('upload'));
  $('start-over').addEventListener('click', () => {
    state.resumeText = '';
    state.tailored = null;
    $('resume-file').value = '';
    $('resume-paste').value = '';
    $('file-state').hidden = true;
    $('do-tailor').disabled = true;
    showStep('upload');
  });

  $('download-pdf').addEventListener('click', () => {
    toast('choose Save as PDF');
    setTimeout(() => window.print(), 350);
  });

  $('copy-text').addEventListener('click', async () => {
    if (!state.tailored) return;
    try {
      await navigator.clipboard.writeText(resumeAsText(state.tailored));
      toast('copied');
    } catch {
      toast('could not copy');
    }
  });
}

/**
 * Measure the sticky stack (top bar + filter rail) and publish it as a CSS
 * variable.
 *
 * The detail pane sticks below both of them. Its offset used to be a hardcoded
 * guess, so shrinking the header pushed the pane's heading underneath the rail —
 * and the rail's height is not fixed anyway: it wraps to two or three lines
 * depending on viewport width. Measuring is the only version that stays correct.
 */
function syncStickyOffset() {
  const bar = document.querySelector('.bar');
  const rail = document.querySelector('.rail');
  if (!bar || !rail) return;
  // Count only what is actually pinned. Below 680px the rail goes position:static
  // and scrolls away, so summing it there would reserve ~290px of offset that
  // nothing occupies and push the listings down behind a gap.
  const h = [bar, rail]
    .filter((el) => getComputedStyle(el).position === 'sticky')
    .reduce((sum, el) => sum + el.getBoundingClientRect().height, 0);
  document.documentElement.style.setProperty('--stack-h', `${Math.round(h)}px`);
}

/* ---------------- boot ---------------- */

async function init() {
  initTheme();
  wireControls();
  wireTailor();

  syncStickyOffset();
  // The rail rewraps on resize, and again once the web fonts land and change
  // the text metrics — both move the stack height.
  addEventListener('resize', syncStickyOffset, { passive: true });
  document.fonts?.ready.then(syncStickyOffset);

  await loadJobs();
  renderFreshness();
  renderTotal();
  populateFilters();
  applyFilters();

  const hash = location.hash.match(/^#job-(.+)$/);
  const target = hash && state.jobs.find((j) => j.id === hash[1]);
  if (target) {
    selectJob(target.id);
  } else if (state.filtered.length && matchMedia('(min-width: 1001px)').matches) {
    // Fill the detail pane on desktop instead of showing an empty box.
    //
    // The two-pane layout gave 45% of the viewport to the words "PICK A ROLE"
    // until you clicked something — the largest single element on the page was
    // an instruction to do the obvious. Opening the newest role costs nothing,
    // demonstrates what a click does, and puts a second real listing on screen.
    //
    // Desktop only: on mobile the pane is a full-screen overlay, so doing this
    // would land the reader inside a job they never asked for.
    selectJob(state.filtered[0].id, { silent: true });
  }

  setInterval(renderFreshness, 60000);
}

init();
