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
  if (job.workplaceType === 'Remote') ld.jobLocationType = 'TELECOMMUTE';
  if (job.logo) ld.hiringOrganization.logo = `${SITE}${job.logo}`;

  return ld;
}

/** Shared <head>, so every generated page carries the same rules. */
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
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@700;800;900&family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/styles.css">
<link rel="stylesheet" href="/page.css">
${extraLd}<script defer src="/_vercel/insights/script.js"></script>
</head>
<body>
<header class="bar">
  <div class="wrap bar-in">
    <a class="brand" href="/" aria-label="Internzo">
      <span class="scope" aria-hidden="true">
        <svg viewBox="0 0 44 44">
          <circle class="s-ring" cx="22" cy="22" r="20"/><circle class="s-ring" cx="22" cy="22" r="13"/>
          <circle class="s-ring" cx="22" cy="22" r="6"/><circle class="s-dot" cx="22" cy="22" r="2.8"/>
        </svg>
      </span>
      <span class="word">INTERN<em>ZO</em></span>
    </a>
  </div>
</header>
`;
}

const FOOT = `
<footer class="foot">
  <div class="wrap">
    <p>Listings are collected from LinkedIn and from companies' own hiring systems, and link back to the original posting — always apply there. Summaries are written by Internzo; the linked posting is the source of truth.</p>
    <p><a href="/">See every live internship →</a></p>
  </div>
</footer>
</body>
</html>
`;

/** A single job page. */
export function renderJobPage(job) {
  const url = `${SITE}/jobs/${jobSlug(job)}`;
  const apply = safeUrl(job.applyUrl);
  const indexable = isIndexable(job);
  const year = new Date(job.postedAt ?? Date.now()).getFullYear();

  // Title shaped the way people actually search: company, role, the word
  // internship, then India and the year.
  const pageTitle = `${job.company} ${job.title} Internship ${year} — India | Internzo`;
  const description = (job.bullets ?? [])[0]
    ? `${job.company} is hiring: ${job.title}. ${(job.bullets ?? [])[0]}.`
    : `${job.company} is hiring a ${job.title} intern in India.`;

  const facts = [
    ['Company', esc(job.company)],
    ['Role', esc(job.title)],
    job.roleLabel ? ['Focus', esc(job.roleLabel)] : null,
    job.location ? ['Location', esc(job.location)] : null,
    job.workplaceType ? ['Mode', esc(job.workplaceType)] : null,
    job.degreeLevel ? ['Eligibility', esc([job.degreeLevel, job.degreeText].filter(Boolean).join(' · '))] : null,
    job.duration ? ['Duration', esc(job.duration)] : null,
    // Same fallback as validThrough and the JSON-LD above. It was the one date
    // here without it, and toISOString on an Invalid Date throws — which would
    // not lose one page, it would abort writePages and with it the whole publish.
    ['Posted', new Date(job.postedAt ?? job.firstSeenAt ?? Date.now()).toISOString().slice(0, 10)],
  ].filter(Boolean);

  return `${head({
    title: pageTitle,
    description,
    canonical: url,
    indexable,
    extraLd: `<script type="application/ld+json">${jsonLd(jobPostingLd(job, url))}</script>\n`,
  })}
<main class="page">
  <div class="wrap">
    <nav class="crumbs"><a href="/">Home</a> › <a href="/companies/${companySlug(job.company)}">${esc(job.company)}</a> › <span>${esc(job.title)}</span></nav>

    <h1>${esc(job.company)} — ${esc(job.title)}</h1>
    ${job.roleLabel ? `<p class="lede-sub">${esc(job.roleLabel)}</p>` : ''}

    ${apply ? `<a class="apply" href="${apply}" target="_blank" rel="nofollow noopener">Apply on LinkedIn →</a>` : ''}

    <dl class="facts">
      ${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('\n      ')}
    </dl>

    ${(job.bullets ?? []).length ? `<h2>What the role involves</h2>
    <ul class="gist-list">${(job.bullets ?? []).map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}

    ${(job.keySkills ?? []).length ? `<h2>Skills mentioned</h2>
    <div class="skills">${(job.keySkills ?? []).map((s) => `<span class="skill">${esc(s)}</span>`).join('')}</div>` : ''}

    <h2>How to apply</h2>
    <p>Applications go through LinkedIn. Internships in India often collect hundreds of applicants within a day, so applying early matters more than applying perfectly.</p>
    ${apply ? `<a class="apply" href="${apply}" target="_blank" rel="nofollow noopener">Open the original posting →</a>` : ''}

    <p class="tiny">This summary was written by Internzo from the public posting. The linked posting is the source of truth — check it before you apply.</p>
  </div>
</main>
${FOOT}`;
}

