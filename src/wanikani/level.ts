/*
 * The quiz carries no level information - not in the subject queue, not in the
 * SRS payload, not in Item Info. The dashboard's Level Progress widget does
 * though: it renders your current level and every one of its subjects as
 *
 *   <a href="https://www.wanikani.com/radicals/charcoal" class="subject-srs-progress">
 *
 * which is the same URL shape subjectUrl() already builds for the panel's
 * cards. So read the set off the dashboard as you pass through it, cache it,
 * and match on it during the review. No API token, no extra request.
 */
import { el } from './dom';
import { LEVEL_STORAGE_KEY } from './config';
import { isReviewPage } from './session';
import { quiz } from './state';
import { subjectUrl } from './subject';
import type { ItemRecord } from './types';
let currentLevel: { level: number; paths: Set<string> } | null = null;

function subjectPath(url: string) {
  try {
    return decodeURIComponent(new URL(url, location.href).pathname);
  } catch (e) {
    return null;
  }
}

export function loadCurrentLevel() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LEVEL_STORAGE_KEY) || 'null');
    if (parsed && parsed.level && Array.isArray(parsed.paths)) {
      currentLevel = { level: parsed.level, paths: new Set(parsed.paths) };
    }
  } catch (e) {
    /* corrupt or unavailable storage - the badge just stays off */
  }
}

function saveCurrentLevel(level: { level: number; paths: Set<string> }) {
  try {
    localStorage.setItem(
      LEVEL_STORAGE_KEY,
      JSON.stringify({ level: level.level, paths: [...level.paths] })
    );
  } catch (e) {
    /* quota / private mode - it still works for this page load */
  }
}

/*
 * Runs off the tick because the widget arrives in a lazy turbo-frame. Its
 * Previous/Next buttons browse other levels, and those visits put a `level=`
 * on the frame's src - only the untouched view is showing *your* level.
 */
export function ensureCurrentLevel() {
  const widget = document.querySelector('.level-progress-widget');
  if (!widget) return;
  const frame = widget.closest('turbo-frame[src]');
  if (frame && /[?&]level=/.test(frame.getAttribute('src') || '')) return;

  const label = [...widget.querySelectorAll('.wk-button__text')]
    .map((node) => (node.textContent || '').trim())
    .find((text) => /^Level \d+$/.test(text));
  const level = label ? Number(label.replace(/\D+/g, '')) : 0;
  if (!level || (currentLevel && currentLevel.level === level)) return;

  const paths = [...widget.querySelectorAll('a.subject-srs-progress[href]')]
    .map((anchor) => subjectPath(anchor.getAttribute('href') || ''))
    .filter((path): path is string => !!path);
  if (!paths.length) return; // widget still filling in - try again next tick

  currentLevel = { level, paths: new Set(paths) };
  saveCurrentLevel(currentLevel);
}

function isCurrentLevel(record: ItemRecord | null) {
  if (!currentLevel || !record) return false;
  const url = subjectUrl(record);
  const path = url && subjectPath(url);
  return !!path && currentLevel.paths.has(path);
}

/*
 * Sits directly under the character being quizzed. WaniKani re-renders that
 * header for every question, so this is idempotent and re-runs on each new
 * question as well as off the tick.
 */
export function ensureLevelMark() {
  const existing = document.getElementById('wkrr-level');
  const anchor = document.querySelector<HTMLElement>('.character-header__characters');
  const level = currentLevel;
  const show = level && isReviewPage() && anchor && isCurrentLevel(quiz.subject);

  if (!show) {
    if (existing) existing.remove();
    return;
  }

  const text = 'Level ' + level.level;
  if (existing) {
    if (existing.textContent !== text) existing.textContent = text;
    if (existing.previousElementSibling !== anchor) anchor.after(existing);
    return;
  }
  anchor.after(el('div', { id: 'wkrr-level', text }));
}
