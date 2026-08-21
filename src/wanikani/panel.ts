/*
 * The sidebar itself: one card per missed item, grouped into "still failed" and
 * "got it on a retry", plus the header, the filter tabs and the copy-as-text
 * export. Renders from ./state, so any handler that changes something calls
 * save() and then render() or scheduleRender().
 */
import { el } from './dom';
import { TYPE_COLOR, TYPE_LABEL } from './config';
import { clearStore, save, session } from './state';
import type { SectionKey } from './state';
import {
  failedTypes,
  meaningsOf,
  outstandingTypes,
  readingGroupsOf,
  subjectUrl,
} from './subject';
import type { ItemRecord, QuestionType } from './types';

let renderQueued = false;

/**
 * `types` selects which halves to render. Outstanding items show only the half
 * that is still wrong; the retry section shows everything you missed.
 */
function card(record: ItemRecord, types: QuestionType[]) {
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
  return Object.values(session.store.items).sort((a, b) => b.lastAt - a.lastAt);
}

function section(
  key: SectionKey,
  title: string,
  hint: string,
  records: ItemRecord[],
  typesFor: (record: ItemRecord) => QuestionType[]
) {
  if (!records.length) return null;
  const isCollapsed = !!session.sectionCollapsed[key];
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
          session.sectionCollapsed[key] = !session.sectionCollapsed[key];
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

export function render() {
  const panel = document.getElementById('wkrr-panel');
  if (!panel) return;

  document.documentElement.classList.toggle('wkrr-collapsed', session.collapsed);
  panel.replaceChildren();

  if (session.collapsed) {
    const total = Object.keys(session.store.items).length;
    panel.append(
      el(
        'button',
        {
          class: 'wkrr-reopen',
          title: 'Show review recap',
          onclick: () => {
            session.collapsed = false;
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
          session.collapsed = true;
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
        class: 'wkrr-tab' + (session.filter === 'all' ? ' is-active' : ''),
        text: 'All',
        onclick: () => {
          session.filter = 'all';
          save();
          render();
        },
      }),
      el('button', {
        class: 'wkrr-tab' + (session.filter === 'unresolved' ? ' is-active' : ''),
        text: 'Still failed',
        onclick: () => {
          session.filter = 'unresolved';
          save();
          render();
        },
      }),
      el('span', { class: 'wkrr-toolbar__spacer' }),
      el('button', {
        class: 'wkrr-text-btn',
        title: 'Copy the list as text',
        text: 'Copy',
        onclick: (event: Event) => {
          const button = event.currentTarget as HTMLElement;
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
          clearStore();
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
  } else if (session.filter === 'unresolved') {
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
    // Whichever of the two is empty comes back as null, and append() renders a
    // null argument as the text "null" rather than skipping it.
    const groups = [
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
      ),
    ].filter((group) => group !== null);
    body.append(...groups);
  }

  panel.append(header, body);
}

export function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}
