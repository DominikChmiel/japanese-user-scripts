/**
 * Replays a review session through the real events WaniKani dispatches
 * (didAnswerQuestion / didCompleteSubject), using the actual subject queue JSON
 * taken from the page snapshot in ./snapshots.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SNAPSHOTS, runUserscript, flush, createChecker } from './harness.mjs';

const snapshot = fs.readFileSync(path.join(SNAPSHOTS, 'WaniKani _ Reviews.html'), 'utf8');
const start = snapshot.indexOf('data-quiz-queue-target="subjects"');
const jsonStart = snapshot.indexOf('>', start) + 1;
const jsonEnd = snapshot.indexOf('</script>', jsonStart);
const subjects = JSON.parse(snapshot.slice(jsonStart, jsonEnd));

// Mirrors the parts of the review page the script touches: the quiz column, the
// Item Info toggle (additional_content_controller's markup) and its turbo-frame.
const { window } = runUserscript('wanikani-review-recap.user.js', {
  url: 'https://www.wanikani.com/subjects/review',
  html: `<!doctype html><html><head></head><body>
     <div class="quiz"><div class="quiz__content">review</div></div>
     <a class="additional-content__item additional-content__item--item-info"
        data-item-info-target="toggle" data-turbo-frame="subject-info" data-hotkey="f"></a>
     <turbo-frame id="subject-info" class="subject-info" data-hotkey="e">
       <section class="subject-section subject-section--meaning subject-section--collapsible" expanded>
         <a class="subject-section__toggle" data-toggle-target="toggle"></a>
       </section>
       <section class="subject-section subject-section--reading subject-section--collapsible">
         <a class="subject-section__toggle" data-toggle-target="toggle"></a>
       </section>
     </turbo-frame>
   </body></html>`,
});

// Stand in for additional_content_controller: clicking the toggle opens/closes.
const infoToggle = window.document.querySelector('[data-item-info-target="toggle"]');
let infoToggleClicks = 0;
infoToggle.addEventListener('click', () => {
  infoToggleClicks++;
  infoToggle.classList.toggle('additional-content__item--open');
});
// ...and for toggle_controller: clicking a section toggle expands it.
window.document.querySelectorAll('#subject-info [data-toggle-target="toggle"]').forEach((t) => {
  t.addEventListener('click', () => t.closest('.subject-section').toggleAttribute('expanded'));
});

// -- replay ------------------------------------------------------------------
// Mirrors WaniKani's own CachedStats + QuizQueue.submitAnswer bookkeeping.
const stats = new Map();
const statFor = (subject) => {
  if (!stats.has(subject.id)) {
    stats.set(subject.id, {
      meaning: { incorrect: 0, complete: false },
      reading: {
        incorrect: 0,
        complete: ['Radical', 'KanaVocabulary'].includes(subject.type),
      },
    });
  }
  return stats.get(subject.id);
};

function answer(subject, questionType, action, typed) {
  const stat = statFor(subject);
  stat[questionType].complete = action === 'pass';
  if (action !== 'pass') stat[questionType].incorrect += 1;
  const subjectWithStats = JSON.parse(JSON.stringify({ subject, stats: stat }));
  window.dispatchEvent(
    new window.CustomEvent('didAnswerQuestion', {
      detail: { subjectWithStats, questionType, answer: typed, results: { action } },
    })
  );
  if (stat.reading.complete && stat.meaning.complete) {
    window.dispatchEvent(
      new window.CustomEvent('didCompleteSubject', { detail: { subjectWithStats } })
    );
    stats.delete(subject.id);
  }
}

const kanjiList = subjects.filter((s) => s.type === 'Kanji');
const kanji = kanjiList[0]; // 湯 - Hot Water / ゆ・とう
const perfectKanji = kanjiList[1]; // 雄 - Male
const splitKanji = kanjiList[2]; // reading missed, meaning fine
const vocab = subjects.find((s) => s.type === 'Vocabulary'); // 希望する
const radical = subjects.find((s) => s.type === 'Radical'); // 尞 - Charcoal

answer(kanji, 'meaning', 'fail', 'hot spring');
answer(kanji, 'reading', 'fail', 'とう');
answer(kanji, 'meaning', 'pass', 'hot water');
answer(kanji, 'reading', 'pass', 'ゆ');

answer(vocab, 'meaning', 'fail', 'to desire it');
answer(vocab, 'meaning', 'fail', 'to demand');

answer(radical, 'meaning', 'fail', 'ox tail');

// Meaning right first try, reading wrong and still outstanding.
answer(splitKanji, 'meaning', 'pass', splitKanji.meanings[0].text);
answer(splitKanji, 'reading', 'fail', 'まちがい');

answer(perfectKanji, 'meaning', 'pass', 'male');
answer(perfectKanji, 'reading', 'pass', 'ゆう');

await flush();

// -- assertions --------------------------------------------------------------
const check = createChecker('WaniKani Review Recap Sidebar');
const { document } = window;
const panel = document.getElementById('wkrr-panel');
const text = panel.textContent.replace(/\s+/g, ' ');

check('panel is injected', !!panel);
check('stylesheet is injected', !!document.getElementById('wkrr-style'));
check('a fully correct item never appears', !text.includes('雄'));
check('"still failed" counts the 3 unresolved items', /3 still failed/.test(text), text.slice(0, 160));
check('"missed total" counts all 4', /4 missed total/.test(text));

// -- meaning and reading resolve independently -------------------------------
const stillFailed = [...panel.querySelectorAll('.wkrr-section')].find((s) =>
  s.textContent.includes('Still failed')
);
const splitCard = [...stillFailed.querySelectorAll('.wkrr-card')].find((c) =>
  c.textContent.includes(splitKanji.characters)
);
check('an item with only a wrong reading is still listed', !!splitCard);
check(
  'its correct meaning is not shown',
  !splitCard.textContent.includes(splitKanji.meanings[0].text),
  splitCard.textContent
);
check('its outstanding reading is shown', !!splitCard.querySelector('.wkrr-readings'));
check('only the reading miss count is badged', !/M ×/.test(splitCard.textContent));
check('the wrong reading is shown', splitCard.textContent.includes('まちがい'));

// 湯 had both halves wrong and both since answered right -> nothing outstanding.
check(
  'an item with every half resolved leaves "Still failed"',
  !stillFailed.textContent.includes('湯')
);

// 希望する only ever missed its meaning, and is still outstanding.
const vocabInFailed = [...stillFailed.querySelectorAll('.wkrr-card')].find((c) =>
  c.textContent.includes('希望する')
);
check(
  'a meaning-only miss hides the reading',
  !vocabInFailed.querySelector('.wkrr-readings'),
  vocabInFailed.textContent
);
check('a meaning-only miss shows no reading badge', !/R ×/.test(vocabInFailed.textContent));

// "Got it on a retry" is collapsed by default, so expand it before inspecting 湯.
const resolvedSection = [...panel.querySelectorAll('.wkrr-section')].find((s) =>
  s.textContent.includes('Got it on a retry')
);
check('the resolved section starts collapsed', resolvedSection.classList.contains('is-collapsed'));
check('a collapsed section renders no cards', !resolvedSection.querySelector('.wkrr-card'));
resolvedSection.querySelector('.wkrr-section__head').click();
await flush();
check(
  'the resolved section expands on click',
  ![...panel.querySelectorAll('.wkrr-section')]
    .find((s) => s.textContent.includes('Got it on a retry'))
    .classList.contains('is-collapsed')
);

const cards = [...panel.querySelectorAll('.wkrr-card')];
check('only failed items are tracked', cards.length === 4, 'got ' + cards.length);

const kanjiCard = cards.find((c) => c.textContent.includes('湯'));
const kanjiTags = [...kanjiCard.querySelectorAll('.wkrr-tag')].map((t) => t.textContent);
check('kanji answered right later is marked resolved', kanjiCard.classList.contains('is-resolved'));
check('kanji shows its primary meaning', kanjiCard.textContent.includes('Hot Water'));
check('kanji tags the kun reading', kanjiTags.includes('kun'), JSON.stringify(kanjiTags));
check('kanji tags the on reading', kanjiTags.includes('on'), JSON.stringify(kanjiTags));
check('kanji shows both readings', /ゆ/.test(kanjiCard.textContent) && /とう/.test(kanjiCard.textContent));
check(
  'no superfluous row labels are rendered',
  !/Meaning|You typed/.test(panel.textContent),
  panel.textContent.slice(0, 200)
);
check('blocked meanings stay hidden', !kanjiCard.textContent.includes('Hot Weather'));
check('wrong meaning is recorded verbatim', kanjiCard.textContent.includes('hot spring'));
check('wrong reading is recorded verbatim', kanjiCard.textContent.includes('とう'));
check(
  'per-type wrong counts are shown',
  /M ×1/.test(kanjiCard.textContent) && /R ×1/.test(kanjiCard.textContent)
);
check('kanji links to its WaniKani page', kanjiCard.querySelector('a').href.includes('/kanji/'));

const vocabCard = cards.find((c) => c.textContent.includes('希望する'));
check('never-completed vocab stays unresolved', !vocabCard.classList.contains('is-resolved'));
check('repeat mistakes are counted', /M ×2/.test(vocabCard.textContent));
check(
  'every distinct wrong answer is kept',
  vocabCard.textContent.includes('to desire it') && vocabCard.textContent.includes('to demand')
);

const radicalCard = cards.find((c) => c.textContent.includes('尞'));
check('radical is tracked', !!radicalCard);
check('radical shows no reading tag', !radicalCard.querySelector('.wkrr-tag'));
check(
  'radical links to its slug page',
  radicalCard.querySelector('a').href.includes('/radicals/charcoal')
);

const saved = JSON.parse(window.localStorage.getItem('wk-review-recap:v1'));
check('session is persisted to localStorage', Object.keys(saved.items).length === 4);
check(
  'per-half resolution is persisted',
  saved.items[splitKanji.id].resolved.meaning === true &&
    saved.items[splitKanji.id].resolved.reading === false
);

// The "Still failed" filter must hide resolved items.
[...panel.querySelectorAll('.wkrr-tab')].find((b) => b.textContent === 'Still failed').click();
await flush();
check(
  'filter hides items answered correctly later',
  !document.getElementById('wkrr-panel').textContent.includes('湯')
);

/*
 * An empty group renders as nothing at all. section() returns null for one, and
 * ParentNode.append() turns a null argument into the literal text "null" rather
 * than skipping it - so the "All" view used to print "null" under the cards for
 * as long as either group was empty, which is most of a session.
 */
