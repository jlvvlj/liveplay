import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import * as Tone from 'tone';
import { LessonEngine, LessonEngineState } from './LessonEngine';
import { Lesson, LessonStep, HitFeedback, LessonScore, PracticeModeSettings } from '../../types/lesson';
import { MidiEvent, DeviceMapping } from '../../types/electron';
import { NoteHighway, HighwayMode, JamNote, JamShip } from './NoteHighway';
import { JamSettingsPanel } from './JamSettingsPanel';
import { JamTrackGrid } from './JamTrackGrid';
import { BackIcon, InstrumentsIcon, SidebarIcon } from './JamIcons';
import { InstrumentPanel } from './instruments/InstrumentPanel';
import { JAM_TRACK_BARS, jamTrackBaseFile, jamTrackByFile, jamTrackFor, jamTrackParts, type JamTrackNote } from './jamTracks';
import { validJamTrackEdit, type JamTrackEdit } from './jamTrackEdits';
import { renderJamBackingPart } from './jamRenderer';
import { jamPartKey, type JamAddedPart } from './jamAddedParts';
import { jamPartTracks, type JamTrackInstruments } from './jamTrackInstruments';
import { JamLiveTracks, type LiveTrack } from './instruments/liveTracks';
import { swung } from './jamTrackRender';
import {
  JamBackingMixer,
  silentJamPart,
  defaultJamTrackMix,
  fitJamTrackMix,
  jamTrackLevels,
  loadJamBackingMixer,
  JAM_BACKING_TOP_DB,
  type BackingPlayer,
  type JamTrackMix,
} from './jamBackingMixer';
import { loadJamReferenceSounds, jamNotesDb, type JamSoundPreset, type JamSampleSound, type JamSynthPatch } from './jamSynth';
import { InstrumentChannel } from './instruments/channel';
import { INSTRUMENTS, choiceForSound, findInstrument, jamRowNote, portInstruments, presetChoice, referenceInstruments } from './instruments/catalog';
import { loadPortCatalog, type PortEntry } from './instruments/engines/port';
import { registerPortEffects } from './instruments/effects';
import { paramsPatch, patchParams } from './instruments/engines/melodicsSynth';
import { PAD_BASE_NOTE, type InstrumentChoice } from './instruments/types';
import { audioTimeAt, hitSlot, remoteNoteSlot, swungPosition } from './jamClock';
import { JamRoom, type JamRoomEnd, type JamRoomPlayer } from './jamRoom';
import { jamRoomSongLesson } from './jamSongs';
import { jamLessonFromSong, type JamLesson } from './jamLessonRooms';
import { defaultLessonKeys } from './lessonKeys';
import { jamAbletonAudioUrl, jamAbletonLesson, mixJamAbletonAudio } from './jamAbletonImport';
import { JAM_ABLETON_FILE, type JamDawSong } from './jamRoomProtocol';
import { JamLessonVoices } from './jamLessonVoices';
import type { JamLessonHit } from './NoteHighway';
import type { JamRoomNote, JamRoomSound, JamRoomState, JamRoomVisibility } from './jamRoomProtocol';
import { JamRemoteVoices } from './jamRemoteVoices';
import { holdToleranceMs, isHoldStep, stepDurationMs } from './holdNotes';
import { useWebMidi } from '../../utils/useWebMidi';
import { ACCENT, DANGER, SUCCESS, TEXT, WARNING } from '../../styles/palette';
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
  // Jam tab: the room server (WebSocket URL) for playing together online, the
  // room to join there (a Jam room by its key, `create` opening it as a new
  // room with that song; or with `edit`, the room where the Daw song with
  // that id is edited), and what to do when the room ends by itself
  jamRoomServer?: string;
  jamRoomJoin?: { key: string; edit?: boolean; create?: { visibility: JamRoomVisibility; song: string } };
  onJamRoomEnd?: (reason: JamRoomEnd) => void;
  // The jam app's sections: the Daw shows only the backing track's grid, the
  // Jam only the highway; both play their room's song. Unset, the Jam tab
  // switches between them and picks its song in the sidebar.
  jamSection?: 'daw' | 'jam';
  // The jam server over HTTP (http(s)://host): imported songs' tracks and audio
  jamHttpServer?: string;
}

const MIN_EFFECTIVE_SPEED = 0.01;

// The mix as heard: in a lesson room without the lesson track, which the hits play
const jamHeardMix = (mix: JamTrackMix, lesson: { parts: number[] } | null): JamTrackMix =>
  lesson ? { ...mix, mutes: mix.mutes.map((mute, part) => mute || lesson.parts.includes(part)) } : mix;

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
// Notes are scheduled at least this far ahead of the audio clock
const JAM_SCHEDULE_MARGIN_S = 0.01;
// Computer keys and the screen play at this velocity
const JAM_KEY_VELOCITY = 100;
// A note let go at once still sounds this long (s)
const JAM_SHORTEST_NOTE_S = 0.03;
// Jam rooms: a player must have a note this long before it sounds, on top of
// its audio output latency, to schedule it (message handling, scheduling)
const JAM_ROOM_RECEIVE_MARGIN_S = 0.02;
// A song started or resumed in a room begins this long after the click, so
// every player has the news in time to start with it
const JAM_ROOM_START_LEAD_MS = 400;
// A grid this far off the room's clock (drift between the audio and system
// clocks) is moved back onto it
const JAM_ROOM_RESYNC_S = 0.015;
const JAM_ROOM_RESYNC_MS = 1000;

// Jam tab volumes: the played notes start below the backing track (see
// JAM_BACKING_TOP_DB), so the groove stays clearly audible
const DEFAULT_JAM_NOTES_VOLUME = 0.75;

// Jam tab settings remembered in this browser: chosen song, the instrument
// played (its preset, parameters and effects as edited), and each other
// instrument as it was last left
interface JamSettings {
  songId: string;
  instrument: InstrumentChoice;
  instruments: Record<string, InstrumentChoice>;
  // Backing tracks edited in the grid, and their mixer settings, by file
  tracks: Record<string, JamTrackEdit>;
  mixes: Record<string, JamTrackMix>;
  // Whether the grid's track headers are shown
  lanesOpen: boolean;
  // How swung the played notes are, by song (0.5 straight); unset follows the backing track
  swings: Record<string, number>;
}

export type { JamTrackEdit } from './jamTrackEdits';

// Edits that no longer match their track's parts are left out
function validTrackEdits(saved: unknown): Record<string, JamTrackEdit> {
  if (!saved || typeof saved !== 'object') return {};
  return Object.fromEntries(Object.entries(saved).filter(([file, edit]) => validJamTrackEdit(file, edit)));
}
// Mixes that no longer cover their track's own parts are left out (added parts come after them)
function validTrackMixes(saved: unknown): Record<string, JamTrackMix> {
  if (!saved || typeof saved !== 'object') return {};
  return Object.fromEntries(
    Object.entries(saved as Record<string, JamTrackMix>).filter(([file, mix]) => {
      const track = jamTrackByFile(file);
      const partCount = track ? jamTrackParts(track).length : -1;
      return [mix?.levels, mix?.mutes, mix?.solos].every((list) => Array.isArray(list) && list.length >= partCount);
    })
  );
}
const JAM_SETTINGS_KEY = 'melodics.jamSettings.v1';
// The player's name in jam rooms, remembered in this browser
const JAM_NAME_KEY = 'melodics.jamName.v1';
function loadJamName(): string {
  try {
    return localStorage.getItem(JAM_NAME_KEY) ?? '';
  } catch {
    return ''; // storage unavailable: the room gives a numbered name
  }
}

// A field that takes typed text
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement) return true;
  return target instanceof HTMLInputElement && !['checkbox', 'radio', 'range', 'button', 'submit'].includes(target.type);
}

// The page's own AudioContext under Tone's wrapper, which lacks output timestamps
function rawAudioContext(): AudioContext {
  const raw = Tone.getContext().rawContext as AudioContext & { _nativeAudioContext?: AudioContext };
  return raw._nativeAudioContext ?? raw;
}

// A room state with every track and part that did not change kept as it was,
// so only the parts edited since are rendered again
function keepUnchangedTracks(prev: JamRoomState | null, next: JamRoomState): JamRoomState {
  if (!prev) return next;
  const tracks = Object.fromEntries(
    Object.entries(next.tracks).map(([file, edit]) => {
      const old = prev.tracks[file];
      if (!old) return [file, edit];
      if (JSON.stringify(old) === JSON.stringify(edit)) return [file, old];
      const parts = edit.parts.map((part, index) =>
        JSON.stringify(old.parts[index]) === JSON.stringify(part) ? old.parts[index] : part
      );
      return [file, { ...edit, parts }];
    })
  );
  return { ...next, tracks };
}

// A choice as saved, if it still names an instrument; reference sounds (on this
// machine only) are checked once their list loads
function savedChoice(saved: unknown): InstrumentChoice | null {
  const choice = saved as Partial<InstrumentChoice> | null;
  if (!choice || typeof choice.instrument !== 'string' || typeof choice.preset !== 'string') return null;
  if (!choice.params || typeof choice.params !== 'object' || !Array.isArray(choice.effects)) return null;
  return choice as InstrumentChoice;
}

// Settings saved before instruments: the chosen sound was a synth patch (now a
// Melodics Synth preset, with its edits) or a kit or recorded sound (now an
// instrument of the same id)
function choiceFromSound(soundId: unknown, patches: unknown): InstrumentChoice | null {
  if (typeof soundId !== 'string') return null;
  const synth = INSTRUMENTS[0];
  if (synth.presets.some((preset) => preset.id === soundId)) {
    const choice = presetChoice(synth, soundId);
    const edited = (patches as Record<string, JamSynthPatch> | undefined)?.[soundId];
    return edited ? { ...choice, params: { ...choice.params, ...patchParams({ ...paramsPatch(choice.params), ...edited }) } } : choice;
  }
  const instrument = findInstrument(INSTRUMENTS, soundId);
  return instrument ? presetChoice(instrument) : { instrument: soundId, preset: 'natural', params: {}, effects: [] };
}

