# Review Recap userscripts

Two Tampermonkey userscripts that answer the same question — *what did I actually
get wrong?* — in the way that suits each site.

| Script | Site | What it does |
| --- | --- | --- |
| `wanikani-review-recap.user.js` | wanikani.com | Live sidebar next to the review (80 / 20 split) listing every failed item with its meanings and readings. |
| `bunpro-mistake-recap.user.js` | bunpro.jp | Records wrong answers only and shows an end-of-session overview you can copy into an LLM. |

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Tampermonkey → **Dashboard** → **Utilities** → *Import from file*, or open the
   `.user.js` file in the browser and confirm the install prompt.
3. Both scripts use `@grant none` and no external dependencies.

---

## WaniKani Review Recap Sidebar

Shrinks WaniKani's review view to 80% and uses the freed right-hand column for a
running list of everything you have missed this session.

Each card shows the characters, the item type, the accepted meanings, the
readings (kanji carry a small `on` / `kun` tag, primary reading in bold), how
often you missed the meaning vs. the reading, and **the wrong answers you
actually typed**. The characters link to the item's WaniKani page.

Rows are deliberately unlabelled — English text is the meaning, Japanese text is
the reading, struck-through red is what you typed — so the narrow column spends
its width on values rather than captions.

### Meaning and reading are tracked separately

Each half of an item resolves on its own, so the sidebar only ever shows the part
you are actually still getting wrong:

| What happened | What the sidebar shows |
| --- | --- |
| Reading wrong, then right | Nothing outstanding — the item drops out of **Still failed** |
| Reading wrong, meaning fine | The reading only — no meaning, no `M ×n` badge |
| Meaning wrong, reading fine | The meaning only — no reading, no `R ×n` badge |
| Both wrong | Both, until each one is answered correctly |

This comes from WaniKani's own `stats[type].complete`, which flips to `true` on a
pass and `false` on a fail, so it stays in step with the review queue rather than
being guessed at.

Items are grouped into two collapsible sections:

- **Still failed** — at least one half is wrong and not yet answered correctly.
  Cards here show only the outstanding half.
- **Got it on a retry** — nothing outstanding any more, but the SRS stage still
  drops. Cards here show everything you missed. Collapsed by default; click the
  header to open it.

`All` / `Still failed` filters the list, `Copy` puts it on the clipboard as text,
`Clear` forgets the session, and `›` collapses the panel back to a tab (the
review returns to full width). Below 900px viewport width the panel auto-collapses.

State is kept in `localStorage`, so reloading mid-review does not lose anything.
A session is dropped automatically after 12 hours.

### Theming

The panel reads `--color-app-background` off the page and switches between a
light and a dark palette accordingly, so it follows
[WaniKani Elementary Dark](https://userstyles.world/style/22026) without being
hardcoded to it. On the dark palette it uses that theme's own
`--USER-surface-*` / `--USER-text*` variables (falling back to its defaults), so
customising the userstyle carries over. Item colours come from
`--color-radical` / `--color-kanji` / `--color-vocabulary`, which both stock
WaniKani and the theme define — pink/purple/blue on stock, muted red/green/slate
on Elementary Dark.

### On a wrong answer

WaniKani's **Item Info** panel (the `F` hotkey) opens automatically, and the
sections inside it are expanded so the reading and explanation are visible
straight away — by default they only auto-expand for the question type you were
just asked, leaving the reading collapsed after a missed meaning. The panel is
only opened when it is not already open, so WaniKani's own
"auto-open after N incorrect" setting cannot fight it.

Item Info also renders at a larger font size (WaniKani's own `--font-size-*`
scale, ×1.15, scoped to that frame).

Three constants at the top of the file control this:

```js
const AUTO_OPEN_ITEM_INFO_ON_FAIL = true;
const EXPAND_ALL_ITEM_INFO_SECTIONS = true;
const ITEM_INFO_FONT_SCALE = 1.15;
```

### Lesson and review counts refresh on the hour

WaniKani hands out new lessons and reviews on the hour, but the counts are baked
into the page at load time — a tab left open keeps advertising the 07:00 batch.
When the hour turns, the page is re-fetched in the background and **only the
count badges are swapped over**: no reload, so the scroll position, open widgets
and Turbo cache all survive. It happens on the spot, not just when you switch
back to the tab.

Two of WaniKani's own elements are updated — `.lesson-and-review-count__count`
(the dashboard's Lessons / Reviews pair) and `.count-bubble` (the badge in the
global navigation). Counts that live in a lazy `<turbo-frame>` are handed to
Turbo's own `frame.reload()` instead. If neither matches, or the re-fetched page
comes back a different shape, nothing is touched — a stale number beats a mangled
page. Quiz pages are skipped entirely.

```js
const AUTO_REFRESH_COUNTS = true;
```

### How it hooks in

WaniKani's review page dispatches these on `window` (verified against
`controllers/quiz_queue/queue.js` in their own bundle):

```js
willShowNextQuestion  // { subject, questionType }
didAnswerQuestion     // { subjectWithStats, questionType, answer, results }
didCompleteSubject    // { subjectWithStats }
```

`results.action` is `'pass'` or `'fail'`. A `'retry'` — typo warnings, impossible
kana, "did you mean the reading?" — never reaches these events, so every `fail`
we see is a real wrong answer. An item is only removed from the queue once both
its meaning and reading are correct, which is what makes "still failed" well
defined: failed at least once, no `didCompleteSubject` yet.

---

## Bunpro Mistake Recap

Records **only wrong answers**. During the session a small `n mistakes` button
sits in the bottom-right corner; when the session ends the overview opens by
itself.

Every mistake keeps the cloze sentence (furigana stripped, blank marked `____`),
the English translation, the grammar point and its link, the accepted answer(s)
and what you typed.

**Copy LLM prompt** produces a ready-to-paste prompt:

```
I'm studying Japanese grammar on Bunpro. Below are the questions I got wrong in my last review session.

For each mistake, please explain:
1. What my answer actually means, and why it is wrong here (grammar, conjugation, or nuance).
2. How exactly it differs from the correct answer.
3. In what context my answer *would* be correct, if any.

Keep each explanation short and concrete.

### Mistake 1 - Contrastive, Standard
Grammar point: https://bunpro.jp/grammar_points/1110
Sentence: 父は____が、愛がある人だ。(厳しい)
English: My father is strict, but he is a loving person.
Correct answer(s): きびしくはある
My answer: きびしいは
```

### How it hooks in

Bunpro mirrors its quiz state onto one element, which a `MutationObserver`
watches:

```html
<div id="quiz-metadata-element"
     data-meta-loc="review"
     data-meta-input="…"                       <!-- what you typed -->
     data-meta-is-correct="false"
     data-meta-is-post-attempt="false"         <!-- flips true once judged -->
     data-meta-info='{"id":1110,"type":"grammar_point"}'
     data-meta-answers-array='["きびしくはある"]'>
```

The sentence, translation and grammar label are not in that element, so they are
read from the DOM (`.bp-quiz-question`, `.bp-quiz-trans`, `.bp-quiz-tense`) at
the moment the answer is judged.

From the console you also get `window.bunproMistakeRecap` with `.mistakes`,
`.prompt()`, `.open()` and `.clear()`.

---

## Tests

Both scripts are exercised in `jsdom` against the real page snapshots in
`snapshots/` — the WaniKani suite replays a session through the actual subject
queue JSON and the real event shapes, the Bunpro suite flips the real
`data-meta-*` attributes.

```bash
npm install
npm test              # both suites
npm run test:wanikani
npm run test:bunpro
```
