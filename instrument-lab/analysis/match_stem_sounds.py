# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = [
#   "librosa>=0.10",
#   "soundfile",
#   "numpy",
# ]
# ///
"""Find full-stem occurrences of user-selected sound clips.

This is intentionally separate from analyze_stem_sounds.py. The analyzer
bootstraps candidate sounds before the user edits anything; this matcher uses
the user's saved regions as templates and rebuilds lesson event timings by
searching the full stem for similar audio.

Output JSON on stdout:
  {"events": [{"time": 10.79, "sound": 6, "velocity": 100, "duration": 3.85}, ...]}
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np

HOP_LENGTH = 1024
N_FFT = 4096
N_MELS = 48
MIN_TEMPLATE_SEC = 0.08
MIN_EVENT_GAP_SEC = 0.18
MIN_SCORE = 0.66
SCORE_RATIO = 0.72
PERCENTILE_GATE = 99.55
MAX_SENSITIVITY = 2.0


def round4(value: float) -> float:
    return round(float(value), 4)


def frame_for_time(seconds: float, sr: int) -> int:
    return int(round(seconds * sr / HOP_LENGTH))


def time_for_frame(frame: int, sr: int) -> float:
    return frame * HOP_LENGTH / sr


def local_rms(y: np.ndarray, start: int, length: int) -> float:
    segment = y[max(0, start) : max(0, start) + max(1, length)]
    if len(segment) == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(segment))))


def build_features(y: np.ndarray, sr: int) -> np.ndarray:
    import librosa

    mel = librosa.feature.melspectrogram(
        y=y,
        sr=sr,
        n_fft=N_FFT,
        hop_length=HOP_LENGTH,
        n_mels=N_MELS,
        fmin=50,
        fmax=min(sr / 2, 9000),
        power=2.0,
    )
    return librosa.power_to_db(mel, ref=np.max)


def standardize(features: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    mean = features.mean(axis=1, keepdims=True)
    std = features.std(axis=1, keepdims=True)
    return (features - mean) / np.maximum(std, 1e-6), mean, std


def energy_weights(y: np.ndarray, sr: int, start_sec: float, duration_sec: float, frames: int) -> np.ndarray:
    start = int(start_sec * sr)
    length = max(1, int(duration_sec * sr))
    segment = y[start : start + length]
    if len(segment) == 0:
        return np.ones(frames, dtype=np.float32)

    frame_length = max(HOP_LENGTH, int(0.035 * sr))
    weights = []
    for frame in range(frames):
        i = frame * HOP_LENGTH
        chunk = segment[i : i + frame_length]
        if len(chunk) == 0:
            weights.append(0.0)
        else:
            weights.append(float(np.sqrt(np.mean(np.square(chunk)))))
    arr = np.asarray(weights, dtype=np.float32)
    if arr.max() <= 1e-8:
        return np.ones(frames, dtype=np.float32)

    gate = max(float(np.percentile(arr, 35)), float(arr.max() * 0.08))
    arr = np.clip((arr - gate) / max(float(arr.max() - gate), 1e-8), 0.0, 1.0)
    arr = 0.15 + 0.85 * arr
    return arr.astype(np.float32)


def score_template(stem_features: np.ndarray, template: np.ndarray, weights: np.ndarray) -> np.ndarray:
    frames = template.shape[1]
    available = stem_features.shape[1] - frames + 1
    if available <= 0:
        return np.asarray([], dtype=np.float32)

    weighted_template = template * weights[None, :]
    template_norm = float(np.linalg.norm(weighted_template))
    if template_norm <= 1e-8:
        return np.asarray([], dtype=np.float32)

    scores = np.empty(available, dtype=np.float32)
    for idx in range(available):
        window = stem_features[:, idx : idx + frames] * weights[None, :]
        denom = float(np.linalg.norm(window)) * template_norm
        scores[idx] = float(np.sum(window * weighted_template) / denom) if denom > 1e-8 else -1.0
    return scores


def sensitivity_thresholds(sensitivity: float) -> tuple[float, float, float]:
    amount = np.clip(sensitivity, 1.0, MAX_SENSITIVITY) - 1.0
    min_score = max(0.52, MIN_SCORE - amount * 0.11)
    score_ratio = max(0.56, SCORE_RATIO - amount * 0.14)
    percentile_gate = max(97.85, PERCENTILE_GATE - amount * 1.75)
    return min_score, score_ratio, percentile_gate


def pick_peaks(
    scores: np.ndarray,
    selected_frame: int,
    duration_sec: float,
    sr: int,
    sensitivity: float,
) -> list[tuple[int, float]]:
    if scores.size == 0:
        return []

    min_score, score_ratio, percentile_gate = sensitivity_thresholds(sensitivity)
    max_score = float(np.max(scores))
    dynamic = max(
        min_score,
        max_score * score_ratio,
        float(np.percentile(scores, percentile_gate)),
    )
    min_distance = max(1, frame_for_time(max(duration_sec * 0.45, MIN_EVENT_GAP_SEC), sr))
    candidate_frames = []

    for idx, score in enumerate(scores):
        if score < dynamic:
            continue
        left = scores[idx - 1] if idx > 0 else -np.inf
        right = scores[idx + 1] if idx + 1 < scores.size else -np.inf
        if score >= left and score >= right:
            candidate_frames.append((idx, float(score)))

    selected_frame = int(np.clip(selected_frame, 0, scores.size - 1))
    selected_score = float(scores[selected_frame])
    if selected_score >= max(min_score * 0.85, max_score * 0.55):
        candidate_frames.append((selected_frame, selected_score))

    candidate_frames.sort(key=lambda item: item[1], reverse=True)
    kept: list[tuple[int, float]] = []
    for frame, score in candidate_frames:
        if all(abs(frame - other) >= min_distance for other, _ in kept):
            kept.append((frame, score))
    kept.sort(key=lambda item: item[0])
    return kept


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, help="stem wav")
    parser.add_argument("--sounds", required=True, help="JSON file with selected sounds")
    parser.add_argument(
        "--sensitivity",
        type=float,
        default=1.0,
        help="similarity sensitivity from 1.0 to 2.0; higher finds more matches",
    )
    args = parser.parse_args()

    stem_path = Path(args.input)
    sounds_path = Path(args.sounds)
    if not stem_path.is_file():
        print(json.dumps({"error": f"Input not found: {stem_path}"}))
        return 1
    if not sounds_path.is_file():
        print(json.dumps({"error": f"Sounds JSON not found: {sounds_path}"}))
        return 1

    import soundfile as sf

    stereo, sr = sf.read(str(stem_path), always_2d=True)
    y = stereo.mean(axis=1).astype(np.float32)
    duration = len(y) / sr
    sounds = json.loads(sounds_path.read_text())

    full_features, mean, std = standardize(build_features(y, sr))
    events = []

    for sound in sounds:
        start = float(sound["start"])
        end = float(sound["end"])
        sound_id = int(sound["id"])
        template_duration = max(end - start, MIN_TEMPLATE_SEC)
        sample_start = max(0, int(start * sr))
        sample_end = min(len(y), max(sample_start + 1, int(end * sr)))
        template_y = y[sample_start:sample_end]
        if len(template_y) / sr < MIN_TEMPLATE_SEC:
            continue

        template_features = (build_features(template_y, sr) - mean) / np.maximum(std, 1e-6)
        template_frames = template_features.shape[1]
        if template_frames < 1 or template_frames > full_features.shape[1]:
            continue

        weights = energy_weights(y, sr, start, template_duration, template_frames)
        scores = score_template(full_features, template_features, weights)
        peaks = pick_peaks(scores, frame_for_time(start, sr), template_duration, sr, args.sensitivity)

        template_rms = max(local_rms(y, sample_start, sample_end - sample_start), 1e-6)
        selected_frame = frame_for_time(start, sr)
        for frame, score in peaks:
            event_time = start if abs(frame - selected_frame) <= 1 else time_for_frame(frame, sr)
            if event_time >= duration:
                continue
            candidate_rms = local_rms(y, int(event_time * sr), sample_end - sample_start)
            velocity = int(round(48 + np.clip(candidate_rms / template_rms, 0.0, 1.0) * 79))
            events.append(
                {
                    "time": round4(event_time),
                    "sound": sound_id,
                    "velocity": int(np.clip(velocity, 1, 127)),
                    "duration": round4(min(template_duration, max(duration - event_time, MIN_TEMPLATE_SEC))),
                    "score": round(float(score), 4),
                }
            )

    events.sort(key=lambda event: (event["time"], event["sound"]))
    print(json.dumps({"events": events}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        sys.exit(1)
