import { Lesson, LessonStep } from '../../types/lesson';

/**
 * Hold notes: in lessons that opt in (`lesson.holdNotes`), a note whose sound
 * lasts at least HOLD_MIN_MS is a hold note. It is drawn as long as its sound,
 * plays only while its key is held, and counts as hit only when held to the
 * end (within holdToleranceMs).
 */
export const HOLD_MIN_MS = 600;

const TICKS_PER_BEAT = 480;

export const stepDurationMs = (step: LessonStep, bpm: number): number =>
  (step.dur / TICKS_PER_BEAT) * (60000 / bpm);

export const isHoldStep = (lesson: Pick<Lesson, 'holdNotes' | 'bpm' | 'ownBpm'>, step: LessonStep): boolean =>
  !!lesson.holdNotes && stepDurationMs(step, lesson.ownBpm ?? lesson.bpm) >= HOLD_MIN_MS;

/** How early a hold may be released and still count as held to the end. */
export const holdToleranceMs = (durationMs: number): number => Math.max(150, durationMs * 0.1);
