/**
 * Lesson JSON Schema Types
 * Defines the structure for interactive MIDI lessons
 */

export type InstrumentType = 'keys' | 'pads' | 'drums';

export interface LessonStep {
  tick: number;      // Position in ticks (480 ticks per quarter note)
  note: number;      // MIDI note number (0-127)
  dur: number;       // Duration in ticks
  velocity: number;  // MIDI velocity (0-127)
  lane?: number;     // Optional logical lane for display
  // For song lessons: this step's own audio region within the lesson's
  // stemAudio file, so triggering it reproduces the exact original sound
  slice?: { offset: number; duration: number };
  // Song lessons: play the lane's clip shifted by this many semitones (a
  // pitched note folded into a neighbouring pitch's lane)
  semitones?: number;
}

export interface LoopSection {
  startTick: number;
  endTick: number;
}

export interface LessonMetadata {
  difficulty?: number;      // 1-10 scale
  genre?: string;
  tags?: string[];
  description?: string;
}

export interface Lesson {
  id: string;
  title: string;
  instrument: InstrumentType;
  bpm: number;
  timeSignature?: {
    numerator: number;
    denominator: number;
  };
  steps: LessonStep[];
  loop?: LoopSection;
  metadata?: LessonMetadata;
  samples?: { [note: number]: string };  // Map MIDI note to audio sample filename
  backingTrack?: string;  // Path to backing track audio file
  stemAudio?: string;     // Song lessons: stem file that step slices point into
  // Song lessons: detected beat grid (lesson seconds); the metronome ticks on
  // these beats and accents the downbeats instead of counting from time 0
  beatGrid?: { beats: number[]; downbeats: number[] };
  laneLabels?: { [note: number]: string };  // display name per lane, e.g. "Kick" or "E1"
  // Notes whose sound lasts long (see HOLD_MIN_MS) must be held for their
  // whole duration; `dur` is then the length of the note's sound
  holdNotes?: boolean;
}

/**
 * Scoring and feedback types
 */

export type HitAccuracy = 'perfect' | 'good' | 'early' | 'late' | 'miss';

export interface HitFeedback {
  expectedStep: LessonStep;
  actualNote: number;
  actualTime: number;
  timingDelta: number;  // ms difference from expected
  accuracy: HitAccuracy;
  points: number;
}

export interface LessonScore {
  totalSteps: number;
  hits: number;
  misses: number;
  perfectHits: number;
  goodHits: number;
  accuracy: number;     // 0-100%
  totalPoints: number;
  maxPoints: number;
}

/**
 * Practice mode settings
 */

export interface PracticeModeSettings {
  loopEnabled: boolean;
  loopSection?: LoopSection;
  speedMultiplier: number;  // 0 = near-stopped, 0.5 = half speed, 1.0 = normal, 2.0 = double
  autoBpmEnabled: boolean;
  autoBpmStartSpeed: number;
  autoBpmIncrementSteps: number;
  waitModeEnabled: boolean; // Pause until correct input
}
