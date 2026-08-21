/*
 * Hold Shift to reveal the meaning + reading of the item you are being asked
 * right now. The half currently being quizzed is highlighted. Built from
 * quiz.subject, so it works whether or not the item has been failed.
 */
import { el } from './dom';
import { TYPE_COLOR, TYPE_LABEL } from './config';
import { isReviewPage } from './session';
import { quiz } from './state';
import { meaningsOf, readingGroupsOf } from './subject';
import { wouldBurn } from './srs';

function buildPeek() {
  const record = quiz.subject;
  if (!record) return el('div');
  const color = TYPE_COLOR[record.type] || '#8a8a8a';
  // A study aid, not a cheat code: an item one correct answer away from
  // burning is the one place revealing it would do real damage.
  const blocked = wouldBurn(record);

  const image = record.image
    ? el('img', { class: 'wkrr-peek__image', src: record.image, alt: '' })
    : null;
  const characterNode: HTMLElement =
    image ?? el('span', { class: 'wkrr-peek__chars', lang: 'ja', text: record.characters || '?' });

  const head = el(
    'div',
    { class: 'wkrr-peek__head' },
    characterNode,
    el('span', { class: 'wkrr-peek__type', text: TYPE_LABEL[record.type] || record.type })
  );
  const hint = el('div', { class: 'wkrr-peek__hint', text: 'Release Shift to hide' });

  // Nothing of the answer is built in this branch - a burn is worth more than
  // the convenience, so it never reaches the DOM to be read out of.
  if (blocked) {
    return el(
      'div',
      { class: 'wkrr-peek__inner', style: '--wkrr-accent:' + color },
      head,
      el(
        'div',
        { class: 'wkrr-peek__blocked' },
        el('div', { class: 'wkrr-peek__blocked-title', text: 'Enlightened - about to burn' }),
        el('div', {
          class: 'wkrr-peek__blocked-text',
          text: 'Answer this one on your own. Miss either half and the peek comes back.',
        })
      ),
      hint
    );
  }

  const { primary, alternative } = meaningsOf(record);
  const groups = readingGroupsOf(record);
  if (image) image.alt = primary[0] || '';

  const rows = [];
  if (primary.length || alternative.length) {
    rows.push(
      el(
        'div',
        { class: 'wkrr-peek__row' + (quiz.questionType === 'meaning' ? ' is-asked' : '') },
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
        { class: 'wkrr-peek__row' + (quiz.questionType === 'reading' ? ' is-asked' : '') },
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
    head,
    el('div', { class: 'wkrr-peek__body' }, rows),
    hint
  );
}

export function showPeek() {
  if (!isReviewPage() || !quiz.subject) return;
  let peek = document.getElementById('wkrr-peek');
  if (!peek) {
    peek = el('div', { id: 'wkrr-peek' });
    document.body.append(peek);
  }
  peek.replaceChildren(buildPeek());
  peek.classList.add('is-visible');
}

export function hidePeek() {
  const peek = document.getElementById('wkrr-peek');
  if (peek) peek.classList.remove('is-visible');
}

export function onKeyDown(event: KeyboardEvent) {
  // Ignore auto-repeat while the key is held, and modifier combos (Shift+Tab,
  // capitalising a letter, ...) so only a bare Shift press reveals the answer.
  if (event.key !== 'Shift' || event.repeat) return;
  if (event.ctrlKey || event.altKey || event.metaKey) return;
  showPeek();
}

export function onKeyUp(event: KeyboardEvent) {
  if (event.key === 'Shift') hidePeek();
}
