import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { JAM_TRACK_BARS, jamTrackParts, type JamTrack, type JamTrackNote, type JamTrackPart } from './jamTracks';
import type { JamTrackMix } from './jamBackingMixer';
import { JamLaneStrip } from './JamLaneStrip';
import { auditionJamPart } from './jamAudition';
import { LanesIcon } from './JamIcons';
import { SOUND_COLORS } from '../../styles/palette';
import './JamTrackGrid.css';

// The Jam tab's backing track as tracks and clips, like a DAW's timeline: the
// drums as one track, every other part as its own, each a clip over the whole
// loop. Clicking a clip opens it below, four bars at a time in square 16ths:
// the drums as a step grid with a row per sound, where clicking a cell adds
// or removes a hit and dragging one up or down sets its velocity; a part as a
// piano roll, where clicking adds a note, dragging moves it or its end, and
// the strip under it sets velocities. The page follows the playhead unless
// one is picked.

const PAGE_BARS = 4;
const PAGE_STEPS = PAGE_BARS * 16;
const PAGES = JAM_TRACK_BARS / PAGE_BARS;
const LOOP_STEPS = JAM_TRACK_BARS * 16;
const NEW_VELOCITY = 127; // a new hit or note: full velocity, a fully coloured square
// Dragging a hit this far (px) changes its velocity by the full range; less
// than DRAG_SLOP_PX counts as a click
const DRAG_RANGE_PX = 120;
const DRAG_SLOP_PX = 4;
// Cells are square and this far apart; below MIN_CELL_PX the editor scrolls sideways instead
const CELL_GAP_PX = 2;
const MIN_CELL_PX = 10;
const EDGE_PX = 6; // a note's end this wide drags its length
const ROLL_MARGIN = 2; // semitones shown past a part's lowest and highest notes
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const noteName = (pitch: number) => `${NOTE_NAMES[pitch % 12]}${Math.floor(pitch / 12) - 1}`;
const isBlackKey = (pitch: number) => [1, 3, 6, 8, 10].includes(pitch % 12);
const partColor = (part: number) => SOUND_COLORS[part % SOUND_COLORS.length];
const noteKey = (note: JamTrackNote) => `${note.step}|${note.pitch}`;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

// The timeline's zoom, as Instrument Lab's tracks (instrument-lab/client/timeline.mjs):
// it shows `span` 16ths from `start`, never fewer than a beat
const MIN_SPAN = 4;
// The view after zooming by `factor` around the 16th `focus`, which stays where it is
function zoomWindow(start: number, span: number, focus: number, factor: number): [number, number] {
  const nextSpan = clamp(span * factor, MIN_SPAN, LOOP_STEPS);
  const ratio = clamp((focus - start) / span, 0, 1);
  return [clamp(focus - ratio * nextSpan, 0, LOOP_STEPS - nextSpan), nextSpan];
}

// A note's color, brighter the louder it is (solid, over the panel)
const velocityColor = (color: string, velocity: number) =>
  `color-mix(in srgb, ${color} ${Math.round(35 + (velocity / 127) * 65)}%, var(--ds-panel))`;
// A hit's color fills it from the bottom up to its velocity. The fill spans
// the border too and is not tiled, or the border would show a strip of the
// next tile.
const velocityFill = (color: string, velocity: number) => {
  const level = Math.round((velocity / 127) * 100);
  return `linear-gradient(to top, ${color} ${level}%, color-mix(in srgb, ${color} 30%, var(--ds-panel)) ${level}%) border-box no-repeat`;
};

// One row of the timeline: the drums together, or one part
interface GridTrack {
  id: string;
  name: string;
  kind: 'drum' | 'notes';
  parts: number[];
  color: string;
}

function gridTracks(parts: JamTrackPart[]): GridTrack[] {
  const drums = parts.flatMap((part, index) => (part.kind === 'drum' ? [index] : []));
  return [
    ...(drums.length ? [{ id: 'drums', name: 'Drums', kind: 'drum' as const, parts: drums, color: partColor(drums[0]) }] : []),
    ...parts.flatMap((part, index) =>
      part.kind === 'notes' ? [{ id: `part-${index}`, name: part.name, kind: 'notes' as const, parts: [index], color: partColor(index) }] : []
    ),
  ];
}

