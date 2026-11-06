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
import { JAM_DAW_MAX_BPM, JAM_DAW_MIN_BPM, JAM_MAX_BARS, JAM_SECTION_BARS, jamTrackParts, type JamTrack, type JamTrackNote, type JamTrackPart } from './jamTracks';
import type { JamTrackMix } from './jamBackingMixer';
import { JamLaneStrip } from './JamLaneStrip';
import { auditionJamPart } from './jamAudition';
import {
  jamAddedInstrument,
  jamAddedIsDrum,
  jamAddedPartName,
  jamAddedTrackName,
  jamNewAddedParts,
  type JamAddedPart,
} from './jamAddedParts';
import TrackZoom from '../../../../../../instrument-lab/client/TrackZoom.jsx';
import { zoomWindow } from '../../../../../../instrument-lab/client/timeline.mjs';
import { CollapseIcon, ExpandIcon, InstrumentsIcon, LanesIcon } from './JamIcons';
import { SOUND_COLORS } from '../../styles/palette';
import './JamTrackGrid.css';

// What a new track starts with, before its instrument is chosen: the first
// synth sound, or the Groove kit (16 pads)
const NEW_INSTRUMENT = 'square-stab';
const NEW_KIT = 'groove-kit';

// The Jam tab's backing track as tracks and clips, like a DAW's timeline: the
// drums as one track, every other part as its own, each a clip over the whole
// loop. Clicking a clip opens it below, four bars at a time in square 16ths:
// the drums as a step grid with a row per sound, where clicking a cell adds
// or removes a hit and dragging one up or down sets its velocity; a part as a
// piano roll, where clicking adds a note, dragging moves it or its end, and
// the strip under it sets velocities. The page follows the playhead unless
// one is picked.

// The editor's page: a section of the track, its bars in 16ths
const PAGE_BARS = JAM_SECTION_BARS;
const PAGE_STEPS = PAGE_BARS * 16;
// A drum track's grid is at least this many rows tall
const MIN_DRUM_ROWS = 8;
const NEW_VELOCITY = 127; // a new hit or note: full velocity, a fully coloured square
// A press moving less than this (px) is a click
const DRAG_SLOP_PX = 4;
// Cells are square and this far apart; below MIN_CELL_PX the editor scrolls sideways instead
const CELL_GAP_PX = 2;
const MIN_CELL_PX = 10;
const EDGE_PX = 6; // a note's ends this wide (at most a third of it) drag its start or its end
const ROLL_MARGIN = 2; // semitones shown past a part's lowest and highest notes
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const noteName = (pitch: number) => `${NOTE_NAMES[pitch % 12]}${Math.floor(pitch / 12) - 1}`;
const isBlackKey = (pitch: number) => [1, 3, 6, 8, 10].includes(pitch % 12);
const partColor = (part: number) => SOUND_COLORS[part % SOUND_COLORS.length];
const noteKey = (note: JamTrackNote) => `${note.step}|${note.pitch}`;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

// The timeline's zoom, as Instrument Lab's tracks: it shows `span` 16ths
// from `start`, never fewer than a beat
const MIN_SPAN = 4;
// A pinch zooms as far as it moves: a trackpad's many small steps zoom
// smoothly, a mouse wheel's notch (capped) by about a half
const wheelZoom = (deltaY: number) => Math.exp(clamp(deltaY, -50, 50) * 0.008);

// A note's color, brighter the louder it is (solid, over the panel)
const velocityColor = (color: string, velocity: number) =>
  `color-mix(in srgb, ${color} ${Math.round(35 + (velocity / 127) * 65)}%, var(--ds-panel))`;

// One row of the timeline: the track's drums together, one of its parts, or
// a track added in the grid (`added`: its id; a kit's parts together)
interface GridTrack {
  id: string;
  name: string;
  kind: 'drum' | 'notes';
  parts: number[];
  color: string;
  added?: string;
}

function gridTracks(own: JamTrackPart[], added: JamAddedPart[]): GridTrack[] {
  const drums = own.flatMap((part, index) => (part.kind === 'drum' ? [index] : []));
  const addedTracks: GridTrack[] = [];
  added.forEach((part, index) => {
    const at = own.length + index;
    const existing = addedTracks.find((candidate) => candidate.added === part.track);
    if (existing) existing.parts.push(at);
    else
      addedTracks.push({
        id: `added-${part.track}`,
        name: jamAddedTrackName(part),
        kind: jamAddedIsDrum(part) ? 'drum' : 'notes',
        parts: [at],
        color: partColor(at),
        added: part.track,
      });
  });
  return [
    ...(drums.length ? [{ id: 'drums', name: 'Drums', kind: 'drum' as const, parts: drums, color: partColor(drums[0]) }] : []),
    ...own.flatMap((part, index) =>
      part.kind === 'notes' ? [{ id: `part-${index}`, name: part.name, kind: 'notes' as const, parts: [index], color: partColor(index) }] : []
    ),
    ...addedTracks,
  ];
}