function loadJamSettings(songIds: string[]): JamSettings {
  const defaults: JamSettings = {
    songId: songIds[0],
    instrument: presetChoice(INSTRUMENTS[0]),
    instruments: {},
    tracks: {},
    mixes: {},
    lanesOpen: true,
    swings: {},
  };
  try {
    const saved = JSON.parse(localStorage.getItem(JAM_SETTINGS_KEY) ?? 'null') as
      | (Partial<JamSettings> & { soundId?: unknown; patches?: unknown })
      | null;
    if (!saved) return defaults;
    return {
      songId: typeof saved.songId === 'string' && songIds.includes(saved.songId) ? saved.songId : defaults.songId,
      instrument: savedChoice(saved.instrument) ?? choiceFromSound(saved.soundId, saved.patches) ?? defaults.instrument,
      instruments: Object.fromEntries(
        Object.entries(saved.instruments ?? {}).flatMap(([id, choice]) => {
          const valid = savedChoice(choice);
          return valid ? [[id, valid]] : [];
        })
      ),
      tracks: validTrackEdits(saved.tracks),
      mixes: validTrackMixes(saved.mixes),
      lanesOpen: typeof saved.lanesOpen === 'boolean' ? saved.lanesOpen : defaults.lanesOpen,
      swings:
        saved.swings && typeof saved.swings === 'object'
          ? Object.fromEntries(Object.entries(saved.swings).filter(([, swing]) => typeof swing === 'number'))
          : {},
    };
  } catch {
    return defaults; // storage unavailable: start from the presets
  }
}

