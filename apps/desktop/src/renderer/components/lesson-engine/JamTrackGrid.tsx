import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { JAM_TRACK_BARS, jamTrackParts, type JamTrack, type JamTrackNote } from './jamTracks';
import type { JamTrackMix } from './jamBackingMixer';
import { JamLaneStrip } from './JamLaneStrip';
import { LanesIcon } from './JamIcons';
import './JamTrackGrid.css';

// The Jam tab's backing track as an editable step grid: one lane per drum and
// per synth part, four bars at a time. Clicking a cell adds or removes a hit or
// a note, dragging one up or down sets its velocity, and a lane's name switches
// its resolution. Each lane has solo, mute and a level, which fold away. The
// page follows the playhead unless a section is picked.

const SECTION_BARS = 4;
const SECTION_STEPS = SECTION_BARS * 16;
const SECTIONS = JAM_TRACK_BARS / SECTION_BARS;
const LOOP_STEPS = JAM_TRACK_BARS * 16;
// Cells per bar a lane can use; each lane shows at least the coarsest one that fits its notes
const DIVISIONS = [4, 8, 16, 32];
const ROW_COLORS = ['#2f9e5b', '#e07b39', '#e8b33f', '#7b57b0', '#3b82c4', '#c8508a', '#2aa198'];
const NEW_VELOCITY = 100;
// Dragging this far (px) changes a velocity by the full range; less than
// DRAG_SLOP_PX counts as a click
const DRAG_RANGE_PX = 120;
const DRAG_SLOP_PX = 4;

interface JamTrackGridProps {
  track: JamTrack;
  // The track's notes, one list per part (drums first, as jamTrackParts orders them)
  notes: JamTrackNote[][];
  // Resolution picked per lane, in cells per bar; null for the coarsest that fits
  divisions: (number | null)[];
  mix: JamTrackMix;
  // Buttons shown first in the header (back, the sidebar's)
  toolbar?: ReactNode;
  // Lane controls shown, or folded away
  lanesOpen: boolean;
  onLanesOpenChange: (open: boolean) => void;
  edited: boolean;
  paused: boolean;
  onChange: (notes: JamTrackNote[][], divisions: (number | null)[]) => void;
  onMixChange: (mix: JamTrackMix) => void;
  onReset: () => void;
  onTogglePause: () => void;
  // 16ths since the backing track started, or null while it is not playing
  getStep: () => number | null;
}

const fittingDivision = (notes: JamTrackNote[]) =>
  DIVISIONS.find((division) => notes.every((note) => Number.isInteger((note.step * division) / 16))) ?? 32;

// A note's or hit's colour fills it from the bottom up to its velocity. The
// fill spans the border too and is not tiled, or the border would show a
// strip of the next tile.
const velocityFill = (color: string, velocity: number) => {
  const level = Math.round((velocity / 127) * 100);
  return `linear-gradient(to top, ${color} ${level}%, ${color}40 ${level}%) border-box no-repeat`;
};

const noteKey = (note: JamTrackNote) => `${note.step}|${note.pitch}`;

interface Drag {
  row: number;
  keys: Set<string>;
  startY: number;
  velocities: Map<string, number>;
  moved: boolean;
  // A click without dragging removes the notes it pressed on
  removeOnClick: boolean;
}

