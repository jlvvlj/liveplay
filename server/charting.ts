/**
 * Charting: turns a raw transcription (sounds + events) into a playable game
 * chart. Runs on fresh analyses only; lessons the user has edited are never
 * re-charted.
 *
 *  1. snap onsets to the song's beat grid (1/16 subdivisions), only when a
 *     hit is close to a grid point, so swing and triplets are left alone;
 *     the detected onset is kept as `audioTime` for slice playback
 *  2. fold lanes with very few hits (or beyond the lane limit) into the most
 *     similar-sounding lane; for pitched stems that is the nearest pitch,
 *     and the player pitch-shifts the lane clip to the note's own pitch
 *  3. merge same-lane double triggers and cap simultaneous notes
 *  4. cap density (notes per second), keeping on-beat and louder notes first
 *  5. renumber lanes contiguously
 */

export interface ChartSound {
  id: number;
  centroidHz: number;
  pitch?: number; // MIDI pitch of a pitched lane (its clip plays this note)
}

export interface ChartEvent {
  time: number; // chart time, seconds
  sound: number;
  velocity: number;
  audioTime?: number; // detected onset in the stem, seconds (slice offset)
  pitch?: number; // MIDI pitch of a pitched note (may differ from its lane's)
}

export interface ChartGrid {
  beats: number[]; // seconds
}

export interface ChartOptions {
  subdivisionsPerBeat: number;
  snapToleranceSec: number;
  minLaneEvents: number;
  minLaneIntervalSec: number;
  maxSimultaneous: number;
  simultaneityWindowSec: number;
  maxLanes: number;
  maxNotesPerSecond: number;
  maxFoldSemitones: number;
}

export const DEFAULT_CHART_OPTIONS: ChartOptions = {
  subdivisionsPerBeat: 4, // 16th notes
  snapToleranceSec: 0.035,
  minLaneEvents: 4,
  minLaneIntervalSec: 0.09,
  maxSimultaneous: 3,
  simultaneityWindowSec: 0.015,
  maxLanes: 8, // a pad controller's playable lanes
  maxNotesPerSecond: 8, // hardest level; difficulty levels will go lower
  // a pitched note may play its lane's clip shifted by at most this much;
  // a rare pitch that would need more is dropped instead of folded
  maxFoldSemitones: 3,
};

export interface ChartStats {
  inputEvents: number;
  phaseShiftMs: number;
  snapped: number;
  lanesFolded: number;
  notesDroppedWithLane: number;
  doubleTriggersMerged: number;
  droppedOverPolyphony: number;
  droppedOverDensity: number;
  outputEvents: number;
}

