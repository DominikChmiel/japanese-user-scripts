/*
 * Boot and the 2s tick. Everything the script does to a page it does from
 * here: the modules it pulls in are all either pure or "make the DOM look like
 * this", and none of them wire themselves up.
 *
 * The tick exists because WaniKani navigates with Turbo, which swaps <body>
 * and prunes our <style>s out of <head> without firing anything we can rely on
 * for every case. Every ensure* function below is therefore idempotent: it is
 * cheaper to re-assert the desired state twice a second than to chase the
 * events that would tell us it changed.
 */
import { checkClockChange } from './counts';
import { el, ensureStyle } from './dom';
import { onAnswer, onComplete, onNextQuestion } from './events';
import { ensureForecastHours } from './forecast';
import { ensureCurrentLevel, ensureLevelMark, loadCurrentLevel } from './level';
import { ensureLevelItems } from './level-progress';
import { render } from './panel';
import { hidePeek, onKeyDown, onKeyUp } from './peek';
import { ensureProgressWidget, loadProgress, refreshProgress } from './progress';
import { isReviewPage, isReviewUrl, resetSession } from './session';
import { load, quiz } from './state';
import { CSS } from './styles/panel.css';
import { DARK_THEME_CSS } from './styles/dark-theme.css';
import type { TurboVisitDetail } from './types';

/*
 * Inject the bundled "WaniKani Elementary Dark" userstyle site-wide (not gated
 * on the review page), so a separate Stylus install isn't needed - the CSS is
 * embedded in ./styles/dark-theme.css. Turbo swaps <head> on navigation, so
 * re-add the <style> whenever it goes missing; the 2s tick keeps it in place
 * through any later DOM churn.
 */
function ensureDarkTheme() {
  ensureStyle('wkrr-dark-theme', DARK_THEME_CSS);
}

function ensureUI() {
  // The script runs site-wide now - only build the panel on a quiz page, and
  // tear it (and any peek) down when Turbo carries us off to the dashboard.
  if (!isReviewPage()) {
    const strayPanel = document.getElementById('wkrr-panel');
    if (strayPanel) strayPanel.remove();
    document.documentElement.classList.remove('wkrr-collapsed');
    quiz.subject = null;
    quiz.questionType = null;
    hidePeek();
    return;
  }
  ensureStyle('wkrr-style', CSS);
  if (!document.getElementById('wkrr-panel')) {
    document.body.append(el('div', { id: 'wkrr-panel' }));
    render();
  }
}

load();
loadCurrentLevel();
loadProgress();

window.addEventListener('didAnswerQuestion', onAnswer);
window.addEventListener('didCompleteSubject', onComplete);
window.addEventListener('willShowNextQuestion', onNextQuestion);

// Hold Shift to peek the current item's meaning + reading.
window.addEventListener('keydown', onKeyDown);
window.addEventListener('keyup', onKeyUp);
// Losing focus (alt-tab, clicking away) never delivers the keyup - hide anyway.
window.addEventListener('blur', hidePeek);

// A Turbo `advance` visit onto a quiz URL is "Start Reviews" - a fresh session,
// so wipe the previous recap. A plain reload is not a Turbo visit and so keeps
// the current session's recap intact.
document.addEventListener('turbo:visit', (event) => {
  const detail = (event as CustomEvent<TurboVisitDetail>).detail || {};
  if (isReviewUrl(detail.url || location.href) && detail.action !== 'restore') {
    resetSession();
  }
});

// Background tabs have their timers throttled, so catch up the moment one is
// brought back to the front instead of waiting on the next tick.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') checkClockChange();
});

// Site theme first, then the panel.
function tick() {
  ensureDarkTheme();
  ensureUI();
  checkClockChange();
  ensureCurrentLevel(); // picks the set up whenever you pass the dashboard
  ensureLevelMark();
  refreshProgress();
  ensureProgressWidget();
  // Two of WaniKani's own dashboard widgets, unfolded in place.
  ensureForecastHours();
  ensureLevelItems();
}

tick();

// Turbo swaps <body> (and prunes our <style>s out of <head>) on navigation.
document.addEventListener('turbo:load', tick);
document.addEventListener('turbo:render', tick);
setInterval(tick, 2000);