/** A company hub — the page with a real chance of ranking for "<company> internship". */
export function renderCompanyPage(company, jobs) {
  const url = `${SITE}/companies/${companySlug(company)}`;
  const live = jobs.filter(isIndexable);
  const indexable = live.length > 0;

  const pageTitle = `${company} Internships in India ${new Date().getFullYear()} — ${live.length} open role${live.length === 1 ? '' : 's'} | Internzo`;
  const description = live.length
    ? `${live.length} live ${company} internship${live.length === 1 ? '' : 's'} in India, updated every 30 minutes. ${live.slice(0, 3).map((j) => j.title).join(', ')}.`
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

  return `${head({
    title: pageTitle,
    description,
    canonical: url,
    indexable,
    extraLd: live.length ? `<script type="application/ld+json">${jsonLd(listLd)}</script>\n` : '',
  })}
<main class="page">
  <div class="wrap">
    <nav class="crumbs"><a href="/">Home</a> › <span>${esc(company)}</span></nav>
    <h1>${esc(company)} internships in India</h1>
    <p class="lede-sub">${live.length} live opening${live.length === 1 ? '' : 's'}, refreshed every 30 minutes from LinkedIn.</p>

    ${live.length ? `<ul class="hub">${live.map((j) => `
      <li>
        <a href="/jobs/${jobSlug(j)}">${esc(j.title)}</a>
        ${j.roleLabel ? `<span class="qual">${esc(j.roleLabel)}</span>` : ''}
        <span class="tiny">${esc(j.location || 'India')}${j.workplaceType ? ` · ${esc(j.workplaceType)}` : ''}</span>
      </li>`).join('')}</ul>`
      : '<p>No live openings right now. New ones appear here within minutes of being posted.</p>'}

    <p><a href="/">Browse every company →</a></p>
  </div>
</main>
${FOOT}`;
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
export function renderCompanyIndex(byCompany) {
  const url = `${SITE}/companies/`;
  const rows = [...byCompany.entries()]
    .map(([company, list]) => ({ company, live: list.filter(isIndexable).length }))
    .filter((r) => r.live > 0)
    .sort((a, b) => b.live - a.live || a.company.localeCompare(b.company));

  const total = rows.reduce((n, r) => n + r.live, 0);

  return `${head({
    title: `Internships in India by company — ${rows.length} companies hiring | Internzo`,
    description: `Browse ${total} live internships across ${rows.length} companies in India. Updated every 30 minutes from LinkedIn.`,
    canonical: url,
    indexable: rows.length > 0,
  })}
<main class="page">
  <div class="wrap">
    <nav class="crumbs"><a href="/">Home</a> › <span>Companies</span></nav>
    <h1>Internships by company</h1>
    <p class="lede-sub">${total} live openings across ${rows.length} companies, refreshed every 30 minutes.</p>
    <ul class="hub">${rows.map((r) => `
      <li>
        <a href="/companies/${companySlug(r.company)}">${esc(r.company)}</a>
        <span class="tiny">${r.live} open role${r.live === 1 ? '' : 's'}</span>
      </li>`).join('')}</ul>
  </div>
</main>
${FOOT}`;
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
export function writePages(jobs, publicDir) {
  const jobsDir = join(publicDir, 'jobs');
  const compDir = join(publicDir, 'companies');
  mkdirSync(jobsDir, { recursive: true });
  mkdirSync(compDir, { recursive: true });

  const wanted = new Set();
  for (const job of jobs) {
    const name = `${jobSlug(job)}.html`;
    wanted.add(join(jobsDir, name));
    writeIfChanged(join(jobsDir, name), renderJobPage(job));
  }

  const byCompany = new Map();
  for (const job of jobs) {
    if (!byCompany.has(job.company)) byCompany.set(job.company, []);
    byCompany.get(job.company).push(job);
  }
  for (const [company, list] of byCompany) {
    const name = `${companySlug(company)}.html`;
    wanted.add(join(compDir, name));
    writeIfChanged(join(compDir, name), renderCompanyPage(company, list));
  }

  // The directory, at /companies/. index.html rather than a slug so the bare
  // directory URL resolves on Vercel and on the dev server alike.
  wanted.add(join(compDir, 'index.html'));
  writeIfChanged(join(compDir, 'index.html'), renderCompanyIndex(byCompany));

  let removed = 0;
  for (const dir of [jobsDir, compDir]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      const full = join(dir, f);
      if (f.endsWith('.html') && !wanted.has(full)) { rmSync(full); removed++; }
    }
  }

  const indexable = jobs.filter(isIndexable).length;
  writeSitemap(jobs, byCompany, publicDir);
  writeRobots(publicDir);
  const feedItems = writeFeeds(jobs, publicDir);
  const homeLinks = writeHomeListings(jobs, publicDir);

  return { jobPages: jobs.length, companyPages: byCompany.size, indexable, removed, feedItems, homeLinks };
}

/** Only indexable URLs go in the sitemap — submitting pages you tell Google to ignore is noise. */
function writeSitemap(jobs, byCompany, publicDir) {
  const now = new Date().toISOString();
  const urls = [
    { loc: `${SITE}/`, priority: '1.0', lastmod: now },
    { loc: `${SITE}/companies/`, priority: '0.7', lastmod: now },
    ...jobs.filter(isIndexable).map((j) => ({
      loc: `${SITE}/jobs/${jobSlug(j)}`,
      priority: '0.8',
      lastmod: new Date(j.postedAt ?? j.firstSeenAt).toISOString(),
    })),
    ...[...byCompany.entries()]
      .filter(([, list]) => list.some(isIndexable))
      .map(([company]) => ({ loc: `${SITE}/companies/${companySlug(company)}`, priority: '0.6', lastmod: now })),
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
