import { Fragment, useEffect, useRef, useState, useMemo } from 'react';
import { LessonStep, InstrumentType, HitFeedback } from '../../types/lesson';
import './NoteHighway.css';

export type HighwayMode = 'free' | 'wait' | 'play';

interface NoteHighwayProps {
  instrument: InstrumentType;
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

export function NoteHighway({
  instrument,
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
  labelMode = 'letters'
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

  // Calculate hit zone offset based on container width
  const hitZoneOffset = useMemo(() => {
    return containerWidth * HIT_ZONE_PERCENT;
  }, [containerWidth]);

  // Get unique notes from the lesson (sorted by MIDI value)
  const uniqueNotes = useMemo(() =>
    Array.from(new Set(steps.map(s => s.note))).sort((a, b) => a - b),
    [steps]
  );

  // Determine number of lanes based on unique notes in the lesson
  const laneCount = uniqueNotes.length;

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
        // Skip if already has a hit state
        if (newStates.has(stepIndex)) return;

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
  }, [mode, currentTime, steps, stepTimes, noteSize]);

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

  const getLaneLabel = (laneIndex: number): string => {
    // Just show the note number (1, 2, 3, etc.)
    return String(laneIndex + 1);
  };

  const getLaneColor = (laneIndex: number): string => {
    const colors = [
      '#ef4444', // red (P1)
      '#3b82f6', // blue (P2)
      '#a855f7', // purple (P3)
      '#f59e0b', // amber (P4)
      '#8b5cf6', // violet
      '#ec4899', // pink
      '#06b6d4', // cyan
      '#f97316', // orange
    ];
    return colors[laneIndex % colors.length];
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
    if (mode !== 'play') return null;
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
                : `${((popup.laneIndex + 0.5) / Math.max(1, laneCount)) * 100}%`,
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
      return String(noteToLane(note) + 1);
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
  const getFreeWaitPixelPosition = (stepIndex: number): number => {
    return HIGHWAY_MARGIN + stepIndex * NOTE_SPACING_PX;
  };

  // Smooth scroll offset based on progress
  const freeWaitScrollOffset = useMemo(() => {
    const targetStep = mode === 'wait' ? currentStepIndex : playedSteps.size;
    // Start scrolling after 6 notes, keep current note visible on left side
    return Math.max(0, targetStep - 6) * NOTE_SPACING_PX;
  }, [mode, currentStepIndex, playedSteps.size]);

  // Check if note should be rendered (performance optimization)
  // Show ALL notes from the beginning up to some distance ahead of current position
  // Never hide notes on the left - they should remain visible as played notes
  const isFreeWaitNoteVisible = (stepIndex: number): boolean => {
    const targetStep = mode === 'wait' ? currentStepIndex : playedSteps.size;
    // Show all notes from start (index 0) up to 30 notes ahead of current position
    return stepIndex <= targetStep + 30;
  };

  // Timing feedback is driven by the actual offset (deltaMs), independent of the
  // engine's perfect/good/early/late buckets. Within ON_TIME_MS the hit is "on
  // time" (green); beyond it we show early (blue) or late (orange), dim the
  // expected note, and draw a solid ghost where the hit actually landed.
  const ON_TIME_MS = 50;
  const OFF_TIMING_NOTE_OPACITY = 0.35;

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

        let noteClass = 'note scrolling-note';
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
                ...(shouldApplyColor && { backgroundColor: getLaneColor(laneIndex) }),
              }}
            >
              {label && <span className="note-label" style={{ fontSize: `${noteFontSize}px` }}>{label}</span>}
            </div>
            {offTiming && (
              <div
                className={`note scrolling-note ghost-hit ${timingClass}${label ? ' has-label' : ''}`}
                style={{
                  left: `${pixelPosition + hitState!.deltaMs! * PIXELS_PER_MS}px`,
                  opacity,
                  width: `${noteSize}px`,
                  height: `${noteSize}px`,
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

        let noteClass = 'note scrolling-note';
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
              backgroundColor: isPlayed ? undefined : getLaneColor(laneIndex),
            }}
          >
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

        let noteClass = 'note scrolling-note';
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
              backgroundColor: isPlayed ? undefined : getLaneColor(laneIndex),
            }}
          >
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

        let noteClass = 'note scrolling-note';
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
                ...(shouldApplyColor && { backgroundColor: getLaneColor(laneIndex) }),
              }}
            >
              {label && <span className="note-label" style={{ fontSize: `${collapsedFontSize}px` }}>{label}</span>}
            </div>
            {offTiming && (
              <div
                className={`note scrolling-note ghost-hit ${timingClass}${label ? ' has-label' : ''}`}
                style={{
                  left: `${pixelPosition + hitState!.deltaMs! * PIXELS_PER_MS}px`,
                  opacity,
                }}
              >
                {label && <span className="note-label" style={{ fontSize: `${collapsedFontSize}px` }}>{label}</span>}
              </div>
            )}
          </Fragment>
        );
      });
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
    if (mode === 'play') {
      const minutes = Math.floor(currentTime / 60000);
      const seconds = Math.floor((currentTime % 60000) / 1000);
      const totalMinutes = Math.floor(totalDuration / 60000);
      const totalSeconds = Math.floor((totalDuration % 60000) / 1000);
      return `${minutes}:${seconds.toString().padStart(2, '0')} / ${totalMinutes}:${totalSeconds.toString().padStart(2, '0')}`;
    }
    return `${playedSteps.size} / ${steps.length} notes`;
  };

  return (
    <div ref={containerRef} className={`note-highway ${isCollapsed ? 'collapsed' : ''}`}>
      {/* Hit zone indicator line - fixed position (for play mode) */}
      {mode === 'play' && (
        <div className={`timing-line ${hasActivePad ? 'active' : ''}`} />
      )}

      {/* Floating timing judgments (early / late / perfect) at the hit zone */}
      {renderTimingPopups()}

      {/* Collapsed view: single lane with all notes */}
      {isCollapsed ? (
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
          {Array.from({ length: laneCount }).map((_, laneIndex) => (
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
          {Array.from({ length: laneCount }).map((_, laneIndex) => (
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
    </div>
  );
}
