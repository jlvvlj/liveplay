import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Lesson } from '../../types/lesson';
import { getStemLabel, MergedStem, Song, StemName, STEM_NAMES, STEM_LABELS } from '../../types/song';
import { stemLessonFromSong, StemLessonData, StemSound, StemEvent } from '../../utils/stemLessonFromSong';
import { SOUND_COLORS } from '../../styles/palette';
import './StemSoundEditor.css';

interface StemSoundEditorProps {
  song: Song;
  onExit: () => void;
  onStartLesson: (lesson: Lesson) => void;
}

const BRUSH_COLORS = ['#f8fafc', '#60a5fa', '#f472b6', '#34d399', '#fbbf24', '#22d3ee', '#a78bfa', '#f87171'];
const STEM_COLOR = '#fb923c';
const RULER_HEIGHT = 24;
const WAVE_HEIGHT = 190;
const WAVE_TOOLBAR_HEIGHT = 42;
const LANE_HEIGHT = 44;
const MINIMAP_HEIGHT = 44;
const MIN_REGION_SEC = 0.03;
const CLICK_DRAG_THRESHOLD_PX = 5;
const EDGE_HIT_PX = 9;

type Region = { start: number; end: number };
type BrushRegion = Region & { id: number; color: string };

type WaveHit =
  | { kind: 'empty' }
  | { kind: 'new-brush' }
  | { kind: 'brush-move'; brushId: number }
  | { kind: 'brush-resize-start'; brushId: number }
  | { kind: 'brush-resize-end'; brushId: number }
  | { kind: 'sound-select'; soundId: number }
  | { kind: 'sound-move'; soundId: number }
  | { kind: 'sound-resize-start'; soundId: number }
  | { kind: 'sound-resize-end'; soundId: number };

interface WaveDrag {
  hit: WaveHit;
  startX: number;
  startTime: number;
  initialRegion: Region | null;
  grabOffset: number; // for move drags: pointer offset from region start
  length: number; // for move drags: region length
  moved: boolean;
  draftBrushId: number | null;
}

