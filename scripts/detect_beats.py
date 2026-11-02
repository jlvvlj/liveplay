# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = [
#   "beat-this==1.1.0",
#   "torch==2.5.1",
#   "torchaudio==2.5.1",
#   "soundfile",
#   "numpy",
# ]
# ///
"""Detect the song-wide beat grid (beats + downbeats) on the full mix.

Uses Beat This! (CPJKU, ISMIR 2024), a transformer beat/downbeat tracker.
Run once per song on the full mix so every stem lesson shares one tempo and
one grid instead of each stem estimating its own.

The model reports beats on a 20ms frame grid, which makes consecutive beat
intervals jitter (e.g. 640/660/680ms on a steady song) and biases a median
tempo estimate. Each beat is therefore replaced by a local linear fit over
its neighbours (segments split at missed/extra beats), which removes the
frame quantization while following real tempo drift. Phase is left to the
charting stage, which aligns the grid to each stem's own onsets.

Output JSON on stdout:
  {"bpm": 90.7, "beatsPerBar": 4, "firstDownbeat": 0.37,
   "beats": [0.37, 1.03, ...], "downbeats": [0.37, 3.02, ...]}
"""

import argparse
import contextlib
import json
import sys
from pathlib import Path

import numpy as np

SMOOTH_HALF_WINDOW = 8  # beats on each side in the local linear fit


def smooth_beats(beats: np.ndarray) -> np.ndarray:
    """Local linear fit of beat time vs beat index, within steady segments."""
    if len(beats) < 3:
        return beats
    diffs = np.diff(beats)
    median = float(np.median(diffs))
    # split where a beat was missed or an extra one detected
    breaks = np.nonzero((diffs > 1.5 * median) | (diffs < 0.5 * median))[0] + 1
    smoothed = beats.copy()
    for segment in np.split(np.arange(len(beats)), breaks):
        if len(segment) < 3:
            continue
        for k, i in enumerate(segment):
            lo = max(0, k - SMOOTH_HALF_WINDOW)
            hi = min(len(segment), k + SMOOTH_HALF_WINDOW + 1)
            idx = segment[lo:hi]
            slope, intercept = np.polyfit(idx.astype(float), beats[idx], 1)
            smoothed[i] = intercept + slope * i
    return smoothed


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, help="full mix audio file")
    parser.add_argument("--device", default="cpu")
    args = parser.parse_args()

    if not Path(args.input).is_file():
        print(json.dumps({"error": f"Input not found: {args.input}"}))
        return 1

    import soundfile as sf
    from beat_this.inference import Audio2Beats

    signal, sr = sf.read(args.input, always_2d=True)
    mono = signal.mean(axis=1).astype(np.float32)

    # the library may print progress/download info; keep stdout clean for JSON
    with contextlib.redirect_stdout(sys.stderr):
        audio2beats = Audio2Beats(checkpoint_path="final0", device=args.device, dbn=False)
        beats, downbeats = audio2beats(mono, sr)

    raw_beats = np.asarray(beats, dtype=float)
    raw_downbeats = np.asarray(downbeats, dtype=float)
    if len(raw_beats) < 4:
        print(json.dumps({"error": "Too few beats detected to establish a tempo"}))
        return 1

    beats = smooth_beats(raw_beats)
    # downbeats are a subset of beats: map each to its refined beat
    downbeats = np.array([beats[int(np.argmin(np.abs(raw_beats - d)))] for d in raw_downbeats])

    bpm = 60.0 / float(np.median(np.diff(beats)))
    if len(downbeats) >= 2:
        per_bar = [int(np.sum((beats >= a) & (beats < b))) for a, b in zip(downbeats, downbeats[1:])]
        beats_per_bar = int(np.median(per_bar))
    else:
        beats_per_bar = 4

    print(
        json.dumps(
            {
                "bpm": round(bpm, 2),
                "beatsPerBar": beats_per_bar,
                "firstDownbeat": round(float(downbeats[0]), 4) if len(downbeats) else round(float(beats[0]), 4),
                "beats": [round(float(t), 4) for t in beats],
                "downbeats": [round(float(t), 4) for t in downbeats],
            }
        )
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        sys.exit(1)
