/*
 * The recap's own state, and its trip through localStorage.
 *
 * It is held in two mutable objects rather than a handful of module-level
 * `let`s because an ES module cannot export a binding that another module
 * reassigns - and the panel, the event handlers and the session reset all write
 * here. Reading `session.filter` is no worse than reading `filter` was; the
 * object is the only thing that had to change.
 */
import { EXPIRY_MS, STORAGE_KEY } from './config';
import type { ItemRecord, QuestionType, Store } from './types';

export type Filter = 'all' | 'unresolved';
export type SectionKey = 'unresolved' | 'resolved';

/**
 * session.store.items[subjectId] is an ItemRecord: what the item is, how often
 * each half was missed, what was actually typed, and whether it has since been
 * answered correctly. See ItemRecord in ./types.
 */
export const session: {
  store: Store;
  filter: Filter;
  collapsed: boolean;
  sectionCollapsed: Record<SectionKey, boolean>;
} = {
  store: { startedAt: Date.now(), items: {} },
  filter: 'all',
  collapsed: false,
  // "Got it on a retry" is reference material, not a to-do list - keep it shut.
  sectionCollapsed: { unresolved: false, resolved: true },
};

/**
 * The subject currently being asked (from willShowNextQuestion) and which half
 * is being quizzed. Drives the Shift-to-peek popover; not persisted.
 */
export const quiz: {
  subject: ItemRecord | null;
  questionType: QuestionType | null;
} = {
  subject: null,
  questionType: null,
};

/** Forget everything tracked so far and start a new session's recap. */
export function clearStore() {
  session.store = { startedAt: Date.now(), items: {} };
}

export function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.items) return;
    if (Date.now() - (parsed.startedAt || 0) > EXPIRY_MS) return;
    session.store = { startedAt: parsed.startedAt || Date.now(), items: parsed.items };
    // Records written before per-type resolution existed only knew "completed".
    for (const record of Object.values(session.store.items) as ItemRecord[]) {
      if (!record.resolved) {
        record.resolved = { meaning: !!record.completed, reading: !!record.completed };
      }
    }
    session.collapsed = !!parsed.collapsed;
    if (parsed.filter === 'unresolved') session.filter = 'unresolved';
    if (parsed.sectionCollapsed) {
      session.sectionCollapsed = {
        unresolved: !!parsed.sectionCollapsed.unresolved,
        resolved: parsed.sectionCollapsed.resolved !== false,
      };
    }
  } catch (e) {
    /* corrupt or unavailable storage - start fresh */
  }
}

export function save() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ...session.store,
        collapsed: session.collapsed,
        filter: session.filter,
        sectionCollapsed: session.sectionCollapsed,
      })
    );
  } catch (e) {
    /* quota / private mode - the panel still works for this page load */
  }
}
