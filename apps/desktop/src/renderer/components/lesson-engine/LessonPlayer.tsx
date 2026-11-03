import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import * as Tone from 'tone';
import { LessonEngine, LessonEngineState } from './LessonEngine';
import { Lesson, LessonStep, HitFeedback, LessonScore, PracticeModeSettings } from '../../types/lesson';
import { MidiEvent, DeviceMapping } from '../../types/electron';
import { NoteHighway, HighwayMode, JamNote } from './NoteHighway';
import { JamSettingsPanel } from './JamSettingsPanel';
import { JamTrackGrid } from './JamTrackGrid';
import { JAM_TRACKS, jamTrackFor, jamTrackParts, type JamTrackNote } from './jamTracks';
import { renderJamBackingPart, renderJamSound } from './jamRenderer';
import {
  JamBackingMixer,
  defaultJamTrackMix,
  jamTrackLevels,
  loadJamBackingMixer,
  type BackingPlayer,
  type JamTrackMix,
} from './jamBackingMixer';
import {
  loadJamReferenceSounds,
  DEFAULT_JAM_EFFECTS,
  JAM_ECHO_BEATS,
  type JamSoundPreset,
  type JamSampleSound,
  type JamSynthPatch,
  type JamEffects,
} from './jamSynth';
import { holdToleranceMs, isHoldStep, stepDurationMs } from './holdNotes';
import './LessonPlayer.css';

interface LessonPlayerProps {
  lesson: Lesson;
  onComplete?: () => void;
  // Jam tab: the highway is always in jam mode and always running
  jamOnly?: boolean;
  // Jam tab: synth sounds and drum kits to choose from in the sidebar; the first is the default
  jamSounds?: JamSoundPreset[];
  // Jam tab: songs (backing tracks) to choose from in the sidebar; `lesson` is the default
  jamSongs?: Lesson[];
}

const MIN_EFFECTIVE_SPEED = 0.01;

// Jam mode quantizes every note to the 16th grid. A hit this soon after a 16th
// still sounds on it (immediately); later hits wait for the next 16th.
const JAM_LATE_GRACE_S = 0.03;
// Jam dots older than this have scrolled off the highway
const JAM_NOTE_LIFETIME_MS = 4000;
// A held pointer in jam mode replays its pitch this many times per bar (4/4),
// or 3/2 as many as triplets, scheduled this far ahead on the audio clock.
// Holding number key 1-4 plays the ship's row at the matching rate.
const JAM_HOLD_DIVISIONS = [4, 8, 16, 32];
const JAM_HOLD_KEYS: Record<string, number> = { '1': 4, '2': 8, '3': 16, '4': 32 };
const DEFAULT_JAM_HOLD_DIVISION = 16;
const JAM_HOLD_LOOKAHEAD_S = 0.1;

// Jam tab volumes: the backing track tops out about 6 dB louder than in
// lessons (x1.3 on -2 dB) and the played notes start below it, so the groove
// stays clearly audible
const JAM_BACKING_TOP_DB = -2 + 20 * Math.log10(1.3);
const DEFAULT_JAM_NOTES_VOLUME = 0.75;
// Phone screens, upright (narrow) or sideways (short), in px: match the media
// query in LessonPlayer.css
const JAM_PHONE_WIDTH = 700;
const JAM_PHONE_HEIGHT = 500;

// Jam tab settings remembered in this browser: chosen song, chosen sound,
// edited synth settings per sound, and the effects. Only edited patches are
// stored, so changes to the presets reach every browser.
interface JamSettings {
  songId: string;
  soundId: string;
  patches: Record<string, JamSynthPatch>;
  effects: JamEffects;
  // Backing tracks edited in the grid, and their mixer settings, by file
  tracks: Record<string, JamTrackEdit>;
  mixes: Record<string, JamTrackMix>;
}

// An edited backing track: its notes, one list per part, and the grid
// resolution picked per row (cells per bar; null keeps the coarsest that fits)
export interface JamTrackEdit {
  parts: JamTrackNote[][];
  divisions: (number | null)[];
}

// Edits that no longer match their track's parts are left out
function validTrackEdits(saved: unknown): Record<string, JamTrackEdit> {
  if (!saved || typeof saved !== 'object') return {};
  return Object.fromEntries(
    Object.entries(saved as Record<string, JamTrackEdit>).filter(([file, edit]) => {
      const track = JAM_TRACKS.find((candidate) => candidate.file === file);
      const partCount = track ? track.drums.length + track.layers.length : -1;
      return Array.isArray(edit?.parts) && edit.parts.length === partCount && Array.isArray(edit.divisions);
    })
  );
}
// Mixes that no longer match their track's parts are left out
function validTrackMixes(saved: unknown): Record<string, JamTrackMix> {
  if (!saved || typeof saved !== 'object') return {};
  return Object.fromEntries(
    Object.entries(saved as Record<string, JamTrackMix>).filter(([file, mix]) => {
      const track = JAM_TRACKS.find((candidate) => candidate.file === file);
      const partCount = track ? track.drums.length + track.layers.length : -1;
      return [mix?.levels, mix?.mutes, mix?.solos].every((list) => Array.isArray(list) && list.length === partCount);
    })
  );
}
const JAM_SETTINGS_KEY = 'melodics.jamSettings.v1';

const presetPatches = (sounds: JamSoundPreset[]): Record<string, JamSynthPatch> =>
  Object.fromEntries(sounds.flatMap((sound) => ('patch' in sound ? [[sound.id, sound.patch]] : [])));

function loadJamSettings(sounds: JamSoundPreset[], songIds: string[]): JamSettings {
  const presets = presetPatches(sounds);
  const defaults: JamSettings = {
    songId: songIds[0],
    soundId: sounds[0].id,
    patches: presets,
    effects: DEFAULT_JAM_EFFECTS,
    tracks: {},
    mixes: {},
  };
  try {
    const saved = JSON.parse(localStorage.getItem(JAM_SETTINGS_KEY) ?? 'null') as Partial<JamSettings> | null;
    if (!saved) return defaults;
    return {
      songId: typeof saved.songId === 'string' && songIds.includes(saved.songId) ? saved.songId : defaults.songId,
      // A reference sound id is kept too; it is checked once the reference list loads
      soundId: typeof saved.soundId === 'string' ? saved.soundId : defaults.soundId,
      patches: Object.fromEntries(
        Object.entries(presets).map(([id, patch]) => [id, { ...patch, ...saved.patches?.[id] }])
      ),
      effects: { ...DEFAULT_JAM_EFFECTS, ...saved.effects },
      tracks: validTrackEdits(saved.tracks),
      mixes: validTrackMixes(saved.mixes),
    };
  } catch {
    return defaults; // storage unavailable: start from the presets
  }
}

function saveJamSettings(settings: JamSettings, sounds: JamSoundPreset[]) {
  const presets = presetPatches(sounds);
  const edited = Object.entries(settings.patches).filter(
    ([id, patch]) => JSON.stringify(patch) !== JSON.stringify(presets[id])
  );
  try {
    localStorage.setItem(JAM_SETTINGS_KEY, JSON.stringify({ ...settings, patches: Object.fromEntries(edited) }));
  } catch {
    // storage unavailable: settings last for this visit only
  }
}

// Lesson audio is either a file under the app's /audio/ folder or already a
// full URL (blob: for files read from a picked Ableton project folder).
const audioUrl = (path: string): string => (/^(blob|https?):/.test(path) ? path : `/audio/${path}`);

// The sounds a player switched off are remembered per lesson in this browser.
// The lane list is part of the record, so a re-analysed lesson (whose lanes
// may now mean different sounds) starts with every sound on again.
const disabledSoundsKey = (lessonId: string) => `melodics:disabled-sounds:${lessonId}`;

function laneSignature(lesson: Lesson, notes: number[]): string {
  return notes.map((note) => `${note}=${lesson.laneLabels?.[note] ?? ''}`).join(',');
}

function loadDisabledNotes(lesson: Lesson, notes: number[]): Set<number> {
  try {
    const raw = localStorage.getItem(disabledSoundsKey(lesson.id));
    if (!raw) return new Set();
    const saved = JSON.parse(raw) as { lanes: string; disabled: number[] };
    if (saved.lanes !== laneSignature(lesson, notes)) return new Set();
    const disabled = new Set(saved.disabled.filter((note) => notes.includes(note)));
    return disabled.size < notes.length ? disabled : new Set();
  } catch {
    return new Set();
  }
}

function saveDisabledNotes(lesson: Lesson, notes: number[], disabled: Set<number>): void {
  try {
    localStorage.setItem(
      disabledSoundsKey(lesson.id),
      JSON.stringify({ lanes: laneSignature(lesson, notes), disabled: [...disabled] })
    );
  } catch {
    // storage unavailable (private mode): the choice just isn't remembered
  }
}

