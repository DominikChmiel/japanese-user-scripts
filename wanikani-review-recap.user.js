// ==UserScript==
// @name         WaniKani Review Recap Sidebar
// @namespace    https://github.com/dominikchmiel/review-recap-wanikani
// @version      1.0.0
// @description  Tracks every wrong meaning/reading you type during a WaniKani review and lists the failed items - with their meanings and readings - in a sidebar next to the review.
// @author       Dominik Chmiel
// @match        https://www.wanikani.com/subjects/review*
// @match        https://www.wanikani.com/subjects/extra_study*
// @match        https://www.wanikani.com/subjects/lesson/quiz*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

/*
 * How this hooks into WaniKani
 * ----------------------------
 * The review page (Turbo + Stimulus) dispatches these events on `window`:
 *
 *   willShowNextQuestion  detail: { subject, questionType }
 *   didAnswerQuestion     detail: { subjectWithStats, questionType, answer, results }
 *   didCompleteSubject    detail: { subjectWithStats }
 *
 * `subjectWithStats` is `{ subject, stats }`, deep-cloned by WaniKani before
 * dispatch. `results.action` is 'pass' or 'fail' - a 'retry' (typo warnings,
 * impossible kana, ...) never reaches these events, so every 'fail' we see is a
 * genuine wrong answer.
 *
 * An item stays in the queue until both its meaning and reading are answered
 * correctly, so "still failed" == failed at least once and no didCompleteSubject
 * yet. Those are listed first; items you eventually got right are kept in a
 * second section because their SRS stage still drops.
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------- config --

  const PANEL_WIDTH = 'clamp(280px, 20%, 460px)'; // the "rest" of the 80/20 split
  const STORAGE_KEY = 'wk-review-recap:v1';
  const EXPIRY_MS = 12 * 60 * 60 * 1000; // drop a stale session after 12h
  const MAX_WRONG_PER_TYPE = 12;

  // Pop WaniKani's own Item Info panel (the "F" hotkey) open whenever you get
  // something wrong, and expand the reading / explanation sections inside it.
  const AUTO_OPEN_ITEM_INFO_ON_FAIL = true;
  const EXPAND_ALL_ITEM_INFO_SECTIONS = true;

  // Item Info runs a little small - scale WaniKani's font-size scale inside it.
  const ITEM_INFO_FONT_SCALE = 1.15;
  const WK_FONT_SIZES = {
    xxsmall: 11,
    xsmall: 14,
    small: 16,
    medium: 18,
    large: 24,
    xlarge: 28,
    xxlarge: 38,
  };

  /*
   * Both vanilla WaniKani and the "WaniKani Elementary Dark" userstyle define
   * these on :root, so borrowing them keeps the panel in step with whichever is
   * active - pink/purple/blue on stock WaniKani, muted red/green/slate on the
   * dark theme, and anything the user customises the theme to.
   */
  const TYPE_COLOR = {
    Radical: 'var(--color-radical, #00a1f1)',
    Kanji: 'var(--color-kanji, #f100a1)',
    Vocabulary: 'var(--color-vocabulary, #a100f1)',
    KanaVocabulary: 'var(--color-vocabulary, #a100f1)',
  };

  const TYPE_LABEL = {
    Radical: 'Radical',
    Kanji: 'Kanji',
    Vocabulary: 'Vocab',
    KanaVocabulary: 'Kana Vocab',
  };

  // Short tags - the panel is narrow and "on'yomi" earns its keep as "on".
  const READING_TAG = {
    onyomi: 'on',
    kunyomi: 'kun',
    nanori: 'nanori',
  };

  // ----------------------------------------------------------------- state --

  /**
   * store.items[subjectId] = {
   *   id, type, characters, image, meanings, readings, primaryReadingType,
   *   counts:  { meaning: Number, reading: Number },   // times answered wrong
   *   wrong:   { meaning: [String], reading: [String] }, // what you actually typed
   *   completed: Boolean,                              // eventually got it right
   *   firstAt, lastAt
   * }
   */
  let store = { startedAt: Date.now(), items: {} };
  let filter = 'all'; // 'all' | 'unresolved'
  let collapsed = false;
  let renderQueued = false;

  // "Got it on a retry" is reference material, not a to-do list - keep it shut.
  let sectionCollapsed = { unresolved: false, resolved: true };

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !parsed.items) return;
      if (Date.now() - (parsed.startedAt || 0) > EXPIRY_MS) return;
      store = { startedAt: parsed.startedAt || Date.now(), items: parsed.items };
      // Records written before per-type resolution existed only knew "completed".
      for (const record of Object.values(store.items)) {
        if (!record.resolved) {
          record.resolved = { meaning: !!record.completed, reading: !!record.completed };
        }
      }
      collapsed = !!parsed.collapsed;
      if (parsed.filter === 'unresolved') filter = 'unresolved';
      if (parsed.sectionCollapsed) {
        sectionCollapsed = {
          unresolved: !!parsed.sectionCollapsed.unresolved,
          resolved: parsed.sectionCollapsed.resolved !== false,
        };
      }
    } catch (e) {
      /* corrupt or unavailable storage - start fresh */
    }
  }

  function save() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ ...store, collapsed, filter, sectionCollapsed })
      );
    } catch (e) {
      /* quota / private mode - the panel still works for this page load */
    }
  }

  function newRecord(subject) {
    const chars = subject.characters;
    return {
      id: subject.id,
      type: subject.type || subject.subject_category || 'Vocabulary',
      characters: typeof chars === 'string' ? chars : '',
      image: chars && typeof chars === 'object' ? chars.url || '' : '',
      meanings: Array.isArray(subject.meanings) ? subject.meanings : [],
      readings: Array.isArray(subject.readings) ? subject.readings : [],
      primaryReadingType: subject.primary_reading_type || '',
      counts: { meaning: 0, reading: 0 },
      wrong: { meaning: [], reading: [] },
      // Mirrors WaniKani's stats[type].complete: true once you have answered
      // that half correctly, so meaning and reading resolve independently.
      resolved: { meaning: false, reading: false },
      completed: false,
      firstAt: Date.now(),
      lastAt: Date.now(),
    };
  }

  const QUESTION_TYPES = ['meaning', 'reading'];

  /** Halves you got wrong at some point this session. */
  function failedTypes(record) {
    return QUESTION_TYPES.filter((type) => record.counts[type] > 0);
  }

  /** Halves you got wrong and have not since answered correctly. */
  function outstandingTypes(record) {
    return failedTypes(record).filter((type) => !record.resolved[type]);
  }

  // ------------------------------------------------------------- item info --

  /*
   * WaniKani's Item Info panel is the "F" hotkey. Its toggle is an anchor with
   * data-item-info-target="toggle"; additional_content_controller marks it open
   * with .additional-content__item--open and refuses to act while it still
   * carries .additional-content__item--disabled (which item_info_controller
   * only removes once an answer has been submitted).
   *
   * WaniKani also has its own auto-open setting, so check the open state before
   * clicking - otherwise we would toggle the panel back shut.
   */
  function openItemInfo() {
    const toggle = document.querySelector('[data-item-info-target="toggle"]');
    if (!toggle) return;
    if (toggle.classList.contains('additional-content__item--disabled')) return;
    if (!toggle.classList.contains('additional-content__item--open')) {
      toggle.click();
    }
    if (EXPAND_ALL_ITEM_INFO_SECTIONS) expandItemInfoSections();
  }

  /*
   * Sections inside the frame only auto-expand when they match the question type
   * you were just asked (meaning sections on meaning questions, and so on), so
   * after a miss the reading and explanation are usually still collapsed. The
   * frame loads over the network, hence the short poll.
   */
  function expandItemInfoSections(attempt = 0) {
    const frame = document.getElementById('subject-info');
    if (!frame) return;
    const collapsedSections = frame.querySelectorAll(
      '.subject-section--collapsible:not([expanded]) [data-toggle-target="toggle"]'
    );
    collapsedSections.forEach((toggle) => toggle.click());

    // Nothing rendered yet - try again while the turbo-frame is still loading.
    if (!frame.querySelector('.subject-section') && attempt < 20) {
      setTimeout(() => expandItemInfoSections(attempt + 1), 100);
    }
  }

  // ---------------------------------------------------------------- events --

  function onAnswer(event) {
    const detail = event.detail || {};
    const subject = (detail.subjectWithStats || {}).subject;
    if (!subject || subject.id == null) return;
    const stats = (detail.subjectWithStats || {}).stats || {};

    const failed = !!detail.results && detail.results.action === 'fail';
    const type = detail.questionType === 'reading' ? 'reading' : 'meaning';

    if (failed && AUTO_OPEN_ITEM_INFO_ON_FAIL) {
      // Let WaniKani's own didAnswerQuestion listeners run first: the toggle is
      // still disabled until item_info_controller#enable has fired.
      setTimeout(openItemInfo, 0);
    }

    let record = store.items[subject.id];
    if (!record) {
      if (!failed) return; // only ever track items you got wrong
      record = store.items[subject.id] = newRecord(subject);
    }

    record.lastAt = Date.now();
    if (failed) {
      record.counts[type] += 1;
      const answer = String(detail.answer == null ? '' : detail.answer).trim();
      const seen = record.wrong[type];
      if (answer && !seen.includes(answer) && seen.length < MAX_WRONG_PER_TYPE) {
        seen.push(answer);
      }
    }

    // Take resolution straight from WaniKani's own bookkeeping rather than
    // inferring it: stats[type].complete flips true on a pass, false on a fail.
    for (const questionType of QUESTION_TYPES) {
      if (stats[questionType]) {
        record.resolved[questionType] = !!stats[questionType].complete;
      }
    }

    save();
    scheduleRender();
  }

  function onComplete(event) {
    const subject = ((event.detail || {}).subjectWithStats || {}).subject;
    if (!subject || subject.id == null) return;
    const record = store.items[subject.id];
    if (!record) return; // completed without ever failing - not our business
    record.completed = true;
    record.resolved.meaning = true;
    record.resolved.reading = true;
    record.lastAt = Date.now();
    save();
    scheduleRender();
  }

  // ------------------------------------------------------------- rendering --

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const key of Object.keys(attrs)) {
        const value = attrs[key];
        if (value == null || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2), value);
        else node.setAttribute(key, value);
      }
    }
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      node.append(child);
    }
    return node;
  }

  function meaningsOf(record) {
    const primary = record.meanings.filter((m) => m.kind === 'primary').map((m) => m.text);
    const alternative = record.meanings
      .filter((m) => m.kind === 'alternative')
      .map((m) => m.text);
    return { primary, alternative };
  }

  /** Grouped readings, blocked ones removed. Kanji get on/kun tags. */
  function readingGroupsOf(record) {
    const usable = (record.readings || []).filter((r) => r.kind !== 'blocked' && r.text);
    if (!usable.length) return [];

    if (record.type !== 'Kanji') {
      return [{ label: '', readings: usable }];
    }

    const order = [];
    const byType = new Map();
    for (const reading of usable) {
      const key = reading.type || '';
      if (!byType.has(key)) {
        byType.set(key, []);
        order.push(key);
      }
      byType.get(key).push(reading);
    }
    return order.map((key) => ({
      label: READING_TAG[key] || key,
      readings: byType.get(key),
    }));
  }

  function subjectUrl(record) {
    if (record.type === 'Radical') {
      const primary = meaningsOf(record).primary[0] || '';
      const slug = primary
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
      return slug ? 'https://www.wanikani.com/radicals/' + slug : null;
    }
    if (!record.characters) return null;
    const segment = record.type === 'Kanji' ? 'kanji' : 'vocabulary';
    return 'https://www.wanikani.com/' + segment + '/' + encodeURIComponent(record.characters);
  }

  /**
   * `types` selects which halves to render. Outstanding items show only the half
   * that is still wrong; the retry section shows everything you missed.
   */
  function card(record, types) {
    const show = types && types.length ? types : failedTypes(record);
    const showMeaning = show.includes('meaning');
    const showReading = show.includes('reading');
    const { primary, alternative } = meaningsOf(record);
    const groups = showReading ? readingGroupsOf(record) : [];
    const url = subjectUrl(record);
    const color = TYPE_COLOR[record.type] || '#8a8a8a';

    const characterNode = record.image
      ? el('img', { class: 'wkrr-card__image', src: record.image, alt: primary[0] || 'radical' })
      : el('span', { class: 'wkrr-card__chars', lang: 'ja', text: record.characters || '?' });

    const head = el(
      'div',
      { class: 'wkrr-card__head' },
      url
        ? el(
            'a',
            {
              class: 'wkrr-card__link',
              href: url,
              target: '_blank',
              rel: 'noreferrer',
              title: 'Open on WaniKani',
            },
            characterNode
          )
        : characterNode,
      el(
        'div',
        { class: 'wkrr-card__badges' },
        el('span', { class: 'wkrr-card__type', text: TYPE_LABEL[record.type] || record.type }),
        showMeaning &&
          record.counts.meaning > 0 &&
          el('span', {
            class: 'wkrr-card__count',
            title: 'Wrong meaning answers',
            text: 'M ×' + record.counts.meaning,
          }),
        showReading &&
          record.counts.reading > 0 &&
          el('span', {
            class: 'wkrr-card__count',
            title: 'Wrong reading answers',
            text: 'R ×' + record.counts.reading,
          })
      )
    );

    // No row labels: the values carry their own meaning. English text is the
    // meaning, Japanese text is the reading, struck-through red is what you typed.
    const rows = [];

    if (showMeaning && (primary.length || alternative.length)) {
      rows.push(
        el(
          'div',
          { class: 'wkrr-line' },
          el('span', { class: 'wkrr-meaning', text: primary.join(', ') }),
          alternative.length
            ? el('span', { class: 'wkrr-meaning-alt', text: ' ' + alternative.join(', ') })
            : null
        )
      );
    }

    for (const group of groups) {
      rows.push(
        el(
          'div',
          { class: 'wkrr-line' },
          el(
            'span',
            { class: 'wkrr-readings', lang: 'ja' },
            group.readings.map((reading, index) =>
              el(
                'span',
                { class: 'wkrr-reading' + (reading.kind === 'primary' ? ' is-primary' : '') },
                (index ? '、' : '') + reading.text
              )
            )
          ),
          group.label ? el('span', { class: 'wkrr-tag', text: group.label }) : null
        )
      );
    }

    const wrongChips = [];
    for (const type of show) {
      for (const answer of record.wrong[type]) {
        wrongChips.push(
          el('span', {
            class: 'wkrr-chip wkrr-chip--' + type,
            title: 'Your wrong ' + type + ' answer',
            lang: type === 'reading' ? 'ja' : null,
            text: answer,
          })
        );
      }
    }
    if (wrongChips.length) {
      rows.push(el('div', { class: 'wkrr-line wkrr-chips' }, wrongChips));
    }

    return el(
      'div',
      {
        class: 'wkrr-card' + (record.completed ? ' is-resolved' : ''),
        style: '--wkrr-accent:' + color,
      },
      head,
      el('div', { class: 'wkrr-card__body' }, rows)
    );
  }

  function sortedRecords() {
    return Object.keys(store.items)
      .map((id) => store.items[id])
      .sort((a, b) => b.lastAt - a.lastAt);
  }

  function section(key, title, hint, records, typesFor) {
    if (!records.length) return null;
    const isCollapsed = !!sectionCollapsed[key];
    return el(
      'div',
      { class: 'wkrr-section' + (isCollapsed ? ' is-collapsed' : '') },
      el(
        'button',
        {
          class: 'wkrr-section__head',
          title: isCollapsed ? 'Expand' : 'Collapse',
          'aria-expanded': String(!isCollapsed),
          onclick: () => {
            sectionCollapsed[key] = !sectionCollapsed[key];
            save();
            render();
          },
        },
        el('span', { class: 'wkrr-section__chevron', text: '▾' }),
        el('span', { class: 'wkrr-section__title', text: title }),
        el('span', { class: 'wkrr-section__count', text: String(records.length) })
      ),
      isCollapsed
        ? null
        : el(
            'div',
            { class: 'wkrr-section__body' },
            hint ? el('div', { class: 'wkrr-section__hint', text: hint }) : null,
            records.map((record) => card(record, typesFor(record)))
          )
    );
  }

  function exportText() {
    const lines = ['WaniKani review mistakes', ''];
    for (const record of sortedRecords()) {
      const { primary, alternative } = meaningsOf(record);
      const outstanding = outstandingTypes(record);
      const readings = readingGroupsOf(record)
        .map((g) => (g.label ? g.label + ': ' : '') + g.readings.map((r) => r.text).join('、'))
        .join(' | ');
      lines.push(
        '- ' +
          (record.characters || primary[0] || '?') +
          ' (' +
          (TYPE_LABEL[record.type] || record.type) +
          (outstanding.length ? ', still failing ' + outstanding.join(' + ') : '') +
          ')'
      );
      if (failedTypes(record).includes('meaning')) {
        lines.push(
          '  meaning: ' +
            primary.join(', ') +
            (alternative.length ? ' [' + alternative.join(', ') + ']' : '')
        );
        if (record.wrong.meaning.length) {
          lines.push('  typed (meaning): ' + record.wrong.meaning.join(' / '));
        }
      }
      if (failedTypes(record).includes('reading')) {
        if (readings) lines.push('  reading: ' + readings);
        if (record.wrong.reading.length) {
          lines.push('  typed (reading): ' + record.wrong.reading.join(' / '));
        }
      }
    }
    return lines.join('\n');
  }

  function render() {
    const panel = document.getElementById('wkrr-panel');
    if (!panel) return;

    document.documentElement.classList.toggle('wkrr-collapsed', collapsed);
    panel.replaceChildren();

    if (collapsed) {
      const total = Object.keys(store.items).length;
      panel.append(
        el(
          'button',
          {
            class: 'wkrr-reopen',
            title: 'Show review recap',
            onclick: () => {
              collapsed = false;
              save();
              render();
            },
          },
          el('span', { class: 'wkrr-reopen__label', text: 'Recap' }),
          total ? el('span', { class: 'wkrr-reopen__count', text: String(total) }) : null
        )
      );
      return;
    }

    // Grouped by outstanding halves, not by whether the subject is finished: a
    // kanji whose reading is still wrong belongs here even if its meaning is fine.
    const records = sortedRecords();
    const unresolved = records.filter((r) => outstandingTypes(r).length > 0);
    const resolved = records.filter((r) => outstandingTypes(r).length === 0);

    const header = el(
      'div',
      { class: 'wkrr-header' },
      el(
        'div',
        { class: 'wkrr-header__top' },
        el('span', { class: 'wkrr-header__title', text: 'Review Recap' }),
        el('button', {
          class: 'wkrr-icon-btn',
          title: 'Collapse panel',
          text: '›',
          onclick: () => {
            collapsed = true;
            save();
            render();
          },
        })
      ),
      el(
        'div',
        { class: 'wkrr-stats' },
        el(
          'span',
          { class: 'wkrr-stat' },
          el('b', { text: String(unresolved.length) }),
          ' still failed'
        ),
        el('span', { class: 'wkrr-stat' }, el('b', { text: String(records.length) }), ' missed total')
      ),
      el(
        'div',
        { class: 'wkrr-toolbar' },
        el('button', {
          class: 'wkrr-tab' + (filter === 'all' ? ' is-active' : ''),
          text: 'All',
          onclick: () => {
            filter = 'all';
            save();
            render();
          },
        }),
        el('button', {
          class: 'wkrr-tab' + (filter === 'unresolved' ? ' is-active' : ''),
          text: 'Still failed',
          onclick: () => {
            filter = 'unresolved';
            save();
            render();
          },
        }),
        el('span', { class: 'wkrr-toolbar__spacer' }),
        el('button', {
          class: 'wkrr-text-btn',
          title: 'Copy the list as text',
          text: 'Copy',
          onclick: (event) => {
            const button = event.currentTarget;
            navigator.clipboard.writeText(exportText()).then(
              () => {
                button.textContent = 'Copied';
                setTimeout(() => {
                  button.textContent = 'Copy';
                }, 1200);
              },
              () => {
                button.textContent = 'Failed';
                setTimeout(() => {
                  button.textContent = 'Copy';
                }, 1200);
              }
            );
          },
        }),
        el('button', {
          class: 'wkrr-text-btn',
          title: 'Forget everything tracked so far',
          text: 'Clear',
          onclick: () => {
            store = { startedAt: Date.now(), items: {} };
            save();
            render();
          },
        })
      )
    );

    const body = el('div', { class: 'wkrr-body' });

    if (!records.length) {
      body.append(
        el(
          'div',
          { class: 'wkrr-empty' },
          el('div', { class: 'wkrr-empty__mark', text: '〇' }),
          el('div', { text: 'No mistakes yet.' }),
          el('div', { class: 'wkrr-empty__sub', text: 'Items you get wrong show up here.' })
        )
      );
    } else if (filter === 'unresolved') {
      body.append(
        section(
          'unresolved',
          'Still failed',
          'Not yet answered correctly - they will come back.',
          unresolved,
          outstandingTypes
        ) || el('div', { class: 'wkrr-empty', text: 'Nothing outstanding right now.' })
      );
    } else {
      body.append(
        section(
          'unresolved',
          'Still failed',
          'Not yet answered correctly - they will come back.',
          unresolved,
          outstandingTypes
        ),
        section(
          'resolved',
          'Got it on a retry',
          'Answered correctly later, but the SRS level still drops.',
          resolved,
          failedTypes
        )
      );
    }

    panel.append(header, body);
  }

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render();
    });
  }

  // ------------------------------------------------------------------- css --

  const scaled = (name) => Math.round(WK_FONT_SIZES[name] * ITEM_INFO_FONT_SCALE);

  const CSS = `
:root { --wkrr-w: ${PANEL_WIDTH}; }
html.wkrr-collapsed { --wkrr-w: 0px; }

/* WaniKani's .quiz is position:fixed;width:100% - shrink it to free the right column */
.quiz { width: calc(100% - var(--wkrr-w)) !important; }

/* Item Info reads small at default size - scale WaniKani's own font-size scale. */
#subject-info, .subject-info {
  font-size: ${scaled('small')}px;
  --font-size-xxsmall: ${scaled('xxsmall')}px;
  --font-size-xsmall: ${scaled('xsmall')}px;
  --font-size-small: ${scaled('small')}px;
  --font-size-medium: ${scaled('medium')}px;
  --font-size-large: ${scaled('large')}px;
  --font-size-xlarge: ${scaled('xlarge')}px;
  --font-size-xxlarge: ${scaled('xxlarge')}px;
}

/*
 * Light values are the defaults; [data-theme="dark"] is set at runtime when the
 * page is actually dark and mirrors the "WaniKani Elementary Dark" palette,
 * deferring to its --USER-* variables so user customisation carries over.
 */
#wkrr-panel {
  --wkrr-bg: #f4f4f4;
  --wkrr-card: #ffffff;
  --wkrr-raised: #ffffff;
  --wkrr-border: #e0e0e0;
  --wkrr-fg: #333333;
  --wkrr-muted: #8a8a8a;
  --wkrr-faint: #b4b4b4;
  --wkrr-bad: #c0392b;
  --wkrr-bad-bg: #fdeaea;
  --wkrr-on-accent: #ffffff;

  position: fixed; top: 0; right: 0; bottom: 0;
  width: var(--wkrr-w);
  display: flex; flex-direction: column;
  background: var(--wkrr-bg); color: var(--wkrr-fg);
  border-left: 1px solid var(--wkrr-border);
  font-family: var(--font-family-default, "Noto Sans", Helvetica, Arial, sans-serif);
  font-size: 13px; line-height: 1.45;
  z-index: 100; overflow: hidden;
  box-sizing: border-box;
}
#wkrr-panel[data-theme="dark"] {
  --wkrr-bg: var(--USER-surface-1, #151515);
  --wkrr-card: var(--USER-surface-2, #282828);
  --wkrr-raised: var(--USER-surface-3, #303030);
  --wkrr-border: var(--USER-surface-4, #535353);
  --wkrr-fg: var(--USER-text, #eeeeee);
  --wkrr-muted: var(--USER-text-grayed, #bbbbbb);
  --wkrr-faint: color-mix(in srgb, var(--USER-text-grayed, #bbbbbb), transparent 40%);
  --wkrr-bad: color-mix(in srgb, var(--USER-incorrect, #9c4644), white 25%);
  --wkrr-bad-bg: color-mix(in srgb, var(--USER-incorrect, #9c4644), transparent 78%);
  --wkrr-on-accent: var(--USER-text, #eeeeee);
}
#wkrr-panel *, #wkrr-panel *::before, #wkrr-panel *::after { box-sizing: border-box; }

html.wkrr-collapsed #wkrr-panel {
  width: auto; background: none; border: 0; overflow: visible;
  top: 50%; bottom: auto; transform: translateY(-50%);
}
.wkrr-reopen {
  display: flex; align-items: center; gap: 6px;
  writing-mode: vertical-rl;
  padding: 14px 6px; border: 0; cursor: pointer;
  background: var(--color-kanji, #f100a1); color: var(--wkrr-on-accent);
  border-radius: 6px 0 0 6px;
  font: inherit; font-weight: 700; letter-spacing: .04em;
  box-shadow: 0 2px 8px rgba(0,0,0,.35);
}
.wkrr-reopen__count {
  background: rgba(255,255,255,.28); border-radius: 8px; padding: 3px 5px; font-size: 11px;
}

.wkrr-header {
  padding: 10px 12px; background: var(--wkrr-raised);
  border-bottom: 1px solid var(--wkrr-border); flex: none;
}
.wkrr-header__top { display: flex; align-items: center; justify-content: space-between; }
.wkrr-header__title { font-weight: 700; font-size: 14px; letter-spacing: .02em; }
.wkrr-icon-btn {
  border: 0; background: none; cursor: pointer; color: var(--wkrr-muted);
  font-size: 20px; line-height: 1; padding: 2px 6px; border-radius: 4px;
}
.wkrr-icon-btn:hover { background: var(--wkrr-border); color: var(--wkrr-fg); }

.wkrr-stats { display: flex; gap: 12px; margin-top: 4px; color: var(--wkrr-muted); font-size: 12px; }
.wkrr-stat b { color: var(--wkrr-fg); font-size: 13px; }

.wkrr-toolbar { display: flex; align-items: center; gap: 4px; margin-top: 8px; }
.wkrr-toolbar__spacer { flex: 1; }
.wkrr-tab {
  border: 1px solid var(--wkrr-border); background: transparent; color: var(--wkrr-muted);
  border-radius: 999px; padding: 3px 10px; cursor: pointer; font: inherit; font-size: 12px;
}
.wkrr-tab:hover { color: var(--wkrr-fg); }
.wkrr-tab.is-active {
  background: var(--wkrr-fg); border-color: var(--wkrr-fg); color: var(--wkrr-bg);
}
.wkrr-text-btn {
  border: 0; background: none; color: var(--wkrr-muted); cursor: pointer;
  font: inherit; font-size: 12px; padding: 3px 5px; border-radius: 4px;
}
.wkrr-text-btn:hover { background: var(--wkrr-border); color: var(--wkrr-fg); }

.wkrr-body { flex: 1; overflow-y: auto; overscroll-behavior: contain; padding: 8px; }

.wkrr-section + .wkrr-section { margin-top: 12px; }
.wkrr-section__head {
  display: flex; align-items: center; gap: 6px; width: 100%;
  padding: 4px; border: 0; background: none; cursor: pointer;
  border-radius: 4px; font: inherit; text-align: left;
}
.wkrr-section__head:hover { background: var(--wkrr-card); }
.wkrr-section__chevron {
  color: var(--wkrr-faint); font-size: 10px; line-height: 1;
  transition: transform .15s ease;
}
.wkrr-section.is-collapsed .wkrr-section__chevron { transform: rotate(-90deg); }
.wkrr-section__title {
  flex: 1; font-weight: 700; font-size: 12px;
  text-transform: uppercase; letter-spacing: .06em; color: var(--wkrr-muted);
}
.wkrr-section__count {
  background: var(--wkrr-border); color: var(--wkrr-fg); border-radius: 999px;
  padding: 1px 7px; font-size: 11px; font-weight: 700;
}
.wkrr-section__hint { padding: 0 4px 6px; color: var(--wkrr-faint); font-size: 11px; }

.wkrr-card {
  background: var(--wkrr-card); border: 1px solid var(--wkrr-border);
  border-left: 4px solid var(--wkrr-accent);
  border-radius: 5px; margin-bottom: 8px; overflow: hidden;
}
.wkrr-card.is-resolved { opacity: .7; }
.wkrr-card.is-resolved:hover { opacity: 1; }
.wkrr-card__head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 7px 10px; background: var(--wkrr-accent); color: var(--wkrr-on-accent);
}
.wkrr-card__link { color: inherit; text-decoration: none; display: inline-flex; align-items: center; }
.wkrr-card__link:hover { text-decoration: underline; }
.wkrr-card__chars { font-size: 24px; line-height: 1.15; font-weight: 500; }
.wkrr-card__image { height: 26px; width: auto; filter: brightness(0) invert(1); }
.wkrr-card__badges { display: flex; align-items: center; gap: 4px; flex: none; }
.wkrr-card__type { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; opacity: .8; }
.wkrr-card__count {
  background: rgba(0,0,0,.25); border-radius: 999px; padding: 1px 6px;
  font-size: 11px; font-weight: 700; white-space: nowrap;
}

/* Unlabelled value rows: English = meaning, Japanese = reading, red = you typed. */
.wkrr-card__body { padding: 6px 10px 8px; }
.wkrr-line {
  display: flex; align-items: baseline; flex-wrap: wrap; gap: 5px;
  padding: 2px 0; word-wrap: break-word;
}
.wkrr-meaning { font-weight: 600; font-size: 17px; }
.wkrr-meaning-alt { color: var(--wkrr-muted); font-size: 14px; }
.wkrr-readings { font-size: 21px; }
.wkrr-reading.is-primary { font-weight: 700; }
.wkrr-tag {
  color: var(--wkrr-faint); font-size: 10px; letter-spacing: .06em;
  text-transform: uppercase; border: 1px solid var(--wkrr-border);
  border-radius: 3px; padding: 0 4px; line-height: 1.5;
}

.wkrr-chips { gap: 4px; margin-top: 2px; }
.wkrr-chip {
  background: var(--wkrr-bad-bg); color: var(--wkrr-bad);
  border: 1px solid color-mix(in srgb, var(--wkrr-bad), transparent 55%);
  border-radius: 4px; padding: 1px 6px; font-size: 14px;
  text-decoration: line-through; text-decoration-color: color-mix(in srgb, var(--wkrr-bad), transparent 45%);
}
.wkrr-chip--reading { font-size: 16px; }

.wkrr-empty { text-align: center; color: var(--wkrr-muted); padding: 34px 14px; }
.wkrr-empty__mark { font-size: 26px; color: var(--wkrr-faint); margin-bottom: 6px; }
.wkrr-empty__sub { font-size: 11px; margin-top: 3px; color: var(--wkrr-faint); }

/* Below ~900px an 80/20 split is unusable - keep the panel out of the way. */
@media (max-width: 900px) {
  :root { --wkrr-w: 0px; }
  #wkrr-panel {
    width: auto; background: none; border: 0; overflow: visible;
    top: 50%; bottom: auto; transform: translateY(-50%);
  }
  #wkrr-panel .wkrr-header, #wkrr-panel .wkrr-body { display: none; }
}
`;

  // ------------------------------------------------------------------ boot --

  /**
   * Relative luminance of a CSS colour, or null if it can't be read.
   * Handles #rgb, #rrggbb and rgb()/rgba() - everything getComputedStyle returns.
   */
  function luminanceOf(color) {
    if (!color) return null;
    let r;
    let g;
    let b;
    const hex = color.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (hex) {
      const digits = hex[1];
      const full =
        digits.length === 3
          ? digits
              .split('')
              .map((c) => c + c)
              .join('')
          : digits;
      r = parseInt(full.slice(0, 2), 16);
      g = parseInt(full.slice(2, 4), 16);
      b = parseInt(full.slice(4, 6), 16);
    } else {
      const rgb = color.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
      if (!rgb) return null;
      r = parseFloat(rgb[1]);
      g = parseFloat(rgb[2]);
      b = parseFloat(rgb[3]);
    }
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  }

  /*
   * Stock WaniKani sets --color-app-background to #F4F4F4; the Elementary Dark
   * userstyle overrides it to #151515. Reading it back covers that theme, any
   * other userstyle, and WaniKani's own future dark mode without hardcoding.
   */
  function applyTheme(panel) {
    const root = getComputedStyle(document.documentElement);
    let lum = luminanceOf(root.getPropertyValue('--color-app-background'));
    if (lum == null) lum = luminanceOf(getComputedStyle(document.body).backgroundColor);
    const theme = lum != null && lum < 0.45 ? 'dark' : 'light';
    if (panel.dataset.theme !== theme) panel.dataset.theme = theme;
  }

  function ensureUI() {
    if (!document.getElementById('wkrr-style')) {
      document.head.append(el('style', { id: 'wkrr-style', text: CSS }));
    }
    let panel = document.getElementById('wkrr-panel');
    if (!panel) {
      panel = el('div', { id: 'wkrr-panel' });
      document.body.append(panel);
      render();
    }
    applyTheme(panel);
  }

  load();

  window.addEventListener('didAnswerQuestion', onAnswer);
  window.addEventListener('didCompleteSubject', onComplete);

  ensureUI();

  // Turbo swaps <body> (and prunes our <style> out of <head>) on navigation.
  document.addEventListener('turbo:load', ensureUI);
  document.addEventListener('turbo:render', ensureUI);
  setInterval(ensureUI, 2000);
})();
