# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = [
#   "librosa>=0.10",
#   "soundfile",
#   "numpy",
# ]
# ///
"""Score how faithfully a stem-lesson reconstructs its stem.

Renders the lesson's events two ways and compares each against the original
stem with perception-oriented metrics:

  - exemplar mode: every event plays its cluster's exemplar clip (legacy)
  - slice mode:    every event plays its own region of the stem
                   (events need a "duration" field; offset = event time)

Metrics (higher = closer):
  - mel_similarity: correlation of log-mel spectrograms (timbre+time match)
  - envelope_correlation: correlation of 50ms loudness envelopes

Usage:
  uv run --script scripts/score_reconstruction.py \
    --stem audio/stems/<id>/drums.wav \
    --lesson audio/stems/<id>/stem-lesson-drums.json \
    [--audio-root audio] [--save-dir <dir>]
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np


def render_exemplar(lesson: dict, clips: dict, length: int, sr: int, channels: int) -> np.ndarray:
    out = np.zeros((length, channels))
    for event in lesson["events"]:
        clip = clips.get(event["sound"])
        if clip is None:
            continue
        start = int(event["time"] * sr)
        end = min(start + len(clip), length)
        if end > start:
            out[start:end] += clip[: end - start] * (event["velocity"] / 127.0)
    return out


def render_slices(lesson: dict, stem: np.ndarray, sr: int) -> np.ndarray:
    out = np.zeros_like(stem)
    fade = int(0.03 * sr)
    for event in lesson["events"]:
        if "duration" not in event:
            continue
        start = int(event["time"] * sr)
        end = min(start + int(event["duration"] * sr), len(stem))
        if end <= start:
            continue
        seg = stem[start:end].copy()
        f = min(fade, len(seg))
        seg[-f:] *= np.linspace(1.0, 0.0, f)[:, None]
        out[start:end] += seg
    return out


def similarity(a: np.ndarray, b: np.ndarray, sr: int) -> dict:
    import librosa

    n = min(len(a), len(b))
    am, bm = a[:n].mean(axis=1), b[:n].mean(axis=1)

    def logmel(x: np.ndarray) -> np.ndarray:
        m = librosa.feature.melspectrogram(y=x, sr=sr, n_mels=64, hop_length=1024)
        return librosa.power_to_db(m, ref=np.max)

    la, lb = logmel(am), logmel(bm)
    mel_sim = float(np.corrcoef(la.flatten(), lb.flatten())[0, 1])

    win = int(0.05 * sr)
    frames = n // win

    def env(x: np.ndarray) -> np.ndarray:
        return np.log1p(np.sqrt((x[: frames * win].reshape(frames, win) ** 2).mean(axis=1)) * 100)

    env_corr = float(np.corrcoef(env(am), env(bm))[0, 1])
    return {"mel_similarity": round(mel_sim, 3), "envelope_correlation": round(env_corr, 3)}


def main() -> int:
    import soundfile as sf

    parser = argparse.ArgumentParser()
    parser.add_argument("--stem", required=True)
    parser.add_argument("--lesson", required=True)
    parser.add_argument("--audio-root", default="audio")
    parser.add_argument("--save-dir", help="also write the rendered reconstructions here")
    args = parser.parse_args()

    lesson = json.loads(Path(args.lesson).read_text())
    stem, sr = sf.read(args.stem, always_2d=True)

    clips = {}
    for sound in lesson.get("sounds", []):
        clip_path = Path(args.audio_root) / sound["clip"]
        if not clip_path.is_file():
            continue
        data, csr = sf.read(str(clip_path), always_2d=True)
        if csr != sr:  # e.g. re-sliced clips at another rate
            n_out = int(len(data) * sr / csr)
            t_old = np.linspace(0, 1, len(data))
            t_new = np.linspace(0, 1, n_out)
            data = np.stack([np.interp(t_new, t_old, data[:, c]) for c in range(data.shape[1])], axis=1)
        clips[sound["id"]] = data

    result = {"events": len(lesson["events"]), "sounds": len(lesson.get("sounds", []))}
    renders = {"exemplar": render_exemplar(lesson, clips, len(stem), sr, stem.shape[1])}
    if any("duration" in e for e in lesson["events"]):
        renders["slice"] = render_slices(lesson, stem, sr)

    for mode, rendered in renders.items():
        result[mode] = similarity(stem, rendered, sr)
        if args.save_dir:
            out_dir = Path(args.save_dir)
            out_dir.mkdir(parents=True, exist_ok=True)
            peak = np.abs(rendered).max()
            sf.write(str(out_dir / f"recon-{mode}-{Path(args.stem).stem}.wav"),
                     rendered * (0.99 / peak) if peak > 0.99 else rendered, sr, subtype="PCM_16")

    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        sys.exit(1)
