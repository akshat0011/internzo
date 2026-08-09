/**
 * Applicant-tracking-system job boards.
 *
 * Why this exists alongside the LinkedIn scraper: LinkedIn is downstream. A
 * company posts to its ATS, and the LinkedIn listing is a copy that appears
 * later. Reading the ATS directly is earlier, structured, and — unlike the
 * scraper — uses endpoints that exist to be consumed, so there is no browser, no
 * selector rot, no rate-limit guard and no terms-of-service problem.
 *
 * Every provider here is unauthenticated and free. They are the public job-board
 * endpoints that a company's own careers page calls to render itself.
 *
 * Workday is deliberately NOT in this file. It has no public job-board API; what
 * it has is the undocumented endpoint its careers pages call, which needs a
 * per-company tenant and site rather than a name slug, and which can change
 * without notice. It belongs behind its own adapter with its own discovery, not
 * mixed in with providers that publish a contract.
 */
import { log } from './logger.js';

/**
 * Generous on purpose. Eight seconds looked reasonable and silently cost us an
 * entire employer: Lever returns Paytm's whole board — 236 postings with full
 * descriptions — as a single 3.7 MB response that takes about 18 seconds. Every
 * poll aborted mid-download, getJson returned null, and the board was counted as
 * unreadable rather than slow. Nothing distinguished the two, so it never looked
 * like a bug.
 *
 * A timeout is not retried (only 429 is), so the cost of the higher ceiling is
 * bounded: one slow board holds one of the eight concurrent slots and nothing
 * more. Boards that are genuinely dead answer 404 immediately and are unaffected.
 *
 * 45s rather than the 26s Paytm actually needs, because that measurement is of a
 * good day on a good connection and the failure it guards against is silent.
 */
const TIMEOUT_MS = 45_000;
const UA = 'internzo (+https://www.internzo.in)';