const loose = runUserscript('wanikani-review-recap.user.js', {
  url: 'https://www.wanikani.com/subjects/review',
  html: '<!doctype html><html><head></head><body><div class="quiz"></div></body></html>',
});
loose.window.dispatchEvent(
  new loose.window.CustomEvent('didAnswerQuestion', {
    detail: {
      subjectWithStats: { subject: kanji, stats: { meaning: { complete: false, incorrect: 1 } } },
      questionType: 'meaning',
      answer: 'hot spring',
      results: { action: 'fail' },
    },
  })
);
await flush();
const looseBody = loose.window.document.querySelector('.wkrr-body');
const strays = [...looseBody.childNodes]
  .filter((node) => node.nodeType === 3)
  .map((node) => node.textContent);
check(
  'nothing failed yet means one empty group, and an empty group renders nothing',
  !!looseBody.querySelector('.wkrr-card') && strays.length === 0,
  JSON.stringify(strays)
);

// Typed answers are untrusted text and must never become live DOM.
answer(subjects.find((s) => s.id === 4443), 'meaning', 'fail', '<img src=x onerror=alert(1)>');
await flush();
check(
  'typed answers are not parsed as HTML',
  document.querySelectorAll('#wkrr-panel img[src="x"]').length === 0
);

// -- Item Info auto-open on a wrong answer -----------------------------------
check('Item Info was opened on failure', infoToggleClicks > 0, 'clicks: ' + infoToggleClicks);
check(
  'Item Info is left open, not toggled shut again',
  infoToggle.classList.contains('additional-content__item--open')
);
check(
  'collapsed reading/explanation sections get expanded',
  [...document.querySelectorAll('#subject-info .subject-section--collapsible')].every((s) =>
    s.hasAttribute('expanded')
  )
);