export interface ChartResult<S extends ChartSound, E extends ChartEvent> {
  sounds: S[];
  events: E[];
  idRemap: Map<number, number>; // old sound id -> new sound id (kept sounds only)
  removedSoundIds: number[];
  stats: ChartStats;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/** All 1/N grid points spanning [0, duration], extrapolated past the detected beats. */
export function gridPoints(beats: number[], subdivisions: number, duration: number): number[] {
  if (beats.length < 2) return [];
  const sorted = [...beats].sort((a, b) => a - b);
  const diffs = sorted.slice(1).map((b, i) => b - sorted[i]).sort((a, b) => a - b);
  const period = diffs[Math.floor(diffs.length / 2)];
  const points: number[] = [];

  for (let t = sorted[0] - period; t > -period; t -= period) {
    for (let k = subdivisions - 1; k >= 0; k--) {
      const p = t + (k * period) / subdivisions;
      if (p >= 0) points.push(p);
    }
  }
  for (let i = 0; i < sorted.length - 1; i++) {
    const step = (sorted[i + 1] - sorted[i]) / subdivisions;
    for (let k = 0; k < subdivisions; k++) points.push(sorted[i] + k * step);
  }
  for (let t = sorted[sorted.length - 1]; t <= duration + period; t += period) {
    for (let k = 0; k < subdivisions; k++) points.push(t + (k * period) / subdivisions);
  }
  return points.sort((a, b) => a - b);
}

function nearest(points: number[], t: number): number {
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  const candidates = [points[lo], points[lo - 1]].filter((p) => p !== undefined);
  return candidates.reduce((best, p) => (Math.abs(p - t) < Math.abs(best - t) ? p : best));
}

export function chartAnalysis<S extends ChartSound, E extends ChartEvent>(
  sounds: S[],
  events: E[],
  grid: ChartGrid,
  duration: number,
  options: ChartOptions = DEFAULT_CHART_OPTIONS
): ChartResult<S, E> {
  const stats: ChartStats = {
    inputEvents: events.length,
    phaseShiftMs: 0,
    snapped: 0,
    lanesFolded: 0,
    notesDroppedWithLane: 0,
    doubleTriggersMerged: 0,
    droppedOverPolyphony: 0,
    droppedOverDensity: 0,
    outputEvents: 0,
  };

  // 1. snap to the beat grid, keeping the detected onset for playback. The
  // grid's phase is first aligned to this stem's own onsets (median offset),
  // so snapping can't introduce a systematic lag between chart and audio.
  let points = gridPoints(grid.beats, options.subdivisionsPerBeat, duration);
  let phaseShift = 0;
  if (points.length > 0) {
    const residuals = events
      .map((e) => e.time - nearest(points, e.time))
      .filter((r) => Math.abs(r) <= options.snapToleranceSec * 2)
      .sort((a, b) => a - b);
    if (residuals.length > 0) {
      phaseShift = Math.max(-0.04, Math.min(0.04, residuals[Math.floor(residuals.length / 2)]));
      points = points.map((p) => p + phaseShift);
      stats.phaseShiftMs = Math.round(phaseShift * 10000) / 10;
    }
  }
  let charted: E[] = events.map((event) => {
    const audioTime = event.audioTime ?? event.time;
    if (points.length === 0) return { ...event, audioTime };
    const target = nearest(points, event.time);
    if (Math.abs(target - event.time) <= options.snapToleranceSec) {
      stats.snapped++;
      return { ...event, time: round4(target), audioTime };
    }
    return { ...event, audioTime };
  });

  // 2. fold lanes with very few hits into the most similar-sounding lane
  let kept = [...sounds];
  for (;;) {
    if (kept.length <= 1) break;
    const counts = new Map(kept.map((s) => [s.id, 0]));
    for (const e of charted) counts.set(e.sound, (counts.get(e.sound) ?? 0) + 1);
    const rarest = kept.reduce((a, b) => ((counts.get(a.id) ?? 0) <= (counts.get(b.id) ?? 0) ? a : b));
    if ((counts.get(rarest.id) ?? 0) >= options.minLaneEvents && kept.length <= options.maxLanes) break;
    const logHz = (s: ChartSound) => Math.log(Math.max(s.centroidHz, 1));
    const target = kept
      .filter((s) => s.id !== rarest.id)
      .reduce((a, b) => (Math.abs(logHz(a) - logHz(rarest)) <= Math.abs(logHz(b) - logHz(rarest)) ? a : b));
    const laneEvents = charted.filter((e) => e.sound === rarest.id);
    const worstShift =
      target.pitch === undefined
        ? 0
        : Math.max(0, ...laneEvents.map((e) => Math.abs((e.pitch ?? target.pitch!) - target.pitch!)));
    if (worstShift > options.maxFoldSemitones) {
      charted = charted.filter((e) => e.sound !== rarest.id);
      stats.notesDroppedWithLane += laneEvents.length;
    } else {
      charted = charted.map((e) => (e.sound === rarest.id ? { ...e, sound: target.id } : e));
      stats.lanesFolded++;
    }
    kept = kept.filter((s) => s.id !== rarest.id);
  }

  // 3a. merge same-lane double triggers: the first hit is the real attack, so
  // it keeps its timing and takes the louder of the two velocities
  const byLane = new Map<number, E[]>();
  for (const e of charted) {
    const lane = byLane.get(e.sound) ?? [];
    lane.push(e);
    byLane.set(e.sound, lane);
  }
  const deduped: E[] = [];
  for (const lane of byLane.values()) {
    lane.sort((a, b) => a.time - b.time);
    for (const e of lane) {
      const last = deduped[deduped.length - 1];
      if (last && last.sound === e.sound && e.time - last.time < options.minLaneIntervalSec) {
        stats.doubleTriggersMerged++;
        deduped[deduped.length - 1] = { ...last, velocity: Math.max(last.velocity, e.velocity) };
        continue;
      }
      deduped.push(e);
    }
  }
  deduped.sort((a, b) => a.time - b.time || a.sound - b.sound);

  // 3b. cap simultaneous notes (a pad player has limited hands)
  const output: E[] = [];
  for (let i = 0; i < deduped.length; ) {
    let j = i + 1;
    while (j < deduped.length && deduped[j].time - deduped[i].time <= options.simultaneityWindowSec) j++;
    const group = deduped.slice(i, j);
    if (group.length > options.maxSimultaneous) {
      group.sort((a, b) => b.velocity - a.velocity);
      stats.droppedOverPolyphony += group.length - options.maxSimultaneous;
      output.push(...group.slice(0, options.maxSimultaneous).sort((a, b) => a.sound - b.sound));
    } else {
      output.push(...group);
    }
    i = j;
  }

  // 4. density cap: accept notes by musical importance (downbeat-of-beat >
  // 8th > 16th > off-grid, then louder) while every 1s window stays under
  // the limit
  const shiftedBeats = [...grid.beats].sort((a, b) => a - b).map((b) => b + phaseShift);
  const metricWeight = (t: number): number => {
    if (shiftedBeats.length < 2) return 0;
    let i = 0;
    while (i < shiftedBeats.length - 2 && shiftedBeats[i + 1] <= t) i++;
    const period = shiftedBeats[i + 1] - shiftedBeats[i];
    const position = ((t - shiftedBeats[i]) / period) * options.subdivisionsPerBeat;
    const sub = Math.round(position);
    if (Math.abs(position - sub) * (period / options.subdivisionsPerBeat) > 0.002) return 0; // off-grid
    const step = ((sub % options.subdivisionsPerBeat) + options.subdivisionsPerBeat) % options.subdivisionsPerBeat;
    if (step === 0) return 3; // on the beat
    if (step * 2 === options.subdivisionsPerBeat) return 2; // 8th
    return 1; // 16th
  };
  const ranked = output
    .map((e) => ({ e, priority: metricWeight(e.time) * 1000 + e.velocity }))
    .sort((a, b) => b.priority - a.priority);
  const acceptedTimes: number[] = []; // sorted
  const countIn = (lo: number, hi: number): number => {
    const lower = (x: number) => {
      let l = 0;
      let h = acceptedTimes.length;
      while (l < h) {
        const m = (l + h) >> 1;
        if (acceptedTimes[m] < x) l = m + 1;
        else h = m;
      }
      return l;
    };
    return lower(hi) - lower(lo);
  };
  const dense: E[] = [];
  for (const { e } of ranked) {
    // every 1s window containing this note must stay under the cap
    let fits = true;
    for (let start = e.time - 1; start <= e.time; start += 0.25) {
      if (countIn(start, start + 1) >= options.maxNotesPerSecond) {
        fits = false;
        break;
      }
    }
    if (!fits) {
      stats.droppedOverDensity++;
      continue;
    }
    dense.push(e);
    const at = countIn(-Infinity, e.time);
    acceptedTimes.splice(at, 0, e.time);
  }
  dense.sort((a, b) => a.time - b.time || a.sound - b.sound);

  // 5. renumber lanes contiguously, keeping their original order
  kept.sort((a, b) => a.id - b.id);
  const idRemap = new Map(kept.map((s, index) => [s.id, index]));
  const removedSoundIds = sounds.filter((s) => !idRemap.has(s.id)).map((s) => s.id);
  const finalSounds = kept.map((s) => ({ ...s, id: idRemap.get(s.id)! }));
  const finalEvents = dense.map((e) => ({ ...e, sound: idRemap.get(e.sound)! }));

  stats.outputEvents = finalEvents.length;
  return { sounds: finalSounds, events: finalEvents, idRemap, removedSoundIds, stats };
}
