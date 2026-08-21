/*
 * Which URLs count as "in a review", and what starting a new one means.
 */
import { clearStore, quiz, save } from './state';
import { scheduleRender } from './panel';

/*
 * Only the quiz pages carry a quiz. The script runs site-wide (see the
 * broadened @match), so every UI/event path gates on this.
 *
 * Reviews and extra study are still under /subjects. Lessons are not: they now
 * live at /subject-lessons/<session>/<subject>, and their quiz - the half this
 * script cares about - at /subject-lessons/<session>/quiz. The old
 * /subjects/lesson/quiz is kept because it costs one regex to keep tolerating a
 * URL some deployment might still serve, and dropping it would silently turn
 * the panel off again for anyone who gets one.
 */
export function isReviewUrl(url: string) {
  try {
    const path = new URL(url, location.href).pathname;
    return (
      /^\/subjects\/(review|extra_study)(\/|$)/.test(path) ||
      /^\/subject-lessons\/[^/]+\/quiz(\/|$)/.test(path) ||
      /^\/subjects\/lesson\/quiz(\/|$)/.test(path)
    );
  } catch (e) {
    return false;
  }
}

export function isReviewPage() {
  return isReviewUrl(location.href);
}

/*
 * A recap is per review session. localStorage lets it survive an accidental F5
 * mid-session, but a *new* session must start clean - otherwise a reading you
 * failed yesterday lingers next to a kanji you get right today.
 *
 * A browser reload is not a Turbo visit, so it never lands here; clicking
 * "Start Reviews" (a Turbo `advance` visit onto a quiz URL) does. That is
 * exactly the boundary we want to reset on. `restore` (back/forward) is left
 * alone so bouncing back into a session keeps its recap.
 */
export function resetSession() {
  clearStore();
  quiz.subject = null;
  quiz.questionType = null;
  save();
  scheduleRender();
}
