/**
 * Static HTML pages, one per job and one per company, generated at publish time.
 *
 * Why this exists: the main page is an empty <ol> that JavaScript fills from
 * jobs.json, so a crawler that does not run JavaScript sees zero listings. The
 * site is therefore invisible to search — the only traffic it can ever get is
 * links someone shares by hand. These pages are the fix: real HTML, present in
 * the response body, one URL per posting.
 *
 * Two rules shape everything here, and both are about not getting the site
 * penalised rather than about ranking:
 *
 * 1. NEVER republish the employer's description. It is their copyrighted text,
 *    and a page whose body is someone else's posting is precisely what Google's
 *    scraped-content policy is written to demote. Every page is built from our
 *    own material: the bullets, the eligibility read, the skills, the freshness.
 *
 * 2. A page with nothing to say is not published as indexable. A posting whose
 *    employer used a template, or whose description was never captured, has no
 *    bullets and gets noindex — a site carrying dozens of near-empty pages looks
 *    like a content farm, and that judgement is applied site-wide, not page by
 *    page.
 */
import { writeFileSync, readFileSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const SITE = 'https://www.internzo.in';

/** HTML-escape. Company names and titles come from LinkedIn and are not trusted. */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * An href we are willing to put in front of a reader.
 *
 * Escaping alone is not enough here: `javascript:` survives HTML-escaping intact,
 * and the apply URL is whatever the posting carried. Only http(s) links out.
 */
function safeUrl(url) {
  const raw = String(url ?? '').trim();
  return /^https?:\/\//i.test(raw) ? esc(raw) : '';
}

/**
 * Where the Apply button actually goes.
 *
 * The label used to say "Apply on LinkedIn" unconditionally, which was already
 * wrong for every ATS listing — those carry a real Greenhouse or Lever URL — and
 * became wrong for LinkedIn listings too once the redesign started exposing the
 * employer's own application page behind its /safety/go/ interstitial. Telling
 * somebody they are going to LinkedIn and then sending them to Workday is a
 * small lie that costs trust on the one click that matters.
 */
function applyTarget(url) {
  const host = (String(url ?? '').match(/^https?:\/\/([^/?#]+)/i) || [])[1] ?? '';
  return /(^|\.)linkedin\.com$/i.test(host) ? 'LinkedIn' : "the company's site";
}

/** Escape for embedding inside a <script type="application/ld+json"> block. */
function jsonLd(obj) {
  // </script> inside a JSON string would close the tag early; U+2028/9 break older parsers.
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function slugify(s, max = 70) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'role';
}

/**
 * A URL a human can read and a search engine can parse: company, role, then id.
 *
 * The id is slugified too. An ATS id is `ats:greenhouse:token:12345`, and the
 * colons went straight into the filename — which git cannot check out on
 * Windows at all, so cloning this public repo failed there. A LinkedIn id is
 * digits only, so its URLs are unchanged by this.
 *
 * The id is NOT length-capped, though the company and title are. The longest id
 * in the database is a 66-character Workday one — four short of the cap — and
 * two requisitions from a single tenant differ only in their last few
 * characters, so capping the id would eventually collide two live postings onto
 * one page and silently drop one of them.
 */
export function jobSlug(job) {
  return `${slugify(job.company)}-${slugify(job.title)}-${slugify(job.id, Infinity)}`;
}

export function companySlug(company) {
  return slugify(company);
}

/**
 * "Aug 2026" — the granularity a closed listing deserves.
 *
 * Deliberately not a day or a relative age: a past role is context about what an
 * employer hires for, not a live signal, and printing "2 days ago" beside a
 * posting nobody can apply to reads as though it were still open.
 */
export function monthLabel(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}

/** Postings age out of the public file after 14 days; tell Google the same. */
const VALID_DAYS = 14;

function validThrough(job) {
  return new Date((job.postedAt ?? job.firstSeenAt ?? Date.now()) + VALID_DAYS * 86_400_000).toISOString();
}

/** Enough substance to deserve a place in the index. */
export function isIndexable(job) {
  return (job.bullets ?? []).length >= 2;
}

/**
 * Google's JobPosting schema. Getting this wrong is worse than omitting it — a
 * structured-data manual action affects the whole domain — so every field here is
 * one we actually hold, and nothing is invented to fill a slot.
 */
function jobPostingLd(job, url) {
  const description = `<p>${esc(job.roleLabel || job.title)}</p><ul>${
    (job.bullets ?? []).map((b) => `<li>${esc(b)}</li>`).join('')
  }</ul>`;

  const ld = {
    '@context': 'https://schema.org/',
    '@type': 'JobPosting',
    title: job.title,
    description,
    identifier: { '@type': 'PropertyValue', name: job.company, value: String(job.id) },
    datePosted: new Date(job.postedAt ?? job.firstSeenAt ?? Date.now()).toISOString(),
    validThrough: validThrough(job),
    employmentType: 'INTERN',
    hiringOrganization: { '@type': 'Organization', name: job.company },
    // We are not the apply destination — LinkedIn is. Saying otherwise is the
    // single most common way sites earn a JobPosting penalty.
    directApply: false,
    url,
  };

  if (job.location) {
    ld.jobLocation = {
      '@type': 'Place',
      address: { '@type': 'PostalAddress', addressLocality: job.location, addressCountry: 'IN' },
    };
  }
  if (job.workplaceType === 'Remote') {
    ld.jobLocationType = 'TELECOMMUTE';
    // Required alongside TELECOMMUTE. Without it Google cannot tell who may
    // apply, and every remote page was flagged incomplete — six of them.
    ld.applicantLocationRequirements = { '@type': 'Country', name: 'India' };
  }
  if (job.logo) ld.hiringOrganization.logo = `${SITE}${job.logo}`;

  // jobLocation is required unless the role is remote. A posting that has
  // neither cannot make a valid JobPosting, and an invalid one is worse than
  // none — the risk this whole function is written around is a structured-data
  // manual action, which lands on the entire domain rather than one page. Two
  // listings were in that state, both with no location text to work from.
  if (!ld.jobLocation && ld.jobLocationType !== 'TELECOMMUTE') return null;

  return ld;
}

/**
 * Presentation helpers.
 *
 * Everything below is display-only. None of it touches extraction, the store or
 * the JSON the app reads — a value we decline to print is still in the data.
 */

/** Two letters when there is no logo file, so a crest is never an empty box. */
function initials(name) {
  const words = String(name ?? '').replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/);
  return (words.slice(0, 2).map((w) => w[0]).join('') || '?').toUpperCase();
}

/**
 * The logo, with the initials underneath rather than instead.
 *
 * Same reasoning as the card list: if the image 404s the alt text would leave a
 * blank square, so the initials are painted first and the image covers them.
 * 130 of 131 live postings carry a logo, and a page of pure type is the single
 * strongest signal that nobody designed it.
 */
function crest(name, logo, { cls = 'jp-crest', href = '' } = {}) {
  const inner = `${esc(initials(name))}${logo ? `<img src="${esc(logo)}" alt="" loading="lazy" decoding="async" width="80" height="80">` : ''}`;
  return href
    ? `<a class="${cls}" href="${esc(href)}" aria-hidden="true" tabindex="-1">${inner}</a>`
    : `<span class="${cls}" aria-hidden="true">${inner}</span>`;
}

const DAY = 86_400_000;

/** "11 Aug 2026" — IST, because every reader of this site is in India. */
function dayLabel(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}
function isoDay(ms) {
  return ms ? new Date(ms).toISOString().slice(0, 10) : '';
}

/**
 * How old the posting is, as a badge.
 *
 * The label rendered here is the ABSOLUTE date, and page.js rewrites it to
 * "3h ago" on load. That split is deliberate on both sides:
 *
 * - Never `postedText`. It is the string LinkedIn showed at scrape time and it
 *   never ages, so a day-old posting kept reading "4 minutes ago".
 * - Never a relative label baked into the file either. These pages are
 *   regenerated every 30 minutes, so a server-rendered "3h ago" would rewrite
 *   every job page on nearly every run and commit the churn to a public repo.
 *   An absolute date is stable, and the freshness class is applied by script.
 */
function agePill(ms) {
  if (!ms) return '';
  const age = Date.now() - ms;
  const cls = age < DAY ? ' is-hot' : age < 3 * DAY ? ' is-fresh' : '';
  return `<span class="pill${cls}" data-ago="${ms}"><i aria-hidden="true"></i>`
    + `Posted <time datetime="${isoDay(ms)}">${esc(dayLabel(ms))}</time></span>`;
}

/**
 * A stipend we are willing to print.
 *
 * The field is dirty: alongside "₹25,000 / month" it holds bare numbers lifted
 * out of the description — "2,026" is a year that reached the money slot. A
 * figure with no currency and no period is not a stipend, and printing one on a
 * student-facing page is worse than printing nothing.
 */
function stipendText(job) {
  const raw = String(job.stipend ?? '').trim();
  if (!raw) return '';
  return /[₹$]|\brs\b|\blpa\b|\bper\b|\/\s*(month|year|week|total)|\b(month|year|week)ly\b/i.test(raw) ? raw : '';
}

/**
 * A duration we are willing to print.
 *
 * Same problem: "0 to 3 years" and "0-11 months" are experience requirements
 * that landed in the duration slot. Anything opening with a zero, or reading as
 * a range of years, is not how long an internship lasts.
 */
function durationText(job) {
  const raw = String(job.duration ?? '').trim();
  if (!raw) return '';
  if (/^0\b/.test(raw)) return '';
  if (/\d\s*(?:to|[-–—])\s*\d+\s*(?:\+\s*)?(?:years?|yrs?)\b/i.test(raw)) return '';
  return raw;
}

/** "On-site" and "onsite" both occur. One spelling reaches the page. */
function modeText(job) {
  const raw = String(job.workplaceType ?? '').trim();
  if (!raw) return '';
  if (/^on-?site$/i.test(raw)) return 'On-site';
  return raw[0].toUpperCase() + raw.slice(1);
}

/**
 * Competition, in the posting's own terms.
 *
 * LinkedIn phrases this two ways — "42 applicants" and "42 people clicked
 * apply" — and they mean different things, so neither is rewritten into the
 * other. Only the count is lifted out; the rest is dropped rather than guessed.
 */
function applicantsText(job) {
  const raw = String(job.applicants ?? '').trim();
  const n = (raw.match(/([\d,]+)/) || [])[1];
  if (!n) return '';
  if (/clicked/i.test(raw)) return `${n} clicked apply`;
  return `${n} applicant${n === '1' ? '' : 's'}`;
}

/** The badges under the headline: freshness, pay, competition. */
function statusPills(job) {
  const money = stipendText(job);
  return [
    agePill(job.postedAt ?? job.firstSeenAt),
    money
      ? `<span class="pill is-paid"><i aria-hidden="true"></i>${esc(money)}</span>`
      : job.stipendStatus === 'paid' ? '<span class="pill is-paid"><i aria-hidden="true"></i>Paid</span>'
        : job.stipendStatus === 'unpaid' ? '<span class="pill">Unpaid</span>' : '',
    applicantsText(job) ? `<span class="pill">${esc(applicantsText(job))}</span>` : '',
    modeText(job) ? `<span class="pill">${esc(modeText(job))}</span>` : '',
  ].filter(Boolean).join('');
}

/**
 * One role, as a card.
 *
 * The same object serves the "more at this employer" strip, the "just landed"
 * strip page.js builds from jobs.json, and the company hub's live list — so a
 * reader meets one shape everywhere and page.js has one markup to mirror.
 */
function tile(job, { showCompany = true } = {}) {
  const posted = job.postedAt ?? job.firstSeenAt;
  const age = posted ? Date.now() - posted : Infinity;
  const cls = age < DAY ? ' is-hot' : '';
  const meta = [
    // The inner <time> is not decoration: page.js finds the text to rewrite by
    // looking for it, and without one the tile kept its absolute date while the
    // pill above went relative.
    posted ? `<span class="tile-age${age < DAY ? ' is-hot' : age < 3 * DAY ? ' is-fresh' : ''}" data-ago="${posted}"><time datetime="${isoDay(posted)}">${esc(dayLabel(posted))}</time></span>` : '',
    esc(cityOf(job.location)),
    modeText(job) ? esc(modeText(job)) : '',
  ].filter(Boolean).join('<span aria-hidden="true">·</span>');

  return `<a class="tile${cls}" href="/jobs/${jobSlug(job)}">
        ${showCompany ? `<span class="tile-top">${crest(job.company, job.logo, { cls: 'tile-crest' })}<span class="tile-co">${esc(job.company)}</span></span>` : ''}
        <span class="tile-role">${esc(job.title)}</span>
        ${job.roleLabel && !showCompany ? `<span class="tile-co">${esc(job.roleLabel)}</span>` : ''}
        <span class="tile-meta">${meta}</span>
      </a>`;
}

/**
 * "Bengaluru, Karnataka, India" -> "Bengaluru".
 *
 * Tiles only. The full string stays on the job page, where there is room for
 * it; in a tile it pushed the workplace mode onto its own line and stranded the
 * separator dot at the end of the one above. Every listing here is in India, so
 * the state and the country are the two least useful words on the card.
 */
function cityOf(location) {
  const first = String(location ?? '').split(',')[0].trim();
  return first || 'India';
}

/** Newest first, and only ones worth opening. */
function newestFirst(jobs) {
  return [...jobs].sort((a, b) => (b.postedAt ?? b.firstSeenAt ?? 0) - (a.postedAt ?? a.firstSeenAt ?? 0));
}

/** Shared <head> and page chrome, so every generated page carries the same rules. */
function head({ title, description, canonical, indexable, extraLd = '' }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
${indexable ? '' : '<meta name="robots" content="noindex,follow">\n'}<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#0a0a0b" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#f4f3ee" media="(prefers-color-scheme: light)">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Internzo">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${SITE}/og.jpg?v=3">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${SITE}/og.jpg?v=3">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="alternate" type="application/rss+xml" title="Internzo — new internships" href="/feed.xml">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@700;800;900&family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/styles.css">
<link rel="stylesheet" href="/page.css">
${extraLd}<script>try{var t=localStorage.getItem('theme');if(t)document.documentElement.dataset.theme=t}catch(e){}</script>
<script defer src="/page.js"></script>
<script defer src="/_vercel/insights/script.js"></script>
</head>
<body>
<div class="grain" aria-hidden="true"></div>
<header class="bar">
  <div class="wrap bar-in">
    <a class="brand" href="/" aria-label="Internzo">
      <span class="scope" aria-hidden="true">
        <svg viewBox="0 0 44 44">
          <circle class="s-ring" cx="22" cy="22" r="20"/><circle class="s-ring" cx="22" cy="22" r="13"/>
          <circle class="s-ring" cx="22" cy="22" r="6"/>
          <g class="s-sweep"><path d="M22 22 L22 1 A21 21 0 0 1 40 12 Z"/></g>
          <circle class="s-dot" cx="22" cy="22" r="2.8"/>
        </svg>
      </span>
      <span class="word">INTERN<em>ZO</em></span>
    </a>

    <div class="bar-right">
      <a class="alerts" href="https://t.me/internzo" target="_blank" rel="noopener noreferrer">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>
        <span>Get alerts</span>
      </a>
      <button class="ghost-btn" id="theme-toggle" type="button" aria-label="Switch theme">
        <svg class="i-sun" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4"/></svg>
        <svg class="i-moon" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.8 6.8 0 0 0 10.5 10.5z"/></svg>
      </button>
    </div>
  </div>
</header>
`;
}

/**
 * The closing invitation, then the disclaimer.
 *
 * A visitor who arrived from a search for one job and has now read it is at the
 * only moment they will ever consider subscribing. The old foot spent that
 * moment on a sentence about sources of truth. That sentence is still here —
 * underneath, in the footer, where a disclaimer belongs.
 */
function foot({ headline, sub }) {
  return `
<section class="outro">
  <div class="wrap">
    <b>${headline}</b>
    <p>${sub}</p>
    <div class="outro-acts">
      <a class="a-1" href="https://t.me/internzo" target="_blank" rel="noopener noreferrer">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>
        Get every new role on Telegram
      </a>
      <a class="a-2" href="/">Browse all live internships</a>
    </div>
  </div>
</section>
<footer class="foot">
  <div class="wrap">
    <p>Every listing links back to its original posting — always apply there. Summaries are written by Internzo; the linked posting is the source of truth.</p>
    <p class="dim"><a href="/">Home</a> · <a href="/companies/">All companies</a> · <a href="/feed.xml">RSS</a></p>
  </div>
</footer>
</body>
</html>
`;
}

/**
 * A single job page.
 *
 * `siblings` is the employer's other live roles. It is the whole reason this
 * page has a second click in it: somebody who landed here from Google has
 * either applied or decided not to, and in both cases the next useful thing is
 * another role — not the back button. The "just landed" strip below it is
 * filled by page.js from jobs.json rather than baked in, because a baked list
 * of the newest roles would rewrite all ~130 job pages every time one arrived.
 */
export function renderJobPage(job, siblings = []) {
  const url = `${SITE}/jobs/${jobSlug(job)}`;
  const apply = safeUrl(job.applyUrl);
  const indexable = isIndexable(job);
  const posted = job.postedAt ?? job.firstSeenAt ?? Date.now();
  const year = new Date(posted).getFullYear();
  const hub = `/companies/${companySlug(job.company)}`;

  // Title shaped the way people actually search: company, role, the word
  // internship, then India and the year.
  const pageTitle = `${job.company} ${job.title} Internship ${year} — India | Internzo`;
  const description = (job.bullets ?? [])[0]
    ? `${job.company} is hiring: ${job.title}. ${(job.bullets ?? [])[0]}.`
    : `${job.company} is hiring a ${job.title} intern in India.`;

  const facts = [
    job.location ? ['Location', esc(job.location)] : null,
    modeText(job) ? ['Mode', esc(modeText(job))] : null,
    job.roleLabel ? ['Focus', esc(job.roleLabel)] : null,
    job.degreeLevel ? ['Eligibility', esc([job.degreeLevel, job.degreeText].filter(Boolean).join(' · '))] : null,
    durationText(job) ? ['Duration', esc(durationText(job))] : null,
    stipendText(job) ? ['Stipend', `<span class="cash">${esc(stipendText(job))}</span>`] : null,
    // Same fallback as validThrough and the JSON-LD above. It was the one date
    // here without it, and toISOString on an Invalid Date throws — which would
    // not lose one page, it would abort writePages and with it the whole publish.
    ['Posted', `<time datetime="${isoDay(posted)}">${esc(dayLabel(posted))}</time>`],
  ].filter(Boolean);

  const postingLd = jobPostingLd(job, url);
  const where = apply ? applyTarget(apply) : '';
  const applyBtn = (extra = '') => (apply
    ? `<a class="btn-apply${extra}" href="${apply}" target="_blank" rel="nofollow noopener"><span>Apply on ${where}</span><em aria-hidden="true"></em></a>`
    : '');

  const others = newestFirst(siblings.filter((j) => String(j.id) !== String(job.id))).slice(0, 6);

  return `${head({
    title: pageTitle,
    description,
    canonical: url,
    indexable,
    extraLd: postingLd ? `<script type="application/ld+json">${jsonLd(postingLd)}</script>\n` : '',
  })}
<main class="page">
  <div class="wrap">
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href="/">Home</a> <i aria-hidden="true">›</i>
      <a href="${hub}">${esc(job.company)}</a> <i aria-hidden="true">›</i>
      <span>${esc(job.title)}</span>
    </nav>

    <div class="jp-grid">
      <div class="jp-main">
        <header class="jp-hero">
          <div class="jp-id">
            ${crest(job.company, job.logo, { href: hub })}
            <div>
              <a class="jp-co" href="${hub}">${esc(job.company)}</a>
            </div>
          </div>

          <h1>${esc(job.title)}</h1>
          ${job.roleLabel ? `<p class="jp-focus">${esc(job.roleLabel)}</p>` : ''}

          <div class="pills">${statusPills(job)}</div>
        </header>

        ${job.summary ? `<section>
          <h2>The gist</h2>
          <p class="summary">${esc(job.summary)}</p>
        </section>` : ''}

        ${(job.bullets ?? []).length ? `<section>
          <h2>What you would actually do</h2>
          <ul class="do-list">${(job.bullets ?? []).map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
        </section>` : ''}

        ${(job.keySkills ?? []).length ? `<section>
          <h2>Skills mentioned</h2>
          <div class="chips">${(job.keySkills ?? []).map((s) => `<span class="chip">${esc(s)}</span>`).join('')}</div>
        </section>` : ''}

        <section>
          <h2>How to apply</h2>
          <div class="apply-band">
            <p>${apply ? `This one is applied for on <strong>${where}</strong>.` : 'Apply through the original posting.'}
            Internships in India often collect hundreds of applicants within a day, so <strong>applying early matters more than applying perfectly</strong>.</p>
            ${applyBtn()}
          </div>
          <p class="note">This summary was written by Internzo from the public posting, and is not the employer's own wording. The linked posting is the source of truth — check it before you apply.</p>
        </section>
      </div>

      <aside class="jp-side">
        <div class="jp-card">
          ${apply ? `<div class="jp-card-top">
            ${applyBtn()}
            <p class="jp-card-note">Opens ${where} in a new tab. Free — we never ask for a fee.</p>
          </div>` : ''}
          <dl class="facts">
            ${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('\n            ')}
          </dl>
          <a class="jp-sub" href="https://t.me/internzo" target="_blank" rel="noopener noreferrer">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>
            Get roles like this the minute they post
          </a>
        </div>
      </aside>
    </div>

    ${others.length ? `<section class="strip">
      <div class="strip-head">
        <h2>More at ${esc(job.company)}</h2>
        <a class="strip-more" href="${hub}">All ${esc(job.company)} roles →</a>
      </div>
      <div class="tiles">${others.map((j) => tile(j, { showCompany: false })).join('')}</div>
    </section>` : ''}

    <section class="strip" id="fresh" hidden>
      <div class="strip-head">
        <h2>Just landed on Internzo</h2>
        <a class="strip-more" href="/">See all live roles →</a>
      </div>
      <div class="tiles" id="fresh-list"></div>
    </section>
  </div>
</main>

${apply ? `<div class="dock" id="dock" aria-hidden="true">
  <div class="dock-t"><b>${esc(job.title)}</b><span>${esc(job.company)}</span></div>
  <a class="btn-apply" href="${apply}" target="_blank" rel="nofollow noopener" tabindex="-1"><span>Apply</span><em aria-hidden="true"></em></a>
</div>` : ''}
${foot({
    headline: 'Do not let the next one pass you by',
    sub: 'Every engineering internship in India, on the board within minutes of going live.',
  })}`;
}

/**
 * A company hub — the page with a real chance of ranking for "<company>
 * internship".
 *
 * PERMANENT. This page outlives the postings on it. It used to be built only
 * from live jobs and deleted the moment an employer's last one aged out, which
 * 404'd a URL Google had indexed and threw away months of accumulated ranking;
 * some flapped in and out four times. Job pages still expire — Google's
 * JobPosting rules require that — but the hub stays.
 *
 * `past` is what keeps an empty hub from being thin content: a page saying only
 * "no live openings" is a page Google is right to ignore. Past roles are
 * plain text with NO markup and NO links, deliberately — describing an expired
 * posting as a live one is the thing that earns a structured-data manual
 * action, and the whole domain pays for that.
 */
export function renderCompanyPage(company, jobs, past = [], logo = '') {
  const url = `${SITE}/companies/${companySlug(company)}`;
  const live = newestFirst(jobs.filter(isIndexable));
  // Newest first, de-duplicated by title against both the live roles and each
  // other, and capped — a hub is a landing page, not an archive. An employer
  // that reposts the same role monthly would otherwise fill the page with one
  // title twelve times over.
  const seenTitles = new Set(live.map((j) => String(j.title ?? '').toLowerCase()));
  const history = [];
  for (const p of [...past].sort((a, b) => (b.postedAt ?? 0) - (a.postedAt ?? 0))) {
    const key = String(p.title ?? '').toLowerCase();
    if (!key || seenTitles.has(key)) continue;
    seenTitles.add(key);
    history.push(p);
    if (history.length === 12) break;
  }

  // Indexable when there is something worth indexing. A hub with no live roles
  // and nothing to show behind them is exactly the thin page to keep out.
  const indexable = live.length > 0 || history.length >= 2;

  const pageTitle = `${company} Internships in India ${new Date().getFullYear()} — ${live.length} open role${live.length === 1 ? '' : 's'} | Internzo`;
  const description = live.length
    ? `${live.length} live ${company} internship${live.length === 1 ? '' : 's'} in India, updated every 30 minutes. ${live.slice(0, 3).map((j) => j.title).join(', ')}.`
    : history.length
      ? `${company} internships in India. No live openings right now; ${history.length} tracked since we started following them, updated every 30 minutes.`
      : `${company} internships in India, tracked by Internzo and updated every 30 minutes.`;

  const listLd = {
    '@context': 'https://schema.org/',
    '@type': 'ItemList',
    itemListElement: live.map((j, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      url: `${SITE}/jobs/${jobSlug(j)}`,
      name: `${j.company} — ${j.title}`,
    })),
  };

  const cities = [...new Set(live.map((j) => String(j.location ?? '').split(',')[0].trim()).filter(Boolean))];

  return `${head({
    title: pageTitle,
    description,
    canonical: url,
    indexable,
    extraLd: live.length ? `<script type="application/ld+json">${jsonLd(listLd)}</script>\n` : '',
  })}
<main class="page">
  <div class="wrap">
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href="/">Home</a> <i aria-hidden="true">›</i>
      <a href="/companies/">Companies</a> <i aria-hidden="true">›</i>
      <span>${esc(company)}</span>
    </nav>

    <header class="hub-hero">
      ${crest(company, logo)}
      <div class="hub-hero-t">
        <h1>${esc(company)} internships in India</h1>
        <div class="hub-count pills">
          <span class="pill ${live.length ? 'is-fresh' : ''}"><i aria-hidden="true"></i>${live.length} live opening${live.length === 1 ? '' : 's'}</span>
          ${cities.length ? `<span class="pill">${esc(cities.slice(0, 3).join(' · '))}</span>` : ''}
          <span class="pill">Refreshed every 30 min</span>
        </div>
      </div>
    </header>

    <section class="strip">
      <div class="strip-head"><h2>${live.length ? 'Open right now' : 'Open right now'}</h2></div>
      ${live.length
        ? `<div class="tiles">${live.map((j) => tile(j, { showCompany: false })).join('')}</div>`
        : `<div class="empty">
             <b>Nothing open today</b>
             <p>${esc(company)} is on our watchlist, so a new posting appears here within minutes of going live. The Telegram channel will tell you the moment it does.</p>
           </div>`}
    </section>

    ${history.length ? `<section class="strip">
      <div class="strip-head"><h2>Previously posted</h2></div>
      <p class="past-note">Roles ${esc(company)} has advertised since we started tracking them. These listings have closed &mdash; they are here so you can see what this employer hires for, and how often.</p>
      <ul class="past">${history.map((p) => `
        <li>
          <b>${esc(p.title)}</b>
          ${p.roleLabel ? `<span class="qual">${esc(p.roleLabel)}</span>` : ''}
          ${p.postedAt ? `<time datetime="${isoDay(p.postedAt)}">${esc(monthLabel(p.postedAt))}</time>` : ''}
        </li>`).join('')}</ul>
    </section>` : ''}

    <section class="strip" id="fresh" hidden>
      <div class="strip-head">
        <h2>Just landed on Internzo</h2>
        <a class="strip-more" href="/">See all live roles →</a>
      </div>
      <div class="tiles" id="fresh-list"></div>
    </section>
  </div>
</main>
${foot({
    headline: `Know before anyone else applies to ${esc(company)}`,
    sub: 'One message the minute a new engineering internship goes live in India. No email, no account.',
  })}`;
}

/**
 * The directory of every company hub.
 *
 * The sitemap tells Google these URLs exist, but a sitemap is a hint, not a crawl
 * path — and the homepage is an empty list filled by JavaScript, so a crawler
 * arriving there finds no links to follow at all. This page is the bridge: one
 * static link from the homepage reaches it, and from here every company hub and
 * then every job page is reachable by following ordinary anchors.
 */
export function renderCompanyIndex(byCompany, pastByCompany = new Map(), logos = new Map()) {
  const url = `${SITE}/companies/`;
  // Employers with no live role are still listed, below the ones hiring. This
  // page is the only crawl path to the hubs — the homepage list is built by
  // JavaScript — so a hub missing from here is a hub Google reaches through the
  // sitemap alone, which is a hint rather than a link.
  const rows = [...new Set([...byCompany.keys(), ...pastByCompany.keys()])]
    .map((company) => ({
      company,
      live: (byCompany.get(company) ?? []).filter(isIndexable).length,
      past: (pastByCompany.get(company) ?? []).length,
    }))
    .filter((r) => r.live > 0 || r.past >= 2)
    .sort((a, b) => b.live - a.live || a.company.localeCompare(b.company));

  const hiring = rows.filter((r) => r.live > 0).length;
  const total = rows.reduce((n, r) => n + r.live, 0);

  const card = (r) => `<a class="dir-card${r.live ? '' : ' is-quiet'}" href="/companies/${companySlug(r.company)}" data-name="${esc(r.company.toLowerCase())}">
        ${crest(r.company, logos.get(r.company), { cls: 'tile-crest' })}
        <span class="dir-t">
          <span class="dir-name">${esc(r.company)}</span>
          <span class="dir-n">${r.live ? `${r.live} open role${r.live === 1 ? '' : 's'}` : `no live roles · ${r.past} tracked`}</span>
        </span>
      </a>`;

  const open = rows.filter((r) => r.live > 0);
  const quiet = rows.filter((r) => r.live === 0);

  return `${head({
    title: `Internships in India by company — ${hiring} companies hiring | Internzo`,
    description: `Browse ${total} live internships across ${hiring} companies in India, plus every employer we track. Updated every 30 minutes.`,
    canonical: url,
    indexable: rows.length > 0,
  })}
<main class="page">
  <div class="wrap">
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href="/">Home</a> <i aria-hidden="true">›</i>
      <span>Companies</span>
    </nav>

    <header class="dir-hero">
      <h1>Internships by company</h1>
      <div class="stats">
        <div class="stat"><b>${total}</b><span>Live openings</span></div>
        <div class="stat"><b>${hiring}</b><span>Hiring right now</span></div>
        <div class="stat"><b>${rows.length}</b><span>Employers tracked</span></div>
      </div>
      <div class="filter" id="filter">
        <label>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/></svg>
          <input type="search" id="filter-input" placeholder="Filter ${rows.length} employers — try “Qualcomm”" aria-label="Filter companies">
        </label>
      </div>
    </header>

    <p class="dir-none" id="dir-none">No employer matches that. Try a shorter word.</p>

    <section class="strip" data-group>
      <div class="strip-head"><h2>Hiring right now</h2></div>
      <div class="dir">${open.map(card).join('')}</div>
    </section>

    ${quiet.length ? `<section class="strip" data-group>
      <div class="strip-head"><h2>Tracked, nothing open today</h2></div>
      <div class="dir">${quiet.map(card).join('')}</div>
    </section>` : ''}
  </div>
</main>
${foot({
    headline: 'Never refresh this page again',
    sub: 'Every new engineering internship in India, pushed to Telegram within minutes of going live.',
  })}`;
}

function writeIfChanged(path, contents) {
  writeFileSync(path, contents);
}

/**
 * Put the listings into the homepage's HTML.
 *
 * This is the fix for the thing Search Console actually reported. Every job
 * page came back "URL is unknown to Google", with both discovery routes empty:
 * "No referring sitemaps detected" and "Referring page: None detected". The
 * homepage is the one URL Google had crawled, and it shipped an empty <ol> that
 * JavaScript filled afterwards — so a crawler arriving there found marketing
 * copy, one link to /companies/, and no way to reach a single listing. Crawl
 * depth to a job page was three on a domain with no authority; now it is one.
 *
 * Every live job is listed rather than a sample, because the point is that each
 * job page gains a referring link. app.js calls replaceChildren() on this list,
 * so the moment the script runs these rows are gone and the interactive board
 * takes over — no duplication, and nothing here is hidden from users to feed a
 * crawler something different.
 *
 * Only the region between the two markers is touched. If they are missing the
 * file is left completely alone: silently rewriting a hand-maintained page is a
 * far worse failure than not adding links to it.
 */
function writeHomeListings(jobs, publicDir) {
  const path = join(publicDir, 'index.html');
  if (!existsSync(path)) return 0;

  const html = readFileSync(path, 'utf8');
  const open = '<!--LISTINGS-->';
  const close = '<!--/LISTINGS-->';
  const from = html.indexOf(open);
  const to = html.indexOf(close);
  if (from === -1 || to === -1 || to < from) {
    console.warn('  index.html has no <!--LISTINGS--> markers — homepage links not written.');
    return 0;
  }

  const rows = jobs.map((j) => {
    const facts = [j.location, j.workplaceType]
      .filter(Boolean).map((s) => esc(s)).join(' · ');
    return `<li><a href="/jobs/${jobSlug(j)}">${esc(j.company)} — ${esc(j.title)}</a>`
      + (facts ? `<span class="tiny"> ${facts}</span>` : '')
      + '</li>';
  }).join('\n');

  const next = `${html.slice(0, from + open.length)}\n${rows}\n${html.slice(to)}`;
  if (next !== html) writeFileSync(path, next);
  return jobs.length;
}

/**
 * Regenerate every page. Stale files are removed rather than left to rot: a
 * posting that aged out of jobs.json must not keep a live URL, or the site
 * accumulates pages for jobs nobody can apply to any more.
 *
 * @returns {{jobPages: number, companyPages: number, indexable: number, removed: number}}
 */
/**
 * company name -> logo path, for the pages that have no job object to read it
 * from.
 *
 * A live posting carries its own `logo`, so that is preferred. A hub whose
 * employer is not hiring today has no posting at all, and a hub is permanent —
 * so the logos directory is scanned by slug as a fallback and the crest
 * survives the last opening ageing out. Extensions vary (.jpg and .png both
 * occur), which is why this reads the directory rather than guessing a name.
 *
 * Returns a Map-shaped object so callers can treat it as one.
 */
function companyLogos(jobs, publicDir) {
  const live = new Map();
  for (const job of jobs) if (job.company && job.logo) live.set(job.company, job.logo);

  const bySlug = new Map();
  const dir = join(publicDir, 'logos');
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (/\.(jpe?g|png|webp|svg)$/i.test(f)) bySlug.set(f.replace(/\.[a-z0-9]+$/i, ''), f);
    }
  }

  return {
    get(company) {
      const known = live.get(company);
      if (known) return known;
      const file = bySlug.get(companySlug(company));
      return file ? `/logos/${file}` : '';
    },
  };
}

export function writePages(jobs, publicDir, history = []) {
  const jobsDir = join(publicDir, 'jobs');
  const compDir = join(publicDir, 'companies');
  mkdirSync(jobsDir, { recursive: true });
  mkdirSync(compDir, { recursive: true });

  const byCompany = new Map();
  for (const job of jobs) {
    if (!byCompany.has(job.company)) byCompany.set(job.company, []);
    byCompany.get(job.company).push(job);
  }

  // Grouped BEFORE the job pages are written, not after, because each job page
  // now carries its employer's other live roles — the only second click a
  // visitor who arrived from a search has.
  const wanted = new Set();
  for (const job of jobs) {
    const name = `${jobSlug(job)}.html`;
    wanted.add(join(jobsDir, name));
    writeIfChanged(join(jobsDir, name), renderJobPage(job, byCompany.get(job.company) ?? []));
  }

  const logos = companyLogos(jobs, publicDir);

  // Every employer we have ever published, not just the ones hiring today. This
  // union is what makes a hub permanent: a company drops out of `byCompany` the
  // moment its last posting ages out, and before this the file was then deleted.
  const pastByCompany = new Map();
  for (const p of history) {
    if (!p.company) continue;
    if (!pastByCompany.has(p.company)) pastByCompany.set(p.company, []);
    pastByCompany.get(p.company).push(p);
  }

  const allCompanies = new Set([...byCompany.keys(), ...pastByCompany.keys()]);
  for (const company of allCompanies) {
    const name = `${companySlug(company)}.html`;
    wanted.add(join(compDir, name));
    writeIfChanged(join(compDir, name),
      renderCompanyPage(company, byCompany.get(company) ?? [], pastByCompany.get(company) ?? [],
        logos.get(company) ?? ''));
  }

  // The directory, at /companies/. index.html rather than a slug so the bare
  // directory URL resolves on Vercel and on the dev server alike.
  wanted.add(join(compDir, 'index.html'));
  writeIfChanged(join(compDir, 'index.html'), renderCompanyIndex(byCompany, pastByCompany, logos));

  let removed = 0;
  for (const dir of [jobsDir, compDir]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      const full = join(dir, f);
      if (f.endsWith('.html') && !wanted.has(full)) { rmSync(full); removed++; }
    }
  }

  const indexable = jobs.filter(isIndexable).length;
  writeSitemap(jobs, byCompany, publicDir, pastByCompany);
  writeRobots(publicDir);
  const feedItems = writeFeeds(jobs, publicDir);
  const homeLinks = writeHomeListings(jobs, publicDir);

  return { jobPages: jobs.length, companyPages: allCompanies.size, indexable, removed, feedItems, homeLinks };
}

/** Only indexable URLs go in the sitemap — submitting pages you tell Google to ignore is noise. */
function writeSitemap(jobs, byCompany, publicDir, pastByCompany = new Map()) {
  const now = new Date().toISOString();
  const urls = [
    { loc: `${SITE}/`, priority: '1.0', lastmod: now },
    { loc: `${SITE}/companies/`, priority: '0.7', lastmod: now },
    ...jobs.filter(isIndexable).map((j) => ({
      loc: `${SITE}/jobs/${jobSlug(j)}`,
      priority: '0.8',
      lastmod: new Date(j.postedAt ?? j.firstSeenAt).toISOString(),
    })),
    // Hubs stay in the sitemap whether or not the employer is hiring today.
    // Dropping a URL from the sitemap the week it has no live roles, then
    // re-adding it, tells Google the page is unstable — which is most of the
    // damage the old delete-and-recreate cycle did. Listed once per company,
    // with the same "enough substance to index" bar the page itself applies.
    ...[...new Set([...byCompany.keys(), ...pastByCompany.keys()])]
      .filter((company) => (byCompany.get(company) ?? []).some(isIndexable)
        || (pastByCompany.get(company) ?? []).length >= 2)
      .map((company) => ({ loc: `${SITE}/companies/${companySlug(company)}`, priority: '0.6', lastmod: now })),
  ];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${esc(u.loc)}</loc><lastmod>${u.lastmod}</lastmod><priority>${u.priority}</priority></url>`).join('\n')}
</urlset>
`;
  writeFileSync(join(publicDir, 'sitemap.xml'), xml);
}

function writeRobots(publicDir) {
  writeFileSync(join(publicDir, 'robots.txt'), `User-agent: *
Allow: /

Sitemap: ${SITE}/sitemap.xml
`);
}

/**
 * RSS and JSON Feed.
 *
 * The site's whole promise is being early, and that only pays off if someone
 * looks. A visitor who checks twice a week gets nothing from a 15-minute
 * refresh. A feed inverts that — new roles arrive wherever they already read
 * things — and it costs nothing to run: two more static files written by the
 * same publish step, with no accounts, no email service and no backend, so the
 * two-process design is untouched.
 *
 * Newest 50 only. A feed reader wants what is new, not a catalogue, and every
 * item here is also a page a crawler can reach through the sitemap.
 */
function writeFeeds(jobs, publicDir) {
  const recent = [...jobs]
    .sort((a, b) => (b.postedAt ?? b.firstSeenAt ?? 0) - (a.postedAt ?? a.firstSeenAt ?? 0))
    .slice(0, 50);

  const now = new Date().toUTCString();
  const facts = (j) => [
    j.company && `Company: ${j.company}`,
    j.location && `Location: ${j.location}`,
    j.duration && `Duration: ${j.duration}`,
  ].filter(Boolean).join(' · ');

  // Our own summary only — never the employer's description. Same rule as the
  // job pages: republishing their copyrighted text is the one thing that would
  // turn a useful feed into a liability.
  const body = (j) => [facts(j), ...(j.bullets ?? []).map((b) => `• ${b}`)].filter(Boolean).join('\n');

  const items = recent.map((j) => {
    const url = `${SITE}/jobs/${jobSlug(j)}`;
    const date = new Date(j.postedAt ?? j.firstSeenAt ?? Date.now());
    return `  <item>
    <title>${esc(`${j.title} — ${j.company ?? ''}`.trim())}</title>
    <link>${esc(url)}</link>
    <guid isPermaLink="true">${esc(url)}</guid>
    <pubDate>${date.toUTCString()}</pubDate>
    <description>${esc(body(j))}</description>
  </item>`;
  }).join('\n');

  writeFileSync(join(publicDir, 'feed.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>Internzo — engineering internships in India</title>
  <link>${SITE}/</link>
  <atom:link href="${SITE}/feed.xml" rel="self" type="application/rss+xml"/>
  <description>New engineering internships, listed within minutes of going live.</description>
  <language>en-in</language>
  <lastBuildDate>${now}</lastBuildDate>
${items}
</channel>
</rss>
`);

  writeFileSync(join(publicDir, 'feed.json'), `${JSON.stringify({
    version: 'https://jsonfeed.org/version/1.1',
    title: 'Internzo — engineering internships in India',
    home_page_url: `${SITE}/`,
    feed_url: `${SITE}/feed.json`,
    description: 'New engineering internships, listed within minutes of going live.',
    items: recent.map((j) => ({
      id: `${SITE}/jobs/${jobSlug(j)}`,
      url: `${SITE}/jobs/${jobSlug(j)}`,
      title: `${j.title} — ${j.company ?? ''}`.trim(),
      content_text: body(j),
      date_published: new Date(j.postedAt ?? j.firstSeenAt ?? Date.now()).toISOString(),
      ...(j.company ? { authors: [{ name: j.company }] } : {}),
    })),
  }, null, 2)}\n`);

  return recent.length;
}
