// ==UserScript==
// @name         WaniKani Review Recap Sidebar
// @namespace    https://github.com/dominikchmiel/review-recap-wanikani
// @version      1.2.0
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

  // Bundle the "WK Basic Dark Mode" userstyle (userstyles.world/style/9178) so a
  // separate Stylus install isn't needed. Set to false to leave WaniKani's own
  // styling alone. The CSS is embedded in DARK_THEME_CSS near the bottom.
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
    applyTheme(peek);
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

/* Shift-to-peek popover. Mirrors the panel's palette (see applyTheme) so it sits
 * right in whichever theme is active. */
#wkrr-peek {
  --wkrr-bg: #f4f4f4;
  --wkrr-card: #ffffff;
  --wkrr-border: #e0e0e0;
  --wkrr-fg: #333333;
  --wkrr-muted: #8a8a8a;
  --wkrr-faint: #b4b4b4;
  --wkrr-on-accent: #ffffff;

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
#wkrr-peek[data-theme="dark"] {
  --wkrr-bg: var(--USER-surface-1, #151515);
  --wkrr-card: var(--USER-surface-2, #282828);
  --wkrr-border: var(--USER-surface-4, #535353);
  --wkrr-fg: var(--USER-text, #eeeeee);
  --wkrr-muted: var(--USER-text-grayed, #bbbbbb);
  --wkrr-faint: color-mix(in srgb, var(--USER-text-grayed, #bbbbbb), transparent 40%);
  --wkrr-on-accent: var(--USER-text, #eeeeee);
}
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
   * "WK Basic Dark Mode" by eggbiscuit1 / aquasurge7 (userstyles.world/style/9178),
   * embedded verbatim. The original ships wrapped in Firefox-only @-moz-document
   * blocks; those are stripped here (Chrome ignores the at-rule, so the rules
   * would never apply) and only the www.wanikani.com block is kept. String.raw
   * keeps the theme's CSS class escapes (e.g. .sm\:w-full) intact without
   * doubling every backslash. Author credit / license live in the CSS comments
   * at the top of the embedded block.
   */
  const DARK_THEME_CSS = String.raw`
/* WK Basic Dark Mode by aquasurge7 */
/* Version 1.2.0 */

/* Notes:

- Credit to SARUOU for the footer gif from Dark Azure 2. If they do not wish for it to be used here, please just notify me.

- If you wish to edit or modify this theme, please do so to your heart's content. If you wish to publish a modified version of this (as I have done with my modified version of Dark Azure 2), please feel free to do so. I only ask that you give credit me for the base of the theme, as well as do not attempt to monetize off of it. I doubt these things would be an issue for the wanikani community anyway, and most likely only a few people will end up getting use out of my dark mode.

- The code isn't perfectly divided. There are page categories, which were the order I coded in. However, modifying some elements will make changes across multiple pages, so please be aware.

*/

/* Page: Dashboard */

body {
    color:#fff;
    background-blend-mode:color-burn;
    background-color:#222;
}

p, ol, figcaption, .body-copy, .body-copy li {
    text-shadow: 0 1px 0 #000;
}

h1, html#public-profile div.wall-of-shame div.title, h2, h3 {
    text-shadow: 0 1px 0 #000;
}

#main footer {
    background-image: url(https://raw.githubusercontent.com/misabiko/Wanikani-Grayish-Blueish-Dark/master/Assets/footer-bg-invert.gif) !important;
    background-position: top !important;
}

.text-black {
    --tw-text-opacity: 1;
    color: rgba(255,255,255,var(--tw-text-opacity));
}

.sitemap__section-header {
    color:#fff;
    text-shadow:0 1px 0 #000;
}

.global-header{
    background-image:none;
    background-color:#111;
}

.community-banner {
    background-color:#333;
    border:none;
}

.community-banner__link {
    color:#fff;
}

.community-banner__link:hover {
    color:#fff
}

.community-banner__text, .community-banner__cta, .community-banner__title {
    text-shadow:0 1px 0 #000;
}

.global-header {
    border-bottom: 1px solid #555;
}

.dashboard section.forecast {
    background-color:#333;
}

.dashboard section.dashboard-progress, .dashboard section.forecast, .dashboard section.newbie, .dashboard section.upgrade, .dashboard section.system-alert, .dashboard section.alert-where-user-scripts-cant-ignore, .community-banner, .dashboard-panel {
    box-shadow: 0 1px 0 #2A2A2A;
}

.review-forecast__day.is-collapsed .review-forecast__day-header {
    color:#333
}
    
.forecast * {
    color:#fff;
}

.bg-white {
    background-color:#444;
}

.review-forecast__day-header::before {
    background-color: rgba(51,51,51,var(--tw-bg-opacity));
}

.dashboard section.dashboard-progress {
    background-color:#333;
}

.sm\:w-full {
    filter: invert(73.5%);
}

.fa-magnifying-glass::before, .fa-search::before {
    color:#fff;
    text-shadow: 0 1px 0 #000;
}

button#search__trigger.hover\:border-transparent-1:hover {
    background-color:#0000;
    border-color:rgba(255, 255, 255, 0.2);
}

button#search__trigger.hover\:border-transparent-3:hover {
    background-color:#0000;
    border-color:rgba(255,255,255,.4);
}

button#search__trigger.hover\:border-transparent-1 {
    color:#0000;
    background-color:#0000;
    border-color:#0000
}

button#search__trigger.hover\:border-transparent-3 {
    color:#0000;
    background-color:#0000;
    border-color:#0000
}

.navigation-shortcut__button {
    color:#fff;
    text-shadow: 0 1px 0 #000;
    border: 2px solid rgba(255, 255, 255, 0.2);
}

.navigation-shortcut__button:hover {
    color:#fff;
    border-color:rgba(255, 255, 255, .4);
}

.navigation-shortcut__button:focus {
    color:#fff;
}

section.srs-progress ul li:first-child {
    box-shadow: 0 1px 0 #dd0093;
}

section.srs-progress ul li:nth-child(2) {
    box-shadow: 0 1px 0 #882d9e;
}

section.srs-progress ul li:nth-child(3) {
    box-shadow: 0 1px 0 #294ddb;
}

section.srs-progress ul li:nth-child(4) {
    box-shadow: 0 1px 0 #0093dd;
}

section.srs-progress ul li:last-child {
    box-shadow: 0 1px 0 #434343;
}

.dashboard-sub-section h3 {
    color:#fff;
    text-shadow:0 1px 0 #000;
    background-color:#333;
}

.dashboard section.dashboard-sub-section div.see-more {
    background-color:#333;
    box-shadow: 0 1px 0 #2A2A2A;
}

.dashboard section.dashboard-sub-section a.small-caps {
    color:#eee;
    text-shadow: 0 1px 0 #000;
}

.dashboard section.dashboard-sub-section a.small-caps:hover {
    color: #999;
}

.kotoba-table-list table tr.none-available {
    background-color:#333;
    color:#fff;
    text-shadow: 0 1px 0 #000;
}

.kotoba-table-list table tr.none-available div {
    border: 5px solid #fff;
    box-shadow:0 1px 0 #2A2A2A;
}

.sitemap__section-header:hover {
    border-color:rgba(255, 255, 255, .2)
}

.sitemap__section-header:focus{
    border-color:rgba(255, 255, 255, .4)
}

.sitemap__section-header[data-expanded="true"] {
    border-color:rgba(255,255,255,.4);
}

.sitemap__section-header--vocabulary:hover {
    border-color:rgba(170,0,255,0.25);
}

.sitemap__section-header--kanji:hover {
    border-color:rgba(255,0,170,0.25);
}

.sitemap__section-header--radicals:hover {
    border-color:rgba(0,170,255,0.25);
}

.sitemap__expandable-chunk > :first-child {
    background-color:#222;
}

.sitemap__pages--levels .sitemap__page a {
    background-color:#333;
}

ul.sitemap__pages.sitemap__pages--radical{
    background-color:#00AAFF;
}

ul.sitemap__pages.sitemap__pages--kanji{
    background-color:#FF00AA;
}

ul.sitemap__pages.sitemap__pages--vocabulary{
    background-color:#AA00FF;
}

.sitemap__section-header--radicals:focus {
    border-color:#00AAFF;
}

.sitemap__section-header--kanji:focus {
    border-color:#FF00AA;
}

.sitemap__section-header--vocabulary:focus {
    border-color:#AA00FF
}

.search-form form .search-query {
    color:#fff;
    background-color:#111;
}

button.flex-initial.rounded.bg-gray-500.text-white.font-bold.border-0.px-3.py-1 {
    background-color:#333;
    box-shadow: 1px 1px 1px rgba(0, 0, 0, 0.7);
}

button.flex-initial.rounded.bg-gray-500.text-white.font-bold.border-0.px-3.py-1:hover {
    background-color:#444;
    box-shadow: 1px 1px 1px rgba(0, 0, 0, 0.7);
}

button.flex-initial.rounded.bg-gray-500.text-white.font-bold.border-0.px-3.py-1:focus {
    box-shadow:none;
}

.text-gray-800 {
    color:#fff;
    text-shadow:#000
}

.text-blue-500 {
    color:#fff;
    text-shadow: 0 1px 0 #000;
}

.text-blue-500:hover {
    color:#999;
}

.border-blue-300 {
    border-color:#eee;
}

*, ::after, ::before {
    --tw-ring-color: rgba(59,130,246,0.0);
}

.bg-gray-300 {
    background-color:#2A2A2A;
}

a:focus {
    color:#fff;
}

.sitemap__section-header--radicals[data-expanded="true"], .sitemap__section-header--radicals:focus {
    outline: none;
    border-color: #00AAFF;
}

.sitemap__section-header--kanji[data-expanded="true"], .sitemap__section-header--kanji:focus {
    outline: none;
    border-color: #FF00AA;
}

.sitemap__section-header--vocabulary[data-expanded="true"], .sitemap__section-header--vocabulary:focus {
    outline: none;
    border-color: #AA00FF;
}

.disabled\:text-gray-700:disabled {
    color:#fff;
}

button.border.border-solid:hover {
    color: #fff;
    background-color: #fff0;
    border-color: #888;
}

.sitemap__page--login a{
    color:#fff;
}

/* Page: Levels */

.character-grid__header {
    color:#fff;
    text-shadow:0 1px 0 #000;
    background-color:#333;
}

.progress-bar__bar {
    background-image: linear-gradient(to bottom, #555, #333);
}

.progress-bar {
    background-color: #2A2A2A;
}

.subject-legend {
    color:#fff;
    text-shadow: 0 1px 0 #000;
    background-color:#333;
}

.subject-legend__title {
    color:#fff;
}

.page-header__title {
    text-shadow: 0 1px 0 #000;
}

.page-nav {
    color:#fff;
    text-shadow: 0 1px 0 #000;
}

.page-nav__item-link{
    color:#fff;
    text-shadow: 0 1px 0 #000;
    background-color: #333;
    border: 1px solid #333;
}

.page-nav__item-link:hover {
    color:#000;
    text-shadow: 0 1px 0 #fff;
    background-color:#ccc;
    border: 1px solid #ccc;
    transition: color ease-out .1s,background-color ease-out .1s, border ease-out .1s;
}

.page-nav__item-link, .page-nav__item-link:visited {
    color: white;
}

.page-nav__item-link:hover {
    color:#000;
}

.navigation-shortcut__link {
    border: 2px solid rgba(255, 255, 255, 0.2);
    color:#fff;
}

.navigation-shortcut__link:hover {
    border-color: rgba(255,255,255,0.4);
}

.search-button {
    border-color:rgb(17, 17, 17);
    transition: border-color ease-out .15s;
}

.search-button:hover {
    border-color:rgba(255,255,255,0.2);
    transition: border-color ease-in .15s;
}

.search-button__icon {
    flex: 0 0 auto;
    font-size: 16px;
    padding: 0 1px 0 0;
}

.footer {
    background-image: url(https://raw.githubusercontent.com/misabiko/Wanikani-Grayish-Blueish-Dark/master/Assets/footer-bg-invert.gif) !important;
    background-position: top !important;
}

/* Page: Radicals */

.subject-pager__item-link, .subject-pager__item-link:visited {
    color:#ccc;
    text-shadow: 0 1px 0 #000;
}

.subject-section__title {
    text-shadow: 0 1px 0 #000;
}

.user-synonyms__button, .user-synonyms__button:visited, .user-synonyms__button:focus {
    color:#fff;
    background-color:#333;
    text-shadow: 0 2px 0 #000;
}

.user-synonyms__button:hover {
    color: #ccc;
}

.user-synonyms__form-input {
    color:#fff;
    background-color:#111;
    border: 1px solid #333;
}

.subject-section__subtitle {
    text-shadow: 0 1px 0 #000;
}

.subject-section__text {
    text-shadow: 0 1px 0 #000;
}
    
.subject-progress {
    text-shadow: 0 1px 0 #000;
}
    
.subject-progress__button {
    color:#fff;
    border: 1px solid #444;
    background-image: linear-gradient(to bottom, #333, #111);
    box-shadow: inset 0 1px 0 rgba(0, 0, 0, 0.2),0 1px 2px rgba(0, 0, 0, 0.05);
}
    
.subject-progress__button:hover {
    color:#fff;
    text-shadow: 0 1px 0 #000;
    background-image: linear-gradient(to bottom, #444, #222);
}

.subject-progress__button:focus {
    color:#fff;
    text-shadow: 0 1px 0 #000;
}


.subject-progress__streak-value {
    color:#fff;
    text-shadow: 0 1px 0 #000;
    background-color:#555;
}

.user-note__input {
    color:#fff;
    text-shadow: 0 1px 0 #000;
    background-color:#333;
}

.user-note__footer {
    background-color:#333;
}
    
.user-note__button, .user-note__button:visited, .user-note__button:active, .user-note__button:focus {
    color:#fff;
    text-shadow: 0 1px 0 #000;
}

.user-note__button:hover {
    color:#ccc;
}

.user-note__character-count-text {
    color:#aaa;
    text-shadow: 0 1px 0 #000;
}
    
.fa-pencil-alt::before, .fa-pencil::before {
    color:#aaa;
    text-shadow: 0 1px 0 #000;
}
    
.user-note__link, .user-note__link:visited {
    color:#999 !important;
}

.user-note__link:hover {
    color:#777 !important;
}

.subject-pager__item-link:hover {
    color: #888;
}

fieldset.user-note__fields {
    background-color:#444;
}

.user-synonyms__form-input:focus {
    border-color:rgba(255,255,255,0.8);
    box-shadow:0 0 8px rgba(255,255,255,0.6)
}

.user-synonym, .user-synonym:visited {
    color:#fff;
    text-shadow: 0 2px 0 #000;
    background-color:#0000;
}

.user-synonym:hover, .user-synonym:focus {
    color:#fff;  
}

.user-synonym__delete-icon {
    color:#fff;
    text-shadow: 0 2px 0 #000;
    background-color:#444;
}

.user-synonym__delete-icon:hover { 
    color:#dc2626
}
    
.alert-info {
    color: #fff;
    text-shadow: 0 1px 0 #000;
    background-color: #ffffff17;
}

.alert-close {
    color:#fff;
    text-shadow: 0 1px 0 #000;
}

.alert-close:hover {
    color:#666;
}

.alert-close:focus {
    color:#666;
}

.search__query {
    color:#fff;
    background-color:#111;
}

.search__button {
    background-color:#333;
    box-shadow: 1px 1px 1px rgba(0,0,0,0.7)
}

.search__button:hover {
    background-color:#444;
    box-shadow: 1px 1px 1px rgba(0,0,0,0.7);
    cursor:pointer;
}

.search__button:focus {
    box-shadow:none;
}

/* Page: Kanji */

.component-character__meaning {
    color:#fff;
    text-shadow: 0 1px 0 #000;
}

.subject-hint {
    color:#fff;
    background-color:#333;
}

.subject-hint__title {
    color:#ddd;
    text-shadow: 0 1px 0 #000;
}

.components-list__item::after {
    text-shadow: 0 1px 0 #000;
}

.subject-readings__reading-title {
    text-shadow: 0 1px 0 #000;
}

.turbo-progress-bar {
    background:#fff;
}

/* Page: Vocabulary */

.subject-readings-with-audio {
    text-shadow: 0 1px 0 #000;
}

.subject-collocations__title {
    text-shadow: 0 1px 0 #000;
}

.subject-collocations__pattern-name {
    color:#fff;
    text-shadow: 0 1px 0 #000;
    background-color:#222;
    
}

.subject-collocations__pattern-name:hover {
    background-color: #333;
    text-shadow: 0 1px 0 #000;
}

.subject-collocations__pattern-name[aria-selected="true"] {
    color:#fff;
    text-shadow: 0 1px 0#000;
    background-color:#444;
}

.subject-collocations__pattern-name[aria-selected="true"]::after {
    background-color:#444;
}

/* Page: Contact Us */

input#subject, textarea#body, input[type="text"], input[type="password"], input[type="datetime"], input[type="datetime-local"], input[type="date"], input[type="month"], input[type="time"], input[type="week"], input[type="number"], input[type="email"], input[type="url"], input[type="search"], input[type="tel"], input[type="color"], .uneditable-input {
    color:#fff;
    text-shadow: 0 1px 0 #000;
    background-color: #111;
    border: 1px solid #ccc;
}

input#subject:focus, textarea#body:focus, input[type="text"]:focus, input[type="password"]:focus, input[type="datetime"]:focus, input[type="datetime-local"]:focus, input[type="date"]:focus, input[type="month"]:focus, input[type="time"]:focus, input[type="week"]:focus, input[type="number"]:focus, input[type="email"]:focus, input[type="url"]:focus, input[type="search"]:focus, input[type="tel"]:focus, input[type="color"]:focus, .uneditable-input:focus, textarea#user_about:focus {
    border-color:rgba(255, 255, 255, .8);
    box-shadow:0 0 8px rgba(255,255,255,0.6)
}

input#attachment {
    color-scheme: dark;
}

.btn {
    color:#fff;
    text-shadow: 0 1px 0 #000;
    background:#333;
    border-color:#2A2A2A;
    box-shadow: inset 0 1px 0 rgb(68, 68, 68), 0 1px 2px rgb(42, 42, 42);
}

.btn:hover {
    color:#000;
    text-shadow: 0 1px 0 #fff;
    background:#ccc;
    border-color:#d4d4d4;
    box-shadow: inset 0 0px 0 rgb(153, 153, 153), 0 1px 2px rgb(204, 204, 204);
}

.btn:focus {
    color:#000;
    text-shadow: 0 1px 0 #fff;
    background:#ccc;
    border-color:#d4d4d4;
    box-shadow:none;
}

.alert, .error {
    color: #fff;
    text-shadow: 0 1px 0 #000;
    background-color: #ffffff17;
    border:none;
}

::selection {
    background:#666
}

/* Page: Profile */

html#public-profile div.wall-of-shame {
    background-color:#2220;
}

html#public-profile div.wall-of-shame ul li > span:first-child {
    color:#fff;
    text-shadow: 0 1px 0 #000;
}

div.chart {
    color:#fff;
    text-shadow: 0 1px 0 #000;
}

html#public-profile div.wall-of-shame .progress {
    background-color:#2A2A2A;
    background-image:none;
}

.progress {
    background-color:#2A2A2A;
}

html#public-profile div.wall-of-shame h3 span {
    color:#fff;
    text-shadow: 0 1px 0 #000;
    background-color:#333;
    box-shadow: inset 0 5px 5px rgba(0,0,0,0.0),0 1px 0 rgba(42,42,42,1);
}

html#public-profile footer {
    background-image: url("https://raw.githubusercontent.com/misabiko/Wanikani-Grayish-Blueish-Dark/master/Assets/footer-bg-invert.gif") !important;
    background-position: top !important;
}

html#public-profile .public-profile-header div.user-info {
    background-image: linear-gradient(to bottom, #222, #111);
    box-shadow: inset 0 15px 15px -15px rgba(0,0,0,0.9),inset 0 -15px 15px -15px rgba(0,0,0,0.9);
}

html#public-profile .public-profile-header div.user-info div[class*="span"] {
    text-shadow: 0 1px 0 #000;
}

html#public-profile .public-profile-header div.user-info h3.small-caps {
    color:#999;
    text-shadow: 0 1px 0 #000;
}

/* Page: Settings - App */

.page-list ul {
    background-color:#222;
    padding-top: 4px;
}

.page-list ul > li > a, .page-list ul > li > span {
    color:#fff;
    text-shadow: 0 1px 0 #000;
    background-color:#333;
    border-color:#222;
}

.page-list ul > li > a:hover {
    color:#000;
    text-shadow: 0 1px 0 #fff;
    background-color:#ccc;
    border-color: #ccc;
    transition: color ease-out .1s,background-color ease-out .1s, border ease-out .1s;
}

.page-list ul > li.active a {
    color:#fff;
    text-shadow: 0 1px 0 #000;
    background-color:#555;
}

.page-list ul > li.active a:hover {
    color:#000;
    text-shadow: 0 1px 0 #fff;
    background-color:#ccc;
    border-color:#ccc;
    transition: color ease-out .1s,background-color ease-out .1s, border ease-out .1s;
}

.settings-section {
    background-color:#333;
    box-shadow: inset 0 -1px 1px #2a2a2a;
}

form label {
    color:#fff;
    text-shadow: 0 1px 0 #000;
}

aside {
    color:#fff;
    text-shadow: 0 1px 0 #000;
}

.account-settings form.form-auto-submit-on-select-change select {
    color:#fff;
    background-color: #1A1A1A;
    border-color:#555;
}

/* Page: Terms */

.short-version {
    background-color:#333;
}

/* Page: Settings - Account */

/* Page: Settings - API */

.wk-modal__window {
    color:#fff;
    background-color:#2A2A2A;
}

h2 {
    color:#fff;
    text-shadow: 0 1px 0 #000;
}

code {
    background-color:#111;
    border: 1px solid #555;
}

.wk-modal__close {
    color:#ccc;
    text-shadow: 0 1px 0 #000;
}

.wk-modal__close:hover {
    color:#888;
}

.personal-access-token-permission__description {
    color:#fff;
    text-shadow: 0 1px 0 #000;
}

.personal-access-token-permissions__namespace-header {
    color:#fff;
    text-shadow: 0 1px 0 #000;
}

.personal-access-token-permission__label {
    color:#fff;
    text-shadow: 0 1px 0 #000;    
}

/* Page: Settings - Profile */

textarea#user_about {
    color:#fff;
    text-shadow: 0 1px 0 #000;
    background-color:#111;
    border: 1px solid #ccc;
}

/* Page: Settings - Danger Zone */

select#user_reset_target_level {
    color:#fff;
    background-color:#1A1A1A;
    border-color:#555;
}

button.btn.btn-danger {
    background-color:#bd362f;
}

button.btn.btn-danger:hover {
    color:#fff;
    text-shadow: 0 1px 0 #000;
    box-shadow:none;
}

button.btn.btn-danger:focus {
    color:#fff;
    text-shadow: 0 1px 0 #000;
}


/* Page: Subscription */

.bg-gray-100 {
    background-color:#333;
}

a.border-solid {
    color:#fff;
    background-color:#4a4a4a;
    border-color:#888
}

a.border-solid:hover {
    color:#fff;
    background-color:#5a5a5a;
    border-color:#999
}

button.border-solid {
    color:#fff;
    background-color:#4a4a4a;
    border-color:#888
}

button.border-solid:hover {
    color:#fff;
    background-color:#5a5a5a;
    border-color:#999;
}

dt.box-border {
    color:#fff;
    
}

dd.box-border {
    color:#fff;
}

/* Page: Sign In */

#explanation .bg-angled {
    background-color:#222;
}

#explanation h2 {
    color:#888;
}

button.button {
    color:#ccc;
    border-color:#ccc;
}

button.button:hover {
    color:#fff;
    border-color:#fff;
}

/* Page: Reviews */

.additional-content__item {
    color: #ccc;
    background-color: #2a2a2a;
    box-shadow: 2px 2px 4px #161616;
    border: 1px solid #0000;
}

.additional-content__item--disabled {
    background-color: #222;
    box-shadow: 3px 3px 0 #161616;
    color: #ccc;
}

.quiz-input__input {
    box-shadow: 3px 3px 0 #161616;
}

input#user-response.quiz-input__input {
    color:#ccc;
    background-color:#2A2A2A;
    border:none;
}

input#user-response.quiz-input__input:focus {
    color:#fff;
    box-shadow: 3px 3px 0 #161616;
}

.quiz-input__input-container[correct="true"] .quiz-input__input {
    background-color:#78b000 !important;
    color:#fff !important;
    text-shadow: 1px 1px 0 #000000bf !important;
    caret-color: #78b000 !important;
    box-shadow:  3px 3px 0 #4d7300;
}

.quiz-input__input-container[correct="true"] .quiz-input__input:focus {
    box-shadow: 3px 3px 0 #4d7300 !important;
}

.quiz-input__input-container[correct="false"] .quiz-input__input {
    background-color:#d0002a !important;
    color: #fff !important;
    text-shadow: 1px 1px 0 #000000bf !important;
    caret-color:#d0002a !important;
    box-shadow:  3px 3px 0 #a20021;
}

.quiz-input__input-container[correct="false"] .quiz-input__input:focus {
    box-shadow:  3px 3px 0 #a20021 !important;
}

div.answer-exception {
    color:#fff;
    text-shadow: 0 1px 0 #000;
    background-color:#444;
    box-shadow: 3px 3px 0 #333;
}

.answer-exception::before {
    border-color: transparent transparent #444 transparent;
}

:root {
    --color-quiz-srs-correct-background: #8c0;
    --color-quiz-srs-incorrect-background: #f00;
    color-scheme: dark;
}

.quiz-input__exception {
    color:#fff;
    text-shadow: 0 1px 0 #000;
    background-color:#444;
    box-shadow: 3px 3px 0 #333;
}

.quiz-input__exception::before {
    border-color: transparent transparent #444 transparent;
}
    
.quiz-input__question-type-container[data-question-type="reading"] {
    background-image: linear-gradient(#333, #111);
    border-top: 1px solid #555;
    border-bottom: 1px solid #000;
    color: #fff;
    text-shadow: 0 1px 0 #000;
}    
    
.quiz-input__question-type-container[data-question-type="meaning"] {
  background-image: linear-gradient(#EAEAEA, #BBB);
  border-top: 1px solid #d5d5d5;
  border-bottom: 1px solid #c8c8c8;
  color: #444;
  text-shadow: 0 1px 0 #fff;
}    

turbo-frame#subject-info.subject-info {
    background-color:#2a2a2a;
}

.additional-content__content {
    border: 2px solid #333;
    box-shadow: 2px 2px 4px #222;
}

turbo-frame#last-items.last-items {
    background-color:#2a2a2a;
}

.subject-info[busy]:after {
    background-color:#2a2a2a;  
    background-image:url(https://assets.wanikani.com/assets/v03/loading-100x100-08cd6590501550b2812b26b2dd9166d8fd3628b7546d34e50c49d2e96483943c.gif);
}

.last-item {
    text-shadow: 0 1px 0 #000;
    background-color:#3a3a3a;
    box-shadow: 2px 2px 4px #222;
}

.last-item__value {
    color:#fff;
}

.last-item:hover {
    background-color:#4a4a4a;
}
.subject-info .subject-collocations__pattern-name[aria-selected="true"]::after {
    background-color: #808080;
    background-image: none;
}

.additional-content__item--open:after {
    border-color:transparent transparent #333 transparent
}

.kana-chart {
    background-color: #2a2a2a;
}

.kana-chart__tab {
    text-shadow: 0 1px 0 #000;
}

.kana-chart__character {
    text-shadow: 0 1px 0 #000;
    background-color:#3a3a3a;
}

.kana-chart__character:hover {
    background-color:#555;
}    

.kana-chart__tab--selected {
    border-color: #777 #777 transparent #777;
}

.kana-chart__tab:not(.kana-chart__tab--selected) {
    border-bottom-color: #777;
    color:#aaa
}

.kana-chart__tab:not(.kana-chart__tab--selected):hover {
    color: #fff;
}

.kana-chart__backspace {
    color:#fff;
    background-color:#3a3a3a;
}

.kana-chart__backspace:hover {
    background-color:#555;
}
.kana-chart__backspace-text {
    text-shadow: 0 1px 0 #000;
}

.last-items[busy] {
    background-color:#2a2a2a;
    min-height:80px
}

.last-items[busy]:after {
    position:absolute;
    top:0;
    left:0;
    width:100%;
    height:100%;
    content:" ";
    background-color:#2a2a2a;
    background-image:url(https://assets.wanikani.com/assets/v03/loading-100x100-08cd6590501550b2812b26b2dd9166d8fd3628b7546d34e50c49d2e96483943c.gif);
    background-repeat:no-repeat;
    background-size:75px auto;
    background-position:50% 50%;
    z-index:1000
}   

.character-header__content {
    height: 250px;
}

.quiz-input__question-type-container {
    font-size: 25px;
    padding-top: 15px;
    padding-bottom: 15px;
}

/* Page: Lessons */

.subject-slide__content {
    background-color:#2a2a2a;
}

.subject-slide__navigation, .subject-slide__navigation:visited {
    background-color:#2a2a2a;
}

.subject-slide__navigation:hover {
    color:#fff;
}

.subject-slide__navigation:hover .subject-slide__navigation-icon {
    background-color:#333;
}

.subject-character__meaning {
    color:#fff;
    text-shadow: 0 1px 0 #000;
}

.subject-slide {
    background-color: #2a2a2a;
    box-shadow: 2px 2px 4px #222;
    border: 2px solid #333;
}

.wk-button--quiz {
    color:#fff !important;
    background-color:#8c0 !important;
}

.subject-slides__navigation {
    text-shadow: 0 1px 0 #000;
    background-color:#222;
}

.subject-character--tiny .subject-character__characters {
    box-shadow: 0 -1px 0 rgba(0,0,0,0.2) inset,0 0 10px rgba(255, 255, 255, 0.25);
}

.wk-button--tiny {
    box-shadow: 0 -1px 0 rgba(0,0,0,0.2) inset,0 0 10px rgba(255, 255, 255, 0.25);
}

.subject-slides__navigation-link[aria-selected=true]:after {
    border-color:transparent transparent #333 transparent;
}

.hotkeys-menu__header, .chat-button {
    color:#ccc;
    text-shadow: 0 1px 0 #000;
    background-color:#333;
    border-radius: 0 0 0 0;
    border-color:#333;
}

.hotkeys-menu__header:hover, .chat-button:hover {
    color:#fff;
}

.wk-button--modal-primary, .wk-button--modal-secondary, .wk-button {
    color:#fff;
    text-shadow: 0 1px 0 #000;
    background-color:#333;
    border-color:#444;
}

.wk-button--modal-primary:hover, .wk-button--modal-secondary:hover, .wk-button:hover {
    color:#fff;
    text-shadow: 0 1px 0 #000;
    background-color:#444;
    border-color:#555
}

.hotkeys-menu__header {
    background-color:#333;
}

.hotkeys-menu--open .hotkeys-menu__header-text {
    color:#fff;
}

.hotkeys-menu--open {
    color:#fff;
}

.hotkeys-menu--open .hotkeys-menu__header {
    color:#fff;
}

.hotkeys-menu--open .hotkeys-menu__content {
    color:#fff;
    text-shadow: 0 1px 0 #000;
    background-color:#333;
}

.wk-button--modal-primary:focus, .wk-button--modal-secondary:focus, .wk-button:focus {
    outline:solid 2px #ccc;
    outline-offset:2px
}

.wk-hint {
    color:#fff;
    text-shadow: 0 1px 0 #000;
    background-color:#333;
}

.wk-hint__title {
    color: #ddd;
    text-shadow: 0 1px 0 #000;
}

.hotkeys-menu {
    background-color:#333;
}

.user-synonyms__form_container {
    background-color:#222;
}

.user-synonyms__synonym-button {
    color:#fff;
    text-shadow: 0 1px 0 #000;
    background-color:#333;
    
}

.user-synonyms__synonym-button:hover {
    background-color:#3a3a3a;
}

.user-synonyms__synonym-button:focus {
    outline:solid 2px #ccc;
    outline-offset:2px;   
}

.wk-button--default:hover {
    cursor:pointer;
}

/* Extra study change (update 1.0.6)*/

.dashboard-panel {
    background-color:#333;
}

.extra-study__content {
    background-color:#444;
}

.dashboard-panel__title {
    text-shadow: 0 1px 0 #000;
}

.extra-study__image {
    filter: invert(73.5%);
}

.extra-study__intro {
    text-shadow: 0 1px 0 #000;
}

.extra-study-button__link {
    color:#fff;
    text-shadow: 0 1px 0 #000;
}

.extra-study-button__link:hover {
    color:#999;
}

.extra-study-button__tooltip-button {
    color:#fff;
    border: 1px solid #999;
}

.extra-study-button {
    border: 1px solid #fff;
}

/* Dashboard Panel quick changes (update 1.0.7) */

.level-progress-bar {
    background-color:#2a2a2a;
}

.level-progress-dashboard__content {
    background-color:#444;
}

.subject-character--small .subject-character__characters {
    box-shadow: 0 -3px 0 rgba(0,0,0,0.2) inset,0 0 10px rgba(255,255,255,0.0);
}

/* Recent mistakes update quick changes (update 1.0.8) */

.recent-mistakes-dashboard__content {
    background-color:#444;
}

.recent-mistakes-dashboard__empty-image {
    filter: invert(73.5%);
}

/* Dashboard Panel changes (again) (update 1.1.0) */

.extra-study {
    background-color: #444;
}

.review-forecast__day {
    background-color: #444;
}

.dashboard-panel__content [busy]::after {
    background-color:#333;
}

.review-forecast__day-header:not([aria-controls]) .review-forecast__expanded-icon {
    color: #888;
}

.review-forecast {
    padding: 0 5px 0 0;
}
    
/* Dashboard panel fixes + other 25/10/23 (update 1.1.1) */
    
.wk-panel {
    background-color:#333;
}
    
.wk-panel__content [busy]::after {
    background-color:#333;
}

.dashboard .progress-and-forecast .wk-panel--level-progress {
    border-radius:5px;
    box-shadow: 0 1px 0 #2a2a2a;
}    
    
.dashboard .progress-and-forecast .wk-panel--review-forecast {
    border-radius:5px;
    box-shadow: 0 1px 0 #2a2a2a;
}
    
.dashboard .progress-and-forecast .wk-panel--extra-study {
    border-radius:5px;
    box-shadow: 0 1px 0 #2a2a2a;
}
    
.dashboard .progress-and-forecast .wk-panel--recent-mistakes {
    border-radius:5px;
    box-shadow: 0 1px 0 #2a2a2a;
}
    
.wk-nav__item-link {
    color:#fff;
    text-shadow: 0 1px 0 #000;
    background-color: #333;
    border: 1px solid #333;
}    
    
.wk-nav__item-link:hover {
    color:#000;
    text-shadow: 0 1px 0 #fff;
    background-color:#ccc;
    border: 1px solid #ccc;
    transition: color ease-out .1s,background-color ease-out .1s, border ease-out .1s;
}
   
.wk-nav__item-link:visited {   
    color:#fff;
    text-shadow: 0 1px 0 #000;
}  
   
.wk-nav__item-link:hover {
    color:#000;
}
   
.wk-title--small {
    text-shadow: 0 1px 0 #000;
}
   
.wk-nav {
    text-shadow: 0 1px 0 #000;
    color: #fff;
}

/* Fixing forecast turbo frame 21/12/2023 (update 1.1.2) */

turbo-frame[data-show-loading="true"][busy]::after {
    color:#333;
    background-color:#333;
}

/* Forecast image thingy 30/12/2023 (update 1.1.3) */
.review-forecast__empty-content {
    filter: invert(73.5%);
}

/* UI changes and lesson/review buttons (update 1.1.4) */

.lesson-and-review-count__item:hover .lesson-and-review-count__label {
    border-color: rgba(0, 0, 0, 0.2);
    color: #fff;
    text-shadow: 0 1px 0 #000;
    border: 2px solid #555;
}

.lesson-and-review-count__label {
    color:#fff;
    text-shadow: 0 1px 0 #000;
    border: 2px solid #414141;
}

.lesson-and-reviews-loading {
    background-color:#333;
}

.lesson-and-reviews-loading__placeholder {
    background-color:#444;
}

.lesson-picker__section-content {
    background-color: #444;
}

:root{
    --color-placeholder-background-stop-1:#222;
    --color-placeholder-background-stop-2:#3a3a3a;
    --color-lesson-picker-footer-background:rgba(0,0,0,0.25);
    --border-radius-normal: 6px;
    --color-lesson-picker-footer-border: 1px solid #555;
    --color-text: #fff;
    --color-text-shadow-light:#000;
    --color-mnemonic-image-background:rgba(255, 255, 255, .15);
    --color-button-background: #333;
    --color-button-secondary-background: #333;
    --color-item-spread-row-background:#333;
    --color-item-spread-row-background:hover:#444;
}

    :root:hover {
    --color-button-secondary-background: #444;
}

.lesson-picker__button[aria-disabled="true"]:hover {
    background-color: #555;
    border-color:#555;
}

.lesson-picker__button[aria-disabled="true"] {
    border-color:#666;
    background-color:#666;
    color:#fff;
    text-shadow: 0 1px 0 var(--color-text-shadow-dark);
    box-shadow:0px -3px 0px 0px #00000033 inset;
    --color-count_bubble-text:#666;
}

.lesson-picker__button[aria-disabled="true"]:focus {
    outline:solid 2px #ccc;
    outline-offset:2px
}

.wk-form__select {
    color:#fff;
    border: 2px solid #555;
    background-color:#1a1a1a;
}

.wk-title--medium {
    text-shadow: 0 1px 0 #000;
}

.lesson-picker__section-toggle {
    color:#fff;
    text-shadow: 0 1px 0 #000;
}

.lesson-picker__section-toggle:hover {
    color:#fff;
    text-shadow: 0 1px 0 #000;
    text-decoration: underline;
    text-decoration-color: #fff;
}

.lesson-picker__section-toggle-all {
    color:#ccc;
    text-shadow: 0 1px 0 #000;    
}

.lesson-picker__section-toggle-all:hover {
    color:#fff;
    text-shadow: 0 1px 0 #000;
    text-decoration: underline;
    text-decoration-color: #fff;    
}

svg {
    fill:#fff;
}

/* Update 1.1.6, small things */

.wk-nav__header {
    color: #fff;
    text-shadow: 0 1px 0 #000;
}

.lu-title {
  font-size: 54px;
  font-weight: 600;
  text-shadow: 0 1px 0 #f00;
}

.srs-progress__subject-type {
    background:#0000004a;
}

.srs-progress__subject-type-title {
    color:#fff;
}

.srs-progress__stage--apprentice {
    color:#fff;
}

.srs-progress__stage--guru {
    color:#fff;
}

.srs-progress__stage--master {
    color:#fff;
}

.srs-progress__stage--enlightened {
    color:#fff;
}

.srs-progress__stage--burned {
    color:#fff;
}

/* Update 1.1.7 */

.wk-alert--info {
    background:#333;
    color:#fff;
    text-shadow: 0 1px 0 #000;
    border: 2px solid #444;
    
}

.wk-icon {
    fill:#fff;
}

turbo-frame[data-show-loading=true]:not([complete]):after {
  background-color:#333;
  background-color:rgba(51,51,51,.9);
}

.progress-chart__progress-bar-container {
    background-color:#2a2a2a;
}

.community-banner__cta {
    text-decoration:none;
}

.subject-info:not([complete]){
    background-color:#333;
}

.subject-info{
    background-color:#333;
}

.subject-info:not([complete])::after {
    background-color:#333;
}

.last-items:not([complete]){
    background-color:#333;
}

.last-items:not([complete])::after {
    background-color:#333;
}

/* Update 1.1.8 */

.level-progress-bar__label {
    color:#eee;
    text-shadow: 0 1px 0 #000;
}

.subject-list--with-separator .subject-list__item::after {
    color:#fff;
}
    
/* Update 1.1.9 (Major Dashboard Updates) */
    
.level-up-alert, .study-streak-widget, .reviews-completed-widget, .review-forecast-widget, .level-progress-widget, .item-spread-table-widget, .item-spread-graph-widget, .heat-map-widget, .extra-study-subjects-widget, .extra-study-single-button-widget, .extra-study-multi-button-widget, .extra-study-flash-card-widget, .error-widget, .days-studied-widget, .correct-percentage-widget, .community-banner-widget {
    background-color:#333;
    color:#fff;
    border: 0px solid;
    box-shadow: 0 1px 0 #2A2A2A;
}

    /* 1.2.0 */
.wk-button--secondary, .wk-button__content {
  background-color: #444;
}

.wk-button--secondary:hover {
    background-color:#555;
}
    
    
.extra-study-multi-button-widget__button, .extra-study-multi-button-widget__button:visited {
    color:#fff;
    text-shadow: 0 1px 0 #000;
    background: #333;
    }
    
.extra-study-multi-button-widget__button:hover {
        background: #444;
    }
    
.wk-button__text {
    color:#fff;
    }

.level-progress-widget__item-type-stat:hover {
    background-color:#444;
    }
    
.todays-lessons-widget.theme--neon:not(.todays-lessons-widget--complete) {
    --color-placeholder-pulse-stop-1: #ffffff00;
    --color-placeholder-pulse-stop-2: #ffffff00;
    }
    
.count-bubble {
    text-shadow: 0 1px 0 #000000;
    color: #ffffff;
    background-color:#333;
}

.item-spread-table-row__total {
    text-shadow: 0 1px 0 #000;
    color: #fff;
    background-color:#666;
}

.character-grid__header-content {
    background-color: #333;
    }
    
.character-grid__header-title {
    text-shadow:0 1px 0 #000;
    color: #ffffff;
}
    
.subject-character {
    background-color: #333;
}
    
.wk-button--primary:hover .wk-button__content {
    background-color:#444;
    }
    
.extra-study-multi-button-widget__intro {
    color:#999;
}

.extra-study-subjects-widget__intro {
    color: #999;
}
    
.extra-study-subjects-widget:not(.extra-study-subjects-widget--split) .extra-study-subjects-widget__empty-message {
    color:#999;
}
    
.community-banner-widget__text {
    color:#999;
}
    
.page-header__title-text {
    color:#eee;
}
    
.lesson-and-review-count__count {
    background-color: var(--color-purple);
    border: solid var(--color-purple);
}
   
.subject-character__content {
    background-color:#00000057;
}
    
.vocabulary-highlight {
    color: #ffffff;
    background-color: #aa00ff;
}

.kanji-highlight {
    color: #ffffff;
    background-color: #ff00aa;
}

.radical-highlight {
    color: #ffffff;
    background-color: #00aaff;
}

.reading-highlight {
    color: #ffffff;
    background-color: #777;
}

.subject-character--kanji .subject-character__characters-text {
    text-shadow: none;
}
    
.subject-character--vocabulary .subject-character__characters-text {
    text-shadow:none;
}
    
.subject-character--radical .subject-character__characters-text {
    text-shadow:none;
}
    
.wk-form__text-area {
    background-color:#222;
}
    
.wk-form__text-area:focus {
    border-color:#bbb;
    }

.subject-character--grid.subject-character--kanji .subject-character__meaning, .subject-character--grid.subject-character--vocabulary .subject-character__meaning {
    color: #ddd;
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

  // Theme first so applyTheme reads the dark background, then the panel.
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