// The pitches a part's roll shows, highest first: the part's own notes with a
// little room around them, and any note put beyond (notes put in that room
// leave the rows as they are)
function rollPitches(original: JamTrackNote[], notes: JamTrackNote[]): number[] {
  const own = original.length ? original.map((note) => note.pitch) : [60];
  const put = notes.map((note) => note.pitch);
  const low = Math.max(0, Math.min(Math.min(...own) - ROLL_MARGIN, ...put));
  const high = Math.min(127, Math.max(Math.max(...own) + ROLL_MARGIN, ...put));
  return Array.from({ length: high - low + 1 }, (_, index) => high - index);
}

interface JamTrackGridProps {
  track: JamTrack;
  // The track's notes, one list per part (drums first, as jamTrackParts orders them)
  notes: JamTrackNote[][];
  mix: JamTrackMix;
  // Buttons shown first in the header (back, the sidebar's)
  toolbar?: ReactNode;
  // The track headers shown, or folded away
  lanesOpen: boolean;
  onLanesOpenChange: (open: boolean) => void;
  edited: boolean;
  paused: boolean;
  onChange: (notes: JamTrackNote[][]) => void;
  onMixChange: (mix: JamTrackMix) => void;
  onReset: () => void;
  onTogglePause: () => void;
  // 16ths since the backing track started, or null while it is not playing
  getStep: () => number | null;
}

// Dragging hits' velocity in the step grid
interface HitDrag {
  part: number;
  keys: Set<string>;
  startY: number;
  velocities: Map<string, number>;
  moved: boolean;
  // A click without dragging removes the hits it pressed on
  removeOnClick: boolean;
}

// Dragging a note in the piano roll: where it was, which way it goes, and the
// rows as they were when the drag began
interface NoteDrag {
  part: number;
  mode: 'move' | 'length' | 'velocity';
  from: JamTrackNote;
  key: string;
  startX: number;
  startY: number;
  pitches: number[];
}

// Buttons give focus back, so the keys keep playing notes
const blurAfter = (action: () => void) => (event: ReactMouseEvent<HTMLButtonElement>) => {
  action();
  event.currentTarget.blur();
};

