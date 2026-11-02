# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = [
#   "librosa>=0.10",
#   "soundfile",
#   "numpy",
#   "scikit-learn",
# ]
# ///
"""Category-free analysis of a stem: find its distinct repeated sounds.

No instrument taxonomy, no MIDI semantics. The stem is reduced to:
  - N distinct "sounds" (clusters of similar onsets), each with an exemplar
    audio clip sliced from the stem itself, ordered from bassiest to
    brightest;
  - a list of events: at which second which sound occurs, and how hard.

Works on any stem (drums, bass, synths, chops...). Weakest on legato
vocals, where onsets are soft by nature.

Output JSON on stdout:
  {"duration": 155.1,
   "sounds": [{"id": 0, "clip": "sound-0.wav", "centroidHz": 92.0}, ...],
   "events": [{"time": 0.52, "sound": 0, "velocity": 104}, ...]}
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np

MAX_SOUNDS = 8
MIN_CLIP_SEC = 0.12
MAX_CLIP_SEC = 1.5
TARGET_RMS = 0.18
PEAK_CEILING = 0.95
FEATURE_WINDOW_SEC = 0.10


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, help="stem wav")
    parser.add_argument("--output", required=True, help="directory for sound clips")
    parser.add_argument("--max-sounds", type=int, default=MAX_SOUNDS)
    args = parser.parse_args()

    if not Path(args.input).is_file():
        print(json.dumps({"error": f"Input not found: {args.input}"}))
        return 1

    import librosa
    import soundfile as sf
    from sklearn.cluster import KMeans
    from sklearn.metrics import silhouette_score
    from sklearn.preprocessing import StandardScaler

    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    stereo, sr = sf.read(args.input, always_2d=True)  # (samples, channels)
    y = stereo.mean(axis=1)
    duration = len(y) / sr
    hop = 512

    onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
    onset_frames = librosa.onset.onset_detect(
        onset_envelope=onset_env, sr=sr, hop_length=hop, backtrack=False, delta=0.05, wait=3
    )
    # backtracked frames mark the start of each rise: best slice/trigger points
    starts = librosa.onset.onset_backtrack(onset_frames, onset_env)
    if len(onset_frames) < 2:
        print(json.dumps({"error": "Too few sound events detected in this stem"}))
        return 1

    times = librosa.frames_to_time(starts, sr=sr, hop_length=hop)
    tempo, _ = librosa.beat.beat_track(onset_envelope=onset_env, sr=sr, hop_length=hop)
    bpm = float(np.atleast_1d(tempo)[0]) or 120.0

    # --- per-onset sound fingerprint: timbre (MFCC) + pitch (chroma) + brightness
    window = int(FEATURE_WINDOW_SEC * sr)
    features = []
    centroids = []
    for frame_start in starts:
        i = frame_start * hop
        seg = y[i : i + window]
        if len(seg) < window:
            seg = np.pad(seg, (0, window - len(seg)))
        mfcc = librosa.feature.mfcc(y=seg, sr=sr, n_mfcc=13).mean(axis=1)
        chroma = librosa.feature.chroma_stft(y=seg, sr=sr).mean(axis=1)
        centroid = float(librosa.feature.spectral_centroid(y=seg, sr=sr).mean())
        centroids.append(centroid)
        features.append(np.concatenate([mfcc, chroma * 8.0, [np.log1p(centroid)]]))
    matrix = StandardScaler().fit_transform(np.array(features))

    # --- how many distinct sounds? pick k by silhouette
    best_k, best_score, best_labels = 1, -1.0, np.zeros(len(matrix), dtype=int)
    for k in range(2, min(args.max_sounds, len(matrix) - 1) + 1):
        km = KMeans(n_clusters=k, n_init=4, random_state=0).fit(matrix)
        score = silhouette_score(matrix, km.labels_)
        if score > best_score:
            best_k, best_score, best_labels = k, score, km.labels_

    # --- relabel clusters from bassiest to brightest for natural lane order
    centroids = np.array(centroids)
    order = sorted(range(best_k), key=lambda c: float(centroids[best_labels == c].mean()))
    relabel = {old: new for new, old in enumerate(order)}
    labels = np.array([relabel[l] for l in best_labels])

    # --- velocity from onset strength
    strengths = onset_env[onset_frames]
    ref = np.percentile(strengths, 95) if len(strengths) else 1.0
    velocities = (40 + np.clip(strengths / max(ref, 1e-9), 0, 1) * 87).astype(int)

    # --- exemplar clip per sound: energetic occurrence with room before the next onset
    sample_starts = starts * hop
    sounds = []
    for cluster in range(best_k):
        indices = np.nonzero(labels == cluster)[0]

        def gap_after(idx: int) -> float:
            here = times[idx]
            later = times[idx + 1] if idx + 1 < len(times) else duration
            return later - here

        exemplar = max(indices, key=lambda i: (min(gap_after(i), MAX_CLIP_SEC), velocities[i]))
        start = int(sample_starts[exemplar])
        length = int(min(max(gap_after(exemplar), MIN_CLIP_SEC), MAX_CLIP_SEC) * sr)
        clip = stereo[start : start + length].copy()  # (samples, channels)
        fade = max(int(len(clip) * 0.25), 1)
        clip[-fade:] *= np.linspace(1.0, 0.0, fade)[:, None]
        peak = np.abs(clip).max()
        if peak < 1e-4:
            continue
        rms = float(np.sqrt(np.mean(clip**2)))
        clip *= min(TARGET_RMS / max(rms, 1e-9), PEAK_CEILING / peak)
        filename = f"sound-{cluster}.wav"
        sf.write(str(output_dir / filename), clip, sr, subtype="PCM_16")
        sounds.append(
            {
                "id": cluster,
                "clip": filename,
                "centroidHz": round(float(centroids[labels == cluster].mean()), 1),
                # clip region within the stem, editable later in the sound editor
                "start": round(start / sr, 4),
                "end": round((start + len(clip)) / sr, 4),
            }
        )

    sound_durations = {s["id"]: max(s["end"] - s["start"], MIN_CLIP_SEC) for s in sounds}
    valid_ids = set(sound_durations.keys())
    # Each event carries a slice length. Use the assigned sound's editable clip
    # length so sustained sources such as vocals are not cut off by nearby onsets.
    events = []
    for i in range(len(times)):
        if labels[i] not in valid_ids:
            continue
        event_duration = min(sound_durations[int(labels[i])], duration - float(times[i]))
        events.append(
            {
                "time": round(float(times[i]), 4),
                "sound": int(labels[i]),
                "velocity": int(velocities[i]),
                "duration": round(float(max(event_duration, MIN_CLIP_SEC)), 4),
            }
        )

    print(
        json.dumps(
            {"bpm": round(bpm, 2), "duration": round(duration, 2), "sounds": sounds, "events": events}
        )
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        sys.exit(1)
