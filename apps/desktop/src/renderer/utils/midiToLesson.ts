import { Midi } from '@tonejs/midi';
import { Lesson, LessonStep } from '../types/lesson';

/**
 * Available sample notes in the Salamander Grand Piano library.
 * Format: {Note}{Octave} -> MIDI note number
 * Samples are at: A, C, D#, F# in each octave
 */
const SAMPLE_NOTES: { [key: string]: number } = {
  'A0': 21, 'C1': 24, 'D#1': 27, 'F#1': 30,
  'A1': 33, 'C2': 36, 'D#2': 39, 'F#2': 42,
  'A2': 45, 'C3': 48, 'D#3': 51, 'F#3': 54,
  'A3': 57, 'C4': 60, 'D#4': 63, 'F#4': 66,
  'A4': 69, 'C5': 72, 'D#5': 75, 'F#5': 78,
  'A5': 81, 'C6': 84, 'D#6': 87, 'F#6': 90,
  'A6': 93, 'C7': 96, 'D#7': 99, 'F#7': 102,
  'A7': 105, 'C8': 108,
};

// Create reverse lookup from MIDI note to sample name
const MIDI_TO_SAMPLE: { [note: number]: string } = {};
for (const [name, midi] of Object.entries(SAMPLE_NOTES)) {
  MIDI_TO_SAMPLE[midi] = name;
}

/**
 * Get the closest available sample note for a given MIDI note.
 * Returns the sample filename prefix (e.g., "C4", "A3")
 */
export function getClosestSampleForNote(midiNote: number): string {
  // Find the closest sample note
  let closestSample = 'C4';
  let minDist = Infinity;

  for (const [name, sampleMidi] of Object.entries(SAMPLE_NOTES)) {
    const dist = Math.abs(midiNote - sampleMidi);
    if (dist < minDist) {
      minDist = dist;
      closestSample = name;
    }
  }

  return closestSample;
}

/**
 * Maps a MIDI note number to the corresponding piano sample filename.
 * Uses the closest available sample from the Salamander Grand Piano library.
 *
 * MIDI note 21 = A0, MIDI note 108 = C8
 */
export function midiNoteToSampleFilename(midiNote: number, velocity: number): string {
  // Get closest available sample
  const sampleNote = getClosestSampleForNote(midiNote);

  // Map velocity (0-127) to velocity layer (1-16)
  const velocityLayer = Math.max(1, Math.min(16, Math.ceil((velocity / 127) * 16)));

  // Use middle velocity for general playback
  return `piano/${sampleNote}v${velocityLayer}.wav`;
}

/**
 * Get the closest available sample for a MIDI note.
 * Returns the MIDI note number of the closest sample.
 */
export function getClosestSampleNote(midiNote: number): number {
  const sampleName = getClosestSampleForNote(midiNote);
  return SAMPLE_NOTES[sampleName] || 60; // Default to C4
}

/**
 * Generate a sample mapping for all notes in a lesson.
 * Maps each MIDI note to the appropriate piano sample file.
 */
export function generateSampleMapping(notes: number[]): { [note: number]: string } {
  const mapping: { [note: number]: string } = {};
  const uniqueNotes = [...new Set(notes)];

  for (const note of uniqueNotes) {
    // Use middle velocity (v8) for the base sample
    mapping[note] = midiNoteToSampleFilename(note, 64);
  }

  return mapping;
}

/**
 * Convert a MIDI file to a Lesson object.
 */
export async function midiToLesson(
  midiData: ArrayBuffer,
  filename: string,
  options: {
    maxNotes?: number;
    trackIndex?: number;
    simplifyToMelody?: boolean;
  } = {}
): Promise<Lesson> {
  const midi = new Midi(midiData);
  const { maxNotes = 500, trackIndex, simplifyToMelody = false } = options;

  // Get the title from filename (remove .mid extension and clean up)
  const title = filename
    .replace(/\.mid$/i, '')
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Generate a URL-safe ID
  const id = filename
    .replace(/\.mid$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  // Collect all notes from tracks
  let allNotes: Array<{
    time: number;
    midi: number;
    duration: number;
    velocity: number;
  }> = [];

  // Get BPM from the first tempo event, default to 120
  const bpm = midi.header.tempos.length > 0 ? midi.header.tempos[0].bpm : 120;

  // If trackIndex is specified, only use that track
  const tracks = trackIndex !== undefined
    ? [midi.tracks[trackIndex]].filter(Boolean)
    : midi.tracks;

  for (const track of tracks) {
    for (const note of track.notes) {
      allNotes.push({
        time: note.time,
        midi: note.midi,
        duration: note.duration,
        velocity: Math.round(note.velocity * 127),
      });
    }
  }

  // Sort by time
  allNotes.sort((a, b) => a.time - b.time);

  // If simplifyToMelody is true, keep only the highest note at each time
  if (simplifyToMelody) {
    const groupedByTime = new Map<number, typeof allNotes>();
    for (const note of allNotes) {
      const timeKey = Math.round(note.time * 1000); // Group by millisecond
      if (!groupedByTime.has(timeKey)) {
        groupedByTime.set(timeKey, []);
      }
      groupedByTime.get(timeKey)!.push(note);
    }

    allNotes = [];
    for (const notes of groupedByTime.values()) {
      // Keep highest note (melody is usually on top)
      const highest = notes.reduce((a, b) => a.midi > b.midi ? a : b);
      allNotes.push(highest);
    }
    allNotes.sort((a, b) => a.time - b.time);
  }

  // Limit notes if needed
  if (allNotes.length > maxNotes) {
    allNotes = allNotes.slice(0, maxNotes);
  }

  // Convert to lesson steps
  // Use 480 ticks per quarter note (standard)
  const ticksPerSecond = (bpm / 60) * 480;

  const steps: LessonStep[] = allNotes.map((note, index) => ({
    tick: Math.round(note.time * ticksPerSecond),
    note: note.midi,
    dur: Math.max(60, Math.round(note.duration * ticksPerSecond)), // Minimum 60 ticks
    velocity: note.velocity,
    lane: index % 8, // Distribute across 8 lanes for visualization
  }));

  // Calculate the end tick for looping
  const lastStep = steps[steps.length - 1];
  const endTick = lastStep ? lastStep.tick + lastStep.dur + 480 : 1920; // Add one quarter note padding

  // Generate sample mapping for all notes used
  const noteNumbers = steps.map(s => s.note);
  const samples = generateSampleMapping(noteNumbers);

  // Estimate difficulty based on note density and range
  const noteRange = Math.max(...noteNumbers) - Math.min(...noteNumbers);
  const noteDensity = steps.length / (endTick / 480); // Notes per quarter note
  const difficulty = Math.min(10, Math.max(1, Math.round(
    (noteRange / 24) * 3 + (noteDensity * 2)
  )));

  return {
    id,
    title,
    instrument: 'keys',
    bpm: Math.round(bpm),
    timeSignature: {
      numerator: midi.header.timeSignatures[0]?.timeSignature[0] || 4,
      denominator: midi.header.timeSignatures[0]?.timeSignature[1] || 4,
    },
    steps,
    loop: {
      startTick: 0,
      endTick,
    },
    samples,
    metadata: {
      difficulty,
      genre: 'Classical',
      tags: ['piano', 'midi-import'],
      description: `${title} - ${steps.length} notes`,
    },
  };
}

/**
 * Parse MIDI file from a URL or path.
 */
export async function loadMidiFile(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load MIDI file: ${response.statusText}`);
  }
  return response.arrayBuffer();
}
