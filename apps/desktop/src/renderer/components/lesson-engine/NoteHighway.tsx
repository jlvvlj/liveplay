import {
  Fragment,
  useEffect,
  useRef,
  useState,
  useMemo,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { LessonStep, HitFeedback } from '../../types/lesson';
import { HOLD_MIN_MS, stepDurationMs } from './holdNotes';
import { SOUND_COLORS } from '../../styles/palette';
import { JamSpace } from './JamSpace';
import './NoteHighway.css';

export type HighwayMode = 'free' | 'wait' | 'play' | 'jam';

// A note played in jam mode, already snapped to its 16th (ms on the jam clock).
// Another player's note in a jam room has their id (`peer`); it leaves from
// their ship.
export interface JamNote {
  id: number;
  note: number;
  timeMs: number;
  peer?: string;
}

// Another player's ship in a jam room: its height in rows from the top
export interface JamShip {
  id: string;
  name: string;
  color: string;
  row: number;
}

interface NoteHighwayProps {
  steps: LessonStep[];
  currentTime: number;
  bpm: number;
  activePads?: Set<number>;
  hitFeedback?: HitFeedback[];
  onNoteReached?: (step: LessonStep) => void;
  // Mode support
  mode?: HighwayMode;
  currentStepIndex?: number; // For wait mode - which step to highlight
  playedSteps?: Set<number>; // Steps that have been played in free/wait mode
  isCollapsed?: boolean; // Collapse all lanes to single line (practice modes)
  // Note labels for practice modes
  noteToKeyMap?: { [note: number]: string }; // Map of MIDI note to key binding
  labelMode?: 'letters' | 'numbers'; // Display key letters or note order numbers
  jamNotes?: JamNote[]; // Notes played in jam mode
  onJamPointer?: (note: number | null) => void; // Jam mode: pitch under a held pointer, null on release
  onJamCursorNote?: (note: number) => void; // Jam mode: the row the ship moved to
  onJamCursorMove?: (row: number) => void; // Jam mode: the ship's height in rows from the top
  jamShips?: JamShip[]; // Jam room: the other players' ships
  holdNotes?: boolean; // long sounds are drawn as long as they last and must be held
  holdBpm?: number; // the tempo at which a note counts as long, when not `bpm`
  holdingSteps?: Set<number>; // hold notes whose key is down right now
  jamToolbar?: ReactNode; // Jam mode: buttons shown first in the toolbar at the top
  // Lesson rooms: the steps come at the ship, which stays where it is, every
  // `loopMs` again; `hits` are how each was played, by `${loop}:${step}`.
  // In every mode the room's lesson is drawn this way: Wait and Free hold
  // still at the step waited for (`current`) and glide to the next one
  // (`stepped`); a game run has one loop only (`lastLoop`); `clock` replaces
  // the toolbar's time.
  jamLesson?: {
    loopMs: number;
    hits: Map<string, JamLessonHit>;
    current?: string;
    stepped?: boolean;
    lastLoop?: number;
    clock?: string;
  };
  // Lanes drawn from the highest at the top in every mode, as the jam's rows
  // are (a lesson room keeps its lanes where they are when its mode changes)
  highestOnTop?: boolean;
}

// A lesson room's step as it was played: its judgment and how far off it
// was; `played` in Wait and Free, which judge no timing
export interface JamLessonHit {
  accuracy: 'perfect' | 'good' | 'early' | 'late' | 'miss' | 'played';
  deltaMs: number;
}

// How a lesson room's step was played, as its note shows it
export function jamLessonTiming(hit: JamLessonHit | undefined): '' | 'played' | 'missed' | 'on-time' | 'early' | 'late' {
  if (!hit) return '';
  if (hit.accuracy === 'played') return 'played';
  if (hit.accuracy === 'miss') return 'missed';
  if (Math.abs(hit.deltaMs) <= ON_TIME_MS) return 'on-time';
  return hit.deltaMs < 0 ? 'early' : 'late';
}

interface NoteHitState {
  hit: boolean;
  accuracy?: 'perfect' | 'good' | 'early' | 'late' | 'miss';
  deltaMs?: number; // Timing offset of the actual hit (negative = early)
}

interface TimingPopup {
  id: number;
  accuracy: 'perfect' | 'good' | 'early' | 'late' | 'miss';
  deltaMs: number;
  laneIndex: number;
}

const POPUP_DURATION_MS = 900; // Matches timingPopupFloat animation length

// Scrolling highway constants
const NOTE_SPACING_PX = 110; // Fixed spacing between notes in pixels (for free/wait modes) - slightly more than note width (100px)
const HIT_ZONE_PERCENT = 0.33; // Position of hit zone as percentage from left (33% = 1/3 from left)
const PIXELS_PER_MS = 0.3; // How fast notes scroll in play mode (pixels per millisecond)
const VISIBLE_BUFFER_MS = 3000; // Show notes this long after they pass the hit zone (play mode)
const JAM_FADE_MS = 2500; // Jam dots fade out over this long after they sound
const JAM_PIXELS_PER_MS = 0.6; // Jam dots scroll twice as fast as play-mode notes
// Jam cursor: rests at a fixed point, each played note pushes it right like an
// engine burst, and it drifts slowly back home (fractions of the highway width)
const JAM_CURSOR_HOME_PERCENT = 0.2;
const JAM_CURSOR_MAX_PERCENT = 0.85;
const JAM_CURSOR_PUSH = 0.024; // Distance one note moves it
const JAM_CURSOR_DRIFT = 0.12; // Speed back home, per second
const JAM_CURSOR_BURST_DECAY = 8; // 1/s: how fast one push eases out
const JAM_CURSOR_FULL_THRUST = 6; // Notes per second that show the full engine flame
const NO_JAM_SHIPS: JamShip[] = [];
const JAM_CURSOR_TAIL_PX = 16; // From the cursor point back to just behind the ship's tail (see .jam-cursor-ship)
const COLLAPSED_NOTE_SIZE = 100; // collapsed-lane notes keep the CSS default size
// Timing feedback is driven by the actual offset (deltaMs), independent of the
// engine's perfect/good/early/late buckets. Within ON_TIME_MS the hit is "on
// time" (green); beyond it we show early (blue) or late (orange), dim the
// expected note, and draw a solid ghost where the hit actually landed.
const ON_TIME_MS = 50;
const OFF_TIMING_NOTE_OPACITY = 0.35;

export function NoteHighway({
  steps,
  currentTime,
  bpm,
  activePads,
  hitFeedback,
  onNoteReached,
  mode = 'play',
  currentStepIndex = 0,
  playedSteps = new Set(),
  isCollapsed = false,
  noteToKeyMap,
  labelMode = 'letters',
  jamNotes = [],
  onJamPointer,
  onJamCursorNote,
  onJamCursorMove,
  jamShips = NO_JAM_SHIPS,
  holdNotes = false,
  holdBpm,
  holdingSteps,
  jamToolbar,
  jamLesson,
  highestOnTop = false,
}: NoteHighwayProps) {
  const [noteHitStates, setNoteHitStates] = useState<Map<number, NoteHitState>>(new Map());
  const [timingPopups, setTimingPopups] = useState<TimingPopup[]>([]);
  const seenFeedbackRef = useRef<Set<HitFeedback>>(new Set());
  const popupIdRef = useRef<number>(0);
  const notifiedNotesRef = useRef<Set<number>>(new Set());
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number>(1000); // Default width
  const [containerHeight, setContainerHeight] = useState<number>(500); // Default height

  // Track container dimensions for dynamic sizing
  useEffect(() => {
    const updateDimensions = () => {
      if (containerRef.current) {
        setContainerWidth(containerRef.current.offsetWidth);
        setContainerHeight(containerRef.current.offsetHeight);
      }
    };

    updateDimensions();
    window.addEventListener('resize', updateDimensions);
    return () => window.removeEventListener('resize', updateDimensions);
  }, []);

  const jamWidth = containerWidth;

  // Calculate hit zone offset based on container width
  // A lesson room's ship is its timing line, where lesson mode has it
  const lessonRoom = !!jamLesson;
  const hitZoneOffset = useMemo(() => {
    return mode === 'jam' && !lessonRoom ? jamWidth * JAM_CURSOR_HOME_PERCENT : containerWidth * HIT_ZONE_PERCENT;
  }, [containerWidth, mode, jamWidth, lessonRoom]);

  // Get unique notes from the lesson (sorted by MIDI value)
  const uniqueNotes = useMemo(() =>
    Array.from(new Set(steps.map(s => s.note))).sort((a, b) => a - b),
    [steps]
  );

  // Determine number of lanes based on unique notes in the lesson
  const laneCount = uniqueNotes.length;
  // The lanes top to bottom, by lane index (lowest note first)
  const laneRows = useMemo(() => {
    const rows = Array.from({ length: laneCount }, (_, laneIndex) => laneIndex);
    return highestOnTop ? rows.reverse() : rows;
  }, [laneCount, highestOnTop]);

  // Calculate note size to be square based on lane height
  // Container height minus progress bar (50px) and padding (2rem = ~32px), divided by lane count
  const noteSize = useMemo(() => {
    const availableHeight = containerHeight - 50 - 32; // minus progress bar and padding
    const laneHeight = availableHeight / Math.max(1, laneCount);
    // Note should be slightly smaller than lane height to fit nicely
    const size = Math.min(laneHeight * 0.85, 100); // Cap at 100px max
    return Math.max(30, size); // Minimum 30px
  }, [containerHeight, laneCount]);

  // Calculate font size for note labels - scales with note size to ensure perfect squares
  // Font size is roughly 50% of note size, capped at reasonable min/max
  const noteFontSize = useMemo(() => {
    const fontSize = noteSize * 0.5;
    return Math.max(10, Math.min(fontSize, 32)); // Min 10px, max 32px
  }, [noteSize]);

  // Collapsed mode uses default 100px notes, so use a larger fixed font size
  const collapsedFontSize = 48; // Large font for collapsed mode (100px notes)

  // Map MIDI note to lane index based on position in unique notes
  const noteToLane = (note: number): number => {
    const laneIndex = uniqueNotes.indexOf(note);
    return laneIndex >= 0 ? laneIndex : 0;
  };

  const ticksToMs = (ticks: number): number => {
    const ticksPerBeat = 480;
    const beatsPerSecond = bpm / 60;
    return (ticks / ticksPerBeat) / beatsPerSecond * 1000;
  };

  // Calculate the time in ms for each step (memoized)
  const stepTimes = useMemo(() =>
    steps.map(step => ticksToMs(step.tick)),
    [steps, bpm]
  );

  // Hold notes: how long each one's sound lasts (0 for ordinary notes)
  const holdMs = useMemo(
    () => steps.map((step) => {
      if (!holdNotes || stepDurationMs(step, holdBpm ?? bpm) < HOLD_MIN_MS) return 0;
      return stepDurationMs(step, bpm);
    }),
    [steps, bpm, holdNotes, holdBpm]
  );

  // A hold note is a rectangle from its start to the end of its sound: its
  // head sits where an ordinary note would, the tail runs to the end time.
  const holdStyle = (stepIndex: number, size: number) => {
    const ms = holdMs[stepIndex];
    if (!ms) return {};
    return {
      width: `${size + ms * PIXELS_PER_MS}px`,
      transform: `translateY(-50%) translateX(-${size / 2}px)`,
    };
  };
  const holdClass = (stepIndex: number) =>
    holdMs[stepIndex] ? ` hold${holdingSteps?.has(stepIndex) ? ' holding' : ''}` : '';
  // Fills over the hold's duration while its key is down
  const holdFill = (stepIndex: number) =>
    holdMs[stepIndex] && holdingSteps?.has(stepIndex) ? (
      <span className="hold-fill" style={{ animationDuration: `${holdMs[stepIndex]}ms` }} />
    ) : null;

  // Get total duration of the song
  const totalDuration = useMemo(() => {
    if (steps.length === 0) return 0;
    const lastStep = steps[steps.length - 1];
    return ticksToMs(lastStep.tick + lastStep.dur) + 1000; // Add 1 second buffer
  }, [steps, bpm]);

  // Update hit states from feedback
  useEffect(() => {
    if (!hitFeedback || hitFeedback.length === 0) return;

    setNoteHitStates(prev => {
      const newStates = new Map(prev);
      hitFeedback.forEach(feedback => {
        // Find the step index that matches this feedback
        const stepIndex = steps.findIndex(
          s => s.tick === feedback.expectedStep.tick && s.note === feedback.expectedStep.note
        );
        // A real hit always wins: override a speculative "miss" that the
        // auto-miss effect may have set once the note passed the timing line.
        // (The engine accepts late hits far beyond the visual miss threshold.)
        if (stepIndex >= 0 && !newStates.get(stepIndex)?.hit) {
          newStates.set(stepIndex, {
            hit: feedback.accuracy !== 'miss',
            accuracy: feedback.accuracy,
            deltaMs: feedback.timingDelta,
          });
        }
      });
      return newStates;
    });
  }, [hitFeedback, steps]);

  // Spawn a timing judgment popup for each new hit feedback (play mode)
  useEffect(() => {
    if (!hitFeedback || hitFeedback.length === 0) return;

    const freshFeedback = hitFeedback.filter(fb => !seenFeedbackRef.current.has(fb));
    if (freshFeedback.length === 0) return;

    const newPopups: TimingPopup[] = freshFeedback.map(fb => {
      seenFeedbackRef.current.add(fb);
      return {
        id: ++popupIdRef.current,
        accuracy: fb.accuracy,
        deltaMs: fb.timingDelta,
        laneIndex: noteToLane(fb.expectedStep.note),
      };
    });

    setTimingPopups(prev => [...prev, ...newPopups]);

    // Remove this batch once its animation has finished.
    // No cleanup: clearing on the next feedback would strand earlier popups.
    const ids = new Set(newPopups.map(p => p.id));
    setTimeout(() => {
      setTimingPopups(prev => prev.filter(p => !ids.has(p.id)));
    }, POPUP_DURATION_MS);
  }, [hitFeedback]);

  // Replay/restart can reuse the exact same lesson steps, so clear visual hit
  // state when the parent resets feedback and transport time back to the start.
  useEffect(() => {
    if ((hitFeedback?.length ?? 0) > 0 || currentTime > 1) return;
    seenFeedbackRef.current.clear();
    notifiedNotesRef.current.clear();
    setNoteHitStates(new Map());
    setTimingPopups([]);
  }, [hitFeedback?.length, currentTime, mode]);

  // Auto-mark notes as missed when they pass the timing line (play mode only)
  // A note is missed when it passes the timing line by roughly half the note width
  useEffect(() => {
    if (mode !== 'play') return;

    // Visual fallback for notes that scroll past unhit. Kept generous (>= the
    // engine's late-hit acceptance window) so it never pre-empts a legitimate
    // late hit — the engine's own miss feedback is the authoritative source.
    const missThresholdMs = Math.max((noteSize / 2) / PIXELS_PER_MS, 800);

    setNoteHitStates(prev => {
      const newStates = new Map(prev);
      let hasChanges = false;

      steps.forEach((_, stepIndex) => {
        // Skip if already has a hit state, or is a hold note still being held
        if (newStates.has(stepIndex) || holdingSteps?.has(stepIndex)) return;

        const stepTime = stepTimes[stepIndex];
        const timePassed = currentTime - stepTime;

        // If note has passed the timing line by the threshold, mark as miss
        if (timePassed > missThresholdMs) {
          newStates.set(stepIndex, {
            hit: false,
            accuracy: 'miss',
          });
          hasChanges = true;
        }
      });

      return hasChanges ? newStates : prev;
    });
  }, [mode, currentTime, steps, stepTimes, noteSize, holdingSteps]);

  // Notify when notes reach the hit zone
  useEffect(() => {
    if (mode !== 'play' || !onNoteReached) return;

    steps.forEach((step, index) => {
      const stepTime = stepTimes[index];
      // Note is at hit zone when currentTime reaches stepTime
      // Notify slightly before (within 50ms window)
      if (
        currentTime >= stepTime - 50 &&
        currentTime <= stepTime + 50 &&
        !notifiedNotesRef.current.has(index)
      ) {
        notifiedNotesRef.current.add(index);
        onNoteReached(step);
      }
    });
  }, [currentTime, steps, stepTimes, mode, onNoteReached]);

  // Reset notified notes when steps change
  useEffect(() => {
    notifiedNotesRef.current.clear();
    seenFeedbackRef.current.clear();
    setNoteHitStates(new Map());
    setTimingPopups([]);
  }, [steps]);

  // A lane's number: 1 for the top lane, then down
  const laneNumber = (laneIndex: number): number => (highestOnTop ? laneCount - laneIndex : laneIndex + 1);
  const getLaneLabel = (laneIndex: number): string => {
    // Just show the note number (1, 2, 3, etc.)
    return String(laneNumber(laneIndex));
  };

  const getLaneColor = (laneIndex: number): string => {
    return SOUND_COLORS[laneIndex % SOUND_COLORS.length];
  };

  // Check if any pad is active for the timing line glow effect
  const hasActivePad = activePads && activePads.size > 0;

  // Popup visual, driven by the actual offset so it matches the note coloring
  const getPopupTiming = (popup: TimingPopup): 'on-time' | 'early' | 'late' | 'miss' => {
    if (popup.accuracy === 'miss') return 'miss';
    if (Math.abs(popup.deltaMs) <= ON_TIME_MS) return 'on-time';
    return popup.deltaMs < 0 ? 'early' : 'late';
  };

  const getPopupLabel = (popup: TimingPopup): string => {
    switch (getPopupTiming(popup)) {
      case 'on-time': return 'Perfect!';
      case 'early': return 'Early';
      case 'late': return 'Late';
      case 'miss': return 'Miss';
    }
  };

  // Signed ms offset shown under the judgment (not for on-time/miss)
  const getPopupDelta = (popup: TimingPopup): string | null => {
    const timing = getPopupTiming(popup);
    if (timing === 'on-time' || timing === 'miss') return null;
    const ms = Math.round(popup.deltaMs);
    return `${ms > 0 ? '+' : ''}${ms}ms`;
  };

  const renderTimingPopups = () => {
    if (mode !== 'play' && !jamLesson) return null;
    // The jam's rows run from the highest lane at the top
    const row = (laneIndex: number) => (jamLesson || highestOnTop ? laneCount - 1 - laneIndex : laneIndex);
    return (
      <div className="timing-popups">
        {timingPopups.map(popup => (
          <div
            key={popup.id}
            className={`timing-popup ${getPopupTiming(popup)}`}
            style={{
              left: `${hitZoneOffset}px`,
              top: isCollapsed
                ? '50%'
                : `${((row(popup.laneIndex) + 0.5) / Math.max(1, laneCount)) * 100}%`,
            }}
          >
            <span className="timing-popup-text">{getPopupLabel(popup)}</span>
            {getPopupDelta(popup) && (
              <span className="timing-popup-delta">{getPopupDelta(popup)}</span>
            )}
          </div>
        ))}
      </div>
    );
  };

  // Get the label to display inside a note (letter key or number)
  const getNoteLabel = (note: number): string | null => {
    if (!noteToKeyMap) return null;
    if (labelMode === 'numbers') {
      return String(laneNumber(noteToLane(note)));
    }
    return noteToKeyMap[note] || null;
  };

  // ============= PLAY MODE: Time-based positioning =============

  // Calculate note position in pixels based on time (for play mode)
  const getPlayModePixelPosition = (stepIndex: number): number => {
    const stepTime = stepTimes[stepIndex];
    return stepTime * PIXELS_PER_MS;
  };

  // Calculate the scroll offset based on current time (for play mode)
  const playModeScrollOffset = useMemo(() => {
    return currentTime * PIXELS_PER_MS;
  }, [currentTime]);

  // Check if a note is visible in play mode (time-based)
  const isPlayModeNoteVisible = (stepIndex: number): boolean => {
    const stepTime = stepTimes[stepIndex];
    const timeDiff = stepTime - currentTime;
    return timeDiff >= -VISIBLE_BUFFER_MS; // Show notes from past to future (clipped by CSS)
  };

  // Calculate opacity for notes in play mode (time-based fade)
  const getPlayModeNoteOpacity = (stepIndex: number): number => {
    const stepTime = stepTimes[stepIndex];
    const timeDiff = stepTime - currentTime;
    const hitState = noteHitStates.get(stepIndex);

    if (timeDiff < 0) {
      // Note has passed the hit zone
      // Keep full opacity for longer, then fade gradually
      const timePassed = Math.abs(timeDiff);
      const fadeStartMs = hitState?.hit ? 2800 : 5800; // Start fading later
      const fadeDurationMs = hitState?.hit ? 800 : 900; // Fade over this duration

      if (timePassed < fadeStartMs) {
        return 1; // Full opacity until fade starts
      }
      return Math.max(0, 1 - (timePassed - fadeStartMs) / fadeDurationMs);
    }
    return 1;
  };

  // ============= FREE/WAIT MODES: Index-based equal spacing with smooth scrolling =============

  // Calculate note position in pixels (equal spacing, index-based) for free/wait modes
  // Notes are positioned from left to right with margin on both sides
  const HIGHWAY_MARGIN = 160; // Margin from edges
  // Equal spacing, plus room for each hold note's length
  const freeWaitPositions = useMemo(() => {
    let x = HIGHWAY_MARGIN;
    return steps.map((_, i) => {
      const position = x;
      x += NOTE_SPACING_PX + holdMs[i] * PIXELS_PER_MS;
      return position;
    });
  }, [steps, holdMs]);
  const getFreeWaitPixelPosition = (stepIndex: number): number => {
    return freeWaitPositions[stepIndex] ?? HIGHWAY_MARGIN + stepIndex * NOTE_SPACING_PX;
  };

  // Smooth scroll offset based on progress
  const freeWaitScrollOffset = useMemo(() => {
    const targetStep = mode === 'wait' ? currentStepIndex : playedSteps.size;
    // Start scrolling after 6 notes, keep current note visible on left side
    const anchor = Math.max(0, targetStep - 6);
    return (freeWaitPositions[anchor] ?? HIGHWAY_MARGIN) - HIGHWAY_MARGIN;
  }, [mode, currentStepIndex, playedSteps.size, freeWaitPositions]);

  // Check if note should be rendered (performance optimization)
  // Show ALL notes from the beginning up to some distance ahead of current position
  // Never hide notes on the left - they should remain visible as played notes
  const isFreeWaitNoteVisible = (stepIndex: number): boolean => {
    const targetStep = mode === 'wait' ? currentStepIndex : playedSteps.size;
    // Show all notes from start (index 0) up to 30 notes ahead of current position
    return stepIndex <= targetStep + 30;
  };


  type TimingClass = 'on-time' | 'timing-early' | 'timing-late' | null;

  const getTimingClass = (hitState?: NoteHitState): TimingClass => {
    if (!hitState?.hit || hitState.deltaMs === undefined) return null;
    if (Math.abs(hitState.deltaMs) <= ON_TIME_MS) return 'on-time';
    return hitState.deltaMs < 0 ? 'timing-early' : 'timing-late';
  };

  const isOffTimingHit = (hitState?: NoteHitState): boolean => {
    const tc = getTimingClass(hitState);
    return tc === 'timing-early' || tc === 'timing-late';
  };

  // Render notes for play mode (time-based scrolling)
  const renderPlayModeNotes = (laneIndex: number) => {
    return steps
      .map((step, stepIndex) => ({ step, stepIndex }))
      .filter(({ step, stepIndex }) =>
        noteToLane(step.note) === laneIndex && isPlayModeNoteVisible(stepIndex)
      )
      .map(({ step, stepIndex }) => {
        const hitState = noteHitStates.get(stepIndex);
        const label = getNoteLabel(step.note);
        const pixelPosition = getPlayModePixelPosition(stepIndex);
        const opacity = getPlayModeNoteOpacity(stepIndex);
        const timingClass = getTimingClass(hitState);
        const offTiming = isOffTimingHit(hitState);

        let noteClass = 'note scrolling-note' + holdClass(stepIndex);
        if (hitState?.hit) noteClass += ' hit';
        if (hitState?.accuracy === 'miss') noteClass += ' miss';
        if (timingClass) noteClass += ` ${timingClass}`;
        if (label) noteClass += ' has-label';

        // Apply original color only if note hasn't been hit AND hasn't been missed
        const shouldApplyColor = !hitState;

        return (
          <Fragment key={stepIndex}>
            <div
              className={noteClass}
              style={{
                left: `${pixelPosition}px`,
                opacity: offTiming ? opacity * OFF_TIMING_NOTE_OPACITY : opacity,
                width: `${noteSize}px`,
                height: `${noteSize}px`,
                ...holdStyle(stepIndex, noteSize),
                ...(shouldApplyColor && { backgroundColor: getLaneColor(laneIndex) }),
              }}
            >
              {holdFill(stepIndex)}
              {label && <span className="note-label" style={{ fontSize: `${noteFontSize}px` }}>{label}</span>}
            </div>
            {offTiming && (
              <div
                className={`note scrolling-note ghost-hit ${timingClass}${label ? ' has-label' : ''}${holdClass(stepIndex)}`}
                style={{
                  left: `${pixelPosition + hitState!.deltaMs! * PIXELS_PER_MS}px`,
                  opacity,
                  width: `${noteSize}px`,
                  height: `${noteSize}px`,
                  ...holdStyle(stepIndex, noteSize),
                }}
              >
                {label && <span className="note-label" style={{ fontSize: `${noteFontSize}px` }}>{label}</span>}
              </div>
            )}
          </Fragment>
        );
      });
  };

  // Render notes for free/wait modes (equal spacing with scrolling)
  const renderFreeWaitNotes = (laneIndex: number) => {
    return steps
      .map((step, stepIndex) => ({ step, stepIndex }))
      .filter(({ step, stepIndex }) =>
        noteToLane(step.note) === laneIndex && isFreeWaitNoteVisible(stepIndex)
      )
      .map(({ step, stepIndex }) => {
        const isPlayed = playedSteps.has(stepIndex);
        const isCurrent = mode === 'wait' && stepIndex === currentStepIndex;
        const isGrayed = mode === 'wait' && stepIndex > currentStepIndex && !isPlayed;
        const label = getNoteLabel(step.note);
        const pixelPosition = getFreeWaitPixelPosition(stepIndex);

        let noteClass = 'note scrolling-note' + holdClass(stepIndex);
        if (isPlayed) noteClass += ' played';
        else if (isCurrent) noteClass += ' current';
        else if (isGrayed) noteClass += ' grayed';
        if (label) noteClass += ' has-label';

        return (
          <div
            key={stepIndex}
            className={noteClass}
            style={{
              left: `${pixelPosition}px`,
              width: `${noteSize}px`,
              height: `${noteSize}px`,
              ...holdStyle(stepIndex, noteSize),
              backgroundColor: isPlayed ? undefined : getLaneColor(laneIndex),
            }}
          >
            {holdFill(stepIndex)}
            {label && <span className="note-label" style={{ fontSize: `${noteFontSize}px` }}>{label}</span>}
          </div>
        );
      });
  };

  // Render all notes in a single collapsed lane (for free/wait modes with scrolling)
  const renderCollapsedFreeWaitNotes = () => {
    return steps
      .map((step, stepIndex) => ({ step, stepIndex }))
      .filter(({ stepIndex }) => isFreeWaitNoteVisible(stepIndex))
      .map(({ step, stepIndex }) => {
        const isPlayed = playedSteps.has(stepIndex);
        const isCurrent = mode === 'wait' && stepIndex === currentStepIndex;
        const isGrayed = mode === 'wait' && stepIndex > currentStepIndex && !isPlayed;
        const laneIndex = noteToLane(step.note);
        const label = getNoteLabel(step.note);
        const pixelPosition = getFreeWaitPixelPosition(stepIndex);

        let noteClass = 'note scrolling-note' + holdClass(stepIndex);
        if (isPlayed) noteClass += ' played';
        else if (isCurrent) noteClass += ' current';
        else if (isGrayed) noteClass += ' grayed';
        if (label) noteClass += ' has-label';

        return (
          <div
            key={stepIndex}
            className={noteClass}
            style={{
              left: `${pixelPosition}px`,
              ...holdStyle(stepIndex, COLLAPSED_NOTE_SIZE),
              backgroundColor: isPlayed ? undefined : getLaneColor(laneIndex),
            }}
          >
            {holdFill(stepIndex)}
            {label && <span className="note-label" style={{ fontSize: `${collapsedFontSize}px` }}>{label}</span>}
          </div>
        );
      });
  };

  // Render all notes in a single collapsed lane for play mode (time-based positioning)
  const renderCollapsedPlayModeNotes = () => {
    return steps
      .map((step, stepIndex) => ({ step, stepIndex }))
      .filter(({ stepIndex }) => isPlayModeNoteVisible(stepIndex))
      .map(({ step, stepIndex }) => {
        const hitState = noteHitStates.get(stepIndex);
        const laneIndex = noteToLane(step.note);
        const label = getNoteLabel(step.note);
        const pixelPosition = getPlayModePixelPosition(stepIndex);
        const opacity = getPlayModeNoteOpacity(stepIndex);
        const timingClass = getTimingClass(hitState);
        const offTiming = isOffTimingHit(hitState);

        let noteClass = 'note scrolling-note' + holdClass(stepIndex);
        if (hitState?.hit) noteClass += ' hit';
        if (hitState?.accuracy === 'miss') noteClass += ' miss';
        if (timingClass) noteClass += ` ${timingClass}`;
        if (label) noteClass += ' has-label';

        // Apply original color only if note hasn't been hit AND hasn't been missed
        const shouldApplyColor = !hitState;

        return (
          <Fragment key={stepIndex}>
            <div
              className={noteClass}
              style={{
                left: `${pixelPosition}px`,
                opacity: offTiming ? opacity * OFF_TIMING_NOTE_OPACITY : opacity,
                ...holdStyle(stepIndex, COLLAPSED_NOTE_SIZE),
                ...(shouldApplyColor && { backgroundColor: getLaneColor(laneIndex) }),
              }}
            >
              {holdFill(stepIndex)}
              {label && <span className="note-label" style={{ fontSize: `${collapsedFontSize}px` }}>{label}</span>}
            </div>
            {offTiming && (
              <div
                className={`note scrolling-note ghost-hit ${timingClass}${label ? ' has-label' : ''}${holdClass(stepIndex)}`}
                style={{
                  left: `${pixelPosition + hitState!.deltaMs! * PIXELS_PER_MS}px`,
                  opacity,
                  ...holdStyle(stepIndex, COLLAPSED_NOTE_SIZE),
                }}
              >
                {label && <span className="note-label" style={{ fontSize: `${collapsedFontSize}px` }}>{label}</span>}
              </div>
            )}
          </Fragment>
        );
      });
  };

  const jamLanesRef = useRef<HTMLDivElement>(null);
  // Jam cursor height (px from the highway top) and the row it is on; it
  // follows the mouse up and down, between the top and bottom row centers,
  // and glides (`glide`) to the row of a note played with a key or MIDI
  const [jamCursorY, setJamCursorY] = useState<{ y: number; note: number | null; glide?: boolean } | null>(null);

  // The jam rows, top to bottom (the lanes also hold the lane controls' fold)
  const jamRowElements = (): HTMLElement[] =>
    Array.from(jamLanesRef.current?.querySelectorAll<HTMLElement>(':scope > [data-jam-note]') ?? []);

  // Where the rows are: the top row's center (px from the highway top) and
  // the distance from one row's center to the next
  const jamRowSpan = (): { top: number; step: number } | null => {
    const rows = jamRowElements();
    const container = containerRef.current;
    if (!rows.length || !container) return null;
    const origin = container.getBoundingClientRect().top;
    const first = rows[0].getBoundingClientRect();
    const last = rows[rows.length - 1].getBoundingClientRect();
    const top = first.top + first.height / 2 - origin;
    const bottom = last.top + last.height / 2 - origin;
    return { top, step: rows.length > 1 ? (bottom - top) / (rows.length - 1) : 0 };
  };

  // Every ship's height (px from the highway top): this player's ('') and the
  // other players' in a jam room, by id
  const jamRowList = mode === 'jam' ? jamRowElements() : [];
  const jamRows = jamRowList.length ? jamRowSpan() : null;
  const jamShipYs = new Map<string, number>();
  if (jamCursorY) jamShipYs.set('', jamCursorY.y);
  if (jamRows) {
    const lastRow = jamRowList.length - 1;
    for (const ship of jamShips) {
      jamShipYs.set(ship.id, jamRows.top + Math.min(lastRow, Math.max(0, ship.row)) * jamRows.step);
    }
  }

  // How far a ship at height `shipY` sits above (-) or below (+) the middle of
  // a note's row, so its notes leave at the ship's height; 0 when the ship is
  // on another row (notes from keys or MIDI)
  const jamShipOffset = (note: number, shipY: number | undefined): number => {
    const lane = jamLanesRef.current?.querySelector<HTMLElement>(`[data-jam-note="${note}"]`);
    const container = containerRef.current;
    if (shipY === undefined || !lane || !container) return 0;
    const rect = lane.getBoundingClientRect();
    const offset = shipY - (rect.top - container.getBoundingClientRect().top + rect.height / 2);
    return Math.abs(offset) <= rect.height / 2 ? offset : 0;
  };

  // Ship motion, advanced once per clock tick: x is how far right of home a
  // ship is, v the leftover push of its recent notes. Each player's ship is
  // pushed by that player's notes. Each note is born where its ship was when
  // it sounded (`born`), so the trail shows where the ship has been.
  const jamMotionRef = useRef<{
    time: number | null;
    ships: Map<string, { x: number; v: number }>;
    born: Map<number, { x: number; dy: number }>;
  }>({ time: null, ships: new Map(), born: new Map() });
  const jamMotion = jamMotionRef.current;
  const shipMotion = (ship: string) => {
    let motion = jamMotion.ships.get(ship);
    if (!motion) jamMotion.ships.set(ship, (motion = { x: 0, v: 0 }));
    return motion;
  };
  if (mode === 'jam' && jamMotion.time !== currentTime) {
    const dt = jamMotion.time === null ? 0 : Math.min(0.1, Math.max(0, (currentTime - jamMotion.time) / 1000));
    jamMotion.time = currentTime;
    const range = jamWidth * (JAM_CURSOR_MAX_PERCENT - JAM_CURSOR_HOME_PERCENT);
    const decay = Math.exp(-JAM_CURSOR_BURST_DECAY * dt);
    for (const motion of jamMotion.ships.values()) {
      motion.x += (motion.v * (1 - decay)) / JAM_CURSOR_BURST_DECAY - jamWidth * JAM_CURSOR_DRIFT * dt;
      motion.v *= decay;
    }
    const ids = new Set<number>();
    for (const jamNote of jamNotes) {
      ids.add(jamNote.id);
      if (jamNote.timeMs > currentTime || jamMotion.born.has(jamNote.id)) continue;
      const ship = jamNote.peer ?? '';
      const motion = shipMotion(ship);
      jamMotion.born.set(jamNote.id, {
        x: Math.min(range, Math.max(0, motion.x)),
        dy: jamShipOffset(jamNote.note, jamShipYs.get(ship)),
      });
      // Notes that sounded long before this tick (e.g. a remount) leave no
      // push, and in a lesson room the ship stays at the timing line
      if (currentTime - jamNote.timeMs < 250 && !jamLesson) {
        motion.v += jamWidth * JAM_CURSOR_PUSH * JAM_CURSOR_BURST_DECAY;
      }
    }
    for (const id of jamMotion.born.keys()) if (!ids.has(id)) jamMotion.born.delete(id);
    const players = new Set(jamShips.map((ship) => ship.id));
    for (const [ship, motion] of jamMotion.ships) {
      if (ship !== '' && !players.has(ship)) jamMotion.ships.delete(ship);
      if (motion.x <= 0) motion.x = 0;
      if (motion.x >= range) {
        motion.x = range;
        motion.v = 0;
      }
    }
  }

  // Render jam mode dots as their ship's exhaust: each waits at the nozzle,
  // just behind the ship and at its height, until its 16th sounds, then
  // drifts left from there as it fades.
  const renderJamNotes = (laneIndex: number) => {
    const dotSize = noteSize * 0.55;
    const nozzle = JAM_CURSOR_TAIL_PX + dotSize / 2;
    return jamNotes
      .filter((jamNote) => noteToLane(jamNote.note) === laneIndex)
      .map((jamNote) => {
        const age = currentTime - jamNote.timeMs;
        const sounded = age >= 0;
        const opacity = sounded ? Math.max(0, 1 - age / JAM_FADE_MS) : 0.5;
        if (opacity === 0) return null;
        const ship = jamNote.peer ?? '';
        const born = sounded ? jamMotion.born.get(jamNote.id) : undefined;
        const left = born
          ? jamNote.timeMs * JAM_PIXELS_PER_MS + born.x
          : currentTime * JAM_PIXELS_PER_MS + shipMotion(ship).x;
        const dy = born ? born.dy : jamShipOffset(jamNote.note, jamShipYs.get(ship));
        return (
          <div
            key={jamNote.id}
            className={`jam-dot ${sounded ? 'sounded' : 'queued'}`}
            style={{
              left: `${left - nozzle}px`,
              top: `calc(50% + ${dy}px)`,
              width: `${dotSize}px`,
              height: `${dotSize}px`,
              opacity,
              color: getLaneColor(laneIndex),
            }}
          />
        );
      });
  };

  // Lesson rooms: the lane's steps coming at the ship, round and outlined in
  // the lane's color, from a little behind it to the far edge, loop after
  // loop. They show how they were played as lesson mode's notes do: on time
  // green; early (blue) or late (orange) dimmed where they were due, with a
  // solid copy where they were played; missed red, with a shake.
  const LESSON_PAST_MS = 600;
  const renderJamLessonNotes = (laneIndex: number) => {
    if (!jamLesson || jamLesson.loopMs <= 0) return null;
    const { loopMs, hits, current } = jamLesson;
    const size = noteSize * 0.62;
    const aheadMs = (jamWidth - hitZoneOffset) / JAM_PIXELS_PER_MS;
    // Wait and Free keep the steps they passed on screen, as far as it shows
    const pastMs = jamLesson.stepped ? hitZoneOffset / JAM_PIXELS_PER_MS : LESSON_PAST_MS;
    const firstLoop = Math.floor((currentTime - pastMs) / loopMs);
    const lastLoop = Math.min(Math.floor((currentTime + aheadMs) / loopMs), jamLesson.lastLoop ?? Infinity);
    const color = getLaneColor(laneIndex);
    const notes: ReactNode[] = [];
    for (let loop = Math.max(0, firstLoop); loop <= lastLoop; loop++) {
      steps.forEach((step, index) => {
        if (noteToLane(step.note) !== laneIndex) return;
        const at = loop * loopMs + stepTimes[index];
        // A hold note stays until its tail has passed
        if (at + holdMs[index] < currentTime - pastMs || at > currentTime + aheadMs) return;
        const key = `${loop}:${index}`;
        const hit = hits.get(key);
        const timing = jamLessonTiming(hit);
        const offTiming = timing === 'early' || timing === 'late';
        const holding = holdingSteps?.has(index) && at <= currentTime;
        if (holdMs[index]) {
          notes.push(
            <div
              key={`${key}:tail`}
              className={`jam-lesson-tail ${timing}${holding ? ' holding' : ''}`}
              style={{ left: `${at * JAM_PIXELS_PER_MS + size / 2}px`, width: `${Math.max(0, holdMs[index] * JAM_PIXELS_PER_MS - size / 2)}px`, color }}
            />
          );
        }
        notes.push(
          <div
            key={key}
            className={`jam-lesson-note ${timing}${key === current ? ' current' : ''}${holding ? ' holding' : ''}`}
            style={{
              left: `${at * JAM_PIXELS_PER_MS}px`,
              width: `${size}px`,
              height: `${size}px`,
              color,
              ...(offTiming && { opacity: OFF_TIMING_NOTE_OPACITY }),
            }}
          />
        );
        if (offTiming) {
          notes.push(
            <div
              key={`${key}:played`}
              className={`jam-lesson-note ghost-hit ${timing}`}
              style={{ left: `${(at + hit!.deltaMs) * JAM_PIXELS_PER_MS}px`, width: `${size}px`, height: `${size}px` }}
            />
          );
        }
      });
    }
    return notes;
  };

  // Jam mode pointer play: press a row to play its pitch, hold to keep playing,
  // drag up or down to change pitch
  const jamPointerHeldRef = useRef<boolean>(false);
  const jamPointerNoteRef = useRef<number | null>(null);
  const jamNoteAt = (clientX: number, clientY: number): number | null => {
    const lane = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>('[data-jam-note]');
    return lane ? Number(lane.dataset.jamNote) : jamPointerNoteRef.current;
  };

  const moveJamCursor = (clientY: number, note: number | null, glide = false) => {
    const rows = jamRowElements();
    const container = containerRef.current;
    if (!rows.length || !container) return;
    const top = rows[0].getBoundingClientRect();
    const bottom = rows[rows.length - 1].getBoundingClientRect();
    const y = Math.min(bottom.top + bottom.height / 2, Math.max(top.top + top.height / 2, clientY));
    setJamCursorY((prev) => ({ y: y - container.getBoundingClientRect().top, note: note ?? prev?.note ?? null, glide }));
  };

  // A note this player plays with a key or MIDI on another row than the
  // ship's takes the ship there, so it leaves from the ship (a held pointer
  // keeps the ship where it is)
  const jamNotesSeenRef = useRef<Set<number> | null>(null);
  useEffect(() => {
    if (mode !== 'jam') return;
    const first = jamNotesSeenRef.current === null;
    const seen = (jamNotesSeenRef.current ??= new Set());
    let played: number | null = null;
    const ids = new Set<number>();
    for (const jamNote of jamNotes) {
      ids.add(jamNote.id);
      if (seen.has(jamNote.id)) continue;
      seen.add(jamNote.id);
      if (jamNote.peer === undefined) played = jamNote.note;
    }
    for (const id of seen) if (!ids.has(id)) seen.delete(id);
    // The notes already there when the highway appears move nothing
    if (first || played === null || jamPointerHeldRef.current) return;
    const shipNote = jamCursorY?.note ?? null;
    if (shipNote !== null && noteToLane(shipNote) === noteToLane(played)) return;
    const row = jamLanesRef.current?.querySelector<HTMLElement>(`[data-jam-note="${played}"]`);
    if (!row) return;
    const rect = row.getBoundingClientRect();
    moveJamCursor(rect.top + rect.height / 2, played, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jamNotes, mode]);

  const jamCursorNote = jamCursorY?.note ?? null;
  useEffect(() => {
    if (jamCursorNote !== null) onJamCursorNote?.(jamCursorNote);
  }, [jamCursorNote, onJamCursorNote]);

  // The ship's height in rows from the top, for the other players in a jam room
  const jamCursorPx = jamCursorY?.y ?? null;
  useEffect(() => {
    const rows = jamRowSpan();
    if (jamCursorPx === null || !rows || !onJamCursorMove) return;
    onJamCursorMove(rows.step > 0 ? (jamCursorPx - rows.top) / rows.step : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jamCursorPx, onJamCursorMove]);

  // Start the cursor on the middle row
  useEffect(() => {
    if (mode !== 'jam' || jamCursorY) return;
    const rows = jamRowElements();
    const middle = rows[Math.floor(rows.length / 2)] as HTMLElement | undefined;
    if (!middle) return;
    const rect = middle.getBoundingClientRect();
    moveJamCursor(rect.top + rect.height / 2, Number(middle.dataset.jamNote));
  });

  const handleJamPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const note = jamNoteAt(event.clientX, event.clientY);
    moveJamCursor(event.clientY, note);
    if (note === null) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    jamPointerHeldRef.current = true;
    jamPointerNoteRef.current = note;
    onJamPointer?.(note);
  };

  const handleJamPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const hovered = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-jam-note]');
    moveJamCursor(event.clientY, hovered ? Number(hovered.dataset.jamNote) : null);
    if (!jamPointerHeldRef.current) return;
    const note = jamNoteAt(event.clientX, event.clientY);
    if (note === null || note === jamPointerNoteRef.current) return;
    jamPointerNoteRef.current = note;
    onJamPointer?.(note);
  };

  const handleJamPointerUp = () => {
    if (!jamPointerHeldRef.current) return;
    jamPointerHeldRef.current = false;
    jamPointerNoteRef.current = null;
    onJamPointer?.(null);
  };

  // Jam mode backdrop: deep space, travelled through with the highway
  const renderJamMotion = () => (
    <div className="jam-motion">
      <JamSpace travel={currentTime * JAM_PIXELS_PER_MS} time={currentTime} beatMs={60000 / bpm} />
    </div>
  );

  // Jam cursor: a small ship whose engine flame, stretch and glow grow with
  // the push of recent notes, in the color of the row it is on. The other players' ships in a jam
  // room carry their name, on a tag in their color.
  const renderJamShip = (ship: string, y: number, color: string | undefined, name?: string, tag?: string) => {
    const motion = shipMotion(ship);
    const fullThrust = jamWidth * JAM_CURSOR_PUSH * JAM_CURSOR_FULL_THRUST;
    const thrust = Math.min(1, motion.v / fullThrust);
    return (
      <div
        key={ship}
        className={name === undefined ? `jam-cursor ${jamCursorY?.glide ? 'gliding' : ''}` : 'jam-cursor jam-cursor-other'}
        style={{ transform: `translate(${hitZoneOffset + motion.x}px, ${y}px)`, color }}
      >
        <div
          className="jam-cursor-flame"
          style={{ transform: `translateY(-50%) scale(${0.25 + thrust * 1.75}, ${1 + thrust})`, opacity: 0.35 + thrust * 0.65 }}
        />
        <div
          className="jam-cursor-ship"
          style={{
            transform: `scale(${1 + thrust * 0.3}, ${1 - thrust * 0.15})`,
            filter: `drop-shadow(0 0 6px currentColor) drop-shadow(0 0 14px currentColor) brightness(${1 + thrust * 0.8})`,
          }}
        />
        {name !== undefined && (
          <div className="jam-cursor-name" style={{ background: tag }}>
            {name}
          </div>
        )}
      </div>
    );
  };
  const renderJamCursor = () => {
    const others = jamShips.flatMap((ship) => {
      const y = jamShipYs.get(ship.id);
      if (y === undefined || !jamRowList.length) return [];
      const row = jamRowList[Math.min(jamRowList.length - 1, Math.max(0, Math.round(ship.row)))];
      const lane = noteToLane(Number(row.dataset.jamNote));
      return [renderJamShip(ship.id, y, lane >= 0 ? getLaneColor(lane) : undefined, ship.name, ship.color)];
    });
    if (!jamCursorY) return others;
    const lane = jamCursorY.note === null ? -1 : noteToLane(jamCursorY.note);
    return [...others, renderJamShip('', jamCursorY.y, lane >= 0 ? getLaneColor(lane) : undefined)];
  };

  const formatClock = (ms: number): string => {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  // Progress calculation
  const getProgress = () => {
    if (mode === 'play') {
      if (totalDuration === 0) return 0;
      return Math.min(100, Math.floor((currentTime / totalDuration) * 100));
    }
    return steps.length > 0 ? Math.floor((playedSteps.size / steps.length) * 100) : 0;
  };

  const getProgressLabel = () => {
    if (mode === 'jam') {
      return jamLesson?.clock ?? formatClock(currentTime);
    }
    if (mode === 'play') {
      return `${formatClock(currentTime)} / ${formatClock(totalDuration)}`;
    }
    return `${playedSteps.size} / ${steps.length} notes`;
  };

  return (
    <div
      ref={containerRef}
      className={`note-highway ${isCollapsed ? 'collapsed' : ''} ${mode === 'jam' ? 'jam' : ''}`}
    >
      {/* Hit zone indicator line - fixed position (for play mode) */}
      {mode === 'play' && (
        <div className={`timing-line ${hasActivePad ? 'active' : ''}`} />
      )}
      {mode === 'jam' && renderJamMotion()}
      {mode === 'jam' && renderJamCursor()}

      {/* Floating timing judgments (early / late / perfect) at the hit zone */}
      {renderTimingPopups()}

      {mode === 'jam' ? (
        /* Jam mode: one row per pitch, highest on top; played notes scroll left from the line */
        <div
          ref={jamLanesRef}
          className="lanes jam-lanes"
          onPointerDown={handleJamPointerDown}
          onPointerMove={handleJamPointerMove}
          onPointerUp={handleJamPointerUp}
          onPointerCancel={handleJamPointerUp}
          onLostPointerCapture={handleJamPointerUp}
        >
          {Array.from({ length: laneCount }).map((_, rowIndex) => {
            const laneIndex = laneCount - 1 - rowIndex;
            const note = uniqueNotes[laneIndex];
            return (
              <div
                key={laneIndex}
                data-jam-note={note}
                className={`lane ${activePads && Array.from(activePads).some(note => noteToLane(note) === laneIndex) ? 'lane-active' : ''}`}
              >
                <div
                  className="notes-scroll-container"
                  style={{
                    transform: `translateX(${hitZoneOffset - currentTime * JAM_PIXELS_PER_MS}px)`,
                    ...(jamLesson?.stepped && { transition: 'transform 0.3s ease-out' }),
                  }}
                >
                  {renderJamLessonNotes(laneIndex)}
                  {renderJamNotes(laneIndex)}
                </div>
              </div>
            );
          })}
        </div>
      ) : isCollapsed ? (
        mode === 'play' ? (
          /* Play mode collapsed: time-based positioning */
          <div className="lanes collapsed-lanes">
            <div className="lane collapsed-lane">
              <div
                className="notes-scroll-container"
                style={{
                  transform: `translateX(${hitZoneOffset - playModeScrollOffset}px)`,
                }}
              >
                {renderCollapsedPlayModeNotes()}
              </div>
            </div>
          </div>
        ) : (
          /* Free/Wait modes collapsed: equal spacing */
          <div className="lanes collapsed-lanes">
            <div className="lane collapsed-lane">
              <div
                className="notes-scroll-container"
                style={{
                  transform: `translateX(${-freeWaitScrollOffset}px)`,
                  transition: 'transform 0.3s ease-out',
                }}
              >
                {renderCollapsedFreeWaitNotes()}
              </div>
            </div>
          </div>
        )
      ) : mode === 'play' ? (
        /* Play mode: time-based scrolling lanes */
        <div className="lanes">
          {laneRows.map((laneIndex) => (
            <div
              key={laneIndex}
              className={`lane ${activePads && Array.from(activePads).some(note => noteToLane(note) === laneIndex) ? 'lane-active' : ''}`}
            >
              {/* Lane label - fixed position */}
              <div className="lane-label" style={{ color: getLaneColor(laneIndex) }}>
                {getLaneLabel(laneIndex)}
              </div>

              {/* Scrolling notes container (time-based) */}
              <div
                className="notes-scroll-container"
                style={{
                  transform: `translateX(${hitZoneOffset - playModeScrollOffset}px)`,
                }}
              >
                {renderPlayModeNotes(laneIndex)}
              </div>
            </div>
          ))}
        </div>
      ) : (
        /* Free/Wait modes: notes positioned left to right */
        <div className="lanes">
          {laneRows.map((laneIndex) => (
            <div
              key={laneIndex}
              className={`lane ${activePads && Array.from(activePads).some(note => noteToLane(note) === laneIndex) ? 'lane-active' : ''}`}
            >
              <div className="lane-label" style={{ color: getLaneColor(laneIndex) }}>
                {getLaneLabel(laneIndex)}
              </div>

              {/* Notes container with smooth scrolling */}
              <div
                className="notes-scroll-container"
                style={{
                  transform: `translateX(${-freeWaitScrollOffset}px)`,
                  transition: 'transform 0.3s ease-out',
                }}
              >
                {renderFreeWaitNotes(laneIndex)}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Jam mode: a toolbar at the top (the player's buttons, the clock)
          instead of the progress bar */}
      {mode === 'jam' ? (
        <div className="jam-toolbar" onPointerDown={(event) => event.stopPropagation()}>
          {jamToolbar}
          <span className="jam-toolbar-clock">{getProgressLabel()}</span>
        </div>
      ) : (
        <>
        {/* A lesson room's other modes keep the toolbar's buttons */}
        {jamToolbar && (
          <div className="jam-toolbar" onPointerDown={(event) => event.stopPropagation()}>
            {jamToolbar}
          </div>
        )}
        {/* Progress bar */}
        <div className="highway-progress">
          <div className="progress-bar-container">
            <div
              className="progress-bar-fill"
              style={{ width: `${getProgress()}%` }}
            />
          </div>
          <div className="progress-label">
            {getProgressLabel()}
          </div>
        </div>
        </>
      )}
    </div>
  );
}
