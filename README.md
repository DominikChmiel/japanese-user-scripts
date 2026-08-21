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

### Shift to peek — except when it would burn

Holding <kbd>Shift</kbd> during a review reveals the current item's meaning and
readings, with the half you are being asked highlighted. Releasing it hides them
again.

An item at **Enlightened** is one correct answer away from burning, which is the
one place a peek would do real damage — so there it shows why it is withholding
the answer instead of revealing it. Nothing of the answer is even built into the
DOM in that case. Miss either half and the peek comes back, because a missed item
drops an SRS stage and is no longer up for a burn.

The stages come from the quiz page's own
`data-quiz-queue-target="subjectIdsWithSRS"` payload — `[subject_id, srs_stage,
srs_system_id]` triples — so no API token or extra request is involved.

### Current-level marker

The item being quizzed gets a **Level _n_** pill directly under its characters
when it belongs to your current level — the items you are actively pushing
through, and so the ones worth slowing down for. Items from earlier levels get
nothing, so the pill's presence is the highlight.

The quiz carries no level data anywhere — not in the subject queue, not in the
SRS payload, not in Item Info. The dashboard's **Level Progress** widget does,
though: it renders your level and every subject in it as
`<a class="subject-srs-progress" href="…/radicals/charcoal">`, which is the same
URL shape the panel's cards already link to. So the set is read off the dashboard
as you pass through it and cached in `localStorage` under
`wk-review-recap:current-level` until you level up. No API token, no extra
request. The widget's Previous / Next buttons put a `level=` on its turbo-frame
`src`, which is how browsing to another level is told apart from your own.

### Overall progress bar on the dashboard

A slim bar across the top of the dashboard, stacked by SRS stage, for the whole
of WaniKani. Its full width is a completed set — every subject burned — so the
coloured part is how far along you actually are, and the grey tail is what is
still locked. It fills from the left, furthest along first: **Burned /
Enlightened / Master / Guru / Apprentice / Lessons**, then the locked remainder.

Two numbers sit on the right: how much of WaniKani you have **unlocked**, then
how much of it has **burned**. Nothing else is on show — hover a segment and the
rest dim while that line becomes `Guru — 1,122 of 9,971 (11.3%)`, so the counts
cost no space of their own. The same text is on each segment as a `title`, so it
still works on touch and with a screen reader.

WaniKani's own dashboard cannot answer this. Its **Active Item Spread** widget
stops at Enlightened, there is no burned count anywhere on the page, and nothing
states how many subjects WaniKani has in total. Both of those live behind the
API, so this one feature builds on
[WaniKani Open Framework](https://github.com/rfindley/wanikani-open-framework)
instead:
`wkof.ItemData.get_items('assignments')` already holds every subject and
assignment in IndexedDB, which makes the counts exact and normally costs no
request. The tally is cached in `localStorage` under `wk-review-recap:progress`
so the bar paints immediately on the next load, and refreshed at most every ten
minutes.

**This is the one part of the script with an outside dependency.** Without wkof
installed the widget simply never appears; everything else works untouched.

Colours come from `--color-srs-progress-*` where the page defines them (the dark
theme below does), falling back to WaniKani's classic pink/purple/blue/burnt
palette.

### On a wrong answer

WaniKani's **Item Info** panel (the `F` hotkey) opens automatically, and the
sections inside it are expanded so the reading and explanation are visible
straight away — by default they only auto-expand for the question type you were
just asked, leaving the reading collapsed after a missed meaning. The panel is
only opened when it is not already open, so WaniKani's own
"auto-open after N incorrect" setting cannot fight it.

Item Info also renders at a larger font size — WaniKani's own `--font-size-*`
scale times `ITEM_INFO_FONT_SCALE` (1.15), scoped to that frame.

### Lesson and review counts refresh on the hour, lessons again at midnight

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

Midnight is a bigger event than the hour, because the **daily lesson allowance
resets with the date**. WaniKani renders the day into the page rather than
inferring it: the frames behind the counts and the Today's Lessons widget are
fetched with `utc_time_at_start_of_day=<your local midnight>`, and every link
into the lesson queue (`/subject-lessons/start`) repeats it. Its own
`set-time-zone` / `dashboard-widget` controllers write that stamp when they
connect and never again — so a plain `frame.reload()` after midnight would just
fetch *yesterday* over again, allowance and all.

So when the date turns, the stamp is rewritten to the new local midnight before
anything is fetched:

- the day-scoped `<turbo-frame src>` is repointed at today, which **is** its
  reload — Turbo loads a frame whose `src` changes, so it is not asked for a
  second one. Everything else in the URL (`widget_frame`, `theme`,
  `browser_timezone`) is left exactly as WaniKani wrote it;
- `.todays-lessons-widget` is swapped **whole**, not just the count inside it —
  the "done for today" state and the Start Lessons button are day-scoped too;
- the `utc_time_at_start_of_day` on lesson links is restamped as a safety net,
  so a failed refresh (offline, expired session) cannot leave a button that asks
  the server for yesterday's batch.

Frames with nothing of ours in them are left alone. The date is checked
alongside the hour, not instead of it, so midnight — which moves both — makes one
pass rather than two; a timezone change or the repeated DST hour can move the
date without moving the hour, so neither is assumed from the other.

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
