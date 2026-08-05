// ==UserScript==
// @name         WaniKani Review Recap Sidebar
// @namespace    https://github.com/dominikchmiel/review-recap-wanikani
// @version      1.3.1
// @description  Tracks every wrong meaning/reading you type during a WaniKani review and lists the failed items - with their meanings and readings - in a sidebar next to the review.
// @author       Dominik Chmiel
// Match the whole site, not just the review URLs: WaniKani navigates with Turbo
// (SPA-style), so a userscript scoped to /subjects/review* is only injected when
// you land there with a full page load. Injecting everywhere lets us be present
// before you click "Start Reviews" and wire the UI up on the Turbo navigation.
// @match        https://www.wanikani.com/*
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

  // Bundle the "WaniKani Elementary Dark" userstyle (userstyles.world/style/22026)
  // so a separate Stylus install isn't needed. Set to false to leave WaniKani's
  // own styling alone. The CSS is embedded in DARK_THEME_CSS near the bottom.
  const LOAD_DARK_THEME = true;

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

  // The subject currently being asked (from willShowNextQuestion) and which half
  // is being quizzed. Drives the Shift-to-peek popover; not persisted.
  let currentSubject = null;
  let currentQuestionType = null;

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

  // ---------------------------------------------------------- session scope --

  /*
   * Only /subjects/review, /subjects/extra_study and /subjects/lesson/quiz carry
   * the quiz. The script now runs site-wide (see the broadened @match), so every
   * UI/event path gates on this.
   */
  function isReviewUrl(url) {
    try {
      const path = new URL(url, location.href).pathname;
      return (
        /^\/subjects\/(review|extra_study)(\/|$)/.test(path) ||
        /^\/subjects\/lesson\/quiz(\/|$)/.test(path)
      );
    } catch (e) {
      return false;
    }
  }

  function isReviewPage() {
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
  function resetSession() {
    store = { startedAt: Date.now(), items: {} };
    currentSubject = null;
    currentQuestionType = null;
    save();
    scheduleRender();
  }

  function onNextQuestion(event) {
    const detail = event.detail || {};
    const subject = detail.subject;
    if (subject && subject.id != null) {
      currentSubject = newRecord(subject);
      currentQuestionType = detail.questionType === 'reading' ? 'reading' : 'meaning';
    }
    hidePeek(); // never carry a reveal across to the next item
  }

  // --------------------------------------------------------------- peek --

  /*
   * Hold Shift to reveal the meaning + reading of the item you are being asked
   * right now. The half currently being quizzed is highlighted. Built from
   * currentSubject, so it works whether or not the item has been failed.
   */
  function buildPeek() {
    const record = currentSubject;
    if (!record) return el('div');
    const { primary, alternative } = meaningsOf(record);
    const groups = readingGroupsOf(record);
    const color = TYPE_COLOR[record.type] || '#8a8a8a';

    const characterNode = record.image
      ? el('img', { class: 'wkrr-peek__image', src: record.image, alt: primary[0] || '' })
      : el('span', { class: 'wkrr-peek__chars', lang: 'ja', text: record.characters || '?' });

    const rows = [];
    if (primary.length || alternative.length) {
      rows.push(
        el(
          'div',
          { class: 'wkrr-peek__row' + (currentQuestionType === 'meaning' ? ' is-asked' : '') },
          el('span', { class: 'wkrr-peek__label', text: 'Meaning' }),
          el(
            'div',
            { class: 'wkrr-line' },
            el('span', { class: 'wkrr-meaning', text: primary.join(', ') }),
            alternative.length
              ? el('span', { class: 'wkrr-meaning-alt', text: ' ' + alternative.join(', ') })
              : null
          )
        )
      );
    }
    for (const group of groups) {
      rows.push(
        el(
          'div',
          { class: 'wkrr-peek__row' + (currentQuestionType === 'reading' ? ' is-asked' : '') },
          el('span', {
            class: 'wkrr-peek__label',
            text: group.label ? 'Reading · ' + group.label : 'Reading',
          }),
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
          )
        )
      );
    }

    return el(
      'div',
      { class: 'wkrr-peek__inner', style: '--wkrr-accent:' + color },
      el(
        'div',
        { class: 'wkrr-peek__head' },
        characterNode,
        el('span', { class: 'wkrr-peek__type', text: TYPE_LABEL[record.type] || record.type })
      ),
      el('div', { class: 'wkrr-peek__body' }, rows),
      el('div', { class: 'wkrr-peek__hint', text: 'Release Shift to hide' })
    );
  }

  function showPeek() {
    if (!isReviewPage() || !currentSubject) return;
    let peek = document.getElementById('wkrr-peek');
    if (!peek) {
      peek = el('div', { id: 'wkrr-peek' });
      document.body.append(peek);
    }
    peek.replaceChildren(buildPeek());
    peek.classList.add('is-visible');
  }

  function hidePeek() {
    const peek = document.getElementById('wkrr-peek');
    if (peek) peek.classList.remove('is-visible');
  }

  function onKeyDown(event) {
    // Ignore auto-repeat while the key is held, and modifier combos (Shift+Tab,
    // capitalising a letter, ...) so only a bare Shift press reveals the answer.
    if (event.key !== 'Shift' || event.repeat) return;
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    showPeek();
  }

  function onKeyUp(event) {
    if (event.key === 'Shift') hidePeek();
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
 * Dark only - the panel is never shown light. Values match the bundled "WaniKani
 * Elementary Dark" palette and defer to its --USER-* variables where a Stylus
 * install defines them, so the panel reads as one system with the theme and
 * inherits any user colour customisation.
 */
#wkrr-panel {
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

/* Shift-to-peek popover. Dark only, matching the panel's palette. */
#wkrr-peek {
  --wkrr-bg: var(--USER-surface-1, #151515);
  --wkrr-card: var(--USER-surface-2, #282828);
  --wkrr-border: var(--USER-surface-4, #535353);
  --wkrr-fg: var(--USER-text, #eeeeee);
  --wkrr-muted: var(--USER-text-grayed, #bbbbbb);
  --wkrr-faint: color-mix(in srgb, var(--USER-text-grayed, #bbbbbb), transparent 40%);
  --wkrr-on-accent: var(--USER-text, #eeeeee);

  position: fixed; left: 50%; top: 14%; transform: translateX(-50%);
  z-index: 10000; display: none;
  width: max-content; max-width: min(440px, 92vw);
  background: var(--wkrr-card); color: var(--wkrr-fg);
  border: 1px solid var(--wkrr-border); border-radius: 10px;
  box-shadow: 0 12px 44px rgba(0,0,0,.35);
  font-family: var(--font-family-default, "Noto Sans", Helvetica, Arial, sans-serif);
  overflow: hidden;
}
#wkrr-peek.is-visible { display: block; }
#wkrr-peek *, #wkrr-peek *::before, #wkrr-peek *::after { box-sizing: border-box; }

.wkrr-peek__head {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 16px; background: var(--wkrr-accent); color: var(--wkrr-on-accent);
}
.wkrr-peek__chars { font-size: 34px; line-height: 1.1; font-weight: 500; }
.wkrr-peek__image { height: 34px; width: auto; filter: brightness(0) invert(1); }
.wkrr-peek__type {
  font-size: 11px; text-transform: uppercase; letter-spacing: .05em; opacity: .85;
}
.wkrr-peek__body { padding: 10px 14px; display: flex; flex-direction: column; gap: 6px; }
.wkrr-peek__row {
  display: flex; flex-direction: column; gap: 2px;
  padding: 6px 8px; border-radius: 6px;
}
.wkrr-peek__row.is-asked {
  background: var(--wkrr-bg); box-shadow: inset 0 0 0 1px var(--wkrr-border);
}
.wkrr-peek__label {
  font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--wkrr-muted);
}
.wkrr-peek__hint {
  padding: 8px 16px 12px; color: var(--wkrr-faint); font-size: 11px;
}
`;

  /*
   * "WaniKani Elementary Dark" by Everesh (userstyles.world/style/22026, MIT),
   * embedded verbatim. The original is a Stylus style: its metadata header and
   * @advanced config blocks are stripped, the Firefox-only @-moz-document wrapper
   * is unwrapped (Chrome ignores the at-rule, so the rules would never apply),
   * and the lone Stylus "wkof_mode" placeholder is dropped. The theme's --USER-*
   * variables aren't defined without Stylus, so every var(--USER-x, #fallback)
   * resolves to its fallback - the theme's intended default look. String.raw
   * keeps CSS escapes intact without doubling backslashes.
   */
  const DARK_THEME_CSS = String.raw`
:root {
    --color-app-background: var(--USER-surface-1, #151515);
    --text-shadow-light: none;
    --text-shadow-dark: none;
    --color-icon: var(--USER-text, #eeeeee);
    --color-blue: var(--color-radical);
    --color-blue-dark: var(--color-radical-dark);
    --color-pink: var(--color-kanji);
    --color-pink-dark: var(--color-kanji-dark);
    --color-purple: var(--color-vocabulary);
    --color-purple-dark: var(--color-vocabulary-dark);
    --color-text: var(--USER-text, #eeeeee);
    --color-character-text: var(--USER-text, #eeeeee);
    --color-title-underline: var(--USER-text, #eeeeee);
    --color-link: var(--USER-text-grayed, #bbbbbb);
    --color-link-active: var(--USER-text, #eeeeee);
    --color-link-hover: var(--USER-text, #eeeeee);
    --color-radical: var(--USER-radical, #56638a);
    --color-radical-dark: color-mix(in srgb, var(--color-radical), black 10%);
    --color-radical-highlight: color-mix(
      in srgb,
      var(--color-radical),
      white 10%
    );
    --color-radical-lowlight: color-mix(in srgb, var(--color-radical), black 20%);
    --color-radical-gradient: none;
    --color-kanji: var(--USER-kanji, #9c4644);
    --color-kanji-dark: color-mix(in srgb, var(--color-kanji), black 10%);
    --color-kanji-highlight: color-mix(in srgb, var(--color-kanji), white 10%);
    --color-kanji-lowlight: color-mix(in srgb, var(--color-kanji), black 20%);
    --color-kanji-gradient: none;
    --color-vocabulary: var(--USER-vocab, #58896f);
    --color-vocabulary-dark: color-mix(
      in srgb,
      var(--color-vocabulary),
      black 10%
    );
    --color-vocabulary-highlight: color-mix(
      in srgb,
      var(--color-vocabulary),
      white 10%
    );
    --color-vocabulary-lowlight: color-mix(
      in srgb,
      var(--color-vocabulary),
      black 20%
    );
    --color-vocabulary-gradient: none;
    --color-burned: var(--USER-burned, #303030);
    --color-burned-dark: color-mix(in srgb, var(--color-burned), black 10%);
    --color-burned-highlight: color-mix(in srgb, var(--color-burned), white 10%);
    --color-burned-lowlight: color-mix(in srgb, var(--color-burned), black 20%);
    --color-burned-gradient: none;
    --color-locked: var(--USER-surface-4, #535353);
    --color-locked-dark: color-mix(in srgb, var(--color-locked), black 10%);
    --color-locked-highlight: color-mix(in srgb, var(--color-locked), white 10%);
    --color-locked-lowlight: color-mix(in srgb, var(--color-locked), black 20%);
    --color-locked-gradient: none;
    --color-new-badge-background: var(--USER-progress, #a97e42);
    --color-new-badge-text: var(--USER-text, #eeeeee);
    --color-subject-slide-navigation-background: var(--USER-surface-2, #282828);
    --color-subject-slide-navigation-text: var(--USER-text, #eeeeee);
    --color-subject-slide-navigation-button-hover: var(--USER-surface-3, #303030);
    --color-modal-background: var(--USER-surface-1, #151515);
    --color-lesson-modal-text: var(--USER-text, #eeeeee);
    --color-alert-info-background: var(--USER-alert, #9c4644);
    --color-alert-info-text: var(--USER-text, #eeeeee);
    --color-alert-info-border: var(--USER-alert, #9c4644);
    --color-alert-info-text-shadow: none;
    --color-alert-system-background: var(--USER-alert, #9c4644);
    --color-alert-system-text: var(--USER-text, #eeeeee);
    --color-button-danger-background: var(--USER-alert, #9c4644);
    --color-button-danger-hover-background: var(--USER-alert, #9c4644);
    --color-button-danger-active-background: var(--USER-alert, #9c4644);
    --color-button-danger-border: color-mix(
      in srgb,
      var(--USER-alert, #9c4644),
      var(--USER-surface-2, #282828) 50%
    );
    --color-button-danger-hover-border: var(--color-button-danger-border);
    --color-button-danger-active-border: var(--color-button-danger-border);
    --color-button-danger-text: var(--USER-text, #eeeeee);
    --color-button-danger-hover-text: var(--USER-text, #eeeeee);
    --color-button-danger-active-text: var(--USER-text, #eeeeee);
    --color-button-danger-text-shadow: none;
    --color-button-danger-hover-text-shadow: none;
    --color-button-danger-active-text-shadow: none;
    --color-button-default-border: var(--USER-text, #eeeeee);
    --color-button-default-hover-border: var(--USER-text-grayed, #bbbbbb);
    --color-button-default-text: var(--USER-text, #eeeeee);
    --color-button-default-hover-text: var(--USER-text-grayed, #bbbbbb);
    --color-button-frameless-background: transparent;
    --color-button-frameless-hover-background: transparent;
    --color-button-frameless-active-background: transparent;
    --color-button-frameless-border: transparent;
    --color-button-frameless-hover-border: var(--USER-surface-4, #535353);
    --color-button-frameless-active-border: var(--USER-text, #eeeeee);
    --color-button-frameless-text: var(--USER-text, #eeeeee);
    --color-button-frameless-hover-text: var(--USER-text, #eeeeee);
    --color-button-frameless-active-text: var(--USER-text, #eeeeee);
    --color-button-frameless-text-shadow: none;
    --color-button-frameless-hover-text-shadow: none;
    --color-button-frameless-active-text-shadow: none;
    --color-button-modal-primary-background: var(--USER-text, #eeeeee);
    --color-button-modal-primary-border: var(--USER-text, #eeeeee);
    --color-button-modal-primary-text: var(--USER-surface-1, #151515);
    --color-button-modal-primary-text-shadow: none;
    --color-button-modal-secondary-border: var(--USER-text, #eeeeee);
    --color-button-modal-secondary-text: var(--USER-text, #eeeeee);
    --color-button-quiz-background: var(--USER-surface-3, #303030);
    --color-button-quiz-text: var(--USER-text, #eeeeee);
    --color-button-lesson-picker-background: var(--USER-surface-3, #303030);
    --color-button-lesson-picker-border: var(--USER-surface-3, #303030);
    --color-button-lesson-picker-text: var(--USER-text, #eeeeee);
    --color-button-lesson-picker-box-shadow: none;
    --color-button-lesson-picker-text-shadow: none;
    --color-button-lesson-picker-hover-background: var(--USER-surface-3, #303030);
    --color-button-lesson-picker-hover-border: var(--USER-surface-3, #303030);
    --color-button-lesson-picker-hover-text: var(--USER-text, #eeeeee);
    --color-button-lesson-picker-hover-text-shadow: none;
    --color-button-lesson-picker-active-background: var(--USER-surface-3, #303030);
    --color-button-lesson-picker-active-border: var(--USER-surface-3, #303030);
    --color-button-lesson-picker-active-text: var(--USER-text, #eeeeee);
    --color-button-lesson-picker-active-text-shadow: none;
    --color-button-lesson-picker-disabled-background: var(--USER-text-grayed, #bbbbbb);
    --color-button-lesson-picker-disabled-hover-background: var(--USER-text-grayed, #bbbbbb);
    --color-button-lesson-picker-disabled-border: var(--USER-text-grayed, #bbbbbb);
    --color-button-lesson-picker-disabled-box-shadow: none;
    --color-button-lesson-picker-disabled-text: var(--USER-surface-2, #282828);
    --color-button-lesson-picker-disabled-text-shadow: none;
    --color-button-lesson-picker-count-background: var(--USER-text, #eeeeee);
    --color-button-lesson-picker-count-text: var(--USER-surface-3, #303030);
    --color-button-synonym-background: var(--USER-surface-3, #303030);
    --color-button-synonym-border: transparent;
    --color-button-synonym-text: var(--USER-text, #eeeeee);
    --color-button-synonym-text-shadow: none;
    --color-button-synonym-hover-background: var(--USER-surface-inv, #bababa);
    --color-button-synonym-hover-border: transparent;
    --color-button-synonym-hover-text: var(--USER-text-inv, #151515);
    --color-button-synonym-hover-text-shadow: none;
    --color-button-synonym-active-background: var(--USER-surface-inv, #bababa);
    --color-button-synonym-active-border: transparent;
    --color-button-synonym-active-text: var(--USER-text-inv, #151515);
    --color-button-synonym-active-text-shadow: none;
    --color-code-text: var(--USER-alert, #9c4644);
    --color-code-background: var(--USER-text, #eeeeee);
    --color-code-border: var(--USER-alert, #9c4644);
    --color-input-text: var(--USER-text, #eeeeee);
    --color-input-background: var(--USER-surface-2, #282828);
    --color-input-border: var(--USER-surface-2, #282828);
    --color-input-focus-border: var(--USER-surface-3, #303030);
    --color-lesson-and-review-count-background: var(--USER-lesson, #9c4644);
    --color-lesson-and-review-count-zero-background: var(--USER-surface-3, #303030);
    --color-lesson-and-review-count-text: var(--USER-text, #eeeeee);
    --color-lesson-and-review-count-text-shadow: none;
    --color-reviews-dashboard-background: var(--USER-review, #56638a);
    --color-todays-lessons-background: var(--USER-lesson, #9c4644);
    --color-todays-lessons-completed-background: var(--USER-surface-2, #282828);
    --color-todays-lessons-loading-background: var(--USER-surface-2, #282828);
    --color-todays-lessons-text: var(--USER-text, #eeeeee);
    --color-placeholder-background-stop-1: var(--USER-surface-3, #303030);
    --color-placeholder-background-stop-2: var(--USER-surface-4, #535353);
    --color-level-progress-bar: var(--USER-surface-4, #535353);
    --color-level-progress-bar-background: var(--USER-surface-3, #303030);
    --color-level-progress-bar-text: var(--USER-text, #eeeeee);
    --color-level-progress-bar-progress: var(--USER-progress, #a97e42);
    --color-level-progress-bar-progress-text: var(--USER-text, #eeeeee);
    --color-quiz-input-background: var(--USER-surface-2, #282828);
    --color-quiz-input-focus: var(--USER-surface-3, #303030);
    --color-quiz-incorrect-background: var(--USER-incorrect, #9c4644);
    --color-quiz-incorrect-text-color: var(--USER-text, #eeeeee);
    --color-quiz-incorrect-text-shadow: none;
    --color-quiz-correct-background: var(--USER-correct, #58896f);
    --color-quiz-correct-text-color: var(--USER-text, #eeeeee);
    --color-quiz-correct-text-shadow: none;
    --color-quiz-srs-correct-background: var(--USER-correct, #58896f);
    --color-quiz-srs-correct-text-color: var(--USER-text, #eeeeee);
    --color-quiz-srs-correct-text-shadow: none;
    --color-quiz-srs-incorrect-background: var(--USER-incorrect, #9c4644);
    --color-quiz-srs-incorrect-text-color: var(--USER-text, #eeeeee);
    --color-quiz-srs-incorrect-text-shadow: none;
    --color-srs-progress-text: var(--USER-text, #eeeeee);
    --color-srs-progress-header-divider: var(--USER-text, #eeeeee);
    --color-srs-progress-apprentice: var(--USER-apprentice, #47454e);
    --color-srs-progress-burned: var(--USER-burned, #303030);
    --color-srs-progress-enlightened: var(--USER-enlightened, #934c3f);
    --color-srs-progress-guru: var(--USER-guru, #605c74);
    --color-srs-progress-master: var(--USER-master, #9a815d);
    --color-srs-progress-subject-type-background: rgba(0, 0, 0, 0.1);
    --color-subject-srs-progress-stage-background: var(--USER-surface-4, #535353);
    --color-subject-srs-progress-stage-complete-background: var(--USER-progress, #a97e42);
    --color-wk-panel-background: var(--USER-surface-2, #282828);
    --color-wk-panel-content-background: var(--USER-surface-3, #303030);
    --color-wk-panel-content-title-underline: var(--USER-text, #eeeeee);
    --color-recent-mistakes-intro-divider: var(--USER-text, #eeeeee);
    --color-review-forecast-divider: var(--USER-text, #eeeeee);
    --color-review-forecast-increase-sign: var(--USER-text, #eeeeee);
    --color-review-forecast-bar: var(--USER-brand, #9c4644);
    --color-billing-plan-background: var(--USER-surface-3, #303030);
    --color-billing-plan-border: var(--USER-text-hl, #c29354);
    --color-billing-plan-title-background: var(--USER-text-hl, #c29354);
    --color-billing-plan-title-text: var(--USER-surface-3, #303030);
    --color-billing-receipt-background-hover: var(--USER-surface-3, #303030);
    --color-billing-activation-error: var(--USER-alert, #9c4644);
    --color-lesson-picker-footer-background: var(--USER-surface-2, #282828);
    --color-lesson-picker-footer-border: 1px solid var(--USER-surface-3, #303030);
    --color-lesson-picker-footer-shadow-color: transparent;
    --color-lesson-picker-footer-shadow: none;
    --color-subject-list-separator: var(--USER-text, #eeeeee);
    --color-character-grid-header-background: var(--USER-surface-3, #303030);
    --color-character-grid-header-text: var(--USER-text, #eeeeee);
    --color-count_bubble-background: var(--USER-text, #eeeeee);
    --color-authentication-footer-divider: var(--USER-text, #eeeeee);
    --color-text-highlight-default-text: var(--USER-text, #eeeeee);
    --color-text-highlight-radical-background: var(--USER-radical, #56638a);
    --color-text-highlight-kanji-background: var(--USER-kanji, #9c4644);
    --color-text-highlight-vocabulary-background: var(--USER-vocab, #58896f);
    --color-text-highlight-meaning-background: var(--USER-text-inv, #151515);
    --color-text-highlight-reading-background: var(--USER-text-inv, #151515);
    --color-text-highlight-radical-gradient: none;
    --color-text-highlight-kanji-gradient: none;
    --color-text-highlight-vocabulary-gradient: none;
    --color-text-highlight-meaning-gradient: none;
    --color-text-highlight-reading-gradient: none;
    --text-highlight-text-shadow: none;
    --text-highlight-box-shadow: none;
    --color-nav-header-text: var(--USER-text, #eeeeee);
    --color-nav-header-text-shadow: none;
    --color-nav-item-background: var(--USER-surface-3, #303030);
    --color-nav-item-text: var(--USER-text, #eeeeee);
    --color-nav-item-text-shadow: none;
    --color-nav-item-highlight-background: var(--USER-surface-4, #535353);
    --color-nav-item-highlight-text: var(--USER-text, #eeeeee);
    --color-nav-item-highlight-text-shadow: none;
    --color-setting-divider: var(--USER-text, #eeeeee);
    --color-progress-chart-bar-background: var(--USER-surface-4, #535353);
    --color-progress-chart-bar: var(--USER-progress, #a97e42);
    --color-progress-chart-bar-gradient: none;
    --color-progress-chart-label-text: var(--USER-text, #eeeeee);
    --color-progress-chart-label-text-shadow: none;
    --color-progress-chart-metric-text: var(--USER-text, #eeeeee);
    --color-progress-chart-metric-count: var(--USER-text-inv, #151515);
    --color-progress-chart-metric-count-background: var(--USER-surface-inv, #bababa);
    --color-progress-chart-metric-count-shadow: none;
    --color-public-profile-avatar-border: var(--USER-surface-2, #282828);
    --color-public-profile-info-background: var(--USER-surface-2, #282828);
    --color-public-profile-info-text: var(--USER-text, #eeeeee);
    --color-public-profile-info-text-emphasis: var(--USER-text-hl, #c29354);
    --color-dashboard-list-empty-icon: var(--USER-text, #eeeeee);
    --color-community-banner-background: var(--USER-surface-2, #282828);
    --color-community-banner-border: transparent;
    --color-community-banner-text: var(--USER-text, #eeeeee);
    --color-widget-background: var(--USER-surface-2, #282828);
    --color-widget-border: var(--USER-surface-4, #535353);
    --color-widget-primary-text: var(--USER-text, #eeeeee);
    --color-widget-secondary-text: var(--USER-text, #eeeeee);
    --color-review-forecast-header-background: var(--USER-brand, #9c4644);
    --color-review-forecast-day-hover: var(--USER-surface-3, #303030);
    --color-review-forecast-day-active: var(--USER-surface-3, #303030);
    --color-review-forecast-bar-positive: var(--USER-progress, #a97e42);
    --color-review-forecast-bar-positive-border: var(--USER-progress, #a97e42);
    --color-review-forecast-increase-positive: var(--USER-progress, #a97e42);
    --color-review-forecast-bar-zero-border: var(--USER-surface-inv, #bababa);
    --color-review-forecast-bar-zero: var(--USER-surface-inv, #bababa);
    --color-extra-study-button-background: var(--USER-surface-2, #282828);
    --color-extra-study-button-text: var(--USER-text, #eeeeee);
    --color-extra-study-button-border: var(--USER-text, #eeeeee);
    --color-extra-study-button-icon: var(--USER-text, #eeeeee);
    --color-extra-study-button-remaining-text: var(--USER-text-grayed, #bbbbbb);
    --color-count-bubble-background: var(--USER-text, #eeeeee);
    --color-count-bubble-border: var(--USER-text, #eeeeee);
    --color-count-bubble-text: var(--USER-surface-2, #282828);
    --color-extra-study-button-hover-background: var(--USER-surface-2, #282828);
    --color-extra-study-button-disabled-background: var(--USER-surface-2, #282828);
    --color-review-forecast-increase-zero: var(--USER-text-grayed, #bbbbbb);
    --color-extra-study-button-active-background: var(--USER-surface-2, #282828);
    --color-level-progress-indicator-background: var(--USER-surface-4, #535353);
    --color-level-progress-item-stat-border: var(--USER-surface-4, #535353);
    --color-level-progress-item-stat-hover-background: var(--USER-surface-2, #282828);
    --color-level-progress-item-stat-active-background: var(--USER-surface-2, #282828);
    --color-level-progress-subjects-background: var(--USER-surface-2, #282828);
    --color-level-progress-subjects-border: var(--USER-surface-4, #535353);
    --color-notification-info-background: var(--USER-alert, #9c4644);
    --color-notification-info-border: var(--USER-alert, #9c4644);
    --color-notification-info-icon: var(--USER-alert, #9c4644);
    --color-item-spread-row-background: var(--USER-surface-2, #282828);
    --color-grouped-navigation-link-current-border: var(--USER-text, #eeeeee);
    --color-item-spread-row-border: transparent;
    --color-extra-study-flashcard-placeholder-pulse-stop-1: color-mix(
      in srgb,
      var(--USER-surface-2, #282828),
      black 10%
    );
    --color-extra-study-flashcard-placeholder-pulse-stop-2: color-mix(
      in srgb,
      var(--USER-surface-2, #282828),
      white 10%
    );
    --color-extra-study-flashcard-loading-background: var(--USER-surface-2, #282828);
    --color-placeholder-pulse-default-stop-1: color-mix(
      in srgb,
      var(--USER-surface-2, #282828),
      black 10%
    );
    --color-placeholder-pulse-default-stop-2: color-mix(
      in srgb,
      var(--USER-surface-2, #282828),
      white 10%
    );
    --color-button-primary-background: transparent;
    --color-button-secondary-background: transparent;
    --color-button-primary-border: var(--USER-text, #eeeeee);
    --color-button-secondary-border: var(--USER-text, #eeeeee);
    --color-button-primary-text: var(--USER-text, #eeeeee);
    --color-button-secondary-text: var(--USER-text, #eeeeee);
    --color-button-primary-edge: transparent;
    --color-button-secondary-edge: transparent;
    --color-button-primary-hover-edge: transparent;
    --color-button-secondary-hover-edge: transparent;
    --color-button-primary-active-edge: transparent;
    --color-button-secondary-active-edge: transparent;
    --color-button-primary-active-background: transparent;
    --color-button-secondary-active-background: transparent;
    --color-level-progress-completed-bar: var(--USER-progress, #a97e42);
    --color-extra-study-single-button-empty-background: var(--USER-surface-3, #303030);
    --color-subject-srs-progress-text: var(--USER-text-grayed, #bbbbbb);
    --color-notification-success-background: var(--USER-correct, #58896f);
    --color-notification-success-border: color-mix(
      in srgb,
      var(--USER-correct, #58896f),
      white 25%
    );
    --color-grouped-navigation-link-text: var(--USER-text, #eeeeee);
    --color-grouped-navigation-background: var(--USER-surface-3, #303030);
    --color-grouped-navigation-link-background: var(--USER-surface-4, #535353);
    --color-grouped-navigation-link-hover-background: var(--USER-surface-inv, #bababa);
    --color-grouped-navigation-link-hover-text: var(--USER-surface-4, #535353);
    --color-grouped-navigation-link-active-background: var(--USER-surface-4, #535353);
    --color-grouped-navigation-link-active-border: var(--USER-text, #eeeeee);
    --color-page-header-title: var(--USER-text, #eeeeee);
    --color-page-header-description: var(--USER-text, #eeeeee);
    --color-dashboard-customization-row-background: var(--USER-surface-2, #282828);
    --color-dashboard-customization-widget-container-background: var(--USER-surface-3, #303030);
    --color-empty-widget-background: var(--USER-surface-3, #303030);
    --color-dashboard-customization-menu-border: var(--USER-surface-4, #535353);
    --color-dashboard-customization-menu-background: var(--USER-surface-3, #303030);
    --color-dashboard-customization-menu-text: var(--USER-text, #eeeeee);
    --color-dashboard-customization-template-background: var(--USER-surface-2, #282828);
    --color-dashboard-customization-template-border: var(--USER-surface-4, #535353);
    --color-dashboard-customization-template-illustration-background: var(--USER-surface-3, #303030);
    --color-dashboard-customization-template-illustration-border: var(--USER-surface-4, #535353);
    --color-dashboard-customization-template-illustration-bar-background: var(--USER-surface-4, #535353);
    --color-dashboard-customization-template-illustration-bar-border: var(--USER-surface-inv, #bababa);
    --color-dashboard-customization-template-selected-border: var(--USER-text, #eeeeee);
    --color-dashboard-customization-template-selected-background: var(--USER-surface-2, #282828);
    --color-dashboard-customization-template-illustration-selected-border: var(--USER-surface-4, #535353);
    --color-dashboard-customization-template-illustration-selected-background: var(--USER-surface-3, #303030);
    --color-dashboard-customization-template-illustration-bar-selected-border: var(--USER-surface-inv, #bababa);
    --color-dashboard-customization-template-illustration-bar-selected-background: var(--USER-surface-4, #535353);
    --color-dashboard-customization-template-radio-selected: var(--USER-text, #eeeeee);
    --color-dashboard-customization-template-hover-background: var(--USER-surface-1, #151515);
    --color-dashboard-customization-template-disabled-background: var(--USER-surface-1, #151515);
    --color-widget-gallery-background: var(--USER-surface-2, #282828);
    --color-widget-gallery-widget-background: var(--USER-surface-3, #303030);
    --color-widget-gallery-divider: var(--USER-text, #eeeeee);
    --color-widget-gallery-navigation-background: var(--USER-surface-3, #303030);
    --color-chip-hover-background: var(--USER-surface-inv, #bababa);
    --color-chip-active-background: var(--USER-text, #eeeeee);
    --color-chip-background: var(--USER-surface-3, #303030);
    --color-chip-hover-border: var(--USER-surface-4, #535353);
    --color-chip-active-border: var(--USER-text, #eeeeee);
    --color-chip-border: var(--USER-surface-4, #535353);
    --color-chip-hover-text: var(--USER-surface-3, #303030);
    --color-chip-active-text: var(--USER-surface-3, #303030);
    --color-chip-text: var(--USER-text, #eeeeee);
    --color-dashboard-customization-menu-divider: var(--USER-surface-4, #535353);
    --color-item-spread-row-hover-background: var(--USER-surface-3, #303030);
    --color-item-spread-row-active-background: var(--USER-surface-3, #303030);
    --color-focus: var(--USER-text, #eeeeee);
    --color-item-spread-graph-axis-label: var(--USER-text, #eeeeee);
    --color-item-spread-graph-grid-line: var(--USER-text-grayed, #bbbbbb);
    --color-extra-study-split-subjects-background: var(--USER-surface-3, #303030);
    --color-extra-study-split-subjects-border: var(--USER-surface-4, #535353);
    --color-extra-study-flashcard-subject: var(--USER-text, #eeeeee);
    --color-extra-study-flashcard-seperator: var(--USER-text, #eeeeee);
    --color-widget-gallery-description: var(--USER-text, #eeeeee);
    --color-days-studied-content-border: var(--USER-brand, #9c4644);
    --color-days-studied-content-background: var(--USER-surface-3, #303030);
    --color-days-studied-digit-border: var(--USER-surface-4, #535353);
    --color-days-studied-digit-background: var(--USER-surface-2, #282828);
    --color-days-studied-digit: var(--USER-text, #eeeeee);
    --color-days-studied-date: var(--USER-text, #eeeeee);
    --color-days-studied-digit-filled-border: color-mix(
      in srgb,
      var(--USER-brand, #9c4644),
      white 25%
    );
    --color-days-studied-digit-filled-background: var(--USER-brand, #9c4644);
    --color-days-studied-digit-filled: var(--USER-text, #eeeeee);
    --color-days-studied-date-label: var(--USER-text, #eeeeee);
    --color-widget-divider: var(--USER-surface-4, #535353);
    --color-heat-map-cell-level-0: var(--USER-surface-3, #303030);
    --color-heat-map-cell-level-4: color-mix(in srgb, var(--USER-brand, #9c4644), red 20%);
    --color-heat-map-cell-level-3: color-mix(
      in srgb,
      color-mix(in srgb, var(--USER-brand, #9c4644), white 20%),
      red 20%
    );
    --color-heat-map-cell-level-2: color-mix(
      in srgb,
      color-mix(in srgb, var(--USER-brand, #9c4644), white 40%),
      red 20%
    );
    --color-heat-map-cell-level-1: color-mix(
      in srgb,
      color-mix(in srgb, var(--USER-brand, #9c4644), white 60%),
      red 20%
    );
    --color-grouped-navigation-header-text: var(--USER-text, #eeeeee);
    --color-study-streak-today-incomplete-background: var(--USER-surface-3, #303030);
    --color-study-streak-today-complete-background: var(--USER-surface-3, #303030);
    --color-study-streak-today-complete-text: var(--USER-text, #eeeeee);
    --color-item-spread-row-count: var(--USER-text, #eeeeee);
    --color-lesson-and-review-border: var(--USER-surface-3, #303030);
    --color-text-highlight-radical-text: var(--USER-text, #eeeeee);
    --color-text-highlight-kanji-text: var(--USER-text, #eeeeee);
    --color-text-highlight-vocabulary-text: var(--USER-text, #eeeeee);
    --color-heat-map-cell-selected-border: var(--USER-surface-inv, #bababa);
    --color-subject-character-secondary-info: var(--USER-text-grayed, #bbbbbb);
    --color-subject-character-grid-item-background: var(--USER-surface-3, #303030);
    --color-subject-character-grid-item-border: var(--USER-surface-4, #535353);
    --color-subject-character-grid-header-background: var(--USER-surface-3, #303030);
    --color-subject-character-grid-header-subtitle: var(--USER-text-grayed, #bbbbbb);
    --color-subject-character-grid-header-title: var(--USER-text, #eeeeee);
    --color-subject-legend-title: var(--USER-text-grayed, #bbbbbb);
    --color-section-subtitle: var(--USER-text, #eeeeee);
    --color-button-quiz-edge: transparent;
    --color-button-quiz-border: transparent;
    --color-button-quiz-hover-edge: transparent;
    --color-button-quiz-active-edge: transparent;
    --color-button-quiz-active-background: var(--USER-surface-2, #282828);
    --color-button-quiz-hover-background: var(--USER-surface-2, #282828);
    --color-count-bubble-divider: var(--USER-text-inv, #151515);
    --color-review-forecast-priority-count: var(--USER-text, #eeeeee);
    --color-review-forecast-priority-count-inside: var(--USER-text, #eeeeee);
    --color-subject-page-header-border: var(--USER-surface-4, #535353);
    --color-section-header-border: var(--USER-surface-4, #535353);
    --color-item-spread-total-border: var(--USER-surface-4, #535353);
    --color-item-spread-total-background: var(--USER-surface-3, #303030);
  }
  
  #turbo-body,
  .site-content-container,
  .site-footer-container,
  .lesson-container {
    background-color: var(--USER-surface-1, #151515);
    background-image: none;
  }
  
  .global-header {
    background: var(--USER-surface-2, #282828);
    border-bottom-color: var(--USER-surface-4, #535353);
  }
  .global-header .logo {
    filter: var(--USER-logo-filter, invert(1) saturate(0) brightness(1.6));
  }
  .global-header .sitemap__section-header {
    text-shadow: none;
    color: var(--USER-text, #eeeeee);
  }
  .global-header .lesson-and-review-count :first-child * {
    --color-lesson-and-review-count-background: var(--USER-lesson, #9c4644);
    --color-lesson-and-review-border-hover: var(--USER-lesson, #9c4644);
  }
  .global-header .lesson-and-review-count :nth-child(2) * {
    --color-lesson-and-review-count-background: var(--USER-review, #56638a);
    --color-lesson-and-review-border-hover: var(--USER-review, #56638a);
  }
  .global-header .sitemap__expandable-chunk--levels::before {
    background-color: var(--USER-text, #eeeeee);
  }
  .global-header .sitemap__expandable-chunk--levels {
    background-color: var(--USER-surface-3, #303030);
  }
  .global-header .sitemap__expandable-chunk--levels .sitemap__group-header {
    color: var(--USER-text-grayed, #bbbbbb);
  }
  .global-header .sitemap__expandable-chunk--levels .sitemap__pages--levels .sitemap__page a {
    color: var(--USER-text, #eeeeee);
    background-color: var(--USER-surface-3, #303030);
    border: 1px solid var(--USER-surface-4, #535353);
  }
  .global-header .sitemap__expandable-chunk--levels .sitemap__pages--levels .sitemap__page a:hover {
    color: var(--USER-surface-3, #303030);
    background-color: var(--USER-surface-inv, #bababa);
  }
  .global-header .sitemap__expandable-chunk--levels .sitemap__pages--levels .sitemap__page--current-level a {
    border: 1px solid var(--USER-text, #eeeeee);
  }
  .global-header .sitemap__expandable-chunk--radicals,
  .global-header .sitemap__expandable-chunk--kanji,
  .global-header .sitemap__expandable-chunk--vocabulary,
  .global-header .sitemap__expandable-chunk {
    background-color: var(--USER-surface-3, #303030);
    color: var(--USER-text, #eeeeee);
    border: 1px solid color-mix(in srgb, var(--USER-surface-3, #303030), white 10%);
  }
  .global-header .sitemap__page--subject a,
  .global-header .sitemap__page-subtitle {
    color: var(--USER-text, #eeeeee);
  }
  .global-header .sitemap__page a {
    color: var(--USER-text, #eeeeee);
  }
  .global-header #sitemap__account .sitemap__page a:hover,
  .global-header #sitemap__account .sitemap__page a:focus,
  .global-header #sitemap__help .sitemap__page--subject a:hover,
  .global-header #sitemap__help .sitemap__page--subject a:focus {
    background-color: var(--USER-text, #eeeeee);
    color: var(--USER-surface-3, #303030);
  }
  .global-header .sitemap__section-header:hover,
  .global-header .sitemap__section-header:focus,
  .global-header .search-button:hover,
  .global-header .search-button:focus {
    border-color: var(--USER-text, #eeeeee);
  }
  .global-header .sitemap__section-header--subsection {
    color: var(--USER-text-grayed, #bbbbbb);
  }
  .global-header .sitemap__expandable-chunk:before {
    background-color: var(--USER-text, #eeeeee);
  }
  .global-header .sitemap__section--open .sitemap__section-header--radicals,
  .global-header .sitemap__section-header--radicals:hover,
  .global-header .sitemap__section-header--radicals:focus {
    border-color: var(--USER-radical, #56638a);
  }
  .global-header .sitemap__expandable-chunk--radicals:before {
    background-color: var(--USER-radical, #56638a);
  }
  .global-header .sitemap__pages--radical .sitemap__page--subject {
    border-color: var(--USER-radical, #56638a);
  }
  .global-header .sitemap__pages--radical .sitemap__page--subject a:hover {
    background-color: var(--USER-radical, #56638a);
  }
  .global-header .sitemap__section--open .sitemap__section-header--kanji,
  .global-header .sitemap__section-header--kanji:hover,
  .global-header .sitemap__section-header--kanji:focus {
    border-color: var(--USER-kanji, #9c4644);
  }
  .global-header .sitemap__expandable-chunk--kanji:before {
    background-color: var(--USER-kanji, #9c4644);
  }
  .global-header .sitemap__pages--kanji .sitemap__page--subject {
    border-color: var(--USER-kanji, #9c4644);
  }
  .global-header .sitemap__pages--kanji .sitemap__page--subject a:hover {
    background-color: var(--USER-kanji, #9c4644);
  }
  .global-header .sitemap__section--open .sitemap__section-header--vocabulary,
  .global-header .sitemap__section-header--vocabulary:hover,
  .global-header .sitemap__section-header--vocabulary:focus {
    border-color: var(--USER-vocab, #58896f);
  }
  .global-header .sitemap__expandable-chunk--vocabulary:before {
    background-color: var(--USER-vocab, #58896f);
  }
  .global-header .sitemap__pages--vocabulary .sitemap__page--subject {
    border-color: var(--USER-vocab, #58896f);
  }
  .global-header .sitemap__pages--vocabulary .sitemap__page--subject a:hover {
    background-color: var(--USER-vocab, #58896f);
  }
  .global-header .navigation__toggle .navigation__toggle-icon,
  .global-header .navigation__toggle .navigation__toggle-icon::before,
  .global-header .navigation__toggle .navigation__toggle-icon::after {
    background: var(--USER-text, #eeeeee);
    border-color: var(--USER-text, #eeeeee);
  }
  .global-header .navigation--open .navigation__toggle {
    background-color: var(--USER-surface-3, #303030);
  }
  .global-header .navigation--open .navigation__toggle .navigation__toggle-icon {
    background: transparent;
    border-color: transparent;
  }
  .global-header .navigation--open .navigation__toggle .navigation__toggle-icon::before,
  .global-header .navigation--open .navigation__toggle .navigation__toggle-icon::after {
    background: var(--USER-text, #eeeeee);
    border-color: var(--USER-text, #eeeeee);
  }
  .global-header .navigation--open .sitemap {
    box-shadow: none;
    background-color: var(--USER-surface-2, #282828);
  }
  .global-header .navigation--open .sitemap .sitemap__section-header::before {
    border-color: var(--USER-text, #eeeeee);
  }
  .global-header .navigation--open .sitemap .sitemap--divider {
    border-color: var(--USER-text, #eeeeee);
  }
  .global-header .sitemap {
    box-shadow: none;
    background-color: var(--USER-surface-2, #282828);
  }
  
  .search--open .search__query {
    background-color: var(--USER-surface-3, #303030);
    color: var(--USER-text, #eeeeee);
    border-color: var(--USER-text, #eeeeee);
  }
  .search--open .search__query::placeholder {
    color: var(--USER-text-grayed, #bbbbbb);
  }
  .search--open .search__button {
    color: var(--USER-surface-1, #151515);
    background: transparent;
  }
  .search--open .search__button:hover,
  .search--open .search__button:focus {
    background: transparent;
  }
  
  .wk-button--primary:hover .wk-button__content,
  .wk-button--primary:focus .wk-button__content,
  .wk-button--secondary:hover .wk-button__content,
  .wk-button--secondary:focus .wk-button__content {
    transform: translateY(-4px);
    outline: 1px solid var(--USER-text, #eeeeee);
  }
  
  .wk-button--primary:active .wk-button__content,
  .wk-button--secondary:active .wk-button__content {
    transform: translateY(-4px);
    outline: 2px solid var(--USER-text, #eeeeee);
  }
  
  .wk-button--primary:hover .wk-button__shadow,
  .wk-button--primary:focus .wk-button__shadow,
  .wk-button--primary:active .wk-button__shadow,
  .wk-button--secondary:hover .wk-button__shadow,
  .wk-button--secondary:focus .wk-button__shadow,
  .wk-button--secondary:active .wk-button__shadow {
    background: transparent;
  }
  
  turbo-frame[data-show-loading=true]:not([complete]):after {
    filter: var(--USER-loading-filter, grayscale(100%) invert(1) hue-rotate(180deg) contrast(0.68));
  }
  
  .footer__item--copyright {
    filter: invert(1);
    background-color: var(--USER-kanji, #9c4644);
  }
  
  .subject-character--radical .subject-character__characters-text {
    --color-text: var(--USER-text, #eeeeee);
  }
  
  .subject-legend-character--review,
  .subject-character--passed .subject-character__characters-text,
  .subject-character--unlocked .subject-character__characters-text {
    color: var(--USER-text, #eeeeee);
  }
  
  .subject-legend-character--radical:not(.subject-legend-character--locked),
  .level-progress-widget__item-type-stat-indicator-bar--radical,
  .subject-character--radical:not(.subject-character--locked) .subject-character__characters-text {
    background: var(--USER-radical, #56638a);
  }
  
  .subject-legend-character--radical,
  .subject-character--radical:not(.subject-character--locked) .subject-character__characters-text {
    border-color: color-mix(in srgb, var(--USER-radical, #56638a), white 25%);
  }
  
  .subject-legend-character--kanji:not(.subject-legend-character--locked),
  .level-progress-widget__item-type-stat-indicator-bar--kanji,
  .subject-character--kanji:not(.subject-character--locked) .subject-character__characters-text {
    background: var(--USER-kanji, #9c4644);
  }
  
  .subject-legend-character--kanji,
  .subject-character--kanji:not(.subject-character--locked) .subject-character__characters-text {
    border-color: color-mix(in srgb, var(--USER-kanji, #9c4644), white 25%);
  }
  
  .subject-legend-character--vocabulary:not(.subject-legend-character--locked),
  .level-progress-widget__item-type-stat-indicator-bar--vocabulary,
  .subject-character--vocabulary:not(.subject-character--locked) .subject-character__characters-text {
    background: var(--USER-vocab, #58896f);
  }
  
  .subject-legend-character--vocabulary,
  .subject-character--vocabulary:not(.subject-character--locked) .subject-character__characters-text {
    border-color: color-mix(in srgb, var(--USER-vocab, #58896f), white 25%);
  }
  
  .subject-character--locked.subject-character--radical .subject-character__characters-text {
    color: var(--USER-text-grayed, #bbbbbb);
    --color-blue: var(--USER-radical, #56638a);
  }
  
  .subject-character--locked.subject-character--kanji .subject-character__characters-text {
    color: var(--USER-text-grayed, #bbbbbb);
    --color-pink: var(--USER-kanji, #9c4644);
  }
  
  .subject-character--locked.subject-character--vocabulary .subject-character__characters-text {
    color: var(--USER-text-grayed, #bbbbbb);
    --color-purple: var(--USER-vocab, #58896f);
  }
  
  .wk-hint {
    --color-icon: var(--USER-text, #eeeeee);
    color: var(--USER-text, #eeeeee);
    background: var(--USER-surface-3, #303030);
    text-shadow: none;
    border-radius: 0;
    border-left: 5px solid var(--USER-text, #eeeeee);
  }
  .wk-hint .wk-hint__title {
    text-shadow: none;
    color: var(--USER-text, #eeeeee);
  }
  
  /*  Invert highlight fg, bg
   *    WaniKani uses same --color for text of all highlights
   *    This stylesheets require inverted text color for meaning/reading hl
   */
  .highlight-reading,
  .highlight-reading > span,
  .reading-highlight,
  .reading-highlight > span,
  .bg-\[\#f1d6ff\],
  .bg-\[\#f8d8ef\],
  .bg-\[\#d6f1ff\] {
    background-color: var(--USER-surface-inv, #bababa);
    color: var(--USER-surface-2, #282828);
    font-weight: bold;
  }
  
  :root {
    --ED-surface-1: var(--USER-surface-1, #151515);
    --ED-surface-2: var(--USER-surface-2, #282828);
    --ED-surface-3: var(--USER-surface-3, #303030);
    --ED-surface-4: var(--USER-surface-4, #535353);
    --ED-surface-inv: var(--USER-surface-inv, #bababa);
    --ED-text: var(--USER-text, #eeeeee);
    --ED-text-inv: var(--USER-text-inv, #151515);
    --ED-text-hl: var(--USER-text-hl, #c29354);
    --ED-text-grayed: var(--USER-text-grayed, #bbbbbb);
    --ED-radical: var(--USER-radical, #56638a);
    --ED-kanji: var(--USER-kanji, #9c4644);
    --ED-vocab: var(--USER-vocab, #58896f);
    --ED-apprentice: var(--USER-apprentice, #47454e);
    --ED-guru: var(--USER-guru, #605c74);
    --ED-master: var(--USER-master, #9a815d);
    --ED-enlightened: var(--USER-enlightened, #934c3f);
    --ED-burned: var(--USER-burned, #303030);
    --ED-lesson: var(--USER-lesson, #9c4644);
    --ED-review: var(--USER-review, #56638a);
    --ED-correct: var(--USER-correct, #58896f);
    --ED-incorrect: var(--USER-incorrect, #9c4644);
    --ED-brand: var(--USER-brand, #9c4644);
    --ED-progress: var(--USER-progress, #a97e42);
    --ED-alert: var(--USER-alert, #9c4644);
    --ED-logo-filter: var(--USER-logo-filter, invert(1) saturate(0) brightness(1.6));
    --ED-kotoba-odd-row-filter: var(--USER-kotoba-odd-row-filter, brightness(0.95));
    --ED-footer-filter: var(--USER-footer-filter, invert(1));
    --ED-loading-filter: var(--USER-loading-filter, grayscale(100%) invert(1) hue-rotate(180deg) contrast(0.68));
    --ED-days-studied-filter: var(--USER-days-studied-filter, invert(0.85));
  }
  
  .todays-lessons-widget--complete {
    --color-count-bubble-background: var(--USER-text, #eeeeee);
    --color-count-bubble-text: var(--USER-text-inv, #151515);
    --color-widget-background: var(--USER-surface-2, #282828);
  }
  
  .todays-lessons-widget.theme--neon:not(.todays-lessons-widget--complete) {
    --color-placeholder-pulse-stop-1: color-mix(in srgb, var(--USER-lesson, #9c4644), black 10%);
    --color-placeholder-pulse-stop-2: color-mix(in srgb, var(--USER-lesson, #9c4644), white 10%);
    --color-count-bubble-background: var(--USER-text, #eeeeee);
    --color-count-bubble-border: var(--USER-text, #eeeeee);
    --color-count-bubble-text: var(--USER-lesson, #9c4644);
    --color-button-edge: transparent;
    --color-button-hover-edge: transparent;
    --color-button-active-edge: transparent;
    --color-button-border: var(--USER-text, #eeeeee);
    --color-button-hover-border: var(--USER-text, #eeeeee);
    --color-button-active-border: var(--USER-text, #eeeeee);
    --color-widget-background: var(--USER-lesson, #9c4644);
    --color-widget-border: color-mix(in srgb, var(--USER-lesson, #9c4644), white 25%);
    --color-widget-primary-text: var(--USER-text, #eeeeee);
    --color-widget-secondary-text: var(--USER-text, #eeeeee);
    --color-button-secondary-active-background: var(--USER-lesson, #9c4644);
  }
  
  .reviews-widget .count-bubble__priority-count {
    --color-icon: var(--USER-text-inv, #151515);
  }
  
  .reviews-widget--complete {
    --color-count-bubble-background: var(--USER-text, #eeeeee);
    --color-count-bubble-text: var(--USER-text-inv, #151515);
    --color-widget-background: var(--USER-surface-2, #282828);
  }
  
  .reviews-widget.theme--neon:not(.reviews-widget--complete.theme--neon) {
    --color-placeholder-pulse-stop-1: color-mix(in srgb, var(--USER-review, #56638a), black 10%);
    --color-placeholder-pulse-stop-2: color-mix(in srgb, var(--USER-review, #56638a), white 10%);
    --color-count-bubble-background: var(--USER-text, #eeeeee);
    --color-count-bubble-border: var(--USER-text, #eeeeee);
    --color-count-bubble-text: var(--USER-review, #56638a);
    --color-button-edge: transparent;
    --color-button-hover-edge: transparent;
    --color-button-active-edge: transparent;
    --color-button-border: var(--USER-text, #eeeeee);
    --color-button-hover-border: var(--USER-text, #eeeeee);
    --color-button-active-border: var(--USER-text, #eeeeee);
    --color-widget-background: var(--USER-review, #56638a);
    --color-widget-border: color-mix(in srgb, var(--USER-review, #56638a), white 25%);
    --color-widget-primary-text: var(--USER-text, #eeeeee);
    --color-widget-secondary-text: var(--USER-text, #eeeeee);
    --color-button-secondary-active-background: var(--USER-review, #56638a);
    --color-count-bubble-divider: var(--USER-review, #56638a);
  }
  .reviews-widget.theme--neon:not(.reviews-widget--complete.theme--neon) .wk-icon {
    --color-icon: var(--USER-text, #eeeeee);
  }
  .reviews-widget.theme--neon:not(.reviews-widget--complete.theme--neon) .count-bubble__priority-count-icon .wk-icon {
    --color-icon: var(--USER-review, #56638a);
  }
  
  .review-forecast-widget:not(.review-forecast-widget--loading) .review-forecast-widget__header {
    --color-review-forecast-header-background: var(--USER-brand, #9c4644);
  }
  
  .extra-study-multi-button-widget__button:hover, .extra-study-multi-button-widget__button:focus {
    outline: 1px solid var(--USER-text, #eeeeee);
  }
  .extra-study-multi-button-widget__button:active {
    outline: 1px solid var(--USER-text, #eeeeee);
  }
  .extra-study-multi-button-widget__button .wk-icon--turtle {
    --color-icon-tertiary: var(--USER-surface-2, #282828);
    --color-icon-secondary: var(--USER-surface-2, #282828);
  }
  
  .extra-study-multi-button-widget__button--disabled,
  .extra-study-multi-button-widget__button--disabled:hover,
  .extra-study-multi-button-widget__button--disabled:focus {
    outline: none;
    border-color: var(--USER-surface-3, #303030);
  }
  
  .item-spread-table-row__count--radical {
    background: var(--USER-radical, #56638a);
    border-color: color-mix(in srgb, var(--USER-radical, #56638a), white 25%);
    --color-item-spread-loading-count-background: var(--USER-radical, #56638a);
    --color-item-spread-loading-count-border: var(--USER-radical, #56638a);
  }
  
  .item-spread-table-row__count--kanji {
    background: var(--USER-kanji, #9c4644);
    border-color: color-mix(in srgb, var(--USER-kanji, #9c4644), white 25%);
    --color-item-spread-loading-count-background: var(--USER-kanji, #9c4644);
    --color-item-spread-loading-count-border: var(--USER-kanji, #9c4644);
  }
  
  .item-spread-table-row__count--vocabulary {
    background: var(--USER-vocab, #58896f);
    border-color: color-mix(in srgb, var(--USER-vocab, #58896f), white 25%);
    --color-item-spread-loading-count-background: var(--USER-vocab, #58896f);
    --color-item-spread-loading-count-border: var(--USER-vocab, #58896f);
  }
  
  .item-spread-table-row__total {
    color: var(--USER-text-inv, #151515);
    background: var(--USER-surface-inv, #bababa);
    border-color: color-mix(in srgb, var(--USER-surface-inv, #bababa), white 25%);
  }
  
  .item-spread-table-row__counts {
    gap: 0;
  }
  
  .item-spread-table-row__count.item-spread-table-row__count--radical {
    border-radius: 9999px 0 0 9999px;
  }
  
  .item-spread-table-row__count.item-spread-table-row__count--kanji {
    border-radius: 0;
  }
  
  .item-spread-table-row__count.item-spread-table-row__count--vocabulary {
    border-radius: 0 9999px 9999px 0;
  }
  
  .item-spread-graph-widget__graph-bar-part--radical {
    background-color: var(--USER-radical, #56638a);
  }
  
  .item-spread-graph-widget__graph-bar-part--kanji {
    background-color: var(--USER-kanji, #9c4644);
  }
  
  .item-spread-graph-widget__graph-bar-part--vocabulary {
    background-color: var(--USER-vocab, #58896f);
  }
  
  .extra-study-flash-card-widget__subject--radical {
    --subject-color: var(--USER-radical, #56638a);
    --subject-blur-color: color-mix(in srgb, var(--USER-radical, #56638a), var(--USER-text, #eeeeee) 50%);
  }
  
  .extra-study-flash-card-widget__subject--kanji {
    --subject-color: var(--USER-kanji, #9c4644);
    --subject-blur-color: color-mix(in srgb, var(--USER-kanji, #9c4644), var(--USER-text, #eeeeee) 50%);
  }
  
  .extra-study-flash-card-widget__subject--vocabulary {
    --subject-color: var(--USER-vocab, #58896f);
    --subject-blur-color: color-mix(in srgb, var(--USER-vocab, #58896f), var(--USER-text, #eeeeee) 50%);
  }
  
  .subject-character--unlocked .subject-character__characters-text {
    --color-text: var(--USER-text, #eeeeee);
  }
  
  .days-studied-widget__background:not(.days-studied-widget__background--dark) {
    filter: var(--USER-days-studied-filter, invert(0.85));
  }
  
  .days-studied-widget.theme--pastel,
  .days-studied-widget.theme--candy,
  .days-studied-widget.theme--vintage {
    --color-days-studied-content-border: var(--USER-brand, #9c4644);
    --color-days-studied-digit-filled-background: var(--USER-brand, #9c4644);
  }
  
  .study-streak-widget wk-svg-image {
    filter: drop-shadow(1px 0 0 var(--USER-text, #eeeeee)) drop-shadow(-1px 0 0 var(--USER-text, #eeeeee)) drop-shadow(0 1px 0 var(--USER-text, #eeeeee)) drop-shadow(0 -1px 0 var(--USER-text, #eeeeee));
  }
  .study-streak-widget .study-streak-widget__offering {
    --color-icon-primary: var(--USER-surface-4, #535353);
    --color-icon-secondary: var(--USER-surface-3, #303030) !important;
    --color-icon-tertiary: var(--USER-surface-2, #282828);
  }
  .study-streak-widget .study-streak-widget__offering.study-streak-widget__offering--available {
    --color-icon-primary: var(--USER-text, #eeeeee);
  }
  
  wk-svg-image[src*="missed-streak-432e8344.svg"] {
    filter: drop-shadow(1px 0 0 var(--USER-text, #eeeeee)) drop-shadow(-1px 0 0 var(--USER-text, #eeeeee)) drop-shadow(0 1px 0 var(--USER-text, #eeeeee)) drop-shadow(0 -1px 0 var(--USER-text, #eeeeee));
  }
  
  img[src*="level_up_image.svg"] {
    content: url("https://raw.githubusercontent.com/Everesh/WaniKani-ElementaryDark/refs/heads/main/img/level_up_image.svg") !important;
  }
  
  .extra-study-flash-card-widget__keyboard-indicator {
    --color-key-outline: var(--USER-text-grayed, #bbbbbb);
    --color-key-letter: var(--USER-text-grayed, #bbbbbb);
    --color-key-face: var(--USER-surface-3, #303030);
    --color-key-sides: var(--USER-surface-3, #303030);
  }
  
  .extra-study-flash-card-widget__keyboard-indicator[focused] {
    --color-key-outline: var(--USER-text, #eeeeee);
    --color-key-letter: var(--USER-text, #eeeeee);
    --color-key-face: var(--USER-surface-3, #303030);
    --color-key-sides: var(--USER-surface-3, #303030);
  }
  
  .wk-notification--info .wk-notification__button {
    --color-button-hover-background: var(
      --color-button-frameless-hover-background,
      transparent
    );
    --color-button-active-background: var(
      --color-button-frameless-active-background,
      transparent
    );
    --color-button-icon: var(--color-text, var(--USER-text, #eeeeee));
    --color-button-frameless-hover-border: var(--USER-text, #eeeeee);
  }
  
  .lesson-picker .page-header__title {
    text-shadow: none;
  }
  .lesson-picker .lesson-picker__link {
    color: var(--color-link);
  }
  .lesson-picker .lesson-picker__link:hover {
    color: var(--color-link-hover);
  }
  .lesson-picker .lesson-picker__link:active {
    color: var(--color-link-actiove);
  }
  .lesson-picker .lesson-picker__section-toggle:hover,
  .lesson-picker .lesson-picker__section-toggle-all:hover,
  .lesson-picker .wk-panel__header .lesson-picker__section-toggle:hover {
    color: var(--color-link-hover);
  }
  .lesson-picker .lesson-picker__section-toggle:active,
  .lesson-picker .lesson-picker__section-toggle-all:active,
  .lesson-picker .wk-panel__header .lesson-picker__section-toggle:active {
    color: var(--color-link-actiove);
  }
  .lesson-picker .lesson-picker__footer .lesson-picker__button:hover {
    filter: brightness(0.9);
  }
  
  .character-header {
    background-image: none;
  }
  .character-header .character-header__characters {
    text-shadow: none;
    color: var(--USER-text, #eeeeee);
  }
  .character-header .character-header__menu {
    color: var(--USER-text, #eeeeee);
  }
  
  .character-header--radical {
    background-color: var(--USER-radical, #56638a);
  }
  
  .character-header--kanji {
    background-color: var(--USER-kanji, #9c4644);
  }
  
  .character-header--vocabulary {
    background-color: var(--USER-vocab, #58896f);
  }
  
  .quiz-input__question-type-container[data-question-type=meaning] {
    color: var(--USER-text-inv, #151515);
    background: var(--USER-surface-inv, #bababa);
    text-shadow: none;
    background-image: none;
    border: none;
  }
  .quiz-input__question-type-container[data-question-type=reading] {
    color: var(--USER-text, #eeeeee);
    background: var(--USER-surface-2, #282828);
    text-shadow: none;
    background-image: none;
    border: none;
  }
  
  .quiz-progress__bar {
    background-color: var(--USER-progress, #a97e42);
  }
  
  .quiz-input__input {
    text-shadow: none;
    box-shadow: none;
    color: var(--USER-text, #eeeeee);
  }
  .quiz-input__input::placeholder {
    color: var(--USER-text-grayed, #bbbbbb);
  }
  
  .additional-content__item {
    box-shadow: none;
    background-color: var(--USER-surface-2, #282828);
    color: var(--USER-text, #eeeeee);
    border-color: var(--USER-surface-2, #282828);
  }
  
  .additional-content__item--open::after {
    border-color: rgba(0, 0, 0, 0) rgba(0, 0, 0, 0) var(--USER-surface-3, #303030) rgba(0, 0, 0, 0);
  }
  
  .additional-content__content {
    background-color: var(--USER-surface-2, #282828);
    box-shadow: none;
    border-color: var(--USER-surface-3, #303030);
  }
  .additional-content__content .subject-info:not([complete])::after,
  .additional-content__content .last-items:not([complete])::after,
  .additional-content__content .kana-chart:not([complete])::after {
    filter: var(--USER-loading-filter, grayscale(100%) invert(1) hue-rotate(180deg) contrast(0.68));
  }
  .additional-content__content .subject-character--burned:not(.subject-character--grid) .subject-character__characters,
  .additional-content__content .subject-character--grid.subject-character--burned,
  .additional-content__content .subject-character--small-with-meaning .subject-character__characters {
    box-shadow: none;
  }
  .additional-content__content .subject-character--grid.subject-character--burned .subject-character__characters,
  .additional-content__content .subject-character--grid.subject-character--burned .subject-character__info {
    opacity: 1;
  }
  .additional-content__content .subject-character--expandable .subject-character__characters:hover::before {
    background-color: var(--USER-surface-3, #303030);
  }
  .additional-content__content .subject-hint {
    --color-icon: var(--USER-text-inv, #151515);
    color: var(--USER-text-inv, #151515);
    background-color: var(--USER-surface-inv, #bababa);
    text-shadow: none;
    border-radius: 5px;
  }
  .additional-content__content .subject-hint .subject-hint__title {
    text-shadow: none;
    color: var(--USER-text-inv, #151515);
  }
  .additional-content__content .subject-section__meanings {
    align-items: center;
    margin-bottom: 8px;
    margin-top: 8px;
  }
  .additional-content__content .subject-section__meanings-title {
    color: var(--USER-text, #eeeeee);
    font-size: 1rem;
  }
  .additional-content__content .subject-section__meanings-items,
  .additional-content__content .subject-readings {
    color: var(--USER-text-hl, #c29354);
    font-weight: bold;
    font-size: 1.5rem;
  }
  .additional-content__content .subject-readings__reading-title,
  .additional-content__content .subject-readings {
    text-shadow: none;
  }
  .additional-content__content .subject-readings__reading {
    opacity: 0.7;
    font-weight: normal;
  }
  .additional-content__content .subject-readings__reading--primary {
    opacity: 1;
    font-weight: bold;
  }
  .additional-content__content .subject-readings__reading-title {
    color: var(--USER-text, #eeeeee);
  }
  .additional-content__content .subject-section__title,
  .additional-content__content .subject-section__subtitle,
  .additional-content__content .subject-section__text {
    text-shadow: none;
    border-color: var(--USER-text, #eeeeee);
  }
  .additional-content__content .user-note__link {
    text-shadow: none;
    color: var(--USER-text-grayed, #bbbbbb);
  }
  .additional-content__content .user-note__fields {
    background-color: var(--USER-surface-3, #303030);
    text-shadow: none;
  }
  .additional-content__content .user-note__fields .user-note__input {
    background-color: var(--USER-surface-3, #303030);
    text-shadow: none;
    color: var(--USER-text, #eeeeee);
  }
  .additional-content__content .user-note__fields .user-note__character-count {
    color: var(--USER-text, #eeeeee);
  }
  .additional-content__content .user-note__fields .user-note__button {
    text-shadow: none;
    color: var(--USER-text, #eeeeee);
  }
  .additional-content__content .subject-readings-with-audio {
    text-shadow: none;
  }
  .additional-content__content .subject-readings-with-audio .reading-with-audio__reading {
    font-size: 2rem;
    font-weight: bold;
    color: var(--USER-text-hl, #c29354);
  }
  .additional-content__content .subject-collocations__title,
  .additional-content__content .subject-collocations {
    text-shadow: none;
  }
  .additional-content__content .subject-collocations__patterns::after {
    box-shadow: 0 0 1px var(--USER-text-grayed, #bbbbbb);
  }
  .additional-content__content .subject-collocations__pattern-name {
    background-color: var(--USER-surface-inv, #bababa);
    color: var(--USER-surface-2, #282828);
    filter: brightness(0.6);
    text-shadow: none;
  }
  .additional-content__content .subject-collocations__pattern-name[aria-selected=true] {
    filter: none;
  }
  .additional-content__content .subject-collocations__pattern-name[aria-selected=true]::after {
    background-color: var(--USER-surface-2, #282828);
    background-image: none;
    box-shadow: 0 0 1px var(--USER-text, #eeeeee);
  }
  .additional-content__content .subject-character-grid--single-column li:nth-child(odd) {
    filter: var(--USER-kotoba-odd-row-filter, brightness(0.95));
  }
  .additional-content__content .subject-character-grid--single-column li:first-child a {
    border-radius: 0.3em 0.3em 0 0;
  }
  .additional-content__content .subject-character-grid--single-column li:last-child a {
    border-radius: 0 0 0.3em 0.3em;
  }
  .additional-content__content .last-item {
    box-shadow: none;
    background-color: var(--USER-surface-3, #303030);
    color: var(--USER-text, #eeeeee);
    border-radius: 0.3em 0.3em 0.3em 0.3em;
  }
  .additional-content__content .last-item .last-item__characters--radical {
    color: var(--USER-text, #eeeeee);
    background-color: var(--USER-radical, #56638a);
    text-shadow: none;
  }
  .additional-content__content .last-item .last-item__characters--kanji {
    color: var(--USER-text, #eeeeee);
    background-color: var(--USER-kanji, #9c4644);
    text-shadow: none;
  }
  .additional-content__content .last-item .last-item__characters--vocabulary {
    color: var(--USER-text, #eeeeee);
    background-color: var(--USER-vocab, #58896f);
    text-shadow: none;
  }
  .additional-content__content .last-item .last-item__label {
    color: var(--USER-text-grayed, #bbbbbb);
  }
  .additional-content__content .last-item .last-item__value {
    color: var(--USER-text, #eeeeee);
  }
  .additional-content__content .kana-chart__tab {
    text-shadow: none;
    color: var(--USER-text, #eeeeee);
    border-bottom: 1px solid var(--USER-text, #eeeeee);
    border-radius: 6px 6px 0 0;
  }
  .additional-content__content .kana-chart__tab.kana-chart__tab--selected {
    border: 1px solid var(--USER-text, #eeeeee);
    border-bottom: none;
  }
  .additional-content__content .kana-chart__tab:hover {
    background-color: var(--USER-surface-inv, #bababa);
    color: var(--USER-text-inv, #151515);
  }
  .additional-content__content .kana-chart__backspace {
    background-color: var(--USER-surface-inv, #bababa);
    color: var(--USER-text-inv, #151515);
  }
  .additional-content__content .kana-chart__backspace .kana-chart__backspace-text {
    text-shadow: none;
  }
  .additional-content__content .kana-chart__backspace:hover {
    background-color: var(--USER-text-grayed, #bbbbbb);
  }
  .additional-content__content .kana-chart__character {
    background-color: var(--USER-surface-3, #303030);
    text-shadow: none;
  }
  .additional-content__content .kana-chart__character:hover {
    background-color: var(--USER-surface-4, #535353);
  }
  .additional-content__content .kana-chart__character .kana-chart__character-romaji {
    color: var(--USER-text-grayed, #bbbbbb);
  }
  
  .user-synonyms__form_container .user-synonyms__synonym-button:hover .wk-icon,
  .user-synonyms__form_container .user-synonyms__synonym-button:active .wk-icon {
    --color-icon: var(--USER-text-inv, #151515);
  }
  
  .answer-exception,
  .quiz-input__exception {
    text-shadow: none;
    box-shadow: none;
    background-color: var(--USER-surface-3, #303030);
    color: var(--USER-text, #eeeeee);
  }
  .answer-exception:before,
  .quiz-input__exception:before {
    border-color: rgba(0, 0, 0, 0) rgba(0, 0, 0, 0) var(--USER-surface-3, #303030) rgba(0, 0, 0, 0);
  }
  
  .hotkeys-menu {
    color: var(--USER-text, #eeeeee);
    text-shadow: none;
    background-color: var(--USER-surface-3, #303030);
    border-radius: 0.3em 0.3em 0 0;
  }
  .hotkeys-menu.hotkeys-menu--open {
    border: 1px solid var(--USER-surface-1, #151515);
    border-bottom: none;
  }
  .hotkeys-menu .hotkeys-menu__header {
    color: var(--USER-text, #eeeeee);
    border-radius: 0.3em 0.3em 0 0;
    background-color: var(--USER-surface-2, #282828);
  }
  .hotkeys-menu .hotkeys-menu__key {
    background-color: var(--USER-surface-4, #535353);
  }
  
  .chat-button {
    background-color: var(--USER-surface-2, #282828);
  }
  
  #user_synonyms {
    flex-direction: row;
    align-items: center;
  }
  #user_synonyms ul {
    color: var(--USER-text-hl, #c29354);
    font-weight: bold;
    font-size: 1.5em;
  }
  
  .reading-with-audio__audio-item[playing=true] .wk-icon--sound_on {
    display: inline-block;
  }
  
  .character-header--radical .character-header__meaning,
  .character-header--kanji .character-header__meaning,
  .character-header--vocabulary .character-header__meaning {
    text-shadow: none;
    color: var(--USER-text, #eeeeee);
  }
  
  .subject-slides__navigation-link[aria-selected=true]::after {
    border-color: rgba(0, 0, 0, 0) rgba(0, 0, 0, 0) var(--USER-surface-3, #303030) rgba(0, 0, 0, 0);
  }
  
  .subject-slide {
    background-color: var(--USER-surface-2, #282828);
    border-color: var(--USER-surface-3, #303030);
    box-shadow: none;
  }
  .subject-slide .user-note__link {
    text-shadow: none;
    color: var(--USER-text-grayed, #bbbbbb);
  }
  .subject-slide .user-note__fields {
    background-color: var(--USER-surface-3, #303030);
    text-shadow: none;
  }
  .subject-slide .user-note__fields .user-note__input {
    background-color: var(--USER-surface-3, #303030);
    text-shadow: none;
    color: var(--USER-text, #eeeeee);
  }
  .subject-slide .user-note__fields .user-note__character-count {
    color: var(--USER-text, #eeeeee);
  }
  .subject-slide .user-note__fields .user-note__button {
    text-shadow: none;
    color: var(--USER-text, #eeeeee);
  }
  .subject-slide .subject-section__title {
    text-shadow: none;
    border-color: var(--USER-text, #eeeeee);
  }
  .subject-slide .subject-readings-with-audio {
    text-shadow: none;
  }
  .subject-slide .subject-collocations__title,
  .subject-slide .subject-collocations {
    text-shadow: none;
  }
  .subject-slide .subject-collocations__patterns::after {
    box-shadow: 0 0 1px var(--USER-text-grayed, #bbbbbb);
  }
  .subject-slide .subject-collocations__pattern-name {
    background-color: var(--USER-surface-inv, #bababa);
    color: var(--USER-surface-2, #282828);
    filter: brightness(0.6);
  }
  .subject-slide .subject-collocations__pattern-name[aria-selected=true] {
    filter: none;
  }
  .subject-slide .subject-collocations__pattern-name[aria-selected=true]::after {
    background-color: var(--USER-surface-2, #282828);
    box-shadow: 0 0 1px var(--USER-text, #eeeeee);
    background-image: none;
  }
  .subject-slide .character--small-with-meaning .subject-character__characters,
  .subject-slide .subject-character--small-with-meaning .subject-character__characters {
    box-shadow: none;
  }
  .subject-slide .reading-with-audio__reading,
  .subject-slide .subject-slide__aside .subject-section:first-of-type p {
    color: var(--USER-text-hl, #c29354);
    font-size: 1.5rem;
    font-weight: bold;
  }
  .subject-slide .reading-with-audio__reading[lang=ja],
  .subject-slide .subject-slide__aside .subject-section:first-of-type p[lang=ja] {
    font-size: 2rem;
  }
  
  .subject-character--tiny .subject-character__characters {
    box-shadow: none;
  }
  
  .wk-button--quiz {
    box-shadow: none;
  }
  .wk-button--quiz:hover {
    filter: brightness(0.9);
  }
  
  .lesson-modal .wk-button--modal-primary {
    --color-icon: var(--USER-surface-1, #151515);
  }
  .lesson-modal .wk-button--modal-primary:hover, .lesson-modal .wk-button--modal-primary:focus, .lesson-modal .wk-button--modal-primary:active {
    --color-icon: var(--USER-text, #eeeeee);
    color: var(--USER-text, #eeeeee);
    background-color: var(--USER-surface-1, #151515);
  }
  
  .wk-button--quiz:hover {
    filter: none;
  }
  .wk-button--quiz .wk-button__content {
    background-color: var(--USER-surface-2, #282828);
    border: solid 1px var(--USER-text, #eeeeee);
    transform: translateY(0);
  }
  .wk-button--quiz:hover .wk-button__content, .wk-button--quiz:focus .wk-button__content {
    filter: none;
    transform: translateY(0);
    border: solid 1px var(--USER-text, #eeeeee);
    outline: 1px solid var(--USER-text, #eeeeee);
  }
  .wk-button--quiz:active .wk-button__content {
    filter: none;
    transform: translateY(0);
    outline: 2px solid var(--USER-text, #eeeeee);
    border: solid 1px var(--USER-text, #eeeeee);
  }
  .wk-button--quiz:active .wk-button__shadow {
    background-color: transparent;
  }
  
  .lesson-modal__buttons {
    --color-button-edge: transparent;
    --color-button-hover-edge: transparent;
    --color-button-active-edge: transparent;
    --color-button-border: var(--USER-text, #eeeeee);
    --color-button-hover-border: var(--USER-text, #eeeeee);
    --color-button-active-border: var(--USER-text, #eeeeee);
  }
  
  .page-header {
    padding: 1.5em 0;
    margin: 0;
  }
  
  .page-header__title {
    text-shadow: none;
  }
  
  .page-header__title-subtext {
    color: var(--USER-text-grayed, #bbbbbb);
  }
  
  .subject-legend-character--locked.subject-legend-character--radical {
    --color-blue: var(--USER-radical, #56638a);
    color: var(--USER-text, #eeeeee);
    border: none;
  }
  
  .subject-legend-character--locked.subject-legend-character--kanji {
    --color-pink: var(--USER-kanji, #9c4644);
    color: var(--USER-text, #eeeeee);
    border: none;
  }
  
  .subject-legend-character--locked.subject-legend-character--vocabulary {
    --color-purple: var(--USER-vocab, #58896f);
    color: var(--USER-text, #eeeeee);
    border: none;
  }
  
  .subject-character--recent.subject-character--radical .subject-character__characters-text,
  .subject-legend-character--lesson.subject-legend-character--radical {
    color: var(--USER-text, #eeeeee);
    background: color-mix(in srgb, var(--USER-radical, #56638a), transparent 75%);
    border-color: color-mix(in srgb, var(--USER-radical, #56638a), white 25%);
  }
  
  .subject-character--recent.subject-character--kanji .subject-character__characters-text,
  .subject-legend-character--lesson.subject-legend-character--kanji {
    color: var(--USER-text, #eeeeee);
    background: color-mix(in srgb, var(--USER-kanji, #9c4644), transparent 75%);
    border-color: color-mix(in srgb, var(--USER-kanji, #9c4644), white 25%);
  }
  
  .subject-character--recent.subject-character--vocabulary .subject-character__characters-text,
  .subject-legend-character--lesson.subject-legend-character--vocabulary {
    color: var(--USER-text, #eeeeee);
    background: color-mix(in srgb, var(--USER-vocab, #58896f), transparent 75%);
    border-color: color-mix(in srgb, var(--USER-vocab, #58896f), white 25%);
  }
  
  .subject-legend-character--burned {
    color: var(--USER-text, #eeeeee);
    background: var(--USER-burned, #303030);
    border-color: color-mix(in srgb, var(--USER-burned, #303030), white 25%);
  }
  
  .site-content-container .container:has(.character-grid) {
    background-color: var(--USER-surface-2, #282828);
    border: 1px solid var(--USER-surface-4, #535353);
    border-radius: 8px;
    padding: 0 1.5em 0.5em 1.5em;
    margin-top: 1.5em;
  }
  .site-content-container .container:has(.character-grid) .search--open {
    transform: translateY(-6em);
    margin-bottom: calc(-5em - 8px);
  }
  .site-content-container .container:has(.character-grid) .search--open .search__button {
    transform: translateY(4px);
  }
  .site-content-container .container:has(.character-grid):has(.search--open) {
    transform: translateY(calc(4em + 4px));
  }
  .site-content-container .container:has(.character-grid) .character-grid__header .character-grid__header-content {
    border-radius: var(--border-radius-tight) var(--border-radius-tight) 0 0;
    border: 1px solid var(--USER-surface-4, #535353);
    border-bottom: none;
  }
  .site-content-container .container:has(.character-grid) .character-grid__header .progress-chart__progress-bar-container {
    box-shadow: none;
  }
  
  .subject-legend-character--burned.subject-legend-character--radical {
    background: var(--USER-burned, #303030);
    border-color: var(--USER-radical, #56638a);
  }
  
  .subject-legend-character--burned.subject-legend-character--kanji {
    background: var(--USER-burned, #303030);
    border-color: var(--USER-kanji, #9c4644);
  }
  
  .subject-legend-character--burned.subject-legend-character--vocabulary {
    background: var(--USER-burned, #303030);
    border-color: var(--USER-vocab, #58896f);
  }
  
  .subject-character--burned:not(.subject-character--locked) .subject-character__characters-text {
    --color-text: var(--USER-text, #eeeeee);
    color: var(--USER-text, #eeeeee);
    background: var(--USER-burned, #303030);
    border-color: var(--EDI-burned-carryover);
  }
  .subject-character--burned:not(.subject-character--locked).subject-character--radical {
    --EDI-burned-carryover: var(--USER-radical, #56638a);
  }
  .subject-character--burned:not(.subject-character--locked).subject-character--kanji {
    --EDI-burned-carryover: var(--USER-kanji, #9c4644);
  }
  .subject-character--burned:not(.subject-character--locked).subject-character--vocabulary {
    --EDI-burned-carryover: var(--USER-vocab, #58896f);
  }
  
  .site-content-container .container:has(.subject-page-header) .search--open {
    transform: translateY(-6em);
    margin-bottom: calc(-5em - 8px);
  }
  .site-content-container .container:has(.subject-page-header) .search--open .search__button {
    transform: translateY(4px);
  }
  .site-content-container .container:has(.subject-page-header):has(.search--open) {
    transform: translateY(calc(4em + 4px));
  }
  .site-content-container .container:has(.subject-page-header) .subject-character--expandable .subject-character__characters:hover::before {
    background: var(--USER-surface-3, #303030);
  }
  .site-content-container .container:has(.subject-page-header) .subject-page-header {
    padding: 0;
  }
  .site-content-container .container:has(.subject-page-header) .subject-page-header__level-and-pagination {
    margin: 0;
  }
  .site-content-container .container:has(.subject-page-header) #section-meaning .subject-section__subtitle,
  .site-content-container .container:has(.subject-page-header) #section-meaning .subject-section__text,
  .site-content-container .container:has(.subject-page-header) #section-reading .subject-section__subtitle,
  .site-content-container .container:has(.subject-page-header) #section-reading .subject-section__text,
  .site-content-container .container:has(.subject-page-header) #section-context .subject-section__subtitle,
  .site-content-container .container:has(.subject-page-header) #section-context .subject-section__text {
    text-shadow: none;
  }
  .site-content-container .container:has(.subject-page-header) #section-meaning .subject-section__meanings-title,
  .site-content-container .container:has(.subject-page-header) #section-reading .subject-section__meanings-title,
  .site-content-container .container:has(.subject-page-header) #section-context .subject-section__meanings-title {
    color: var(--USER-text, #eeeeee);
  }
  .site-content-container .container:has(.subject-page-header) #section-meaning .subject-section__meanings,
  .site-content-container .container:has(.subject-page-header) #section-reading .subject-section__meanings,
  .site-content-container .container:has(.subject-page-header) #section-context .subject-section__meanings {
    align-items: center;
  }
  .site-content-container .container:has(.subject-page-header) #section-meaning .subject-section__meanings:first-child p.subject-section__meanings-items,
  .site-content-container .container:has(.subject-page-header) #section-meaning .subject-section__meanings:nth-child(2) p.subject-section__meanings-items,
  .site-content-container .container:has(.subject-page-header) #section-reading .subject-section__meanings:first-child p.subject-section__meanings-items,
  .site-content-container .container:has(.subject-page-header) #section-reading .subject-section__meanings:nth-child(2) p.subject-section__meanings-items,
  .site-content-container .container:has(.subject-page-header) #section-context .subject-section__meanings:first-child p.subject-section__meanings-items,
  .site-content-container .container:has(.subject-page-header) #section-context .subject-section__meanings:nth-child(2) p.subject-section__meanings-items {
    color: var(--USER-text-hl, #c29354);
    font-weight: bold;
    font-size: 1.5rem;
  }
  .site-content-container .container:has(.subject-page-header) #section-meaning .user-note__link,
  .site-content-container .container:has(.subject-page-header) #section-reading .user-note__link,
  .site-content-container .container:has(.subject-page-header) #section-context .user-note__link {
    text-shadow: none;
    color: var(--USER-text-grayed, #bbbbbb);
  }
  .site-content-container .container:has(.subject-page-header) #section-meaning .user-note__fields,
  .site-content-container .container:has(.subject-page-header) #section-reading .user-note__fields,
  .site-content-container .container:has(.subject-page-header) #section-context .user-note__fields {
    background-color: var(--USER-surface-3, #303030);
    text-shadow: none;
  }
  .site-content-container .container:has(.subject-page-header) #section-meaning .user-note__fields .user-note__input,
  .site-content-container .container:has(.subject-page-header) #section-reading .user-note__fields .user-note__input,
  .site-content-container .container:has(.subject-page-header) #section-context .user-note__fields .user-note__input {
    background-color: var(--USER-surface-3, #303030);
    text-shadow: none;
    color: var(--USER-text, #eeeeee);
  }
  .site-content-container .container:has(.subject-page-header) #section-meaning .user-note__fields .user-note__character-count,
  .site-content-container .container:has(.subject-page-header) #section-reading .user-note__fields .user-note__character-count,
  .site-content-container .container:has(.subject-page-header) #section-context .user-note__fields .user-note__character-count {
    color: var(--USER-text, #eeeeee);
  }
  .site-content-container .container:has(.subject-page-header) #section-meaning .user-note__fields .user-note__button,
  .site-content-container .container:has(.subject-page-header) #section-reading .user-note__fields .user-note__button,
  .site-content-container .container:has(.subject-page-header) #section-context .user-note__fields .user-note__button {
    text-shadow: none;
    color: var(--USER-text, #eeeeee);
  }
  .site-content-container .container:has(.subject-page-header) #section-meaning .subject-readings__reading-title,
  .site-content-container .container:has(.subject-page-header) #section-reading .subject-readings__reading-title,
  .site-content-container .container:has(.subject-page-header) #section-context .subject-readings__reading-title {
    text-shadow: none;
  }
  .site-content-container .container:has(.subject-page-header) #section-meaning .subject-readings__reading-items,
  .site-content-container .container:has(.subject-page-header) #section-reading .subject-readings__reading-items,
  .site-content-container .container:has(.subject-page-header) #section-context .subject-readings__reading-items {
    text-shadow: none;
    color: var(--USER-text-hl, #c29354);
    font-weight: bold;
    font-size: 1.5rem;
  }
  .site-content-container .container:has(.subject-page-header) #section-meaning .subject-readings-with-audio,
  .site-content-container .container:has(.subject-page-header) #section-reading .subject-readings-with-audio,
  .site-content-container .container:has(.subject-page-header) #section-context .subject-readings-with-audio {
    text-shadow: none;
  }
  .site-content-container .container:has(.subject-page-header) #section-meaning .subject-readings-with-audio .reading-with-audio__reading,
  .site-content-container .container:has(.subject-page-header) #section-reading .subject-readings-with-audio .reading-with-audio__reading,
  .site-content-container .container:has(.subject-page-header) #section-context .subject-readings-with-audio .reading-with-audio__reading {
    color: var(--USER-text-hl, #c29354);
    font-weight: bold;
    font-size: 2rem;
  }
  .site-content-container .container:has(.subject-page-header) #section-meaning .subject-collocations__title,
  .site-content-container .container:has(.subject-page-header) #section-meaning .subject-collocations,
  .site-content-container .container:has(.subject-page-header) #section-reading .subject-collocations__title,
  .site-content-container .container:has(.subject-page-header) #section-reading .subject-collocations,
  .site-content-container .container:has(.subject-page-header) #section-context .subject-collocations__title,
  .site-content-container .container:has(.subject-page-header) #section-context .subject-collocations {
    text-shadow: none;
  }
  .site-content-container .container:has(.subject-page-header) #section-meaning .subject-collocations__patterns::after,
  .site-content-container .container:has(.subject-page-header) #section-reading .subject-collocations__patterns::after,
  .site-content-container .container:has(.subject-page-header) #section-context .subject-collocations__patterns::after {
    box-shadow: 0 0 1px var(--USER-text-grayed, #bbbbbb);
  }
  .site-content-container .container:has(.subject-page-header) #section-meaning .subject-collocations__pattern-name,
  .site-content-container .container:has(.subject-page-header) #section-reading .subject-collocations__pattern-name,
  .site-content-container .container:has(.subject-page-header) #section-context .subject-collocations__pattern-name {
    background-color: var(--USER-surface-inv, #bababa);
    color: var(--USER-surface-2, #282828);
    filter: brightness(0.6);
  }
  .site-content-container .container:has(.subject-page-header) #section-meaning .subject-collocations__pattern-name[aria-selected=true],
  .site-content-container .container:has(.subject-page-header) #section-reading .subject-collocations__pattern-name[aria-selected=true],
  .site-content-container .container:has(.subject-page-header) #section-context .subject-collocations__pattern-name[aria-selected=true] {
    filter: none;
  }
  .site-content-container .container:has(.subject-page-header) #section-meaning .subject-collocations__pattern-name[aria-selected=true]::after,
  .site-content-container .container:has(.subject-page-header) #section-reading .subject-collocations__pattern-name[aria-selected=true]::after,
  .site-content-container .container:has(.subject-page-header) #section-context .subject-collocations__pattern-name[aria-selected=true]::after {
    background-image: none;
    background-color: var(--USER-surface-2, #282828);
    box-shadow: 0 0 1px var(--USER-text, #eeeeee);
  }
  .site-content-container .container:has(.subject-page-header) .subject-progress {
    text-shadow: none;
  }
  .site-content-container .container:has(.subject-page-header) .subject-progress .progress-chart__progress-bar-container,
  .site-content-container .container:has(.subject-page-header) .subject-progress .progress-chart__progress-bar {
    border-radius: 8px;
  }
  .site-content-container .container:has(.subject-page-header) .subject-progress .subject-progress__meta-value {
    color: var(--USER-text-grayed, #bbbbbb);
  }
  .site-content-container .container:has(.subject-page-header) .subject-progress .subject-progress__button {
    color: var(--USER-text, #eeeeee);
    background: var(--USER-alert, #9c4644);
    border-color: color-mix(in srgb, var(--USER-alert, #9c4644), white 10%);
    box-shadow: none;
    font-weight: bold;
  }
  .site-content-container .container:has(.subject-page-header) .subject-progress .subject-progress__button:hover {
    border-color: color-mix(in srgb, var(--USER-alert, #9c4644), white 20%);
    background-color: color-mix(in srgb, var(--USER-alert, #9c4644), white 10%);
  }
  .site-content-container .container:has(.subject-page-header) .subject-progress .subject-progress__button:active {
    color: var(--USER-alert, #9c4644);
    background: var(--USER-text, #eeeeee);
  }
  .site-content-container .container:has(.subject-page-header) {
    background-color: var(--USER-surface-2, #282828);
    border-radius: 8px;
    border: 1px solid var(--USER-surface-4, #535353);
    padding: 0 1.5em 0.5em 1.5em;
    margin-top: 1.5em;
  }
  
  .public-profile .subject-character--small-with-meaning .subject-character__characters {
    box-shadow: none;
  }
  .public-profile .progress-chart__progress-bar-container,
  .public-profile .progress-chart__progress-bar {
    border-radius: 8px;
  }
  .public-profile .wk-panel {
    border: 1px solid var(--USER-surface-4, #535353);
  }
  
  #preference_lessons_batch_size,
  #preference_reviews_display_srs_indicator,
  #preference_reviews_presentation_order,
  #preference_lessons_interleave_subjects,
  #preference_preferred_voice_actor_type,
  #preference_lessons_autoplay_audio,
  #preference_reviews_autoplay_audio,
  #preference_extra_study_autoplay_audio,
  #maximum_recommended_daily_lesson_count,
  #username,
  #new_password,
  #current_password,
  #email,
  #new_email_password,
  #preference_time_format,
  #preference_timezone,
  #preference_gravatar_profile_pic,
  #preference_opt_mail,
  #preference_emails_on_level_up,
  #preference_update_email_frequency,
  #user_reset_target_level {
    background-color: var(--USER-surface-3, #303030);
  }
  
  .settings-link,
  #gravatar_profile_pic a:not(.wk-button--default),
  #personal_access_token_frame a:not(.wk-button--default) {
    color: var(--USER-text-hl, #c29354);
  }
  .settings-link:hover,
  #gravatar_profile_pic a:not(.wk-button--default):hover,
  #personal_access_token_frame a:not(.wk-button--default):hover {
    color: var(--USER-text-grayed, #bbbbbb);
  }
  
  #personal_access_token_frame .wk-code {
    border-radius: 5px;
    padding: 0.3em;
    font-weight: bold;
  }
  
  .wk-button--danger {
    border-radius: 4px;
    box-shadow: 1px 0 0 var(--USER-surface-4, #535353), -1px 0 0 var(--USER-surface-4, #535353), 0 1px 0 var(--USER-surface-4, #535353), 0 -1px 0 var(--USER-surface-4, #535353);
  }
  
  .billing-receipts__receipt-link,
  .billing-receipts__receipt-link:visited,
  .billing-receipts__receipt-link:active,
  .billing-receipts__receipt-link:focus,
  .billing-receipts__receipt-link:hover {
    color: var(--USER-text-hl, #c29354);
  }
  
  .billing-receipts li:nth-child(odd) a {
    filter: var(--USER-kotoba-odd-row-filter, brightness(0.95));
  }
  
  html:has(.wk-authentication) {
    background-color: var(--USER-surface-1, #151515);
  }
  html:has(.wk-authentication) .wk-authentication a,
  html:has(.wk-authentication) .wk-authentication a:visited {
    color: var(--USER-text-hl, #c29354);
  }
  html:has(.wk-authentication) .wk-authentication a:hover,
  html:has(.wk-authentication) .wk-authentication a:visited:hover {
    color: var(--USER-text-grayed, #bbbbbb);
  }
`;

  // ------------------------------------------------------------------ boot --

  /*
   * Inject the bundled dark theme site-wide (not gated on the review page).
   * Turbo swaps <head> on navigation, so re-add the <style> whenever it goes
   * missing; the 2s tick keeps it in place through any later DOM churn.
   */
  function ensureDarkTheme() {
    if (!LOAD_DARK_THEME) return;
    if (document.getElementById('wkrr-dark-theme')) return;
    const style = el('style', { id: 'wkrr-dark-theme', text: DARK_THEME_CSS });
    (document.head || document.documentElement).append(style);
  }

  function ensureUI() {
    // The script runs site-wide now - only build the panel on a quiz page, and
    // tear it (and any peek) down when Turbo carries us off to the dashboard.
    if (!isReviewPage()) {
      const strayPanel = document.getElementById('wkrr-panel');
      if (strayPanel) strayPanel.remove();
      document.documentElement.classList.remove('wkrr-collapsed');
      currentSubject = null;
      currentQuestionType = null;
      hidePeek();
      return;
    }
    if (!document.getElementById('wkrr-style')) {
      document.head.append(el('style', { id: 'wkrr-style', text: CSS }));
    }
    if (!document.getElementById('wkrr-panel')) {
      document.body.append(el('div', { id: 'wkrr-panel' }));
      render();
    }
  }

  load();

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
    const detail = event.detail || {};
    if (isReviewUrl(detail.url || location.href) && detail.action !== 'restore') {
      resetSession();
    }
  });

  // Site theme first, then the panel.
  function tick() {
    ensureDarkTheme();
    ensureUI();
  }

  tick();

  // Turbo swaps <body> (and prunes our <style>s out of <head>) on navigation.
  document.addEventListener('turbo:load', tick);
  document.addEventListener('turbo:render', tick);
  setInterval(tick, 2000);
})();
