/**
 * Is this job title a software / tech role?
 *
 * A single broad `internship` search returns everything — psychosocial support,
 * field sales, cinematography, telecalling. This is the filter that decides
 * what actually reaches the site.
 *
 * Negative signals are checked BEFORE positive ones on purpose: "Software Sales
 * Intern" and "Sales Engineer Intern" both contain engineering words but are
 * not engineering jobs, and letting the positive match win would put them on a
 * software job board.
 *
 * A title that matches neither list is reported as `uncertain` rather than
 * guessed at, so the vocabulary can be tuned from real titles instead of
 * imagination — see `node bin/show-report.js --roles`.
 */

const POSITIVE = [
  // core engineering
  'software', 'developer', 'dev', 'engineer', 'engineering', 'sde', 'swe', 'sdet',
  'programmer', 'programming', 'coding', 'computer science', 'informatics',
  // web / app
  'backend', 'back end', 'back-end', 'frontend', 'front end', 'front-end',
  'fullstack', 'full stack', 'full-stack', 'web development', 'web developer', 'webdev',
  'android', 'ios', 'mobile app', 'mobile application', 'react native', 'flutter',
  'kotlin', 'swift developer',
  // languages / frameworks
  'python', 'java', 'javascript', 'typescript', 'node.js', 'nodejs', 'react',
  'angular', 'vue', '.net', 'c++', 'c#', 'golang', 'rust', 'php', 'ruby', 'scala',
  // data / ml
  'data science', 'data scientist', 'data engineer', 'data engineering',
  'data analyst', 'data analytics', 'business intelligence', 'machine learning',
  'deep learning', 'artificial intelligence', 'computer vision', 'nlp',
  'generative ai', 'genai', 'mlops', 'llm', 'ml', 'ai',
  // infra. The compound forms are listed explicitly: \bcloud\b cannot match
  // "CloudOps", which cost us eight real postings before it was noticed.
  'devops', 'cloudops', 'dataops', 'secops', 'sysops', 'platformops',
  'sre', 'site reliability', 'cloud', 'aws', 'azure', 'kubernetes',
  'docker', 'infrastructure', 'platform engineer', 'systems engineer',
  'network engineer', 'database', 'dba', 'sql', 'api', 'microservices',
  // quality
  'qa', 'quality assurance', 'test engineer', 'software testing',
  'automation testing', 'test automation',
  // security
  'cybersecurity', 'cyber security', 'information security', 'infosec',
  'security engineer', 'application security', 'penetration testing', 'soc analyst',
  // hardware-adjacent software
  'embedded', 'firmware', 'vlsi', 'rtl', 'asic', 'fpga', 'chip design',
  'physical design', 'design verification', 'silicon',
  // other technical
  'game development', 'game developer', 'unity', 'unreal', 'graphics',
  'blockchain', 'web3', 'solidity', 'smart contract',
  'technology', 'technical', 'r&d', 'research and development',
  // Broader technical vocabulary — added after a real backfill showed several
  // engineering titles falling through to "uncertain".
  'software development', 'application developer', 'systems software',
  'solution architect', 'software architect', 'technical architect',
  'technical program manager', 'tpm', 'release engineering', 'build engineer',
  'observability', 'devsecops', 'automation engineer', 'rpa',
  'etl', 'data warehouse', 'data platform', 'big data', 'spark', 'hadoop',
  'airflow', 'snowflake', 'power bi', 'tableau', 'looker',
  'salesforce developer', 'sap abap', 'servicenow developer', 'erp', 'crm developer',
  'linux', 'unix', 'shell scripting', 'networking', 'network security',
  'penetration tester', 'red team', 'blue team', 'soc',
  'compiler', 'kernel', 'operating systems', 'distributed systems',
  'robotics', 'ros', 'autonomous', 'mechatronics software',
  'ar/vr', 'xr', 'augmented reality', 'virtual reality', 'computer graphics',
  'hardware engineer', 'hardware design', 'validation engineer', 'verification engineer',
  'electronics engineer', 'signal processing', 'wireless', 'rf design',
  'bioinformatics', 'quantum computing', 'gis developer', 'geospatial',
  'mainframe', 'cobol', 'prompt engineering', 'agentic', 'chatbot',
  'engineering intern', 'engineering trainee', 'technical intern',
  'interim engineering',
  // product & design, adjacent but usually part of a software team
  'product management', 'product manager', 'associate product manager', 'apm',
  'ui/ux', 'ui ux', 'uiux', 'ux', 'ui', 'user experience', 'user interface',
  'product design', 'ux research', 'ux designer', 'ui designer', 'interaction design',
  // Quant roles. Ambiguous on their own, but leaning positive is the safe
  // direction: the company filter runs afterwards, so a trading internship at
  // an unknown shop is still dropped while one at Optiver survives. Leaning
  // negative would silently lose the watchlist ones.
  'quantitative', 'quant', 'algorithmic trading', 'trading',
];

