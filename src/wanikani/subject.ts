/*
 * Everything that is true of a single item regardless of where it is drawn -
 * how a raw WaniKani subject becomes a record, which halves of it are missed,
 * and how its meanings, readings and URL read. The panel, the peek popover and
 * the level marker all render from here rather than from each other.
 */
import { QUESTION_TYPES, READING_TAG } from './config';
import type { ItemRecord, Reading, ReadingGroup, Subject } from './types';

export function newRecord(subject: Subject): ItemRecord {
  const chars = subject.characters;
  return {
    id: subject.id,
    type: subject.type || subject.subject_category || 'Vocabulary',
    characters: typeof chars === 'string' ? chars : '',
    image: chars && typeof chars === 'object' ? chars.url || '' : '',
    meanings: Array.isArray(subject.meanings) ? subject.meanings : [],
    readings: Array.isArray(subject.readings) ? subject.readings : [],
    primaryReadingType: subject.primary_reading_type || '',
    counts: { meaning: 0, reading: 0 },
    wrong: { meaning: [], reading: [] },
    // Mirrors WaniKani's stats[type].complete: true once you have answered
    // that half correctly, so meaning and reading resolve independently.
    resolved: { meaning: false, reading: false },
    completed: false,
    firstAt: Date.now(),
    lastAt: Date.now(),
  };
}

/** Halves you got wrong at some point this session. */
export function failedTypes(record: ItemRecord) {
  return QUESTION_TYPES.filter((type) => record.counts[type] > 0);
}

/** Halves you got wrong and have not since answered correctly. */
export function outstandingTypes(record: ItemRecord) {
  return failedTypes(record).filter((type) => !record.resolved[type]);
}

export function meaningsOf(record: ItemRecord) {
  const primary = record.meanings.filter((m) => m.kind === 'primary').map((m) => m.text);
  const alternative = record.meanings
    .filter((m) => m.kind === 'alternative')
    .map((m) => m.text);
  return { primary, alternative };
}

/** Grouped readings, blocked ones removed. Kanji get on/kun tags. */
export function readingGroupsOf(record: ItemRecord): ReadingGroup[] {
  const usable = (record.readings || []).filter((r) => r.kind !== 'blocked' && r.text);
  if (!usable.length) return [];

  if (record.type !== 'Kanji') {
    return [{ label: '', readings: usable }];
  }

  const order: string[] = [];
  const byType = new Map<string, Reading[]>();
  for (const reading of usable) {
    const key = reading.type || '';
    let group = byType.get(key);
    if (!group) {
      group = [];
      byType.set(key, group);
      order.push(key);
    }
    group.push(reading);
  }
  return order.map((key) => ({
    label: READING_TAG[key] || key,
    readings: byType.get(key) ?? [],
  }));
}

export function subjectUrl(record: ItemRecord): string | null {
  if (record.type === 'Radical') {
    const primary = meaningsOf(record).primary[0] || '';
    const slug = primary
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return slug ? 'https://www.wanikani.com/radicals/' + slug : null;
  }
  if (!record.characters) return null;
  const segment = record.type === 'Kanji' ? 'kanji' : 'vocabulary';
  return 'https://www.wanikani.com/' + segment + '/' + encodeURIComponent(record.characters);
}
