/**
 * Post new listings to a Telegram channel.
 *
 * Why Telegram and not WhatsApp: WhatsApp has no public API for posting to a
 * channel, so the only way to automate it is to drive WhatsApp Web in a browser
 * — which is against their Acceptable Use policy and gets the *number* banned,
 * not the browser. Telegram publishes a Bot API, so this is a plain HTTPS call
 * that breaks only if Telegram changes their API rather than their markup.
 *
 * Everything here fails soft. A channel post is the least important thing a run
 * does; it must never be the reason a scrape is recorded as failed.
 */
import { log } from './logger.js';
import { jobSlug, SITE } from './pages.js';

const API = 'https://api.telegram.org';

/** Telegram hard-limits a message to 4096 characters. Stay clear of it. */
const MAX_CHARS = 3800;

/** Listings named individually before the rest become "+N more". */
const MAX_LISTED = 8;

/**
 * HTML-escape for Telegram's parse_mode=HTML.
 *
 * Company names and titles come from LinkedIn and are not trusted. An
 * unescaped "&" or "<" makes Telegram reject the whole message with a 400,
 * which would silently drop the post for every job in that batch.
 */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * One message for the whole run, not one per job.
 *
 * A run that finds six roles firing six notifications is how a channel gets
 * muted. The site's own promise is the lead: these are minutes old.
 */
export function compose(jobs) {
  const n = jobs.length;
  const head = n === 1
    ? '<b>1 new internship</b>'
    : `<b>${n} new internships</b>`;

  const lines = [];
  for (const j of jobs.slice(0, MAX_LISTED)) {
    const url = `${SITE}/jobs/${jobSlug({ company: j.company, title: j.title, id: j.job_id })}`;
    const where = [j.location, j.workplace_type].filter(Boolean).join(' · ');
    lines.push(
      `\n<a href="${url}"><b>${esc(j.title)}</b></a>\n`
      + `${esc(j.company)}${where ? ` — ${esc(where)}` : ''}`,
    );
  }

  let body = `${head}\n${lines.join('\n')}`;
  if (n > MAX_LISTED) body += `\n\n…and ${n - MAX_LISTED} more on the site.`;
  body += `\n\n<a href="${SITE}/">See every live role →</a>`;

  // Truncating mid-tag would produce invalid HTML and a 400 from Telegram, so
  // drop whole listings until it fits rather than slicing the string.
  while (body.length > MAX_CHARS && lines.length > 1) {
    lines.pop();
    body = `${head}\n${lines.join('\n')}\n\n…and ${n - lines.length} more on the site.`
      + `\n\n<a href="${SITE}/">See every live role →</a>`;
  }
  return body;
}

/**
 * @param {object[]} jobs rows from store.jobsForRun()
 * @param {object} cfg loaded config
 * @returns {Promise<boolean>} true if a message was sent
 */
export async function postNewJobs(jobs, cfg) {
  const conf = cfg.notifications?.telegram ?? {};
  if (!conf.enabled || !jobs.length) return false;

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = conf.chatId;

  // A missing token is a setup mistake, not a runtime error — say so once,
  // clearly, rather than throwing into the middle of a successful run.
  if (!token) {
    log.warn('Telegram is enabled but TELEGRAM_BOT_TOKEN is not set — skipping the channel post.');
    return false;
  }
  if (!chatId) {
    log.warn('Telegram is enabled but notifications.telegram.chatId is empty — skipping the channel post.');
    return false;
  }

  const text = compose(jobs);

  try {
    const res = await fetch(`${API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        // The listings carry their own links; Telegram's link preview would
        // add a large card for whichever it picked first and bury the rest.
        link_preview_options: { is_disabled: true },
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      log.warn(`Telegram post failed (${res.status}): ${data.description ?? 'no detail'}`);
      return false;
    }
    log.ok(`Posted ${jobs.length} listing${jobs.length === 1 ? '' : 's'} to the Telegram channel.`);
    return true;
  } catch (err) {
    // Network flake, timeout, Telegram down — none of it should mark the run bad.
    log.warn(`Telegram post skipped — ${String(err?.message ?? err).split('\n')[0]}`);
    return false;
  }
}
