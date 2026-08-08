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

// -- theming -----------------------------------------------------------------
check('the panel carries a resolved theme', ['light', 'dark'].includes(panel.dataset.theme));

// The panel follows whatever --color-app-background the page resolves to, which
// is what makes it track the Elementary Dark userstyle without hardcoding it.
for (const [label, background, expected] of [
  ['Elementary Dark', '#151515', 'dark'],
  ['vanilla WaniKani', '#F4F4F4', 'light'],
]) {
  const probe = runUserscript('wanikani-review-recap.user.js', {
    url: 'https://www.wanikani.com/subjects/review',
    html: `<!doctype html><html style="--color-app-background: ${background}"><head></head>
             <body><div class="quiz"></div></body></html>`,
  });
  await flush();
  probe.tick();
  const theme = probe.window.document.getElementById('wkrr-panel').dataset.theme;
  check(`${label} resolves to the ${expected} palette`, theme === expected, 'got ' + theme);
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
 * The script samples the hour at boot and only acts when it changes, so pin
 * `getHours` before it runs and move it afterwards. `fetches` records what the
 * script asked the server for - jsdom has no fetch of its own.
 */
function countProbe({ url, html, served }) {
  const clock = { hour: 10 };
  const fetches = [];
  const probe = runUserscript('wanikani-review-recap.user.js', {
    url,
    html,
    setup(window) {
      window.Date.prototype.getHours = () => clock.hour;
      window.fetch = (target, options) => {
        fetches.push({ target, options });
        return Promise.resolve({ ok: true, text: () => Promise.resolve(served) });
      };
    },
  });
  return { ...probe, clock, fetches };
}

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

const css = document.getElementById('wkrr-style').textContent;
check('type colours defer to WaniKani/theme variables', css.includes('var(--color-kanji'));
check('the dark palette follows the Elementary Dark variables', css.includes('--USER-surface-1'));
check('Item Info font size is scaled up', /#subject-info[^{]*\{[^}]*font-size: 18px/.test(css));

process.exit(check.summary() ? 1 : 0);