const clicksBefore = infoToggleClicks;
answer(subjects.find((s) => s.id === 4443), 'meaning', 'fail', 'to cut');
await flush();
check(
  'an already-open Item Info is not toggled shut',
  infoToggleClicks === clicksBefore,
  `${clicksBefore} -> ${infoToggleClicks}`
);

// A correct answer must not pop the panel open.
infoToggle.classList.remove('additional-content__item--open');
const clicksBeforePass = infoToggleClicks;
answer(perfectKanji, 'meaning', 'pass', 'male');
await flush();
check('Item Info stays shut on a correct answer', infoToggleClicks === clicksBeforePass);

// -- Shift to peek, and the burn guard ---------------------------------------
// The quiz page publishes the queue's SRS stages as JSON. Stage 8 is
// Enlightened, so the next correct answer burns the item.
const srsBlob = document.createElement('script');
srsBlob.type = 'application/json';
srsBlob.setAttribute('data-quiz-queue-target', 'subjectIdsWithSRS');
srsBlob.textContent = JSON.stringify({
  subject_ids_with_srs_info: [
    [perfectKanji.id, 8, 1], // one pass away from burning
    [vocab.id, 4, 1], // mid-Apprentice, nothing at stake
  ],
});
document.body.append(srsBlob);

function peekAt(subject, questionType) {
  window.dispatchEvent(
    new window.CustomEvent('willShowNextQuestion', { detail: { subject, questionType } })
  );
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Shift' }));
  return document.getElementById('wkrr-peek');
}
const releaseShift = () =>
  window.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'Shift' }));

const safePeek = peekAt(vocab, 'meaning');
check('holding Shift reveals the item', safePeek.classList.contains('is-visible'));
check(
  'an item with nothing at stake shows its meaning',
  safePeek.textContent.includes(vocab.meanings[0].text),
  safePeek.textContent
);
check('the asked half is highlighted', !!safePeek.querySelector('.wkrr-peek__row.is-asked'));
releaseShift();
check('releasing Shift hides it', !safePeek.classList.contains('is-visible'));

const burnPeek = peekAt(perfectKanji, 'reading');
check('an item about to burn is still shown', burnPeek.classList.contains('is-visible'));
check('...but the answer is withheld', !!burnPeek.querySelector('.wkrr-peek__blocked'));
check('...with the reason spelled out', /about to burn/i.test(burnPeek.textContent));
check(
  '...and no meaning or reading reaches the DOM',
  !burnPeek.textContent.includes(perfectKanji.meanings[0].text) &&
    !burnPeek.querySelector('.wkrr-readings') &&
    !burnPeek.textContent.includes(perfectKanji.readings[0].reading),
  burnPeek.textContent
);
releaseShift();

// Missing a half drops the SRS stage, so there is no longer a burn to protect.
answer(perfectKanji, 'reading', 'fail', 'まちがい');
await flush();
const afterMiss = peekAt(perfectKanji, 'reading');
check(
  'once the item has been missed the peek comes back',
  !afterMiss.querySelector('.wkrr-peek__blocked') &&
    afterMiss.textContent.includes(perfectKanji.meanings[0].text),
  afterMiss.textContent
);
releaseShift();

