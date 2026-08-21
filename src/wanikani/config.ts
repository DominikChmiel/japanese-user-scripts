/*
 * Tunables and the lookup tables the panel is built out of. Nothing here reads
 * the DOM or the network, so everything else can import it freely.
 */
import type { QuestionType } from './types';

export const PANEL_WIDTH = 'clamp(280px, 20%, 460px)'; // the "rest" of the 80/20 split
export const STORAGE_KEY = 'wk-review-recap:v1';
export const LEVEL_STORAGE_KEY = 'wk-review-recap:current-level';
export const EXPIRY_MS = 12 * 60 * 60 * 1000; // drop a stale session after 12h
export const MAX_WRONG_PER_TYPE = 12;

// Item Info runs a little small - scale WaniKani's font-size scale inside it.
export const ITEM_INFO_FONT_SCALE = 1.15;
export const WK_FONT_SIZES = {
  xxsmall: 11,
  xsmall: 14,
  small: 16,
  medium: 18,
  large: 24,
  xlarge: 28,
  xxlarge: 38,
};

/*
 * Both vanilla WaniKani and the "WaniKani Elementary Dark" userstyle define
 * these on :root, so borrowing them keeps the panel in step with whichever is
 * active - pink/purple/blue on stock WaniKani, muted red/green/slate on the
 * dark theme, and anything the user customises the theme to.
 */
export const TYPE_COLOR: Record<string, string> = {
  Radical: 'var(--color-radical, #00a1f1)',
  Kanji: 'var(--color-kanji, #f100a1)',
  Vocabulary: 'var(--color-vocabulary, #a100f1)',
  KanaVocabulary: 'var(--color-vocabulary, #a100f1)',
};

export const TYPE_LABEL: Record<string, string> = {
  Radical: 'Radical',
  Kanji: 'Kanji',
  Vocabulary: 'Vocab',
  KanaVocabulary: 'Kana Vocab',
};

// Short tags - the panel is narrow and "on'yomi" earns its keep as "on".
export const READING_TAG: Record<string, string> = {
  onyomi: 'on',
  kunyomi: 'kun',
  nanori: 'nanori',
};

export const QUESTION_TYPES: QuestionType[] = ['meaning', 'reading'];