async function getJson(url, { method = 'GET', body = null, headers = {}, retriesLeft = 2 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': UA,
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    // 429 means slow down, not "this board does not exist". Collapsing the two
    // silently dropped three Workable boards from every poll.
    if (res.status === 429 && retriesLeft > 0) {
      clearTimeout(timer);
      const wait = Number(res.headers.get('retry-after')) * 1000 || 2000 * (3 - retriesLeft + 1);
      await new Promise((r) => setTimeout(r, Math.min(wait, 10_000)));
      return getJson(url, { method, body, headers, retriesLeft: retriesLeft - 1 });
    }
    if (!res.ok) return null;
    // A Workday site name that does not exist answers 200 with the careers-page
    // HTML rather than an error, so a non-JSON body is a failure too.
    const text = await res.text();
    try { return JSON.parse(text); } catch { return null; }
  } catch (err) {
    // Say so when a board was abandoned rather than absent. Collapsing "timed
    // out" into the same silent null as "does not exist" is exactly what hid
    // Paytm — 236 postings, aborted on every poll for as long as the board has
    // existed, and indistinguishable from a company that simply has no board.
    if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
      console.warn(`  ats: timed out after ${TIMEOUT_MS / 1000}s — ${url.slice(0, 90)}`);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Normalised shape every adapter returns, so the rest of the app sees one thing. */
function job({ id, title, location, url, postedAt, department, remote, description, externalPath }) {
  return {
    id: String(id),
    title: String(title ?? '').trim(),
    location: location ? String(location).trim() : null,
    url,
    postedAt: postedAt ? new Date(postedAt).getTime() : null,
    department: department ?? null,
    remote: remote ?? null,
    description: description ? stripHtml(description) : null,
    externalPath: externalPath ?? null,
  };
}

/**
 * These descriptions arrive as HTML. Everything downstream — the stipend and
 * duration parsers, the summariser, the enrichment prompt — expects readable
 * text, and feeding it markup makes all of them worse. Block-level tags become
 * newlines so bullet lists survive as lines rather than collapsing into one
 * run-on paragraph.
 */
function stripHtml(html) {
  return String(html)
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#39;|&rsquo;/gi, "'").replace(/&quot;|&ldquo;|&rdquo;/gi, '"')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Name → candidate tokens.
 *
 * Ordered most-likely first, and deliberately conservative: a token that is too
 * generic will match somebody else's board, and a wrong employer on a public
 * site is worse than a missing one. "India", "Technologies", "Group" and the
 * like are stripped because they are noise in a slug, but a bare first word is
 * never tried on its own for the same reason.
 */
export function candidateTokens(name) {
  const base = String(name)
    .replace(/&/g, ' and ')
    .replace(/\b(pvt|private|ltd|limited|inc|llc|corp|corporation|plc|gmbh)\b/gi, ' ')
    .trim();

  const trimmed = base.replace(/\b(india|technologies|technology|labs|group|global|solutions|services|systems|software)\b/gi, ' ').trim();

  const forms = new Set();
  for (const v of [base, trimmed]) {
    if (!v) continue;
    forms.add(v.toLowerCase().replace(/[^a-z0-9]+/g, ''));
    forms.add(v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
  }
  return [...forms].filter((t) => t.length >= 3);
}

/** Loose match used to confirm a board really belongs to the company we asked for. */
function looksLikeSameCompany(a, b) {
  const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

/**
 * Is this an unclaimed demo board rather than a real employer's?
 *
 * Several of these platforms hand out a subdomain to anyone who signs up, and
 * plenty of those trials were started on a big company's name and abandoned
 * full of the template postings the product ships with. A real case from this
 * watchlist: accenture.recruitee.com serves "Senior Marketer (Sample)" and one
 * sales role in Amsterdam. Publishing that as Accenture would put a fabricated
 * job under a real employer's name on a public site, which is the worst class of
 * error this project can make.
 */
function looksLikeDemoBoard(jobs) {
  if (!jobs?.length) return true;
  const sampleish = jobs.filter((j) => /\((sample|demo|example)\)|^sample\b|^demo\b/i.test(j.title ?? '')).length;
  // Any sample posting at all is damning on a small board; on a large one it is
  // more likely to be a genuine oddity.
  return sampleish > 0 && sampleish / jobs.length >= 0.2;
}

/**
 * Confirm a board using the company name the POSTINGS carry.
 *
 * Stronger than checking the token, which we generated from the name ourselves
 * and so proves nothing. Used where the provider has no board-metadata endpoint
 * but does stamp each posting with the employer.
 */
/**
 * Does this board token plausibly belong to this company?
 *
 * Exact-match against the generated tokens was too strict in two ways that cost
 * real boards: it compared case-sensitively, so Ashby's "Clerk" failed against
 * "clerk"; and it demanded equality, so "sarvam" failed against "Sarvam AI".
 *
 * The prefix rule is length-bounded on purpose. Allowing any prefix would let
 * "navi" match "navitas" — a different company — which is the false positive
 * this whole verification layer exists to prevent. Five characters is short
 * enough to admit "sarvam" and long enough to exclude the short brand names
 * where collisions actually happen.
 */
function tokenMatchesCompany(token, companyName) {
  const t = String(token).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!t) return false;
  if (candidateTokens(companyName).some((c) => c.replace(/[^a-z0-9]/g, '') === t)) return true;
  const name = String(companyName).toLowerCase().replace(/[^a-z0-9]/g, '');
  return t.length >= 5 && name.startsWith(t);
}

function verifyFromPostings(rawJobs, companyName, pick) {
  const names = (rawJobs ?? []).map(pick).filter(Boolean);
  if (!names.length) return false;
  return names.some((n) => looksLikeSameCompany(n, companyName));
}

/**
 * Each provider exposes:
 *   list(token)   -> normalised jobs, or null when the board does not exist
 *   verify(token, companyName) -> true when the board is provably that company
 *
 * `verify` matters more than it looks. A short token like "navi" or "meesho"
 * will happily resolve to somebody else's board, and publishing another
 * company's postings under a watchlist name is precisely the failure the publish
 * step already guards against. Where a provider exposes the board's own name we
 * check it; where it does not, discovery falls back to requiring an exact token.
 */
export const PROVIDERS = {
  greenhouse: {
    label: 'Greenhouse',
    async list(token) {
      const j = await getJson(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`);
      if (!Array.isArray(j?.jobs)) return null;
      return j.jobs.map((p) => job({
        id: p.id,
        title: p.title,
        location: p.location?.name,
        url: p.absolute_url,
        postedAt: p.updated_at ?? p.first_published,
        department: p.departments?.[0]?.name,
        description: p.content,
      }));
    },
    async verify(token, companyName) {
      const j = await getJson(`https://boards-api.greenhouse.io/v1/boards/${token}`);
      return j?.name ? looksLikeSameCompany(j.name, companyName) : false;
    },
  },

  lever: {
    label: 'Lever',
    async list(token) {
      const j = await getJson(`https://api.lever.co/v0/postings/${token}?mode=json`);
      if (!Array.isArray(j)) return null;
      return j.map((p) => job({
        id: p.id,
        title: p.text,
        location: p.categories?.location,
        url: p.hostedUrl ?? p.applyUrl,
        postedAt: p.createdAt,
        department: p.categories?.team,
        remote: p.workplaceType,
        description: p.descriptionPlain ?? p.description,
      }));
    },
    // Lever has no board-metadata endpoint, so the token itself is the evidence.
    async verify(token, companyName) {
      return tokenMatchesCompany(token, companyName);
    },
  },

  ashby: {
    label: 'Ashby',
    async list(token) {
      const j = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${token}`);
      if (!Array.isArray(j?.jobs)) return null;
      return j.jobs.map((p) => job({
        id: p.id,
        title: p.title,
        location: p.location,
        url: p.jobUrl,
        postedAt: p.publishedAt,
        department: p.department,
        remote: p.isRemote ? 'Remote' : null,
        description: p.descriptionPlain ?? p.descriptionHtml,
      }));
    },
    async verify(token, companyName) {
      return tokenMatchesCompany(token, companyName);
    },
  },

  smartrecruiters: {
    label: 'SmartRecruiters',
    async list(token) {
      const j = await getJson(`https://api.smartrecruiters.com/v1/companies/${token}/postings?limit=100`);
      if (!Array.isArray(j?.content)) return null;
      return j.content.map((p) => job({
        id: p.id,
        title: p.name,
        location: [p.location?.city, p.location?.country].filter(Boolean).join(', '),
        url: `https://jobs.smartrecruiters.com/${token}/${p.id}`,
        postedAt: p.releasedDate,
        department: p.department?.label,
        remote: p.location?.remote ? 'Remote' : null,
      }));
    },
    async verify(token, companyName) {
      const j = await getJson(`https://api.smartrecruiters.com/v1/companies/${token}/postings?limit=10`);
      return verifyFromPostings(j?.content, companyName, (p) => p?.company?.name);
    },
  },

  workable: {
    label: 'Workable',
    async list(token) {
      const j = await getJson(`https://apply.workable.com/api/v1/widget/accounts/${token}?details=true`);
      if (!Array.isArray(j?.jobs)) return null;
      return j.jobs.map((p) => job({
        id: p.shortcode,
        title: p.title,
        location: [p.city, p.country].filter(Boolean).join(', '),
        url: p.url ?? p.application_url,
        postedAt: p.published_on,
        department: p.department,
        remote: p.telecommuting ? 'Remote' : null,
        description: p.description,
      }));
    },
    async verify(token, companyName) {
      const j = await getJson(`https://apply.workable.com/api/v1/widget/accounts/${token}`);
      return j?.name ? looksLikeSameCompany(j.name, companyName) : false;
    },
  },

  recruitee: {
    label: 'Recruitee',
    async list(token) {
      const j = await getJson(`https://${token}.recruitee.com/api/offers/`);
      if (!Array.isArray(j?.offers)) return null;
      return j.offers.map((p) => job({
        id: p.id,
        title: p.title,
        location: [p.city, p.country].filter(Boolean).join(', '),
        url: p.careers_url ?? p.careers_apply_url,
        postedAt: p.published_at,
        department: p.department,
        remote: p.remote ? 'Remote' : null,
        description: p.description,
      }));
    },
    async verify(token, companyName) {
      const j = await getJson(`https://${token}.recruitee.com/api/offers/`);
      if (looksLikeDemoBoard((j?.offers ?? []).map((o) => ({ title: o.title })))) return false;
      return verifyFromPostings(j?.offers, companyName, (o) => o?.company_name);
    },
  },

  personio: {
    label: 'Personio',
    async list(token) {
      const j = await getJson(`https://${token}.jobs.personio.de/search.json`);
      if (!Array.isArray(j)) return null;
      return j.map((p) => job({
        id: p.id,
        title: p.name,
        location: p.office,
        url: `https://${token}.jobs.personio.de/job/${p.id}`,
        postedAt: p.createdAt,
        department: p.department,
      }));
    },
    async verify(token, companyName) {
      return tokenMatchesCompany(token, companyName);
    },
  },
};

/**
 * Workday, kept apart from the rest on purpose.
 *
 * It publishes no job-board API. What works is the endpoint its own careers page
 * calls, and it needs three things a company name cannot give you: a tenant, a
 * datacentre number (wd1, wd3, wd5, wd12…) and a site name that is entirely
 * bespoke — NVIDIAExternalCareerSite, external_experienced, External_Career_Site.
 *
 * Guessing those is not an option, and I measured why rather than assuming:
 * `zzzznotarealcompany.wd5` answers 422 exactly like a real tenant does, so
 * there is no signal to search against. The token here is therefore always
 * discovered from a real careers-page link, never constructed, and is stored as
 * "tenant:wd:site".
 */
PROVIDERS.workday = {
  label: 'Workday',
  async list(token) {
    const [tenant, wd, site] = String(token).split(':');
    if (!tenant || !wd || !site) return null;
    const j = await getJson(
      `https://${tenant}.${wd}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`,
      { method: 'POST', body: { appliedFacets: {}, limit: 20, offset: 0, searchText: '' } },
    );
    if (!Array.isArray(j?.jobPostings)) return null;
    return j.jobPostings.map((p) => job({
      id: p.bulletFields?.[0] ?? p.externalPath,
      title: p.title,
      location: p.locationsText,
      url: `https://${tenant}.${wd}.myworkdayjobs.com/en-US/${site}${p.externalPath}`,
      // Left null here on purpose: the list only offers "Posted 3 Days Ago".
      // detail() replaces it with the real startDate for the few postings kept.
      postedAt: null,
      externalPath: p.externalPath,
    }));
  },
  /**
   * "It came off their careers page, so it is theirs" is not sound, and a real
   * crawl proved it: Discover resolved to capitalone:wd12:Capital_One, and Plum
   * to an unrelated `pacs` tenant. Following links lands on the wrong page often
   * enough that the tenant has to be checked against the company name.
   *
   * Internal boards are rejected outright. A site called Internal_Careers is for
   * existing employees; publishing it would send students to a page they cannot
   * apply through.
   */
  async verify(token, companyName) {
    const [tenant, , site] = String(token).split(':');
    if (!tenant || !site) return false;
    if (/internal/i.test(site)) return false;
    return looksLikeSameCompany(tenant, companyName);
    // Deliberately NOT calling list() to confirm the board reads.
    //
    // That was the obvious next check and it would have been a disaster: when
    // Workday rate-limits us it answers 200 with the careers-page HTML for every
    // tenant, including ones that worked minutes earlier. A verifier that
    // required a readable board would then delete all 38 Workday boards during a
    // block that clears on its own. Unreadable-right-now and does-not-exist are
    // different, and this file has been bitten by conflating them before.
  },

  /**
   * Workday's list gives neither a description nor a usable date — `postedOn`
   * is the phrase "Posted 2 Days Ago". The per-job endpoint gives both, and its
   * `startDate` is an actual calendar date, which beats parsing English.
   *
   * Called only for postings that already passed every filter, so a board of
   * 2,000 roles costs one extra request per internship rather than 2,000.
   */
  async detail(token, externalPath) {
    const [tenant, wd, site] = String(token).split(':');
    if (!externalPath) return null;
    const j = await getJson(`https://${tenant}.${wd}.myworkdayjobs.com/wday/cxs/${tenant}/${site}${externalPath}`);
    const info = j?.jobPostingInfo;
    if (!info) return null;
    return {
      description: info.jobDescription ? stripHtml(info.jobDescription) : null,
      postedAt: info.startDate ? new Date(info.startDate).getTime() : null,
    };
  },
};

/**
 * Amazon — the first of the first-party boards.
 *
 * The giants do not use a third-party ATS, which is why discovery kept coming
 * back empty for them: probing Greenhouse and Lever tokens cannot turn up a
 * board that was never there. Eighteen of the thirty biggest names on the
 * watchlist are in this position. They are marked `firstParty` and seeded into
 * company_ats directly instead of being discovered, because there is no token to
 * guess — the endpoint is fixed and known.
 *
 * The token is the ISO country code to restrict the search to, and that is the
 * other difference from a real ATS board. There is no "whole board" to fetch
 * here: Amazon lists 2,621 roles in India alone, and pulling all of them every
 * quarter hour to find a handful of internships would be both slow and rude. So
 * this narrows at the source and lets poll-ats.js filter afterwards exactly as
 * it does for every other provider.
 *
 * Three queries, not one. Amazon's search does not stem — `intern` returns 13
 * results and `internship` returns 423 — so a single term silently misses most
 * of the board. `apprentice` and `co-op` return nothing in India and are left
 * out rather than spent on a request per poll. Each query is sorted newest-first
 * and capped at one page: anything posted since the last poll is at the top, and
 * the staleness filter drops the rest. Results are merged by id because a role
 * matching two terms is one job.
 */
PROVIDERS.amazon = {
  label: 'Amazon',
  firstParty: true,
  async list(token) {
    const country = String(token || 'IND').toUpperCase();
    const found = new Map();

    for (const term of ['intern', 'internship', 'trainee']) {
      const j = await getJson(
        `https://www.amazon.jobs/en/search.json?base_query=${encodeURIComponent(term)}`
        + `&country=${encodeURIComponent(country)}&result_limit=50&sort=recent`,
      );
      if (!Array.isArray(j?.jobs)) continue;

      for (const p of j.jobs) {
        const id = p.id_icims ?? p.id;
        if (!id || found.has(String(id))) continue;
        found.set(String(id), job({
          id,
          title: p.title,
          // normalized_location is "Bengaluru, KA, IND"; city/state is the fallback.
          location: p.normalized_location || [p.city, p.state].filter(Boolean).join(', '),
          url: p.job_path ? `https://www.amazon.jobs${p.job_path}` : null,
          // "July 31, 2026" — a real calendar date, unlike Workday's "Posted 3 Days Ago".
          postedAt: p.posted_date,
          department: p.job_category,
          // The qualifications carry the degree and the skills; the description
          // alone often does not, and both parsers downstream read this field.
          description: [p.description, p.basic_qualifications, p.preferred_qualifications]
            .filter(Boolean).join('<br/><br/>'),
        }));
      }
    }

    return found.size ? [...found.values()] : null;
  },

  /**
   * Nothing to verify. A third-party token is a guess that has to be checked
   * against the company name — that is what filed an unrelated Personio tenant
   * under "Amazon" in the first place. Here the host IS the company, so the only
   * question is whether the board reads at all.
   */
  async verify(token) {
    const j = await getJson(
      `https://www.amazon.jobs/en/search.json?base_query=intern&country=${encodeURIComponent(String(token || 'IND').toUpperCase())}&result_limit=1`,
    );
    return Array.isArray(j?.jobs);
  },
};

/**
 * Microsoft — second first-party board, and the reason the browser earns its
 * keep exactly once per site.
 *
 * The endpoint could not be guessed from outside. The obvious one,
 * gcsservices.careers.microsoft.com, is the OLD careers system and answers an
 * empty body — it looks broken rather than moved, which is the worst kind of
 * wrong. Watching what the real page requests found this in about a minute.
 * That is the whole role of a browser here: discover the call once, by hand,
 * then never open a browser for this site again.
 *
 * postedTs is in SECONDS. Feeding it straight to new Date() dates every posting
 * to 1970-01-21, and the staleness filter then drops the entire board without a
 * single error — zero jobs, no failure, nothing to notice. Hence the × 1000.
 */
PROVIDERS.microsoft = {
  label: 'Microsoft',
  firstParty: true,
  async list(token) {
    const location = String(token || 'India');
    const found = new Map();

    for (const term of ['intern', 'internship', 'trainee']) {
      const j = await getJson(
        'https://apply.careers.microsoft.com/api/pcsx/search?domain=microsoft.com'
        + `&query=${encodeURIComponent(term)}&location=${encodeURIComponent(location)}&start=0`,
      );
      const positions = j?.data?.positions;
      if (!Array.isArray(positions)) continue;

      for (const p of positions) {
        const id = p.id ?? p.displayJobId;
        if (!id || found.has(String(id))) continue;
        found.set(String(id), job({
          id,
          title: p.name,
          // "India, Karnataka, Bangalore" — city last, which the India filter reads fine.
          location: p.locations?.[0] ?? p.location ?? null,
          url: p.positionUrl?.startsWith('http')
            ? p.positionUrl
            : `https://jobs.careers.microsoft.com/global/en/job/${id}`,
          postedAt: p.postedTs ? p.postedTs * 1000 : null,
          department: p.department,
          remote: p.workLocationOption ?? p.locationFlexibility,
          // The search response carries no description at all; detail() fetches it
          // for the few postings that survive the filters.
          description: null,
          externalPath: String(id),
        }));
      }
    }

    return found.size ? [...found.values()] : null;
  },

  async verify(token) {
    const j = await getJson(
      `https://apply.careers.microsoft.com/api/pcsx/search?domain=microsoft.com&query=intern&location=${encodeURIComponent(String(token || 'India'))}&start=0`,
    );
    return Array.isArray(j?.data?.positions);
  },

  /** One request per internship kept, not one per posting seen. */
  async detail(token, positionId) {
    if (!positionId) return null;
    const j = await getJson(
      `https://apply.careers.microsoft.com/api/pcsx/position_details?position_id=${encodeURIComponent(positionId)}&domain=microsoft.com&hl=en`,
    );
    const d = j?.data ?? j;
    if (!d?.jobDescription) return null;
    return {
      description: stripHtml(d.jobDescription),
      postedAt: d.postedTs ? d.postedTs * 1000 : null,
    };
  },
};

/**
 * Uber — first-party board, and the one that arrives without a description.
 *
 * jobs.uber.com/robots.txt is `Allow: /` and advertises a sitemap, and the
 * search endpoint its own careers page calls answers an honest user-agent. The
 * per-job detail endpoints do not: loadJobDetail returns 403, and so does the
 * rendered job page. So a posting here carries its title, location, team and
 * date, and nothing to summarise — the card will show the facts and no bullets.
 * That is a deliberate trade. Being first to a role still beats a prettier card
 * for one nobody can see yet, and the Apply link goes to the real posting.
 *
 * The token is the ISO-3 country code. Uber returns a structured location with
 * a country field, so this filters exactly rather than by matching city names.
 */
// Uber's endpoint answers 403 without an x-csrf-token header and 200 with any
// value at all, so it is a same-origin formality rather than a check on who is
// calling — nothing is validated and nothing is defeated by sending it. Their
// robots.txt for jobs.uber.com is `Allow: /`. Recorded here so the choice is
// visible: delete this and the provider simply stops working.
const CSRF = { 'x-csrf-token': 'x' };

PROVIDERS.uber = {
  label: 'Uber',
  firstParty: true,
  async list(token) {
    const country = String(token || 'IND').toUpperCase();
    const found = new Map();

    for (const term of ['intern', 'internship', 'trainee', 'apprentice']) {
      const j = await getJson('https://www.uber.com/api/loadSearchJobsResults?localeCode=en', {
        method: 'POST',
        body: { params: { query: term }, page: 0, limit: 50 },
        headers: CSRF,
      });
      const results = j?.data?.results;
      if (!Array.isArray(results)) continue;

      for (const p of results) {
        if (p.location?.country !== country) continue;
        const id = p.id;
        if (!id || found.has(String(id))) continue;
        found.set(String(id), job({
          id,
          title: p.title,
          location: [p.location?.city, p.location?.countryName].filter(Boolean).join(', '),
          url: `https://jobs.uber.com/en/jobs/${id}`,
          postedAt: p.creationDate,
          department: p.department ?? p.team,
          description: p.description || null,
        }));
      }
    }

    return found.size ? [...found.values()] : null;
  },

  async verify(token) {
    const j = await getJson('https://www.uber.com/api/loadSearchJobsResults?localeCode=en', {
      method: 'POST',
      body: { params: { query: 'intern' }, page: 0, limit: 1 },
      headers: CSRF,
    });
    return Array.isArray(j?.data?.results) && !!token;
  },
};

/** Fetch the extra per-job data a provider only exposes on a detail endpoint. */
export async function fetchDetail(providerName, token, atsJob) {
  const provider = PROVIDERS[providerName];
  if (!provider?.detail) return null;
  return provider.detail(token, atsJob.externalPath);
}

/**
 * Providers discovery is allowed to guess at.
 *
 * Workday is excluded because its tokens come from careers-page links rather
 * than name guesses. First-party boards are excluded because there is no token
 * to guess at all — they are seeded, not found.
 */
export const PROVIDER_NAMES = Object.keys(PROVIDERS)
  .filter((n) => n !== 'workday' && !PROVIDERS[n].firstParty);

/** Company → [provider, token] for boards that must be seeded rather than discovered. */
export const FIRST_PARTY_BOARDS = {
  Amazon: ['amazon', 'IND'],
  Microsoft: ['microsoft', 'India'],
  Uber: ['uber', 'IND'],
};

/** Every ATS link shape we know how to read, for scraping off a careers page. */
const ATS_LINK = new RegExp([
  String.raw`([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([A-Za-z0-9_-]+)`,
  // The embed form puts the real token in a query parameter, not the path:
  // boards.greenhouse.io/embed/job_board?for=cloudsek. Matching the path first
  // would capture the literal word "embed" as the board name.
  String.raw`greenhouse\.io\/embed\/job_board\?for=([a-z0-9-]+)`,
  String.raw`(?:boards|job-boards)\.greenhouse\.io\/(?!embed\b)([a-z0-9-]+)`,
  String.raw`jobs\.lever\.co\/([a-z0-9-]+)`,
  String.raw`jobs\.ashbyhq\.com\/([a-z0-9-]+)`,
  String.raw`([a-z0-9-]+)\.recruitee\.com`,
  String.raw`apply\.workable\.com\/([a-z0-9-]+)`,
  String.raw`jobs\.smartrecruiters\.com\/([A-Za-z0-9-]+)`,
].join('|'), 'i');

/** Plausible homepages for a company name, best guess first. */
function candidateDomains(name) {
  const slug = String(name).toLowerCase()
    .replace(/&/g, 'and')
    .replace(/\b(pvt|private|ltd|limited|inc|llc|corp|corporation|plc)\b/gi, '')
    .replace(/[^a-z0-9]+/g, '');
  if (slug.length < 3) return [];
  // Indian startups sit on a wide spread of TLDs — CRED is cred.club, and
  // guessing only .com/.in was why its Lever board went undiscovered even though
  // its careers page links jobs.lever.co/cred in plain sight. Ordered by how
  // often each actually resolves, and the search stops at the first that does.
  return [`${slug}.com`, `${slug}.in`, `${slug}.co.in`, `${slug}.io`, `${slug}.club`, `${slug}.ai`, `${slug}.co`];
}

/**
 * Find the ATS by reading the company's own careers page.
 *
 * Strictly better than guessing a slug where it works, because the page links
 * the real token: Razorpay's board is
 * `job-boards.greenhouse.io/razorpaysoftwareprivatelimited`, which no amount of
 * slugifying "Razorpay" would ever produce. It is also the only way to reach
 * Workday at all.
 *
 * It misses careers pages rendered entirely in JavaScript — Infosys, Swiggy and
 * Zomato all come back empty — so this complements slug discovery rather than
 * replacing it.
 */
/**
 * Follow the company's homepage to whatever it calls its careers page, then read
 * the ATS link off that.
 *
 * The guess-based version only tried `{slug}.com/careers`, which is why it
 * resolved 46 of 744: real careers pages live at /company/careers, /join-us,
 * careers.acme.com, and a dozen other shapes. Asking the homepage where its own
 * careers page is costs one extra request and removes the guessing entirely.
 */
async function fetchText(url, timeoutMs = 9000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; internzo/1.0; +https://www.internzo.in)' },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return { url: res.url, html: await res.text() };
  } catch { return null; }
}

/**
 * A link found on a page is a candidate, not an answer.
 *
 * Both link-scraping discoverers used to return the first ATS URL they saw,
 * skipping the verification that slug discovery has always done — and following
 * links lands on the wrong company often enough to matter. Real results from one
 * crawl: Discover resolved to Capital One's Workday, Plum to an unrelated `pacs`
 * tenant, CyberArk to Palo Alto Networks. Every path now goes through the same
 * check before a board is accepted.
 */
async function verified(hit, companyName) {
  if (!hit) return null;
  const provider = PROVIDERS[hit.provider];
  if (!provider) return null;
  try {
    return (await provider.verify(hit.token, companyName)) ? hit : null;
  } catch {
    return null;
  }
}

function matchAts(page) {
  const m = page.url.match(ATS_LINK) || page.html.match(ATS_LINK);
  if (!m) return null;
  const [, wdTenant, wdNum, wdSite, ghEmbed, gh, lever, ashby, recruitee, workable, smart] = m;
  if (wdTenant && wdNum && wdSite) return { provider: 'workday', token: `${wdTenant}:${wdNum}:${wdSite}` };
  if (ghEmbed) return { provider: 'greenhouse', token: ghEmbed };
  if (gh) return { provider: 'greenhouse', token: gh };
  if (lever) return { provider: 'lever', token: lever };
  if (ashby) return { provider: 'ashby', token: ashby };
  if (recruitee) return { provider: 'recruitee', token: recruitee };
  if (workable) return { provider: 'workable', token: workable };
  if (smart) return { provider: 'smartrecruiters', token: smart };
  return null;
}

/** Links on a homepage that look like they lead to jobs. */
function careersLinks(page) {
  const out = new Set();
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(page.html))) {
    const href = m[1];
    if (!/career|jobs?\b|join.?us|work.?with.?us|opportunit|hiring|vacanc/i.test(href)) continue;
    if (/^(mailto:|tel:|#|javascript:)/i.test(href)) continue;
    try { out.add(new URL(href, page.url).href); } catch { /* malformed href */ }
    if (out.size >= 6) break;
  }
  return [...out];
}

export async function discoverViaHomepage(companyName) {
  for (const domain of candidateDomains(companyName)) {
    const home = await fetchText(`https://${domain}/`);
    if (!home) continue;

    // The homepage itself sometimes carries the link, e.g. a footer "Careers".
    const direct = await verified(matchAts(home), companyName);
    if (direct) return { ...direct, via: home.url };

    for (const link of careersLinks(home)) {
      const page = await fetchText(link);
      if (!page) continue;
      const hit = await verified(matchAts(page), companyName);
      if (hit) return { ...hit, via: page.url };
    }
    // Deliberately NOT returning here. The first domain that merely *responds*
    // is not the right one: cred.com answers, but CRED is cred.club, and
    // stopping at the first reply meant its Lever board stayed invisible. Only a
    // found board ends the search.
  }
  return null;
}

export async function discoverViaCareersPage(companyName) {
  for (const domain of candidateDomains(companyName)) {
    for (const path of ['/careers', '/jobs']) {
      const url = `https://${domain}${path}`;
      let res;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 9000);
        res = await fetch(url, {
          redirect: 'follow',
          signal: controller.signal,
          headers: { 'user-agent': 'Mozilla/5.0 (compatible; internzo/1.0; +https://www.internzo.in)' },
        });
        clearTimeout(timer);
      } catch { continue; }
      if (!res.ok) continue;

      let html = '';
      try { html = await res.text(); } catch { continue; }

      const m = res.url.match(ATS_LINK) || html.match(ATS_LINK);
      if (!m) continue;

      // Groups line up with the alternation order above.
      const [, wdTenant, wdNum, wdSite, ghEmbed, gh, lever, ashby, recruitee, workable, smart] = m;
      if (wdTenant && wdNum && wdSite) return (await verified({ provider: 'workday', token: `${wdTenant}:${wdNum}:${wdSite}` }, companyName)) && { provider: 'workday', token: `${wdTenant}:${wdNum}:${wdSite}`, via: url };
      if (ghEmbed) return (await verified({ provider: 'greenhouse', token: ghEmbed }, companyName)) && { provider: 'greenhouse', token: ghEmbed, via: url };
      if (gh) return (await verified({ provider: 'greenhouse', token: gh }, companyName)) && { provider: 'greenhouse', token: gh, via: url };
      if (lever) return (await verified({ provider: 'lever', token: lever }, companyName)) && { provider: 'lever', token: lever, via: url };
      if (ashby) return (await verified({ provider: 'ashby', token: ashby }, companyName)) && { provider: 'ashby', token: ashby, via: url };
      if (recruitee) return (await verified({ provider: 'recruitee', token: recruitee }, companyName)) && { provider: 'recruitee', token: recruitee, via: url };
      if (workable) return (await verified({ provider: 'workable', token: workable }, companyName)) && { provider: 'workable', token: workable, via: url };
      if (smart) return (await verified({ provider: 'smartrecruiters', token: smart }, companyName)) && { provider: 'smartrecruiters', token: smart, via: url };
    }
  }
  return null;
}

/**
 * Find which board, if any, belongs to this company.
 * Returns { provider, token, count } or null.
 */
export async function discover(companyName, { providers = PROVIDER_NAMES } = {}) {
  const tokens = candidateTokens(companyName);

  for (const providerName of providers) {
    const provider = PROVIDERS[providerName];
    for (const token of tokens) {
      const jobs = await provider.list(token);
      if (!jobs || jobs.length === 0) continue;

      if (looksLikeDemoBoard(jobs)) {
        log.debug(`${companyName}: ${providerName}/${token} looks like an unclaimed demo board — skipping.`);
        continue;
      }

      // A board that exists is not yet a board that is theirs.
      const ok = await provider.verify(token, companyName);
      if (!ok) {
        log.debug(`${companyName}: ${providerName}/${token} exists but did not verify — skipping.`);
        continue;
      }
      return { provider: providerName, token, count: jobs.length };
    }
  }
  return null;
}

/** Fetch the current postings for a discovered board. */
export async function fetchBoard(providerName, token) {
  const provider = PROVIDERS[providerName];
  if (!provider) return null;
  return provider.list(token);
}
