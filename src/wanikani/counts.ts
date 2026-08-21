/*
 * The lesson and review counts are baked into the page when it loads, so a tab
 * left open all morning still advertises the 07:00 batch. Rather than reload -
 * which loses the scroll position, collapses open widgets and throws away the
 * Turbo cache - re-fetch the page in the background and swap the count badges
 * over on their own.
 *
 * The selectors are WaniKani's own: `.lesson-and-review-count__count` is the
 * dashboard's Lessons/Reviews pair, `.count-bubble` the badge in the global
 * navigation. If either stops matching, this quietly does nothing rather than
 * mangling the page.
 *
 * Reviews arrive on the hour and that is all they do. Lessons also turn over
 * at midnight, when the daily allowance resets - a bigger change, handled by
 * the two blocks below.
 */
import { isReviewPage } from './session';
import type { TurboFrame } from './types';

const COUNT_SELECTOR = '.lesson-and-review-count__count, .count-bubble';

/*
 * A new day is more than a bigger number. WaniKani's daily lesson allowance
 * resets at your local midnight, and the Today's Lessons widget renders that
 * whole state - how much of the day's batch is left, the "you're done" face,
 * the Start Lessons button - not just a count. So when the date turns, the
 * widget is swapped whole rather than having its bubble picked out of it.
 */
const LESSONS_SELECTOR = '.todays-lessons-widget';

/*
 * Which day the server rendered for is not implicit: the page tells it, via
 * `utc_time_at_start_of_day` on the frames it fetches and on every link into
 * the lesson queue. WaniKani's own `set-time-zone` / `dashboard-widget`
 * controllers write that stamp when they connect and never again, so a frame
 * reloaded after midnight would fetch *yesterday* over again - same widget,
 * same allowance, same numbers. Restamp before asking for anything.
 */
const DAY_PARAM = 'utc_time_at_start_of_day';

let lastCountHour = new Date().getHours();
let lastCountDate = new Date().toDateString();

function countNodes(root: Document, selector: string) {
  const nodes = [...root.querySelectorAll<HTMLElement>(selector)];
  // The widget's own count bubble travels with the widget - patching both
  // would replace the widget and then write into the detached copy.
  return nodes.filter((node) => !nodes.some((other) => other !== node && other.contains(node)));
}

/** The instant the current local day began, in the format WaniKani sends. */
function startOfDay() {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  return midnight.toISOString();
}

/*
 * Rewrites the day stamp on one attribute, leaving everything else WaniKani
 * put there (`widget_frame`, `theme`, `browser_timezone`) alone. Reports
 * whether it wrote, since pointing a <turbo-frame> at a new src *is* its
 * reload - asking for one on top would fetch the same thing twice.
 */
function restamp(node: Element, attribute: string, midnight: string) {
  const value = node.getAttribute(attribute);
  if (!value || !value.includes(DAY_PARAM)) return false;
  try {
    const url = new URL(value, location.href);
    if (!url.searchParams.has(DAY_PARAM)) return false;
    url.searchParams.set(DAY_PARAM, midnight);
    if (url.href === value) return false;
    node.setAttribute(attribute, url.href);
    return true;
  } catch (e) {
    return false; /* not a URL we understand - leave it as WaniKani wrote it */
  }
}

/*
 * The links are a safety net rather than the main event: a reloaded frame
 * brings fresh ones with it. But if that fetch fails - offline, expired
 * session - "Start Lessons" would still hand the server yesterday's date and
 * hold back today's batch, and that is worth not leaving to chance.
 */
function restampLessonLinks(root: Document, midnight: string) {
  root.querySelectorAll('a[href*="' + DAY_PARAM + '"]').forEach((link) => {
    restamp(link, 'href', midnight);
  });
}

async function fetchDocument(url: string) {
  try {
    const response = await fetch(url, {
      credentials: 'same-origin',
      headers: { Accept: 'text/html' },
    });
    if (!response.ok) return null;
    return new DOMParser().parseFromString(await response.text(), 'text/html');
  } catch (e) {
    return null; /* offline, or the session expired - keep the stale numbers */
  }
}

async function refreshCounts(dayChanged: boolean) {
  // On the hour only the numbers moved; over midnight the lesson state did.
  const selector = dayChanged ? COUNT_SELECTOR + ', ' + LESSONS_SELECTOR : COUNT_SELECTOR;
  const midnight = dayChanged ? startOfDay() : null;
  const live = countNodes(document, selector);
  if (!live.length) return; // nothing of ours on this page - nothing to do

  /*
   * A lazy <turbo-frame> is rendered empty in the outer page, so re-fetching
   * that page would only bring its placeholder back. Turbo refills those
   * itself; anything else we patch by hand.
   */
  const frames = new Set<TurboFrame>();
  const plain: HTMLElement[] = [];
  for (const node of live) {
    const frame = node.closest('turbo-frame[src]') as TurboFrame | null;
    if (frame && typeof frame.reload === 'function') frames.add(frame);
    else plain.push(node);
  }
  frames.forEach((frame) => {
    if (!(midnight && restamp(frame, 'src', midnight))) frame.reload?.();
  });
  if (midnight) restampLessonLinks(document, midnight);
  if (!plain.length) return;

  const fresh = await fetchDocument(location.href);
  if (!fresh) return;
  const updated = countNodes(fresh, selector).filter((node) => !node.closest('turbo-frame[src]'));

  // Paired by position - if the page has changed shape underneath us, leave it
  // alone rather than writing the review count into the lesson slot.
  if (updated.length !== plain.length) return;
  plain.forEach((node, i) => {
    const replacement = updated[i];
    if (replacement) node.replaceWith(replacement);
  });
  if (midnight) restampLessonLinks(document, midnight);
}

/*
 * Cheap enough to hang off the 2s tick, so the numbers turn over while you are
 * looking at the page. Both marks live in variables rather than localStorage -
 * each tab patches its own DOM, so there is nothing to share between them.
 *
 * The date is checked alongside the hour rather than instead of it: midnight
 * moves both, and one pass has to serve for both so the frames are not
 * refetched twice. A timezone change or the DST hour that repeats itself can
 * move the date without moving the hour, which is why neither implies the
 * other.
 */
export function checkClockChange() {
  if (isReviewPage()) return;
  const now = new Date();
  const hour = now.getHours();
  const date = now.toDateString();
  if (hour === lastCountHour && date === lastCountDate) return;
  const dayChanged = date !== lastCountDate;
  lastCountHour = hour;
  lastCountDate = date;
  refreshCounts(dayChanged);
}
