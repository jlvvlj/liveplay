// Parallel copy of the Sound editor. Canvas drawing and editing gestures are kept here
// so changes in Instrument Lab cannot change the original editor.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiPath } from '../paths.mjs';
import './LabSoundEditor.css';
type StemSound = {id:number;clip:string;centroidHz:number;start:number;end:number;pitch?:number;label?:string};
type StemEvent = {time:number;sound:number;velocity:number;duration?:number;pitch?:number};
type StemLessonData = {stem:string;bpm:number;duration:number;sounds:StemSound[];events:StemEvent[];rev:number;referenceFile:string;backing?:string};

const SOUND_COLORS = ['#fb923c', '#818cf8', '#f472b6', '#34d399', '#fbbf24', '#22d3ee', '#a78bfa', '#f87171'];
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

export function LabSoundEditor({part, timeline, onView, time, onSeek, onTime, onAudition, onStartLesson, visible = true}: any) {
  const endpoint = apiPath(`/api/projects/${part.ownerProjectId}/sound-editor/${part.ownerPartId}`);
  const activeStemLabel = part.name;
  const activeStemPath = part.referenceFile;
  const rootRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [size, setSize] = useState(0);
  const [data, setData] = useState<StemLessonData | null>(null);
  const [status, setStatus] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [startingLesson, setStartingLesson] = useState(false);
  const [selectedSound, setSelectedSound] = useState<number | null>(null);
  const [brushes, setBrushes] = useState<BrushRegion[]>([]);
  const [activeBrushId, setActiveBrushId] = useState<number | null>(null);
  const viewStart = timeline[0], viewDur = timeline[1];
  const setViewStart = (value: any) => onView((v: number[]) => [typeof value === 'function' ? value(v[0]) : value, v[1]]);
  const setViewDur = (value: number) => onView((v: number[]) => [v[0], value || duration]);
  const [playing, setPlaying] = useState(false);
  const playhead = time;
  const setPlayhead = (value: number) => onSeek(value, endpoint);
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
  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    setSelectedSound(null);
    setBrushes([]);
    setActiveBrushId(null);
    nextBrushIdRef.current = 1;
    setDirty(false);
    stopPlayback();

    const load = async () => {
      try {
        setStatus('Loading stem sounds…');
        if (!activeStemPath) throw new Error('Instrument stem is missing');
        const response = await fetch(endpoint, { method: 'POST' });
        const lesson = await response.json();
        if (!response.ok || lesson.error) throw new Error(lesson.error ?? `HTTP ${response.status}`);
        if (cancelled) return;
        setData(lesson);

        setStatus('Loading waveform…');
        const audioResponse = await fetch(apiPath(`/api/projects/${part.ownerProjectId}/audio/${activeStemPath}`));
        if (!audioResponse.ok) throw new Error('Could not load stem audio');
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
  }, [endpoint, activeStemPath]);

  useEffect(() => () => { stopPlayback(); void audioCtxRef.current?.close(); }, []);
  useEffect(() => {
    const observer = new ResizeObserver(() => setSize(n => n + 1));
    if (rootRef.current) observer.observe(rootRef.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { if (!visible) stopPlayback(); }, [visible]);
  // Starting any other Lab transport stops this local clip audition.
  useEffect(() => {
    const stop = (e: Event) => { if ((e as CustomEvent).detail !== endpoint) stopPlayback(); };
    window.addEventListener('lab-audition', stop);
    return () => window.removeEventListener('lab-audition', stop);
  }, [endpoint]);

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
    onAudition?.();
    window.dispatchEvent(new CustomEvent('lab-audition', {detail:endpoint}));
    stopPlayback();
    offset = Math.max(0, Math.min(offset, buffer.duration - .001));
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
  }, [endpoint, onAudition]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const ctx = audioCtxRef.current;
      if (ctx && playStartRef.current) {
        onTime(Math.min(duration, playStartRef.current.offset + (ctx.currentTime - playStartRef.current.ctxTime)));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, onTime, duration]);

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
  }, [data, brushes, activeBrushId, selectedSound, playhead, viewStart, viewDur, duration, timeToX, xToTime, status, expanded, size]);

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
  }, [data, selectedSound, viewStart, viewDur, playhead, timeToX, lanesHeight, status, expanded, size]);

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
  }, [viewStart, effectiveViewDur, timeToX, data, status, expanded, size]);

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
  }, [viewStart, effectiveViewDur, duration, playhead, data, status, expanded, size]);

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

  useEffect(() => {
    const node = rootRef.current;
    const wheel = (e: WheelEvent) => {
      const canvas = (e.target as Element).closest('canvas');
      if (!canvas) return;
      e.preventDefault(); e.stopPropagation();
      const rect = canvas.getBoundingClientRect();
      if (e.ctrlKey) zoomAround(xToTime(e.clientX - rect.left, rect.width), e.deltaY > 0 ? 1.25 : .8);
      else {
        const delta = e.deltaX || (e.shiftKey ? e.deltaY : 0);
        const pixels = delta * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.width : 1);
        setViewStart((current:number) => Math.min(Math.max(current + pixels * effectiveViewDur / rect.width, 0), Math.max(duration - effectiveViewDur, 0)));
      }
    };
    node?.addEventListener('wheel', wheel, {passive:false});
    return () => node?.removeEventListener('wheel', wheel);
  }, [viewStart, viewDur, duration]);

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
    if (effectiveViewDur >= duration) {
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
    setExpanded(true);
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
      const response = await fetch(endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rev: data.rev, referenceFile: data.referenceFile,
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
    onAudition?.();
    window.dispatchEvent(new CustomEvent('lab-audition'));
    try {
      const lessonData = dirty ? await save() : data;
      if (!lessonData) return;
      const response = await fetch(`${endpoint}/lesson`, {method:'POST'});
      const lesson = await response.json();
      if (!response.ok) throw new Error(lesson.error);
      onStartLesson(lesson);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStartingLesson(false);
    }
  };

  const resetToAuto = async () => {
    setStatus('Restoring detected sounds…');
    setError(null);
    try {
      const reset = await fetch(endpoint, { method: 'DELETE', headers:{'Content-Type':'application/json'}, body:JSON.stringify({rev:data?.rev, referenceFile:data?.referenceFile}) });
      if (!reset.ok) throw new Error((await reset.json()).error);
      const response = await fetch(endpoint, { method: 'POST' });
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

  const rematch = async () => {
    if (!data) return;
    setStatus('Finding matching sounds…'); setError(null);
    try {
      const response = await fetch(`${endpoint}/match`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({sounds:data.sounds})});
      const value = await response.json();
      if (!response.ok) throw new Error(value.error);
      setData({...data, events:value.events}); setDirty(true);
    } catch(err) {setError(err instanceof Error ? err.message : String(err));}
    finally {setStatus('');}
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
    <div ref={rootRef} className={`lab-sound-editor ${expanded ? "audio-expanded" : "audio-compact"}`} role="region" aria-label={`${part.name} Sound editor`}>
      <header className="lab-se-topbar">
        <div className="lab-se-project">
          <span className="lab-se-project-name">{part.name} · Original stem</span>
          <span className="lab-se-project-sub">Sound editor</span>
        </div>

        <div className="lab-se-tools lab-se-event-tools">
          <span className="lab-se-tools-label">Event</span>
          <button
            className="lab-se-tool"
            disabled={selectedSound === null}
            onClick={addEventAtPlayhead}
            title="Insert an occurrence of the selected sound at the playhead"
          >
            ⊕
          </button>
        </div>

        <div className="lab-se-topbar-right">
          <button className="lab-se-merge-button" onClick={() => setExpanded(v => !v)} aria-expanded={expanded}>{expanded ? 'Hide sound lanes' : 'Edit sound lanes'}</button>
          <button className="lab-se-merge-button" disabled={!data || !!status || !data.sounds.length} onClick={rematch}>Find matching events</button>
          <button className="lab-se-chip-button" onClick={resetToAuto} disabled={!data || !!status} title="Reset audio edits to detected sounds">
            ↺
          </button>
          <button className="lab-se-publish" disabled={!dirty || !!status} onClick={save}>
            {dirty ? 'Save' : 'Saved'}
          </button>
          <button
            className="lab-se-start-lesson"
            disabled={!onStartLesson || !data || !!status || startingLesson || !data.events.length}
            onClick={startCurrentLesson}
            title="Start a lesson from this stem"
          >
            {startingLesson ? 'Starting…' : dirty ? 'Save & Start' : 'Start Lesson'}
          </button>
        </div>
      </header>

      {error && <div className="lab-se-error">{error}</div>}

      {!data || status ? (
        <div className="lab-se-loading">
          <div className="lab-se-loading-pulse" />
          {status || 'Loading…'}
        </div>
      ) : (
        <div className="lab-se-body">
          <div className="lab-se-main">
            <div className="lab-se-tracks">
              <div className="lab-se-track-row" style={{ height: WAVE_HEIGHT + WAVE_TOOLBAR_HEIGHT }}>
                <div className="lab-se-gutter">
                  <span className="lab-se-gutter-grip">≡</span>
                  <span className="lab-se-gutter-name">{activeStemLabel}</span>
                </div>
                <div className="lab-se-track-canvas">
                  <span className="lab-se-clip-pill" style={{ background: STEM_COLOR }}>
                    {activeStemLabel} stem
                  </span>
                  {showActiveBrushTools && activeBrush && (
                    <div className="lab-se-brush-popover" style={{ left: `${activeBrushToolsLeft}%` }}>
                      <span className="lab-se-brush-swatch" style={{ background: activeBrush.color }} />
                      <button
                        className="lab-se-tool"
                        onClick={() => playRange(activeBrush.start, activeBrush.end - activeBrush.start)}
                        title="Play the active selection"
                      >
                        ▶
                      </button>
                      <button
                        className="lab-se-tool"
                        disabled={selectedSound === null}
                        onClick={applyBrushToSelected}
                        title="Set the selected sound's clip to the active selection"
                      >
                        ✓
                      </button>
                      <button className="lab-se-tool" onClick={addSoundFromBrush} title="New sound from the active selection">
                        ＋
                      </button>
                      <button className="lab-se-tool danger" onClick={removeActiveBrush} title="Cancel the active selection">
                        ✕
                      </button>
                    </div>
                  )}
                  <canvas
                    ref={waveCanvasRef}
                    className="lab-se-wave" aria-label={`${part.name} audio waveform`}
                    style={{ height: WAVE_HEIGHT, cursor: waveCursor }}
                    onMouseDown={handleWaveMouseDown}
                    onMouseMove={handleWaveMouseMove}
                    onMouseUp={handleWaveMouseUp}
                    onMouseLeave={handleWaveMouseLeave}
                  />
                </div>
              </div>

              <div className="lab-se-track-row lab-se-sound-lanes" style={{ height: lanesHeight }}>
                <div className="lab-se-gutter lab-se-gutter-lanes">
                  {data.sounds.map((sound) => {
                    const color = colorFor(sound.id, data);
                    const selected = selectedSound === sound.id;
                    return (
                      <button
                        key={sound.id}
                        className={`lab-se-lane-label ${selected ? 'selected' : ''}`}
                        style={{ height: LANE_HEIGHT, color: selected ? color : undefined }}
                        onClick={() => setSelectedSound(selected ? null : sound.id)}
                      >
                        <span className="lab-se-lane-dot" style={{ background: color }} />
                        {sound.label || `Sound ${sound.id + 1}`}
                      </button>
                    );
                  })}
                </div>
                <div className="lab-se-track-canvas">
                  <canvas
                    ref={lanesCanvasRef}
                    className="lab-se-lanes" aria-label={`${part.name} sound events`}
                    style={{ height: lanesHeight }}
                    onClick={handleLanesClick}
                  />
                </div>
              </div>
            </div>

            <div className="lab-se-timebase">
              <div className="lab-se-gutter-spacer" />
              <div className="lab-se-timebalab-se-canvases">
                <canvas ref={rulerCanvasRef} className="lab-se-ruler" style={{ height: RULER_HEIGHT }} />
                <canvas
                  ref={minimapCanvasRef}
                  className="lab-se-minimap"
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

            <div className="lab-se-hint">
              Drag on the waveform to add selections · drag selection handles or body to edit · scroll horizontally · pinch to zoom · click a marker
              to audition · ⌥-click a marker to delete it
            </div>
          </div>

          <aside className="lab-se-sidebar">
            <h3 className="lab-se-sidebar-title">Stem sounds</h3>
            <p className="lab-se-sidebar-sub">
              {data.sounds.length} sounds · {data.events.length} events
            </p>
            {data.sounds.map((sound) => {
              const color = colorFor(sound.id, data);
              const selected = selectedSound === sound.id;
              return (
                <div
                  key={sound.id}
                  className={`lab-se-side-sound ${selected ? 'selected' : ''}`}
                  style={selected ? { borderColor: hexWithAlpha(color, 0.7) } : undefined}
                  onClick={() => setSelectedSound(selected ? null : sound.id)}
                >
                  <span className="lab-se-side-pill" style={{ background: color }}>
                    {sound.label || `Sound ${sound.id + 1}`}
                  </span>
                  <span className="lab-se-side-meta">
                    {(sound.end - sound.start).toFixed(2)}s · {eventCounts.get(sound.id) ?? 0} hits
                  </span>
                  <div className="lab-se-side-actions">
                    <button
                      className="lab-se-tool"
                      title="Audition this sound's clip"
                      onClick={(e) => {
                        e.stopPropagation();
                        playRange(sound.start, sound.end - sound.start);
                      }}
                    >
                      ▶
                    </button>
                    <select
                      className="lab-se-side-merge"
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
                            {`→ ${other.label || `Sound ${other.id + 1}`}`}
                          </option>
                        ))}
                    </select>
                    <button
                      className="lab-se-tool danger"
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
        <footer className="lab-se-transport">
          <div className="lab-se-timecode-chip">
            <span className="lab-se-time-now">{formatTime(playhead)}</span>
            <span className="lab-se-time-total">/ {formatTime(duration)}</span>
          </div>

          <div className="lab-se-transport-center">
            <button className="lab-se-skip" onClick={() => seekBy(-5)} title="Back 5 seconds">
              ◂◂
            </button>
            <button
              className="lab-se-play"
              onClick={() => (playing ? stopPlayback() : playRange(playhead))}
              title={playing ? 'Stop' : 'Play from playhead'}
            >
              {playing ? '❚❚' : '▶'}
            </button>
            <button className="lab-se-skip" onClick={() => seekBy(5)} title="Forward 5 seconds">
              ▸▸
            </button>
          </div>

          <div className="lab-se-zoom-slider">
            <button className="lab-se-zoom-step" onClick={() => zoomAround(playhead, 1.4)} title="Zoom out">
              −
            </button>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.min(Math.max(zoomValue, 0), 100)}
              onChange={(e) => handleZoomSlider(Number(e.target.value))}
            />
            <button className="lab-se-zoom-step" onClick={() => zoomAround(playhead, 0.7)} title="Zoom in">
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
