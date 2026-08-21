// ==UserScript==
// @name         WaniKani Review Recap Sidebar
// @namespace    https://github.com/dominikchmiel/review-recap-wanikani
// @version      1.5.0
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