export function LessonPlayer({ lesson: lessonArg, onComplete, jamOnly = false, jamSounds, jamSongs }: LessonPlayerProps) {
  // Jam tab: the chosen song, synth sound, its (editable) settings and the
  // effects, remembered between visits
  const [jamSettings, setJamSettings] = useState<JamSettings | null>(() =>
    jamSounds?.length ? loadJamSettings(jamSounds, [lessonArg.id, ...(jamSongs ?? []).map((song) => song.id)]) : null
  );
  // Switching songs swaps the lesson in place, so volumes and the sidebar stay as they are
  const lessonProp = jamSongs?.find((song) => song.id === jamSettings?.songId) ?? lessonArg;
  useEffect(() => {
    if (jamSettings && jamSounds) saveJamSettings(jamSettings, jamSounds);
  }, [jamSettings, jamSounds]);
  const jamPatch = jamSettings ? jamSettings.patches[jamSettings.soundId] : undefined;
  const jamKitPreset = jamSounds?.find((sound) => sound.id === jamSettings?.soundId);
  const jamKit = jamKitPreset && 'kit' in jamKitPreset ? jamKitPreset.kit : undefined;

  // Jam tab: recorded reference sounds on this machine, if any
  const [jamReferenceSounds, setJamReferenceSounds] = useState<JamSampleSound[] | null>(null);
  useEffect(() => {
    if (!jamOnly) return;
    let cancelled = false;
    loadJamReferenceSounds()
      .then((sounds) => {
        if (!cancelled) setJamReferenceSounds(sounds);
      })
      .catch((err) => {
        console.error('[LessonPlayer] Could not load the jam reference sounds list:', err);
        if (!cancelled) setJamReferenceSounds([]);
      });
    return () => {
      cancelled = true;
    };
  }, [jamOnly]);
  const jamReference = jamReferenceSounds?.find((sound) => sound.id === jamSettings?.soundId);
  // A remembered reference sound that is no longer on this machine: back to the first preset
  useEffect(() => {
    if (!jamSettings || !jamSounds?.length || jamReferenceSounds === null) return;
    if (!jamSettings.patches[jamSettings.soundId] && !jamKit && !jamReference) {
      setJamSettings({ ...jamSettings, soundId: jamSounds[0].id });
    }
  }, [jamSettings, jamSounds, jamReferenceSounds, jamReference, jamKit]);

  // The chosen synth sound or kit is rendered into one clip per note,
  // re-rendered shortly after its settings stop changing
  const [jamSamples, setJamSamples] = useState<{ [note: number]: string } | undefined>(undefined);
  useEffect(() => {
    if (jamReference) setJamSamples(jamReference.samples);
  }, [jamReference]);
  useEffect(() => {
    const source = jamKit ? { kit: jamKit } : jamPatch ? { patch: jamPatch } : null;
    if (!source) return;
    const notes = Array.from(new Set(lessonProp.steps.map((s) => s.note)));
    let cancelled = false;
    const timer = setTimeout(() => {
      renderJamSound(source, notes).then(
        (samples) => {
          if (cancelled) Object.values(samples).forEach((url) => URL.revokeObjectURL(url));
          else setJamSamples(samples);
        },
        (err) => console.error('[LessonPlayer] Could not render the jam sound:', err)
      );
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [jamPatch, jamKit, lessonProp.steps]);
  // Free replaced clips once their players have been swapped out
  useEffect(
    () => () => {
      if (jamSamples) {
        const blobs = Object.values(jamSamples).filter((url) => url.startsWith('blob:'));
        setTimeout(() => blobs.forEach((url) => URL.revokeObjectURL(url)), 2000);
      }
    },
    [jamSamples]
  );
  const fullLesson = useMemo<Lesson>(
    () => (jamSamples ? { ...lessonProp, samples: jamSamples } : lessonProp),
    [lessonProp, jamSamples]
  );

  // Sounds (lanes) the player switched off are removed from the practice
  // entirely: off the highway, not scored, never auto-played, and their pad
  // is silent. Everything below plays and scores `lesson`, the practice
  // lesson; only key bindings and the sound list use the full lesson, so
  // switching a sound off never moves the other sounds to different keys.
  const allLaneNotes = useMemo(
    () => Array.from(new Set(fullLesson.steps.map((s) => s.note))).sort((a, b) => a - b),
    [fullLesson.steps]
  );
  const [disabledNotes, setDisabledNotes] = useState<Set<number>>(() =>
    loadDisabledNotes(fullLesson, allLaneNotes)
  );
  useEffect(() => {
    setDisabledNotes(loadDisabledNotes(fullLesson, allLaneNotes));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullLesson.id]);
  const lesson = useMemo<Lesson>(
    () =>
      disabledNotes.size === 0
        ? fullLesson
        : { ...fullLesson, steps: fullLesson.steps.filter((step) => !disabledNotes.has(step.note)) },
    [fullLesson, disabledNotes]
  );

  const engineRef = useRef<LessonEngine | null>(null);
  const [state, setState] = useState<LessonEngineState>('stopped');
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [showCompletion, setShowCompletion] = useState<boolean>(false);
  const [finalScore, setFinalScore] = useState<LessonScore | null>(null);
  const [deviceMapping, setDeviceMapping] = useState<DeviceMapping | null>(null);
  const [score, setScore] = useState<LessonScore>({
    totalSteps: 0,
    hits: 0,
    misses: 0,
    perfectHits: 0,
    goodHits: 0,
    accuracy: 0,
    totalPoints: 0,
    maxPoints: 0,
  });
  const [recentFeedback, setRecentFeedback] = useState<HitFeedback[]>([]);
  const [lastMidiNote, setLastMidiNote] = useState<number | null>(null);
  const [midiActivity, setMidiActivity] = useState<boolean>(false);
  const [activePads, setActivePads] = useState<Set<number>>(new Set());
  const [practiceMode, setPracticeMode] = useState<PracticeModeSettings>({
    loopEnabled: true,
    speedMultiplier: 1.0,
    autoBpmEnabled: false,
    autoBpmStartSpeed: 0.5,
    autoBpmIncrementSteps: 0.1,
    waitModeEnabled: false,
  });

  // Current mode tab: free (default), wait, play, or jam
  const [currentMode, setCurrentMode] = useState<HighwayMode>(jamOnly ? 'jam' : 'free');
  // Jam mode: free play over the pulse. Notes snap to the next 16th and are
  // drawn as dots on their pitch row, scrolling away from the line.
  const [jamNotes, setJamNotes] = useState<JamNote[]>([]);
  const jamStartRef = useRef<number | null>(null); // Tone time the jam clock started at
  const jamNoteIdRef = useRef<number>(0);
  const jamNotesRef = useRef<JamNote[]>([]); // Mirrors jamNotes so input never reads a stale list
  // The repeating pitch, its spacing and next position (in 16ths)
  const jamHoldRef = useRef<{ note: number; step: number; nextSlot: number } | null>(null);
  const jamHoldTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const jamPointerNoteRef = useRef<number | null>(null); // Row under a held pointer
  const jamCursorNoteRef = useRef<number | null>(null); // Row the ship is on
  // Jam tab: how often a held note repeats, in notes per bar, straight or as triplets
  const [jamHoldDivision, setJamHoldDivision] = useState<number>(DEFAULT_JAM_HOLD_DIVISION);
  const jamHoldDivisionRef = useRef<number>(DEFAULT_JAM_HOLD_DIVISION);
  jamHoldDivisionRef.current = jamHoldDivision;
  const [jamHoldTriplet, setJamHoldTriplet] = useState<boolean>(false);
  const jamHoldTripletRef = useRef<boolean>(false);
  jamHoldTripletRef.current = jamHoldTriplet;
  // Jam tab: the highway, or the backing track drawn as a step grid
  const [jamView, setJamView] = useState<'highway' | 'grid'>('highway');
  // Jam tab paused, and how far it had played when it was (seconds)
  const [jamPaused, setJamPaused] = useState<boolean>(false);
  const jamResumeAtRef = useRef<number>(0);
  // Rates of the number keys held down, latest last; the latest one is used
  const [jamKeyDivisions, setJamKeyDivisions] = useState<number[]>([]);
  const jamKeyDivisionsRef = useRef<number[]>([]);
  // Track current step index for wait mode
  const [waitModeStepIndex, setWaitModeStepIndex] = useState<number>(0);
  // Track played notes for free/wait modes
  const [playedNotes, setPlayedNotes] = useState<Set<number>>(new Set());
  // Track if we're in actual game mode (fullscreen with countdown) vs practice
  const [isGameMode, setIsGameMode] = useState<boolean>(false);
  // Track if highway lanes are collapsed to single line (practice modes only)
  const [isCollapsed, setIsCollapsed] = useState<boolean>(false);
  // Label display mode: 'letters' shows key bindings, 'numbers' shows note order
  const [labelMode, setLabelMode] = useState<'letters' | 'numbers'>('letters');
  // Show/hide key settings panel
  const [showKeySettings, setShowKeySettings] = useState<boolean>(false);
  // Game mode settings sidebar
  const [showGameSettings, setShowGameSettings] = useState<boolean>(true); // Default open
  // Auto-play volume (0 = off, 1 = full volume)
  const [autoPlayVolume, setAutoPlayVolume] = useState<number>(0);
  // Backing track volume (0 = off, 1 = full volume)
  // Audible by default when the lesson ships with a backing track (song lessons)
  const [backingTrackVolume, setBackingTrackVolume] = useState<number>(lesson.backingTrack ? 1 : 0);
  // Metronome volume (0 = off, 1 = full volume)
  const [metronomeVolume, setMetronomeVolume] = useState<number>(0);
  // Jam tab: volume of the notes you play, and its settings sidebar
  const [jamNotesVolume, setJamNotesVolume] = useState<number>(DEFAULT_JAM_NOTES_VOLUME);
  // On a phone the sidebar would cover most of the highway, so it starts closed there
  const [showJamSettings, setShowJamSettings] = useState<boolean>(
    () => !(jamOnly && (window.innerWidth <= JAM_PHONE_WIDTH || window.innerHeight <= JAM_PHONE_HEIGHT))
  );

  // Default keys for note assignments (in order of preference)
  // Expanded to support lessons with many unique notes (up to 36 keys)
  // Using home row first, then top row, then bottom row, then numbers
  const defaultKeys = [
    // Home row (most accessible)
    'a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l',
    // Top row
    'q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p',
    // Bottom row
    'z', 'x', 'c', 'v', 'b', 'n', 'm',
    // Number row (for lessons with 26+ notes)
    '1', '2', '3', '4', '5', '6', '7', '8', '9', '0',
  ];

  // Get unique notes from the lesson (sorted by first appearance, then by MIDI value)
  const uniqueLessonNotes = allLaneNotes;

  // Generate default key-to-note mapping based on lesson notes
  const generateDefaultKeyMapping = (): { [key: string]: number } => {
    const mapping: { [key: string]: number } = {};
    uniqueLessonNotes.forEach((note, index) => {
      if (index < defaultKeys.length) {
        mapping[defaultKeys[index]] = note;
      }
    });
    return mapping;
  };

  // Key bindings state (user configurable)
  const [keyBindings, setKeyBindings] = useState<{ [key: string]: number }>(() => generateDefaultKeyMapping());

  // Update key bindings when lesson changes
  useEffect(() => {
    setKeyBindings(generateDefaultKeyMapping());
  }, [lesson.id]);

  // Reverse mapping: note-to-key for displaying inside notes
  const noteToKeyMap: { [note: number]: string } = Object.entries(keyBindings).reduce(
    (acc, [key, note]) => ({ ...acc, [note]: key.toUpperCase() }),
    {} as { [note: number]: string }
  );

  useEffect(() => {
    // Load device mappings and ensure MIDI device is connected
    loadDeviceMappings();
    ensureMidiConnected();
  }, []);

  const ensureMidiConnected = async () => {
    try {
      if (!window.electronAPI) return;

      // Get available MIDI devices
      const devices = await window.electronAPI.midi.list();
      console.log('[LessonPlayer] Available MIDI devices:', devices);

      if (devices.length > 0) {
        // Connect to the first device if not already connected
        console.log('[LessonPlayer] Connecting to MIDI device:', devices[0].name);
        await window.electronAPI.midi.selectDevice(devices[0].id);
        console.log('[LessonPlayer] MIDI device connected successfully');
      } else {
        console.warn('[LessonPlayer] No MIDI devices available');
      }
    } catch (err) {
      console.error('[LessonPlayer] Failed to connect MIDI device:', err);
    }
  };

  const loadDeviceMappings = async () => {
    try {
      if (!window.electronAPI) return;
      const mappings = await window.electronAPI.mapping.getAll();
      // Use the first mapping found (in a real app, you'd select based on connected device)
      if (mappings.length > 0) {
        console.log('[LessonPlayer] Loaded device mapping:', mappings[0]);
        setDeviceMapping(mappings[0]);
      } else {
        console.log('[LessonPlayer] No device mappings found');
      }
    } catch (err) {
      console.error('[LessonPlayer] Failed to load device mappings:', err);
    }
  };

  const translateMidiNote = (hardwareNote: number): number => {
    if (!deviceMapping) {
      // No mapping configured, use raw MIDI note
      return hardwareNote;
    }
    // Translate hardware note to lesson note using mapping
    const lessonNote = deviceMapping.mappings[hardwareNote];
    if (lessonNote !== undefined) {
      console.log(`[LessonPlayer] Translated MIDI ${hardwareNote} -> Lesson ${lessonNote}`);
      return lessonNote;
    }
    // No mapping for this note, pass through
    console.log(`[LessonPlayer] No mapping for MIDI ${hardwareNote}, using raw note`);
    return hardwareNote;
  };

  // Initialize Tone.js synth for pad sounds
  const synthRef = useRef<any>(null);
  const SAMPLE_PLAYER_POOL_SIZE = 8;
  // Sample players for lessons with audio samples (individual samples like drums)
  const samplePlayersRef = useRef<{ [note: number]: Tone.Player[] }>({});
  const nextSamplePlayerRef = useRef<{ [note: number]: number }>({});
  // Piano sampler for pitch-shifted piano playback
  const pianoSamplerRef = useRef<Tone.Sampler | null>(null);
  const [samplesLoaded, setSamplesLoaded] = useState<boolean>(false);
  // Track if lesson uses piano samples (needs Sampler) vs individual samples (needs Players)
  const [usesPianoSampler, setUsesPianoSampler] = useState<boolean>(false);
  // Metronome synth
  const metronomeRef = useRef<Tone.MembraneSynth | null>(null);
  // interval (fixed-BPM click) or timeout (beat-grid click); timer ids share one
  // pool, so clearInterval cancels either
  const metronomeLoopRef = useRef<number | null>(null);
  // Backing track player
  const backingTrackRef = useRef<BackingPlayer | null>(null);
  const [backingTrackLoaded, setBackingTrackLoaded] = useState<boolean>(false);
  // Song lessons: pooled players for triggering overlapping regions of the stem file.
  const stemPlayersRef = useRef<Tone.Player[]>([]);
  const lastSliceRef = useRef<{ offset: number; at: number } | null>(null);

  // Hold notes whose key is down, by lesson note. Their sound stops on
  // release unless the hold already reached its end (`done`).
  interface HeldNote {
    stepIndex: number | null; // the chart note being held, if any
    player?: Tone.Player;
    timer?: number; // free/wait modes: completes the hold at its end
    done: boolean;
  }
  const heldNotesRef = useRef<Map<number, HeldNote>>(new Map());
  const [holdingSteps, setHoldingSteps] = useState<Set<number>>(new Set());
  const setHolding = (stepIndex: number, holding: boolean) =>
    setHoldingSteps((prev) => {
      const next = new Set(prev);
      if (holding) next.add(stepIndex);
      else next.delete(stepIndex);
      return next;
    });
  const releaseAllHolds = () => {
    heldNotesRef.current.forEach((held) => window.clearTimeout(held.timer));
    heldNotesRef.current.clear();
    setHoldingSteps(new Set());
  };
  const nextStemPlayerRef = useRef<number>(0);
  const stemPlayerLoadedRef = useRef<boolean>(false);

  useEffect(() => {
    stemPlayerLoadedRef.current = false;
    nextStemPlayerRef.current = 0;
    let buffer: Tone.ToneAudioBuffer | null = null;
    let disposed = false;
    if (lesson.stemAudio) {
      // One decoded copy of the stem, shared by every voice. The voices are
      // created once it has loaded: handing Tone an unloaded buffer replaces
      // that buffer's onload callback, once per voice.
      buffer = new Tone.ToneAudioBuffer(
        audioUrl(lesson.stemAudio),
        (loaded) => {
          if (disposed) return;
          stemPlayersRef.current = Array.from({ length: 8 }, () => {
            const player = new Tone.Player(loaded).toDestination();
            player.fadeOut = 0.03; // avoid clicks at slice boundaries
            return player;
          });
          stemPlayerLoadedRef.current = true;
        },
        (err) => console.error('[LessonPlayer] Failed to load stem audio:', err)
      );
    }
    return () => {
      disposed = true;
      stemPlayersRef.current.forEach((player) => player.dispose());
      buffer?.dispose();
      stemPlayersRef.current = [];
      stemPlayerLoadedRef.current = false;
    };
  }, [lesson.id, lesson.stemAudio]);

  useEffect(() => {
    // Initialize a synth for playing pad sounds (fallback when no samples)
    synthRef.current = new Tone.PolySynth(Tone.Synth, {
      envelope: {
        attack: 0.02,
        decay: 0.1,
        sustain: 0.3,
        release: 1,
      },
    }).toDestination();
    synthRef.current.volume.value = -10;

    // Initialize metronome synth (click sound)
    metronomeRef.current = new Tone.MembraneSynth({
      pitchDecay: 0.008,
      octaves: 2,
      oscillator: { type: 'sine' },
      envelope: {
        attack: 0.001,
        decay: 0.3,
        sustain: 0,
        release: 0.1,
      },
    }).toDestination();
    metronomeRef.current.volume.value = -Infinity; // Start muted

    return () => {
      if (synthRef.current) {
        synthRef.current.dispose();
      }
      if (metronomeRef.current) {
        metronomeRef.current.dispose();
      }
    };
  }, []);

  // Jam tab: played notes run through an echo and a reverb before the output
  const jamNotesBusRef = useRef<Tone.Gain | null>(null);
  const jamEchoRef = useRef<Tone.FeedbackDelay | null>(null);
  const jamReverbRef = useRef<Tone.Reverb | null>(null);
  useEffect(() => {
    if (!jamOnly) return;
    const bus = new Tone.Gain(1);
    const echo = new Tone.FeedbackDelay();
    const reverb = new Tone.Reverb();
    bus.chain(echo, reverb, Tone.getDestination());
    jamNotesBusRef.current = bus;
    jamEchoRef.current = echo;
    jamReverbRef.current = reverb;
    return () => {
      bus.dispose();
      echo.dispose();
      reverb.dispose();
      jamNotesBusRef.current = null;
      jamEchoRef.current = null;
      jamReverbRef.current = null;
    };
  }, [jamOnly]);

  const jamEffects = jamSettings?.effects;
  useEffect(() => {
    const echo = jamEchoRef.current;
    const reverb = jamReverbRef.current;
    if (!echo || !reverb || !jamEffects) return;
    echo.wet.value = jamEffects.echoMix;
    echo.feedback.value = jamEffects.echoFeedback;
    echo.delayTime.value = (JAM_ECHO_BEATS[jamEffects.echoTime] * 60) / lessonProp.bpm;
    reverb.wet.value = jamEffects.reverbMix;
    if (reverb.decay !== jamEffects.reverbSize) reverb.decay = jamEffects.reverbSize;
  }, [jamEffects, lessonProp.bpm, jamOnly]);

  // Load audio samples when lesson has samples defined
  useEffect(() => {
    // Cleanup previous sample players
    Object.values(samplePlayersRef.current).flat().forEach(player => {
      try {
        player.dispose();
      } catch (e) {
        // Ignore disposal errors
      }
    });
    samplePlayersRef.current = {};
    nextSamplePlayerRef.current = {};

    // Cleanup previous piano sampler
    if (pianoSamplerRef.current) {
      try {
        pianoSamplerRef.current.dispose();
      } catch (e) {
        // Ignore disposal errors
      }
      pianoSamplerRef.current = null;
    }

    setSamplesLoaded(false);
    setUsesPianoSampler(false);

    console.log('[LessonPlayer] Sample loading effect triggered:', {
      lessonId: lesson.id,
      hasSamples: !!lesson.samples,
      samplesCount: lesson.samples ? Object.keys(lesson.samples).length : 0,
      hasElectronAPI: !!window.electronAPI,
      hasAudioAPI: !!window.electronAPI?.audio,
    });

    if (lesson.samples) {
      console.log('[LessonPlayer] Loading audio samples for lesson:', lesson.id);
      const sampleEntries = Object.entries(lesson.samples);

      // Check if this lesson uses piano samples (files start with "piano/")
      const isPianoLesson = sampleEntries.some(([, filename]) => filename.startsWith('piano/'));

      if (isPianoLesson) {
        // Use Tone.Sampler for piano - it handles pitch shifting automatically
        console.log('[LessonPlayer] Detected piano lesson, using Tone.Sampler for pitch-shifted playback');
        setUsesPianoSampler(true);

        // Build the sample map for Tone.Sampler
        // We need to map note names (like "C4", "A3") to audio URLs
        const loadPianoSampler = async () => {
          const samplerUrls: { [note: string]: string } = {};

          // Get unique sample files (avoid loading duplicates)
          const uniqueFiles = [...new Set(sampleEntries.map(([, filename]) => filename))];

          for (const filename of uniqueFiles) {
            // Extract note name from filename like "piano/C4v8.wav" -> "C4"
            const match = filename.match(/piano\/([A-G]#?\d)v\d+\.wav/);
            if (match) {
              const noteName = match[1];
              let audioPath: string;

              if (window.electronAPI?.audio) {
                audioPath = await window.electronAPI.audio.getPath(filename);
              } else {
                audioPath = `/audio/${filename}`;
              }

              samplerUrls[noteName] = audioPath;
              console.log(`[LessonPlayer] Piano sampler: ${noteName} -> ${audioPath}`);
            }
          }

          console.log('[LessonPlayer] Creating Tone.Sampler with', Object.keys(samplerUrls).length, 'samples');

          pianoSamplerRef.current = new Tone.Sampler({
            urls: samplerUrls,
            release: 1,
            onload: () => {
              console.log('[LessonPlayer] Piano sampler loaded successfully!');
              setSamplesLoaded(true);
            },
            onerror: (err) => {
              console.error('[LessonPlayer] Piano sampler failed to load:', err);
              setSamplesLoaded(false);
            }
          }).toDestination();
          pianoSamplerRef.current.volume.value = -6;
        };

        loadPianoSampler();
      } else {
        // Use individual Tone.Player for non-piano samples (drums, synths, etc.)
        console.log('[LessonPlayer] Non-piano lesson, using individual Tone.Player instances');
        const expectedLoads = sampleEntries.length * SAMPLE_PLAYER_POOL_SIZE;
        let loadedCount = 0;
        let errorCount = 0;

        const loadSample = async (noteStr: string, filename: string) => {
          const note = parseInt(noteStr, 10);
          try {
            let audioPath: string;

            if (/^(blob|https?):/.test(filename)) {
              // already a full URL, e.g. a sample read from a picked Ableton project folder
              audioPath = filename;
            } else if (window.electronAPI?.audio) {
              console.log(`[LessonPlayer] Requesting path via Electron for note ${note}, filename: "${filename}"`);
              const [baseFilename, query] = filename.split('?');
              audioPath = await window.electronAPI.audio.getPath(baseFilename);
              if (query) audioPath = `${audioPath}?${query}`;
            } else {
              console.log(`[LessonPlayer] Using browser fallback for note ${note}, filename: "${filename}"`);
              audioPath = `/audio/${filename}`;
            }
            console.log(`[LessonPlayer] Got audio path for note ${note}:`, audioPath);

            samplePlayersRef.current[note] = Array.from({ length: SAMPLE_PLAYER_POOL_SIZE }, () => {
              const player = new Tone.Player({
                url: audioPath,
                onload: () => {
                  loadedCount++;
                  if (loadedCount + errorCount === expectedLoads) {
                    console.log(`[LessonPlayer] Sample loading complete! Loaded: ${loadedCount}, Errors: ${errorCount}`);
                    setSamplesLoaded(loadedCount > 0);
                  }
                },
                onerror: (err) => {
                  console.error(`[LessonPlayer] Tone.Player failed to load sample for note ${note}:`, err);
                  errorCount++;
                  if (loadedCount + errorCount === expectedLoads) {
                    console.log(`[LessonPlayer] Sample loading complete! Loaded: ${loadedCount}, Errors: ${errorCount}`);
                    setSamplesLoaded(loadedCount > 0);
                  }
                }
              }).connect(jamNotesBusRef.current ?? Tone.getDestination());
              player.volume.value = -6;
              return player;
            });
            nextSamplePlayerRef.current[note] = 0;
            console.log(`[LessonPlayer] Player pool created for note ${note}, stored in ref`);
          } catch (err) {
            console.error(`[LessonPlayer] Error getting path for note ${note}:`, err);
            errorCount += SAMPLE_PLAYER_POOL_SIZE;
            if (loadedCount + errorCount === expectedLoads) {
              setSamplesLoaded(loadedCount > 0);
            }
          }
        };

        // Load all samples
        console.log('[LessonPlayer] Starting to load', sampleEntries.length, 'samples');
        sampleEntries.forEach(([noteStr, filename]) => {
          loadSample(noteStr, filename);
        });
      }
    } else {
      console.log('[LessonPlayer] Skipping sample loading - no samples defined');
    }

    return () => {
      Object.values(samplePlayersRef.current).flat().forEach(player => {
        try {
          player.dispose();
        } catch (e) {
          // Ignore disposal errors
        }
      });
      samplePlayersRef.current = {};
      nextSamplePlayerRef.current = {};
      if (pianoSamplerRef.current) {
        try {
          pianoSamplerRef.current.dispose();
        } catch (e) {
          // Ignore disposal errors
        }
      }
    };
  }, [lesson.id, lesson.samples]);

  // Jam: the backing track's data and its notes as edited in the grid. The
  // track is rendered live from them, and again after every edit.
  const jamTrack = jamOnly ? jamTrackFor(lesson.backingTrack) : undefined;
  const jamTrackEdit = jamTrack ? jamSettings?.tracks[jamTrack.file] : undefined;
  const jamTrackOriginal = useMemo(() => (jamTrack ? jamTrackParts(jamTrack).map((part) => part.notes) : null), [jamTrack]);
  const jamTrackNotes = jamTrackEdit?.parts ?? jamTrackOriginal;
  const jamTrackNotesRef = useRef(jamTrackNotes);
  jamTrackNotesRef.current = jamTrackNotes;
  const renderedTrackNotesRef = useRef<JamTrackNote[][] | null>(null);

  // After an edit: render the edited parts again and swap them in at the same point of the loop
  useEffect(() => {
    const mixer = backingTrackRef.current;
    if (!jamTrack || !jamTrackNotes || !backingTrackLoaded || !(mixer instanceof JamBackingMixer)) return;
    const rendered = renderedTrackNotesRef.current;
    const changed = jamTrackNotes.map((_, part) => part).filter((part) => rendered?.[part] !== jamTrackNotes[part]);
    if (!rendered || changed.length === 0) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      for (const part of changed) {
        const notes = jamTrackNotes[part];
        renderJamBackingPart(jamTrack.file, part, notes).then(
          (audio) => {
            if (cancelled || backingTrackRef.current !== mixer) return;
            mixer.replace(part, audio);
            rendered[part] = notes;
          },
          (err) => console.error('[LessonPlayer] Could not render the edited backing track:', err)
        );
      }
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [jamTrack, jamTrackNotes, backingTrackLoaded]);

  // The grid's mixer settings: levels, mutes and solos per part
  const jamSavedMix = jamTrack ? jamSettings?.mixes[jamTrack.file] : undefined;
  const jamPartCount = jamTrackNotes?.length ?? 0;
  const jamTrackMix = useMemo(
    () => (jamSavedMix ?? (jamPartCount ? defaultJamTrackMix(jamPartCount) : undefined)),
    [jamSavedMix, jamPartCount]
  );
  useEffect(() => {
    const mixer = backingTrackRef.current;
    if (jamTrackMix && mixer instanceof JamBackingMixer) mixer.setLevels(jamTrackLevels(jamTrackMix));
  }, [jamTrackMix, backingTrackLoaded]);

  // Load backing track if defined
  useEffect(() => {
    // Cleanup previous backing track
    if (backingTrackRef.current) {
      try {
        backingTrackRef.current.stop();
        backingTrackRef.current.dispose();
      } catch (e) {
        // Ignore disposal errors
      }
      backingTrackRef.current = null;
    }
    setBackingTrackLoaded(false);

    // Jam backing tracks are rendered from their notes
    const jamTrackToLoad = jamOnly ? jamTrackFor(lesson.backingTrack) : undefined;
    if (jamTrackToLoad) {
      let cancelled = false;
      const notes = jamTrackNotesRef.current!;
      loadJamBackingMixer(jamTrackToLoad, notes).then(
        (mixer) => {
          if (cancelled) {
            mixer.dispose();
            return;
          }
          mixer.volume.value = -Infinity; // Start muted
          backingTrackRef.current = mixer;
          renderedTrackNotesRef.current = [...notes];
          setBackingTrackLoaded(true);
        },
        (err) => console.error('[LessonPlayer] Could not render the backing track:', err)
      );
      return () => {
        cancelled = true;
        try {
          backingTrackRef.current?.stop();
          backingTrackRef.current?.dispose();
        } catch (e) {
          // Ignore disposal errors
        }
        backingTrackRef.current = null;
      };
    }

    if (lesson.backingTrack) {
      console.log('[LessonPlayer] Loading backing track:', lesson.backingTrack);
      const loadBackingTrack = async () => {
        try {
          let audioPath: string;
          if (window.electronAPI?.audio) {
            audioPath = await window.electronAPI.audio.getPath(lesson.backingTrack!);
          } else {
            audioPath = audioUrl(lesson.backingTrack!);
          }

          const player: Tone.Player = new Tone.Player({
            url: audioPath,
            loop: true,
            onload: () => {
              // A player replaced before it finished loading (e.g. React's
              // double mount in development) must not mark the current one loaded
              if (backingTrackRef.current !== player) return;
              console.log('[LessonPlayer] Backing track loaded successfully');
              setBackingTrackLoaded(true);
            },
            onerror: (err) => {
              console.error('[LessonPlayer] Failed to load backing track:', err);
            },
          }).toDestination();
          backingTrackRef.current = player;
          player.volume.value = -Infinity; // Start muted
        } catch (err) {
          console.error('[LessonPlayer] Error loading backing track:', err);
        }
      };
      loadBackingTrack();
    }

    return () => {
      if (backingTrackRef.current) {
        try {
          backingTrackRef.current.stop();
          backingTrackRef.current.dispose();
        } catch (e) {
          // Ignore disposal errors
        }
      }
    };
  }, [lesson.id, lesson.backingTrack, jamOnly]);

  // Update metronome volume when slider changes
  useEffect(() => {
    if (metronomeRef.current) {
      metronomeRef.current.volume.value = metronomeVolume === 0 ? -Infinity : -6 + (metronomeVolume - 1) * 20;
    }
  }, [metronomeVolume]);

  // Update backing track volume when slider changes, and once the track has loaded
  useEffect(() => {
    if (backingTrackRef.current) {
      const topDb = jamOnly ? JAM_BACKING_TOP_DB : -6;
      backingTrackRef.current.volume.value = backingTrackVolume === 0 ? -Infinity : topDb + (backingTrackVolume - 1) * 20;
    }
  }, [backingTrackVolume, backingTrackLoaded, jamOnly]);

  useEffect(() => {
    if (backingTrackRef.current) {
      backingTrackRef.current.playbackRate = Math.max(practiceMode.speedMultiplier, MIN_EFFECTIVE_SPEED);
    }
  }, [practiceMode.speedMultiplier]);

  // Metronome tick function
  const playMetronomeTick = useCallback((isDownbeat: boolean) => {
    if (metronomeRef.current && metronomeVolume > 0) {
      const note = isDownbeat ? 'C5' : 'C4'; // Higher pitch for downbeat
      metronomeRef.current.triggerAttackRelease(note, '16n');
    }
  }, [metronomeVolume]);

  const getStepTimeSeconds = useCallback((step: LessonStep): number => {
    return (step.tick / 480) * (60 / lesson.bpm);
  }, [lesson.bpm]);

  const getPlayableStepForInput = useCallback((note: number, lessonTimeSeconds: number): LessonStep | undefined => {
    const matchingSteps = lesson.steps.filter((step) => step.note === note);
    if (matchingSteps.length === 0) {
      return undefined;
    }

    return matchingSteps.reduce((closest, step) => {
      const closestDistance = Math.abs(getStepTimeSeconds(closest) - lessonTimeSeconds);
      const stepDistance = Math.abs(getStepTimeSeconds(step) - lessonTimeSeconds);
      return stepDistance < closestDistance ? step : closest;
    });
  }, [getStepTimeSeconds, lesson.steps]);

  // Start/stop metronome with game
  useEffect(() => {
    if (isGameMode && state === 'playing') {
      const speed = Math.max(practiceMode.speedMultiplier, MIN_EFFECTIVE_SPEED);
      const grid = lesson.beatGrid;

      if (grid && grid.beats.length > 0) {
        // Song lessons: tick on the detected beats, accenting real downbeats.
        // Each tick schedules the next from the engine's current position, so
        // the click stays locked to the song through pauses, loops and speed.
        const downbeats = new Set(grid.downbeats.map((t) => Math.round(t * 1000)));
        const scheduleNext = () => {
          const now = engineRef.current?.getCurrentTimeSeconds() ?? 0;
          const next = grid.beats.find((b) => b > now + 0.005);
          if (next === undefined) return;
          metronomeLoopRef.current = window.setTimeout(() => {
            playMetronomeTick(downbeats.has(Math.round(next * 1000)));
            scheduleNext();
          }, ((next - now) / speed) * 1000);
        };
        scheduleNext();
      } else {
        // Calculate interval based on BPM
        const beatInterval = (60 / (lesson.bpm * speed)) * 1000;
        const timeSignature = lesson.timeSignature || { numerator: 4, denominator: 4 };
        let beatCount = 0;

        const tick = () => {
          const isDownbeat = beatCount % timeSignature.numerator === 0;
          playMetronomeTick(isDownbeat);
          beatCount++;
        };

        // Start immediately with first tick
        tick();
        metronomeLoopRef.current = window.setInterval(tick, beatInterval);
      }

      // Start backing track if loaded
      if (backingTrackRef.current && backingTrackLoaded && backingTrackVolume > 0) {
        backingTrackRef.current.playbackRate = Math.max(practiceMode.speedMultiplier, MIN_EFFECTIVE_SPEED);
        backingTrackRef.current.start();
      }
    } else if (currentMode !== 'jam') {
      // Stop metronome
      if (metronomeLoopRef.current) {
        clearInterval(metronomeLoopRef.current);
        metronomeLoopRef.current = null;
      }
      // Stop backing track
      if (backingTrackRef.current) {
        try {
          backingTrackRef.current.stop();
        } catch (e) {
          // Ignore if not started
        }
      }
    }

    return () => {
      if (metronomeLoopRef.current) {
        clearInterval(metronomeLoopRef.current);
        metronomeLoopRef.current = null;
      }
    };
  }, [isGameMode, currentMode, state, lesson.bpm, lesson.beatGrid, lesson.timeSignature, practiceMode.speedMultiplier, playMetronomeTick, backingTrackLoaded, backingTrackVolume]);

  // Browsers only let audio start from a tap, click or key press; the jam opens
  // without one (e.g. the standalone jam app), so the first one anywhere starts it
  useEffect(() => {
    if (!jamOnly) return;
    // iPhone: play through the silent switch, like a music app
    const audioSession = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    if (audioSession) audioSession.type = 'playback';
    const unlock = () => {
      Tone.start().then(() => {
        if (Tone.getContext().state === 'running') {
          events.forEach((event) => document.removeEventListener(event, unlock, true));
        }
      });
    };
    const events = ['pointerdown', 'touchend', 'keydown'];
    events.forEach((event) => document.addEventListener(event, unlock, true));
    return () => events.forEach((event) => document.removeEventListener(event, unlock, true));
  }, [jamOnly]);

  // Jam mode clock and pulse: the backing track loops when the lesson has one,
  // otherwise a soft click marks the beats. Runs for as long as the Jam tab is open.
  useEffect(() => {
    if (currentMode !== 'jam' || jamPaused) return;

    let cancelled = false;
    let clockInterval: ReturnType<typeof setInterval> | null = null;
    let pulseInterval: ReturnType<typeof setInterval> | null = null;
    // Its level is the volume slider's job, so moving the slider never restarts the jam
    const backing = backingTrackRef.current?.loaded && backingTrackLoaded ? backingTrackRef.current : null;
    // A song with a backing track starts once it has loaded (this runs again then)
    if (lesson.backingTrack && !backing) return;

    const begin = async () => {
      await Tone.start();
      if (cancelled) return;

      // After a pause it carries on from where it stopped
      const resume = jamResumeAtRef.current;
      jamResumeAtRef.current = 0;
      const start = Tone.now() + 0.1 - resume;
      jamStartRef.current = start;

      if (backing) {
        // An edit made while the audio was locked may have swapped the player
        const player = backingTrackRef.current ?? backing;
        player.loop = true;
        player.playbackRate = 1;
        player.start(start + resume, resume);
      } else {
        const beatSeconds = 60 / lesson.bpm;
        const beatsPerBar = (lesson.timeSignature || { numerator: 4, denominator: 4 }).numerator;
        let nextBeat = Math.ceil(resume / beatSeconds);
        // Schedule clicks slightly ahead on the audio clock so they never drift
        pulseInterval = setInterval(() => {
          const horizon = Tone.now() + 0.15;
          while (start + nextBeat * beatSeconds < horizon) {
            const isDownbeat = nextBeat % beatsPerBar === 0;
            metronomeRef.current?.triggerAttackRelease(
              isDownbeat ? 'C5' : 'C4',
              '16n',
              start + nextBeat * beatSeconds,
              isDownbeat ? 0.35 : 0.2
            );
            nextBeat++;
          }
        }, 50);
      }

      clockInterval = setInterval(() => {
        setCurrentTime(Math.max(0, (Tone.now() - start) * 1000));
      }, 16);
    };
    begin();

    return () => {
      cancelled = true;
      if (clockInterval) clearInterval(clockInterval);
      if (pulseInterval) clearInterval(pulseInterval);
      // The backing may have been swapped for an edited one since it started
      for (const player of new Set([backing, backingTrackRef.current])) {
        if (!player) continue;
        try {
          player.loop = false;
          player.stop();
        } catch (e) {
          // Ignore if not started, or already disposed by a song change
        }
      }
      if (jamHoldTimerRef.current) clearInterval(jamHoldTimerRef.current);
      jamHoldTimerRef.current = null;
      jamHoldRef.current = null;
      jamStartRef.current = null;
      jamNotesRef.current = [];
      setJamNotes([]);
      setCurrentTime(0);
    };
  }, [currentMode, lesson.bpm, lesson.timeSignature, lesson.backingTrack, backingTrackLoaded, jamPaused]);

  // A new song starts from its beginning
  useEffect(() => {
    jamResumeAtRef.current = 0;
  }, [lesson.id]);

  const toggleJamPause = () => {
    if (!jamPaused && jamStartRef.current !== null) jamResumeAtRef.current = Math.max(0, Tone.now() - jamStartRef.current);
    setJamPaused(!jamPaused);
  };

  const playSound = (
    note: number,
    sampleNote?: number,
    volumeOverride?: number,
    slice?: { offset: number; duration: number },
    startTime?: number,
    semitones?: number
  ): Tone.Player | undefined => {
    // Song lessons must play the step's own region of the original stem.
    if (lesson.stemAudio) {
      if (!slice) {
        console.warn('[LessonPlayer] Song lesson step has no stem slice; refusing substitute playback.', {
          lessonId: lesson.id,
          note,
        });
        return;
      }
      if (stemPlayersRef.current.length === 0 || !stemPlayerLoadedRef.current) {
        console.warn('[LessonPlayer] Stem audio is not ready; refusing substitute playback.', {
          lessonId: lesson.id,
          note,
          slice,
        });
        return;
      }

      // Notes that start together (a chord, even strummed) share one slice of
      // the track's audio, which already contains every note: play it once.
      const now = Tone.now();
      const last = lastSliceRef.current;
      if (last && last.offset === slice.offset && now - last.at < 0.25) {
        return;
      }
      lastSliceRef.current = { offset: slice.offset, at: now };

      const idlePlayer = stemPlayersRef.current.find((candidate) => candidate.state !== 'started');
      const player = idlePlayer ?? stemPlayersRef.current[nextStemPlayerRef.current % stemPlayersRef.current.length];
      nextStemPlayerRef.current += 1;
      if (!idlePlayer && player.state === 'started') {
        player.stop();
      }
      player.volume.value =
        volumeOverride !== undefined
          ? volumeOverride === 0
            ? -Infinity
            : -6 + (volumeOverride - 1) * 20
          : -6;
      player.start(startTime, slice.offset, slice.duration);
      return player;
    }

    // The note to play (use sampleNote if provided, for lesson step matching)
    const noteToPlay = sampleNote ?? note;

    console.log('[LessonPlayer] playSound called:', {
      note,
      sampleNote,
      noteToPlay,
      usesPianoSampler,
      hasPianoSampler: !!pianoSamplerRef.current,
      isPianoSamplerLoaded: pianoSamplerRef.current?.loaded,
      hasSamplePlayer: !!samplePlayersRef.current[noteToPlay],
      samplesLoadedState: samplesLoaded,
      volumeOverride,
    });

    // For piano lessons, use the Tone.Sampler which handles pitch shifting
    if (usesPianoSampler && pianoSamplerRef.current && pianoSamplerRef.current.loaded) {
      console.log(`[LessonPlayer] Playing piano note ${noteToPlay} via Sampler`);
      // Apply volume override if provided (for auto-play)
      if (volumeOverride !== undefined) {
        pianoSamplerRef.current.volume.value = volumeOverride === 0 ? -Infinity : -6 + (volumeOverride - 1) * 20;
      } else {
        pianoSamplerRef.current.volume.value = -6;
      }
      // Convert MIDI note number to note name (e.g., 60 -> "C4")
      const noteName = Tone.Frequency(noteToPlay, 'midi').toNote();
      pianoSamplerRef.current.triggerAttackRelease(noteName, '2n', startTime);
      return;
    }

    // For non-piano lessons, use individual sample players
    const samplePool = samplePlayersRef.current[noteToPlay];
    const samplePlayer =
      samplePool?.find((candidate) => candidate.state !== 'started') ??
      samplePool?.[nextSamplePlayerRef.current[noteToPlay] % samplePool.length];
    if (samplePool?.length && samplePlayer?.loaded) {
      console.log(`[LessonPlayer] Playing sample for note ${noteToPlay}`);
      nextSamplePlayerRef.current[noteToPlay] = (nextSamplePlayerRef.current[noteToPlay] ?? 0) + 1;
      if (samplePlayer.state === 'started') {
        samplePlayer.stop();
      }
      // Apply volume override if provided (for auto-play)
      if (volumeOverride !== undefined) {
        samplePlayer.volume.value = volumeOverride === 0 ? -Infinity : -6 + (volumeOverride - 1) * 20;
      } else {
        samplePlayer.volume.value = -6;
      }
      // pooled players are reused, so always (re)set the pitch shift
      samplePlayer.playbackRate = semitones ? 2 ** (semitones / 12) : 1;
      samplePlayer.start(startTime);
      return samplePlayer;
    }

    if (lesson.metadata?.tags?.includes('song')) {
      console.warn('[LessonPlayer] Song lesson sample is not ready; refusing substitute playback.', {
        lessonId: lesson.id,
        note: noteToPlay,
      });
      return;
    }

    // Fallback to synth using the input note for pitch
    console.log(`[LessonPlayer] Falling back to synth for note ${note}`);
    if (synthRef.current) {
      // Apply volume override for synth as well
      if (volumeOverride !== undefined) {
        synthRef.current.volume.value = volumeOverride === 0 ? -Infinity : -10 + (volumeOverride - 1) * 20;
      } else {
        synthRef.current.volume.value = -10;
      }
      const midiNote = Tone.Frequency(note, 'midi').toNote();
      synthRef.current.triggerAttackRelease(midiNote, '8n', startTime);
    }
  };

  // Callback for when a note reaches the timing line (auto-play in game mode)
  const handleNoteReached = useCallback((step: LessonStep) => {
    if (autoPlayVolume > 0 && isGameMode) {
      playSound(step.note, step.note, autoPlayVolume, step.slice, undefined, step.semitones);
    }
  }, [autoPlayVolume, isGameMode]);

  // Jam rows are the lesson's pitches; any other note plays the nearest row
  const jamRows = useMemo(
    () => Array.from(new Set(lesson.steps.map((s) => s.note))).sort((a, b) => a - b),
    [lesson.steps]
  );

  // Plays the row nearest `note` at the given position in 16ths (default: the
  // next point of a grid `grid` 16ths apart) and returns that position, or null
  // when the jam clock isn't running
  const playJamNote = useCallback((note: number, atSlot?: number, grid = 1): number | null => {
    const start = jamStartRef.current;
    if (start === null || jamRows.length === 0) return null;

    const row = jamRows.reduce((nearest, candidate) =>
      Math.abs(candidate - note) < Math.abs(nearest - note) ? candidate : nearest
    );
    const step = lesson.steps.find((s) => s.note === row);
    const sixteenth = 60 / lesson.bpm / 4;
    const elapsed = Tone.now() - start;
    const slot = atSlot ?? Math.max(0, Math.ceil((elapsed - JAM_LATE_GRACE_S) / (sixteenth * grid)) * grid);
    const timeMs = slot * sixteenth * 1000;

    // The same pitch twice on one 16th sounds once
    const prev = jamNotesRef.current;
    if (prev.some((n) => n.note === row && n.timeMs === timeMs)) return slot;
    playSound(row, step?.note, jamOnly ? jamNotesVolume : undefined, step?.slice, Math.max(start + slot * sixteenth, Tone.now()), step?.semitones);
    const next = [
      ...prev.filter((n) => n.timeMs > elapsed * 1000 - JAM_NOTE_LIFETIME_MS),
      { id: ++jamNoteIdRef.current, note: row, timeMs },
    ];
    jamNotesRef.current = next;
    setJamNotes(next);
    return slot;
  }, [jamRows, lesson.steps, lesson.bpm, jamOnly, jamNotesVolume]);

  // Repeat spacing in 16ths: the latest held number key's rate, else the chosen one
  const jamHoldStep = useCallback(() => {
    const keys = jamKeyDivisionsRef.current;
    const division = keys.length ? keys[keys.length - 1] : jamHoldDivisionRef.current;
    return (16 / division) * (jamHoldTripletRef.current ? 2 / 3 : 1);
  }, []);

  // Starts, steers or stops the repeat. A held pointer plays its row, a held
  // number key the ship's row: at once (on the next 16th, or triplet), then
  // again every step. A changed rate continues on its own grid.
  const updateJamHold = useCallback(() => {
    const note = jamPointerNoteRef.current ?? (jamKeyDivisionsRef.current.length ? jamCursorNoteRef.current : null);
    if (note === null) {
      if (jamHoldTimerRef.current) clearInterval(jamHoldTimerRef.current);
      jamHoldTimerRef.current = null;
      jamHoldRef.current = null;
      return;
    }
    if (jamHoldRef.current) {
      jamHoldRef.current.note = note;
      return;
    }
    const step = jamHoldStep();
    const slot = playJamNote(note, undefined, jamHoldTripletRef.current ? Math.min(step, 2 / 3) : 1);
    if (slot === null) return;
    jamHoldRef.current = { note, step, nextSlot: slot + step };
    jamHoldTimerRef.current = setInterval(() => {
      const hold = jamHoldRef.current;
      const start = jamStartRef.current;
      if (!hold || start === null) return;
      const sixteenth = 60 / lesson.bpm / 4;
      const step = jamHoldStep();
      if (step !== hold.step) {
        const played = hold.nextSlot - hold.step;
        const now = (Tone.now() - start) / sixteenth;
        hold.nextSlot = Math.max(Math.floor(played / step + 1e-6) + 1, Math.ceil(now / step)) * step;
        hold.step = step;
      }
      while (start + hold.nextSlot * sixteenth < Tone.now() + JAM_HOLD_LOOKAHEAD_S) {
        playJamNote(hold.note, hold.nextSlot);
        hold.nextSlot += hold.step;
      }
    }, 25);
  }, [playJamNote, lesson.bpm, jamHoldStep]);

  // Pointer play on the jam highway: pressing plays the row, holding repeats
  // it, dragging changes the row
  const handleJamPointer = useCallback((note: number | null) => {
    jamPointerNoteRef.current = note;
    updateJamHold();
  }, [updateJamHold]);

  const handleJamCursorNote = useCallback((note: number) => {
    jamCursorNoteRef.current = note;
    if (jamKeyDivisionsRef.current.length) updateJamHold();
  }, [updateJamHold]);

  const setJamKeys = useCallback((divisions: number[]) => {
    jamKeyDivisionsRef.current = divisions;
    setJamKeyDivisions(divisions);
    updateJamHold();
  }, [updateJamHold]);

  // How far the backing track has played, in 16ths
  const getJamStep = useCallback(
    () => (jamStartRef.current === null ? null : (Tone.now() - jamStartRef.current) / (60 / lesson.bpm / 4)),
    [lesson.bpm]
  );

  // Shared function to handle note input from both MIDI and keyboard
  const handleNoteInput = useCallback((hardwareNote: number, timestamp: number) => {
    // Translate note
    let translatedNote = hardwareNote;
    if (deviceMapping) {
      const lessonNote = deviceMapping.mappings[hardwareNote];
      if (lessonNote !== undefined) {
        console.log(`[LessonPlayer] Translated MIDI ${hardwareNote} -> Lesson ${lessonNote}`);
        translatedNote = lessonNote;
      } else {
        console.log(`[LessonPlayer] No mapping for MIDI ${hardwareNote}, using raw note`);
      }
    }

    console.log('[LessonPlayer] Note input received:', { hardwareNote, translatedNote, currentMode });

    // a switched-off sound is out of the practice: its pad is silent and unscored
    if (disabledNotes.has(translatedNote)) {
      return;
    }

    // Visual feedback
    setLastMidiNote(hardwareNote);
    setMidiActivity(true);
    setTimeout(() => setMidiActivity(false), 100);

    // Add to active pads for visual feedback
    setActivePads((prev) => {
      const newSet = new Set(prev);
      newSet.add(translatedNote);
      return newSet;
    });

    // Handle based on current mode
    if (currentMode === 'free') {
      // Free mode: you can hear any note, but the lesson only advances when you
      // play the NEXT note in order. Target the first unplayed step (lowest index),
      // never a same-pitch note further down the track — otherwise pressing a pitch
      // that appears later would light an unrelated note ahead of the sequence.
      let nextStepIndex = -1;
      for (let i = 0; i < lesson.steps.length; i++) {
        if (!playedNotes.has(i)) {
          nextStepIndex = i;
          break;
        }
      }
      const nextStep = nextStepIndex !== -1 ? lesson.steps[nextStepIndex] : null;
      const isCorrectNext = nextStep !== null && nextStep.note === translatedNote;

      // Play sound for any note (free play). The sound comes from this pitch's
      // next appearance in the chart (the next note itself when it's correct):
      // song lessons need a step to know which moment of the recording to play.
      let soundStep: LessonStep | null = isCorrectNext ? nextStep : null;
      if (!soundStep) {
        const from = Math.max(nextStepIndex, 0);
        soundStep =
          lesson.steps.slice(from).find((step) => step.note === translatedNote) ??
          lesson.steps.find((step) => step.note === translatedNote) ??
          null;
      }
      const player = playSound(
        translatedNote,
        soundStep?.note,
        undefined,
        soundStep?.slice,
        undefined,
        soundStep?.semitones
      );

      if (soundStep && isHoldStep(lesson, soundStep)) {
        // A long sound plays only while its key is down. The next note counts
        // as played once it has been held to its end.
        const held: HeldNote = { stepIndex: isCorrectNext ? nextStepIndex : null, player, done: false };
        if (isCorrectNext) {
          const durationMs = stepDurationMs(soundStep, lesson.bpm);
          const stepIndex = nextStepIndex;
          held.timer = window.setTimeout(() => {
            held.done = true;
            setHolding(stepIndex, false);
            setPlayedNotes((prev) => {
              const next = new Set(prev).add(stepIndex);
              return next.size >= lesson.steps.length ? new Set() : next;
            });
          }, durationMs - holdToleranceMs(durationMs));
          setHolding(stepIndex, true);
        }
        heldNotesRef.current.set(translatedNote, held);
      } else if (isCorrectNext) {
        const newPlayedNotes = new Set(playedNotes).add(nextStepIndex);

        // Check if all notes are played - loop immediately for seamless play
        if (newPlayedNotes.size >= lesson.steps.length) {
          setPlayedNotes(new Set());
        } else {
          setPlayedNotes(newPlayedNotes);
        }
      }
    } else if (currentMode === 'wait') {
      // Wait mode: only play and advance if correct note
      const currentStep = lesson.steps[waitModeStepIndex];
      if (currentStep && translatedNote === currentStep.note) {
        // Correct note - play sound with the step's note for sample lookup
        const player = playSound(translatedNote, currentStep.note, undefined, currentStep.slice, undefined, currentStep.semitones);

        if (isHoldStep(lesson, currentStep)) {
          // A long sound must be held to its end before the lesson moves on
          const stepIndex = waitModeStepIndex;
          const durationMs = stepDurationMs(currentStep, lesson.bpm);
          const held: HeldNote = { stepIndex, player, done: false };
          held.timer = window.setTimeout(() => {
            held.done = true;
            setHolding(stepIndex, false);
            if (stepIndex >= lesson.steps.length - 1) {
              setPlayedNotes(new Set());
              setWaitModeStepIndex(0);
            } else {
              setPlayedNotes((prev) => new Set(prev).add(stepIndex));
              setWaitModeStepIndex(stepIndex + 1);
            }
          }, durationMs - holdToleranceMs(durationMs));
          heldNotesRef.current.set(translatedNote, held);
          setHolding(stepIndex, true);
        } else if (waitModeStepIndex >= lesson.steps.length - 1) {
          setPlayedNotes(new Set());
          setWaitModeStepIndex(0);
        } else {
          setPlayedNotes((prev) => new Set(prev).add(waitModeStepIndex));
          setWaitModeStepIndex(waitModeStepIndex + 1);
        }
      }
      // Wrong note - do nothing (no sound, no feedback)
    } else if (currentMode === 'jam') {
      playJamNote(translatedNote);
    } else {
      // Process note if engine is playing
      if (engineRef.current && engineRef.current.getState() === 'playing') {
        console.log(`[LessonPlayer] Processing note - Hardware: ${hardwareNote}, Translated: ${translatedNote}, Engine state: ${engineRef.current.getState()}, Timestamp: ${timestamp}`);
        const lessonTimeSeconds = engineRef.current.getCurrentTimeSeconds();
        const playableStep = getPlayableStepForInput(translatedNote, lessonTimeSeconds);

        if (!lesson.stemAudio || playableStep) {
          const player = playSound(translatedNote, playableStep?.note, undefined, playableStep?.slice, undefined, playableStep?.semitones);
          if (playableStep && isHoldStep(lesson, playableStep)) {
            // the engine scores the hold (onHoldStart/onHoldEnd); the sound
            // stops on release unless the hold reached its end
            heldNotesRef.current.set(translatedNote, { stepIndex: null, player, done: false });
          }
        }

        engineRef.current.processNote(translatedNote, timestamp);
      }
    }

    // Remove from active pads after animation
    setTimeout(() => {
      setActivePads((prev) => {
        const newSet = new Set(prev);
        newSet.delete(translatedNote);
        return newSet;
      });
    }, 200);
  }, [deviceMapping, currentMode, waitModeStepIndex, lesson.steps, lesson.stemAudio, playedNotes, getPlayableStepForInput, disabledNotes, playJamNote]);

  // A key or pad was released: a hold note let go before its end stops
  // sounding and does not count.
  const handleNoteRelease = useCallback((hardwareNote: number) => {
    const note = deviceMapping?.mappings[hardwareNote] ?? hardwareNote;
    const held = heldNotesRef.current.get(note);
    if (held) {
      heldNotesRef.current.delete(note);
      window.clearTimeout(held.timer);
      if (!held.done) {
        held.player?.stop();
        if (held.stepIndex !== null) setHolding(held.stepIndex, false);
      }
    }
    engineRef.current?.processNoteOff(note);
  }, [deviceMapping]);
  const handleNoteReleaseRef = useRef(handleNoteRelease);
  handleNoteReleaseRef.current = handleNoteRelease;

  useEffect(() => {
    // Initialize engine
    const engine = new LessonEngine({
      onHitFeedback: (feedback) => {
        console.log('[LessonPlayer] onHitFeedback received:', feedback);
        setRecentFeedback((prev) => [...prev.slice(-9), feedback]);
      },
      onScoreUpdate: (newScore) => {
        console.log('[LessonPlayer] onScoreUpdate received:', newScore);
        setScore(newScore);
      },
      onStateChange: (newState) => {
        console.log('[LessonPlayer] onStateChange received:', newState);
        setState(newState);
      },
      onLoop: () => {
        console.log('[LessonPlayer] Loop restarted');
      },
      onComplete: (finalScore) => {
        console.log('[LessonPlayer] onComplete received:', finalScore);
        setFinalScore(finalScore);
        setShowCompletion(true);
      },
      onHoldStart: (stepIndex, step) => {
        const held = heldNotesRef.current.get(step.note);
        if (held) held.stepIndex = stepIndex;
        setHolding(stepIndex, true);
      },
      onHoldEnd: (stepIndex, completed) => {
        if (completed) {
          // held to the end: let the sound finish even if the key is released now
          heldNotesRef.current.forEach((held) => {
            if (held.stepIndex === stepIndex) held.done = true;
          });
        }
        setHolding(stepIndex, false);
      },
    });

    engine.loadLesson(lesson);
    engine.setPracticeMode(practiceMode);
    engineRef.current = engine;

    // Set up MIDI event listener with note translation
    if (window.electronAPI) {
      window.electronAPI.midi.onEvent((event: MidiEvent) => {
        console.log('[LessonPlayer] MIDI event received:', event);

        if (event.type === 'noteon' && event.velocity > 0) {
          handleNoteInput(event.note, engineRef.current?.getCurrentTimeSeconds() ?? 0);
        } else if (event.type === 'noteoff' || (event.type === 'noteon' && event.velocity === 0)) {
          // Handle note off - remove from active pads, end any hold
          handleNoteReleaseRef.current(event.note);
          const translatedNote = translateMidiNote(event.note);
          setActivePads((prev) => {
            const newSet = new Set(prev);
            newSet.delete(translatedNote);
            return newSet;
          });
        }
      });
    }

    return () => {
      if (engineRef.current) {
        engineRef.current.stop();
      }
      if (window.electronAPI) {
        window.electronAPI.midi.removeEventListener();
      }
    };
  }, [lesson, deviceMapping]);

  useEffect(() => {
    if (engineRef.current) {
      engineRef.current.setPracticeMode(practiceMode);
    }
  }, [practiceMode]);

  // Set up keyboard event listeners
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // ESC key to stop lesson and exit game mode
      if (e.key === 'Escape') {
        e.preventDefault();
        setIsGameMode(false);
        setCurrentMode('free'); // Reset to free mode when exiting game
        if (engineRef.current && engineRef.current.getState() !== 'stopped') {
          engineRef.current.stop();
        }
        return;
      }

      // Note input keys (use dynamic keyBindings)
      const note = keyBindings[e.key.toLowerCase()];
      // Jam: an unbound number key 1-4 repeats the ship's row while held
      const holdDivision = JAM_HOLD_KEYS[e.key];
      if (currentMode === 'jam' && holdDivision && note === undefined) {
        e.preventDefault();
        if (!jamKeyDivisionsRef.current.includes(holdDivision)) setJamKeys([...jamKeyDivisionsRef.current, holdDivision]);
        return;
      }
      if (note !== undefined && !e.repeat) {
        e.preventDefault();
        handleNoteInput(note, engineRef.current?.getCurrentTimeSeconds() ?? 0);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      const holdDivision = JAM_HOLD_KEYS[e.key];
      if (holdDivision && jamKeyDivisionsRef.current.includes(holdDivision)) {
        setJamKeys(jamKeyDivisionsRef.current.filter((division) => division !== holdDivision));
      }
      const note = keyBindings[e.key.toLowerCase()];
      if (note !== undefined) {
        e.preventDefault();
        handleNoteReleaseRef.current(note);
        // Remove from active pads
        setActivePads((prev) => {
          const newSet = new Set(prev);
          newSet.delete(note);
          return newSet;
        });
      }
    };

    // Keys released while the window is in the background never send keyup
    const handleBlur = () => {
      if (jamKeyDivisionsRef.current.length) setJamKeys([]);
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, [handleNoteInput, keyBindings, currentMode, setJamKeys]);

  // Update current time from the engine's logical lesson clock. The lesson
  // duration stays fixed; speed changes how quickly this playhead advances.
  useEffect(() => {
    if (state === 'playing') {
      const interval = setInterval(() => {
        setCurrentTime((engineRef.current?.getCurrentTimeSeconds() ?? 0) * 1000);
      }, 16); // ~60fps

      return () => clearInterval(interval);
    } else if (state === 'stopped') {
      setCurrentTime(0);
    }
  }, [state, practiceMode.speedMultiplier]);

  const [showSoundSettings, setShowSoundSettings] = useState<boolean>(false);
  const soundLabel = (note: number, index: number) => fullLesson.laneLabels?.[note] ?? `Sound ${index + 1}`;

  useEffect(() => {
    resetRunState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabledNotes]);

  // Switch a sound in or out of the practice. Not while notes are running:
  // the scored notes change, so the run resets (like Restart).
  const toggleSound = (note: number) => {
    if (state === 'playing') return;
    const next = new Set(disabledNotes);
    if (next.has(note)) {
      next.delete(note);
    } else if (next.size < allLaneNotes.length - 1) {
      next.add(note); // at least one sound always stays on
    } else {
      return;
    }
    saveDisabledNotes(fullLesson, allLaneNotes, next);
    setDisabledNotes(next);
  };

  const renderSoundToggles = () => (
    <div className="sound-toggle-list">
      {allLaneNotes.map((note, index) => {
        const on = !disabledNotes.has(note);
        const lastOn = on && disabledNotes.size === allLaneNotes.length - 1;
        return (
          <button
            key={note}
            className={`sound-toggle ${on ? 'on' : 'off'}`}
            onClick={() => toggleSound(note)}
            disabled={state === 'playing' || lastOn}
            title={
              state === 'playing'
                ? 'Pause to change sounds'
                : lastOn
                  ? 'At least one sound stays on'
                  : on
                    ? 'Remove this sound from the practice'
                    : 'Add this sound back'
            }
          >
            <kbd>{noteToKeyMap[note] ?? '–'}</kbd>
            <span className="sound-toggle-label">{soundLabel(note, index)}</span>
            <span className="sound-toggle-state">{on ? 'On' : 'Off'}</span>
          </button>
        );
      })}
    </div>
  );

  const resetRunState = () => {
    releaseAllHolds();
    setPlayedNotes(new Set());
    setWaitModeStepIndex(0);
    setRecentFeedback([]);
    setActivePads(new Set());
    setCurrentTime(0);
    setScore({
      totalSteps: lesson.steps.length,
      hits: 0,
      misses: 0,
      perfectHits: 0,
      goodHits: 0,
      accuracy: 0,
      totalPoints: 0,
      maxPoints: lesson.steps.length * 100,
    });
  };

  const handleStart = async () => {
    // Stop any current playback first
    if (engineRef.current) {
      engineRef.current.stop();
    }

    // Reset state for game mode
    resetRunState();

    // Switch to play mode for proper time-based scrolling
    setCurrentMode('play');

    // Set game mode speed (full speed for actual game)
    setPracticeMode((prev) => ({ ...prev, speedMultiplier: 1.0, loopEnabled: false }));

    // Reload the lesson to ensure clean state
    if (engineRef.current) {
      engineRef.current.loadLesson(lesson);
    }

    // Enter actual game mode (fullscreen, countdown)
    setIsGameMode(true);
    // Start countdown before lesson begins
    setCountdown(3);

    const countdownInterval = setInterval(() => {
      setCountdown((prev) => {
        if (prev === null) return null;
        if (prev <= 1) {
          clearInterval(countdownInterval);
          // Start the lesson after countdown
          if (engineRef.current) {
            engineRef.current.start();
          }
          return null;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const handleSpeedChange = (speed: number) => {
    const clampedSpeed = Math.max(0, Math.min(2, speed));
    setPracticeMode((prev) => ({ ...prev, speedMultiplier: clampedSpeed }));
  };

  // Handle mode tab change
  const handleModeChange = async (mode: HighwayMode) => {
    // Stop any current playback when switching modes
    if (engineRef.current && engineRef.current.getState() !== 'stopped') {
      engineRef.current.stop();
    }
    // Exit game mode when switching tabs
    setIsGameMode(false);
    // Reset state for the new mode
    setPlayedNotes(new Set());
    setWaitModeStepIndex(0);
    setRecentFeedback([]);
    setCurrentMode(mode);

    // Play mode practice: start engine directly at 50% speed, no countdown
    if (mode === 'play') {
      setPracticeMode((prev) => ({ ...prev, loopEnabled: true, speedMultiplier: 0.5 }));
      // Start engine directly without countdown for practice
      setTimeout(async () => {
        if (engineRef.current) {
          await engineRef.current.start();
        }
      }, 100);
    }
  };

  const handleReplay = async () => {
    setShowCompletion(false);
    setFinalScore(null);
    await handleStart();
  };

  const handleContinue = () => {
    if (onComplete) {
      onComplete();
    }
  };

  // Game mode control handlers
  const handleGameBack = () => {
    // Stop the game and go back to lesson selection
    if (engineRef.current) {
      engineRef.current.stop();
    }
    setIsGameMode(false);
    if (onComplete) {
      onComplete();
    }
  };

  const handleGamePlayPause = () => {
    if (!engineRef.current) return;

    if (state === 'playing') {
      engineRef.current.pause();
    } else if (state === 'paused') {
      engineRef.current.resume();
    }
  };

  const handleGameRestart = async () => {
    // Stop current playback
    if (engineRef.current) {
      engineRef.current.stop();
    }

    // Reset score and feedback
    resetRunState();

    // Reload the lesson
    if (engineRef.current) {
      engineRef.current.loadLesson(lesson);
    }

    // Restart with countdown
    setCountdown(3);
    const countdownInterval = setInterval(() => {
      setCountdown((prev) => {
        if (prev === null) return null;
        if (prev <= 1) {
          clearInterval(countdownInterval);
          if (engineRef.current) {
            engineRef.current.start();
          }
          return null;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const getAccuracyColor = (accuracy: number): string => {
    if (accuracy >= 90) return '#4ade80'; // green
    if (accuracy >= 75) return '#facc15'; // yellow
    if (accuracy >= 60) return '#fb923c'; // orange
    return '#f87171'; // red
  };

  const getFeedbackColor = (feedback: HitFeedback): string => {
    switch (feedback.accuracy) {
      case 'perfect':
        return '#4ade80';
      case 'good':
        return '#facc15';
      case 'early':
      case 'late':
        return '#fb923c';
      case 'miss':
        return '#f87171';
      default:
        return '#ffffff';
    }
  };

  return (
    <div className={`lesson-player ${jamOnly ? 'jam-only' : ''}`}>
      {/* Countdown Overlay */}
      {countdown !== null && (
        <div className="countdown-overlay">
          <div className="countdown-number">
            {countdown === 0 ? 'GO!' : countdown}
          </div>
        </div>
      )}

      {/* Completion Screen */}
      {showCompletion && finalScore && (
        <div className="completion-overlay">
          <div className="completion-screen">
            <h2 className="completion-title">Lesson Complete!</h2>

            <div className="completion-score">
              <div
                className="completion-accuracy-circle"
                style={{ borderColor: getAccuracyColor(finalScore.accuracy) }}
              >
                <span className="completion-accuracy-value">{finalScore.accuracy.toFixed(1)}%</span>
                <span className="completion-accuracy-label">Accuracy</span>
              </div>
            </div>

            <div className="completion-stats">
              <div className="completion-stat">
                <span className="completion-stat-value">{finalScore.totalPoints}</span>
                <span className="completion-stat-label">Total Points</span>
              </div>
              <div className="completion-stat">
                <span className="completion-stat-value">{finalScore.perfectHits}</span>
                <span className="completion-stat-label">Perfect Hits</span>
              </div>
              <div className="completion-stat">
                <span className="completion-stat-value">{finalScore.goodHits}</span>
                <span className="completion-stat-label">Good Hits</span>
              </div>
              <div className="completion-stat">
                <span className="completion-stat-value">{finalScore.misses}</span>
                <span className="completion-stat-label">Misses</span>
              </div>
            </div>

            <div className="completion-actions">
              <button className="btn-primary" onClick={handleReplay}>
                Replay Lesson
              </button>
              <button className="btn-primary" onClick={handleContinue}>
                Continue
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Compact Toolbar - hidden in actual game mode and in the Jam tab (its controls live in the jam sidebar) */}
      {!isGameMode && !jamOnly && (
        <div className="lesson-toolbar">
          {/* Left: Exit and Title */}
          <div className="toolbar-left">
            {!jamOnly && (
              <button className="toolbar-btn exit-btn" onClick={handleContinue} title="Exit Lesson">
                ←
              </button>
            )}
            <span className="toolbar-title">{lesson.title}</span>
            <span className="toolbar-badge">{lesson.bpm} BPM</span>
            {!jamOnly && lesson.metadata?.difficulty && (
              <span className="toolbar-badge">Lv.{lesson.metadata.difficulty}</span>
            )}
          </div>

          {/* Center: Mode Tabs */}
          <div className="toolbar-center">
            {!jamOnly && (
            <div className="toolbar-mode-tabs">
              <button
                className={`toolbar-mode-tab ${currentMode === 'free' ? 'active' : ''}`}
                onClick={() => handleModeChange('free')}
              >
                Free
              </button>
              <button
                className={`toolbar-mode-tab ${currentMode === 'wait' ? 'active' : ''}`}
                onClick={() => handleModeChange('wait')}
              >
                Wait
              </button>
              <button
                className={`toolbar-mode-tab ${currentMode === 'play' ? 'active' : ''}`}
                onClick={() => handleModeChange('play')}
              >
                Play
              </button>
              <button
                className={`toolbar-mode-tab ${currentMode === 'jam' ? 'active' : ''}`}
                onClick={() => handleModeChange('jam')}
              >
                Jam
              </button>
            </div>
            )}

            {/* Wait mode progress indicator */}
            {currentMode === 'wait' && (
              <div className="toolbar-progress">
                <span>{waitModeStepIndex + 1}/{lesson.steps.length}</span>
              </div>
            )}
          </div>

          {/* Right: Controls */}
          <div className="toolbar-right">
            {/* MIDI Indicator */}
            <div className={`toolbar-midi ${midiActivity ? 'active' : ''}`} title="MIDI Status">
              <span className="midi-dot"></span>
              {lastMidiNote !== null ? lastMidiNote : 'MIDI'}
            </div>

            {/* Keys hint */}
            <div className="toolbar-keys">
              {Object.keys(keyBindings).slice(0, 3).map(key => (
                <kbd key={key}>{key.toUpperCase()}</kbd>
              ))}
              {Object.keys(keyBindings).length > 3 && <span>+{Object.keys(keyBindings).length - 3}</span>}
            </div>

            {/* Key settings button */}
            <button
              className={`toolbar-btn ${showKeySettings ? 'active' : ''}`}
              onClick={() => setShowKeySettings(!showKeySettings)}
              title="Key Bindings"
            >
              Keys
            </button>

            {/* Sound selection button */}
            {!jamOnly && allLaneNotes.length > 1 && (
              <button
                className={`toolbar-btn ${showSoundSettings ? 'active' : ''} ${disabledNotes.size > 0 ? 'has-off' : ''}`}
                onClick={() => setShowSoundSettings(!showSoundSettings)}
                title="Choose which sounds you practice"
              >
                Sounds {allLaneNotes.length - disabledNotes.size}/{allLaneNotes.length}
              </button>
            )}

            {/* Label mode tabs */}
            <div className="toolbar-label-tabs">
              <button
                className={`toolbar-label-tab ${labelMode === 'letters' ? 'active' : ''}`}
                onClick={() => setLabelMode('letters')}
              >
                ABC
              </button>
              <button
                className={`toolbar-label-tab ${labelMode === 'numbers' ? 'active' : ''}`}
                onClick={() => setLabelMode('numbers')}
              >
                123
              </button>
            </div>

            {/* Collapse toggle (jam always shows one row per pitch) */}
            {currentMode !== 'jam' && (
              <button
                className={`toolbar-btn ${isCollapsed ? 'active' : ''}`}
                onClick={() => setIsCollapsed(!isCollapsed)}
                title={isCollapsed ? 'Expand lanes' : 'Collapse lanes'}
              >
                {isCollapsed ? '⬍' : '⬌'}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Note Highway Visualization - fullscreen only in actual game mode */}
      <div className={`highway-container ${isGameMode ? 'fullscreen' : ''} ${jamOnly && showJamSettings ? 'with-jam-settings' : ''}`}>

        {/* Sound selection panel */}
        {!isGameMode && showSoundSettings && (
          <div className="key-settings-panel sound-settings-panel">
            <div className="key-settings-header">
              <h4>Sounds</h4>
              <button className="close-settings" onClick={() => setShowSoundSettings(false)}>×</button>
            </div>
            <p className="sound-settings-hint">Switched-off sounds leave the practice: no notes, no scoring, silent pad.</p>
            {renderSoundToggles()}
          </div>
        )}

        {/* Key bindings settings panel */}
        {!isGameMode && showKeySettings && (
          <div className="key-settings-panel">
            <div className="key-settings-header">
              <h4>Key Bindings</h4>
              <button className="close-settings" onClick={() => setShowKeySettings(false)}>×</button>
            </div>
            <div className="key-bindings-list">
              {uniqueLessonNotes.map((note, index) => {
                const currentKey = Object.entries(keyBindings).find(([_, n]) => n === note)?.[0] || '';
                return (
                  <div key={note} className="key-binding-row">
                    <span className="note-number">{index + 1}</span>
                    <span className="note-value">Note {note}</span>
                    <input
                      type="text"
                      className="key-input"
                      value={currentKey.toUpperCase()}
                      maxLength={1}
                      onChange={(e) => {
                        const newKey = e.target.value.toLowerCase();
                        if (newKey && newKey.length === 1) {
                          // Remove old binding for this note
                          const newBindings = Object.fromEntries(
                            Object.entries(keyBindings).filter(([_, n]) => n !== note)
                          );
                          // Remove any existing binding for the new key
                          delete newBindings[newKey];
                          // Add new binding
                          newBindings[newKey] = note;
                          setKeyBindings(newBindings);
                        }
                      }}
                      onFocus={(e) => e.target.select()}
                    />
                  </div>
                );
              })}
            </div>
            <button
              className="btn-secondary reset-keys"
              onClick={() => setKeyBindings(generateDefaultKeyMapping())}
            >
              Reset to Defaults
            </button>

            {/* Recent Hits */}
            <div className="recent-hits-section">
              <h4>Recent Hits</h4>
              <div className="feedback-list-compact">
                {recentFeedback.length === 0 ? (
                  <p className="no-feedback">Play to see feedback...</p>
                ) : (
                  recentFeedback.slice(-5).map((feedback, idx) => (
                    <div
                      key={idx}
                      className="feedback-item-compact"
                      style={{ borderLeftColor: getFeedbackColor(feedback) }}
                    >
                      <span className="feedback-accuracy">{feedback.accuracy}</span>
                      <span className="feedback-points">+{feedback.points}</span>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Score Section (compact) */}
            <div className="score-section-compact">
              <h4>Score</h4>
              <div className="score-compact">
                <div className="score-accuracy" style={{ color: getAccuracyColor(score.accuracy) }}>
                  {score.accuracy.toFixed(1)}%
                </div>
                <div className="score-details">
                  <span>{score.hits} hits</span>
                  <span>{score.perfectHits} perfect</span>
                  <span>{score.misses} miss</span>
                </div>
              </div>
            </div>

            {/* Speed Control (Play mode only) */}
            {currentMode === 'play' && (
              <div className="speed-section-compact">
                <h4>Speed: {(practiceMode.speedMultiplier * 100).toFixed(0)}%</h4>
                <input
                  type="range"
                  min="0"
                  max="2.0"
                  step="0.05"
                  value={practiceMode.speedMultiplier}
                  onChange={(e) => handleSpeedChange(parseFloat(e.target.value))}
                  className="speed-slider-compact"
                />
              </div>
            )}

            {/* Restart button for free/wait modes */}
            {(currentMode === 'free' || currentMode === 'wait') && (
              <button
                className="btn-secondary restart-btn"
                onClick={() => {
                  setPlayedNotes(new Set());
                  setWaitModeStepIndex(0);
                }}
              >
                Restart
              </button>
            )}
          </div>
        )}
        {jamTrack && jamTrackNotes && jamSettings && jamView === 'grid' ? (
          <JamTrackGrid
            track={jamTrack}
            notes={jamTrackNotes}
            divisions={jamTrackEdit?.divisions ?? jamTrackNotes.map(() => null)}
            edited={!!jamTrackEdit || !!jamSettings.mixes[jamTrack.file]}
            mix={jamTrackMix!}
            onMixChange={(mix) => setJamSettings({ ...jamSettings, mixes: { ...jamSettings.mixes, [jamTrack.file]: mix } })}
            paused={jamPaused}
            onTogglePause={toggleJamPause}
            onChange={(parts, divisions) =>
              setJamSettings({ ...jamSettings, tracks: { ...jamSettings.tracks, [jamTrack.file]: { parts, divisions } } })
            }
            onReset={() => {
              const tracks = { ...jamSettings.tracks };
              const mixes = { ...jamSettings.mixes };
              delete tracks[jamTrack.file];
              delete mixes[jamTrack.file];
              setJamSettings({ ...jamSettings, tracks, mixes });
            }}
            getStep={getJamStep}
          />
        ) : (
          <NoteHighway
            steps={lesson.steps}
            currentTime={currentTime}
            bpm={lesson.bpm}
            activePads={activePads}
            hitFeedback={recentFeedback}
            mode={currentMode}
            currentStepIndex={waitModeStepIndex}
            playedSteps={playedNotes}
            isCollapsed={isCollapsed && !isGameMode && currentMode !== 'jam'}
            noteToKeyMap={noteToKeyMap}
            labelMode={labelMode}
            jamNotes={jamNotes}
            onJamPointer={currentMode === 'jam' ? handleJamPointer : undefined}
            onJamCursorNote={currentMode === 'jam' ? handleJamCursorNote : undefined}
            holdNotes={!!lesson.holdNotes}
            holdingSteps={holdingSteps}
            onNoteReached={isGameMode ? handleNoteReached : undefined}
          />
        )}

        {/* Play button - bottom right of highway (the Jam tab is always running) */}
        {!isGameMode && !jamOnly && (
          <button className="highway-play-btn" onClick={handleStart} title="Start Game">
            <span className="play-icon">&#9654;</span>
          </button>
        )}

        {/* Jam tab: full-page highway; collapsed sidebar leaves only back and expand */}
        {jamOnly && !showJamSettings && (
          <div className="jam-corner-buttons">
            {onComplete && (
              <button className="jam-corner-btn" onClick={onComplete} title="Back">
                &#8592;
              </button>
            )}
            <button className="jam-corner-btn" onClick={() => setShowJamSettings(true)} title="Show settings">
              &#187;
            </button>
          </div>
        )}
        {jamOnly && showJamSettings && jamSettings && jamSounds && (
          <JamSettingsPanel
            songs={jamSongs ?? [lessonArg]}
            songId={lessonProp.id}
            onSongChange={(songId) => setJamSettings({ ...jamSettings, songId })}
            view={jamView}
            onViewChange={jamTrack ? setJamView : undefined}
            sounds={jamSounds}
            referenceSounds={jamReferenceSounds ?? []}
            soundId={jamSettings.soundId}
            onSoundChange={(soundId) => setJamSettings({ ...jamSettings, soundId })}
            patch={jamSettings.patches[jamSettings.soundId]}
            onPatchChange={(patch) =>
              setJamSettings({ ...jamSettings, patches: { ...jamSettings.patches, [jamSettings.soundId]: patch } })
            }
            onPatchReset={() => {
              const preset = jamSounds.find((sound) => sound.id === jamSettings.soundId);
              if (preset && 'patch' in preset) {
                setJamSettings({ ...jamSettings, patches: { ...jamSettings.patches, [preset.id]: preset.patch } });
              }
            }}
            holdDivisions={JAM_HOLD_DIVISIONS}
            holdDivision={jamKeyDivisions.length ? jamKeyDivisions[jamKeyDivisions.length - 1] : jamHoldDivision}
            onHoldDivisionChange={setJamHoldDivision}
            holdTriplet={jamHoldTriplet}
            onHoldTripletChange={setJamHoldTriplet}
            notesVolume={jamNotesVolume}
            onNotesVolumeChange={setJamNotesVolume}
            backingVolume={backingTrackVolume}
            onBackingVolumeChange={setBackingTrackVolume}
            effects={jamSettings.effects}
            onEffectsChange={(effects) => setJamSettings({ ...jamSettings, effects })}
            title={lesson.title}
            bpm={lesson.bpm}
            midiActive={midiActivity}
            lastMidiNote={lastMidiNote}
            showKeys={showKeySettings}
            onToggleKeys={() => setShowKeySettings(!showKeySettings)}
            labelMode={labelMode}
            onLabelModeChange={setLabelMode}
            onBack={onComplete}
            onClose={() => setShowJamSettings(false)}
          />
        )}

        {/* Game mode settings toggle button - left side */}
        {isGameMode && !showGameSettings && (
          <button
            className="game-settings-toggle"
            onClick={() => setShowGameSettings(true)}
            title="Game Settings"
          >
            <span className="settings-icon">&#9881;</span>
          </button>
        )}

        {/* Game mode collapsible settings sidebar - LEFT side */}
        {isGameMode && showGameSettings && (
          <div className="game-settings-sidebar">
            <div className="game-settings-header">
              <h3>Settings</h3>
              <button className="close-sidebar" onClick={() => setShowGameSettings(false)}>
                &times;
              </button>
            </div>

            <div className="game-settings-content">
              {allLaneNotes.length > 1 && (
                <div className="setting-group">
                  <label className="setting-label">
                    <span className="setting-icon">&#127898;</span>
                    Sounds
                    <span className="setting-value">
                      {allLaneNotes.length - disabledNotes.size}/{allLaneNotes.length}
                    </span>
                  </label>
                  <p className="setting-description">
                    {state === 'playing' ? 'Pause to change which sounds you practice' : 'Choose which sounds you practice'}
                  </p>
                  {renderSoundToggles()}
                </div>
              )}

              {/* Auto-play volume control */}
              <div className="setting-group">
                <label className="setting-label">
                  <span className="setting-icon">&#127925;</span>
                  Auto-Play
                  <span className="setting-value">{Math.round(autoPlayVolume * 100)}%</span>
                </label>
                <p className="setting-description">
                  Hear notes as they reach the timing line
                </p>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={autoPlayVolume}
                  onChange={(e) => setAutoPlayVolume(parseFloat(e.target.value))}
                  className="volume-slider"
                />
                <div className="slider-labels">
                  <span>Off</span>
                  <span>Full</span>
                </div>
              </div>

              {/* Backing track volume control */}
              <div className="setting-group">
                <label className="setting-label">
                  <span className="setting-icon">&#127926;</span>
                  Backing Track
                  <span className="setting-value">
                    {lesson.backingTrack ? `${Math.round(backingTrackVolume * 100)}%` : 'N/A'}
                  </span>
                </label>
                <p className="setting-description">
                  {lesson.backingTrack ? 'Play along with the backing track' : 'No backing track available'}
                </p>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={backingTrackVolume}
                  onChange={(e) => setBackingTrackVolume(parseFloat(e.target.value))}
                  className="volume-slider"
                  disabled={!lesson.backingTrack}
                />
                <div className="slider-labels">
                  <span>Off</span>
                  <span>Full</span>
                </div>
              </div>

              {/* Metronome volume control */}
              <div className="setting-group">
                <label className="setting-label">
                  <span className="setting-icon">&#128336;</span>
                  Metronome
                  <span className="setting-value">{Math.round(metronomeVolume * 100)}%</span>
                </label>
                <p className="setting-description">
                  {lesson.bpm} BPM • Keep time with the beat
                </p>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={metronomeVolume}
                  onChange={(e) => setMetronomeVolume(parseFloat(e.target.value))}
                  className="volume-slider"
                />
                <div className="slider-labels">
                  <span>Off</span>
                  <span>Full</span>
                </div>
              </div>

              {/* Playback speed control */}
              <div className="setting-group">
                <label className="setting-label">
                  <span className="setting-icon">&#9201;</span>
                  Speed
                  <span className="setting-value">{Math.round(practiceMode.speedMultiplier * 100)}%</span>
                </label>
                <p className="setting-description">
                  Adjust playback speed (0% - 200%)
                </p>
                <input
                  type="range"
                  min="0"
                  max="2"
                  step="0.05"
                  value={practiceMode.speedMultiplier}
                  onChange={(e) => handleSpeedChange(parseFloat(e.target.value))}
                  className="volume-slider"
                />
                <div className="slider-labels">
                  <span>0%</span>
                  <span>200%</span>
                </div>
              </div>
            </div>

            {/* Game control buttons */}
            <div className="game-controls">
              <button
                className="game-control-btn back-btn"
                onClick={handleGameBack}
                title="Back to Lessons"
              >
                <span className="control-icon">&#8592;</span>
                <span className="control-label">Back</span>
              </button>
              <button
                className="game-control-btn play-pause-btn"
                onClick={handleGamePlayPause}
                title={state === 'playing' ? 'Pause' : 'Play'}
              >
                <span className="control-icon">
                  {state === 'playing' ? '\u275A\u275A' : '\u25B6'}
                </span>
                <span className="control-label">{state === 'playing' ? 'Pause' : 'Play'}</span>
              </button>
              <button
                className="game-control-btn restart-btn"
                onClick={handleGameRestart}
                title="Restart"
              >
                <span className="control-icon">&#8635;</span>
                <span className="control-label">Restart</span>
              </button>
            </div>
          </div>
        )}
      </div>

    </div>
  );
}
