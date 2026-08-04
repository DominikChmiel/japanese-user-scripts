// ==UserScript==
// @name         Bunpro Mistake Recap
// @namespace    https://github.com/dominikchmiel/review-recap
// @version      1.0.0
// @description  Records only your wrong answers during a Bunpro review and shows an end-of-session overview you can copy straight into an LLM to have each mistake explained.
// @author       Dominik Chmiel
// @match        https://bunpro.jp/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

/*
 * How this hooks into Bunpro
 * --------------------------
 * Bunpro's quiz mirrors its entire state onto a single element:
 *
 *   <div id="quiz-metadata-element"
 *        data-meta-loc="review"
 *        data-meta-input="..."                     <- what you typed
 *        data-meta-is-correct="false"
 *        data-meta-is-post-attempt="false"         <- flips true once judged
 *        data-meta-total-submissions-count="0"
 *        data-meta-correct-submissions-count="0"
 *        data-meta-info='{"id":1110,"type":"grammar_point"}'
 *        data-meta-answers-array='["きびしくはある"]' />
 *
 * A MutationObserver on those attributes gives us every judged attempt. We only
 * keep the wrong ones. The sentence / translation / grammar label are read out
 * of the DOM at that moment, because they are not in the metadata element.
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------- config --

  const META_ID = 'quiz-metadata-element';
  const STORAGE_KEY = 'bunpro-mistake-recap:v1';
  const EXPIRY_MS = 24 * 60 * 60 * 1000;

  const LLM_PREAMBLE = [
    "I'm studying Japanese grammar on Bunpro. Below are the questions I got wrong in my last review session.",
    '',
    'For each mistake, please explain:',
    '1. What my answer actually means, and why it is wrong here (grammar, conjugation, or nuance).',
    '2. How exactly it differs from the correct answer.',
    '3. In what context my answer *would* be correct, if any.',
    '',
    'Keep each explanation short and concrete.',
  ].join('\n');

  // ----------------------------------------------------------------- state --

  /**
   * store.mistakes[] = {
   *   grammarId, grammarType, grammarLabel,
   *   sentence,      // cloze sentence, furigana stripped, blank marked ____
   *   translation,   // English
   *   answers: [],   // accepted answers
   *   input,         // what you typed
   *   at             // timestamp
   * }
   */
  let store = { startedAt: Date.now(), mistakes: [] };
  let overviewOpen = false;
  let lastAttemptKey = '';
  let sawQuiz = false;

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.mistakes)) return;
      if (Date.now() - (parsed.startedAt || 0) > EXPIRY_MS) return;
      store = { startedAt: parsed.startedAt || Date.now(), mistakes: parsed.mistakes };
    } catch (e) {
      /* ignore unusable storage */
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch (e) {
      /* ignore */
    }
  }

  // ------------------------------------------------------------ dom reading --

  function meta() {
    return document.getElementById(META_ID);
  }

  function metaValue(node, name) {
    const value = node.getAttribute('data-meta-' + name);
    return value == null ? '' : value;
  }

  function metaJSON(node, name, fallback) {
    try {
      const raw = metaValue(node, name);
      if (!raw || raw === 'null') return fallback;
      return JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  /** textContent with furigana (<rt>/<rp>) removed, whitespace collapsed. */
  function plainJapanese(node) {
    if (!node) return '';
    const clone = node.cloneNode(true);
    clone.querySelectorAll('rt, rp').forEach((n) => n.remove());
    return clone.textContent.replace(/\s+/g, ' ').trim();
  }

  /**
   * The cloze sentence is a mix of text spans and a <button> standing in for the
   * blank. Replace that button with ____ so the sentence reads like a question.
   */
  function readSentence() {
    const question = document.querySelector('.bp-quiz-question');
    if (!question) return '';
    const clone = question.cloneNode(true);
    clone.querySelectorAll('rt, rp').forEach((n) => n.remove());
    clone.querySelectorAll('button').forEach((button) => {
      button.replaceWith(document.createTextNode('____'));
    });
    return clone.textContent.replace(/\s+/g, ' ').trim();
  }

  function readGrammarLabel() {
    return plainJapanese(document.querySelector('.bp-quiz-tense'));
  }

  function readTranslation() {
    const nodes = [...document.querySelectorAll('.bp-quiz-trans')];
    const main = nodes.find((n) => !n.className.includes('bp-quiz-trans--hint'));
    return plainJapanese(main).replace(/\*/g, '');
  }

  // ---------------------------------------------------------------- capture --

  function onMetaChanged() {
    const node = meta();
    if (!node) return;
    sawQuiz = true;

    // Only look at judged attempts.
    if (metaValue(node, 'is-post-attempt') !== 'true') {
      lastAttemptKey = '';
      return;
    }
    if (metaValue(node, 'is-correct') !== 'false') return; // correct -> ignore

    const input = metaValue(node, 'input').trim();
    const info = metaJSON(node, 'info', {}) || {};
    const answers = metaJSON(node, 'answers-array', []) || [];
    const sentence = readSentence();

    // The observer fires for many attribute writes per attempt - dedupe.
    const key = [info.id, input, sentence].join('|');
    if (!input || key === lastAttemptKey) return;
    lastAttemptKey = key;

    store.mistakes.push({
      grammarId: info.id == null ? null : info.id,
      grammarType: info.type || '',
      grammarLabel: readGrammarLabel(),
      sentence,
      translation: readTranslation(),
      answers: Array.isArray(answers) ? answers : [answers],
      input,
      at: Date.now(),
    });
    save();
    renderLauncher();
  }

  function grammarUrl(mistake) {
    return mistake.grammarId ? 'https://bunpro.jp/grammar_points/' + mistake.grammarId : null;
  }

  // ----------------------------------------------------------------- export --

  function llmPrompt() {
    const blocks = store.mistakes.map((mistake, index) => {
      const lines = [];
      const heading = ['### Mistake ' + (index + 1)];
      if (mistake.grammarLabel) heading.push('- ' + mistake.grammarLabel);
      lines.push(heading.join(' '));
      const url = grammarUrl(mistake);
      if (url) lines.push('Grammar point: ' + url);
      if (mistake.sentence) lines.push('Sentence: ' + mistake.sentence);
      if (mistake.translation) lines.push('English: ' + mistake.translation);
      lines.push('Correct answer(s): ' + mistake.answers.join(' / '));
      lines.push('My answer: ' + mistake.input);
      return lines.join('\n');
    });
    return LLM_PREAMBLE + '\n\n' + blocks.join('\n\n');
  }

  // -------------------------------------------------------------- rendering --

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

  function copyButton(label, getText, extraClass) {
    return el('button', {
      class: 'bpmr-btn ' + (extraClass || ''),
      text: label,
      onclick: (event) => {
        const button = event.currentTarget;
        const original = button.textContent;
        navigator.clipboard.writeText(getText()).then(
          () => {
            button.textContent = 'Copied!';
            setTimeout(() => {
              button.textContent = original;
            }, 1400);
          },
          () => {
            button.textContent = 'Copy failed';
            setTimeout(() => {
              button.textContent = original;
            }, 1400);
          }
        );
      },
    });
  }

  function mistakeCard(mistake, index) {
    const url = grammarUrl(mistake);
    return el(
      'li',
      { class: 'bpmr-card' },
      el(
        'div',
        { class: 'bpmr-card__head' },
        el('span', { class: 'bpmr-card__index', text: '#' + (index + 1) }),
        mistake.grammarLabel
          ? url
            ? el('a', {
                class: 'bpmr-card__grammar',
                href: url,
                target: '_blank',
                rel: 'noreferrer',
                text: mistake.grammarLabel,
              })
            : el('span', { class: 'bpmr-card__grammar', text: mistake.grammarLabel })
          : null
      ),
      mistake.sentence
        ? el('div', { class: 'bpmr-sentence', lang: 'ja', text: mistake.sentence })
        : null,
      mistake.translation
        ? el('div', { class: 'bpmr-translation', text: mistake.translation })
        : null,
      el(
        'div',
        { class: 'bpmr-answers' },
        el(
          'div',
          { class: 'bpmr-answer bpmr-answer--wrong' },
          el('span', { class: 'bpmr-answer__label', text: 'You' }),
          el('span', { class: 'bpmr-answer__value', lang: 'ja', text: mistake.input })
        ),
        el(
          'div',
          { class: 'bpmr-answer bpmr-answer--right' },
          el('span', { class: 'bpmr-answer__label', text: 'Correct' }),
          el('span', {
            class: 'bpmr-answer__value',
            lang: 'ja',
            text: mistake.answers.join(' / '),
          })
        )
      )
    );
  }

  function renderOverview() {
    const existing = document.getElementById('bpmr-overlay');
    if (existing) existing.remove();
    if (!overviewOpen) return;

    const close = () => {
      overviewOpen = false;
      renderOverview();
      renderLauncher();
    };

    const body = store.mistakes.length
      ? el('ul', { class: 'bpmr-list' }, store.mistakes.map(mistakeCard))
      : el(
          'div',
          { class: 'bpmr-empty' },
          el('div', { class: 'bpmr-empty__mark', text: '◎' }),
          el('div', { text: 'No mistakes recorded.' }),
          el('div', { class: 'bpmr-empty__sub', text: 'Everything you answered was correct.' })
        );

    const overlay = el(
      'div',
      {
        id: 'bpmr-overlay',
        onclick: (event) => {
          if (event.target.id === 'bpmr-overlay') close();
        },
      },
      el(
        'div',
        { class: 'bpmr-dialog', role: 'dialog', 'aria-modal': 'true' },
        el(
          'header',
          { class: 'bpmr-dialog__head' },
          el(
            'div',
            null,
            el('h2', { class: 'bpmr-dialog__title', text: 'Review mistakes' }),
            el('p', {
              class: 'bpmr-dialog__sub',
              text:
                store.mistakes.length +
                (store.mistakes.length === 1 ? ' wrong answer' : ' wrong answers') +
                ' recorded',
            })
          ),
          el('button', {
            class: 'bpmr-close',
            title: 'Close',
            text: '×',
            onclick: close,
          })
        ),
        el('div', { class: 'bpmr-dialog__body' }, body),
        el(
          'footer',
          { class: 'bpmr-dialog__foot' },
          store.mistakes.length
            ? copyButton('Copy LLM prompt', llmPrompt, 'bpmr-btn--primary')
            : null,
          el('span', { class: 'bpmr-foot__spacer' }),
          el('button', {
            class: 'bpmr-btn bpmr-btn--ghost',
            text: 'Clear',
            onclick: () => {
              store = { startedAt: Date.now(), mistakes: [] };
              save();
              renderOverview();
              renderLauncher();
            },
          })
        )
      )
    );

    document.body.append(overlay);
  }

  function renderLauncher() {
    const existing = document.getElementById('bpmr-launcher');
    if (existing) existing.remove();
    if (overviewOpen) return;

    const count = store.mistakes.length;
    if (!count) return;

    document.body.append(
      el(
        'button',
        {
          id: 'bpmr-launcher',
          title: 'Show the mistakes from this session',
          onclick: () => {
            overviewOpen = true;
            renderOverview();
            renderLauncher();
          },
        },
        el('span', { class: 'bpmr-launcher__count', text: String(count) }),
        el('span', { text: count === 1 ? 'mistake' : 'mistakes' })
      )
    );
  }

  // ------------------------------------------------------------------- css --

  const CSS = `
#bpmr-launcher {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
  display: flex; align-items: center; gap: 8px;
  padding: 9px 14px; border: 0; border-radius: 999px; cursor: pointer;
  background: #e4572e; color: #fff;
  font: 600 13px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
  box-shadow: 0 4px 14px rgba(0,0,0,.28);
}
#bpmr-launcher:hover { background: #cf4826; }
.bpmr-launcher__count {
  background: rgba(255,255,255,.26); border-radius: 999px;
  padding: 3px 7px; font-size: 12px;
}

#bpmr-overlay {
  position: fixed; inset: 0; z-index: 2147483001;
  background: rgba(15,15,20,.62);
  display: flex; align-items: center; justify-content: center; padding: 20px;
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
}
#bpmr-overlay *, #bpmr-overlay *::before, #bpmr-overlay *::after { box-sizing: border-box; }

.bpmr-dialog {
  background: #fff; color: #23262c;
  width: min(760px, 100%); max-height: 88vh;
  border-radius: 12px; overflow: hidden;
  display: flex; flex-direction: column;
  box-shadow: 0 18px 50px rgba(0,0,0,.4);
}
.bpmr-dialog__head {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
  padding: 16px 20px; border-bottom: 1px solid #e8e8ec;
}
.bpmr-dialog__title { margin: 0; font-size: 17px; font-weight: 700; }
.bpmr-dialog__sub { margin: 2px 0 0; font-size: 12px; color: #8a8f98; }
.bpmr-close {
  border: 0; background: none; cursor: pointer; color: #9aa0a8;
  font-size: 26px; line-height: 1; padding: 0 4px; border-radius: 6px;
}
.bpmr-close:hover { background: #f0f0f3; color: #23262c; }

.bpmr-dialog__body { overflow-y: auto; padding: 14px 20px; flex: 1; }
.bpmr-list { list-style: none; margin: 0; padding: 0; }

.bpmr-card {
  border: 1px solid #e8e8ec; border-radius: 9px;
  padding: 12px 14px; margin-bottom: 10px; background: #fcfcfd;
}
.bpmr-card__head { display: flex; align-items: center; gap: 8px; margin-bottom: 7px; }
.bpmr-card__index { color: #b0b4bb; font-size: 12px; font-weight: 700; }
.bpmr-card__grammar {
  color: #e4572e; font-size: 12px; font-weight: 700;
  text-decoration: none; border-bottom: 1px dotted currentColor;
}
.bpmr-sentence { font-size: 18px; line-height: 1.7; margin-bottom: 4px; }
.bpmr-translation { color: #8a8f98; font-size: 13px; margin-bottom: 10px; }

.bpmr-answers { display: grid; gap: 6px; }
.bpmr-answer { display: flex; align-items: baseline; gap: 10px; }
.bpmr-answer__label {
  flex: none; width: 58px; font-size: 11px; font-weight: 700;
  text-transform: uppercase; letter-spacing: .05em; text-align: right;
}
.bpmr-answer--wrong .bpmr-answer__label { color: #d0402a; }
.bpmr-answer--right .bpmr-answer__label { color: #1f9d55; }
.bpmr-answer__value { font-size: 16px; }
.bpmr-answer--wrong .bpmr-answer__value {
  color: #d0402a; text-decoration: line-through; text-decoration-color: rgba(208,64,42,.45);
}
.bpmr-answer--right .bpmr-answer__value { color: #1f7a45; font-weight: 600; }

.bpmr-dialog__foot {
  display: flex; align-items: center; gap: 8px;
  padding: 12px 20px; border-top: 1px solid #e8e8ec; background: #fafafb;
}
.bpmr-foot__spacer { flex: 1; }
.bpmr-btn {
  border: 1px solid #d8d8de; background: #fff; color: #23262c;
  border-radius: 7px; padding: 8px 14px; cursor: pointer;
  font: 600 13px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
}
.bpmr-btn:hover { background: #f4f4f6; }
.bpmr-btn--primary { background: #e4572e; border-color: #e4572e; color: #fff; }
.bpmr-btn--primary:hover { background: #cf4826; }
.bpmr-btn--ghost { border-color: transparent; background: none; color: #8a8f98; }
.bpmr-btn--ghost:hover { background: #f0f0f3; color: #23262c; }

.bpmr-empty { text-align: center; color: #9aa0a8; padding: 44px 16px; }
.bpmr-empty__mark { font-size: 30px; color: #d5d7dc; margin-bottom: 8px; }
.bpmr-empty__sub { font-size: 12px; margin-top: 4px; color: #b8bcc3; }

@media (prefers-color-scheme: dark) {
  .bpmr-dialog { background: #1c1e23; color: #e6e7ea; }
  .bpmr-dialog__head, .bpmr-dialog__foot { border-color: #2d3038; }
  .bpmr-dialog__foot { background: #191b1f; }
  .bpmr-card { background: #232630; border-color: #2d3038; }
  .bpmr-close:hover, .bpmr-btn--ghost:hover { background: #2d3038; color: #e6e7ea; }
  .bpmr-btn { background: #232630; border-color: #363a44; color: #e6e7ea; }
  .bpmr-btn:hover { background: #2d3038; }
  .bpmr-answer--right .bpmr-answer__value { color: #4ecb8b; }
  .bpmr-answer--wrong .bpmr-answer__value { color: #ff7d68; }
}
`;

  // ------------------------------------------------------------------ boot --

  function ensureStyle() {
    if (!document.getElementById('bpmr-style')) {
      document.head.append(el('style', { id: 'bpmr-style', text: CSS }));
    }
  }

  let observed = null;
  let observer = null;

  function attachObserver() {
    const node = meta();
    if (!node || node === observed) return;
    if (observer) observer.disconnect();
    observer = new MutationObserver(onMetaChanged);
    observer.observe(node, { attributes: true });
    observed = node;
    onMetaChanged();
  }

  /**
   * Bunpro is a SPA: the quiz element appears when a session starts and is gone
   * once it finishes. Losing it after we saw it means the session ended, which
   * is when the overview should pop up on its own.
   */
  function watchSession() {
    const node = meta();
    if (node) {
      attachObserver();
      return;
    }
    if (observed) {
      observed = null;
      if (observer) observer.disconnect();
      observer = null;
    }
    if (sawQuiz && store.mistakes.length && !overviewOpen) {
      sawQuiz = false;
      overviewOpen = true;
      renderOverview();
    }
    renderLauncher();
  }

  load();
  ensureStyle();
  renderLauncher();
  watchSession();
  setInterval(() => {
    ensureStyle();
    watchSession();
  }, 1000);

  // Expose a tiny handle for debugging / manual export from the console.
  window.bunproMistakeRecap = {
    get mistakes() {
      return store.mistakes.slice();
    },
    prompt: llmPrompt,
    open() {
      overviewOpen = true;
      renderOverview();
      renderLauncher();
    },
    clear() {
      store = { startedAt: Date.now(), mistakes: [] };
      save();
      renderOverview();
      renderLauncher();
    },
  };
})();
