import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { JAM_TRACK_BARS, jamTrackParts, type JamTrack, type JamTrackNote } from './jamTracks';
import './JamTrackGrid.css';

// The Jam tab's backing track as an editable step grid: one row per drum and
// per synth part, four bars at a time. Clicking a cell adds or removes a hit or
// a note; a row's name switches its resolution. The page follows the playhead
// unless a section is picked.

const SECTION_BARS = 4;
const SECTION_STEPS = SECTION_BARS * 16;
const SECTIONS = JAM_TRACK_BARS / SECTION_BARS;
const LOOP_STEPS = JAM_TRACK_BARS * 16;
// Cells per bar a row can use; each row shows at least the coarsest one that fits its notes
const DIVISIONS = [4, 8, 16, 32];
const ROW_COLORS = ['#2f9e5b', '#e07b39', '#e8b33f', '#7b57b0', '#3b82c4', '#c8508a', '#2aa198'];
const NEW_VELOCITY = 100;

interface JamTrackGridProps {
  track: JamTrack;
  // The track's notes, one list per part (drums first, as jamTrackParts orders them)
  notes: JamTrackNote[][];
  // Resolution picked per row, in cells per bar; null for the coarsest that fits
  divisions: (number | null)[];
  edited: boolean;
  onChange: (notes: JamTrackNote[][], divisions: (number | null)[]) => void;
  onReset: () => void;
  // 16ths since the backing track started, or null before it has
  getStep: () => number | null;
}

const fittingDivision = (notes: JamTrackNote[]) =>
  DIVISIONS.find((division) => notes.every((note) => Number.isInteger((note.step * division) / 16))) ?? 32;

const opacityFor = (velocity: number) => 0.45 + (0.55 * velocity) / 127;