// The pitches a part's roll shows, highest first: the part's own notes with a
// little room around them, and any note put beyond (notes put in that room
// leave the rows as they are)
function rollPitches(original: JamTrackNote[], notes: JamTrackNote[], least = 0): number[] {
  // A part with no notes of its own (an added one) shows two octaves around middle C
  const own = original.length ? original.map((note) => note.pitch) : [50, 70];
  const put = notes.map((note) => note.pitch);
  let low = Math.max(0, Math.min(Math.min(...own) - ROLL_MARGIN, ...put));
  let high = Math.min(127, Math.max(Math.max(...own) + ROLL_MARGIN, ...put));
  // A taller editor shows more pitches, above and below in turn
  while (high - low + 1 < least && (low > 0 || high < 127)) {
    if (high < 127) high++;
    if (high - low + 1 < least && low > 0) low--;
  }
  return Array.from({ length: high - low + 1 }, (_, index) => high - index);
}

interface JamTrackGridProps {
  track: JamTrack;
  // The track's notes, one list per part (drums first, as jamTrackParts orders
  // them, then the parts added here, played by `added`)
  notes: JamTrackNote[][];
  added: JamAddedPart[];
  mix: JamTrackMix;
  // Buttons shown first in the header (back, the sidebar's)
  toolbar?: ReactNode;
  // The track headers shown, or folded away
  lanesOpen: boolean;
  onLanesOpenChange: (open: boolean) => void;
  edited: boolean;
  paused: boolean;
  // The track's length in bars (its own 8, or more with sections added)
  bars: number;
  onChange: (notes: JamTrackNote[][], added: JamAddedPart[], bars: number) => void;
  onMixChange: (mix: JamTrackMix) => void;
  onReset: () => void;
  onTogglePause: () => void;
  // 16ths since the backing track started, or null while it is not playing
  getStep: () => number | null;
  // The song's tempo, when it can be changed here (a Daw song)
  tempo?: number;
  onTempoChange?: (bpm: number) => void;
  // The instrument each track plays, by its key (see jamTrackInstruments.ts):
  // its name and a kit's pads' names; none for a track of the song's own
  // playing its original sound
  trackSounds: Record<string, { name: string; pads?: string[] }>;
  // Opens a track's instruments
  onTrackInstrument: (key: string) => void;
  // One note of a part played by its live instrument; false for a part played
  // by its original sound
  onLiveAudition: (part: number, pitch: number) => boolean;
}

// One row of the editor: a pitch of an instrument, or a drum of a kit (its
// part, played at its pitch); null for the empty rows under a short kit
type GridRow = { part: number; pitch: number } | null;