const TrashIcon = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
    <path
      d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13M10 11v6M14 11v6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export function JamTrackGrid({
  track,
  notes,
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
  const tracks = useMemo(() => gridTracks(original), [original]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  const [playing, setPlaying] = useState(0);
  const [selected, setSelected] = useState<{ part: number; key: string } | null>(null);
  // The editor's row headers (each drum's controls, the piano keys) shown, or folded away
  const [rowsOpen, setRowsOpen] = useState(true);
  const [cell, setCell] = useState(MIN_CELL_PX);
  // The timeline's view: from `start`, `span` 16ths of the loop
  const [view, setView] = useState<[number, number]>([0, LOOP_STEPS]);
  const [viewStart, viewSpan] = view;
  const timelineRef = useRef<HTMLDivElement>(null);
  const timelinePlayheadRef = useRef<HTMLDivElement>(null);
  const editorPlayheadRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const hitDragRef = useRef<HitDrag | null>(null);
  const noteDragRef = useRef<NoteDrag | null>(null);
  const open = tracks.find((candidate) => candidate.id === openId) ?? null;
  const page = pinned ?? playing;
  const first = page * PAGE_STEPS;
  const step = cell + CELL_GAP_PX;
  const soloing = mix.solos.some(Boolean);
  const silent = (part: number) => mix.mutes[part] || (soloing && !mix.solos[part]);

  // Another song's tracks: nothing of the last one stays open or selected
  useEffect(() => {
    setOpenId(null);
    setSelected(null);
    setView([0, LOOP_STEPS]);
  }, [track]);

  // Over the clips or the bars, a pinch (or a wheel with Ctrl) zooms around
  // the pointer and a sideways scroll pans; a plain scroll still scrolls the
  // tracks. A non-passive listener keeps the pinch from zooming the page.
  useEffect(() => {
    const node = timelineRef.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      const lane = (event.target as Element | null)?.closest?.('.jam-timeline-lane, .jam-timeline-bars');
      if (!lane) return;
      const rect = lane.getBoundingClientRect();
      if (event.ctrlKey) {
        event.preventDefault();
        setView(([start, span]) =>
          zoomWindow(start, span, start + clamp((event.clientX - rect.left) / rect.width, 0, 1) * span, event.deltaY > 0 ? 1.25 : 0.8)
        );
        return;
      }
      const delta = event.deltaX || (event.shiftKey ? event.deltaY : 0);
      if (!delta) return;
      event.preventDefault();
      const pixels = delta * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.width : 1);
      setView(([start, span]) => [clamp(start + (pixels * span) / rect.width, 0, LOOP_STEPS - span), span]);
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => node.removeEventListener('wheel', wheel);
  }, []);

  // Cells fill the editor's width, four bars across, and stay square
  useLayoutEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    const measure = () => setCell(Math.max(MIN_CELL_PX, (area.clientWidth - (PAGE_STEPS - 1) * CELL_GAP_PX) / PAGE_STEPS));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(area);
    return () => observer.disconnect();
  }, [open?.id]);

  // The playheads move every frame without re-rendering; the playing page is tracked for the editor
  const stepRef = useRef(step);
  stepRef.current = step;
  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const now = getStep();
      const inLoop = now === null ? 0 : ((now % LOOP_STEPS) + LOOP_STEPS) % LOOP_STEPS;
      const nowPage = Math.floor(inLoop / PAGE_STEPS);
      if (now !== null) setPlaying(nowPage);
      const timeline = timelinePlayheadRef.current;
      if (timeline) {
        const [start, span] = viewRef.current;
        timeline.style.visibility = now === null || inLoop < start || inLoop > start + span ? 'hidden' : 'visible';
        timeline.style.left = `${((inLoop - start) / span) * 100}%`;
      }
      const editor = editorPlayheadRef.current;
      if (editor) {
        editor.style.visibility = now === null || nowPage !== page ? 'hidden' : 'visible';
        editor.style.transform = `translateX(${(inLoop - nowPage * PAGE_STEPS) * stepRef.current}px)`;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [getStep, page]);

  const setPart = (part: number, next: JamTrackNote[]) =>
    onChange(notes.map((current, p) => (p === part ? [...next].sort((a, b) => a.step - b.step || a.pitch - b.pitch) : current)));

  // A track's solo, mute and level: the drums' set every drum's (their level
  // scales them all, keeping their balance)
  const setMixOf = (parts: number[], key: keyof JamTrackMix, value: number | boolean) => {
    const top = Math.max(...parts.map((part) => mix.levels[part]));
    onMixChange({
      ...mix,
      [key]: mix[key].map((current, part) => {
        if (!parts.includes(part)) return current;
        if (key !== 'levels') return value;
        return top > 0 ? (current as number) * ((value as number) / top) : value;
      }),
    });
  };

  const removeSelected = () => {
    if (!selected) return;
    setPart(selected.part, notes[selected.part].filter((note) => noteKey(note) !== selected.key));
    setSelected(null);
  };

  // Delete or Backspace removes the selected note; Escape lets it go
  const removeRef = useRef(removeSelected);
  removeRef.current = removeSelected;
  useEffect(() => {
    if (!selected) return;
    const onKey = (event: KeyboardEvent) => {
      const { target } = event;
      if (target instanceof Element && target.closest('input, textarea, [contenteditable="true"]')) return;
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        removeRef.current();
      } else if (event.key === 'Escape') {
        setSelected(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected]);

  // Step grid: pressing on a cell's hits starts a drag that sets their
  // velocity; pressing on an empty cell adds a hit there first
  const pressCell = (event: ReactPointerEvent<HTMLElement>, part: number, cellStep: number) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const inCell = notes[part].filter((note) => note.step >= cellStep && note.step < cellStep + 1);
    const pitch = original[part].notes[0]?.pitch ?? 0;
    const added = inCell.length ? null : { pitch, step: cellStep, length: 1, velocity: NEW_VELOCITY };
    const pressed = added ? [added] : inCell;
    hitDragRef.current = {
      part,
      keys: new Set(pressed.map(noteKey)),
      startY: event.clientY,
      velocities: new Map(pressed.map((note) => [noteKey(note), note.velocity])),
      moved: false,
      removeOnClick: !added,
    };
    if (added) setPart(part, [...notes[part], added]);
  };

  const dragCell = (event: ReactPointerEvent<HTMLElement>) => {
    const current = hitDragRef.current;
    if (!current) return;
    const dy = current.startY - event.clientY;
    if (!current.moved && Math.abs(dy) < DRAG_SLOP_PX) return;
    current.moved = true;
    const change = (dy / DRAG_RANGE_PX) * 127;
    setPart(
      current.part,
      notes[current.part].map((note) => {
        const from = current.velocities.get(noteKey(note));
        if (from === undefined) return note;
        return { ...note, velocity: Math.round(clamp(from + change, 1, 127)) };
      })
    );
  };

  const releaseCell = () => {
    const current = hitDragRef.current;
    hitDragRef.current = null;
    if (!current || current.moved || !current.removeOnClick) return;
    setPart(current.part, notes[current.part].filter((note) => !current.keys.has(noteKey(note))));
  };

  // Piano roll: pressing on a note selects it and drags it (or its end, near
  // the end); pressing on an empty spot adds a 16th note there, whose end the
  // drag then draws out
  const pressRoll = (event: ReactPointerEvent<HTMLDivElement>, part: number, pitches: number[]) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const at = first + x / step;
    const pitch = pitches[clamp(Math.floor((event.clientY - rect.top) / step), 0, pitches.length - 1)];
    const under = notes[part].find((note) => note.pitch === pitch && note.step <= at && note.step + note.length > at);
    event.currentTarget.setPointerCapture(event.pointerId);
    let note = under;
    let mode: NoteDrag['mode'] = 'move';
    if (under) {
      const end = (under.step + under.length - first) * step - CELL_GAP_PX;
      if (end - x <= EDGE_PX) mode = 'length';
    } else {
      note = { pitch, step: clamp(Math.floor(at), first, first + PAGE_STEPS - 1), length: 1, velocity: NEW_VELOCITY };
      mode = 'length';
      setPart(part, [...notes[part], note]);
      auditionJamPart(track.file, part, pitch);
    }
    noteDragRef.current = { part, mode, from: note!, key: noteKey(note!), startX: event.clientX, startY: event.clientY, pitches };
    setSelected({ part, key: noteKey(note!) });
  };

  // The velocity strip: pressing on a note's bar sets its velocity to that height
  const pressVelocity = (event: ReactPointerEvent<HTMLDivElement>, part: number) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const column = first + Math.floor((event.clientX - rect.left) / step);
    const starting = notes[part].filter((note) => Math.floor(note.step) === column);
    const note = starting.find((candidate) => selected?.part === part && noteKey(candidate) === selected.key) ?? starting[0];
    if (!note) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    noteDragRef.current = { part, mode: 'velocity', from: note, key: noteKey(note), startX: event.clientX, startY: rect.top, pitches: [] };
    setSelected({ part, key: noteKey(note) });
    dragNote(event, rect.height);
  };

  const dragNote = (event: ReactPointerEvent<HTMLDivElement>, stripHeight = 0) => {
    const current = noteDragRef.current;
    if (!current) return;
    const { from, part } = current;
    let next: JamTrackNote;
    if (current.mode === 'velocity') {
      const height = stripHeight || event.currentTarget.getBoundingClientRect().height;
      next = { ...from, velocity: Math.round(clamp((1 - (event.clientY - current.startY) / height) * 127, 1, 127)) };
    } else {
      const steps = Math.round((event.clientX - current.startX) / step);
      if (current.mode === 'length') {
        const end = clamp(Math.round(from.step + from.length) + steps, Math.floor(from.step) + 1, LOOP_STEPS);
        next = { ...from, length: end - from.step };
      } else {
        const rows = Math.round((event.clientY - current.startY) / step);
        const row = clamp(current.pitches.indexOf(from.pitch) + rows, 0, current.pitches.length - 1);
        next = { ...from, step: clamp(from.step + steps, first, first + PAGE_STEPS - 1), pitch: current.pitches[row] };
      }
    }
    const key = noteKey(next);
    const others = notes[part].filter((note) => noteKey(note) !== current.key);
    // Never onto another note's place
    if (key !== current.key && others.some((note) => noteKey(note) === key)) return;
    const now = notes[part].find((note) => noteKey(note) === current.key);
    if (now && now.step === next.step && now.pitch === next.pitch && now.length === next.length && now.velocity === next.velocity) return;
    if (current.mode === 'move' && next.pitch !== now?.pitch) auditionJamPart(track.file, part, next.pitch);
    current.key = key;
    setPart(part, [...others, next]);
    setSelected({ part, key });
  };

  const releaseNote = () => {
    noteDragRef.current = null;
  };

  const togglePause = (event: ReactMouseEvent<HTMLButtonElement>) => {
    onTogglePause();
    event.currentTarget.blur();
  };

  // A clip's notes, small: the drums a row per sound, a part a row per pitch
  const renderPreview = (gridTrack: GridTrack) => {
    if (gridTrack.kind === 'drum') {
      return gridTrack.parts.flatMap((part, row) =>
        notes[part].map((note) => (
          <rect
            key={`${part}|${noteKey(note)}`}
            x={note.step + 0.15}
            y={row + 0.35}
            width={0.7}
            height={0.3}
          />
        ))
      );
    }
    const part = gridTrack.parts[0];
    const pitches = rollPitches(original[part].notes, notes[part]);
    return notes[part].map((note) => (
      <rect
        key={noteKey(note)}
        x={note.step}
        y={pitches.indexOf(note.pitch)}
        width={Math.max(0.6, note.length - 0.15)}
        height={1}
      />
    ));
  };

  const previewRows = (gridTrack: GridTrack) =>
    gridTrack.kind === 'drum'
      ? gridTrack.parts.length
      : rollPitches(original[gridTrack.parts[0]].notes, notes[gridTrack.parts[0]]).length;

  // The ruler over the editor: a mark per beat, bar.beat
  const ruler = (
    <div className="jam-editor-ruler">
      {Array.from({ length: PAGE_STEPS / 4 }, (_, beat) => {
        const bar = page * PAGE_BARS + Math.floor(beat / 4) + 1;
        return (
          <span key={beat} className={beat % 4 === 0 ? 'bar' : undefined}>
            {beat % 4 === 0 ? bar : `${bar}.${(beat % 4) + 1}`}
          </span>
        );
      })}
    </div>
  );

  const renderDrums = (gridTrack: GridTrack) => (
    <>
      {rowsOpen && (
        <div className="jam-editor-heads">
          <div className="jam-editor-corner" />
          {gridTrack.parts.map((part) => (
            <div key={part} className="jam-editor-head">
              <JamLaneStrip
                name={original[part].name}
                tag=""
                solo={mix.solos[part]}
                mute={mix.mutes[part]}
                level={mix.levels[part]}
                onNameClick={() => auditionJamPart(track.file, part, original[part].notes[0]?.pitch ?? 0)}
                onSolo={() => setMixOf([part], 'solos', !mix.solos[part])}
                onMute={() => setMixOf([part], 'mutes', !mix.mutes[part])}
                onLevel={(level) => setMixOf([part], 'levels', level)}
              />
            </div>
          ))}
        </div>
      )}
      <div className="jam-editor-area" ref={areaRef}>
        {ruler}
        {gridTrack.parts.map((part) => {
          const color = partColor(part);
          return (
            <div key={part} className={`jam-editor-cells ${silent(part) ? 'silent' : ''}`}>
              {Array.from({ length: PAGE_STEPS }, (_, index) => {
                const cellStep = first + index;
                const velocity = notes[part]
                  .filter((note) => note.step >= cellStep && note.step < cellStep + 1)
                  .reduce((loudest, note) => Math.max(loudest, note.velocity), 0);
                const classes = ['jam-editor-cell'];
                if (Math.floor(index / 4) % 2 === 1) classes.push('off-beat');
                if (index % 16 === 0) classes.push('bar-start');
                return (
                  <button
                    key={index}
                    className={classes.join(' ')}
                    style={velocity ? { background: velocityFill(color, velocity) } : undefined}
                    onPointerDown={(event) => pressCell(event, part, cellStep)}
                    onPointerMove={dragCell}
                    onPointerUp={releaseCell}
                    onPointerCancel={releaseCell}
                    aria-label={`${original[part].name}, ${noteLabel(cellStep)}`}
                  />
                );
              })}
            </div>
          );
        })}
        <div ref={editorPlayheadRef} className="jam-editor-playhead" />
      </div>
    </>
  );

  const renderRoll = (gridTrack: GridTrack) => {
    const part = gridTrack.parts[0];
    const color = gridTrack.color;
    const pitches = noteDragRef.current?.part === part && noteDragRef.current.pitches.length
      ? noteDragRef.current.pitches
      : rollPitches(original[part].notes, notes[part]);
    const shown = notes[part].filter((note) => note.step < first + PAGE_STEPS && note.step + note.length > first);
    const starting = shown.filter((note) => note.step >= first);
    const isSelected = (note: JamTrackNote) => selected?.part === part && selected.key === noteKey(note);
    return (
      <>
        {rowsOpen && (
          <div className="jam-editor-heads">
            <div className="jam-editor-corner" />
            <div className="jam-editor-keys">
              {pitches.map((pitch) => (
                <button
                  key={pitch}
                  className={`jam-editor-key ${isBlackKey(pitch) ? 'black' : ''}`}
                  onClick={blurAfter(() => auditionJamPart(track.file, part, pitch))}
                  aria-label={`Play ${noteName(pitch)}`}
                >
                  {pitch % 12 === 0 && noteName(pitch)}
                </button>
              ))}
            </div>
            <div className="jam-editor-velocity-name">Velocity</div>
          </div>
        )}
        <div className="jam-editor-area" ref={areaRef}>
          {ruler}
          <div
            className={`jam-editor-roll ${silent(part) ? 'silent' : ''}`}
            style={{ height: pitches.length * step - CELL_GAP_PX }}
            onPointerDown={(event) => pressRoll(event, part, pitches)}
            onPointerMove={dragNote}
            onPointerUp={releaseNote}
            onPointerCancel={releaseNote}
          >
            {pitches.map((pitch, row) =>
              isBlackKey(pitch) || pitch % 12 === 0 ? (
                <span
                  key={pitch}
                  className={`jam-editor-roll-row ${pitch % 12 === 0 ? 'c' : 'black'}`}
                  style={{ top: row * step, height: cell }}
                />
              ) : null
            )}
            {shown.map((note) => {
              const start = Math.max(note.step, first) - first;
              const end = Math.min(note.step + note.length, first + PAGE_STEPS) - first;
              return (
                <span
                  key={noteKey(note)}
                  className={`jam-editor-note ${isSelected(note) ? 'selected' : ''}`}
                  style={{
                    left: start * step,
                    width: Math.max(4, (end - start) * step - CELL_GAP_PX),
                    top: pitches.indexOf(note.pitch) * step,
                    height: cell,
                    background: velocityColor(color, note.velocity),
                  }}
                />
              );
            })}
          </div>
          <div
            className="jam-editor-velocities"
            onPointerDown={(event) => pressVelocity(event, part)}
            onPointerMove={(event) => dragNote(event)}
            onPointerUp={releaseNote}
            onPointerCancel={releaseNote}
          >
            {starting.map((note) => (
              <span
                key={noteKey(note)}
                className={`jam-editor-velocity ${isSelected(note) ? 'selected' : ''}`}
                style={{
                  left: (note.step - first) * step,
                  width: cell,
                  height: `${(note.velocity / 127) * 100}%`,
                  background: color,
                }}
              />
            ))}
          </div>
          <div ref={editorPlayheadRef} className="jam-editor-playhead" />
        </div>
      </>
    );
  };

  // The timeline's zoom: the playhead stays put, or the view's middle while paused
  const zoomFocus = () => {
    const now = getStep();
    return now === null ? viewStart + viewSpan / 2 : ((now % LOOP_STEPS) + LOOP_STEPS) % LOOP_STEPS;
  };
  const zoomAround = (factor: number) => setView(zoomWindow(viewStart, viewSpan, zoomFocus(), factor));
  // 0 shows the whole loop, 100 a beat
  const zoomLevel = (1 - (viewSpan - MIN_SPAN) / (LOOP_STEPS - MIN_SPAN)) * 100;
  // A 16th's place across the view
  const at = (step16: number) => `${((step16 - viewStart) / viewSpan) * 100}%`;
  // The ruler's marks in view: every bar, and every beat once there is room
  const markEvery = viewSpan <= 32 ? 4 : 16;
  const marks = Array.from({ length: LOOP_STEPS / markEvery }, (_, index) => index * markEvery)
    .filter((mark) => mark >= viewStart - markEvery && mark <= viewStart + viewSpan)
    .map((mark) => {
      const bar = Math.floor(mark / 16) + 1;
      const beat = (mark % 16) / 4 + 1;
      return { at: mark, bar: beat === 1, label: beat === 1 ? `${bar}` : `${bar}.${beat}` };
    });

  return (
    <div className={`jam-grid ${lanesOpen ? '' : 'heads-closed'}`}>
      <div className="jam-grid-head">
        {toolbar}
        <button
          className={`jam-corner-btn ${lanesOpen ? 'on' : ''}`}
          onClick={blurAfter(() => onLanesOpenChange(!lanesOpen))}
          title={lanesOpen ? 'Hide track headers' : 'Show track headers'}
        >
          <LanesIcon />
        </button>
        <button className={`jam-grid-play ${paused ? '' : 'playing'}`} onClick={togglePause} aria-label={paused ? 'Play' : 'Pause'}>
          {paused ? '▶' : '❚❚'}
        </button>
        <div className="jam-grid-zoom">
          <button aria-label="Zoom out tracks" title="Zoom out" onClick={blurAfter(() => zoomAround(1.4))} disabled={viewSpan >= LOOP_STEPS}>
            −
          </button>
          <input
            className="jam-lane-level"
            aria-label="Track zoom"
            type="range"
            min={0}
            max={100}
            step={0.1}
            value={zoomLevel}
            style={{ '--level': `${zoomLevel}%` } as CSSProperties}
            onChange={(event) => {
              const span = Math.max(LOOP_STEPS - (Number(event.target.value) / 100) * (LOOP_STEPS - MIN_SPAN), MIN_SPAN);
              const focus = zoomFocus();
              setView([clamp(focus - span / 2, 0, LOOP_STEPS - span), span]);
            }}
            onPointerUp={(event) => event.currentTarget.blur()}
          />
          <button aria-label="Zoom in tracks" title="Zoom in" onClick={blurAfter(() => zoomAround(0.7))} disabled={viewSpan <= MIN_SPAN}>
            +
          </button>
          <button className="jam-grid-fit" onClick={blurAfter(() => setView([0, LOOP_STEPS]))} disabled={viewSpan >= LOOP_STEPS}>
            Fit
          </button>
        </div>
        {edited && (
          <button className="jam-grid-reset" onClick={blurAfter(onReset)}>
            Reset
          </button>
        )}
      </div>

      <div className="jam-timeline" ref={timelineRef}>
        {/* Bar (or, zoomed in, beat) lines behind the clips */}
        <div className="jam-timeline-lines">
          {marks.map((mark) => (
            <span key={mark.at} className={mark.bar ? 'bar' : undefined} style={{ left: at(mark.at) }} />
          ))}
        </div>
        <div className="jam-timeline-row jam-timeline-ruler">
          <div className="jam-timeline-head" />
          <div className="jam-timeline-bars">
            {open && (
              <span
                className="jam-timeline-page"
                style={{ left: at(first), width: `${(PAGE_STEPS / viewSpan) * 100}%` }}
              />
            )}
            {marks.map((mark) => (
              <span key={mark.at} className={`jam-timeline-mark ${mark.bar ? 'bar' : ''}`} style={{ left: at(mark.at) }}>
                {mark.label}
              </span>
            ))}
          </div>
        </div>
        {tracks.map((gridTrack) => {
          const solo = gridTrack.parts.every((part) => mix.solos[part]);
          const mute = gridTrack.parts.every((part) => mix.mutes[part]);
          const level = Math.max(...gridTrack.parts.map((part) => mix.levels[part]));
          return (
            <div
              key={gridTrack.id}
              className={`jam-timeline-row ${open?.id === gridTrack.id ? 'open' : ''}`}
              style={{ '--track-color': gridTrack.color } as CSSProperties}>
              <div className="jam-timeline-head">
                {lanesOpen && (
                  <JamLaneStrip
                    name={gridTrack.name}
                    tag=""
                    solo={solo}
                    mute={mute}
                    level={level}
                    onSolo={() => setMixOf(gridTrack.parts, 'solos', !solo)}
                    onMute={() => setMixOf(gridTrack.parts, 'mutes', !mute)}
                    onLevel={(next) => setMixOf(gridTrack.parts, 'levels', next)}
                  />
                )}
              </div>
              <div className="jam-timeline-lane">
                <button
                  className={`jam-timeline-clip ${open?.id === gridTrack.id ? 'open' : ''} ${
                    gridTrack.parts.every(silent) ? 'silent' : ''
                  }`}
                  onClick={blurAfter(() => {
                    setOpenId(gridTrack.id);
                    setSelected(null);
                  })}
                  aria-label={`Edit ${gridTrack.name}`}
                  style={{ left: at(0), width: `${(LOOP_STEPS / viewSpan) * 100}%` }}
                >
                  <svg viewBox={`0 0 ${LOOP_STEPS} ${previewRows(gridTrack)}`} preserveAspectRatio="none" aria-hidden="true">
                    {renderPreview(gridTrack)}
                  </svg>
                </button>
              </div>
            </div>
          );
        })}
        <div className="jam-timeline-overlay">
          <div ref={timelinePlayheadRef} className="jam-timeline-playhead" />
        </div>
      </div>

      {open && (
        <section
          className={`jam-editor ${rowsOpen ? '' : 'heads-closed'}`}
          style={{ '--track-color': open.color, '--cell': `${cell}px` } as CSSProperties}
        >
          <div className="jam-editor-top">
            <button
              className={`jam-editor-icon-btn ${rowsOpen ? 'on' : ''}`}
              onClick={blurAfter(() => setRowsOpen(!rowsOpen))}
              title={rowsOpen ? 'Hide row headers' : 'Show row headers'}
            >
              <LanesIcon />
            </button>
            <span className="jam-editor-dot" />
            <span className="jam-editor-name">{open.name}</span>
            <div className="jam-grid-sections">
              <button className={pinned === null ? 'active' : ''} onClick={blurAfter(() => setPinned(null))}>
                Auto
              </button>
              {Array.from({ length: PAGES }, (_, index) => (
                <button
                  key={index}
                  className={`${pinned === index ? 'active' : ''} ${playing === index ? 'playing' : ''}`}
                  onClick={blurAfter(() => setPinned(index))}
                >
                  {index * PAGE_BARS + 1}–{(index + 1) * PAGE_BARS}
                </button>
              ))}
            </div>
            {selected && (
              <button className="jam-editor-icon-btn" onClick={blurAfter(removeSelected)} aria-label="Delete note" title="Delete note">
                <TrashIcon />
              </button>
            )}
            <button
              className="jam-editor-icon-btn jam-editor-close"
              onClick={blurAfter(() => {
                setOpenId(null);
                setSelected(null);
              })}
              aria-label="Close"
              title="Close"
            >
              &times;
            </button>
          </div>
          <div className="jam-editor-body">
            <div className="jam-editor-content">{open.kind === 'drum' ? renderDrums(open) : renderRoll(open)}</div>
          </div>
        </section>
      )}
    </div>
  );
}

// A 16th's place in the loop, as bar.beat.16th
function noteLabel(at: number): string {
  return `${Math.floor(at / 16) + 1}.${(Math.floor(at / 4) % 4) + 1}.${(at % 4) + 1}`;
}