// -- current-level marker ----------------------------------------------------
// The real Level Progress widget, lifted out of the dashboard snapshot: a lazy
// turbo-frame listing every subject on the level as a subject-srs-progress link.
const dashboardSnapshot = fs.readFileSync(path.join(SNAPSHOTS, 'WaniKani _ Dashboard.html'), 'utf8');
const widgetAt = dashboardSnapshot.search(/class="level-progress-widget /);
const widgetStart = dashboardSnapshot.lastIndexOf('<turbo-frame', widgetAt);
const levelWidget = dashboardSnapshot.slice(
  widgetStart,
  dashboardSnapshot.indexOf('</turbo-frame>', widgetStart) + '</turbo-frame>'.length
);
const LEVEL_KEY = 'wk-review-recap:current-level';
const onLevel = subjects.find((s) => s.characters === '雄'); // level 29, like perfectKanji
const offLevel = subjects.find((s) => s.characters === '湯'); // level 12-ish, like kanji

const dashboardProbe = runUserscript('wanikani-review-recap.user.js', {
  url: 'https://www.wanikani.com/dashboard',
  html: `<!doctype html><html><head></head><body>${levelWidget}</body></html>`,
});
const cached = JSON.parse(dashboardProbe.window.localStorage.getItem(LEVEL_KEY) || 'null');
check('the current level is read off the dashboard widget', cached && cached.level === 29, cached);
check('every subject on the level is cached', cached && cached.paths.length === 163, cached.paths.length);
check(
  '...keyed by the same subject paths the panel links to',
  cached.paths.includes('/kanji/雄') && cached.paths.includes('/radicals/charcoal'),
  cached.paths.slice(0, 3)
);

// Previous/Next browse other levels, and those visits put a level= on the src.
const browsedProbe = runUserscript('wanikani-review-recap.user.js', {
  url: 'https://www.wanikani.com/dashboard',
  html: `<!doctype html><html><head></head><body>${levelWidget.replace(
    /(src="[^"]*widgets\/level-progress)\?/,
    '$1?level=28&'
  )}</body></html>`,
});
check(
  'browsing to another level is not mistaken for your own',
  browsedProbe.window.localStorage.getItem(LEVEL_KEY) === null
);

const marked = runUserscript('wanikani-review-recap.user.js', {
  url: 'https://www.wanikani.com/subjects/review',
  html: `<!doctype html><html><head></head><body>
     <div class="quiz"><div class="character-header"><div class="character-header__content">
       <div class="character-header__characters" lang="ja">雄</div>
       <div class="character-header__meaning"></div>
     </div></div></div>
   </body></html>`,
  setup(w) {
    w.localStorage.setItem(LEVEL_KEY, JSON.stringify({ level: 29, paths: ['/kanji/雄'] }));
  },
});
const ask = (subject) =>
  marked.window.dispatchEvent(
    new marked.window.CustomEvent('willShowNextQuestion', {
      detail: { subject, questionType: 'meaning' },
    })
  );

ask(onLevel);
const mark = marked.window.document.getElementById('wkrr-level');
check('a current-level item is marked', !!mark);
check('the mark names the level', mark && mark.textContent === 'Level 29', mark && mark.textContent);
check(
  'it sits directly under the character being quizzed',
  mark &&
    mark.previousElementSibling ===
      marked.window.document.querySelector('.character-header__characters')
);

ask(offLevel);
check(
  'an item from an earlier level is not marked',
  !marked.window.document.getElementById('wkrr-level')
);

ask(onLevel);
marked.tick();
check(
  'the mark comes back, and the tick does not duplicate it',
  marked.window.document.querySelectorAll('#wkrr-level').length === 1
);

// -- theming -----------------------------------------------------------------
// The script brings its own dark theme, so there is no light/dark to resolve at
// runtime and nothing is stamped on the panel - the palette is dark either way.
check('the panel takes no runtime theme stamp', panel.dataset.theme === undefined);
check('the bundled theme is injected on the review page', !!document.getElementById('wkrr-dark-theme'));

// It is a site theme, not a panel theme: it goes in wherever we run, including
// the pages that never build a panel.
const themed = runUserscript('wanikani-review-recap.user.js', {
  url: 'https://www.wanikani.com/dashboard',
  html: '<!doctype html><html><head></head><body><div class="dashboard"></div></body></html>',
});
check(
  'and site-wide, on a page with no panel at all',
  !!themed.window.document.getElementById('wkrr-dark-theme') &&
    !themed.window.document.getElementById('wkrr-panel')
);
check(
  'it sets the page background the rest of WaniKani is styled off',
  themed.window.document.getElementById('wkrr-dark-theme').textContent.includes('--color-app-background')
);

// Turbo swaps <head> on navigation, which takes the <style> with it.
themed.window.document.getElementById('wkrr-dark-theme').remove();
themed.tick();
check(
  'the tick puts it back after a Turbo head swap, exactly once',
  themed.window.document.querySelectorAll('#wkrr-dark-theme').length === 1
);

// Whatever background a page (or another userstyle) declares, the panel is
// built the same - its palette comes from the theme's own --USER-* variables.
for (const [label, background] of [
  ['Elementary Dark', '#151515'],
  ['vanilla WaniKani', '#F4F4F4'],
]) {
  const probe = runUserscript('wanikani-review-recap.user.js', {
    url: 'https://www.wanikani.com/subjects/review',
    html: `<!doctype html><html style="--color-app-background: ${background}"><head></head>
             <body><div class="quiz"></div></body></html>`,
  });
  await flush();
  probe.tick();
  const built = probe.window.document.getElementById('wkrr-panel');
  check(`on ${label} the panel is built with the one dark palette`, !!built && !built.dataset.theme);
}

// -- lesson/review counts refresh once the hour turns ------------------------
// WaniKani's own markup: the dashboard's Lessons/Reviews pair plus the badge in
// the global navigation.
const dashboardHtml = (lessons, reviews) => `<!doctype html><html><head></head><body>
   <nav><a href="/subjects/lesson"><span class="count-bubble">${lessons}</span></a></nav>
   <div class="lesson-and-review-count">
     <a class="lesson-and-review-count__item" href="/subjects/lesson">
       <span class="lesson-and-review-count__count${lessons ? '' : ' lesson-and-review-count__count--zero'}">${lessons}</span>
       <span class="lesson-and-review-count__label">lessons</span>
     </a>
     <a class="lesson-and-review-count__item" href="/subjects/review">
       <span class="lesson-and-review-count__count">${reviews}</span>
       <span class="lesson-and-review-count__label">reviews</span>
     </a>
   </div>
 </body></html>`;

/**
 * The script samples the hour and the date at boot and only acts when one of
 * them moves, so pin both before it runs and move them afterwards. `fetches`
 * records what the script asked the server for - jsdom has no fetch of its own.
 * jsdom has no Turbo either, so `reloads` stands in for `<turbo-frame>.reload`.
 */
function countProbe({ url, html, served }) {
  const clock = { hour: 10, date: 'Fri Aug 07 2026' };
  const fetches = [];
  const reloads = [];
  const probe = runUserscript('wanikani-review-recap.user.js', {
    url,
    html,
    setup(window) {
      window.Date.prototype.getHours = () => clock.hour;
      window.Date.prototype.toDateString = () => clock.date;
      window.fetch = (target, options) => {
        fetches.push({ target, options });
        return Promise.resolve({ ok: true, text: () => Promise.resolve(served) });
      };
    },
  });
  probe.window.document.querySelectorAll('turbo-frame[src]').forEach((frame) => {
    frame.reload = () => reloads.push(frame.id);
  });
  return { ...probe, clock, fetches, reloads };
}

/** What the script should be stamping onto the day-scoped URLs: local midnight. */
function localMidnight() {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  return midnight.toISOString();
}

const dayParam = (node, attribute) =>
  new URL(node.getAttribute(attribute), 'https://www.wanikani.com').searchParams.get(
    'utc_time_at_start_of_day'
  );

const dash = countProbe({
  url: 'https://www.wanikani.com/dashboard',
  html: dashboardHtml(0, 12),
  served: dashboardHtml(9, 41),
});
const counts = () =>
  [...dash.window.document.querySelectorAll('.lesson-and-review-count__count, .count-bubble')].map(
    (n) => n.textContent
  );

dash.tick();
await flush();
check('nothing is fetched while the hour stands still', dash.fetches.length === 0);
check('the counts are left alone', JSON.stringify(counts()) === '["0","0","12"]', counts());

dash.clock.hour = 11;
dash.tick();
await flush();
check('the hour turning refetches the page', dash.fetches.length === 1, JSON.stringify(dash.fetches));
check(
  'the fetch carries the session cookie',
  dash.fetches[0] && dash.fetches[0].options.credentials === 'same-origin'
);
check('the new counts are patched in', JSON.stringify(counts()) === '["9","9","41"]', counts());
check(
  'the count is no longer marked as zero',
  !dash.window.document.querySelector('.lesson-and-review-count__count--zero')
);
check(
  'the surrounding links are left untouched',
  dash.window.document.querySelectorAll('.lesson-and-review-count__item').length === 2 &&
    dash.window.document.querySelectorAll('.lesson-and-review-count__label').length === 2
);

dash.tick();
await flush();
check('it refetches once per hour, not every tick', dash.fetches.length === 1);

// Nothing is reloaded or replaced when the page has changed shape underneath us.
const shifted = countProbe({
  url: 'https://www.wanikani.com/dashboard',
  html: dashboardHtml(0, 12),
  served: '<!doctype html><html><body>Please log in</body></html>',
});
shifted.clock.hour = 11;
shifted.tick();
await flush();
check(
  'a response without counts leaves the stale numbers in place',
  shifted.window.document.querySelector('.lesson-and-review-count__count').textContent === '0'
);

// Mid-session there is nothing to update and a background fetch is just noise.
const quiz = countProbe({
  url: 'https://www.wanikani.com/subjects/review',
  html: '<!doctype html><html><head></head><body><div class="quiz"></div></body></html>',
  served: dashboardHtml(9, 41),
});
quiz.clock.hour = 11;
quiz.tick();
await flush();
check('a quiz page never fetches mid-session', quiz.fetches.length === 0);

// -- the day turning also refreshes the lesson state -------------------------
/*
 * Reviews only ever get more numerous; lessons get a whole new allowance at
 * midnight. WaniKani renders that day into the page - the frames behind the
 * counts and the Today's Lessons widget are fetched with
 * `utc_time_at_start_of_day`, and every link into the lesson queue repeats it -
 * and its own controllers only write that stamp when they connect. So a plain
 * `frame.reload()` after midnight would fetch yesterday all over again.
 */
const YESTERDAY = '2026-08-07T22:00:00.000Z';
const stamped = (base) => base + encodeURIComponent(YESTERDAY);
const START_LESSONS = 'https://www.wanikani.com/subject-lessons/start?utc_time_at_start_of_day=';

const framedHtml = `<!doctype html><html><head></head><body>
   <turbo-frame id="counts" src="${stamped(
     'https://www.wanikani.com/lesson-and-review-count?browser_timezone=Europe%2FBerlin&utc_time_at_start_of_day='
   )}">
     <div class="lesson-and-review-count">
       <a class="lesson-and-review-count__item" href="${stamped(START_LESSONS)}">
         <span class="lesson-and-review-count__count">0</span>
       </a>
     </div>
   </turbo-frame>
   <turbo-frame id="lessons-widget" src="${stamped(
     'https://www.wanikani.com/widgets/todays-lessons?theme=neon&widget_frame=lessons-widget&browser_timezone=Europe%2FBerlin&utc_time_at_start_of_day='
   )}">
     <div class="todays-lessons-widget todays-lessons-widget--complete">
       <span class="count-bubble"><span class="count-bubble__text">0</span></span>
       <a class="wk-button" href="${stamped(START_LESSONS)}">Start Lessons</a>
     </div>
   </turbo-frame>
   <turbo-frame id="level-progress" src="${stamped(
     'https://www.wanikani.com/widgets/level-progress?utc_time_at_start_of_day='
   )}"><div class="level-progress-widget"></div></turbo-frame>
 </body></html>`;

// The fixture above is a stand-in - check its shape against the real dashboard.
check(
  'the Today\'s Lessons widget is the class the script looks for',
  dashboardSnapshot.includes('class="todays-lessons-widget ')
);
check(
  'its frame carries the day stamp the script rewrites',
  /widgets\/todays-lessons[^"]*utc_time_at_start_of_day=/.test(dashboardSnapshot)
);
check(
  'so does the link into the lesson queue',
  dashboardSnapshot.includes('/subject-lessons/start?utc_time_at_start_of_day=')
);

// The hour turning is not the day turning: reload the frames as they stand.
const sameDay = countProbe({ url: 'https://www.wanikani.com/dashboard', html: framedHtml });
sameDay.clock.hour = 11;
sameDay.tick();
await flush();
check(
  'the hour turning reloads the count frames',
  JSON.stringify(sameDay.reloads.sort()) === '["counts","lessons-widget"]',
  JSON.stringify(sameDay.reloads)
);
check(
  'the day stamp is left where it was',
  dayParam(sameDay.window.document.getElementById('counts'), 'src') === YESTERDAY
);
check(
  'the page is not re-fetched when every count lives in a frame',
  sameDay.fetches.length === 0
);

// Midnight: point the frames at today, which is itself the reload.
const midnight = countProbe({ url: 'https://www.wanikani.com/dashboard', html: framedHtml });
const today = localMidnight();
midnight.clock.hour = 0;
midnight.clock.date = 'Sat Aug 08 2026';
midnight.tick();
await flush();
const frameAt = (id) => dayParam(midnight.window.document.getElementById(id), 'src');
check('the count frame is restamped for the new day', frameAt('counts') === today, frameAt('counts'));
check(
  'so is the Today\'s Lessons widget - the allowance resets with the date',
  frameAt('lessons-widget') === today,
  frameAt('lessons-widget')
);
check(
  'a frame with nothing of ours in it is left alone',
  frameAt('level-progress') === YESTERDAY
);
check(
  'restamping is the reload - the frames are not fetched twice',
  midnight.reloads.length === 0,
  JSON.stringify(midnight.reloads)
);
check(
  'the rest of the frame src survives the rewrite',
  midnight.window.document.getElementById('lessons-widget').getAttribute('src').includes(
    'widget_frame=lessons-widget'
  ) &&
    midnight.window.document
      .getElementById('lessons-widget')
      .getAttribute('src')
      .includes('theme=neon')
);
check(
  'both links into the lesson queue point at today',
  [...midnight.window.document.querySelectorAll('a[href*="subject-lessons/start"]')].every(
    (link) => dayParam(link, 'href') === today
  )
);

midnight.tick();
await flush();
check('it turns the day over once, not every tick', midnight.reloads.length === 0);
check(
  'and the stamp is not rewritten again',
  frameAt('counts') === today
);

// Without frames the widget is swapped whole: the count is only part of what
// the new day changes - so are the "done for today" state and the button.
const widgetHtml = (lessons, done) => `<!doctype html><html><head></head><body>
   <nav><span class="count-bubble">${lessons}</span></nav>
   <div class="todays-lessons-widget${done ? ' todays-lessons-widget--complete' : ''}">
     <span class="count-bubble">${lessons}</span>
     <a class="wk-button" href="${stamped(START_LESSONS)}">Start Lessons</a>
   </div>
 </body></html>`;

const plainDay = countProbe({
  url: 'https://www.wanikani.com/dashboard',
  html: widgetHtml(0, true),
  served: widgetHtml(15, false),
});
plainDay.clock.hour = 0;
plainDay.clock.date = 'Sat Aug 08 2026';
plainDay.tick();
await flush();
const dayWidget = () => plainDay.window.document.querySelector('.todays-lessons-widget');
check('the day turning re-fetches the page', plainDay.fetches.length === 1);
check(
  'the widget stops claiming you are done for the day',
  dayWidget() && !dayWidget().classList.contains('todays-lessons-widget--complete')
);
check(
  'the new allowance is showing',
  dayWidget() && dayWidget().querySelector('.count-bubble').textContent === '15'
);
check(
  'the badge outside the widget moved too',
  plainDay.window.document.querySelector('nav .count-bubble').textContent === '15'
);
check(
  'the swapped-in link points at today',
  dayParam(dayWidget().querySelector('a'), 'href') === localMidnight()
);

// An hour change leaves the widget alone - only the counts move on the hour.
const plainHour = countProbe({
  url: 'https://www.wanikani.com/dashboard',
  html: widgetHtml(0, true),
  served: widgetHtml(15, false),
});
plainHour.clock.hour = 11;
plainHour.tick();
await flush();
const hourWidget = plainHour.window.document.querySelector('.todays-lessons-widget');
check(
  'the hour turning still moves the counts',
  [...plainHour.window.document.querySelectorAll('.count-bubble')].every(
    (n) => n.textContent === '15'
  )
);
check(
  'but leaves the day-scoped state as it was',
  hourWidget.classList.contains('todays-lessons-widget--complete')
);
check(
  'and leaves the day stamp on the link alone',
  dayParam(hourWidget.querySelector('a'), 'href') === YESTERDAY
);

// -- overall progress widget -------------------------------------------------
// wkof hands back one entry per subject with its assignment attached. An
// assignment that has never unlocked counts as locked, same as having none.
const PROGRESS_KEY = 'wk-review-recap:progress';
const atStage = (stage, count) =>
  Array.from({ length: count }, (_, i) => ({
    id: stage * 1000 + i,
    data: { hidden_at: null },
    assignments: { srs_stage: stage, unlocked_at: '2020-01-01T00:00:00.000Z' },
  }));

const wkofItems = [
  ...Array.from({ length: 5 }, (_, i) => ({ id: 90000 + i, data: { hidden_at: null } })),
  ...Array.from({ length: 2 }, (_, i) => ({
    id: 91000 + i,
    data: { hidden_at: null },
    assignments: { srs_stage: 0, unlocked_at: null },
  })),
  ...atStage(0, 3), // lessons
  ...atStage(1, 4), ...atStage(2, 3), ...atStage(3, 2), ...atStage(4, 1), // apprentice: 10
  ...atStage(5, 4), ...atStage(6, 2), // guru: 6
  ...atStage(7, 4), // master
  ...atStage(8, 8), // enlightened
  ...atStage(9, 12), // burned
]; // 50 subjects, 7 of them locked

const DASHBOARD = `<!doctype html><html><head></head><body>
   <div class="dashboard"><div class="dashboard__content" data-controller="dashboard">
     <div class="dashboard__row" id="wk-own-row">
       <div class="dashboard__widget dashboard__widget--one-third"></div>
     </div>
   </div></div>
 </body></html>`;

// The fixture above is a stand-in - check its anchor against the real dashboard.
check(
  'the container the widget hooks onto is WaniKani\'s own',
  (dashboardSnapshot.match(/class="dashboard__content"/g) || []).length === 1
);

function progressProbe({ items, cached, url = 'https://www.wanikani.com/dashboard', html = DASHBOARD }) {
  const asked = [];
  const probe = runUserscript('wanikani-review-recap.user.js', {
    url,
    html,
    setup(window) {
      if (cached) window.localStorage.setItem(PROGRESS_KEY, JSON.stringify(cached));
      if (!items) return;
      window.wkof = {
        include: (module) => asked.push(module),
        ready: () => Promise.resolve(),
        ItemData: {
          get_items: (config) => {
            asked.push(config);
            return Promise.resolve(items);
          },
        },
      };
    },
  });
  return { ...probe, asked };
}

const bars = progressProbe({ items: wkofItems });
await flush();
const widget = bars.window.document.querySelector('.wkrr-progress');
check('the progress widget is built from wkof', !!widget);
check(
  'it asks wkof for the item data with assignments',
  bars.asked.join(',') === 'ItemData,assignments',
  JSON.stringify(bars.asked)
);
check('its stylesheet is injected', !!bars.window.document.getElementById('wkrr-progress-style'));

const readoutOf = (probe) =>
  probe.window.document.querySelector('.wkrr-progress__readout').textContent;
check(
  'unlocked leads the readout, burned follows',
  readoutOf(bars) === '86.0% unlocked · 24.0% burned',
  readoutOf(bars)
);
const progressCss = bars.window.document.getElementById('wkrr-progress-style').textContent;
const barHeight = Number(
  (progressCss.match(/\.wkrr-progress__bar \{[^}]*height: (\d+)px/) || [])[1]
);
check('the bar is thick enough to read as a bar', barHeight >= 16, barHeight);

const segments = [...bars.window.document.querySelectorAll('.wkrr-progress__segment')];
check(
  'the bar fills from the left, furthest along first',
  segments.map((s) => s.className.replace(/.*--/, '')).join(',') ===
    'burned,enlightened,master,guru,apprentice,lessons,locked',
  segments.map((s) => s.className)
);
check(
  'each segment is sized by its item count',
  segments.map((s) => s.style.flexGrow).join(',') === '12,8,4,6,10,3,7',
  segments.map((s) => s.style.flexGrow)
);
check(
  'the locked share is the empty tail of the track, not a coloured segment',
  segments[6].classList.contains('wkrr-progress__segment--locked') && !segments[6].style.background
);
/*
 * The stage colours are the one thing here that does not defer to the theme:
 * Elementary Dark resolves five of the --color-srs-progress-* variables to
 * near-identical greys, so the widget ships a set that was checked instead -
 * worst neighbouring pair ΔE 11.6 under simulated colour blindness (16.7 with
 * full colour vision), each at least 3:1 against both the dark widget and
 * stock WaniKani's white. Pinned so that changing one has to go back through
 * those checks.
 */
const PALETTE = {
  burned: 'rgb(194, 110, 18)',
  enlightened: 'rgb(2, 138, 155)',
  master: 'rgb(102, 136, 255)',
  guru: 'rgb(172, 76, 181)',
  apprentice: 'rgb(234, 89, 116)',
  lessons: 'rgb(138, 143, 152)',
};
check(
  'the stage colours are the checked set, not the theme greys',
  segments
    .slice(0, 6)
    .every((s) => s.style.backgroundColor === PALETTE[s.className.replace(/.*--/, '')]),
  segments.map((s) => s.style.backgroundColor)
);
// Lessons is "not started", so it is striped rather than tinted - and the
// stripes come from the stylesheet, which the background shorthand would drop.
check(
  'the Lessons segment is striped on top of its fill',
  /\.wkrr-progress__segment--lessons[^{]*\{[^}]*repeating-linear-gradient/.test(progressCss) &&
    !/;background:/.test(segments[5].getAttribute('style')),
  segments[5].getAttribute('style')
);

// Hovering a segment is the only way the counts are shown, so it has to work.
const hover = (node, type) => node.dispatchEvent(new bars.window.MouseEvent(type));
hover(segments[3], 'mouseenter');
check('hovering a segment names it and counts it', readoutOf(bars) === 'Guru - 6 of 50 (12.0%)', readoutOf(bars));
check('...and is spelled out as a title too', segments[3].title === 'Guru - 6 of 50 (12.0%)', segments[3].title);
hover(segments[6], 'mouseenter');
check('the empty tail reports what is still locked', readoutOf(bars) === 'Locked - 7 of 50 (14.0%)', readoutOf(bars));
hover(bars.window.document.querySelector('.wkrr-progress__bar'), 'mouseleave');
check('leaving the bar puts the summary back', readoutOf(bars) === '86.0% unlocked · 24.0% burned');

// The key is where the counts live: a 4%-wide segment has no room for its own
// number, so every stage is named and counted underneath the bar instead.
const keys = [...bars.window.document.querySelectorAll('.wkrr-progress__key')];
const keyText = keys.map(
  (k) =>
    k.querySelector('.wkrr-progress__key-label').textContent +
    ' ' +
    k.querySelector('.wkrr-progress__key-count').textContent
);
check(
  'every segment is labelled with its count, in bar order',
  keyText.join(', ') ===
    'Burned 12, Enlightened 8, Master 4, Guru 6, Apprentice 10, Lessons 3, Locked 7',
  keyText
);
check(
  'each entry wears its own segment\'s colour',
  keys.every(
    (k, i) =>
      k.querySelector('.wkrr-progress__swatch').style.backgroundColor ===
      segments[i].style.backgroundColor
  ),
  keys.map((k) => k.querySelector('.wkrr-progress__swatch').style.backgroundColor)
);

// Pointing at an entry has to reach into the bar, or the two halves are just
// two lists to line up by eye.
const bar = bars.window.document.querySelector('.wkrr-progress__bar');
hover(keys[2], 'mouseenter');
check(
  'hovering an entry lights its segment and reads it out',
  segments[2].classList.contains('wkrr-progress__segment--lit') &&
    bar.classList.contains('wkrr-progress__bar--pointed') &&
    readoutOf(bars) === 'Master - 4 of 50 (8.0%)',
  readoutOf(bars)
);
hover(keys[2], 'mouseleave');
check(
  'and the rest of the bar comes back up when you leave',
  !segments[2].classList.contains('wkrr-progress__segment--lit') &&
    !bar.classList.contains('wkrr-progress__bar--pointed')
);
hover(bars.window.document.querySelector('.wkrr-progress__legend'), 'mouseleave');
check('leaving the key puts the summary back too', readoutOf(bars) === '86.0% unlocked · 24.0% burned');

check(
  'it sits at the top of the dashboard, above WaniKani\'s own rows',
  bars.window.document.querySelector('.dashboard__content').firstElementChild.id === 'wkrr-progress'
);
check(
  'it spans the full width rather than sharing a row',
  !!bars.window.document.querySelector('#wkrr-progress .dashboard__widget--full')
);
check("WaniKani's own row is left alone", !!bars.window.document.getElementById('wk-own-row'));

const cachedProgress = JSON.parse(bars.window.localStorage.getItem(PROGRESS_KEY) || 'null');
check('the tally is cached for the next page load', cachedProgress && cachedProgress.total === 50, cachedProgress);

widget.dataset.probe = 'built-once';
bars.tick();
await flush();
check(
  'the tick neither duplicates nor rebuilds an unchanged bar',
  bars.window.document.querySelectorAll('#wkrr-progress').length === 1 &&
    bars.window.document.querySelector('.wkrr-progress').dataset.probe === 'built-once'
);
check('and it does not re-ask wkof', bars.asked.filter((a) => a === 'assignments').length === 1);

// A stage can legitimately be empty, and an empty segment would still take up
// its 3px minimum - so it has to be left out of the bar entirely.
const empty = progressProbe({
  items: [...Array.from({ length: 3 }, (_, i) => ({ id: i, data: { hidden_at: null } })), ...atStage(9, 1)],
});
await flush();
check(
  'stages with nothing in them take no room in the bar',
  [...empty.window.document.querySelectorAll('.wkrr-progress__segment')]
    .map((s) => s.className.replace(/.*--/, ''))
    .join(',') === 'burned,locked'
);
check(
  '...and none in the key either',
  [...empty.window.document.querySelectorAll('.wkrr-progress__key-label')]
    .map((k) => k.textContent)
    .join(',') === 'Burned,Locked'
);

// The cache is what makes the bar paint before wkof has answered.
const fromCache = progressProbe({
  items: null,
  cached: { at: Date.now(), total: 50, counts: { '-1': 38, 9: 12 } },
});
check(
  'a cached tally renders without wkof',
  readoutOf(fromCache) === '24.0% unlocked · 24.0% burned',
  readoutOf(fromCache)
);

const noWkof = progressProbe({ items: null });
check('no wkof and no cache means no widget', !noWkof.window.document.getElementById('wkrr-progress'));

const quizPage = progressProbe({
  items: wkofItems,
  cached: { at: Date.now(), total: 50, counts: { 9: 12 } },
  url: 'https://www.wanikani.com/subjects/review',
  html: '<!doctype html><html><head></head><body><div class="quiz"></div></body></html>',
});
await flush();
check(
  'the widget stays on the dashboard',
  !quizPage.window.document.getElementById('wkrr-progress') && quizPage.asked.length === 0
);

const css = document.getElementById('wkrr-style').textContent;
check('type colours defer to WaniKani/theme variables', css.includes('var(--color-kanji'));
check('the dark palette follows the Elementary Dark variables', css.includes('--USER-surface-1'));
check('Item Info font size is scaled up', /#subject-info[^{]*\{[^}]*font-size: 18px/.test(css));

process.exit(check.summary() ? 1 : 0);
