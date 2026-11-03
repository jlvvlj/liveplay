import { useEffect, useMemo, useRef, useState } from 'react';
import { JAM_TRACK_BARS, jamTrackParts, type JamTrack, type JamTrackNote } from './jamTracks';
import './JamTrackGrid.css';

// The Jam tab's backing track as a step grid: one row per drum and per synth
// part, two bars at a time, turning the page with the playhead

const SECTION_BARS = 2;
const SECTION_STEPS = SECTION_BARS * 16;
const SECTIONS = JAM_TRACK_BARS / SECTION_BARS;
const LOOP_STEPS = JAM_TRACK_BARS * 16;
// Cells per bar a row can use; each row takes the coarsest one that fits its notes
const DIVISIONS = [4, 8, 16, 32];
const ROW_COLORS = ['#2f9e5b', '#e07b39', '#e8b33f', '#7b57b0', '#3b82c4', '#c8508a', '#2aa198'];

interface JamTrackGridProps {
  track: JamTrack;
  // 16ths since the backing track started, or null before it has
  getStep: () => number | null;
}

const divisionFor = (notes: JamTrackNote[]) =>
  DIVISIONS.find((division) => notes.every((note) => Number.isInteger((note.step * division) / 16))) ?? 32;

const opacityFor = (velocity: number) => 0.45 + (0.55 * velocity) / 127;

export function JamTrackGrid({ track, getStep }: JamTrackGridProps) {
  const parts = useMemo(() => jamTrackParts(track), [track]);
  const [section, setSection] = useState(0);
  const playheadRef = useRef<HTMLDivElement>(null);

  // The playhead moves every frame without re-rendering; the page turns with it
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const step = getStep();
      const inLoop = step === null ? 0 : Math.max(0, step) % LOOP_STEPS;
      setSection(Math.floor(inLoop / SECTION_STEPS));
      if (playheadRef.current) {
        playheadRef.current.style.visibility = step === null ? 'hidden' : 'visible';
        playheadRef.current.style.left = `${((Math.floor(inLoop) % SECTION_STEPS) / SECTION_STEPS) * 100}%`;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [getStep]);

  const first = section * SECTION_STEPS;
  const inSection = (note: JamTrackNote) => note.step < first + SECTION_STEPS && note.step + note.length > first;

  return (
    <div className="jam-grid">
      <div className="jam-grid-title">
        Section {section + 1} / {SECTIONS}
      </div>
      <div className="jam-grid-body">
        <div className="jam-grid-row jam-grid-beats">
          <div className="jam-grid-name" />
          <div className="jam-grid-cells" style={{ gridTemplateColumns: `repeat(${SECTION_STEPS / 2}, 1fr)` }}>
            {Array.from({ length: SECTION_STEPS / 2 }, (_, i) => (
              <span key={i} className={i % 2 === 0 ? 'jam-grid-beat' : 'jam-grid-and'}>
                {i % 2 === 0 ? i / 2 + 1 : '+'}
              </span>
            ))}
          </div>
        </div>
        {parts.map((part, row) => {
          const color = ROW_COLORS[row % ROW_COLORS.length];
          if (part.kind === 'drum') {
            const division = divisionFor(part.notes);
            const cells = division * SECTION_BARS;
            const cellSteps = 16 / division;
            const velocities = Array.from({ length: cells }, (_, cell) =>
              part.notes
                .filter((note) => note.step >= first + cell * cellSteps && note.step < first + (cell + 1) * cellSteps)
                .reduce((max, note) => Math.max(max, note.velocity), 0),
            );
            return (
              <div key={part.name} className="jam-grid-row">
                <div className="jam-grid-name">{part.name}</div>
                <div
                  className={`jam-grid-cells ${division >= 16 ? 'narrow' : ''}`}
                  style={{ gridTemplateColumns: `repeat(${cells}, 1fr)` }}
                >
                  {velocities.map((velocity, cell) => (
                    <span
                      key={cell}
                      className={`jam-grid-cell ${(cell * cellSteps) % 4 === 0 ? 'on-beat' : ''}`}
                      style={velocity ? { background: color, opacity: opacityFor(velocity) } : undefined}
                    />
                  ))}
                </div>
              </div>
            );
          }
          // Synth part: a small piano roll with one lane per pitch it plays, lowest at the bottom
          const pitches = [...new Set(part.notes.map((note) => note.pitch))].sort((a, b) => b - a);
          return (
            <div key={part.name} className="jam-grid-row tall">
              <div className="jam-grid-name">{part.name}</div>
              <div className="jam-grid-roll">
                {Array.from({ length: SECTION_STEPS / 4 }, (_, beat) => (
                  <span
                    key={beat}
                    className="jam-grid-roll-beat"
                    style={{ left: `${(beat / (SECTION_STEPS / 4)) * 100}%` }}
                  />
                ))}
                {part.notes.filter(inSection).map((note, i) => {
                  const start = Math.max(note.step, first) - first;
                  const end = Math.min(note.step + note.length, first + SECTION_STEPS) - first;
                  return (
                    <span
                      key={i}
                      className="jam-grid-note"
                      style={{
                        left: `${(start / SECTION_STEPS) * 100}%`,
                        width: `${((end - start) / SECTION_STEPS) * 100}%`,
                        top: `${(pitches.indexOf(note.pitch) / pitches.length) * 100}%`,
                        height: `${100 / pitches.length}%`,
                        background: color,
                        opacity: opacityFor(note.velocity),
                      }}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
        <div className="jam-grid-overlay">
          <div ref={playheadRef} className="jam-grid-playhead" style={{ width: `${100 / SECTION_STEPS}%` }} />
        </div>
      </div>
    </div>
  );
}
