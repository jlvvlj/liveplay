import { useEffect, useRef, useState } from 'react';
import { LessonStep, InstrumentType } from '../../types/lesson';
import './NoteHighway.css';

interface NoteHighwayProps {
  instrument: InstrumentType;
  steps: LessonStep[];
  currentTime: number;
  bpm: number;
  onNoteReached?: (step: LessonStep) => void;
}

interface VisualNote {
  step: LessonStep;
  position: number; // 0 = top, 1 = hit zone
  opacity: number;
  hit?: boolean;
  accuracy?: 'perfect' | 'good' | 'early' | 'late' | 'miss';
}

const LOOK_AHEAD_TIME = 3000; // Show notes 3 seconds ahead
const NOTE_FALL_DURATION = 3000; // Notes take 3 seconds to reach hit zone

export function NoteHighway({ instrument, steps, currentTime, bpm, onNoteReached }: NoteHighwayProps) {
  const [visualNotes, setVisualNotes] = useState<Map<number, VisualNote>>(new Map());
  const animationFrameRef = useRef<number>();
  const lastUpdateRef = useRef<number>(0);

  // Determine number of lanes based on instrument
  const getLaneCount = (): number => {
    switch (instrument) {
      case 'pads':
        return 4; // 4 pads
      case 'drums':
        return 5; // Kick, snare, hi-hat, crash, ride
      case 'keys':
        return 8; // Show 8 keys for simplicity
      default:
        return 4;
    }
  };

  const laneCount = getLaneCount();

  // Map MIDI note to lane index
  const noteToLane = (note: number): number => {
    if (instrument === 'pads') {
      // Standard pad mapping: 36, 37, 38, 39
      return Math.max(0, Math.min(laneCount - 1, note - 36));
    } else if (instrument === 'drums') {
      // Drum mapping: 36=kick, 38=snare, 42=hihat, 49=crash, 51=ride
      const drumMap: { [key: number]: number } = {
        36: 0, // Kick
        38: 1, // Snare
        42: 2, // Hi-hat
        49: 3, // Crash
        51: 4, // Ride
      };
      return drumMap[note] ?? 0;
    } else {
      // Keys: map to visual lanes (C4=60)
      return Math.max(0, Math.min(laneCount - 1, (note - 60) % laneCount));
    }
  };

  const ticksToMs = (ticks: number): number => {
    const ticksPerBeat = 480;
    const beatsPerSecond = bpm / 60;
    return (ticks / ticksPerBeat) / beatsPerSecond * 1000;
  };

  const updateNotes = (time: number) => {
    const newVisualNotes = new Map<number, VisualNote>();

    steps.forEach((step, index) => {
      const stepTime = ticksToMs(step.tick);
      const timeDiff = stepTime - time;

      // Only show notes within look-ahead window
      if (timeDiff > -500 && timeDiff < LOOK_AHEAD_TIME) {
        const existing = visualNotes.get(index);

        // Calculate position (0 = top, 1 = hit zone)
        const position = 1 - (timeDiff / NOTE_FALL_DURATION);
        const clampedPosition = Math.max(0, Math.min(1, position));

        // Check if note should fade out after being hit
        let opacity = 1;
        let hit = existing?.hit;
        let accuracy = existing?.accuracy;

        if (existing?.hit && clampedPosition > 1) {
          opacity = Math.max(0, 1 - (clampedPosition - 1) * 2);
        }

        newVisualNotes.set(index, {
          step,
          position: clampedPosition,
          opacity,
          hit,
          accuracy,
        });

        // Notify when note reaches hit zone
        if (clampedPosition >= 0.95 && !existing?.hit && onNoteReached) {
          onNoteReached(step);
        }
      }
    });

    setVisualNotes(newVisualNotes);
  };

  useEffect(() => {
    const animate = (timestamp: number) => {
      if (timestamp - lastUpdateRef.current > 16) { // ~60fps
        updateNotes(currentTime);
        lastUpdateRef.current = timestamp;
      }
      animationFrameRef.current = requestAnimationFrame(animate);
    };

    animationFrameRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [currentTime, steps, bpm]);

  const markNoteHit = (stepIndex: number, accuracy: 'perfect' | 'good' | 'early' | 'late' | 'miss') => {
    setVisualNotes((prev) => {
      const newMap = new Map(prev);
      const note = newMap.get(stepIndex);
      if (note) {
        newMap.set(stepIndex, { ...note, hit: true, accuracy });
      }
      return newMap;
    });
  };

  const getLaneLabel = (laneIndex: number): string => {
    if (instrument === 'pads') {
      return `P${laneIndex + 1}`;
    } else if (instrument === 'drums') {
      return ['Kick', 'Snare', 'HH', 'Crash', 'Ride'][laneIndex] || '';
    } else {
      const notes = ['C', 'D', 'E', 'F', 'G', 'A', 'B', 'C'];
      return notes[laneIndex] || '';
    }
  };

  const getLaneColor = (laneIndex: number): string => {
    const colors = [
      '#ef4444', // red
      '#3b82f6', // blue
      '#10b981', // green
      '#f59e0b', // amber
      '#8b5cf6', // purple
      '#ec4899', // pink
      '#06b6d4', // cyan
      '#f97316', // orange
    ];
    return colors[laneIndex % colors.length];
  };

  return (
    <div className="note-highway">
      <div className="lanes">
        {Array.from({ length: laneCount }).map((_, laneIndex) => (
          <div key={laneIndex} className="lane" style={{ flex: 1 }}>
            {/* Lane label */}
            <div className="lane-label" style={{ color: getLaneColor(laneIndex) }}>
              {getLaneLabel(laneIndex)}
            </div>

            {/* Hit zone */}
            <div
              className="hit-zone"
              style={{
                borderColor: getLaneColor(laneIndex),
                boxShadow: `0 0 20px ${getLaneColor(laneIndex)}40`,
              }}
            />

            {/* Notes falling down this lane */}
            {Array.from(visualNotes.values())
              .filter((vn) => noteToLane(vn.step.note) === laneIndex)
              .map((visualNote, idx) => (
                <div
                  key={idx}
                  className={`note ${visualNote.hit ? 'hit' : ''} ${visualNote.accuracy || ''}`}
                  style={{
                    top: `${visualNote.position * 100}%`,
                    opacity: visualNote.opacity,
                    backgroundColor: getLaneColor(laneIndex),
                    transform: `translateY(-50%) scale(${visualNote.hit ? 1.2 : 1})`,
                  }}
                >
                  {visualNote.hit && (
                    <div className="hit-burst" style={{ borderColor: getLaneColor(laneIndex) }} />
                  )}
                </div>
              ))}
          </div>
        ))}
      </div>

      {/* Progress bar */}
      <div className="highway-progress">
        <div className="progress-label">Lesson Progress</div>
      </div>
    </div>
  );
}
