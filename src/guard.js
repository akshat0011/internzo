import { join } from 'node:path';
import { PATHS, ensureDirs } from './paths.js';
import { log } from './logger.js';
import { notify, soundAlarm, focusApp, blockingAlert } from './notify.js';
import { sleep } from './human.js';

/**
 * Page states we care about. Anything other than OK means we stop touching
 * LinkedIn and either ask the human for help or end the run — never push through.
 */
export const State = {
  OK: 'ok',
  CHALLENGE: 'challenge',
  LOGGED_OUT: 'logged_out',
  RATE_LIMITED: 'rate_limited',
  SOFT_BLOCK: 'soft_block',
  // The browser went away underneath us. Kept separate from SOFT_BLOCK because
  // the two demand opposite reactions: a soft block is LinkedIn pushing back and
  // means slow down, while this is our own process dying and means nothing about
  // the account at all. Reporting a crashed Brave as a block sent a run's
  // postmortem looking for a ban that never happened.
  BROWSER_GONE: 'browser_gone',
};

export class RunAborted extends Error {
  constructor(state, message) {
    super(message);
    this.name = 'RunAborted';
    this.state = state;
  }
}

const URL_MARKERS = [
  [/\/checkpoint\/challenge/i, State.CHALLENGE],
  [/\/checkpoint\/lg\/login-submit/i, State.CHALLENGE],
  [/\/checkpoint\/rp\//i, State.CHALLENGE],
  [/\/checkpoint\/rm\//i, State.CHALLENGE],
  [/\/authwall/i, State.LOGGED_OUT],
  [/\/uas\/login/i, State.LOGGED_OUT],
  [/linkedin\.com\/login/i, State.LOGGED_OUT],
  [/\/signup/i, State.LOGGED_OUT],
  [/\/error\/429/i, State.RATE_LIMITED],
];

const TEXT_MARKERS = [
  [/let'?s do a quick security check/i, State.CHALLENGE],
  [/we(?:'| a)?re sorry.{0,40}(unusual|suspicious) activity/i, State.CHALLENGE],
  [/verify (?:that )?you'?re a human/i, State.CHALLENGE],
  [/complete this security check/i, State.CHALLENGE],
  [/security verification/i, State.CHALLENGE],
  [/prove you'?re (?:a person|not a robot)/i, State.CHALLENGE],
  [/enter the code we sent/i, State.CHALLENGE],
  [/unusual login activity/i, State.CHALLENGE],
  // Deliberately no bare /captcha/ marker: the word turns up in ordinary feed
  // posts, and matching it halted a run on a perfectly healthy page.
  [/sign in to (?:see|continue|view)/i, State.LOGGED_OUT],
  [/join linkedin now.{0,20}it'?s free/i, State.LOGGED_OUT],
  // Guest / authwall variants, captured from a real logged-out session.
  [/agree & join/i, State.LOGGED_OUT],
  [/already on linkedin\?\s*sign in/i, State.LOGGED_OUT],
  [/new to linkedin\?\s*join now/i, State.LOGGED_OUT],
  [/password \(6\+ characters\)/i, State.LOGGED_OUT],
  [/you'?ve reached the (?:monthly|weekly|commercial) (?:use )?limit/i, State.RATE_LIMITED],
  [/too many requests/i, State.RATE_LIMITED],
  [/you'?re browsing too fast/i, State.RATE_LIMITED],
  [/your account (?:has been )?(?:restricted|temporarily restricted)/i, State.RATE_LIMITED],
];

/**
 * Detect a CAPTCHA that is actually *blocking* the page.
 *
 * The presence of a vendor iframe means nothing on its own: LinkedIn embeds an
 * invisible reCAPTCHA Enterprise frame on ordinary pages (the feed included) to
 * score traffic passively. Treating that as a challenge halts every run before
 * it starts. Two rules keep this honest:
 *   - reCAPTCHA's `anchor` frame is the passive scorer; only `bframe` is the
 *     real puzzle.
 *   - The frame must be rendered at a human-visible size.
 */
async function visibleChallengeFrame(page) {
  return page.evaluate(() => {
    const vendor = /(arkoselabs|funcaptcha|hcaptcha|recaptcha|challenges\.cloudflare|geo\.captcha)/i;
    for (const frame of document.querySelectorAll('iframe')) {
      const src = frame.getAttribute('src') ?? '';
      if (!vendor.test(src)) continue;
      // Skip reCAPTCHA's always-present invisible scorer.
      if (/recaptcha/i.test(src) && !/bframe/i.test(src)) continue;

      const rect = frame.getBoundingClientRect();
      const style = getComputedStyle(frame);
      const shown =
        rect.width > 100 && rect.height > 100 &&
        style.visibility !== 'hidden' && style.display !== 'none' &&
        parseFloat(style.opacity || '1') > 0.1;
      if (shown) return src.slice(0, 120);
    }
    return null;
  }).catch(() => null);
}

/**
 * Classify the current page. Cheap and side-effect free; call it after every
 * navigation and periodically during long list walks.
 */
export async function classify(page) {
  let url = '';
  try {
    url = page.url();
  } catch {
    return { state: State.BROWSER_GONE, evidence: 'the page or browser was closed' };
  }

  for (const [re, state] of URL_MARKERS) {
    if (re.test(url)) return { state, evidence: `url matched ${re}` };
  }

  const challengeFrame = await visibleChallengeFrame(page);
  if (challengeFrame) {
    return { state: State.CHALLENGE, evidence: `visible captcha frame: ${challengeFrame}` };
  }

  let probe;
  try {
    probe = await page.evaluate(() => ({
      // Only the top of the body — enough for banners, and avoids pulling a
      // megabyte of feed text on every check.
      text: document.body?.innerText?.slice(0, 4000) ?? '',
      // The signed-in chrome. Its presence is strong evidence the session is
      // fine, whatever words happen to appear in the page content.
      signedIn: !!document.querySelector(
        '.global-nav__me, .global-nav__me-photo, img.global-nav__me-photo, [data-control-name="nav.settings"], .global-nav__primary-items',
      ),
    }));
  } catch (err) {
    // "Target page, context or browser has been closed" is Playwright telling
    // us the browser is gone, not LinkedIn refusing to answer.
    const gone = /Target page, context or browser has been closed|Execution context was destroyed|browser has (?:been )?(?:closed|disconnected)/i
      .test(String(err?.message ?? ''));
    return gone
      ? { state: State.BROWSER_GONE, evidence: 'the page or browser was closed mid-run' }
      : { state: State.SOFT_BLOCK, evidence: 'could not read page text' };
  }

  for (const [re, state] of TEXT_MARKERS) {
    // Feed posts routinely contain phrases like "sign in to see". If the
    // signed-in navigation is on screen, do not let page *content* convince us
    // we have been logged out.
    if (state === State.LOGGED_OUT && probe.signedIn) continue;
    if (re.test(probe.text)) return { state, evidence: `text matched ${re}` };
  }

  return { state: State.OK, evidence: '' };
}

async function shoot(page, label) {
  ensureDirs();
  const name = `${label}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
  const file = join(PATHS.screenshots, name);
  try {
    await page.screenshot({ path: file, fullPage: false });
    return file;
  } catch {
    return null;
  }
}

/**
 * A CAPTCHA is blocking us. Ping the human loudly, bring the window forward,
 * and wait for them to solve it — polling until the page looks healthy again.
 *
 * We never attempt to solve or bypass the challenge ourselves.
 */
async function waitForHuman(page, evidence, { waitMinutes = 12, notifications }) {
  const shot = await shoot(page, 'captcha');
  log.warn(`CAPTCHA / security check detected (${evidence})`);
  if (shot) log.warn(`Screenshot: ${shot}`);

  if (notifications.onCaptcha) {
    await focusApp('Brave Browser');
    await notify(
      'LinkedIn needs you',
      `A security check is blocking the job scan. Solve it in Brave and the run will continue on its own. Waiting up to ${waitMinutes} min.`,
      { sound: 'Sosumi', subtitle: 'Internship watcher paused' },
    );
    soundAlarm({ times: 3 }).catch(() => {});
    // A dialog that persists until dismissed, in case the banner was missed.
    // Deliberately not awaited: the poll loop below is the real mechanism.
    blockingAlert(
      'LinkedIn security check',
      'The internship watcher hit a CAPTCHA in Brave.\n\nSolve it in the browser window, then this dialog can be ignored — the run resumes automatically.',
      { confirmLabel: 'OK', timeoutSeconds: waitMinutes * 60 },
    ).catch(() => {});
  }

  const deadline = Date.now() + waitMinutes * 60_000;
  let announced = false;

  while (Date.now() < deadline) {
    await sleep(5_000);
    const { state } = await classify(page);

    if (state === State.OK) {
      log.ok('Security check cleared — resuming.');
      await notify('Back on track', 'CAPTCHA solved, the internship scan is continuing.', { sound: 'Ping' });
      return true;
    }
    if (state === State.LOGGED_OUT || state === State.RATE_LIMITED) {
      return false;
    }

    const left = Math.round((deadline - Date.now()) / 60_000);
    if (!announced && left <= 3) {
      announced = true;
      log.warn(`Still blocked — ${left} min before this run gives up.`);
      soundAlarm({ times: 2 }).catch(() => {});
    }
  }

  log.error('Nobody solved the security check in time. Ending this run.');
  await notify(
    'Internship watcher stopped',
    'The CAPTCHA went unsolved, so this run was skipped. The next scheduled run will try again.',
    { sound: 'Basso' },
  );
  return false;
}

/**
 * Check the page and handle whatever we find.
 * Returns normally when it is safe to carry on; throws RunAborted otherwise.
 */
export async function ensureHealthy(page, cfg, { context = 'page', remainingMs = null } = {}) {
  const { state, evidence } = await classify(page);

  if (state === State.OK) return;

  if (state === State.CHALLENGE) {
    // Escape hatch for false positives. The detector reads page *text* as well
    // as frames, and unlike the logged-out markers it is not suppressed by the
    // signed-in nav being on screen — so a job description containing a phrase
    // like "security verification" halts a perfectly healthy run, which is what
    // was happening. Off means: screenshot it, say so, and carry on.
    if (cfg.safety?.pauseOnChallenge === false) {
      const shot = await shoot(page, 'challenge-ignored');
      log.warn(`Security check reported at ${context} (${evidence}) — safety.pauseOnChallenge is off, carrying on.`);
      if (shot) log.warn(`Screenshot: ${shot}`);
      return;
    }

    // The wait for a human has to fit inside the run's own budget.
    //
    // It used to be a flat 12 minutes, decided here with no knowledge of how
    // long the run was allowed to take. On a 15-minute schedule that is fatal,
    // and not only to the run holding it: the run sails past maxRuntimeMinutes,
    // its lock in index.js ages out and is treated as stale, the next scheduled
    // run starts while this Brave still owns the profile, and that run then dies
    // on a launch timeout. One unattended CAPTCHA took out a whole hour of runs
    // that way — a 59-minute run followed by launch failures.
    //
    // So: never wait longer than the run has left, minus a margin to publish
    // whatever was already collected.
    const configured = cfg.safety?.captchaWaitMinutes ?? 4;
    const budgetMinutes = remainingMs == null
      ? configured
      : Math.max(0, remainingMs / 60_000 - 1);
    const waitMinutes = Math.min(configured, budgetMinutes);

    if (waitMinutes <= 0) {
      log.warn('A security check appeared, but this run is out of time — stopping so the next slot is not blocked.');
      throw new RunAborted(State.CHALLENGE, `Security check at ${context}, no budget left to wait`);
    }

    const recovered = await waitForHuman(page, evidence, {
      waitMinutes,
      notifications: cfg.notifications,
    });
    if (recovered) return;
    throw new RunAborted(State.CHALLENGE, `Unsolved security check at ${context}`);
  }

  if (state === State.LOGGED_OUT) {
    await shoot(page, 'logged-out');
    log.error('LinkedIn session is no longer signed in.');
    if (cfg.notifications.onError) {
      await notify(
        'LinkedIn login expired',
        'Run `npm run login` to sign in again — the watcher is paused until then.',
        { sound: 'Basso' },
      );
      soundAlarm({ times: 2 }).catch(() => {});
    }
    throw new RunAborted(State.LOGGED_OUT, 'Session expired — run `npm run login`');
  }

  if (state === State.RATE_LIMITED) {
    await shoot(page, 'rate-limited');
    log.error(`LinkedIn is rate limiting us (${evidence}). Stopping immediately.`);
    if (cfg.notifications.onError) {
      await notify(
        'LinkedIn rate limit hit',
        'The watcher stopped early to protect your account. Consider raising the pacing values in config.json.',
        { sound: 'Basso' },
      );
    }
    throw new RunAborted(State.RATE_LIMITED, `Rate limited at ${context}`);
  }

  log.warn(`Unhealthy page state "${state}" at ${context} (${evidence})`);
}

/**
 * Confirm the session is actually signed in.
 *
 * This is not redundant with `classify`. LinkedIn will happily serve a *public*
 * job-search page to a signed-out visitor — it looks healthy, it has job cards,
 * and nothing in the URL or page text says "logged out". Scraping that would
 * quietly produce worse results from a different surface, and poison the
 * database with them. The session cookie is the honest signal.
 */
export async function assertSignedIn(page, context, cfg) {
  const cookies = await context.cookies('https://www.linkedin.com').catch(() => []);
  const liAt = cookies.find((c) => c.name === 'li_at');
  const cookieOk = !!liAt && !(liAt.expires > 0 && liAt.expires * 1000 < Date.now());

  // Corroborate with the page itself: the signed-in chrome has a "Me" menu,
  // the guest surface has a join/sign-in call to action.
  const domVerdict = await page.evaluate(() => {
    const signedIn = !!document.querySelector('.global-nav__me, .global-nav__me-photo, img.global-nav__me-photo, [data-control-name="nav.settings"]');
    const guest = !!document.querySelector('.nav__button-secondary, .sign-in-form, form.login__form, [data-tracking-control-name*="guest"]');
    return { signedIn, guest };
  }).catch(() => ({ signedIn: false, guest: false }));

  if (cookieOk && !domVerdict.guest) return;

  const why = !cookieOk ? 'the li_at session cookie is missing or expired' : 'the page is showing LinkedIn\'s signed-out surface';
  log.error(`Not signed in — ${why}.`);
  await shoot(page, 'not-signed-in');

  if (cfg.notifications.onError) {
    await notify(
      'LinkedIn login expired',
      'Run `npm run login` to sign in again — the watcher is paused until then.',
      { sound: 'Basso' },
    );
    soundAlarm({ times: 2 }).catch(() => {});
  }
  throw new RunAborted(State.LOGGED_OUT, `Not signed in (${why}) — run \`npm run login\``);
}

/**
 * Sanity check that the job list actually rendered. If LinkedIn changes its
 * markup, selectors silently return zero results — which looks identical to
 * "no jobs today". This makes that failure loud instead.
 */
export async function assertListRendered(page, cardCount, { pageIndex, searchLabel }) {
  if (cardCount > 0) return;

  const shot = await shoot(page, 'empty-list');
  const emptyState = await page.evaluate(() => {
    const t = document.body?.innerText ?? '';
    return /no matching jobs found|no results found|couldn'?t find|0 results|try a different search/i.test(t);
  }).catch(() => false);

  if (emptyState) {
    log.info(`LinkedIn reports genuinely no results for "${searchLabel}" page ${pageIndex}.`);
    return;
  }

  throw new Error(
    `Job list rendered 0 cards for "${searchLabel}" page ${pageIndex}, and LinkedIn did not show a ` +
    `"no results" message. This usually means LinkedIn changed its markup and the card selectors need updating.` +
    (shot ? ` Screenshot: ${shot}` : ''),
  );
}
