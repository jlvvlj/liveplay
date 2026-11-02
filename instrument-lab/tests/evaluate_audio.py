"""Measure isolation and reconstruction against independent isolated sources.

SI-SDR is appropriate for phase-preserving reference stems. Synth waveforms
may have different phase, so their comparison uses magnitude spectra instead.
These are engineering diagnostics, not perceptual similarity percentages.
"""

import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy import signal
from scipy.optimize import linear_sum_assignment

from evaluate import matches


def load(path):
    y, rate = sf.read(path)
    if y.ndim > 1:
        y = y.mean(axis=1)
    if rate != 22050:
        y = signal.resample_poly(y, 22050, rate)
    return y


def si_sdr(prediction, target):
    prediction = prediction - np.mean(prediction)
    target = target - np.mean(target)
    projection = target * (prediction @ target) / max(target @ target, 1e-12)
    error = prediction - projection
    return float(
        10 * np.log10(max(projection @ projection, 1e-12) / max(error @ error, 1e-12))
    )


def spectral_error(prediction, target):
    errors = []
    for window in [512, 2048, 4096]:
        _, _, actual = signal.stft(prediction, nperseg=window)
        _, _, expected = signal.stft(target, nperseg=window)
        actual, expected = abs(actual), abs(expected)
        # Remove a constant level difference, reported separately below.
        scale = np.sum(actual * expected) / max(np.sum(actual**2), 1e-12)
        errors.append(
            float(
                np.linalg.norm(actual * scale - expected)
                / max(np.linalg.norm(expected), 1e-12)
            )
        )
    return float(np.mean(errors))


def evaluate(result_path, truth_path, render_folder):
    result = json.loads(result_path.read_text())
    truth = json.loads(truth_path.read_text())
    prefix = str(truth_path).removesuffix("-truth.json")
    mix = load(prefix + ".wav")
    counts = np.array(
        [
            [matches(p["notes"], t["notes"])[0] for t in truth["parts"]]
            for p in result["parts"]
        ]
    )
    rows, columns = linear_sum_assignment(-counts)
    details = []
    for i, j in zip(rows, columns):
        part = result["parts"][i]
        original = load(prefix + f"-source-{j}.wav")
        reference = load(result_path.parent / part["referenceFile"])
        synth = load(render_folder / (part["id"] + "-synth.wav"))
        length = min(len(original), len(reference), len(synth), len(mix))
        original, reference, synth = (
            original[:length],
            reference[:length],
            synth[:length],
        )
        baseline = si_sdr(mix[:length], original)
        isolation = si_sdr(reference, original)
        level = 10 * np.log10(
            max(np.mean(synth**2), 1e-12) / max(np.mean(original**2), 1e-12)
        )
        # Gated pulse fixtures contain DC/very-low-frequency energy that the
        # zero-mean synth deliberately does not reproduce. Keep the raw metric
        # and separately compare both signals through the same 20 Hz high-pass.
        highpass = signal.butter(2, 20, fs=22050, btype="highpass", output="sos")
        audible_error = spectral_error(
            signal.sosfiltfilt(highpass, synth),
            signal.sosfiltfilt(highpass, original),
        )
        details.append(
            dict(
                expected=truth["parts"][j]["name"],
                instrument=part["id"],
                stemSiSdrDb=round(isolation, 2),
                isolationImprovementDb=round(isolation - baseline, 2),
                synthSpectralError=round(spectral_error(synth, original), 4),
                highPassedSpectralError=round(audible_error, 4),
                synthLevelErrorDb=round(float(level), 2),
            )
        )
    return details


if __name__ == "__main__":
    print(json.dumps(evaluate(*(Path(p) for p in sys.argv[1:4])), indent=2))
