/*
 * A slim bar across the dashboard for the whole of WaniKani - every subject
 * grouped by SRS stage, with the full width standing for a completed set,
 * i.e. everything burned. The counts stay out of the way until you hover a
 * segment, so the whole thing costs two lines.
 *
 * The dashboard cannot answer that on its own. Its "Active Item Spread"
 * widget stops at Enlightened, there is no burned count anywhere on the page,
 * and nothing states how many subjects WaniKani has in total. Both of those
 * live behind the API, so this builds on WaniKani Open Framework instead:
 * wkof already holds every subject and assignment in IndexedDB, which makes
 * the counts exact and normally free. Without wkof the widget never appears.
 */
import { el } from './dom';
import { PROGRESS_CSS } from './styles/progress.css';
import type { ProgressRow, ProgressTally, WkofItem } from './types';
const PROGRESS_STORAGE_KEY = 'wk-review-recap:progress';
const PROGRESS_MAX_AGE_MS = 10 * 60 * 1000; // how often to re-ask wkof

/*
 * Left to right along the bar, furthest along first, so it fills from the
 * left the way a progress bar should. The numbers are WaniKani's own stages:
 * 9 Burned, 8 Enlightened, 7 Master, 5-6 Guru, 1-4 Apprentice, and 0 for
 * unlocked but not yet learned (it is sitting in the lesson queue). Locked
 * items have no stage at all and are the empty tail of the bar.
 *
 * The colours are fixed hexes rather than WaniKani's --color-srs-progress-*
 * variables, which is the one place this widget does not defer to the theme.
 * Six touching segments have to be told apart at a glance, and the SRS
 * variables cannot do that here: Elementary Dark resolves five of them to
 * near-identical muted greys, and even stock WaniKani puts Guru beside
 * Apprentice at a colour-blind separation of ΔE 6.6, below the ΔE 8 the
 * segments need to stay distinct. These five were picked against those
 * checks - worst neighbouring pair ΔE 11.6 simulated (16.7 with full colour
 * vision), every one of them at least 3:1 against the widget behind it in
 * both the dark theme and stock WaniKani's white. Burned keeps the ember
 * reading rather than WaniKani's near-black, which is invisible on a dark
 * surface. Lessons is deliberately colourless - "not started yet", the same
 * family as the empty tail - so it is striped rather than tinted, which is
 * also what keeps it apart from Apprentice next to it.
 */
const PROGRESS_STAGES = [
  { key: 'burned', label: 'Burned', stages: [9], color: '#c26e12' },
  { key: 'enlightened', label: 'Enlightened', stages: [8], color: '#028a9b' },
  { key: 'master', label: 'Master', stages: [7], color: '#6688ff' },
  { key: 'guru', label: 'Guru', stages: [5, 6], color: '#ac4cb5' },
  { key: 'apprentice', label: 'Apprentice', stages: [1, 2, 3, 4], color: '#ea5974' },
  { key: 'lessons', label: 'Lessons', stages: [0], color: '#8a8f98' },
];

let progress: ProgressTally | null = null;
let progressAskedAt = 0;

export function loadProgress() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PROGRESS_STORAGE_KEY) || 'null');
    if (parsed && parsed.total > 0 && parsed.counts) progress = parsed;
  } catch (e) {
    /* corrupt or unavailable storage - the widget waits for wkof instead */
  }
}

function saveProgress() {
  try {
    localStorage.setItem(PROGRESS_STORAGE_KEY, JSON.stringify(progress));
  } catch (e) {
    /* quota / private mode - it still renders for this page load */
  }
}

/*
 * wkof hands back one entry per subject with its assignment attached, if it
 * has one. An assignment without unlocked_at has not been reached yet, which
 * is the same as having none - both count as locked, exactly how wkof's own
 * srs_stage index treats them.
 */
function tallyProgress(items: WkofItem[] | undefined): ProgressTally | null {
  const counts: Record<number, number> = {};
  let total = 0;
  for (const item of items || []) {
    if (!item || !item.data) continue;
    total++;
    const assignment = item.assignments;
    const stage = assignment && assignment.unlocked_at ? (assignment.srs_stage ?? -1) : -1;
    counts[stage] = (counts[stage] || 0) + 1;
  }
  return total ? { at: Date.now(), total, counts } : null;
}

/*
 * Runs off the tick: wkof may well load after us, and the dashboard is the
 * only place the numbers are shown. The timestamp gates both outcomes, so a
 * missing API key costs one attempt every PROGRESS_MAX_AGE_MS rather than one
 * per tick.
 */
export function refreshProgress() {
  const wkof = window.wkof;
  if (!dashboardContent() || !wkof || typeof wkof.include !== 'function') return;
  const last = Math.max(progressAskedAt, progress ? progress.at : 0);
  if (Date.now() - last < PROGRESS_MAX_AGE_MS) return;
  progressAskedAt = Date.now();

  try {
    wkof.include('ItemData');
    wkof
      .ready('ItemData')
      .then(() => wkof.ItemData.get_items('assignments'))
      .then((items: WkofItem[]) => {
        const tally = tallyProgress(items);
        if (!tally) return;
        progress = tally;
        saveProgress();
        ensureProgressWidget();
      })
      .catch(() => {
        /* no API key, or wkof never became ready - leave the widget as is */
      });
  } catch (e) {
    /* wkof present but not the version we expect */
  }
}