// Dragging a note: where it was, which part of it was pressed (its start, its
// end, its middle, or its bar in the velocity strip), the rows as they were
// when the drag began, and whether it has moved (a click on a note removes it)
interface NoteDrag {
  part: number;
  mode: 'move' | 'start' | 'length' | 'velocity';
  from: JamTrackNote;
  key: string;
  startX: number;
  startY: number;
  rows: GridRow[];
  moved: boolean;
  added: boolean;
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

// The song's tempo: its value follows the slider while it moves, and the
// song changes tempo once it is let go (each change renders the track again)
function TempoControl({ tempo, onChange }: { tempo: number; onChange: (bpm: number) => void }) {
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? tempo;
  const commit = () => {
    if (draft !== null && draft !== tempo) onChange(draft);
    setDraft(null);
  };
  return (
    <label className="jam-grid-tempo">
      <input
        type="range"
        min={JAM_DAW_MIN_BPM}
        max={JAM_DAW_MAX_BPM}
        step={1}
        value={shown}
        aria-label="Tempo"
        onChange={(event) => setDraft(Number(event.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <span className="jam-grid-tempo-value">{shown}</span>
      <span className="jam-grid-tempo-unit">BPM</span>
    </label>
  );
}

export function JamTrackGrid({
  track,
  notes,
  added,
  bars,
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
  tempo,
  onTempoChange,
  trackSounds,
  onTrackInstrument,
  onLiveAudition,
}: JamTrackGridProps) {
  const own = useMemo(() => jamTrackParts(track), [track]);
  // Every part: the track's own, then the ones added here (no notes of their own)
  const original = useMemo(
    () => [
      ...own,
      ...added.map((part): JamTrackPart => {
        const sound = trackSounds[`added-${part.track}`];
        const name =
          part.drum !== undefined && sound?.pads?.length
            ? sound.pads[part.drum % sound.pads.length]
            : (sound?.name ?? jamAddedPartName(part));
        return { name, kind: jamAddedIsDrum(part) ? 'drum' : 'notes', notes: [] };
      }),
    ],
    [own, added, trackSounds]
  );
  const tracks = useMemo(
    () => gridTracks(own, added).map((gridTrack) => (gridTrack.added && trackSounds[gridTrack.id] ? { ...gridTrack, name: trackSounds[gridTrack.id].name } : gridTrack)),
    [own, added, trackSounds]
  );
  const addedAt = (part: number) => (part < own.length ? undefined : added[part - own.length]);
  // A part's sound on one pitch, an added part's from its instrument
  const audition = (part: number, pitch: number) => {
    if (onLiveAudition(part, pitch)) return;
    const addedPart = addedAt(part);
    const instrument = addedPart && jamAddedInstrument(addedPart);
    if (addedPart && !instrument) return;
    auditionJamPart(
      track.file,
      part,
      pitch,
      addedPart && instrument ? { id: `${addedPart.sound}:${addedPart.drum ?? ''}`, instrument } : undefined
    );
  };
  const [openId, setOpenId] = useState<string | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  const [playing, setPlaying] = useState(0);
  const [selected, setSelected] = useState<{ part: number; key: string } | null>(null);
  // The editor's row headers (each drum's controls, the piano keys) shown, or folded away (at first)
  const [rowsOpen, setRowsOpen] = useState(false);
  // The sounds to add a track with, shown
  const [adding, setAdding] = useState(false);
  const [cell, setCell] = useState(MIN_CELL_PX);
  // The timeline's view: from `start`, `span` 16ths of the loop
  // The loop: the track's bars, its own 8 or more sections added here
  const LOOP_STEPS = bars * 16;
  const loopRef = useRef(LOOP_STEPS);
  loopRef.current = LOOP_STEPS;
  const [view, setView] = useState<[number, number]>([0, LOOP_STEPS]);
  const [viewStart, viewSpan] = view;
  const timelineRef = useRef<HTMLDivElement>(null);
  // The editor's height once dragged taller (or shorter) by its grip, else its own
  const [editorHeight, setEditorHeight] = useState<number | null>(null);
  // The editor over the whole height, the tracks down to a few rows
  const [expanded, setExpanded] = useState(false);
  const editorRef = useRef<HTMLElement>(null);
  const resizeRef = useRef<{ startY: number; from: number; min: number; max: number } | null>(null);
  const timelinePlayheadRef = useRef<HTMLDivElement>(null);
  const editorPlayheadRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  // The editor's scrolling body, measured: a taller editor shows more rows
  const bodyRef = useRef<HTMLDivElement>(null);
  const [bodyHeight, setBodyHeight] = useState(0);
  const noteDragRef = useRef<NoteDrag | null>(null);
  const open = tracks.find((candidate) => candidate.id === openId) ?? null;
  const page = pinned ?? playing;
  const PAGES = bars / PAGE_BARS;
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

  // A longer loop: a view of the whole loop grows with it, a closer one stays put
  const viewLoopRef = useRef(LOOP_STEPS);
  useEffect(() => {
    const before = viewLoopRef.current;
    viewLoopRef.current = LOOP_STEPS;
    setView(([start, span]) => (span >= before ? [0, LOOP_STEPS] : [clamp(start, 0, LOOP_STEPS - span), span]));
  }, [LOOP_STEPS]);

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
          zoomWindow(start, span, loopRef.current, start + clamp((event.clientX - rect.left) / rect.width, 0, 1) * span, wheelZoom(event.deltaY), MIN_SPAN)
        );
        return;
      }
      const delta = event.deltaX || (event.shiftKey ? event.deltaY : 0);
      if (!delta) return;
      event.preventDefault();
      const pixels = delta * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.width : 1);
      setView(([start, span]) => [clamp(start + (pixels * span) / rect.width, 0, loopRef.current - span), span]);
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

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const measure = () => setBodyHeight(body.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body);
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
  }, [getStep, page, LOOP_STEPS]);

  const setPart = (part: number, next: JamTrackNote[]) =>
    onChange(
      notes.map((current, p) => (p === part ? [...next].sort((a, b) => a.step - b.step || a.pitch - b.pitch) : current)),
      added,
      bars
    );

  // A section taken out of every track: its notes go (a note running into it
  // stops where it starts) and the bars after it move back
  const removeSection = (section: number) => {
    const from = section * PAGE_STEPS;
    const to = from + PAGE_STEPS;
    onChange(
      notes.map((part) =>
        part.flatMap((note) => {
          if (note.step >= to) return [{ ...note, step: note.step - PAGE_STEPS }];
          if (note.step >= from) return [];
          return [{ ...note, length: Math.min(note.length, from - note.step) }];
        })
      ),
      added,
      bars - PAGE_BARS
    );
    setPinned(null);
    setSelected(null);
  };

  // A section more at the end, silent, shown in the editor
  const addSection = () => {
    onChange(notes, added, bars + PAGE_BARS);
    setPinned(bars / PAGE_BARS);
  };

  // A new track: an instrument's part or a kit's (one per pad) after the
  // others, empty, its editor open and its instruments to choose from
  const addTrack = (kind: 'notes' | 'drum') => {
    const id = Date.now().toString(36);
    const parts = jamNewAddedParts(kind === 'drum' ? NEW_KIT : NEW_INSTRUMENT, id);
    if (!parts.length) return;
    onChange([...notes, ...parts.map(() => [])], [...added, ...parts], bars);
    setAdding(false);
    setOpenId(`added-${id}`);
    setPinned(null);
    setSelected(null);
    onTrackInstrument(`added-${id}`);
  };

  // An added track taken out, with its notes and its mix
  const removeTrack = (gridTrack: GridTrack) => {
    const keep = (_: unknown, part: number) => !gridTrack.parts.includes(part);
    onChange(notes.filter(keep), added.filter((_, index) => keep(null, own.length + index)), bars);
    onMixChange({ levels: mix.levels.filter(keep), mutes: mix.mutes.filter(keep), solos: mix.solos.filter(keep) });
    setOpenId(null);
    setSelected(null);
  };

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

  // The grid: pressing on a note drags its start or its end (near them) or
  // the whole note, and a click on it (no drag) removes it; pressing on an
  // empty spot adds a 16th note there, whose end the drag then draws out
  // What a press at this point of the grid does: add a note on its row, or
  // move the note under it, or drag its start or its end; null off the rows
  const gridHit = (event: ReactPointerEvent<HTMLDivElement>, rows: GridRow[]) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const at = first + x / step;
    const row = rows[clamp(Math.floor((event.clientY - rect.top) / step), 0, rows.length - 1)];
    if (!row) return null;
    const under = notes[row.part].find((note) => note.pitch === row.pitch && note.step <= at && note.step + note.length > at);
    if (!under) return { row, at, under, mode: 'add' as const };
    const left = (Math.max(under.step, first) - first) * step;
    const right = (Math.min(under.step + under.length, first + PAGE_STEPS) - first) * step - CELL_GAP_PX;
    const edge = Math.min(EDGE_PX, (right - left) / 3);
    const mode: NoteDrag['mode'] = x - left <= edge && under.step >= first ? 'start' : right - x <= edge ? 'length' : 'move';
    return { row, at, under, mode };
  };

  // The pointer shows what a press does there, and what a drag is doing
  const DRAG_CURSORS: Record<NoteDrag['mode'], string> = {
    move: 'grabbing',
    start: 'ew-resize',
    length: 'ew-resize',
    velocity: 'ns-resize',
  };
  const HOVER_CURSORS: Record<'add' | NoteDrag['mode'], string> = {
    add: 'copy',
    move: 'grab',
    start: 'ew-resize',
    length: 'ew-resize',
    velocity: 'ns-resize',
  };
  const hoverGrid = (event: ReactPointerEvent<HTMLDivElement>, rows: GridRow[]) => {
    if (noteDragRef.current) return;
    const hit = gridHit(event, rows);
    event.currentTarget.style.cursor = hit ? HOVER_CURSORS[hit.mode] : 'default';
  };

  const pressGrid = (event: ReactPointerEvent<HTMLDivElement>, rows: GridRow[]) => {
    const hit = gridHit(event, rows);
    if (!hit) return;
    const { part, pitch } = hit.row;
    const { at, under } = hit;
    event.currentTarget.setPointerCapture(event.pointerId);
    let note = under;
    // A new note is stretched by dragging, like a note's end
    const mode: NoteDrag['mode'] = hit.mode === 'add' ? 'length' : hit.mode;
    if (!under) {
      note = { pitch, step: clamp(Math.floor(at), first, first + PAGE_STEPS - 1), length: 1, velocity: NEW_VELOCITY };
      setPart(part, [...notes[part], note]);
      audition(part, pitch);
    }
    noteDragRef.current = {
      part,
      mode,
      from: note!,
      key: noteKey(note!),
      startX: event.clientX,
      startY: event.clientY,
      rows,
      moved: false,
      added: !under,
    };
    event.currentTarget.style.cursor = DRAG_CURSORS[mode];
    setSelected({ part, key: noteKey(note!) });
  };

  // The velocity strip: pressing on a note's bar sets its velocity to that height
  const notesStartingAt = (event: ReactPointerEvent<HTMLDivElement>, part: number) => {
    const column = first + Math.floor((event.clientX - event.currentTarget.getBoundingClientRect().left) / step);
    return notes[part].filter((note) => Math.floor(note.step) === column);
  };
  const hoverVelocity = (event: ReactPointerEvent<HTMLDivElement>, part: number) => {
    if (!noteDragRef.current) event.currentTarget.style.cursor = notesStartingAt(event, part).length ? 'ns-resize' : 'default';
  };
  const pressVelocity = (event: ReactPointerEvent<HTMLDivElement>, part: number) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const starting = notesStartingAt(event, part);
    const note = starting.find((candidate) => selected?.part === part && noteKey(candidate) === selected.key) ?? starting[0];
    if (!note) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    noteDragRef.current = {
      part,
      mode: 'velocity',
      from: note,
      key: noteKey(note),
      startX: event.clientX,
      startY: rect.top,
      rows: [],
      moved: true,
      added: false,
    };
    setSelected({ part, key: noteKey(note) });
    dragNote(event, rect.height);
  };

  const dragNote = (event: ReactPointerEvent<HTMLDivElement>, stripHeight = 0) => {
    const current = noteDragRef.current;
    if (!current) return;
    const { from, part } = current;
    if (!current.moved && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < DRAG_SLOP_PX) return;
    current.moved = true;
    let next: JamTrackNote;
    if (current.mode === 'velocity') {
      const height = stripHeight || event.currentTarget.getBoundingClientRect().height;
      next = { ...from, velocity: Math.round(clamp((1 - (event.clientY - current.startY) / height) * 127, 1, 127)) };
    } else {
      const steps = Math.round((event.clientX - current.startX) / step);
      const end = Math.round(from.step + from.length);
      if (current.mode === 'length') {
        next = { ...from, length: clamp(end + steps, Math.floor(from.step) + 1, LOOP_STEPS) - from.step };
      } else if (current.mode === 'start') {
        const start = clamp(from.step + steps, first, end - 1);
        next = { ...from, step: start, length: end - start };
      } else {
        // Up or down to another pitch of the same part (a kit's drums stay on their row)
        const at = current.rows.findIndex((row) => row?.part === part && row.pitch === from.pitch);
        const target = current.rows[clamp(at + Math.round((event.clientY - current.startY) / step), 0, current.rows.length - 1)];
        const pitch = target && target.part === part ? target.pitch : from.pitch;
        next = { ...from, step: clamp(from.step + steps, first, first + PAGE_STEPS - 1), pitch };
      }
    }
    const key = noteKey(next);
    const others = notes[part].filter((note) => noteKey(note) !== current.key);
    // Never onto another note's place
    if (key !== current.key && others.some((note) => noteKey(note) === key)) return;
    const now = notes[part].find((note) => noteKey(note) === current.key);
    if (now && now.step === next.step && now.pitch === next.pitch && now.length === next.length && now.velocity === next.velocity) return;
    if (current.mode === 'move' && next.pitch !== now?.pitch) audition(part, next.pitch);
    current.key = key;
    setPart(part, [...others, next]);
    setSelected({ part, key });
  };

  const releaseNote = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.style.cursor = '';
    const current = noteDragRef.current;
    noteDragRef.current = null;
    if (!current || current.moved || current.added || current.mode === 'velocity') return;
    setPart(current.part, notes[current.part].filter((note) => noteKey(note) !== current.key));
    setSelected(null);
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

  // A track's clips: one per run of sections that have notes, from its first 16th to past its last
  const clipRuns = (gridTrack: GridTrack): [number, number][] => {
    const filled = Array.from({ length: PAGES }, (_, section) =>
      gridTrack.parts.some((part) =>
        notes[part].some((note) => note.step < (section + 1) * PAGE_STEPS && note.step + note.length > section * PAGE_STEPS)
      )
    );
    const runs: [number, number][] = [];
    filled.forEach((has, section) => {
      if (!has) return;
      const last = runs[runs.length - 1];
      if (last && last[1] === section * PAGE_STEPS) last[1] += PAGE_STEPS;
      else runs.push([section * PAGE_STEPS, (section + 1) * PAGE_STEPS]);
    });
    return runs;
  };

  // The editor's top edge: its height follows the pointer, between a short
  // editor and the tracks keeping their least height
  const TIMELINE_MIN_PX = 112;
  const EDITOR_MIN_PX = 150;
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const editor = editorRef.current;
    const timeline = timelineRef.current;
    if (!editor || !timeline) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setExpanded(false);
    const from = editor.getBoundingClientRect().height;
    resizeRef.current = {
      startY: event.clientY,
      from,
      min: EDITOR_MIN_PX,
      max: from + Math.max(0, timeline.getBoundingClientRect().height - TIMELINE_MIN_PX),
    };
  };
  const resize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = resizeRef.current;
    if (!current) return;
    setEditorHeight(clamp(current.from + (current.startY - event.clientY), current.min, Math.max(current.min, current.max)));
  };
  const endResize = () => {
    resizeRef.current = null;
  };

  // A track's editor, at the section clicked on its lane; the open track's lane closes it
  const openAt = (gridTrack: GridTrack, event: ReactMouseEvent<HTMLElement>) => {
    event.currentTarget.blur();
    if (open?.id === gridTrack.id) {
      setOpenId(null);
      setSelected(null);
      return;
    }
    const lane = event.currentTarget.closest('.jam-timeline-lane')!.getBoundingClientRect();
    const at = viewStart + clamp((event.clientX - lane.left) / lane.width, 0, 1) * viewSpan;
    setOpenId(gridTrack.id);
    setPinned(clamp(Math.floor(at / PAGE_STEPS), 0, PAGES - 1));
    setSelected(null);
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

  // The editor's grid, the same for a kit and an instrument: a row per drum
  // (each its own part) or per pitch, square 16ths, notes with their start
  // and end to drag, and their velocities in a strip under them. It shows as
  // many rows as fit its height (at least MIN_DRUM_ROWS for a kit).
  const renderGrid = (gridTrack: GridTrack) => {
    const color = gridTrack.color;
    const drum = gridTrack.kind === 'drum';
    // Rows that fit: the body's height less the ruler, the velocity strip and the gaps
    const fit = Math.max(0, Math.floor((bodyHeight - 26 - 48 - 16 + CELL_GAP_PX) / step));
    const drumPitch = (part: number) => notes[part][0]?.pitch ?? original[part].notes[0]?.pitch ?? 0;
    const rows: GridRow[] = noteDragRef.current?.rows.length
      ? noteDragRef.current.rows
      : drum
        ? [
            ...gridTrack.parts.map((part) => ({ part, pitch: drumPitch(part) })),
            ...Array.from({ length: Math.max(0, Math.max(MIN_DRUM_ROWS, fit) - gridTrack.parts.length) }, () => null),
          ]
        : rollPitches(original[gridTrack.parts[0]].notes, notes[gridTrack.parts[0]], fit).map((pitch) => ({
            part: gridTrack.parts[0],
            pitch,
          }));
    const onPage = (note: JamTrackNote) => note.step < first + PAGE_STEPS && note.step + note.length > first;
    const isSelected = (part: number, note: JamTrackNote) => selected?.part === part && selected.key === noteKey(note);
    // The velocity strip shows the selected note's row (a kit's first drum at first)
    const stripPart = selected && gridTrack.parts.includes(selected.part) ? selected.part : gridTrack.parts[0];
    return (
      <>
        {rowsOpen && (
          <div className="jam-editor-heads">
            <div className="jam-editor-corner" />
            <div className="jam-editor-keys">
              {rows.map((row, index) =>
                !row ? (
                  <div key={`empty-${index}`} className="jam-editor-head" />
                ) : drum ? (
                  <div key={row.part} className="jam-editor-head">
                    <JamLaneStrip
                      name={original[row.part].name}
                      tag=""
                      solo={mix.solos[row.part]}
                      mute={mix.mutes[row.part]}
                      level={mix.levels[row.part]}
                      onNameClick={() => audition(row.part, row.pitch)}
                      onSolo={() => setMixOf([row.part], 'solos', !mix.solos[row.part])}
                      onMute={() => setMixOf([row.part], 'mutes', !mix.mutes[row.part])}
                      onLevel={(level) => setMixOf([row.part], 'levels', level)}
                    />
                  </div>
                ) : (
                  <button
                    key={row.pitch}
                    className={`jam-editor-key ${isBlackKey(row.pitch) ? 'black' : ''}`}
                    onClick={blurAfter(() => audition(row.part, row.pitch))}
                    aria-label={`Play ${noteName(row.pitch)}`}
                  >
                    {row.pitch % 12 === 0 && noteName(row.pitch)}
                  </button>
                )
              )}
            </div>
            <div className="jam-editor-velocity-name">Velocity</div>
          </div>
        )}
        <div className="jam-editor-area" ref={areaRef}>
          {ruler}
          <div
            className={`jam-editor-roll ${!drum && silent(gridTrack.parts[0]) ? 'silent' : ''}`}
            style={{ height: rows.length * step - CELL_GAP_PX }}
            onPointerDown={(event) => pressGrid(event, rows)}
            onPointerMove={(event) => {
              dragNote(event);
              hoverGrid(event, rows);
            }}
            onPointerUp={(event) => {
              releaseNote(event);
              hoverGrid(event, rows);
            }}
            onPointerCancel={releaseNote}
          >
            {rows.map((row, index) => {
              const band = !row ? 'empty' : drum && silent(row.part) ? 'silent' : null;
              return band ? (
                <span key={index} className={`jam-editor-roll-row ${band}`} style={{ top: index * step, height: cell }} />
              ) : null;
            })}
            {rows.flatMap((row, index) =>
              !row
                ? []
                : notes[row.part]
                    .filter((note) => note.pitch === row.pitch && onPage(note))
                    .map((note) => {
                      const start = Math.max(note.step, first) - first;
                      const end = Math.min(note.step + note.length, first + PAGE_STEPS) - first;
                      return (
                        <span
                          key={`${row.part}|${noteKey(note)}`}
                          className={`jam-editor-note ${isSelected(row.part, note) ? 'selected' : ''} ${
                            drum && silent(row.part) ? 'silent' : ''
                          }`}
                          style={{
                            left: start * step,
                            width: Math.max(4, (end - start) * step - CELL_GAP_PX),
                            top: index * step,
                            height: cell,
                            background: velocityColor(color, note.velocity),
                          }}
                        >
                          {note.step >= first && <i className="jam-editor-note-edge start" />}
                          <i className="jam-editor-note-edge end" />
                        </span>
                      );
                    })
            )}
          </div>
          <div
            className="jam-editor-velocities"
            onPointerDown={(event) => pressVelocity(event, stripPart)}
            onPointerMove={(event) => {
              dragNote(event);
              hoverVelocity(event, stripPart);
            }}
            onPointerUp={(event) => {
              releaseNote(event);
              hoverVelocity(event, stripPart);
            }}
            onPointerCancel={releaseNote}
          >
            {notes[stripPart]
              .filter((note) => note.step >= first && onPage(note))
              .map((note) => (
                <span
                  key={noteKey(note)}
                  className={`jam-editor-velocity ${isSelected(stripPart, note) ? 'selected' : ''}`}
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
    <div
      className={`jam-grid ${lanesOpen ? '' : 'heads-closed'} ${open && expanded ? 'editor-expanded' : ''} ${
        open && !expanded && editorHeight !== null ? 'editor-sized' : ''
      }`}
    >
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
        {tempo !== undefined && onTempoChange && <TempoControl tempo={tempo} onChange={onTempoChange} />}
        <TrackZoom view={view} duration={LOOP_STEPS} focus={zoomFocus()} minSpan={MIN_SPAN} onView={setView} />
        {edited && (
          <button className="jam-grid-reset" onClick={blurAfter(onReset)}>
            Reset
          </button>
        )}
      </div>

      <div className={`jam-timeline ${tracks.length ? '' : 'empty'}`} ref={timelineRef}>
        {/* The ruler and the tracks, with their bar lines and playhead; Add track is under them */}
        <div className="jam-timeline-tracks">
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
                    onNameClick={() => onTrackInstrument(gridTrack.id)}
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
                {/* Empty sections are only the lane: pressing anywhere on it opens the track there */}
                <button className="jam-timeline-lane-hit" onClick={(event) => openAt(gridTrack, event)} aria-label={`Edit ${gridTrack.name}`} />
                {clipRuns(gridTrack).map(([from, to]) => (
                  <button
                    key={from}
                    className={`jam-timeline-clip ${open?.id === gridTrack.id ? 'open' : ''} ${
                      gridTrack.parts.every(silent) ? 'silent' : ''
                    }`}
                    onClick={(event) => openAt(gridTrack, event)}
                    tabIndex={-1}
                    style={{ left: at(from), width: `${((to - from) / viewSpan) * 100}%` }}
                  >
                    <svg viewBox={`${from} 0 ${to - from} ${previewRows(gridTrack)}`} preserveAspectRatio="none" aria-hidden="true">
                      {renderPreview(gridTrack)}
                    </svg>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        <div className="jam-timeline-overlay">
          <div ref={timelinePlayheadRef} className="jam-timeline-playhead" />
        </div>
        </div>
        <div className="jam-timeline-add">
          <button
            className={`jam-timeline-add-btn ${adding ? 'on' : ''}`}
            onClick={blurAfter(() => setAdding(!adding))}
            aria-expanded={adding}
          >
            <span className="jam-timeline-add-icon">
              <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </span>
            Add track
          </button>
          {adding && (
            <div className="jam-timeline-add-sounds">
              <div className="jam-timeline-add-options">
                <button onClick={blurAfter(() => addTrack('notes'))}>Instrument</button>
                <button onClick={blurAfter(() => addTrack('drum'))}>Drums</button>
              </div>
            </div>
          )}
        </div>
      </div>

      {open && (
        <section
          ref={editorRef}
          className={`jam-editor ${rowsOpen ? '' : 'heads-closed'} ${editorHeight === null || expanded ? '' : 'sized'}`}
          style={
            {
              '--track-color': open.color,
              '--cell': `${cell}px`,
              '--steps': PAGE_STEPS,
              '--beats': PAGE_STEPS / 4,
              ...(editorHeight === null || expanded ? {} : { height: editorHeight }),
            } as CSSProperties
          }
        >
          {/* Its top edge, dragged up, grows the editor over the tracks' space (they keep a few rows) */}
          <div
            className="jam-editor-edge"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize the editor"
            onPointerDown={startResize}
            onPointerMove={resize}
            onPointerUp={endResize}
            onPointerCancel={endResize}
          />
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
            <button className="jam-editor-instrument" onClick={blurAfter(() => onTrackInstrument(open.id))}>
              <InstrumentsIcon />
              {trackSounds[open.id]?.name ?? 'Original'}
            </button>
            <div className="jam-grid-sections">
              <button className={pinned === null ? 'active' : ''} onClick={blurAfter(() => setPinned(null))}>
                Auto
              </button>
              {Array.from({ length: PAGES }, (_, index) => (
                <span key={index} className="jam-grid-section">
                  <button
                    className={`${pinned === index ? 'active' : ''} ${playing === index ? 'playing' : ''}`}
                    onClick={blurAfter(() => setPinned(index))}
                  >
                    {index * PAGE_BARS + 1}–{(index + 1) * PAGE_BARS}
                  </button>
                  {PAGES > 1 && (
                    <button
                      className="jam-grid-section-remove"
                      onClick={blurAfter(() => removeSection(index))}
                      aria-label={`Delete bars ${index * PAGE_BARS + 1}–${(index + 1) * PAGE_BARS}`}
                      title="Delete these bars"
                    >
                      ×
                    </button>
                  )}
                </span>
              ))}
              {bars < JAM_MAX_BARS && (
                <button className="jam-grid-add-section" onClick={blurAfter(addSection)} aria-label="Add 4 bars" title="Add 4 bars">
                  +
                </button>
              )}
            </div>
            {open.added && (
              <button className="jam-editor-remove" onClick={blurAfter(() => removeTrack(open))}>
                Remove track
              </button>
            )}
            {selected && (
              <button className="jam-editor-icon-btn" onClick={blurAfter(removeSelected)} aria-label="Delete note" title="Delete note">
                <TrashIcon />
              </button>
            )}
            <button
              className={`jam-editor-icon-btn ${expanded ? 'on' : ''}`}
              onClick={blurAfter(() => setExpanded(!expanded))}
              aria-label={expanded ? 'Back to its size' : 'Full height'}
              title={expanded ? 'Back to its size' : 'Full height'}
            >
              {expanded ? <CollapseIcon /> : <ExpandIcon />}
            </button>
          </div>
          <div className="jam-editor-body" ref={bodyRef}>
            <div className="jam-editor-content">{renderGrid(open)}</div>
          </div>
        </section>
      )}
    </div>
  );
}