const NEGATIVE = [
  // Creative and lab roles that a single positive token drags in. Negatives are
  // checked first, which is what makes this work: "AI Film Making(Internship)"
  // reached the live site because 'ai' matched on its own, and "QA Food Testing
  // Intern" because 'qa' did. Both are real postings that were published.
  'film', 'filmmaking', 'film making', 'videography', 'video editing', 'video editor',
  'graphic design', 'graphic designer', 'animation', 'animator', 'motion graphics',
  'photography', 'photographer', 'illustrator', 'copywriter', 'copywriting',
  'food testing', 'food technology', 'food safety',

  // commercial
  'sales', 'business development', 'telecalling', 'telesales', 'telemarketing',
  'inside sales', 'field sales', 'pre sales', 'presales', 'lead generation',
  'business analyst', 'market research', 'growth hacking',
  // marketing & content
  'marketing', 'digital marketing', 'social media', 'seo', 'content writing',
  'content creation', 'content writer', 'copywriting', 'copywriter', 'blogging',
  'brand', 'influencer', 'public relations', 'journalism', 'editorial',
  'video editing', 'video making', 'videography', 'photography', 'cinematography',
  'graphic design', 'graphics design', 'illustration', 'motion graphics',
  // people & back office
  'human resource', 'human resources', 'recruitment', 'recruiter',
  'talent acquisition', 'people operations', 'hr',
  'finance', 'accounting', 'accounts', 'audit', 'taxation', 'bookkeeping',
  'legal', 'paralegal', 'company secretary',
  'administrative', 'office assistant', 'back office', 'data entry',
  'customer support', 'customer service', 'customer success', 'call center',
  'operations executive', 'supply chain', 'logistics', 'procurement', 'warehouse',
  'event management', 'hospitality', 'travel',
  // non-software engineering & sciences
  'civil engineer', 'mechanical engineer', 'electrical engineer',
  'chemical engineer', 'production engineer', 'industrial engineer',
  'automobile', 'hvac', 'construction', 'architecture', 'interior design',
  'clinical', 'pharmacovigilance', 'pharmacist', 'nursing', 'medical',
  'biotechnology', 'microbiology', 'chemistry lab',
  // education & social
  'teaching', 'teacher', 'tutor', 'lecturer', 'academic',
  'counselling', 'counsellor', 'counselor', 'psychosocial', 'psychology',
  'social work', 'community outreach', 'fundraising', 'csr',
  'fashion design', 'fashion', 'textile', 'culinary', 'agriculture', 'agronomy',
  // Some postings say so outright: "Intern- Content Developer (Non-technical)"
  // was being filed as tech because of the word "Developer".
  'non-technical', 'non technical', 'nontechnical', 'content developer',
  // Observed in real runs, all correctly unwanted but previously "unclear".
  'mechanical', 'chemical', 'technician', 'telecaller', 'telecalling',
  'customer acquisition', 'client acquisition', 'market analyst',
  'content creator', 'student ambassador', 'management trainee',
  'character animation', 'curation', 'cataloging', 'cataloguing',
  'article trainee', 'articleship', 'leasing', 'tenant representation',
  'founder\'s office', 'founders office', 'growth intern', 'sports',
];

/**
 * Built-in terms with their polarity, for vetting learned vocabulary. A
 * hand-written rule with tests behind it outranks a model's suggestion.
 */
export function builtInPolarity() {
  const map = new Map();
  for (const t of POSITIVE) map.set(t.toLowerCase(), true);
  for (const t of NEGATIVE) map.set(t.toLowerCase(), false);
  return map;
}

const cache = new Map();

/**
 * Whole-word matching. Plain substring tests are unsafe here: "hr" appears in
 * "Chromium", "ai" in "maintain", "dev" in "device".
 */
function hasTerm(haystack, term) {
  let re = cache.get(term);
  if (!re) {
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Terms ending in a non-word character (c++, .net, r&d) cannot take a
    // trailing \b, and ones starting with one cannot take a leading \b.
    const lead = /^[a-z0-9]/i.test(term) ? '\\b' : '';
    const tail = /[a-z0-9]$/i.test(term) ? '\\b' : '';
    re = new RegExp(`${lead}${esc}${tail}`, 'i');
    cache.set(term, re);
  }
  return re.test(haystack);
}