export function StemSoundEditor({ song, onExit, onStartLesson }: StemSoundEditorProps) {
  const [stem, setStem] = useState<string>('drums');
  const [mergedStems, setMergedStems] = useState<MergedStem[]>([]);
  const [mergeA, setMergeA] = useState<StemName>('drums');
  const [mergeB, setMergeB] = useState<StemName>('vocals');
  const [merging, setMerging] = useState(false);
  const [data, setData] = useState<StemLessonData | null>(null);
  const [status, setStatus] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [startingLesson, setStartingLesson] = useState(false);
  const [selectedSound, setSelectedSound] = useState<number | null>(null);
  const [brushes, setBrushes] = useState<BrushRegion[]>([]);
  const [activeBrushId, setActiveBrushId] = useState<number | null>(null);
  const [viewStart, setViewStart] = useState(0);
  const [viewDur, setViewDur] = useState(0); // 0 = fit whole stem
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [waveCursor, setWaveCursor] = useState('crosshair');

  const rulerCanvasRef = useRef<HTMLCanvasElement>(null);
  const waveCanvasRef = useRef<HTMLCanvasElement>(null);
  const lanesCanvasRef = useRef<HTMLCanvasElement>(null);
  const minimapCanvasRef = useRef<HTMLCanvasElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const bufferRef = useRef<AudioBuffer | null>(null);
  const peaksRef = useRef<Float32Array | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const playStartRef = useRef<{ ctxTime: number; offset: number } | null>(null);
  const dragRef = useRef<WaveDrag | null>(null);
  const minimapDragRef = useRef<boolean>(false);
  const nextBrushIdRef = useRef(1);

  const duration = bufferRef.current?.duration ?? data?.duration ?? 1;
  const effectiveViewDur = viewDur > 0 ? viewDur : duration;
  const lanesHeight = Math.max((data?.sounds.length ?? 0) * LANE_HEIGHT, 0);
  const activeBrush = brushes.find((brush) => brush.id === activeBrushId) ?? null;
  const showActiveBrushTools =
    !!activeBrush && activeBrush.end >= viewStart && activeBrush.start <= viewStart + effectiveViewDur;
  const activeBrushToolsLeft = activeBrush
    ? Math.min(
        92,
        Math.max(8, (((activeBrush.start + activeBrush.end) / 2 - viewStart) / effectiveViewDur) * 100)
      )
    : 50;
  const stemOptions = useMemo(
    () => [
      ...STEM_NAMES.map((name) => ({
        id: name,
        label: STEM_LABELS[name],
        path: song.stems?.[name] ?? '',
      })),
      ...mergedStems,
    ],
    [mergedStems, song.stems]
  );
  const activeStem = stemOptions.find((option) => option.id === stem);
  const activeStemLabel = activeStem?.label ?? getStemLabel(stem);
  const activeStemPath = activeStem?.path ?? '';

  // ---------- data + audio loading ----------
  useEffect(() => {
    let cancelled = false;
    const loadMergedStems = async () => {
      try {
        const response = await fetch(`/api/songs/${song.id}/merged-stems`);
        const merged = await response.json();
        if (!response.ok || merged.error) throw new Error(merged.error ?? `HTTP ${response.status}`);
        if (!cancelled) setMergedStems(merged);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void loadMergedStems();
    return () => {
      cancelled = true;
    };
  }, [song.id]);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    setSelectedSound(null);
    setBrushes([]);
    setActiveBrushId(null);
    nextBrushIdRef.current = 1;
    setDirty(false);
    setViewStart(0);
    setViewDur(0);
    stopPlayback();

    const load = async () => {
      try {
        setStatus('Analyzing stem…');
        if (!activeStemPath) throw new Error('Song stems missing');
        const response = await fetch(`/api/songs/${song.id}/stem-lesson?stem=${stem}`, { method: 'POST' });
        const lesson = await response.json();
        if (!response.ok || lesson.error) throw new Error(lesson.error ?? `HTTP ${response.status}`);
        if (cancelled) return;
        setData(lesson);

        setStatus('Loading waveform…');
        const audioResponse = await fetch(`/audio/${activeStemPath}`);
        const arrayBuffer = await audioResponse.arrayBuffer();
        const ctx = (audioCtxRef.current ??= new AudioContext());
        const buffer = await ctx.decodeAudioData(arrayBuffer);
        if (cancelled) return;
        bufferRef.current = buffer;
        peaksRef.current = computePeaks(buffer, 8000);
        setStatus('');
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setStatus('');
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song.id, stem, activeStemPath]);

  useEffect(() => () => stopPlayback(), []); // unmount

  // ---------- playback ----------
  function stopPlayback() {
    if (sourceRef.current) {
      try {
        sourceRef.current.stop();
      } catch {
        /* not started */
      }
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    playStartRef.current = null;
    setPlaying(false);
  }

  const playRange = useCallback((offset: number, length?: number) => {
    const ctx = audioCtxRef.current;
    const buffer = bufferRef.current;
    if (!ctx || !buffer) return;
    stopPlayback();
    void ctx.resume();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.onended = () => {
      if (sourceRef.current === source) {
        playStartRef.current = null;
        setPlaying(false);
      }
    };
    source.start(0, offset, length);
    sourceRef.current = source;
    playStartRef.current = { ctxTime: ctx.currentTime, offset };
    setPlaying(true);
  }, []);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const ctx = audioCtxRef.current;
      if (ctx && playStartRef.current) {
        setPlayhead(playStartRef.current.offset + (ctx.currentTime - playStartRef.current.ctxTime));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const seekBy = (delta: number) => {
    const t = Math.min(Math.max(playhead + delta, 0), duration);
    setPlayhead(t);
    if (playing) playRange(t);
  };

  // ---------- coordinate helpers ----------
  const timeToX = useCallback(
    (t: number, width: number) => ((t - viewStart) / effectiveViewDur) * width,
    [viewStart, effectiveViewDur]
  );
  const xToTime = useCallback(
    (x: number, width: number) => viewStart + (x / width) * effectiveViewDur,
    [viewStart, effectiveViewDur]
  );

  // ---------- drawing: waveform track ----------
  useEffect(() => {
    const canvas = waveCanvasRef.current;
    const peaks = peaksRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    canvas.width = width * dpr;
    canvas.height = WAVE_HEIGHT * dpr;
    const g = canvas.getContext('2d')!;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, width, WAVE_HEIGHT);

    // clip card (rounded, tinted, colored border) like the reference
    const pad = 6;
    const cardY = pad;
    const cardH = WAVE_HEIGHT - pad * 2;
    g.beginPath();
    g.roundRect(1, cardY, width - 2, cardH, 10);
    g.fillStyle = 'rgba(251, 146, 60, 0.05)';
    g.fill();
    g.strokeStyle = 'rgba(251, 146, 60, 0.55)';
    g.lineWidth = 1;
    g.stroke();

    if (peaks) {
      const bins = peaks.length / 2;
      const mid = cardY + cardH / 2;
      const amp = cardH / 2 - 8;
      g.fillStyle = STEM_COLOR;
      // discrete bars with gaps, like the reference waveforms
      for (let x = 4; x < width - 4; x += 3) {
        const t0 = xToTime(x, width);
        const t1 = xToTime(x + 3, width);
        const b0 = Math.max(0, Math.floor((t0 / duration) * bins));
        const b1 = Math.min(bins, Math.max(b0 + 1, Math.ceil((t1 / duration) * bins)));
        let hi = 0;
        for (let b = b0; b < b1; b++) {
          hi = Math.max(hi, peaks[b * 2 + 1], -peaks[b * 2]);
        }
        const h = Math.max(hi * amp, 1);
        g.fillRect(x, mid - h, 2, h * 2);
      }
    }

    // selected sound's clip region
    if (data && selectedSound !== null) {
      const sound = data.sounds.find((s) => s.id === selectedSound);
      if (sound) {
        const color = colorFor(sound.id, data);
        const x0 = timeToX(sound.start, width);
        const x1 = timeToX(sound.end, width);
        g.fillStyle = hexWithAlpha(color, 0.14);
        g.fillRect(x0, cardY, x1 - x0, cardH);
        g.fillStyle = color;
        g.fillRect(x0 - 1, cardY, 2, cardH);
        g.fillRect(x1 - 1, cardY, 2, cardH);
        g.fillRect(x0 - 4, cardY + cardH / 2 - 12, 8, 24);
        g.fillRect(x1 - 4, cardY + cardH / 2 - 12, 8, 24);
      }
    }

    // brush selections
    for (const brush of brushes) {
      const x0 = timeToX(brush.start, width);
      const x1 = timeToX(brush.end, width);
      const selected = brush.id === activeBrushId;
      if (x1 < 0 || x0 > width) continue;

      g.fillStyle = hexWithAlpha(brush.color, selected ? 0.22 : 0.12);
      g.fillRect(x0, cardY, x1 - x0, cardH);
      g.strokeStyle = hexWithAlpha(brush.color, selected ? 0.95 : 0.65);
      g.setLineDash(selected ? [] : [5, 4]);
      g.strokeRect(x0 + 0.5, cardY + 1, x1 - x0 - 1, cardH - 2);
      g.setLineDash([]);

      g.fillStyle = brush.color;
      g.fillRect(x0 - 1.5, cardY + 3, 3, cardH - 6);
      g.fillRect(x1 - 1.5, cardY + 3, 3, cardH - 6);
      if (selected) {
        g.beginPath();
        g.roundRect(x0 - 5, cardY + cardH / 2 - 14, 10, 28, 4);
        g.roundRect(x1 - 5, cardY + cardH / 2 - 14, 10, 28, 4);
        g.fill();
      }

      const label = `${(brush.end - brush.start).toFixed(2)}s`;
      g.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
      const tw = g.measureText(label).width;
      const lx = Math.min(Math.max((x0 + x1) / 2 - tw / 2, 6), width - tw - 10);
      g.fillStyle = 'rgba(10,10,12,0.92)';
      g.beginPath();
      g.roundRect(lx - 5, cardY + 6, tw + 10, 16, 4);
      g.fill();
      g.fillStyle = 'rgba(255,255,255,0.92)';
      g.fillText(label, lx, cardY + 17);
    }

    drawPlayhead(g, timeToX(playhead, width), 0, WAVE_HEIGHT, true);
  }, [data, brushes, activeBrushId, selectedSound, playhead, viewStart, viewDur, duration, timeToX, xToTime, status]);

  // ---------- drawing: sound lanes ----------
  useEffect(() => {
    const canvas = lanesCanvasRef.current;
    if (!canvas || !data || data.sounds.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    canvas.width = width * dpr;
    canvas.height = lanesHeight * dpr;
    const g = canvas.getContext('2d')!;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, width, lanesHeight);

    data.sounds.forEach((sound, row) => {
      const color = colorFor(sound.id, data);
      const dimmed = selectedSound !== null && selectedSound !== sound.id;
      const y = row * LANE_HEIGHT + 5;
      const h = LANE_HEIGHT - 10;
      g.beginPath();
      g.roundRect(1, y, width - 2, h, 8);
      g.fillStyle = hexWithAlpha(color, dimmed ? 0.02 : 0.05);
      g.fill();
      g.strokeStyle = hexWithAlpha(color, dimmed ? 0.18 : 0.5);
      g.lineWidth = 1;
      g.stroke();

      g.fillStyle = hexWithAlpha(color, dimmed ? 0.35 : 0.95);
      for (const event of data.events) {
        if (event.sound !== sound.id) continue;
        const x = timeToX(event.time, width);
        if (x < 2 || x > width - 2) continue;
        const vh = 6 + (event.velocity / 127) * (h - 14);
        g.beginPath();
        g.roundRect(x - 1, y + (h - vh) / 2, 2.5, vh, 1);
        g.fill();
      }
    });

    drawPlayhead(g, timeToX(playhead, width), 0, lanesHeight, false);
  }, [data, selectedSound, viewStart, viewDur, playhead, timeToX, lanesHeight]);

  // ---------- drawing: ruler ----------
  useEffect(() => {
    const canvas = rulerCanvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    canvas.width = width * dpr;
    canvas.height = RULER_HEIGHT * dpr;
    const g = canvas.getContext('2d')!;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, width, RULER_HEIGHT);

    const targetPx = 100;
    const raw = (effectiveViewDur / width) * targetPx;
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120];
    const step = steps.find((s) => s >= raw) ?? 300;
    const first = Math.ceil(viewStart / step) * step;

    g.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
    g.textBaseline = 'middle';
    for (let t = first; t <= viewStart + effectiveViewDur; t += step) {
      const x = timeToX(t, width);
      g.fillStyle = 'rgba(255,255,255,0.5)';
      g.fillText(formatRuler(t), x + 3, RULER_HEIGHT / 2);
      const minor = step / 5;
      for (let m = t + minor; m < t + step; m += minor) {
        const mx = timeToX(m, width);
        if (mx > width) break;
        g.fillStyle = 'rgba(255,255,255,0.16)';
        g.fillRect(mx, RULER_HEIGHT / 2 - 3, 1, 6);
      }
    }
  }, [viewStart, effectiveViewDur, timeToX, data, status]);

  // ---------- drawing: minimap ----------
  useEffect(() => {
    const canvas = minimapCanvasRef.current;
    const peaks = peaksRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    canvas.width = width * dpr;
    canvas.height = MINIMAP_HEIGHT * dpr;
    const g = canvas.getContext('2d')!;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, width, MINIMAP_HEIGHT);

    if (peaks) {
      const bins = peaks.length / 2;
      const mid = MINIMAP_HEIGHT / 2;
      const amp = mid - 6;
      g.fillStyle = 'rgba(255,255,255,0.28)';
      for (let x = 0; x < width; x += 3) {
        const b0 = Math.floor((x / width) * bins);
        const b1 = Math.min(bins, Math.max(b0 + 1, Math.floor(((x + 3) / width) * bins)));
        let hi = 0;
        for (let b = b0; b < b1; b++) {
          hi = Math.max(hi, peaks[b * 2 + 1], -peaks[b * 2]);
        }
        const h = Math.max(hi * amp, 0.5);
        g.fillRect(x, mid - h, 2, h * 2);
      }
    }

    // viewport window
    const wx0 = (viewStart / duration) * width;
    const wx1 = ((viewStart + effectiveViewDur) / duration) * width;
    g.fillStyle = 'rgba(255,255,255,0.1)';
    g.beginPath();
    g.roundRect(wx0, 2, Math.max(wx1 - wx0, 8), MINIMAP_HEIGHT - 4, 6);
    g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.75)';
    g.lineWidth = 1.5;
    g.stroke();

    // playhead
    const px = (playhead / duration) * width;
    g.fillStyle = STEM_COLOR;
    g.fillRect(px - 0.5, 0, 1.5, MINIMAP_HEIGHT);
  }, [viewStart, effectiveViewDur, duration, playhead, data, status]);

  // ---------- interactions: waveform (click seek, drag/edit brush, wheel zoom) ----------
  const createBrush = (start: number, end: number): BrushRegion => {
    const id = nextBrushIdRef.current++;
    return {
      id,
      color: BRUSH_COLORS[(id - 1) % BRUSH_COLORS.length],
      start: Math.min(start, end),
      end: Math.max(start, end),
    };
  };

  const updateBrush = (id: number, region: Region) => {
    setBrushes((current) =>
      current.map((brush) =>
        brush.id === id
          ? {
              ...brush,
              start: Math.min(region.start, region.end),
              end: Math.max(region.start, region.end),
            }
          : brush
      )
    );
  };

  const finalizeBrush = (id: number) => {
    setBrushes((current) =>
      current
        .map((brush) =>
          brush.id === id ? { ...brush, start: round4(brush.start), end: round4(brush.end) } : brush
        )
        .filter((brush) => brush.end - brush.start >= MIN_REGION_SEC)
    );
  };

  const removeActiveBrush = () => {
    if (activeBrushId === null) return;
    setBrushes((current) => current.filter((brush) => brush.id !== activeBrushId));
    setActiveBrushId(null);
  };

  const getWaveHit = useCallback(
    (x: number, width: number): WaveHit => {
      for (let i = brushes.length - 1; i >= 0; i--) {
        const brush = brushes[i];
        const x0 = timeToX(brush.start, width);
        const x1 = timeToX(brush.end, width);
        if (Math.abs(x - x0) <= EDGE_HIT_PX) return { kind: 'brush-resize-start', brushId: brush.id };
        if (Math.abs(x - x1) <= EDGE_HIT_PX) return { kind: 'brush-resize-end', brushId: brush.id };
        if (x >= Math.min(x0, x1) && x <= Math.max(x0, x1)) return { kind: 'brush-move', brushId: brush.id };
      }
      return { kind: 'new-brush' };
    },
    [brushes, timeToX]
  );

  const cursorForHit = (hit: WaveHit, dragging = false) => {
    if (hit.kind === 'brush-resize-start' || hit.kind === 'brush-resize-end') return 'ew-resize';
    if (hit.kind === 'brush-move') return dragging ? 'grabbing' : 'grab';
    return 'crosshair';
  };

  const handleWaveMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const t = xToTime(x, rect.width);
    const hit = getWaveHit(x, rect.width);
    const hitBrush =
      hit.kind === 'brush-move' || hit.kind === 'brush-resize-start' || hit.kind === 'brush-resize-end'
        ? brushes.find((brush) => brush.id === hit.brushId) ?? null
        : null;
    if (hitBrush) setActiveBrushId(hitBrush.id);
    setWaveCursor(cursorForHit(hit, true));
    dragRef.current = {
      hit,
      startX: x,
      startTime: t,
      initialRegion: hitBrush ? { start: hitBrush.start, end: hitBrush.end } : null,
      grabOffset: hitBrush ? t - hitBrush.start : 0,
      length: hitBrush ? hitBrush.end - hitBrush.start : 0,
      moved: false,
      draftBrushId: null,
    };
  };

  const handleWaveMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const drag = dragRef.current;
    if (!drag) {
      setWaveCursor(cursorForHit(getWaveHit(x, rect.width)));
      return;
    }
    if (Math.abs(x - drag.startX) > CLICK_DRAG_THRESHOLD_PX) drag.moved = true;
    if (!drag.moved) return;

    const t = Math.min(Math.max(xToTime(x, rect.width), 0), duration);
    setWaveCursor(cursorForHit(drag.hit, true));

    if (drag.hit.kind === 'new-brush') {
      if (drag.draftBrushId === null) {
        const brush = createBrush(drag.startTime, t);
        drag.draftBrushId = brush.id;
        setActiveBrushId(brush.id);
        setBrushes((current) => [...current, brush]);
      } else {
        updateBrush(drag.draftBrushId, { start: drag.startTime, end: t });
      }
      return;
    }

    if (!drag.initialRegion) return;
    if (drag.hit.kind === 'brush-move') {
      const start = Math.min(Math.max(t - drag.grabOffset, 0), Math.max(duration - drag.length, 0));
      updateBrush(drag.hit.brushId, { start, end: start + drag.length });
      return;
    }

    if (drag.hit.kind === 'brush-resize-start') {
      updateBrush(drag.hit.brushId, {
        start: Math.min(t, drag.initialRegion.end - MIN_REGION_SEC),
        end: drag.initialRegion.end,
      });
      return;
    }

    if (drag.hit.kind === 'brush-resize-end') {
      updateBrush(drag.hit.brushId, {
        start: drag.initialRegion.start,
        end: Math.max(t, drag.initialRegion.start + MIN_REGION_SEC),
      });
    }
  };

  const handleWaveMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (!drag.moved) {
      if (drag.hit.kind === 'new-brush') {
        setActiveBrushId(null);
        setPlayhead(drag.startTime);
        if (playing) playRange(drag.startTime);
      }
      const rect = e.currentTarget.getBoundingClientRect();
      setWaveCursor(cursorForHit(getWaveHit(e.clientX - rect.left, rect.width)));
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (drag.hit.kind === 'new-brush' && drag.draftBrushId !== null) finalizeBrush(drag.draftBrushId);
    if (
      drag.hit.kind === 'brush-move' ||
      drag.hit.kind === 'brush-resize-start' ||
      drag.hit.kind === 'brush-resize-end'
    ) {
      finalizeBrush(drag.hit.brushId);
    }
    setWaveCursor(cursorForHit(getWaveHit(x, rect.width)));
  };

  const handleWaveMouseLeave = () => {
    const drag = dragRef.current;
    if (drag?.moved) {
      if (drag.hit.kind === 'new-brush' && drag.draftBrushId !== null) finalizeBrush(drag.draftBrushId);
      if (
        drag.hit.kind === 'brush-move' ||
        drag.hit.kind === 'brush-resize-start' ||
        drag.hit.kind === 'brush-resize-end'
      ) {
        finalizeBrush(drag.hit.brushId);
      }
    }
    dragRef.current = null;
    setWaveCursor('crosshair');
  };

  const zoomAround = (focus: number, factor: number) => {
    const nextDur = Math.min(Math.max(effectiveViewDur * factor, 0.25), duration);
    const ratio = (focus - viewStart) / effectiveViewDur;
    const nextStart = Math.min(Math.max(focus - ratio * nextDur, 0), Math.max(duration - nextDur, 0));
    setViewDur(nextDur >= duration ? 0 : nextDur);
    setViewStart(nextDur >= duration ? 0 : nextStart);
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (e.ctrlKey) {
      e.preventDefault();
      zoomAround(xToTime(e.clientX - rect.left, rect.width), e.deltaY > 0 ? 1.25 : 0.8);
      return;
    }

    const panDelta = e.deltaX !== 0 ? e.deltaX : e.shiftKey ? e.deltaY : 0;
    if (panDelta === 0 || effectiveViewDur >= duration) return;

    e.preventDefault();
    const secondsPerPixel = effectiveViewDur / rect.width;
    const normalizedPixels =
      e.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? panDelta * 16
        : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? panDelta * rect.width
          : panDelta;
    const maxStart = Math.max(duration - effectiveViewDur, 0);
    setViewStart((current) => Math.min(Math.max(current + normalizedPixels * secondsPerPixel, 0), maxStart));
  };

  // zoom slider: 0 = fit whole track, 100 = maximum zoom
  const zoomValue = viewDur === 0 ? 0 : Math.round((1 - (effectiveViewDur - 0.25) / (duration - 0.25)) * 100);
  const handleZoomSlider = (value: number) => {
    if (value <= 0) {
      setViewDur(0);
      setViewStart(0);
      return;
    }
    const nextDur = Math.max(duration - (value / 100) * (duration - 0.25), 0.25);
    const focus = playhead;
    const nextStart = Math.min(Math.max(focus - nextDur / 2, 0), Math.max(duration - nextDur, 0));
    setViewDur(nextDur);
    setViewStart(nextStart);
  };

  // ---------- interactions: minimap (click / drag to pan) ----------
  const panMinimap = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const t = ((e.clientX - rect.left) / rect.width) * duration;
    if (viewDur === 0) {
      setPlayhead(Math.min(Math.max(t, 0), duration));
      if (playing) playRange(t);
      return;
    }
    setViewStart(Math.min(Math.max(t - effectiveViewDur / 2, 0), Math.max(duration - effectiveViewDur, 0)));
  };

  // ---------- interactions: lanes ----------
  const handleLanesClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!data) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const t = xToTime(e.clientX - rect.left, rect.width);
    const row = Math.floor((e.clientY - rect.top) / LANE_HEIGHT);
    const sound = data.sounds[row];
    if (!sound) return;
    const tolerance = (effectiveViewDur / rect.width) * 6;
    const nearest = data.events
      .filter((ev) => ev.sound === sound.id)
      .reduce<StemEvent | null>(
        (best, ev) => (Math.abs(ev.time - t) < Math.abs((best?.time ?? Infinity) - t) ? ev : best),
        null
      );
    if (!nearest || Math.abs(nearest.time - t) > tolerance) {
      setSelectedSound(sound.id);
      return;
    }
    if (e.altKey) {
      setData({ ...data, events: data.events.filter((ev) => ev !== nearest) });
      setDirty(true);
    } else {
      setSelectedSound(sound.id);
      playRange(nearest.time, Math.min(sound.end - sound.start, 1.5));
      setPlayhead(nearest.time);
    }
  };

  // ---------- edit operations ----------
  const applyBrushToSelected = () => {
    if (!data || !activeBrush || selectedSound === null) return;
    setData({
      ...data,
      sounds: data.sounds.map((s) =>
        s.id === selectedSound ? { ...s, start: round4(activeBrush.start), end: round4(activeBrush.end) } : s
      ),
    });
    setDirty(true);
  };

  const addSoundFromBrush = () => {
    if (!data || !activeBrush) return;
    const id = Math.max(-1, ...data.sounds.map((s) => s.id)) + 1;
    const sound: StemSound = {
      id,
      clip: '',
      centroidHz: 0,
      start: round4(activeBrush.start),
      end: round4(activeBrush.end),
    };
    setData({
      ...data,
      sounds: [...data.sounds, sound],
      events: [...data.events, { time: round4(activeBrush.start), sound: id, velocity: 100 }],
    });
    setSelectedSound(id);
    setDirty(true);
  };

  const deleteSound = (id: number) => {
    if (!data) return;
    setData({
      ...data,
      sounds: data.sounds.filter((s) => s.id !== id),
      events: data.events.filter((e) => e.sound !== id),
    });
    if (selectedSound === id) setSelectedSound(null);
    setDirty(true);
  };

  const mergeSound = (from: number, into: number) => {
    if (!data || from === into) return;
    setData({
      ...data,
      sounds: data.sounds.filter((s) => s.id !== from),
      events: data.events.map((e) => (e.sound === from ? { ...e, sound: into } : e)),
    });
    if (selectedSound === from) setSelectedSound(into);
    setDirty(true);
  };

  const addEventAtPlayhead = () => {
    if (!data || selectedSound === null) return;
    setData({
      ...data,
      events: [...data.events, { time: round4(playhead), sound: selectedSound, velocity: 100 }].sort(
        (a, b) => a.time - b.time
      ),
    });
    setDirty(true);
  };

  const save = async (): Promise<StemLessonData | null> => {
    if (!data) return null;
    setStatus('Saving…');
    try {
      const response = await fetch(`/api/songs/${song.id}/stem-lesson?stem=${stem}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sounds: data.sounds.map(({ clip: _clip, ...rest }) => rest),
          events: data.events,
        }),
      });
      const saved = await response.json();
      if (!response.ok || saved.error) throw new Error(saved.error ?? `HTTP ${response.status}`);
      setData(saved);
      setDirty(false);
      setError(null);
      return saved;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setStatus('');
    }
  };

  const startCurrentLesson = async () => {
    if (!data || status) return;
    setStartingLesson(true);
    stopPlayback();
    try {
      const lessonData = dirty ? await save() : data;
      if (!lessonData) return;
      onStartLesson(stemLessonFromSong(song, lessonData));
    } finally {
      setStartingLesson(false);
    }
  };

  const resetToAuto = async () => {
    setStatus('Re-analyzing…');
    setError(null);
    try {
      await fetch(`/api/songs/${song.id}/stem-lesson?stem=${stem}`, { method: 'DELETE' });
      const response = await fetch(`/api/songs/${song.id}/stem-lesson?stem=${stem}`, { method: 'POST' });
      const lesson = await response.json();
      if (!response.ok || lesson.error) throw new Error(lesson.error ?? `HTTP ${response.status}`);
      setData(lesson);
      setSelectedSound(null);
      setBrushes([]);
      setActiveBrushId(null);
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStatus('');
    }
  };

  const createMergedStem = async () => {
    if (mergeA === mergeB || merging) return;
    setMerging(true);
    setStatus('Merging stems…');
    setError(null);
    stopPlayback();
    try {
      const response = await fetch(`/api/songs/${song.id}/merged-stems`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stems: [mergeA, mergeB] }),
      });
      const merged = await response.json();
      if (!response.ok || merged.error) throw new Error(merged.error ?? `HTTP ${response.status}`);
      setMergedStems((current) =>
        [...current.filter((candidate) => candidate.id !== merged.id), merged].sort((a, b) =>
          a.label.localeCompare(b.label)
        )
      );
      setStem(merged.id);
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMerging(false);
      setStatus('');
    }
  };

  const eventCounts = useMemo(() => {
    const counts = new Map<number, number>();
    for (const event of data?.events ?? []) {
      counts.set(event.sound, (counts.get(event.sound) ?? 0) + 1);
    }
    return counts;
  }, [data]);

  // ---------- render ----------
  return (
    <div className="stem-editor">
      <header className="se-topbar">
        <button className="se-chip-button" onClick={onExit} title="Back to songs">
          ←
        </button>
        <div className="se-project">
          <span className="se-project-name">{song.title}</span>
          <span className="se-project-sub">Sound editor</span>
        </div>

        <div className="se-tools se-event-tools">
          <span className="se-tools-label">Event</span>
          <button
            className="se-tool"
            disabled={selectedSound === null}
            onClick={addEventAtPlayhead}
            title="Insert an occurrence of the selected sound at the playhead"
          >
            ⊕
          </button>
        </div>

        <div className="se-topbar-right">
          <div className="se-merge-controls">
            <select
              className="se-merge-select"
              value={mergeA}
              onChange={(event) => setMergeA(event.target.value as StemName)}
              title="First stem to merge"
            >
              {STEM_NAMES.map((name) => (
                <option key={name} value={name}>
                  {STEM_LABELS[name]}
                </option>
              ))}
            </select>
            <span className="se-merge-plus">+</span>
            <select
              className="se-merge-select"
              value={mergeB}
              onChange={(event) => setMergeB(event.target.value as StemName)}
              title="Second stem to merge"
            >
              {STEM_NAMES.map((name) => (
                <option key={name} value={name}>
                  {STEM_LABELS[name]}
                </option>
              ))}
            </select>
            <button
              className="se-merge-button"
              disabled={mergeA === mergeB || merging || !!status}
              onClick={createMergedStem}
              title="Create a merged lesson stem"
            >
              {merging ? 'Merging…' : 'Merge'}
            </button>
          </div>
          <nav className="se-stem-tabs">
            {stemOptions.map((option) => (
              <button
                key={option.id}
                className={`se-stem-tab ${stem === option.id ? 'active' : ''}`}
                onClick={() => setStem(option.id)}
              >
                {option.label}
              </button>
            ))}
          </nav>
          <button className="se-chip-button" onClick={resetToAuto} title="Discard edits and re-run the automatic analysis">
            ↺
          </button>
          <button className="se-publish" disabled={!dirty} onClick={save}>
            {dirty ? 'Save' : 'Saved'}
          </button>
          <button
            className="se-start-lesson"
            disabled={!data || !!status || startingLesson}
            onClick={startCurrentLesson}
            title="Start a lesson from this stem"
          >
            {startingLesson ? 'Starting…' : dirty ? 'Save & Start' : 'Start Lesson'}
          </button>
        </div>
      </header>

      {error && <div className="se-error">{error}</div>}

      {!data || status ? (
        <div className="se-loading">
          <div className="se-loading-pulse" />
          {status || 'Loading…'}
        </div>
      ) : (
        <div className="se-body">
          <div className="se-main">
            <div className="se-tracks">
              <div className="se-track-row" style={{ height: WAVE_HEIGHT + WAVE_TOOLBAR_HEIGHT }}>
                <div className="se-gutter">
                  <span className="se-gutter-grip">≡</span>
                  <span className="se-gutter-name">{activeStemLabel}</span>
                </div>
                <div className="se-track-canvas">
                  <span className="se-clip-pill" style={{ background: STEM_COLOR }}>
                    {activeStemLabel} stem
                  </span>
                  {showActiveBrushTools && activeBrush && (
                    <div className="se-brush-popover" style={{ left: `${activeBrushToolsLeft}%` }}>
                      <span className="se-brush-swatch" style={{ background: activeBrush.color }} />
                      <button
                        className="se-tool"
                        onClick={() => playRange(activeBrush.start, activeBrush.end - activeBrush.start)}
                        title="Play the active selection"
                      >
                        ▶
                      </button>
                      <button
                        className="se-tool"
                        disabled={selectedSound === null}
                        onClick={applyBrushToSelected}
                        title="Set the selected sound's clip to the active selection"
                      >
                        ✓
                      </button>
                      <button className="se-tool" onClick={addSoundFromBrush} title="New sound from the active selection">
                        ＋
                      </button>
                      <button className="se-tool danger" onClick={removeActiveBrush} title="Cancel the active selection">
                        ✕
                      </button>
                    </div>
                  )}
                  <canvas
                    ref={waveCanvasRef}
                    className="se-wave"
                    style={{ height: WAVE_HEIGHT, cursor: waveCursor }}
                    onMouseDown={handleWaveMouseDown}
                    onMouseMove={handleWaveMouseMove}
                    onMouseUp={handleWaveMouseUp}
                    onMouseLeave={handleWaveMouseLeave}
                    onWheel={handleWheel}
                  />
                </div>
              </div>

              <div className="se-track-row" style={{ height: lanesHeight }}>
                <div className="se-gutter se-gutter-lanes">
                  {data.sounds.map((sound) => {
                    const color = colorFor(sound.id, data);
                    const selected = selectedSound === sound.id;
                    return (
                      <button
                        key={sound.id}
                        className={`se-lane-label ${selected ? 'selected' : ''}`}
                        style={{ height: LANE_HEIGHT, color: selected ? color : undefined }}
                        onClick={() => setSelectedSound(selected ? null : sound.id)}
                      >
                        <span className="se-lane-dot" style={{ background: color }} />
                        Sound {sound.id + 1}
                      </button>
                    );
                  })}
                </div>
                <div className="se-track-canvas">
                  <canvas
                    ref={lanesCanvasRef}
                    className="se-lanes"
                    style={{ height: lanesHeight }}
                    onClick={handleLanesClick}
                    onWheel={handleWheel}
                  />
                </div>
              </div>
            </div>

            <div className="se-timebase">
              <div className="se-gutter-spacer" />
              <div className="se-timebase-canvases">
                <canvas ref={rulerCanvasRef} className="se-ruler" style={{ height: RULER_HEIGHT }} />
                <canvas
                  ref={minimapCanvasRef}
                  className="se-minimap"
                  style={{ height: MINIMAP_HEIGHT }}
                  onMouseDown={(e) => {
                    minimapDragRef.current = true;
                    panMinimap(e);
                  }}
                  onMouseMove={(e) => minimapDragRef.current && panMinimap(e)}
                  onMouseUp={() => (minimapDragRef.current = false)}
                  onMouseLeave={() => (minimapDragRef.current = false)}
                />
              </div>
            </div>

            <div className="se-hint">
              Drag on the waveform to add selections · drag selection handles or body to edit · scroll horizontally · pinch to zoom · click a marker
              to audition · ⌥-click a marker to delete it
            </div>
          </div>

          <aside className="se-sidebar">
            <h3 className="se-sidebar-title">Stem sounds</h3>
            <p className="se-sidebar-sub">
              {data.sounds.length} sounds · {data.events.length} events
            </p>
            {data.sounds.map((sound) => {
              const color = colorFor(sound.id, data);
              const selected = selectedSound === sound.id;
              return (
                <div
                  key={sound.id}
                  className={`se-side-sound ${selected ? 'selected' : ''}`}
                  style={selected ? { borderColor: hexWithAlpha(color, 0.7) } : undefined}
                  onClick={() => setSelectedSound(selected ? null : sound.id)}
                >
                  <span className="se-side-pill" style={{ background: color }}>
                    Sound {sound.id + 1}
                  </span>
                  <span className="se-side-meta">
                    {(sound.end - sound.start).toFixed(2)}s · {eventCounts.get(sound.id) ?? 0} hits
                  </span>
                  <div className="se-side-actions">
                    <button
                      className="se-tool"
                      title="Audition this sound's clip"
                      onClick={(e) => {
                        e.stopPropagation();
                        playRange(sound.start, sound.end - sound.start);
                      }}
                    >
                      ▶
                    </button>
                    <select
                      className="se-side-merge"
                      value=""
                      title="Merge this sound's events into another sound"
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => {
                        const into = Number(e.target.value);
                        if (!Number.isNaN(into)) mergeSound(sound.id, into);
                      }}
                    >
                      <option value="">merge…</option>
                      {data.sounds
                        .filter((other) => other.id !== sound.id)
                        .map((other) => (
                          <option key={other.id} value={other.id}>
                            → Sound {other.id + 1}
                          </option>
                        ))}
                    </select>
                    <button
                      className="se-tool danger"
                      title="Delete this sound and its events"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteSound(sound.id);
                      }}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              );
            })}
          </aside>
        </div>
      )}

      {data && !status && (
        <footer className="se-transport">
          <div className="se-timecode-chip">
            <span className="se-time-now">{formatTime(playhead)}</span>
            <span className="se-time-total">/ {formatTime(duration)}</span>
          </div>

          <div className="se-transport-center">
            <button className="se-skip" onClick={() => seekBy(-5)} title="Back 5 seconds">
              ◂◂
            </button>
            <button
              className="se-play"
              onClick={() => (playing ? stopPlayback() : playRange(playhead))}
              title={playing ? 'Stop' : 'Play from playhead'}
            >
              {playing ? '❚❚' : '▶'}
            </button>
            <button className="se-skip" onClick={() => seekBy(5)} title="Forward 5 seconds">
              ▸▸
            </button>
          </div>

          <div className="se-zoom-slider">
            <button className="se-zoom-step" onClick={() => zoomAround(playhead, 1.4)} title="Zoom out">
              −
            </button>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.min(Math.max(zoomValue, 0), 100)}
              onChange={(e) => handleZoomSlider(Number(e.target.value))}
            />
            <button className="se-zoom-step" onClick={() => zoomAround(playhead, 0.7)} title="Zoom in">
              ＋
            </button>
          </div>
        </footer>
      )}
    </div>
  );
}

// ---------- helpers ----------

function drawPlayhead(g: CanvasRenderingContext2D, x: number, top: number, bottom: number, cap: boolean) {
  if (x < 0) return;
  g.fillStyle = STEM_COLOR;
  g.fillRect(x - 0.5, top, 1.5, bottom - top);
  if (cap) {
    g.beginPath();
    g.moveTo(x - 4, top);
    g.lineTo(x + 4, top);
    g.lineTo(x, top + 6);
    g.closePath();
    g.fill();
  }
}

function computePeaks(buffer: AudioBuffer, bins: number): Float32Array {
  const channel = buffer.getChannelData(0);
  const peaks = new Float32Array(bins * 2);
  const samplesPerBin = Math.max(Math.floor(channel.length / bins), 1);
  for (let b = 0; b < bins; b++) {
    let lo = 0;
    let hi = 0;
    const start = b * samplesPerBin;
    const end = Math.min(start + samplesPerBin, channel.length);
    for (let i = start; i < end; i++) {
      const v = channel[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    peaks[b * 2] = lo;
    peaks[b * 2 + 1] = hi;
  }
  return peaks;
}

function colorFor(id: number, data: StemLessonData): string {
  const index = data.sounds.findIndex((s) => s.id === id);
  return SOUND_COLORS[(index >= 0 ? index : id) % SOUND_COLORS.length];
}

function hexWithAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

function formatTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const cs = Math.floor((t % 1) * 100);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function formatRuler(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
