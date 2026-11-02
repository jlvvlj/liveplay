# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = [
#   "librosa>=0.10",
#   "soundfile",
#   "numpy",
# ]
# ///
"""Transcribe a separated drum stem into timed kick/snare/hihat events.

Onset detection via librosa, then each hit is classified by the energy
balance of frequency bands in a short window after the onset. Prints a
single JSON object on stdout:

  {"bpm": 120.0, "duration": 155.1,
   "events": [{"time": 0.52, "drum": "kick", "velocity": 104}, ...]}
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np


def classify_onset(y: np.ndarray, sr: int, sample_idx: int) -> str:
    """Classify a hit as kick/snare/hihat from band energies near the onset."""
    window = y[sample_idx : sample_idx + 4096]
    if len(window) < 512:
        return "snare"
    spectrum = np.abs(np.fft.rfft(window * np.hanning(len(window))))
    freqs = np.fft.rfftfreq(len(window), 1 / sr)

    def band(lo: float, hi: float) -> float:
        mask = (freqs >= lo) & (freqs < hi)
        return float(np.sum(spectrum[mask] ** 2))

    low = band(20, 150)       # kick fundamental
    mid = band(150, 2500)     # snare body + toms
    high = band(5000, 16000)  # hats / cymbals
    total = low + mid + high + 1e-12

    low_f, mid_f, high_f = low / total, mid / total, high / total
    if low_f > 0.45 and low_f >= high_f:
        return "kick"
    if high_f > 0.5 and low_f < 0.2:
        return "hihat"
    if mid_f >= 0.3:
        return "snare"
    return "hihat" if high_f > low_f else "kick"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, help="drum stem wav")
    args = parser.parse_args()

    if not Path(args.input).is_file():
        print(json.dumps({"error": f"Input not found: {args.input}"}))
        return 1

    import librosa

    y, sr = librosa.load(args.input, sr=None, mono=True)
    duration = len(y) / sr

    hop = 512
    onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
    onset_frames = librosa.onset.onset_detect(
        onset_envelope=onset_env,
        sr=sr,
        hop_length=hop,
        backtrack=False,
        delta=0.04,
        wait=2,  # >= ~23ms apart
    )
    tempo, _ = librosa.beat.beat_track(onset_envelope=onset_env, sr=sr, hop_length=hop)
    bpm = float(np.atleast_1d(tempo)[0]) or 120.0

    # Onset strength -> velocity 40..127, scaled against a robust maximum
    strengths = onset_env[onset_frames]
    ref = np.percentile(strengths, 95) if len(strengths) else 1.0
    velocities = 40 + np.clip(strengths / max(ref, 1e-9), 0, 1) * 87

    events = []
    for frame, velocity in zip(onset_frames, velocities):
        sample_idx = frame * hop
        time = sample_idx / sr
        events.append(
            {
                "time": round(float(time), 4),
                "drum": classify_onset(y, sr, sample_idx),
                "velocity": int(velocity),
            }
        )

    print(json.dumps({"bpm": round(bpm, 2), "duration": round(duration, 2), "events": events}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        sys.exit(1)
