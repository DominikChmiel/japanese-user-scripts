/*
 * The three events WaniKani's quiz dispatches on `window`, and what the recap
 * makes of them. See ./meta.js for their payload shapes - in short,
 * `results.action` is only ever 'pass' or 'fail' here, so every fail we see is
 * a genuine wrong answer rather than a typo warning.
 */
import { MAX_WRONG_PER_TYPE, QUESTION_TYPES } from './config';
import { openItemInfo } from './item-info';
import { ensureLevelMark } from './level';
import { scheduleRender } from './panel';
import { hidePeek } from './peek';
import { quiz, save, session } from './state';
import { newRecord } from './subject';
import type {
  AnswerDetail,
  CompleteDetail,
  NextQuestionDetail,
  QuestionType,
} from './types';

export function onAnswer(event: Event) {
  const detail = (event as CustomEvent<AnswerDetail>).detail || {};
  const subject = (detail.subjectWithStats || {}).subject;
  if (!subject || subject.id == null) return;
  const stats = (detail.subjectWithStats || {}).stats || {};

  const failed = !!detail.results && detail.results.action === 'fail';
  const type: QuestionType = detail.questionType === 'reading' ? 'reading' : 'meaning';

  if (failed) {
    // Let WaniKani's own didAnswerQuestion listeners run first: the toggle is
    // still disabled until item_info_controller#enable has fired.
    setTimeout(openItemInfo, 0);
  }

  let record = session.store.items[subject.id];
  if (!record) {
    if (!failed) return; // only ever track items you got wrong
    record = session.store.items[subject.id] = newRecord(subject);
  }

  record.lastAt = Date.now();
  if (failed) {
    record.counts[type] += 1;
    const answer = String(detail.answer == null ? '' : detail.answer).trim();
    const seen = record.wrong[type];
    if (answer && !seen.includes(answer) && seen.length < MAX_WRONG_PER_TYPE) {
      seen.push(answer);
    }
  }

  // Take resolution straight from WaniKani's own bookkeeping rather than
  // inferring it: stats[type].complete flips true on a pass, false on a fail.
  for (const questionType of QUESTION_TYPES) {
    const half = stats[questionType];
    if (half) {
      record.resolved[questionType] = !!half.complete;
    }
  }

  save();
  scheduleRender();
}

export function onComplete(event: Event) {
  const detail = (event as CustomEvent<CompleteDetail>).detail || {};
  const subject = (detail.subjectWithStats || {}).subject;
  if (!subject || subject.id == null) return;
  const record = session.store.items[subject.id];
  if (!record) return; // completed without ever failing - not our business
  record.completed = true;
  record.resolved.meaning = true;
  record.resolved.reading = true;
  record.lastAt = Date.now();
  save();
  scheduleRender();
}

export function onNextQuestion(event: Event) {
  const detail = (event as CustomEvent<NextQuestionDetail>).detail || {};
  const subject = detail.subject;
  if (subject && subject.id != null) {
    quiz.subject = newRecord(subject);
    quiz.questionType = detail.questionType === 'reading' ? 'reading' : 'meaning';
  }
  hidePeek(); // never carry a reveal across to the next item
  ensureLevelMark(); // straight away - waiting for the tick would lag the item
}
