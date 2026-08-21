/*
 * The shapes WaniKani hands us, and the one we keep for ourselves.
 *
 * Everything on WaniKani's side of the line is typed defensively - the fields
 * are what its quiz payloads actually carry, and they are optional wherever the
 * script already guards for them. A userscript reads someone else's JSON, and
 * that JSON changes without warning.
 */

export type QuestionType = 'meaning' | 'reading';

export interface Meaning {
  text: string;
  /** 'primary' | 'alternative' | ... */
  kind?: string;
}

export interface Reading {
  text: string;
  /** 'primary' | 'alternative' | 'blocked' */
  kind?: string;
  /** 'onyomi' | 'kunyomi' | 'nanori' - kanji only. */
  type?: string;
}

/** A radical with no character of its own is drawn from an image instead. */
export interface SubjectImage {
  url?: string;
}

/** A subject as it arrives on willShowNextQuestion / didAnswerQuestion. */
export interface Subject {
  id: number;
  type?: string;
  subject_category?: string;
  characters?: string | SubjectImage | null;
  meanings?: Meaning[];
  readings?: Reading[];
  primary_reading_type?: string;
}

/** WaniKani's own per-half bookkeeping, which `ItemRecord.resolved` mirrors. */
export interface QuestionStats {
  complete?: boolean;
  incorrect?: number;
}

export interface SubjectWithStats {
  subject?: Subject;
  stats?: Partial<Record<QuestionType, QuestionStats>>;
}

/** One missed item, as the panel keeps it. */
export interface ItemRecord {
  id: number;
  type: string;
  characters: string;
  image: string;
  meanings: Meaning[];
  readings: Reading[];
  primaryReadingType: string;
  /** How often each half has been answered wrong this session. */
  counts: Record<QuestionType, number>;
  /** What was actually typed - deduped, and capped at MAX_WRONG_PER_TYPE. */
  wrong: Record<QuestionType, string[]>;
  /** Mirrors stats[type].complete: answered correctly since failing it. */
  resolved: Record<QuestionType, boolean>;
  /** Every half answered correctly - didCompleteSubject has fired. */
  completed: boolean;
  firstAt: number;
  lastAt: number;
}

export interface Store {
  startedAt: number;
  items: Record<string, ItemRecord>;
}

/** Readings of one type, grouped for display. Kanji get an on/kun label. */
export interface ReadingGroup {
  label: string;
  readings: Reading[];
}

/**
 * A <turbo-frame>. Turbo defines reload() on the element itself, so its
 * presence is also how the script tells whether Turbo is on the page at all.
 */
export interface TurboFrame extends HTMLElement {
  reload?: () => void;
}

/** One SRS-stage tally of every subject WaniKani has, as wkof reports it. */
export interface ProgressTally {
  /** When it was taken, which is also the widget's cache stamp. */
  at: number;
  total: number;
  /** Keyed by SRS stage; -1 is "locked", i.e. no assignment yet. */
  counts: Record<number, number>;
}

/** One segment of the progress bar, and its entry in the key below it. */
export interface ProgressRow {
  key: string;
  label: string;
  /** Empty for Locked - the tail of the track is drawn, not filled. */
  color: string;
  count: number;
}

/** One subject as WaniKani Open Framework hands it back, assignment attached. */
export interface WkofItem {
  data?: unknown;
  assignments?: {
    srs_stage?: number;
    unlocked_at?: string | null;
  };
}

/**
 * The slice of WaniKani Open Framework the progress widget uses. wkof is a
 * separate userscript that may or may not be installed, which is why every
 * entry point into it is guarded rather than assumed.
 */
export interface Wkof {
  include?: (modules: string) => void;
  ready: (modules: string) => Promise<unknown>;
  ItemData: {
    get_items: (config: string) => Promise<WkofItem[]>;
  };
}

declare global {
  interface Window {
    wkof?: Wkof;
  }
}

/* The detail payloads of the three events WaniKani's quiz dispatches. */

export interface AnswerDetail {
  subjectWithStats?: SubjectWithStats;
  questionType?: string;
  answer?: unknown;
  /** 'pass' | 'fail'. A 'retry' never reaches these events. */
  results?: { action?: string };
}

export interface CompleteDetail {
  subjectWithStats?: SubjectWithStats;
}

export interface NextQuestionDetail {
  subject?: Subject;
  questionType?: string;
}

/** Turbo's own visit event, used to spot the start of a new session. */
export interface TurboVisitDetail {
  url?: string;
  /** 'advance' | 'replace' | 'restore' */
  action?: string;
}