function firstMatch(text, terms) {
  // Longest terms first, so "data analyst" is considered before "sales" style
  // single words and the more specific phrase wins.
  for (const term of terms) {
    if (hasTerm(text, term)) return term;
  }
  return null;
}

const POSITIVE_SORTED = [...POSITIVE].sort((a, b) => b.length - a.length);
const NEGATIVE_SORTED = [...NEGATIVE].sort((a, b) => b.length - a.length);

/**
 * Classify a job title.
 * @returns {{verdict: 'tech'|'non-tech'|'uncertain', matched: string|null}}
 */
export function classifyRole(title, options = {}) {
  const text = String(title ?? '').trim();
  if (!text) return { verdict: 'uncertain', matched: null };

  const positive = [...(options.extraPositive ?? []), ...POSITIVE_SORTED];
  const negative = [...(options.extraNegative ?? []), ...NEGATIVE_SORTED];

  // A specific positive phrase beats a generic negative word: "Data Analyst"
  // and "Business Intelligence" should survive even though "analyst" reads as
  // commercial. Only phrases of two or more words earn this override.
  const strongPositive = positive.find((t) => t.includes(' ') && hasTerm(text, t));

  const neg = firstMatch(text, negative);
  if (neg && !strongPositive) return { verdict: 'non-tech', matched: neg };

  const pos = strongPositive ?? firstMatch(text, positive);
  if (pos) return { verdict: 'tech', matched: pos };

  return { verdict: 'uncertain', matched: null };
}

/** Convenience: should this title reach a software job board? */
/**
 * Terms too generic to settle the question on their own. "Graduate Engineer
 * Trainee" is automotive R&D at Valeo and software at Wipro; only the
 * description tells them apart.
 */
const GENERIC = new Set([
  'engineer', 'engineering', 'technical', 'technology', 'r&d',
  'research and development', 'engineering intern', 'engineering trainee',
  'technical intern', 'interim engineering', 'trainee', 'apprentice',
]);

/**
 * Should this title be sent to Gemini with its description?
 *
 * True when the vocabulary could not decide, or when it decided on nothing more
 * than a generic engineering word.
 */
export function needsDescription(title, options = {}) {
  const { verdict, matched } = classifyRole(title, options);
  if (verdict === 'uncertain') return true;
  if (verdict === 'tech' && matched && GENERIC.has(matched.toLowerCase())) {
    // A generic match only makes the title ambiguous if nothing SPECIFIC also
    // matched. "Software Engineering Intern (Full Stack)" came back generic
    // purely because classifyRole prefers the longest phrase, and
    // "engineering intern" is longer than "full stack" — even though the
    // specific term is right there and settles it. Left alone, that sent a
    // plainly technical title off for a description read, and once the
    // watchlist became a trust signal it dropped the role entirely.
    const specific = [...(options.extraPositive ?? []), ...POSITIVE_SORTED]
      .some((t) => !GENERIC.has(t.toLowerCase()) && hasTerm(title, t));
    return !specific;
  }
  return false;
}

export function isSoftwareRole(title, { includeUncertain = false, ...options } = {}) {
  const { verdict } = classifyRole(title, options);
  return verdict === 'tech' || (includeUncertain && verdict === 'uncertain');
}

/**
 * Let this vocabulary overrule a model verdict, in one direction only.
 *
 * If the configured terms confidently call a role non-engineering, that stands
 * whatever the model thinks. Those terms are added deliberately, in response to
 * something wrong actually reaching the site, so they are evidence rather than
 * opinion. The reverse is not true: a role the vocabulary cannot settle is
 * exactly what the model is here to decide.
 *
 * The ROLE LABEL is read as well as the title, because employers who post
 * everything under one generic title give the vocabulary nothing else to bite
 * on. American Express posts every internship as the bare word "Apprentice",
 * which is how "Credit Risk Analyst" reached an engineering-only board.
 *
 * The label is a FALLBACK, consulted only when the title settles nothing. It
 * must not outrank a confident title: labels name the business domain as often
 * as the work, and BNP Paribas' "Data Science Intern" is labelled "Financial
 * NLP modelling" — with `financial` a negative term, letting the label win
 * would drop a real data science role to catch a credit risk one.
 *
 * Lives here rather than beside either classifier because there are two of
 * them and only one was ever wired up.
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
  if (fromTitle === 'uncertain' && verdictOf(roleLabel) === 'non-tech') return false;

  return typeof modelVerdict === 'boolean' ? modelVerdict : null;
}