function saveJamSettings(settings: JamSettings) {
  try {
    localStorage.setItem(JAM_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // storage unavailable: settings last for this visit only
  }
}

// Lesson audio is either a file under the app's /audio/ folder or already a
// full URL (blob: for files read from a picked Ableton project folder).
const audioUrl = (path: string): string => (/^(blob|data|https?):/.test(path) ? path : `/audio/${path}`);

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

export function LessonPlayer({
  lesson: lessonArg,
  onComplete,
  jamOnly = false,
  jamSounds,
  jamSongs,
  jamRoomServer,
  jamRoomJoin,
  onJamRoomEnd,
  jamSection,
  jamHttpServer,
}: LessonPlayerProps) {
  // Jam tab: the chosen song, synth sound, its (editable) settings and the
  // effects, remembered between visits
  const [jamSettings, setJamSettings] = useState<JamSettings | null>(() =>
    jamSounds?.length ? loadJamSettings([lessonArg.id, ...(jamSongs ?? []).map((song) => song.id)]) : null
  );
  // Jam room (playing together online): the room, its jam once joined and
  // synced, its players, and why the last one ended if it ended by itself.
  // In a room its jam replaces this browser's song, play / pause and grid edits.
  const [jamRoom, setJamRoom] = useState<JamRoom | null>(null);
  const [jamRoomState, setJamRoomState] = useState<JamRoomState | null>(null);
  const [jamRoomPlayers, setJamRoomPlayers] = useState<JamRoomPlayer[]>([]);
  const jamRoomRef = useRef<JamRoom | null>(null);
  jamRoomRef.current = jamRoom;
  const jamRoomStateRef = useRef<JamRoomState | null>(null);
  jamRoomStateRef.current = jamRoomState;
  const jamRoomStartAt = jamRoomState ? jamRoomState.startAt : null;
  // This player's name on their ship; empty for the room's numbered name
  const [jamName, setJamName] = useState<string>(loadJamName);
  useEffect(() => {
    try {
      localStorage.setItem(JAM_NAME_KEY, jamName);
    } catch {
      // storage unavailable: the name lasts until the page closes
    }
  }, [jamName]);

  // Switching songs swaps the lesson in place, so volumes and the sidebar stay
  // as they are. A room plays its own song, and its backing track waits for it.
  const jamRoomSong = jamRoomState ? JSON.stringify(jamRoomState.song) : null;
  const jamRoomLesson = useMemo(() => (jamRoomSong ? jamRoomSongLesson(JSON.parse(jamRoomSong)) : null), [jamRoomSong]);
  // A lesson room plays one track of its song as a lesson: its notes are the
  // highway's steps, its lanes the rows (see jamLessonRooms.ts)
  const jamRoomLessonTrack = jamRoomState?.lesson?.track ?? null;
  const jamRoomSongEdit = jamRoomState ? jamRoomState.tracks[jamRoomState.song.file] : undefined;
  const jamGridLesson = useMemo(
    () => (jamRoomSong && jamRoomLessonTrack ? jamLessonFromSong(JSON.parse(jamRoomSong), jamRoomSongEdit, jamRoomLessonTrack) : null),
    [jamRoomSong, jamRoomSongEdit, jamRoomLessonTrack]
  );
  // A song imported from an Ableton project: its lesson track's lesson as the
  // full app makes it (each hit a slice of the track's export), over the
  // others' recordings mixed as the backing
  const jamRoomAbleton = jamRoomState?.song.file === JAM_ABLETON_FILE ? jamRoomState.song.id : null;
  const [jamAbletonRoomLesson, setJamAbletonRoomLesson] = useState<JamLesson | null>(null);
  useEffect(() => {
    if (!jamRoomAbleton || !jamRoomLessonTrack || !jamHttpServer) return;
    let cancelled = false;
    let backing: string | null = null;
    (async () => {
      const response = await fetch(`${jamHttpServer}/jam-songs/${jamRoomAbleton}`);
      if (!response.ok) throw new Error(`The song could not be loaded (${response.status})`);
      const song = (await response.json()) as JamDawSong;
      const index = Number(jamRoomLessonTrack.replace('ableton-', ''));
      const track = song.ableton?.tracks[index];
      if (!song.ableton || !track) throw new Error(`${song.title} has no track ${jamRoomLessonTrack}`);
      const others = song.ableton.tracks.filter((_, at) => at !== index).map((other) => jamAbletonAudioUrl(jamHttpServer, other));
      backing = await mixJamAbletonAudio(others, song.ableton.seconds);
      if (cancelled) return;
      const lesson = { ...jamAbletonLesson(jamHttpServer, song.id, song.title, track), backingTrack: backing };
      const notes = [...new Set(lesson.steps.map((step) => step.note))].sort((a, b) => a - b);
      setJamAbletonRoomLesson({ lesson, lanes: notes.map((note) => ({ note, part: -1, pitch: note })), parts: [] });
    })().catch((err) => {
      if (cancelled) return;
      console.error('[LessonPlayer] Could not prepare the imported song\'s lesson:', err);
      onJamRoomEndRef.current?.('song');
    });
    return () => {
      cancelled = true;
      if (backing) URL.revokeObjectURL(backing);
      setJamAbletonRoomLesson(null);
    };
  }, [jamRoomAbleton, jamRoomLessonTrack, jamHttpServer]);
  const jamLesson = jamAbletonRoomLesson ?? jamGridLesson;
  const jamLessonRef = useRef(jamLesson);
  jamLessonRef.current = jamLesson;
  const jamWaitingForRoom = !!jamRoomJoin && (!jamRoomState || (!!jamRoomAbleton && !jamAbletonRoomLesson));
  const lessonProp = jamLesson?.lesson ?? jamRoomLesson ?? jamSongs?.find((song) => song.id === jamSettings?.songId) ?? lessonArg;
  useEffect(() => {
    if (jamSettings) saveJamSettings(jamSettings);
  }, [jamSettings]);
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
  // The instrument ports (synths compiled to WebAssembly), once their catalog
  // has loaded; none where they were not built
  const [jamPorts, setJamPorts] = useState<PortEntry[] | null>(null);
  useEffect(() => {
    if (!jamOnly) return;
    let cancelled = false;
    loadPortCatalog()
      .then((entries) => {
        if (cancelled) return;
        registerPortEffects(entries);
        setJamPorts(entries);
      })
      .catch((err) => {
        console.error('[LessonPlayer] Could not load the instrument ports catalog:', err);
        if (!cancelled) setJamPorts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [jamOnly]);
  // Every instrument there is to play, the one chosen and how it is set
  const jamInstruments = useMemo(
    () => [...INSTRUMENTS, ...portInstruments(jamPorts ?? []), ...referenceInstruments(jamReferenceSounds ?? [])],
    [jamReferenceSounds, jamPorts]
  );
  const jamChoice = jamSettings?.instrument;
  const jamInstrument = jamChoice ? findInstrument(jamInstruments, jamChoice.instrument) : undefined;
  const jamInstrumentRef = useRef(jamInstrument);
  jamInstrumentRef.current = jamInstrument;
  // A remembered reference sound no longer on this machine (or a port no
  // longer built): back to the first instrument, once both lists have loaded
  useEffect(() => {
    if (!jamSettings || jamReferenceSounds === null || jamPorts === null || jamInstrument) return;
    setJamSettings({ ...jamSettings, instrument: presetChoice(INSTRUMENTS[0]) });
  }, [jamSettings, jamReferenceSounds, jamPorts, jamInstrument]);
  const fullLesson = lessonProp;

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
  const jamPlayedOnceRef = useRef<number | null>(null); // Row a held pointer played, with no repeat
  const jamCursorNoteRef = useRef<number | null>(null); // Row the ship is on
  // Jam tab: how often a held note repeats, in notes per bar, straight or as triplets
  // None: a held pointer plays its row once
  const [jamHoldDivision, setJamHoldDivision] = useState<number | null>(DEFAULT_JAM_HOLD_DIVISION);
  const jamHoldDivisionRef = useRef<number | null>(DEFAULT_JAM_HOLD_DIVISION);
  jamHoldDivisionRef.current = jamHoldDivision;
  const [jamHoldTriplet, setJamHoldTriplet] = useState<boolean>(false);
  const jamHoldTripletRef = useRef<boolean>(false);
  jamHoldTripletRef.current = jamHoldTriplet;
  // Jam tab: the highway, or the backing track drawn as a step grid
  const [jamViewChosen, setJamView] = useState<'highway' | 'grid'>('highway');
  const jamView = jamSection === 'daw' ? 'grid' : jamSection === 'jam' ? 'highway' : jamViewChosen;
  // Jam tab paused, and how far it had played when it was (seconds)
  const [jamPaused, setJamPaused] = useState<boolean>(false);
  // In a room, play / pause is the room's
  const jamIsPaused = jamRoomState ? jamRoomState.startAt === null : jamPaused;
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
  const jamNotesVolumeRef = useRef(jamNotesVolume);
  jamNotesVolumeRef.current = jamNotesVolume;
  // The current playSound, for callbacks made before it (it reads the current lesson)
  const playSoundRef = useRef<
    (note: number, sampleNote?: number, volume?: number, slice?: { offset: number; duration: number }, startTime?: number, semitones?: number) => Tone.Player | undefined
  >(() => undefined);
  // The Jam's sidebar starts folded away, leaving the room to the highway or the grid
  const [showJamSettings, setShowJamSettings] = useState<boolean>(false);
  // The instruments panel, down the left side: for the played sound ('jam')
  // or for a track of the backing track's grid (its key)
  const [instrumentsFor, setInstrumentsFor] = useState<string | null>(null);
  // A new instrument or a changed setting, remembered for that instrument too
  const setJamChoice = useCallback((choice: InstrumentChoice) => {
    setJamSettings((settings) =>
      settings ? { ...settings, instrument: choice, instruments: { ...settings.instruments, [choice.instrument]: choice } } : settings
    );
  }, []);

  // The lanes top to bottom, as the highway draws them: the Jam tab's rows
  // (and a lesson room's lanes in every mode) from the highest note, lesson
  // mode's from the lowest. Default keys and the lists of sounds and keys
  // follow them.
  const uniqueLessonNotes = useMemo(() => (jamOnly ? [...allLaneNotes].reverse() : allLaneNotes), [allLaneNotes, jamOnly]);
  const generateDefaultKeyMapping = () => defaultLessonKeys(uniqueLessonNotes);

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

  // Jam tab: played notes go through the chosen instrument's channel (its
  // effects and level) into one bus, as remote players' notes do
  const jamNotesBusRef = useRef<Tone.Gain | null>(null);
  const jamChannelRef = useRef<InstrumentChannel | null>(null);
  useEffect(() => {
    if (!jamOnly) return;
    const bus = new Tone.Gain(1).connect(Tone.getDestination());
    // The notes and the backing together stay under 0 dBFS
    const limiter = new Tone.Limiter(-1);
    Tone.getDestination().chain(limiter);
    jamNotesBusRef.current = bus;
    jamChannelRef.current = new InstrumentChannel(bus);
    return () => {
      Tone.getDestination().chain();
      limiter.dispose();
      jamChannelRef.current?.dispose();
      bus.dispose();
      jamNotesBusRef.current = null;
      jamChannelRef.current = null;
    };
  }, [jamOnly]);

  // The chosen instrument, as its parameters and effects are set; the id of
  // the one that is loaded and can sound
  const [jamReadyInstrument, setJamReadyInstrument] = useState('');
  useEffect(() => {
    const channel = jamChannelRef.current;
    if (!channel || !jamInstrument || !jamChoice) return;
    let current = true;
    channel.set(jamInstrument, jamChoice, lessonProp.bpm).then(
      () => {
        if (current) setJamReadyInstrument(jamInstrument.id);
      },
      (err) => console.error(`[LessonPlayer] Could not load the instrument ${jamInstrument.name}:`, err)
    );
    return () => {
      current = false;
    };
    // (again once the ports have loaded: an effect port joins the chain)
  }, [jamInstrument, jamChoice, lessonProp.bpm, jamPorts]);

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

            if (/^(blob|data|https?):/.test(filename)) {
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
  const jamTrack = jamOnly && !jamWaitingForRoom ? jamTrackFor(lesson.backingTrack) : undefined;
  const jamSwing = jamSettings?.swings[lesson.id] ?? jamTrack?.swing ?? 0.5;
  const jamSwingRef = useRef(jamSwing);
  jamSwingRef.current = jamSwing;
  const jamTrackEdit = jamTrack ? (jamRoomState ?? jamSettings)?.tracks[jamTrack.file] : undefined;
  const jamTrackOriginal = useMemo(() => (jamTrack ? jamTrackParts(jamTrack).map((part) => part.notes) : null), [jamTrack]);
  const jamTrackNotes = jamTrackEdit?.parts ?? jamTrackOriginal;
  const jamTrackAdded = useMemo(() => jamTrackEdit?.added ?? [], [jamTrackEdit]);
  const jamTrackBars = jamTrackEdit?.bars ?? JAM_TRACK_BARS;
  const jamTrackBarsRef = useRef(jamTrackBars);
  jamTrackBarsRef.current = jamTrackBars;
  const jamTrackNotesRef = useRef(jamTrackNotes);
  jamTrackNotesRef.current = jamTrackNotes;
  const jamTrackAddedRef = useRef(jamTrackAdded);
  jamTrackAddedRef.current = jamTrackAdded;
  // The instrument each track plays: as chosen in the grid, else an added
  // track's own (the one it was added with); none for a track of the song's
  // own playing its original sound
  const jamPartTrackList = useMemo(
    () => (jamTrack ? jamPartTracks(jamTrackParts(jamTrack), jamTrackAdded) : []),
    [jamTrack, jamTrackAdded]
  );
  const jamTrackChoices = useMemo(() => {
    const choices: JamTrackInstruments = {};
    jamPartTrackList.forEach((partTrack, part) => {
      if (choices[partTrack.key]) return;
      const own = jamTrackNotes ? jamTrackNotes.length - jamTrackAdded.length : 0;
      const chosen =
        jamTrackEdit?.instruments?.[partTrack.key] ?? (part >= own ? choiceForSound(jamTrackAdded[part - own].sound) : null);
      // A port's track waits for the ports' catalog, silent, rather than play something else
      const pending = jamPorts === null && chosen?.instrument.startsWith('port:');
      if (chosen && (pending || findInstrument(jamInstruments, chosen.instrument))) choices[partTrack.key] = chosen;
    });
    return choices;
  }, [jamPartTrackList, jamTrackEdit, jamTrackAdded, jamTrackNotes, jamInstruments, jamPorts]);
  // Each track's instrument as the grid shows it: a synth's sound by its
  // preset's name, the others by theirs, and a kit's pads
  const jamTrackSounds = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(jamTrackChoices).flatMap(([key, choice]) => {
          const instrument = findInstrument(jamInstruments, choice.instrument);
          if (!instrument) return [];
          const preset = instrument.presets.find((candidate) => candidate.id === choice.preset);
          const name = instrument.engine === 'melodics-synth' ? (preset?.name ?? instrument.name) : instrument.name;
          return [[key, { name, ...(instrument.pads ? { pads: instrument.pads } : {}) }]];
        })
      ),
    [jamTrackChoices, jamInstruments]
  );
  // Which parts live instruments play (the others are rendered)
  const jamLiveParts = useMemo(
    () => jamPartTrackList.map((partTrack) => !!jamTrackChoices[partTrack.key]),
    [jamPartTrackList, jamTrackChoices]
  );
  const jamLivePartsRef = useRef(jamLiveParts);
  jamLivePartsRef.current = jamLiveParts;
  // The notes each mixer part was rendered from, which part it is (see
  // jamPartKey), and whether a live instrument plays it (left silent)
  const renderedTrackNotesRef = useRef<(JamTrackNote[] | null)[] | null>(null);
  const renderedTrackKeysRef = useRef<string[]>([]);
  const renderedTrackLiveRef = useRef<boolean[]>([]);

  // After an edit: take out the parts of removed tracks, add lanes for added
  // ones, render the edited parts again and swap them in at the same point of the loop
  useEffect(() => {
    const mixer = backingTrackRef.current;
    if (!jamTrack || !jamTrackNotes || !backingTrackLoaded || !(mixer instanceof JamBackingMixer)) return;
    const rendered = renderedTrackNotesRef.current;
    if (!rendered) return;
    const own = jamTrackNotes.length - jamTrackAdded.length;
    const addedAt = (part: number) => (part < own ? undefined : jamTrackAdded[part - own]);
    const keys = jamTrackNotes.map((_, part) => jamPartKey(part, addedAt(part)));
    const renderedKeys = renderedTrackKeysRef.current;
    const renderedLive = renderedTrackLiveRef.current;
    for (let part = renderedKeys.length - 1; part >= 0; part--) {
      if (keys.includes(renderedKeys[part])) continue;
      mixer.remove(part);
      renderedKeys.splice(part, 1);
      rendered.splice(part, 1);
      renderedLive.splice(part, 1);
    }
    for (let part = renderedKeys.length; part < keys.length; part++) {
      mixer.add();
      renderedKeys.push(keys[part]);
      // A new part with no notes is already right: silent
      rendered.push(jamTrackNotes[part].length ? null : jamTrackNotes[part]);
      renderedLive.push(true);
    }
    // Parts a live instrument now plays go silent here at once
    jamLiveParts.forEach((live, part) => {
      if (!live || renderedLive[part]) return;
      mixer.replace(part, silentJamPart());
      renderedLive[part] = true;
    });
    const changed = jamTrackNotes
      .map((_, part) => part)
      .filter((part) => !jamLiveParts[part] && (rendered[part] !== jamTrackNotes[part] || renderedLive[part]));
    jamTrackNotes.forEach((notes, part) => {
      if (jamLiveParts[part]) rendered[part] = notes;
    });
    if (changed.length === 0) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      for (const part of changed) {
        const notes = jamTrackNotes[part];
        renderJamBackingPart(jamTrack.file, part, notes, undefined, jamTrackBarsRef.current).then(
          (audio) => {
            if (cancelled || backingTrackRef.current !== mixer) return;
            mixer.replace(part, audio);
            rendered[part] = notes;
            renderedLive[part] = false;
          },
          (err) => console.error('[LessonPlayer] Could not render the edited backing track:', err)
        );
      }
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [jamTrack, jamTrackNotes, jamTrackAdded, jamLiveParts, backingTrackLoaded]);

  // The grid's mixer settings: levels, mutes and solos per part
  // Mixer settings are kept by track, whatever its tempo
  const jamMixKey = jamTrack ? jamTrackBaseFile(jamTrack.file) : '';
  const jamSavedMix = jamTrack ? jamSettings?.mixes[jamMixKey] : undefined;
  const jamPartCount = jamTrackNotes?.length ?? 0;
  const jamTrackMix = useMemo(
    () =>
      jamSavedMix ? fitJamTrackMix(jamSavedMix, jamPartCount) : jamTrackNotes ? defaultJamTrackMix(jamPartCount) : undefined,
    [jamSavedMix, jamPartCount, jamTrackNotes]
  );
  // A lesson room leaves its lesson track out of the backing: the hits play it
  useEffect(() => {
    const mixer = backingTrackRef.current;
    if (!jamTrackMix || !(mixer instanceof JamBackingMixer)) return;
    mixer.setLevels(jamTrackLevels(jamHeardMix(jamTrackMix, jamLesson)));
  }, [jamTrackMix, backingTrackLoaded, jamLesson]);

  // A lesson room's hits sound with the lesson track's own sound: its live
  // instrument when it has one, on the track's own pads or pitches
  const jamLessonVoicesRef = useRef<JamLessonVoices | null>(null);
  const [jamLessonVoices, setJamLessonVoices] = useState<JamLessonVoices | null>(null);
  // ...at the track's loudness, as the backing plays it
  useEffect(() => {
    const mixer = backingTrackRef.current;
    if (jamLessonVoices && backingTrackLoaded && mixer instanceof JamBackingMixer) jamLessonVoices.setScale(mixer.scale);
  }, [jamLessonVoices, backingTrackLoaded]);
  const jamLessonChoice = jamRoomLessonTrack ? jamTrackChoices[jamRoomLessonTrack] : undefined;
  useEffect(() => {
    if (!jamLesson || !jamTrack) return;
    const instrument = jamLessonChoice && findInstrument(jamInstruments, jamLessonChoice.instrument);
    const live =
      jamLessonChoice && instrument
        ? {
            instrument,
            choice: jamLessonChoice,
            bpm: jamTrack.bpm,
            notes: new Map(
              jamLesson.lanes.map((lane) => {
                const partTrack = jamPartTrackList[lane.part];
                return [lane.note, partTrack?.kind === 'drum' ? PAD_BASE_NOTE + partTrack.pad : lane.pitch] as const;
              })
            ),
          }
        : null;
    const voices = new JamLessonVoices(jamTrack.file, jamLesson.lanes, jamTrackAddedRef.current, jamTrackParts(jamTrack).length, live);
    voices.ready.catch((err) => console.error('[LessonPlayer] Could not prepare the lesson track\'s sounds:', err));
    jamLessonVoicesRef.current = voices;
    setJamLessonVoices(voices);
    return () => {
      voices.dispose();
      if (jamLessonVoicesRef.current === voices) jamLessonVoicesRef.current = null;
      setJamLessonVoices((current) => (current === voices ? null : current));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jamLesson, jamTrack, jamLessonChoice]);

  // The tracks live instruments play, in time with the backing track's loop
  // and through its mixer (levels, mutes and solos as the grid sets them)
  const jamTrackMixRef = useRef(jamTrackMix);
  jamTrackMixRef.current = jamTrackMix;
  const jamTrackRef = useRef(jamTrack);
  jamTrackRef.current = jamTrack;
  const jamBpmRef = useRef(lesson.bpm);
  jamBpmRef.current = lesson.bpm;
  const liveTracksRef = useRef<JamLiveTracks | null>(null);
  useEffect(() => {
    const mixer = backingTrackRef.current;
    if (!jamOnly || !backingTrackLoaded || !(mixer instanceof JamBackingMixer)) return;
    if (liveTracksRef.current) {
      liveTracksRef.current.route(mixer.input);
      return;
    }
    liveTracksRef.current = new JamLiveTracks(mixer.input, {
      start: () => (backingTrackRef.current?.state === 'started' ? jamStartRef.current : null),
      sixteenth: () => 60 / jamBpmRef.current / 4,
      loopSteps: () => jamTrackBarsRef.current * 16,
      swing: (step) => (jamTrackRef.current ? swung(jamTrackRef.current, step) : step),
      notes: () => jamTrackNotesRef.current ?? [],
      levels: () => (jamTrackMixRef.current ? jamTrackLevels(jamHeardMix(jamTrackMixRef.current, jamLessonRef.current)) : []),
    });
  }, [jamOnly, backingTrackLoaded]);
  useEffect(
    () => () => {
      liveTracksRef.current?.dispose();
      liveTracksRef.current = null;
    },
    []
  );
  useEffect(() => {
    const live = liveTracksRef.current;
    if (!live) return;
    const tracks: LiveTrack[] = [];
    jamPartTrackList.forEach((partTrack, part) => {
      const choice = jamTrackChoices[partTrack.key];
      const instrument = choice && findInstrument(jamInstruments, choice.instrument);
      if (!choice || !instrument) return;
      let track = tracks.find((candidate) => candidate.key === partTrack.key);
      if (!track) {
        track = { key: partTrack.key, instrument, choice, parts: [] };
        tracks.push(track);
      }
      track.parts.push({ part, pad: partTrack.kind === 'drum' ? partTrack.pad : null });
    });
    live.set(tracks, lesson.bpm);
  }, [jamPartTrackList, jamTrackChoices, jamInstruments, lesson.bpm, backingTrackLoaded]);

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
    // A jam playing on its own carries on from where it is once the track is back
    // (a song change starts it from the top; a room keeps its own time)
    if (jamStartRef.current !== null && !jamRoomRef.current) jamResumeAtRef.current = jamHeardPosition();
    setBackingTrackLoaded(false);

    // Jam backing tracks are rendered from their notes, as long as the grid made them
    if (jamOnly && jamWaitingForRoom) return;
    const jamTrackToLoad = jamOnly ? jamTrackFor(lesson.backingTrack) : undefined;
    if (jamTrackToLoad) {
      let cancelled = false;
      const notes = jamTrackNotesRef.current!;
      const added = jamTrackAddedRef.current;
      const live = jamLivePartsRef.current;
      loadJamBackingMixer(jamTrackToLoad, notes, live, jamTrackBarsRef.current).then(
        (mixer) => {
          if (cancelled) {
            mixer.dispose();
            return;
          }
          mixer.volume.value = -Infinity; // Start muted
          backingTrackRef.current = mixer;
          renderedTrackNotesRef.current = [...notes];
          renderedTrackLiveRef.current = [...live];
          const own = notes.length - added.length;
          renderedTrackKeysRef.current = notes.map((_, part) => jamPartKey(part, part < own ? undefined : added[part - own]));
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
  }, [lesson.id, lesson.backingTrack, jamOnly, jamTrackBars, jamWaitingForRoom]);

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
    if (currentMode !== 'jam' || jamIsPaused) return;

    let cancelled = false;
    let clockInterval: ReturnType<typeof setInterval> | null = null;
    let pulseInterval: ReturnType<typeof setInterval> | null = null;
    let resyncInterval: ReturnType<typeof setInterval> | null = null;
    // Its level is the volume slider's job, so moving the slider never restarts the jam
    const backing = backingTrackRef.current?.loaded && backingTrackLoaded ? backingTrackRef.current : null;
    // A song with a backing track starts once it has loaded (this runs again then)
    if (lesson.backingTrack && !backing) return;

    const begin = async () => {
      await Tone.start();
      if (cancelled) return;

      // The jam's grid on the audio clock: `start` is the audio time of its
      // first 16th, as it leaves the speakers
      const context = rawAudioContext();
      const room = jamRoomRef.current;
      let start: number;
      if (room && jamRoomStartAt !== null) {
        // In a room it is the room's: the first 16th left every player's speakers at the room's start
        start = audioTimeAt(context, room.clock.toPage(jamRoomStartAt));
      } else {
        // After a pause it carries on from where it stopped
        start = context.currentTime + 0.1 - jamResumeAtRef.current;
      }
      jamResumeAtRef.current = 0;
      jamStartRef.current = start;
      // The music comes in right away, or at a room's start still to come
      const playAt = Math.max(start, context.currentTime + 0.1);
      const offset = playAt - start;

      if (backing) {
        // An edit made while the audio was locked may have swapped the player
        const player = backingTrackRef.current ?? backing;
        player.loop = true;
        player.playbackRate = 1;
        player.start(playAt, offset);
        // The audio clock drifts from the room's: once the grid is off by more
        // than a few ms, the track jumps back onto the room's grid
        if (room && jamRoomStartAt !== null) {
          resyncInterval = setInterval(() => {
            const expected = audioTimeAt(context, room.clock.toPage(jamRoomStartAt));
            if (jamStartRef.current === null || Math.abs(expected - jamStartRef.current) < JAM_ROOM_RESYNC_S) return;
            const at = context.currentTime + 0.05;
            jamStartRef.current = expected;
            (backingTrackRef.current ?? backing).start(at, at - expected);
          }, JAM_ROOM_RESYNC_MS);
        }
      }
      // The beat's click: without a backing track, and in a lesson room (its Metronome)
      if (!backing || jamLessonRef.current) {
        const beatSeconds = 60 / lesson.bpm;
        const beatsPerBar = (lesson.timeSignature || { numerator: 4, denominator: 4 }).numerator;
        let nextBeat = Math.ceil(offset / beatSeconds);
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

      // The highway shows what is heard
      clockInterval = setInterval(() => {
        if (jamStartRef.current !== null) setCurrentTime(Math.max(0, (audioTimeAt(context) - jamStartRef.current) * 1000));
      }, 16);
    };
    begin();

    return () => {
      cancelled = true;
      if (clockInterval) clearInterval(clockInterval);
      if (pulseInterval) clearInterval(pulseInterval);
      if (resyncInterval) clearInterval(resyncInterval);
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
  }, [currentMode, lesson.bpm, lesson.timeSignature, lesson.backingTrack, backingTrackLoaded, jamIsPaused, jamRoomStartAt]);

  // A new song starts from its beginning
  useEffect(() => {
    jamResumeAtRef.current = 0;
  }, [lesson.id]);

  // Paused, the clock shows where the jam stopped (it runs on from there)
  const jamPausedAt = currentMode !== 'jam' || !jamIsPaused ? null : (jamRoomState?.position ?? jamResumeAtRef.current);
  useEffect(() => {
    if (jamPausedAt !== null) setCurrentTime(jamPausedAt * 1000);
  }, [jamPausedAt]);

  // Where the jam is, as heard (s)
  const jamHeardPosition = (): number =>
    jamStartRef.current === null ? 0 : Math.max(0, audioTimeAt(rawAudioContext()) - jamStartRef.current);

  const toggleJamPause = () => {
    const room = jamRoomRef.current;
    if (room && jamRoomState) {
      const { startAt, position } = jamRoomState;
      if (startAt !== null) room.setState({ startAt: null, position: jamHeardPosition() });
      else room.setState({ startAt: room.clock.now() + JAM_ROOM_START_LEAD_MS - position * 1000, position });
      return;
    }
    if (!jamPaused && jamStartRef.current !== null) jamResumeAtRef.current = jamHeardPosition();
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
    // A lesson room's track (off the room's clock: Free, Wait, Play): its own sounds
    if (jamLessonRef.current && !lesson.stemAudio) {
      if (!jamLessonVoicesRef.current?.play(note, startTime ?? Tone.now(), JAM_KEY_VELOCITY, volumeOverride ?? jamNotesVolumeRef.current)) {
        console.warn('[LessonPlayer] The lesson track\'s sounds are still being prepared; the note was not played.');
      }
      return;
    }
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
  playSoundRef.current = playSound;

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

  // Adds a dot to the highway, dropping the ones that have scrolled off
  const addJamNote = useCallback((note: Omit<JamNote, 'id'>, heardMs: number) => {
    const next = [
      ...jamNotesRef.current.filter((n) => n.timeMs > heardMs - JAM_NOTE_LIFETIME_MS),
      { ...note, id: ++jamNoteIdRef.current },
    ];
    jamNotesRef.current = next;
    setJamNotes(next);
  }, []);

  // Plays the row nearest `note` at the given position in 16ths (default: the
  // next point of a grid `grid` 16ths apart from where the music is heard) and
  // returns that position, or null when the jam clock isn't running. A note
  // with a `length` (in 16ths) ends by itself; one without is held until
  // releaseJamNote. In a room the note also goes to the other players, and
  // lands no sooner than they can all play it on the same 16th.
  const jamHeldRef = useRef(new Map<number, { note: number; at: number; slot: number }>());
  const playJamNote = useCallback((note: number, atSlot?: number, grid = 1, velocity = JAM_KEY_VELOCITY, length?: number): number | null => {
    const start = jamStartRef.current;
    if (start === null || jamRows.length === 0) return null;

    const row = jamRows.reduce((nearest, candidate) =>
      Math.abs(candidate - note) < Math.abs(nearest - note) ? candidate : nearest
    );
    const sixteenth = 60 / lesson.bpm / 4;
    const context = rawAudioContext();
    const heard = audioTimeAt(context) - start;
    const room = jamRoomRef.current?.ready ? jamRoomRef.current : null;
    const lead = room?.lead ?? 0;
    const slot = atSlot ?? hitSlot(heard / sixteenth, JAM_LATE_GRACE_S / sixteenth, lead / sixteenth, grid);
    const sounds = swungPosition(slot, jamSwingRef.current) * sixteenth;
    const timeMs = sounds * 1000;

    // The same pitch twice on one 16th sounds once
    if (jamNotesRef.current.some((n) => !n.peer && n.note === row && n.timeMs === timeMs)) return slot;
    const at = Math.max(start + sounds, context.currentTime + JAM_SCHEDULE_MARGIN_S);
    const channel = jamChannelRef.current;
    const instrument = jamInstrumentRef.current;
    const lessonVoices = jamLessonRef.current ? jamLessonVoicesRef.current : null;
    if (jamLessonRef.current) {
      // A lesson room: the hit is judged when it is pressed, and sounds with the lesson track's sound
      const engine = engineRef.current;
      const playing = engine?.getState() === 'playing';
      if (playing && atSlot === undefined) engine!.processNote(row, heard);
      else if (playing) {
        // A repeat of a held press is judged as it sounds
        window.setTimeout(() => {
          if (engineRef.current === engine && engine!.getState() === 'playing') engine!.processNote(row, at - start);
        }, Math.max(0, (at - context.currentTime) * 1000));
      }
      if (lesson.stemAudio) {
        // An imported song's track: the slice of its export the press is nearest, as lesson mode plays it
        const step = getPlayableStepForInput(row, playing ? engine!.getCurrentTimeSeconds() : heard);
        if (step) playSoundRef.current(row, step.note, jamNotesVolumeRef.current, step.slice, at, step.semitones);
      } else if (!lessonVoices?.play(row, at, velocity, jamNotesVolumeRef.current)) {
        console.warn('[LessonPlayer] The lesson track\'s sounds are still being prepared; the note was not played.');
      }
    } else if (channel && instrument) {
      const played = jamRowNote(instrument, row, jamRows);
      // A row played again while held starts over
      const held = jamHeldRef.current.get(row);
      if (held) channel.noteOff(held.note, at);
      channel.noteOn(played, velocity, at);
      if (length !== undefined) channel.noteOff(played, at + length * sixteenth);
      else jamHeldRef.current.set(row, { note: played, at, slot });
    }
    room?.sendNote({ song: lesson.id, slot, note: row, velocity, ...(length !== undefined ? { length } : {}) });
    addJamNote({ note: row, timeMs }, heard * 1000);
    return slot;
  }, [jamRows, lesson.bpm, lesson.id, lesson.stemAudio, addJamNote, getPlayableStepForInput]);

  // A held row let go: it ends now, never before it started
  const releaseJamNote = useCallback((note: number) => {
    const start = jamStartRef.current;
    if (start === null || jamRows.length === 0) return;
    const row = jamRows.reduce((nearest, candidate) =>
      Math.abs(candidate - note) < Math.abs(nearest - note) ? candidate : nearest
    );
    const held = jamHeldRef.current.get(row);
    if (!held) return;
    jamHeldRef.current.delete(row);
    const context = rawAudioContext();
    const off = Math.max(context.currentTime + JAM_SCHEDULE_MARGIN_S, held.at + JAM_SHORTEST_NOTE_S);
    jamChannelRef.current?.noteOff(held.note, off);
    const sixteenth = 60 / lesson.bpm / 4;
    const length = Math.max(JAM_SHORTEST_NOTE_S, off - held.at) / sixteenth;
    const room = jamRoomRef.current?.ready ? jamRoomRef.current : null;
    room?.sendNote({ song: lesson.id, slot: held.slot, note: row, off: length });
  }, [jamRows, lesson.bpm, lesson.id]);

  // Another player's note: on its own 16th when it came in time, else like a late hit
  const remoteVoicesRef = useRef<JamRemoteVoices | null>(null);
  const playRemoteJamNote = useCallback((from: string, note: JamRoomNote) => {
    const start = jamStartRef.current;
    if (start === null || note.song !== lesson.id) return;
    const sixteenth = 60 / lesson.bpm / 4;
    const context = rawAudioContext();
    const earliest = (context.currentTime + JAM_SCHEDULE_MARGIN_S - start) / sixteenth;
    const slot = remoteNoteSlot(note.slot, earliest, JAM_LATE_GRACE_S / sixteenth);
    const sounds = swungPosition(slot, jamSwingRef.current) * sixteenth;
    const voices = remoteVoicesRef.current;
    if (note.off !== undefined) {
      // A held note let go: as long as it was held, never before now
      voices?.release(from, note.note, jamRows, Math.max(context.currentTime + JAM_SCHEDULE_MARGIN_S, start + sounds + note.off * sixteenth));
      return;
    }
    const length = note.length !== undefined ? note.length * sixteenth : undefined;
    if (jamLessonRef.current && lesson.stemAudio) {
      // Another player's hit on an imported song's track: the slice nearest its time in the song
      const loopSeconds = lesson.loop ? ((lesson.loop.endTick - lesson.loop.startTick) / 480) * (60 / lesson.bpm) : 0;
      const step = getPlayableStepForInput(note.note, loopSeconds > 0 ? sounds % loopSeconds : sounds);
      if (step) playSoundRef.current(note.note, step.note, jamNotesVolumeRef.current, step.slice, start + sounds, step.semitones);
    } else if (jamLessonRef.current) {
      if (!jamLessonVoicesRef.current?.play(note.note, start + sounds, note.velocity ?? JAM_KEY_VELOCITY, jamNotesVolumeRef.current)) {
        console.warn('[LessonPlayer] The lesson track\'s sounds are still being prepared; a player\'s note was not played.', { from });
      }
    } else if (!voices?.play(from, note.note, jamRows, start + sounds, note.velocity ?? JAM_KEY_VELOCITY, length)) {
      console.warn('[LessonPlayer] A jam room player\'s instrument is still loading; their note was not played.', { from });
    }
    addJamNote({ note: note.note, timeMs: sounds * 1000, peer: from }, (audioTimeAt(context) - start) * 1000);
  }, [lesson.id, lesson.bpm, lesson.loop, lesson.stemAudio, jamRows, addJamNote, getPlayableStepForInput]);
  const playRemoteJamNoteRef = useRef(playRemoteJamNote);
  playRemoteJamNoteRef.current = playRemoteJamNote;

  // Jam rooms. This player's instrument, as the others play it
  const jamRoomSound: JamRoomSound | null = jamChoice ?? null;
  // How long before a note sounds this device must have it (s)
  const jamRoomNeed = (): number => {
    const context = rawAudioContext();
    return JAM_ROOM_RECEIVE_MARGIN_S + Math.max(0, context.currentTime - audioTimeAt(context));
  };

  // The room the app put this player in: joined on arrival, left on the way
  // out. A room that ends by itself (full, gone, connection lost) is reported
  // to the app, which takes the player back.
  const onJamRoomEndRef = useRef(onJamRoomEnd);
  onJamRoomEndRef.current = onJamRoomEnd;
  const jamRoomKey = jamRoomJoin?.key;
  const jamRoomEdit = jamRoomJoin?.edit;
  const jamRoomCreate = jamRoomJoin?.create;
  useEffect(() => {
    if (!jamRoomServer || !jamRoomKey || !jamSettings) return;
    let first = true;
    const wasPlaying = !jamIsPaused;
    const room: JamRoom = new JamRoom(
      jamRoomKey,
      jamRoomServer,
      { edit: jamRoomEdit, create: jamRoomCreate, name: jamName, sound: jamRoomSound, need: jamRoomNeed() },
      {
        onState: (state) => {
          // A Jam room this player is alone in (just opened, or come back to
          // while it waited, paused) plays on from where it is
          if (first) {
            first = false;
            if (wasPlaying && !jamRoomEdit && state.startAt === null && room.players().length === 1) {
              const { position } = state;
              room.setState({ startAt: room.clock.now() - position * 1000, position });
              return;
            }
          }
          setJamRoomState((prev) => keepUnchangedTracks(prev, state));
        },
        onPlayers: setJamRoomPlayers,
        onNote: (from, note) => playRemoteJamNoteRef.current(from, note),
        onClosed: (reason) => onJamRoomEndRef.current?.(reason),
      }
    );
    jamRoomRef.current = room;
    setJamRoom(room);
    return () => {
      room.leave();
      remoteVoicesRef.current?.dispose();
      remoteVoicesRef.current = null;
      jamRoomRef.current = null;
      setJamRoom(null);
      setJamRoomState(null);
      setJamRoomPlayers([]);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jamRoomServer, jamRoomKey, jamRoomEdit, jamRoomCreate]);

  // A changed name goes out once typing pauses
  useEffect(() => {
    if (!jamRoom) return;
    const timer = setTimeout(() => jamRoom.setPeer(jamName, jamRoomSound, jamRoomNeed()), 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jamRoom, jamRoomSound, jamName]);

  // The other players' ships, and this player's going out to them
  const jamShips = useMemo<JamShip[]>(
    () =>
      jamRoomPlayers.flatMap((player) =>
        !player.you && player.row !== null
          ? [{ id: player.id, name: player.name, color: player.color, row: player.row }]
          : []
      ),
    [jamRoomPlayers]
  );
  const handleJamCursorMove = useCallback((row: number) => jamRoomRef.current?.setCursor(row), []);

  // The other players' instruments, played here
  useEffect(() => {
    const bus = jamNotesBusRef.current;
    if (!jamRoom || !bus) return;
    const voices = (remoteVoicesRef.current ??= new JamRemoteVoices(bus));
    voices.setLevel(jamNotesDb(jamNotesVolume));
    const others = jamRoomPlayers.filter((player) => !player.you);
    voices.keepOnly(others.map((player) => player.id));
    for (const player of others) voices.set(player.id, player.sound, jamInstruments, lessonProp.bpm);
  }, [jamRoom, jamRoomPlayers, jamInstruments, lessonProp.bpm, jamNotesVolume]);
  // This player's own level
  useEffect(() => {
    if (jamChannelRef.current) jamChannelRef.current.level = jamNotesDb(jamNotesVolume);
  }, [jamNotesVolume, jamOnly]);

  // Repeat spacing in 16ths: the latest held number key's rate, else the
  // chosen one; none when no repeat is chosen
  const jamHoldStep = useCallback((): number | null => {
    const keys = jamKeyDivisionsRef.current;
    const division = keys.length ? keys[keys.length - 1] : jamHoldDivisionRef.current;
    return division === null ? null : (16 / division) * (jamHoldTripletRef.current ? 2 / 3 : 1);
  }, []);

  // Starts, steers or stops the repeat. A held pointer plays its row, a held
  // number key the ship's row: at once (on the next 16th, or triplet), then
  // again every step. A changed rate continues on its own grid.
  const updateJamHold = useCallback(() => {
    const note = jamPointerNoteRef.current ?? (jamKeyDivisionsRef.current.length ? jamCursorNoteRef.current : null);
    const step = jamHoldStep();
    if (note === null || step === null) {
      if (jamHoldTimerRef.current) clearInterval(jamHoldTimerRef.current);
      jamHoldTimerRef.current = null;
      jamHoldRef.current = null;
      // No repeat: each row the pointer presses or is dragged onto plays once
      if (note !== null && jamPlayedOnceRef.current !== note) playJamNote(note, undefined, 1, JAM_KEY_VELOCITY, 0.9);
      jamPlayedOnceRef.current = note;
      return;
    }
    jamPlayedOnceRef.current = null;
    if (jamHoldRef.current) {
      jamHoldRef.current.note = note;
      return;
    }
    // Swung, 8ths and slower start on an 8th: from an odd 16th they would not swing
    const grid = jamHoldTripletRef.current ? Math.min(step, 2 / 3) : jamSwingRef.current > 0.5 && step >= 2 ? 2 : 1;
    // Each repeat lasts nearly to the next
    const slot = playJamNote(note, undefined, grid, JAM_KEY_VELOCITY, step * 0.9);
    if (slot === null) return;
    jamHoldRef.current = { note, step, nextSlot: slot + step };
    jamHoldTimerRef.current = setInterval(() => {
      const hold = jamHoldRef.current;
      const start = jamStartRef.current;
      if (!hold || start === null) return;
      const sixteenth = 60 / lesson.bpm / 4;
      const step = jamHoldStep();
      if (step === null) return;
      if (step !== hold.step) {
        const played = hold.nextSlot - hold.step;
        const now = (Tone.now() - start) / sixteenth;
        hold.nextSlot = Math.max(Math.floor(played / step + 1e-6) + 1, Math.ceil(now / step)) * step;
        hold.step = step;
      }
      while (start + hold.nextSlot * sixteenth < Tone.now() + JAM_HOLD_LOOKAHEAD_S) {
        playJamNote(hold.note, hold.nextSlot, 1, JAM_KEY_VELOCITY, hold.step * 0.9);
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

  // How far the backing track has played as heard, in 16ths
  const getJamStep = useCallback(
    () =>
      jamStartRef.current === null ? null : (audioTimeAt(rawAudioContext()) - jamStartRef.current) / (60 / lesson.bpm / 4),
    [lesson.bpm]
  );

  // Shared function to handle note input from both MIDI and keyboard
  const handleNoteInput = useCallback((hardwareNote: number, timestamp: number, velocity = JAM_KEY_VELOCITY) => {
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
      playJamNote(translatedNote, undefined, 1, velocity);
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
    if (currentMode === 'jam') releaseJamNote(note);
    engineRef.current?.processNoteOff(note);
  }, [deviceMapping, currentMode, releaseJamNote]);
  const handleNoteReleaseRef = useRef(handleNoteRelease);
  handleNoteReleaseRef.current = handleNoteRelease;

  // MIDI keyboards in the browser play the Jam with their velocity, and their
  // keys are held until let go
  const handleNoteInputRef = useRef(handleNoteInput);
  handleNoteInputRef.current = handleNoteInput;
  useWebMidi(
    ({ note, velocity }) => handleNoteInputRef.current(note, 0, velocity),
    ({ note }) => handleNoteReleaseRef.current(note),
    jamOnly && !window.electronAPI
  );

  useEffect(() => {
    // Initialize engine
    const engine = new LessonEngine({
      onHitFeedback: (feedback) => {
        console.log('[LessonPlayer] onHitFeedback received:', feedback);
        setRecentFeedback((prev) => [...prev.slice(-9), feedback]);
        recordLessonHitRef.current(feedback);
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

  // A lesson room: the lesson plays on the room's clock, looping with its
  // song, and pauses with it. Each step's judgment is kept by the loop it
  // was played in, to draw it filled (or faded) on the highway.
  const jamLessonLoopSeconds = lesson.loop ? (lesson.loop.endTick - lesson.loop.startTick) / 480 * (60 / lesson.bpm) : 0;
  const [jamLessonHits, setJamLessonHits] = useState<Map<string, JamLessonHit>>(() => new Map());
  // Counts the restarts of a lesson room's lesson on the room's clock
  const [jamLessonRun, setJamLessonRun] = useState(0);
  useEffect(() => setJamLessonHits(new Map()), [lesson]);
  const recordLessonHitRef = useRef<(feedback: HitFeedback) => void>(() => {});
  recordLessonHitRef.current = (feedback) => {
    const start = jamStartRef.current;
    const index = lesson.steps.indexOf(feedback.expectedStep);
    if (!jamLesson || start === null || index < 0 || jamLessonLoopSeconds <= 0) return;
    const heard = audioTimeAt(rawAudioContext()) - start;
    const stepSeconds = (feedback.expectedStep.tick / 480) * (60 / lesson.bpm);
    const loop = Math.round((heard - stepSeconds) / jamLessonLoopSeconds);
    setJamLessonHits((prev) => {
      const next = new Map([...prev].filter(([key]) => Number(key.split(':')[0]) >= loop - 1));
      next.set(`${loop}:${index}`, { accuracy: feedback.accuracy, deltaMs: feedback.timingDelta });
      return next;
    });
  };
  // Auto-play: the lesson's steps play by themselves, at this volume
  useEffect(() => {
    if (!jamLesson || autoPlayVolume <= 0 || jamIsPaused || jamLessonLoopSeconds <= 0) return;
    const loop = jamLessonLoopSeconds;
    const times = lesson.steps.map((step) => (step.tick / 480) * (60 / lesson.bpm));
    const scheduled = new Set<string>();
    const timer = setInterval(() => {
      const start = jamStartRef.current;
      const voices = jamLessonVoicesRef.current;
      if (start === null || (!voices && !lesson.stemAudio)) return;
      const now = audioTimeAt(rawAudioContext()) - start;
      const ahead = now + JAM_HOLD_LOOKAHEAD_S * 2;
      for (let k = Math.floor(now / loop); k <= Math.floor(ahead / loop); k++) {
        lesson.steps.forEach((step, index) => {
          const at = k * loop + times[index];
          const key = `${k}:${index}`;
          if (at < now || at >= ahead || scheduled.has(key)) return;
          scheduled.add(key);
          // An imported song's track plays each step's own slice of its export
          if (lesson.stemAudio) playSoundRef.current(step.note, step.note, autoPlayVolume, step.slice, start + at, step.semitones);
          else voices?.play(step.note, start + at, step.velocity, autoPlayVolume);
        });
      }
    }, 40);
    return () => clearInterval(timer);
  }, [jamLesson, autoPlayVolume, jamIsPaused, jamLessonLoopSeconds, lesson]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!jamLesson || !engine || jamLessonLoopSeconds <= 0 || currentMode !== 'jam') return;
    if (jamIsPaused || !backingTrackLoaded) {
      if (engine.getState() === 'playing') engine.pause();
      return;
    }
    // Starts once the jam's clock runs
    const clock = () => {
      const start = jamStartRef.current;
      const heard = start === null ? 0 : audioTimeAt(rawAudioContext()) - start;
      return ((heard % jamLessonLoopSeconds) + jamLessonLoopSeconds) % jamLessonLoopSeconds;
    };
    const timer = setInterval(() => {
      if (jamStartRef.current === null) return;
      clearInterval(timer);
      if (engine.getState() === 'paused') engine.resume();
      else if (engine.getState() !== 'playing') engine.startOnClock(clock);
    }, 30);
    return () => clearInterval(timer);
    // `lesson`: its engine is made again for each one (a sound switched on or off, a new tempo)
  }, [jamLesson, lesson, currentMode, jamIsPaused, backingTrackLoaded, jamLessonLoopSeconds, jamLessonRun]);

  useEffect(() => {
    if (engineRef.current) {
      engineRef.current.setPracticeMode(practiceMode);
    }
  }, [practiceMode]);

  // Set up keyboard event listeners
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Keys typed into a field (a name, a room code) are text, not notes
      if (isTextEntry(e.target)) return;
      // ESC key to stop lesson and exit game mode; the Jam tab has no other mode
      if (e.key === 'Escape' && !jamOnly) {
        e.preventDefault();
        setIsGameMode(false);
        setCurrentMode('free'); // Reset to free mode when exiting game
        if (engineRef.current && engineRef.current.getState() !== 'stopped') {
          engineRef.current.stop();
        }
        return;
      }

      // The Daw is only its grid: keys play no notes there
      if (jamSection === 'daw') return;
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
  }, [handleNoteInput, keyBindings, currentMode, setJamKeys, jamOnly, jamSection]);

  // Update current time from the engine's logical lesson clock. The lesson
  // duration stays fixed; speed changes how quickly this playhead advances.
  // The Jam keeps its own clock (a lesson room's engine follows it).
  useEffect(() => {
    if (currentMode === 'jam') return;
    if (state === 'playing') {
      const interval = setInterval(() => {
        setCurrentTime((engineRef.current?.getCurrentTimeSeconds() ?? 0) * 1000);
      }, 16); // ~60fps

      return () => clearInterval(interval);
    } else if (state === 'stopped') {
      setCurrentTime(0);
    }
  }, [state, practiceMode.speedMultiplier, currentMode]);

  const [showSoundSettings, setShowSoundSettings] = useState<boolean>(false);
  const soundLabel = (note: number, index: number) => fullLesson.laneLabels?.[note] ?? `Sound ${index + 1}`;

  useEffect(() => {
    resetRunState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabledNotes]);

  // Switch a sound in or out of the practice. Not while notes are running:
  // the scored notes change, so the run resets (like Restart).
  const toggleSound = (note: number) => {
    // A lesson room's lesson is always running: its sounds change as it plays
    if (state === 'playing' && !jamLesson) return;
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
      {uniqueLessonNotes.map((note) => {
        const index = allLaneNotes.indexOf(note);
        const on = !disabledNotes.has(note);
        const lastOn = on && disabledNotes.size === allLaneNotes.length - 1;
        return (
          <button
            key={note}
            className={`sound-toggle ${on ? 'on' : 'off'}`}
            onClick={() => toggleSound(note)}
            disabled={(state === 'playing' && !jamLesson) || lastOn}
            title={
              state === 'playing' && !jamLesson
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
    // A lesson room's game ends back on the room's clock
    if (jamLesson) {
      setShowCompletion(false);
      setFinalScore(null);
      handleModeChange('jam');
      return;
    }
    if (onComplete) {
      onComplete();
    }
  };

  // A lesson room's Restart: this player's lesson from its start, in the mode
  // they are in (on the room's clock, the room plays on)
  const handleLessonRoomRestart = () => {
    const engine = engineRef.current;
    if (currentMode === 'free' || currentMode === 'wait') {
      setPlayedNotes(new Set());
      setWaitModeStepIndex(0);
      return;
    }
    if (isGameMode) {
      handleGameRestart();
      return;
    }
    if (!engine) return;
    engine.stop();
    engine.loadLesson(lesson);
    resetRunState();
    if (currentMode === 'jam') {
      setJamLessonHits(new Map());
      setJamLessonRun((run) => run + 1);
    } else {
      engine.start();
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
    if (accuracy >= 90) return SUCCESS;
    if (accuracy >= 75) return WARNING;
    if (accuracy >= 60) return ACCENT;
    return DANGER;
  };

  const getFeedbackColor = (feedback: HitFeedback): string => {
    switch (feedback.accuracy) {
      case 'perfect':
        return SUCCESS;
      case 'good':
        return WARNING;
      case 'early':
      case 'late':
        return ACCENT;
      case 'miss':
        return DANGER;
      default:
        return TEXT;
    }
  };

  // Jam tab, with the sidebar hidden: back and the sidebar's button lead the
  // highway's or the grid's toolbar, where the sidebar's own header has them
  // A grid edit saved: in the room (and so to the Daw song), or in this
  // browser. Instruments of tracks no longer there are left out.
  const saveJamTrackEdit = (
    parts: JamTrackNote[][],
    added: JamAddedPart[],
    bars: number,
    instruments: JamTrackInstruments,
    mix?: JamTrackMix
  ) => {
    if (!jamTrack || !jamSettings) return;
    const mixes = mix ? { ...jamSettings.mixes, [jamMixKey]: mix } : jamSettings.mixes;
    const keys = new Set(jamPartTracks(jamTrackParts(jamTrack), added).map((partTrack) => partTrack.key));
    const kept = Object.fromEntries(Object.entries(instruments).filter(([key]) => keys.has(key)));
    const edit: JamTrackEdit = {
      parts,
      ...(added.length ? { added } : {}),
      ...(bars !== JAM_TRACK_BARS ? { bars } : {}),
      ...(Object.keys(kept).length ? { instruments: kept } : {}),
    };
    if (jamRoom && jamRoomState) {
      setJamRoomState({ ...jamRoomState, tracks: { ...jamRoomState.tracks, [jamTrack.file]: edit } });
      jamRoom.setTrack(jamTrack.file, edit);
      if (mix) setJamSettings({ ...jamSettings, mixes });
    } else {
      setJamSettings({ ...jamSettings, tracks: { ...jamSettings.tracks, [jamTrack.file]: edit }, mixes });
    }
  };
  // A track's instrument chosen in the panel (null: back to its original sound)
  const setJamTrackInstrument = (key: string, choice: InstrumentChoice | null) => {
    if (!jamTrackNotes) return;
    const instruments = { ...(jamTrackEdit?.instruments ?? {}) };
    if (choice) instruments[key] = choice;
    else delete instruments[key];
    // An added kit track gets a row per pad of its new kit: rows added after
    // every other part (the mixer adds parts at the end), or its last rows
    // taken out when none of them holds a note
    const addedId = key.startsWith('added-') ? key.slice('added-'.length) : null;
    const pads = (choice && findInstrument(jamInstruments, choice.instrument)?.pads?.length) ?? 0;
    const own = jamTrackNotes.length - jamTrackAdded.length;
    const rows = jamTrackAdded.flatMap((part, index) => (part.track === addedId && part.drum !== undefined ? [own + index] : []));
    const mix = jamTrackMix ?? defaultJamTrackMix(jamTrackNotes.length);
    let parts = jamTrackNotes;
    let added = jamTrackAdded;
    let { levels, mutes, solos } = mix;
    if (addedId && pads && rows.length > pads && rows.slice(pads).every((part) => jamTrackNotes[part].length === 0)) {
      const drop = new Set(rows.slice(pads));
      const keep = (_: unknown, part: number) => !drop.has(part);
      parts = parts.filter(keep);
      added = added.filter((_, index) => keep(null, own + index));
      [levels, mutes, solos] = [levels.filter(keep), mutes.filter(keep), solos.filter(keep)];
    } else if (addedId && pads && rows.length && rows.length < pads) {
      const count = pads - rows.length;
      parts = [...parts, ...Array.from({ length: count }, () => [])];
      added = [...added, ...Array.from({ length: count }, (_, i): JamAddedPart => ({ track: addedId, sound: choice!.instrument, drum: rows.length + i }))];
      [levels, mutes, solos] = [[...levels, ...Array(count).fill(1)], [...mutes, ...Array(count).fill(false)], [...solos, ...Array(count).fill(false)]];
    }
    const resized = parts !== jamTrackNotes;
    saveJamTrackEdit(parts, added, jamTrackBars, instruments, resized ? { levels, mutes, solos } : undefined);
  };
  // The panel's view of a track: its name, kind, and its original sound when it is the song's own
  const jamTrackInstrumentTarget = (() => {
    if (!instrumentsFor || instrumentsFor === 'jam' || !jamTrack) return null;
    const part = jamPartTrackList.findIndex((partTrack) => partTrack.key === instrumentsFor);
    if (part < 0) return null;
    const kind = jamPartTrackList[part].kind;
    const own = instrumentsFor === 'drums' || instrumentsFor.startsWith('part-');
    const name = instrumentsFor === 'drums' ? 'Drums' : own ? (jamTrackParts(jamTrack)[part]?.name ?? '') : (jamTrackSounds[instrumentsFor]?.name ?? '');
    return { name, kind, ...(own ? { original: () => setJamTrackInstrument(instrumentsFor, null) } : {}) };
  })();

  const jamToolbar =
    jamOnly && !showJamSettings ? (
      <>
        {onComplete && (
          <button className="jam-corner-btn jam-back-btn" onClick={onComplete} title="Back">
            <BackIcon />
          </button>
        )}
        <button className="jam-corner-btn" onClick={() => setShowJamSettings(true)} title="Show sidebar">
          <SidebarIcon />
        </button>
        {jamSection !== 'daw' && !jamLesson && (
          <button className="jam-corner-btn" onClick={() => setInstrumentsFor('jam')} title="Instruments">
            <InstrumentsIcon />
          </button>
        )}
      </>
    ) : null;

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
      <div className={`highway-container ${isGameMode && !jamOnly ? 'fullscreen' : ''} ${jamOnly && showJamSettings ? 'with-jam-settings' : ''}`}>

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
            toolbar={jamToolbar}
            track={jamTrack}
            notes={jamTrackNotes}
            added={jamTrackAdded}
            bars={jamTrackBars}
            edited={!!jamTrackEdit || !!jamSettings.mixes[jamMixKey]}
            lanesOpen={jamSettings.lanesOpen}
            onLanesOpenChange={(lanesOpen) => setJamSettings({ ...jamSettings, lanesOpen })}
            mix={jamTrackMix!}
            onMixChange={(mix) => setJamSettings({ ...jamSettings, mixes: { ...jamSettings.mixes, [jamMixKey]: mix } })}
            tempo={jamSection === 'daw' && jamRoom && jamRoomState ? lesson.bpm : undefined}
            onTempoChange={(bpm) => jamRoom?.setTempo(bpm)}
            paused={jamIsPaused}
            onTogglePause={toggleJamPause}
            onChange={(parts, added, bars) => saveJamTrackEdit(parts, added, bars, jamTrackEdit?.instruments ?? {})}
            trackSounds={jamTrackSounds}
            onTrackInstrument={(key) => setInstrumentsFor(key)}
            onLiveAudition={(part, pitch) => {
              const partTrack = jamPartTrackList[part];
              if (!partTrack || !jamTrackChoices[partTrack.key]) return false;
              return !!liveTracksRef.current?.audition(partTrack.key, { pitch, pad: partTrack.kind === 'drum' ? partTrack.pad : null });
            }}
            onReset={() => {
              const mixes = { ...jamSettings.mixes };
              delete mixes[jamMixKey];
              if (jamRoom && jamRoomState) {
                const tracks = { ...jamRoomState.tracks };
                delete tracks[jamTrack.file];
                setJamRoomState({ ...jamRoomState, tracks });
                jamRoom.setTrack(jamTrack.file, null);
                setJamSettings({ ...jamSettings, mixes });
                return;
              }
              const tracks = { ...jamSettings.tracks };
              delete tracks[jamTrack.file];
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
            onJamCursorMove={jamRoom ? handleJamCursorMove : undefined}
            jamShips={jamShips}
            holdNotes={!!lesson.holdNotes}
            holdingSteps={holdingSteps}
            onNoteReached={isGameMode ? handleNoteReached : undefined}
            jamToolbar={jamToolbar}
            jamLesson={jamLesson && currentMode === 'jam' ? { loopMs: jamLessonLoopSeconds * 1000, hits: jamLessonHits } : undefined}
            highestOnTop={jamOnly}
          />
        )}

        {/* Play button - bottom right of highway (the Jam tab is always running) */}
        {!isGameMode && !jamOnly && (
          <button className="highway-play-btn" onClick={handleStart} title="Start Game">
            <span className="play-icon">&#9654;</span>
          </button>
        )}

        {jamOnly && showJamSettings && jamSettings && jamSounds && (
          <JamSettingsPanel
            section={jamSection}
            lesson={
              jamLesson
                ? {
                    score,
                    lanes: renderSoundToggles(),
                    autoPlay: autoPlayVolume,
                    onAutoPlayChange: setAutoPlayVolume,
                    mode: currentMode,
                    game: isGameMode,
                    onModeChange: handleModeChange,
                    waitStep: currentMode === 'wait' ? { step: waitModeStepIndex + 1, total: lesson.steps.length } : undefined,
                    tempo: jamRoom && !jamRoomAbleton ? lesson.bpm : null,
                    onTempoChange: (bpm) => jamRoom?.setTempo(bpm),
                    speed: practiceMode.speedMultiplier,
                    onSpeedChange: handleSpeedChange,
                    metronome: metronomeVolume,
                    onMetronomeChange: setMetronomeVolume,
                    paused: currentMode === 'jam' ? jamIsPaused : state === 'paused',
                    onTogglePause: currentMode === 'jam' ? toggleJamPause : handleGamePlayPause,
                    onRestart: handleLessonRoomRestart,
                    onStartGame: handleStart,
                    collapsed: isCollapsed,
                    onCollapsedChange: setIsCollapsed,
                  }
                : undefined
            }
            songs={jamSection ? [lessonProp] : (jamSongs ?? [lessonArg])}
            songId={lessonProp.id}
            onSongChange={(songId) => setJamSettings({ ...jamSettings, songId })}
            room={
              jamRoom
                ? {
                    code: jamRoom.visibility === 'private' ? jamRoom.code : null,
                    joined: !!jamRoomState,
                    players: jamRoomPlayers,
                  }
                : undefined
            }
            roomName={jamName}
            onRoomNameChange={setJamName}
            view={jamView}
            onViewChange={jamTrack && !jamSection ? setJamView : undefined}
            instrument={
              jamInstrument && jamChoice
                ? {
                    name: jamInstrument.name,
                    category: jamInstrument.category,
                    preset: jamInstrument.presets.find((preset) => preset.id === jamChoice.preset)?.name ?? '',
                    tag: jamInstrument.presets.find((preset) => preset.id === jamChoice.preset)?.tag,
                    art: jamInstruments.indexOf(jamInstrument),
                  }
                : null
            }
            onOpenInstruments={() => setInstrumentsFor('jam')}
            holdDivisions={JAM_HOLD_DIVISIONS}
            holdDivision={jamKeyDivisions.length ? jamKeyDivisions[jamKeyDivisions.length - 1] : jamHoldDivision}
            onHoldDivisionChange={setJamHoldDivision}
            holdTriplet={jamHoldTriplet}
            onHoldTripletChange={setJamHoldTriplet}
            swing={jamSwing}
            onSwingChange={(swing) => setJamSettings({ ...jamSettings, swings: { ...jamSettings.swings, [lessonProp.id]: swing } })}
            notesVolume={jamNotesVolume}
            onNotesVolumeChange={setJamNotesVolume}
            backingVolume={backingTrackVolume}
            onBackingVolumeChange={setBackingTrackVolume}
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

        {jamOnly && instrumentsFor === 'jam' && jamSettings && jamChoice && (
          <InstrumentPanel
            instruments={jamInstruments}
            choice={jamChoice}
            loading={jamReadyInstrument !== jamChoice.instrument}
            saved={jamSettings.instruments}
            onChange={setJamChoice}
            onClose={() => setInstrumentsFor(null)}
          />
        )}
        {jamOnly && instrumentsFor && instrumentsFor !== 'jam' && jamSettings && jamTrackInstrumentTarget && (
          <InstrumentPanel
            key={instrumentsFor}
            instruments={jamInstruments}
            choice={jamTrackChoices[instrumentsFor] ?? null}
            track={jamTrackInstrumentTarget}
            loading={false}
            saved={jamSettings.instruments}
            onChange={(choice) => setJamTrackInstrument(instrumentsFor, choice)}
            onClose={() => setInstrumentsFor(null)}
          />
        )}

        {/* Game mode settings toggle button - left side */}
        {isGameMode && !jamOnly && !showGameSettings && (
          <button
            className="game-settings-toggle"
            onClick={() => setShowGameSettings(true)}
            title="Game Settings"
          >
            <span className="settings-icon">&#9881;</span>
          </button>
        )}

        {/* Game mode collapsible settings sidebar - LEFT side */}
        {isGameMode && !jamOnly && showGameSettings && (
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
