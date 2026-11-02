"""Rebuild reference stems for a user-corrected assignment, without rediscovery.

Only the imported mixture and accepted note/voice assignments are inputs. Synth
controls are preserved; changing a playable patch does not redefine the recorded
instrument's spectral identity. The caller publishes these files atomically.
"""

import argparse
from copy import deepcopy
import json
from pathlib import Path

import numpy as np
from scipy import signal
import soundfile as sf

from analyze import SR, FFT, HOP, extract_references


def reextract(source, result, directory):
    audio, rate = sf.read(source, always_2d=True, dtype="float32")
    if rate != SR:
        audio = signal.resample_poly(audio, SR, rate, axis=0)
    mono = audio.mean(axis=1)
    parts = deepcopy(result["parts"])
    for part in parts:
        part["patch"] = part.get(
            "referencePatch", part.get("automaticPatch", part["patch"])
        )
    # Use the actual assigned pitches, including manually entered low/high notes.
    pitches = np.array(sorted({n["pitch"] for p in parts for n in p["notes"]}) or [60])
    _, times, spectrum = signal.stft(
        mono, fs=SR, nperseg=FFT, noverlap=FFT - HOP, boundary="zeros"
    )
    magnitude = abs(spectrum).astype(np.float32)
    weight = (
        1
        / np.maximum(
            np.mean(magnitude, axis=1), max(float(magnitude.max()) * 0.0008, 1e-10)
        )
        ** 0.35
    )
    weight[:4] = 0
    residual = extract_references(
        parts,
        mono,
        times,
        spectrum,
        magnitude * weight[:, None],
        weight,
        directory,
        pitches=pitches,
        calibrate=False,
    )
    for original, extracted in zip(result["parts"], parts):
        original["referenceFile"] = extracted["referenceFile"]
    result["referenceRevision"] = {
        "method": "accepted-note-masks",
        "spectralResidual": round(residual, 4),
    }
    (directory / "result.json").write_text(json.dumps(result, indent=2))
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--document", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    folder = Path(args.output)
    folder.mkdir(parents=True, exist_ok=True)
    reextract(args.input, json.loads(Path(args.document).read_text()), folder)
