"""Score model outputs against held-out stems; never feeds truth into inference.

Numerical thresholds are proposed engineering gates, not perceptual similarity
percentages. Passing this prompted benchmark cannot validate automatic discovery,
stereo preservation, patch fitting, or production integration.
"""

import argparse
import json
import math
from pathlib import Path
import sys

import numpy as np
import soundfile as sf
from scipy import signal
from scipy.optimize import linear_sum_assignment

RATE = 24000
REQUIRED_CASES = {"distinct-duet", "chords-and-drums", "similar-overlapping-synths", "absent-target", "full-length-arrangement"}


def load(path):
    audio, rate = sf.read(path, dtype="float32", always_2d=True)
    if not len(audio) or not np.isfinite(audio).all():
        raise ValueError("Invalid waveform")
    if rate != RATE:
        divisor = math.gcd(rate, RATE)
        audio = signal.resample_poly(audio, RATE // divisor, rate // divisor, axis=0)
    return audio


def power(x):
    return float(np.mean(np.square(x, dtype=np.float64)))


def level_db(x, y):
    return float(10 * np.log10(max(power(x), 1e-12) / max(power(y), 1e-12)))


def spectrum(x):
    return abs(signal.stft(x, nperseg=1024, noverlap=768)[2]).astype(np.float32)


def spectral_error(predicted, target):
    # No level normalization: lost or added signal energy must remain visible.
    a, b = spectrum(predicted), spectrum(target)
    return float(np.linalg.norm(a - b) / max(np.linalg.norm(b), 1e-9))


def si_sdr(predicted, target):
    a = predicted.astype(np.float64) - np.mean(predicted)
    b = target.astype(np.float64) - np.mean(target)
    projection = b * (a @ b) / max(b @ b, 1e-12)
    return float(10 * np.log10(max(projection @ projection, 1e-12) / max((a - projection) @ (a - projection), 1e-12)))


def note_metrics(predicted, truth):
    if not predicted or not truth:
        return dict(f1=1.0 if not predicted and not truth else 0.0, matched=0, expected=len(truth), detected=len(predicted), meanOnsetErrorMs=None)
    costs = np.full((len(predicted), len(truth)), 1e6)
    for i, p in enumerate(predicted):
        for j, t in enumerate(truth):
            error = abs(p["start"] - t["start"])
            if p["pitch"] == t["pitch"] and error <= 0.05:
                costs[i, j] = error
    rows, columns = linear_sum_assignment(costs)
    pairs = [(i, j) for i, j in zip(rows, columns) if costs[i, j] < 1e6]
    errors = [float(costs[i, j]) for i, j in pairs]
    offsets = [abs(predicted[i]["end"] - truth[j]["end"]) for i, j in pairs
               if "end" in predicted[i] and "end" in truth[j]]
    return dict(f1=2 * len(errors) / (len(predicted) + len(truth)), matched=len(errors),
                expected=len(truth), detected=len(predicted),
                meanOnsetErrorMs=float(np.mean(errors) * 1000) if errors else None,
                meanOffsetErrorMs=float(np.mean(offsets) * 1000) if offsets else None)


def measure(predicted, target, mixture, expected_present=True):
    if len(predicted) != len(target) or len(mixture) != len(target):
        raise ValueError("Output duration differs from the reference; truncation is not scored as success")
    p, t, m = [x.mean(axis=1) for x in [predicted, target, mixture]]
    if not expected_present:
        db = level_db(p, m)
        return dict(absentTargetLevelDb=db, audioGate=db <= -30)
    error = spectral_error(p, t)
    level = level_db(p, t)
    # Per-window diagnostics reveal identity loss after an instrument returns.
    intervals = []
    for lo in range(0, len(t), 5 * RATE):
        hi = min(len(t), lo + 5 * RATE)
        if hi - lo < 1024:
            continue
        active = power(t[lo:hi]) > max(power(t) * 0.001, 1e-10)
        intervals.append(dict(start=lo / RATE, end=hi / RATE, active=active,
                              spectralError=spectral_error(p[lo:hi], t[lo:hi]) if active else None,
                              outputVsMixtureDb=level_db(p[lo:hi], m[lo:hi]),
                              quietOutput=power(p[lo:hi]) <= 1e-10))
    return dict(spectralError=error, levelErrorDb=level, siSdrDb=si_sdr(p, t),
                siSdrImprovementDb=si_sdr(p, t) - si_sdr(m, t),
                intervals=intervals, audioGate=(error <= 0.35 and abs(level) <= 3 and
                    all(w["spectralError"] <= 0.5 if w["active"] else w["quietOutput"] or w["outputVsMixtureDb"] <= -25 for w in intervals)))


def score(truth_path, output, notes=False):
    truth = json.loads(truth_path.read_text())["sources"]
    run = json.loads((output / "run.json").read_text())
    completed = {j["id"]: j for j in run["jobs"]}
    report = dict(model=run.get("model"), modelRevision=run.get("modelRevision"),
                  runStatus=run["status"], sources=[], missing=[],
                  automaticDiscoveryValidated=False, stereoPreserved=False,
                  productionReady=False)
    propose = None
    if notes:
        sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "analysis"))
        from pitch_support import propose
    mix_sums = {}
    for expected in truth:
        identifier = expected["id"]
        if identifier not in completed:
            report["missing"].append(identifier)
            continue
        actual = completed[identifier]
        predicted = load(output / actual["target"])
        target = load(truth_path.parent / expected["target"])
        mixture = load(truth_path.parent / expected["input"])
        row = dict(id=identifier, case=expected["case"], seconds=actual["seconds"],
                   inputChannels=mixture.shape[1], outputChannels=predicted.shape[1],
                   **measure(predicted, target, mixture, expected["expectedPresent"]))
        if expected["expectedPresent"]:
            entry = mix_sums.setdefault(expected["case"], dict(predicted=np.zeros(len(mixture), dtype=np.float32), mixture=mixture.mean(axis=1)))
            entry["predicted"] += predicted.mean(axis=1)
        if propose and expected["kind"] != "kick":
            row["notes"] = note_metrics(propose(output / actual["target"]), expected["notes"])
        report["sources"].append(row)
    report["summedStems"] = [dict(case=case, monoSpectralError=spectral_error(entry["predicted"], entry["mixture"]),
                                 levelErrorDb=level_db(entry["predicted"], entry["mixture"]))
                             for case, entry in mix_sums.items()]
    coverage = {s["case"] for s in report["sources"]}
    report["missingCases"] = sorted(REQUIRED_CASES - coverage)
    report["promptedAudioGate"] = bool(run["status"] == "finished" and not report["missing"] and not report["missingCases"] and report["sources"] and all(s["audioGate"] for s in report["sources"]))
    note_rows = [s["notes"] for s in report["sources"] if "notes" in s]
    report["noteGate"] = all(n["f1"] >= 0.9 for n in note_rows) if notes and note_rows else None
    report["remainingValidation"] = ["automatic source discovery and count", "stereo preservation", "stem-to-patch reconstruction", "listening review", "real-song full-length identity", "browser integration"]
    (output / "scores.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("truth", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--notes", action="store_true")
    args = parser.parse_args()
    result = score(args.truth, args.output, args.notes)
    print(json.dumps({k: v for k, v in result.items() if k != "sources"}, indent=2))