export function JamTrackGrid({
  track,
  notes,
  divisions,
  mix,
  toolbar,
  lanesOpen,
  onLanesOpenChange,
  edited,
  paused,
  onChange,
  onMixChange,
  onReset,
  onTogglePause,
  getStep,
}: JamTrackGridProps) {
  const original = useMemo(() => jamTrackParts(track), [track]);
  const [pinned, setPinned] = useState<number | null>(null);
  const [playing, setPlaying] = useState(0);
  const playheadRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const section = pinned ?? playing;
  const first = section * SECTION_STEPS;
  const soloing = mix.solos.some(Boolean);

  // The playhead moves every frame without re-rendering; the playing section is tracked for the page
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const step = getStep();
      const inLoop = step === null ? 0 : Math.max(0, step) % LOOP_STEPS;
      const now = Math.floor(inLoop / SECTION_STEPS);
      if (step !== null) setPlaying(now);
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

  const setMix = (key: keyof JamTrackMix, row: number, value: number | boolean) =>
    onMixChange({ ...mix, [key]: mix[key].map((current, r) => (r === row ? value : current)) });

  // Pressing on notes starts a drag that sets their velocity; pressing on an
  // empty spot adds a note there first, which the drag then sets
  const press = (event: ReactPointerEvent<HTMLElement>, row: number, pressed: JamTrackNote[], added: JamTrackNote | null) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const notesHere = added ? [added] : pressed;
    dragRef.current = {
      row,
      keys: new Set(notesHere.map(noteKey)),
      startY: event.clientY,
      velocities: new Map(notesHere.map((note) => [noteKey(note), note.velocity])),
      moved: false,
      removeOnClick: !added,
    };
    if (added) setPart(row, [...notes[row], added]);
  };

  const drag = (event: ReactPointerEvent<HTMLElement>) => {
    const current = dragRef.current;
    if (!current) return;
    const dy = current.startY - event.clientY;
    if (!current.moved && Math.abs(dy) < DRAG_SLOP_PX) return;
    current.moved = true;
    const change = (dy / DRAG_RANGE_PX) * 127;
    setPart(
      current.row,
      notes[current.row].map((note) => {
        const from = current.velocities.get(noteKey(note));
        if (from === undefined) return note;
        return { ...note, velocity: Math.round(Math.min(127, Math.max(1, from + change))) };
      })
    );
  };

  const release = () => {
    const current = dragRef.current;
    dragRef.current = null;
    if (!current || current.moved || !current.removeOnClick) return;
    setPart(current.row, notes[current.row].filter((note) => !current.keys.has(noteKey(note))));
  };

  // A drum cell: its hits, or a new one at its start
  const pressCell = (event: ReactPointerEvent<HTMLElement>, row: number, cellStart: number, cellSteps: number) => {
    const inCell = notes[row].filter((note) => note.step >= cellStart && note.step < cellStart + cellSteps);
    press(event, row, inCell, inCell.length ? null : { pitch: 0, step: cellStart, length: cellSteps, velocity: NEW_VELOCITY });
  };

  // A piano roll: the note under the pointer on that pitch, or a new one a cell long
  const pressRoll = (event: ReactPointerEvent<HTMLDivElement>, row: number, pitches: number[]) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const cellSteps = 16 / shownDivision(row);
    const cell = Math.floor(((event.clientX - rect.left) / rect.width) * (SECTION_STEPS / cellSteps));
    const step = first + cell * cellSteps;
    const lane = Math.floor(((event.clientY - rect.top) / rect.height) * pitches.length);
    const pitch = pitches[Math.min(pitches.length - 1, Math.max(0, lane))];
    const under = notes[row].filter(
      (note) => note.pitch === pitch && note.step < step + cellSteps && note.step + note.length > step
    );
    press(event, row, under, under.length ? null : { pitch, step, length: cellSteps, velocity: NEW_VELOCITY });
  };

  return (
    <div className={`jam-grid ${lanesOpen ? '' : 'lanes-closed'}`}>
      <div className="jam-grid-head">
        {toolbar}
        <button
          className={`jam-corner-btn ${lanesOpen ? 'on' : ''}`}
          onClick={(event) => {
            onLanesOpenChange(!lanesOpen);
            event.currentTarget.blur();
          }}
          title={lanesOpen ? 'Hide lane controls' : 'Show lane controls'}
        >
          <LanesIcon />
        </button>
        <button
          className={`jam-grid-play ${paused ? '' : 'playing'}`}
          onClick={onTogglePause}
          aria-label={paused ? 'Play' : 'Pause'}
        >
          {paused ? '▶' : '❚❚'}
        </button>
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
          <div className="jam-grid-lane" />
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
          const silent = mix.mutes[row] || (soloing && !mix.solos[row]);
          const lane = (
            <div className="jam-grid-lane">
              {lanesOpen && (
                <JamLaneStrip
                  name={part.name}
                  tag={`1/${division}`}
                  solo={mix.solos[row]}
                  mute={mix.mutes[row]}
                  level={mix.levels[row]}
                  onNameClick={() => cycleDivision(row)}
                  onSolo={() => setMix('solos', row, !mix.solos[row])}
                  onMute={() => setMix('mutes', row, !mix.mutes[row])}
                  onLevel={(level) => setMix('levels', row, level)}
                />
              )}
            </div>
          );
          if (part.kind === 'drum') {
            const cells = division * SECTION_BARS;
            return (
              <div key={part.name} className={`jam-grid-row ${silent ? 'silent' : ''}`}>
                {lane}
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
                        style={velocity ? { background: velocityFill(color, velocity) } : undefined}
                        onPointerDown={(event) => pressCell(event, row, cellStart, cellSteps)}
                        onPointerMove={drag}
                        onPointerUp={release}
                        onPointerCancel={release}
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
            <div key={part.name} className={`jam-grid-row tall ${silent ? 'silent' : ''}`}>
              {lane}
              <div
                className="jam-grid-roll"
                onPointerDown={(event) => pressRoll(event, row, pitches)}
                onPointerMove={drag}
                onPointerUp={release}
                onPointerCancel={release}
              >
                {Array.from({ length: SECTION_STEPS / cellSteps }, (_, cell) => (
                  <span
                    key={cell}
                    className={`jam-grid-roll-line ${(cell * cellSteps) % 4 === 0 ? 'on-beat' : ''}`}
                    style={{ left: `${((cell * cellSteps) / SECTION_STEPS) * 100}%` }}
                  />
                ))}
                {shown.map((note) => {
                  const start = Math.max(note.step, first) - first;
                  const end = Math.min(note.step + note.length, first + SECTION_STEPS) - first;
                  return (
                    <span
                      key={noteKey(note)}
                      className="jam-grid-note"
                      style={{
                        left: `${(start / SECTION_STEPS) * 100}%`,
                        width: `${((end - start) / SECTION_STEPS) * 100}%`,
                        top: `${(pitches.indexOf(note.pitch) / pitches.length) * 100}%`,
                        height: `${100 / pitches.length}%`,
                        background: velocityFill(color, note.velocity),
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