export function JamTrackGrid({ track, notes, divisions, edited, onChange, onReset, getStep }: JamTrackGridProps) {
  const original = useMemo(() => jamTrackParts(track), [track]);
  const [pinned, setPinned] = useState<number | null>(null);
  const [playing, setPlaying] = useState(0);
  const playheadRef = useRef<HTMLDivElement>(null);
  const section = pinned ?? playing;
  const first = section * SECTION_STEPS;

  // The playhead moves every frame without re-rendering; the playing section is tracked for the page
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const step = getStep();
      const inLoop = step === null ? 0 : Math.max(0, step) % LOOP_STEPS;
      const now = Math.floor(inLoop / SECTION_STEPS);
      setPlaying(now);
      if (playheadRef.current) {
        playheadRef.current.style.visibility = step === null || now !== section ? 'hidden' : 'visible';
        playheadRef.current.style.left = `${((Math.floor(inLoop) % SECTION_STEPS) / SECTION_STEPS) * 100}%`;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [getStep, section]);

  const shownDivision = (row: number) => Math.max(divisions[row] ?? 0, fittingDivision(notes[row]));

  const setPart = (row: number, part: JamTrackNote[]) =>
    onChange(
      notes.map((current, r) => (r === row ? [...part].sort((a, b) => a.step - b.step || a.pitch - b.pitch) : current)),
      divisions
    );

  // Next finer resolution, back to the coarsest that fits after 32
  const cycleDivision = (row: number) => {
    const fitting = fittingDivision(notes[row]);
    const next = DIVISIONS.find((division) => division > shownDivision(row));
    onChange(
      notes,
      divisions.map((division, r) => (r === row ? (next && next !== fitting ? next : null) : division))
    );
  };

  // A drum cell: removes the hits starting in it, or adds one at its start
  const toggleCell = (row: number, cellStart: number, cellSteps: number) => {
    const part = notes[row];
    const inCell = (note: JamTrackNote) => note.step >= cellStart && note.step < cellStart + cellSteps;
    setPart(
      row,
      part.some(inCell)
        ? part.filter((note) => !inCell(note))
        : [...part, { pitch: 0, step: cellStart, length: cellSteps, velocity: NEW_VELOCITY }]
    );
  };

  // A piano-roll click: removes the note under it on that pitch, or adds one a cell long
  const toggleNote = (row: number, pitches: number[], event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const cellSteps = 16 / shownDivision(row);
    const cell = Math.floor(((event.clientX - rect.left) / rect.width) * (SECTION_STEPS / cellSteps));
    const step = first + cell * cellSteps;
    const lane = Math.floor(((event.clientY - rect.top) / rect.height) * pitches.length);
    const pitch = pitches[Math.min(pitches.length - 1, Math.max(0, lane))];
    const part = notes[row];
    const under = (note: JamTrackNote) =>
      note.pitch === pitch && note.step < step + cellSteps && note.step + note.length > step;
    setPart(
      row,
      part.some(under)
        ? part.filter((note) => !under(note))
        : [...part, { pitch, step, length: cellSteps, velocity: NEW_VELOCITY }]
    );
  };

  return (
    <div className="jam-grid">
      <div className="jam-grid-head">
        <div className="jam-grid-title">
          Section {section + 1} / {SECTIONS}
        </div>
        <div className="jam-grid-sections">
          <button className={pinned === null ? 'active' : ''} onClick={() => setPinned(null)}>
            Auto
          </button>
          {Array.from({ length: SECTIONS }, (_, index) => (
            <button
              key={index}
              className={`${pinned === index ? 'active' : ''} ${playing === index ? 'playing' : ''}`}
              onClick={() => setPinned(index)}
            >
              {index + 1}
            </button>
          ))}
        </div>
        {edited && (
          <button className="jam-grid-reset" onClick={onReset}>
            Reset
          </button>
        )}
      </div>
      <div className="jam-grid-body">
        <div className="jam-grid-row jam-grid-beats">
          <div className="jam-grid-name" />
          <div className="jam-grid-cells" style={{ gridTemplateColumns: `repeat(${SECTION_STEPS / 2}, minmax(0, 1fr))` }}>
            {Array.from({ length: SECTION_STEPS / 2 }, (_, i) => (
              <span
                key={i}
                className={i % 2 === 0 ? `jam-grid-beat ${i % 8 === 0 ? 'bar-start' : ''}` : 'jam-grid-and'}
              >
                {i % 2 === 0 ? i / 2 + 1 : '+'}
              </span>
            ))}
          </div>
        </div>
        {original.map((part, row) => {
          const color = ROW_COLORS[row % ROW_COLORS.length];
          const division = shownDivision(row);
          const cellSteps = 16 / division;
          const name = (
            <button className="jam-grid-name" onClick={() => cycleDivision(row)}>
              {part.name}
              <span className="jam-grid-division">1/{division}</span>
            </button>
          );
          if (part.kind === 'drum') {
            const cells = division * SECTION_BARS;
            return (
              <div key={part.name} className="jam-grid-row">
                {name}
                <div
                  className={`jam-grid-cells ${division >= 16 ? 'narrow' : ''}`}
                  style={{ gridTemplateColumns: `repeat(${cells}, minmax(0, 1fr))` }}
                >
                  {Array.from({ length: cells }, (_, cell) => {
                    const cellStart = first + cell * cellSteps;
                    const velocity = notes[row]
                      .filter((note) => note.step >= cellStart && note.step < cellStart + cellSteps)
                      .reduce((max, note) => Math.max(max, note.velocity), 0);
                    return (
                      <button
                        key={cell}
                        className={`jam-grid-cell ${(cell * cellSteps) % 4 === 0 ? 'on-beat' : ''}`}
                        style={velocity ? { background: color, opacity: opacityFor(velocity) } : undefined}
                        onPointerDown={() => toggleCell(row, cellStart, cellSteps)}
                      />
                    );
                  })}
                </div>
              </div>
            );
          }
          // Synth part: a small piano roll with a lane per pitch the part plays, lowest at the bottom
          const pitches = [...new Set([...part.notes, ...notes[row]].map((note) => note.pitch))].sort((a, b) => b - a);
          const shown = notes[row].filter((note) => note.step < first + SECTION_STEPS && note.step + note.length > first);
          return (
            <div key={part.name} className="jam-grid-row tall">
              {name}
              <div className="jam-grid-roll" onPointerDown={(event) => toggleNote(row, pitches, event)}>
                {Array.from({ length: SECTION_STEPS / cellSteps }, (_, cell) => (
                  <span
                    key={cell}
                    className={`jam-grid-roll-line ${(cell * cellSteps) % 4 === 0 ? 'on-beat' : ''}`}
                    style={{ left: `${((cell * cellSteps) / SECTION_STEPS) * 100}%` }}
                  />
                ))}
                {shown.map((note, i) => {
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
