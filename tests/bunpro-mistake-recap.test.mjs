/**
 * Drives the real Bunpro review snapshot: flips the data-meta-* attributes on
 * #quiz-metadata-element the way Bunpro does when an answer is judged, and
 * checks that only wrong answers are recorded and that the end-of-session
 * overview produces a usable LLM prompt.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SNAPSHOTS, runUserscript, createChecker } from './harness.mjs';

const html = fs.readFileSync(path.join(SNAPSHOTS, 'Review _ Bunpro.html'), 'utf8');

const { window, tick } = runUserscript('bunpro-mistake-recap.user.js', {
  url: 'https://bunpro.jp/reviews',
  html,
});
const { document } = window;
const meta = document.getElementById('quiz-metadata-element');

/** MutationObserver callbacks are queued as microtasks. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

async function judge({ input, correct }) {
  meta.setAttribute('data-meta-is-post-attempt', 'false'); // back to the input state
  await settle();
  meta.setAttribute('data-meta-input', input);
  meta.setAttribute('data-meta-is-correct', String(correct));
  meta.setAttribute('data-meta-is-post-attempt', 'true');
  await settle();
}

const check = createChecker('Bunpro Mistake Recap');

check('the metadata element was found', !!meta);
check('nothing is recorded before any answer', window.bunproMistakeRecap.mistakes.length === 0);

// A wrong answer -> recorded.
await judge({ input: 'きびしいは', correct: false });
let mistakes = window.bunproMistakeRecap.mistakes;
check('a wrong answer is recorded', mistakes.length === 1, 'got ' + mistakes.length);

const first = mistakes[0] || {};
check('the typed answer is kept', first.input === 'きびしいは', JSON.stringify(first.input));
check(
  'the accepted answers come from the metadata',
  Array.isArray(first.answers) && first.answers.includes('きびしくはある'),
  JSON.stringify(first.answers)
);
check('the grammar point id is captured', first.grammarId === 1110, String(first.grammarId));
check(
  'the grammar label is captured',
  first.grammarLabel === 'Contrastive, Standard',
  JSON.stringify(first.grammarLabel)
);
check(
  'the cloze blank is marked in the sentence',
  typeof first.sentence === 'string' && first.sentence.includes('____'),
  JSON.stringify(first.sentence)
);
check(
  'furigana is stripped from the sentence',
  first.sentence.includes('父は') && !first.sentence.includes('ちち'),
  JSON.stringify(first.sentence)
);
check(
  'the English translation is captured',
  /My father is strict, but he is a loving person\./.test(first.translation || ''),
  JSON.stringify(first.translation)
);

// Repeated observer fire for the same attempt must not double-record.
meta.setAttribute('data-meta-toast', 'something-else');
await settle();
check('duplicate mutations do not double-record', window.bunproMistakeRecap.mistakes.length === 1);

// A correct answer -> ignored.
await judge({ input: 'きびしくはある', correct: true });
check('correct answers are ignored', window.bunproMistakeRecap.mistakes.length === 1);

// A second wrong answer on the same item -> recorded separately.
await judge({ input: 'きびしくある', correct: false });
check('a second wrong answer is recorded', window.bunproMistakeRecap.mistakes.length === 2);

// The floating launcher reflects the count.
const launcher = document.getElementById('bpmr-launcher');
check('the launcher button appears', !!launcher);
check('the launcher shows the mistake count', /2/.test(launcher.textContent));

// Session ends: the quiz element disappears -> the overview opens by itself.
meta.remove();
tick();
const overlay = document.getElementById('bpmr-overlay');
check('the overview opens when the session ends', !!overlay);
check(
  'the overview lists both mistakes',
  overlay.querySelectorAll('.bpmr-card').length === 2,
  'got ' + overlay.querySelectorAll('.bpmr-card').length
);
check(
  'the overview shows the wrong and correct answers',
  overlay.textContent.includes('きびしいは') && overlay.textContent.includes('きびしくはある')
);

// The LLM prompt is the whole point - it must carry every field.
const prompt = window.bunproMistakeRecap.prompt();
check('the prompt asks for an explanation', /why it is wrong/.test(prompt));
check('the prompt contains the sentence', prompt.includes('____'));
check('the prompt contains the translation', prompt.includes('My father is strict'));
check('the prompt contains my answer', /My answer: きびしいは/.test(prompt));
check('the prompt contains the correct answer', /Correct answer\(s\): きびしくはある/.test(prompt));
check(
  'the prompt links the grammar point',
  prompt.includes('https://bunpro.jp/grammar_points/1110')
);
check('the prompt covers both mistakes', /### Mistake 2/.test(prompt));

// Persistence across the SPA navigation to the summary page.
const saved = JSON.parse(window.localStorage.getItem('bunpro-mistake-recap:v1'));
check('mistakes are persisted', saved && saved.mistakes.length === 2);

process.exit(check.summary() ? 1 : 0);