/** Every segment of the bar, left to right, with the locked remainder last. */
function progressRows(tally: ProgressTally): ProgressRow[] {
  const rows: ProgressRow[] = PROGRESS_STAGES.map((stage) => ({
    key: stage.key,
    label: stage.label,
    color: stage.color,
    count: stage.stages.reduce((sum, n) => sum + (tally.counts[n] || 0), 0),
  }));
  const placed = rows.reduce((sum, row) => sum + row.count, 0);
  // No colour: the locked share is the empty tail of the track, not a segment.
  rows.push({
    key: 'locked',
    label: 'Locked',
    color: '',
    count: Math.max(0, tally.total - placed),
  });
  return rows;
}

function progressShare(tally: ProgressTally, count: number) {
  return ((count / tally.total) * 100).toFixed(1) + '%';
}

function progressTitle(tally: ProgressTally, row: ProgressRow) {
  const of = `${row.count.toLocaleString()} of ${tally.total.toLocaleString()}`;
  return `${row.label} - ${of} (${progressShare(tally, row.count)})`;
}

function buildProgress(tally: ProgressTally) {
  const rows = progressRows(tally);
  // Both keys are in PROGRESS_STAGES / appended by progressRows, so both are
  // always there; ?? 0 is how that is said without an assertion.
  const burned = rows.find((row) => row.key === 'burned')?.count ?? 0;
  const locked = rows.find((row) => row.key === 'locked')?.count ?? 0;
  // How far into WaniKani you have got, then how much of it has stuck.
  const summary =
    `${progressShare(tally, tally.total - locked)} unlocked · ${progressShare(tally, burned)} burned`;
  const readout = el('span', { class: 'wkrr-progress__readout', text: summary });
  const shown = rows.filter((row) => row.count > 0);

  /*
   * flex-grow does the proportions, so nothing is recomputed on a resize.
   * Empty stages are simply left out. Hovering names the stage and adds its
   * share to the readout; the counts themselves live in the key below, where
   * they are always legible - a 4%-wide segment has no room to be labelled
   * from the inside, and cropping the number would be worse than not showing
   * it at all.
   */
  // background-color rather than the background shorthand: the shorthand
  // would drop the stripes the stylesheet paints onto the Lessons segment.
  const segments = new Map(
    shown.map((row) => [
      row.key,
      el('span', {
        class: 'wkrr-progress__segment wkrr-progress__segment--' + row.key,
        style: 'flex-grow:' + row.count + (row.color ? ';background-color:' + row.color : ''),
        // Also as a title, so it works on touch and for screen readers.
        title: progressTitle(tally, row),
        onmouseenter: () => {
          readout.textContent = progressTitle(tally, row);
        },
      }),
    ])
  );

  const bar = el(
    'div',
    {
      class: 'wkrr-progress__bar',
      role: 'img',
      'aria-label': summary,
      onmouseleave: () => {
        readout.textContent = summary;
      },
    },
    [...segments.values()]
  );

  /*
   * The key names every segment and carries its count. Hovering an entry
   * lights its segment in the bar, the same as pointing at the segment does,
   * so the two halves are one control rather than two things to line up by
   * eye. The swatch is the only coloured thing here - the name and the count
   * stay in the widget's own text colours, which is what keeps them readable
   * whatever the segment is filled with.
   */
  const legend = el(
    'div',
    {
      class: 'wkrr-progress__legend',
      onmouseleave: () => {
        readout.textContent = summary;
      },
    },
    shown.map((row) =>
      el(
        'span',
        {
          class: 'wkrr-progress__key wkrr-progress__key--' + row.key,
          title: progressTitle(tally, row),
          onmouseenter: () => {
            readout.textContent = progressTitle(tally, row);
            bar.classList.add('wkrr-progress__bar--pointed');
            segments.get(row.key)?.classList.add('wkrr-progress__segment--lit');
          },
          onmouseleave: () => {
            bar.classList.remove('wkrr-progress__bar--pointed');
            segments.get(row.key)?.classList.remove('wkrr-progress__segment--lit');
          },
        },
        el('span', {
          class: 'wkrr-progress__swatch wkrr-progress__swatch--' + row.key,
          style: row.color ? 'background-color:' + row.color : '',
        }),
        el('span', { class: 'wkrr-progress__key-label', text: row.label }),
        el('span', {
          class: 'wkrr-progress__key-count',
          text: row.count.toLocaleString(),
        })
      )
    )
  );

  return el(
    'div',
    { class: 'wkrr-progress' },
    el(
      'div',
      { class: 'wkrr-progress__head' },
      el('span', { class: 'wkrr-progress__title', text: 'Overall progress' }),
      readout
    ),
    bar,
    legend
  );
}

function dashboardContent() {
  return document.querySelector<HTMLElement>('.dashboard__content');
}

/*
 * The dashboard lays widgets out as flex rows, so ours gets a full-width row
 * of its own at the top rather than being squeezed into one of WaniKani's and
 * reflowing it. Turbo swaps <body> on navigation, hence the rebuild-if-
 * missing; the data stamp keeps the tick from re-rendering an unchanged bar.
 */
export function ensureProgressWidget() {
  const content = dashboardContent();
  const existing = document.getElementById('wkrr-progress');
  const tally = progress;
  if (!content || !tally) {
    if (existing) existing.remove();
    return;
  }
  if (existing && existing.dataset.at === String(tally.at)) return;

  if (!document.getElementById('wkrr-progress-style')) {
    (document.head || document.documentElement).append(
      el('style', { id: 'wkrr-progress-style', text: PROGRESS_CSS })
    );
  }

  const row = existing || el('div', { id: 'wkrr-progress', class: 'dashboard__row' });
  row.dataset.at = String(tally.at);
  row.replaceChildren(
    el('div', { class: 'dashboard__widget dashboard__widget--full' }, buildProgress(tally))
  );
  if (row.parentElement !== content) content.prepend(row);
}
