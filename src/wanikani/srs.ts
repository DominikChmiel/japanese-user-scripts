/*
 * The quiz page ships the SRS stage of everything in the queue as JSON:
 *
 *   <script type="application/json" data-quiz-queue-target="subjectIdsWithSRS">
 *     {"subject_ids_with_srs_info": [[3920,5,1], [844,2,1], ...],
 *      "srs_ids_stage_names": [[1, ["Unlocked","Apprentice", ..., "Burned"]]]}
 *
 * Each triple is [subject_id, srs_stage, srs_system_id] and the stage indexes
 * into that system's name list, so stage 8 is Enlightened - one more correct
 * answer and the item burns.
 */
import { failedTypes } from './subject';
import { session } from './state';
import type { ItemRecord } from './types';

export const BURN_FROM_STAGE = 8;
const SRS_BLOB_SELECTOR =
  'script[type="application/json"][data-quiz-queue-target="subjectIdsWithSRS"]';

let srsStages: Map<number, number> | null = null;
let srsSource = ''; // the JSON we parsed, so a Turbo swap re-reads it

function parseSrsStages(json: string) {
  const stages = new Map<number, number>();
  try {
    const parsed = JSON.parse(json);
    for (const entry of parsed.subject_ids_with_srs_info || []) {
      if (Array.isArray(entry) && entry.length >= 2) stages.set(entry[0], entry[1]);
    }
  } catch (e) {
    /* payload changed shape - carry on with no stage information */
  }
  return stages;
}

export function srsStageOf(subjectId: number) {
  const blob = document.querySelector(SRS_BLOB_SELECTOR);
  const source = blob ? blob.textContent || '' : '';
  if (!srsStages || source !== srsSource) {
    srsSource = source;
    srsStages = parseSrsStages(source);
  }
  const stage = srsStages.get(subjectId);
  return typeof stage === 'number' ? stage : null;
}

/*
 * An item only burns if it comes through the whole session clean. Once either
 * half has been missed its stage drops instead, so there is no longer a burn to
 * protect and the peek is fair game again.
 */
export function wouldBurn(record: ItemRecord | null) {
  if (!record) return false;
  if (srsStageOf(record.id) !== BURN_FROM_STAGE) return false;
  const tracked = session.store.items[record.id];
  return !tracked || failedTypes(tracked).length === 0;
}
