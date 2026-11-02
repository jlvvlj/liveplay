"""Independent pitched-instrument discovery. No calls to the legacy stem pipeline.

Fits a sparse spectral dictionary of synth voices, selects a variable number of
shared timbres, decodes note activity, and extracts soft-masked reference stems.
Unexplained energy is reported as uncertainty, never an 'other' instrument.
"""

import argparse
import json
import os
from pathlib import Path
import numpy as np
from scipy import signal, ndimage, optimize
import soundfile as sf
from pitch_support import propose, supported_notes

SR = 22050
FFT = 4096
HOP = 220
PITCHES = np.arange(21, 109)


def report(stage, progress, **extra):
    print(json.dumps(dict(stage=stage, progress=progress, **extra)), flush=True)


def basis(harmonics, pitches=PITCHES):
    """Magnitude response of windowed harmonic voices at MIDI pitches."""
    result = np.zeros((FFT // 2 + 1, len(pitches)), dtype=np.float32)
    for j, pitch in enumerate(pitches):
        f = 440 * 2 ** ((float(pitch) - 69) / 12)
        for h, amp in enumerate(harmonics, 1):
            if h * f >= SR * 0.45 or abs(amp) < 0.0002:
                continue
            center = h * f * FFT / SR
            bins = np.arange(
                max(0, int(center) - 5), min(FFT // 2 + 1, int(center) + 7)
            )
            x = bins - center
            kernel = np.abs(
                0.5 * np.sinc(x) + 0.25 * np.sinc(x - 1) + 0.25 * np.sinc(x + 1)
            )
            result[bins, j] += abs(amp) * kernel
    return result


FRAME_BLOCK = 1024


def frame_blocks(length):
    for start in range(0, length, FRAME_BLOCK):
        yield slice(start, min(start + FRAME_BLOCK, length))


def fit_fixed(D, V, H, iterations, penalty_ratio, prior=None):
    """Time frames are independent; retain a global penalty across blocks.

    Only scratch matrices are chunked. Instrument identities and note decoding
    still span the entire recording, including notes crossing block boundaries.
    """
    DD = D.T @ D
    peak = max(float((D.T @ V[:, block]).max()) for block in frame_blocks(V.shape[1]))
    penalty = peak * penalty_ratio
    if prior is not None:
        penalty = penalty * (1 + 3 * (1 - prior[:, None]))
    for block in frame_blocks(V.shape[1]):
        numerator = np.maximum(D.T @ V[:, block] - penalty, 1e-9)
        h = H[:, block].copy()
        for _ in range(iterations):
            h *= numerator / (DD @ h + 1e-9)
        H[:, block] = h
    return H


def activations(D, V, iterations=55, warm=None, prior=None):
    """Nonnegative sparse factorization with fixed instrument spectra."""
    H = np.zeros((D.shape[1], V.shape[1]), dtype=V.dtype)
    for block in frame_blocks(V.shape[1]):
        v = V[:, block]
        h = H[:, block]
        if warm is not None:
            h[:] = np.maximum(warm[:, block], (D.T @ v) * 0.0001)
            continue
        residual = v.copy()
        for _ in range(8):
            projection = np.maximum(D.T @ residual, 0)
            index = np.argmax(projection, axis=0)
            value = projection[index, np.arange(v.shape[1])]
            h[index, np.arange(v.shape[1])] += value
            residual -= D[:, index] * value[None, :]
        h += 1e-9
    return fit_fixed(D, V, H, iterations, 0.035, prior)


def decode(H, times, pitch_offset=0):
    notes = []
    global_peak = float(H.max())
    for row, pitch in zip(H, PITCHES):
        if row.max() < global_peak * 0.07:
            continue
        smooth = ndimage.median_filter(row, size=3)
        threshold = max(float(row.max()) * 0.42, global_peak * 0.12)
        active = smooth > threshold
        active = ndimage.binary_closing(active, iterations=1)
        edges = np.diff(np.r_[0, active, 0].astype(int))
        for start, end in zip(np.where(edges == 1)[0], np.where(edges == -1)[0]):
            if end - start < 6:
                continue
            peak = float(smooth[start:end].max())
            if peak < global_peak * 0.32:
                continue
            # Frame centers straddle the attack. Correct the conservative activation gate.
            onset = max(0, float(times[start]) - 0.004)
            offset = float(times[min(end, len(times) - 1)]) - 0.022
            notes.append(
                dict(
                    pitch=int(pitch) + pitch_offset,
                    start=round(onset, 4),
                    end=round(max(onset + 0.06, offset), 4),
                    velocity=int(np.clip(95 * np.sqrt(peak / global_peak), 35, 120)),
                    confidence=round(min(0.98, peak / (threshold * 3)), 3),
                )
            )
    return sorted(notes, key=lambda n: (n["start"], n["pitch"]))


def harmonics(p):
    k = np.arange(1, 81, dtype=float)
    family = p["family"]
    if family == "fm":
        phase = np.arange(512) * 2 * np.pi / 512
        a = (
            2
            / 512
            * (
                np.sin(k[:, None] * phase)
                @ np.sin(phase + p["fm"] * np.sin(round(p["ratio"]) * phase))
            )
        )
    elif family == "sine":
        a = (k == 1).astype(float)
    elif family == "triangle":
        a = np.where(k % 2, (-1) ** np.floor((k - 1) / 2) / (k * k), 0)
    elif family == "square":
        a = (k % 2) / k
    elif family == "pulse":
        a = np.sin(np.pi * k * (0.12 + 0.32 * p["odd"])) / k
    else:
        a = 1 / k
    a *= np.exp(-(k - 1) / (2 + 55 * p["brightness"] ** 2))
    a[0] += p["body"]
    return a / max(np.linalg.norm(a), 1e-9)


def refine_patch(patch, h, target, others, times, weight):
    notes = decode(h, times)
    examples = []
    for n in sorted(notes, key=lambda n: n["velocity"], reverse=True)[:12]:
        if n["end"] - n["start"] < 0.09:
            continue
        frame = np.argmin(
            abs(times - (n["start"] + min(0.1, (n["end"] - n["start"]) * 0.55)))
        )
        observed = np.maximum(target[:, frame] - others[:, frame], 0)
        examples.append((n["pitch"], observed))
    if not examples:
        return dict(patch), None
    pitches = np.array([p for p, _ in examples])
    observed = np.stack([v for _, v in examples], axis=1)
    # Only fit bins around this note's partials, not leftover neighbouring notes.
    masks = basis(np.ones(80), pitches) > 0.02
    observed *= masks
    norms = np.linalg.norm(observed, axis=0)
    observed /= np.maximum(norms, 1e-9)
    keys = ["brightness", "body"] + (
        ["fm"]
        if patch["family"] == "fm"
        else ["odd"] if patch["family"] == "pulse" else []
    )
    bounds = [(0.03, 1), (0, 1)] + (
        [(max(0, patch["fm"] - 0.6), min(6, patch["fm"] + 0.6))]
        if patch["family"] == "fm"
        else [(0, 1)] if patch["family"] == "pulse" else []
    )

    def objective(values):
        p = {**patch, **dict(zip(keys, values))}
        d = basis(harmonics(p), pitches) * weight[:, None] * masks
        d /= np.maximum(np.linalg.norm(d, axis=0), 1e-9)
        return float(np.mean(1 - np.sum(d * observed, axis=0)))

    initial = objective([patch[k] for k in keys])
    fitted = optimize.differential_evolution(
        objective, bounds, maxiter=16, popsize=5, seed=7, polish=True, tol=0.002
    )
    result = {**patch, **{k: round(float(v), 5) for k, v in zip(keys, fitted.x)}}
    return result, dict(
        before=round(initial, 5),
        after=round(float(fitted.fun), 5),
        examples=len(examples),
    )


def stabilize_voices(H, D, target, times, count):
    """Keep one sound identity through a note rather than switching mid-hold.

    Compare the complete harmonic spectrum after removing other pitches. The
    least crowded frames carry more weight; timbre identity is fixed for the
    event, while amplitudes continue to be estimated jointly.
    """
    cube = H.reshape(count, len(PITCHES), -1)
    combined = np.sum(cube, axis=0)
    prediction = D @ H
    support = np.zeros_like(cube)
    for pitch_index, row in enumerate(combined):
        if row.max() < combined.max() * 0.04:
            continue
        active = ndimage.binary_closing(
            row > max(row.max() * 0.22, combined.max() * 0.025), iterations=3
        )
        edges = np.diff(np.r_[0, active, 0].astype(int))
        columns = D[:, pitch_index :: len(PITCHES)]
        contribution = columns @ cube[:, pitch_index]
        other = prediction - contribution
        for start, end in zip(np.where(edges == 1)[0], np.where(edges == -1)[0]):
            if end - start < 7:
                continue
            frames = np.arange(start, end)
            strength = row[frames]
            frames = frames[strength > strength.max() * 0.55]
            if len(frames) < 3:
                continue
            crowd = np.linalg.norm(other[:, frames], axis=0) / (row[frames] + 1e-9)
            frames = frames[np.argsort(crowd)[: max(3, len(frames) // 2)]]
            observation = np.maximum(target[:, frames] - other[:, frames], 0)
            correlations = np.maximum(columns.T @ observation, 0)
            votes = np.sum(correlations**2, axis=1)
            winner = int(np.argmax(votes))
            support[
                winner, pitch_index, max(0, start - 3) : min(len(times), end + 3)
            ] = 1
    supported = H * support.reshape(H.shape)
    # Give a voice the full continuous note as its starting point.
    supported += np.tile(combined, (count, 1)) * support.reshape(H.shape) * 0.05
    return fit_fixed(D, target, supported, 140, 0.018)


def fit_envelope(H, notes, times, patch):
    attacks = []
    releases = []
    sustains = []
    for note in notes:
        row = H[note["pitch"] - int(PITCHES[0])]
        start = np.searchsorted(times, note["start"])
        end = np.searchsorted(times, note["end"])
        seg = row[start:end]
        if len(seg) < 8:
            continue
        peak = int(np.argmax(seg))
        attacks.append(max(0.004, min(0.5, peak * HOP / SR)))
        sustains.append(float(np.median(seg[len(seg) // 2 :]) / (seg.max() + 1e-9)))
    p = dict(patch)
    p.update(
        attack=round(float(np.median(attacks)) if attacks else 0.015, 4),
        decay=0.25,
        sustain=round(
            float(np.clip(np.median(sustains), 0.08, 0.95)) if sustains else 0.5, 3
        ),
        release=0.12,
        gain=0.65,
    )
    return p


def reconcile_continuations(parts):
    """A timbre assignment change during one held pitch is not a new attack.

    Only join adjacent fragments of the same pitch when the second fragment
    is short and the first instrument explains that pitch repeatedly. Preserve
    genuinely simultaneous same-pitch notes and isolated register changes.
    """
    for part in parts:
        retained = []
        for note in part["notes"]:
            duration = note["end"] - note["start"]
            previous = []
            if duration < 0.15:
                for other in parts:
                    if other is part:
                        continue
                    same = [n for n in other["notes"] if n["pitch"] == note["pitch"]]
                    if len(same) < 3:
                        continue
                    previous.extend(
                        n
                        for n in same
                        if n["start"] < note["start"] - 0.12
                        and -0.025 <= note["start"] - n["end"] <= 0.055
                    )
            if previous:
                prev = max(previous, key=lambda n: n["end"])
                prev["end"] = max(prev["end"], note["end"])
                prev["boundaryAdjusted"] = True
            else:
                retained.append(note)
        part["notes"] = retained


def reconcile_masked_holds(parts):
    """Join a chord tone interrupted while a lower instrument masks its harmonics."""
    for part in parts:
        notes = sorted(part["notes"], key=lambda n: (n["pitch"], n["start"]))
        removed = set()
        for i, first in enumerate(notes):
            if i in removed:
                continue
            for j in range(i + 1, len(notes)):
                second = notes[j]
                if second["pitch"] != first["pitch"]:
                    break
                gap = second["start"] - first["end"]
                if gap <= 0 or gap > min(0.6, 0.4 * (second["end"] - first["start"])):
                    break
                companions = [
                    n
                    for n in notes
                    if n["pitch"] != first["pitch"]
                    and abs(n["start"] - first["start"]) < 0.09
                    and n["end"] >= second["end"] - 0.15
                ]
                if not companions:
                    break
                intervals = []
                for other in parts:
                    if other is part:
                        continue
                    for n in other["notes"]:
                        ratio = 2 ** ((first["pitch"] - n["pitch"]) / 12)
                        if not 1.9 <= ratio <= 8.1 or abs(ratio - round(ratio)) > 0.025:
                            continue
                        start = max(first["end"], n["start"] - 0.04)
                        end = min(second["start"], n["end"] + 0.08)
                        if end > start:
                            intervals.append((start, end))
                covered, until = 0.0, first["end"]
                for start, end in sorted(intervals):
                    covered += max(0, end - max(start, until))
                    until = max(until, end)
                if covered < gap * 0.85:
                    break
                first["end"] = second["end"]
                first["boundaryAdjusted"] = True
                first["maskedContinuation"] = True
                removed.add(j)
        part["notes"] = sorted(
            [n for i, n in enumerate(notes) if i not in removed],
            key=lambda n: n["start"],
        )


def fit_dynamics(part, stem, all_parts):
    """Fit note envelope and boundary corrections against the original recording.

    The measured energy and predicted envelope use the same smoothing kernel.
    Per-note gain is a nuisance variable; the synth's envelope is shared.
    """
    examples = []
    for n in sorted(part["notes"], key=lambda x: x["velocity"], reverse=True):
        if len(examples) >= 10:
            break
        if n["end"] - n["start"] < 0.1:
            continue
        # Prefer exposed notes to avoid fitting a chord's changing amplitude.
        if any(
            m is not n
            and m["pitch"] == n["pitch"]
            and m["start"] < n["end"]
            and m["end"] > n["start"]
            for m in part["notes"]
        ):
            continue
        next_onset = min(
            [m["start"] for m in part["notes"] if m["start"] > n["end"]]
            + [len(stem) / SR]
        )
        lo = max(0, int((n["start"] - 0.09) * SR))
        hi = min(len(stem), int(min(n["end"] + 0.23, next_onset - 0.02) * SR))
        t = np.arange(lo, hi) / SR - n["start"]
        fundamental = 440 * 2 ** ((n["pitch"] - 69) / 12)
        amplitudes = np.abs(harmonics(part["patch"]))
        others = []
        for other in all_parts:
            amps = np.abs(harmonics(other["patch"]))
            for m in other["notes"]:
                if m is n or m["start"] >= n["end"] or m["end"] <= n["start"]:
                    continue
                f = 440 * 2 ** ((m["pitch"] - 69) / 12)
                others.extend(
                    (f * (j + 1), a) for j, a in enumerate(amps[:24]) if a > 0.035
                )
        scores = []
        for harmonic, amp in enumerate(amplitudes[:12], 1):
            frequency = fundamental * harmonic
            if frequency > SR * 0.4:
                continue
            contamination = sum(
                a * np.exp(-(((f - frequency) / 15) ** 2)) for f, a in others
            )
            scores.append((amp / (0.1 + contamination), harmonic))
        harmonic = max(scores)[1]
        frequency = fundamental * harmonic
        # A 15 ms demodulation window rejects adjacent bass/chord harmonics.
        # Apply the same smoothing to the predicted envelope so this does not
        # interpret the window's smearing as the instrument's attack time.
        sigma = max(SR * 0.015, SR / frequency * 0.4)
        phase = np.arange(lo, hi) / SR * 2 * np.pi * frequency
        demod = stem[lo:hi] * np.exp(-1j * phase)
        measured = np.abs(
            ndimage.gaussian_filter1d(demod.real, sigma)
            + 1j * ndimage.gaussian_filter1d(demod.imag, sigma)
        )
        if measured.max() < 1e-8:
            continue
        # Fit the slowly varying envelope at about 500 Hz. Filtering every
        # full-rate sample on each optimizer step adds cost without pitch detail.
        stride = 44
        examples.append(
            (
                t[::stride],
                n["end"] - n["start"],
                measured[::stride] / measured.max(),
                sigma / stride,
                n,
                float(measured.max()),
                float(amplitudes[harmonic - 1]),
            )
        )
    if not examples:
        return

    def prediction(params, t, gate, sigma):
        attack, decay, sustain, release, shift, gate_shift = params
        time = t - shift
        held = np.where(
            time < attack,
            np.maximum(time, 0) / attack,
            sustain
            + (1 - sustain) * np.exp(np.minimum(0, -4 * (time - attack) / decay)),
        )
        stop = gate + gate_shift
        at_stop = (
            stop / attack
            if stop < attack
            else sustain + (1 - sustain) * np.exp(-4 * (stop - attack) / decay)
        )
        env = np.where(
            time <= stop,
            held,
            at_stop * np.exp(np.minimum(0, -6 * (time - stop) / release)),
        )
        env = np.where(time >= 0, env, 0)
        return ndimage.gaussian_filter1d(env, sigma)

    def residual(params):
        diffs = []
        for t, gate, target, sigma, n, peak, partial in examples:
            model = prediction(params, t, gate, sigma)
            scale = float(model @ target) / (float(model @ model) + 1e-9)
            diffs.extend((model * scale - target).tolist())
        return np.asarray(diffs)

    p = part["patch"]
    initial = [0.012, 0.25, 0.5, 0.12, 0, 0]
    fit = optimize.least_squares(
        residual,
        initial,
        bounds=(
            [0.002, 0.035, 0.02, 0.02, -0.04, -0.08],
            [0.4, 1.5, 1, 1.2, 0.04, 0.12],
        ),
        max_nfev=75,
        loss="soft_l1",
        f_scale=0.1,
    )
    attack, decay, sustain, release, shift, gate_shift = fit.x
    for key, value in zip(["attack", "decay", "sustain", "release"], fit.x[:4]):
        p[key] = round(float(value), 5)
    gains = []
    for t, gate, target, sigma, n, peak, partial in examples:
        model = prediction(fit.x, t, gate, sigma)
        gains.append(
            peak
            / (
                max(float(model.max()), 1e-6)
                * 0.15
                * max(partial, 0.01)
                * (n["velocity"] / 127)
            )
        )
    p["gain"] = round(float(np.clip(np.median(gains), 0.05, 1.5)), 4)
    for n in part["notes"]:
        n["start"] = round(max(0, n["start"] + float(shift)), 4)
        n["end"] = round(
            max(
                n["start"] + 0.035,
                min(len(stem) / SR, n["end"] + float(shift + gate_shift)),
            ),
            4,
        )
    part["dynamicsFit"] = dict(
        error=round(float(np.mean(residual(fit.x) ** 2)), 5), examples=len(examples)
    )
    part["automaticPatch"] = dict(p)


def note_support(parts, times, pitches=PITCHES):
    """Allow only each instrument's accepted notes, including STFT/release tails."""
    support = np.zeros((len(parts) * len(pitches), len(times)), dtype=np.float32)
    pitch_indexes = {int(pitch): i for i, pitch in enumerate(pitches)}
    for i, part in enumerate(parts):
        for n in part["notes"]:
            if n["pitch"] not in pitch_indexes:
                continue
            row = i * len(pitches) + pitch_indexes[n["pitch"]]
            start = n["start"] - FFT / SR * 0.5
            end = n["end"] + part["patch"]["release"] * 1.5 + FFT / SR * 0.5
            support[row, (times >= start) & (times <= end)] = 1
    return support


def extract_references(
    parts,
    mono,
    times,
    spectrum,
    target,
    weight,
    directory,
    warm=None,
    *,
    pitches=PITCHES,
    calibrate=True,
):
    """Re-estimate masks after final note assignment instead of retaining stale masks."""
    columns = []
    for part in parts:
        d = basis(harmonics(part["patch"]), pitches) * weight[:, None]
        d /= np.maximum(np.linalg.norm(d, axis=0), 1e-9)
        columns.append(d)
    D = np.concatenate(columns, axis=1)
    support = note_support(parts, times, pitches)
    H = np.empty((D.shape[1], target.shape[1]), dtype=target.dtype)
    for block in frame_blocks(target.shape[1]):
        initial = D.T @ target[:, block] * 0.0001 if warm is None else warm[:, block]
        H[:, block] = np.maximum(initial, 1e-9) * support[:, block]
    fit_fixed(D, target, H, 160, 0.018)
    # Sum masks without retaining a full spectrogram for every instrument.
    denominator = np.zeros_like(target)
    squared_error = 0.0
    target_power = 0.0
    for block in frame_blocks(target.shape[1]):
        prediction = D @ H[:, block]
        squared_error += float(
            np.sum((target[:, block] - prediction) ** 2, dtype=np.float64)
        )
        target_power += float(np.sum(target[:, block] ** 2, dtype=np.float64))
        denominator[:, block] = np.maximum(
            prediction / np.maximum(weight[:, None], 1e-9), abs(spectrum[:, block])
        )
    for i, part in enumerate(parts):
        estimate = np.empty_like(target)
        for block in frame_blocks(target.shape[1]):
            estimate[:, block] = (
                columns[i] @ H[i * len(pitches) : (i + 1) * len(pitches), block]
            ) / np.maximum(weight[:, None], 1e-9)
        _, stem = signal.istft(
            spectrum * estimate / np.maximum(denominator, 1e-10),
            fs=SR,
            nperseg=FFT,
            noverlap=FFT - HOP,
        )
        stem = stem[: len(mono)]
        filename = part["id"] + "-reference.wav"
        sf.write(directory / filename, stem, SR)
        part["referenceFile"] = filename
        if not calibrate:
            continue
        # Calibrate level from the complete isolated part, not a weak partial
        # contaminated by an overlapping instrument. Unit-gain oscillator RMS
        # is 0.3/sqrt(2) because our harmonic coefficient vector has unit norm.
        power = np.zeros(len(mono), dtype=np.float64)
        p = part["patch"]
        for n in part["notes"]:
            lo = max(0, round(n["start"] * SR))
            hi = min(len(mono), round((n["end"] + p["release"] * 1.5) * SR))
            t = np.arange(hi - lo) / SR
            gate = n["end"] - n["start"]
            held = np.where(
                t < p["attack"],
                t / p["attack"],
                p["sustain"]
                + (1 - p["sustain"])
                * np.exp(np.minimum(0, -4 * (t - p["attack"]) / p["decay"])),
            )
            at_gate = (
                gate / p["attack"]
                if gate < p["attack"]
                else p["sustain"]
                + (1 - p["sustain"]) * np.exp(-4 * (gate - p["attack"]) / p["decay"])
            )
            envelope = np.where(
                t <= gate,
                held,
                at_gate * np.exp(np.minimum(0, -6 * (t - gate) / p["release"])),
            )
            power[lo:hi] += 0.045 * (n["velocity"] / 127 * envelope) ** 2
        gain = np.sqrt(np.sum(stem**2) / max(np.sum(power), 1e-12))
        p["gain"] = round(float(np.clip(gain, 0.01, 1.5)), 5)
        part["automaticPatch"] = dict(p)
    return float(np.sqrt(squared_error / max(target_power, 1e-20)))


def select_candidates(catalogue, votes, max_parts=None):
    """Choose distinct audible candidates until their evidence runs out.

    An explicit CLI budget may limit research runs; the application does not
    impose a fixed instrument count. The finite dictionary bounds this search.
    """
    votes = np.asarray(votes, dtype=float).copy()
    selected = []
    total_votes = float(votes.sum())
    while (
        max_parts is None or len(selected) < max_parts
    ) and votes.max() > total_votes * 0.025:
        best = int(np.argmax(votes))
        selected.append(best)
        a = (
            np.abs(np.asarray(catalogue[best]["harmonics"], dtype=float))
            * np.arange(1, 81) ** 0.7
        )
        a /= np.linalg.norm(a)
        for j, candidate in enumerate(catalogue):
            b = (
                np.abs(np.asarray(candidate["harmonics"], dtype=float))
                * np.arange(1, 81) ** 0.7
            )
            b /= np.linalg.norm(b)
            if a @ b > 0.97:
                votes[j] = 0
        votes[best] = 0
    discovery_limit_reached = (
        max_parts is not None
        and len(selected) >= max_parts
        and votes.max() > total_votes * 0.025
    )
    return selected, bool(discovery_limit_reached)


def analyze(source, directory, catalogue, max_parts=None):
    report("Reading audio", 0.03)
    y, sr = sf.read(source, always_2d=True, dtype="float32")
    if not np.isfinite(y).all():
        raise ValueError("Audio contains non-finite samples")
    if sr != SR:
        y = signal.resample_poly(y, SR, sr, axis=0)
    mono = y.mean(axis=1)
    if len(mono) < SR * 0.3 or np.max(np.abs(mono)) < 1e-5:
        raise ValueError("Choose an audible recording of at least 0.3 seconds.")
    duration = len(mono) / SR
    report("Checking independent pitch evidence", 0.08)
    try:
        proposals = propose(source)
    except Exception as error:
        raise RuntimeError(
            "Pitch analysis could not start. Run npm run setup:instruments and retry. "
            + str(error)
        ) from error
    _, times, Z = signal.stft(
        mono, fs=SR, nperseg=FFT, noverlap=FFT - HOP, boundary="zeros"
    )
    V = np.abs(Z).astype(np.float32)
    # Whitening avoids a loud fundamental monopolizing instrument discovery.
    weight = 1 / np.maximum(np.mean(V, axis=1), V.max() * 0.0008) ** 0.35
    weight[:4] = 0
    target = V * weight[:, None]
    # Keep the established central register search and open the extended bass/lead
    # register where the independent model has pitched evidence. Unsupported
    # octaves should not steal energy from the main instrument candidates.
    eligible = ((PITCHES >= 30) & (PITCHES <= 89)) | np.isin(
        PITCHES, [p["pitch"] for p in proposals]
    )
    if not proposals:
        raise ValueError(
            "No reliable pitched notes found. Try a clearer electronic passage."
        )
    raw = [basis(c["harmonics"]) * eligible[None, :] for c in catalogue]
    Ds = []
    for b in raw:
        d = b * weight[:, None]
        d /= np.maximum(np.linalg.norm(d, axis=0), 1e-9)
        Ds.append(d)
    dictionary = np.concatenate(Ds, axis=1)
    report("Discovering instrument voices", 0.12)
    # Discovery uses a decimated time grid; note decoding retains every frame.
    sample = target[:, ::4]
    votes = np.zeros(len(catalogue))
    for block in frame_blocks(sample.shape[1]):
        residual = sample[:, block].copy()
        for iteration in range(8):
            projection = np.maximum(dictionary.T @ residual, 0)
            winners = np.argmax(projection, axis=0)
            amplitudes = projection[winners, np.arange(residual.shape[1])]
            votes += np.bincount(
                winners // len(PITCHES), weights=amplitudes**2, minlength=len(catalogue)
            )
            residual -= dictionary[:, winners] * amplitudes[None, :]
    del dictionary, residual, projection
    selected, discovery_limit_reached = select_candidates(catalogue, votes, max_parts)
    if not selected:
        raise ValueError(
            "No stable instrument candidates were found. Try a clearer passage."
        )
    report("Discovering instrument voices", 0.4, instruments=len(selected))
    report("Resolving pitches and note boundaries", 0.48)
    D = np.concatenate([Ds[c] for c in selected], axis=1)
    H = activations(D, target, 90)
    report("Matching synth parameters", 0.57)
    fitting = []
    fitted_patches = []
    prediction = D @ H
    for i, c in enumerate(selected):
        h = H[i * len(PITCHES) : (i + 1) * len(PITCHES)]
        fitted, metrics = refine_patch(
            catalogue[c]["patch"],
            h,
            target,
            np.maximum(prediction - Ds[c] @ h, 0),
            times,
            weight,
        )
        fitted_patches.append(fitted)
        fitting.append(metrics)
        raw[c] = basis(harmonics(fitted)) * eligible[None, :]
        d = raw[c] * weight[:, None]
        d /= np.maximum(np.linalg.norm(d, axis=0), 1e-9)
        Ds[c] = d
        report(
            "Matching synth parameters",
            0.58 + (i + 1) / len(selected) * 0.15,
            instrument=i + 1,
        )
    D = np.concatenate([Ds[c] for c in selected], axis=1)
    del prediction
    H = activations(D, target, 180, warm=H)
    # Continuous fitting can make initially different dictionary candidates
    # converge on the same timbre. Collapse those before counting instruments.
    energies = [
        float(np.sum(H[i * len(PITCHES) : (i + 1) * len(PITCHES)] ** 2))
        for i in range(len(selected))
    ]
    signatures = [
        np.abs(harmonics(p)) * np.arange(1, 81) ** 0.5 for p in fitted_patches
    ]
    lowest_supported = []
    for i in range(len(selected)):
        accepted = supported_notes(
            decode(H[i * len(PITCHES) : (i + 1) * len(PITCHES)], times), proposals
        )
        lowest_supported.append(
            min((n["pitch"] for n in accepted), default=int(PITCHES[0]))
        )

    def same_audible_voice(i, j):
        # At a high register, most oscillator harmonics cannot reach the output.
        # Differences in those inaudible coefficients are not evidence of a new
        # instrument. Compare the harmonics observed for both candidates; a
        # fundamental-only candidate has no evidence about its higher partials.
        pitch = max(lowest_supported[i], lowest_supported[j])
        count = min(80, int(SR * 0.45 / (440 * 2 ** ((pitch - 69) / 12))))
        a, b = signatures[i][:count], signatures[j][:count]
        similarity = float(a @ b / max(np.linalg.norm(a) * np.linalg.norm(b), 1e-12))
        if fitted_patches[i]["family"] == fitted_patches[j]["family"]:
            return similarity > 0.985
        # Different oscillator families can become observationally equivalent
        # when only a few harmonics remain; demand closer agreement in that case.
        return count <= 8 and similarity > 0.99

    groups = []
    for i in np.argsort(energies)[::-1]:
        group = next(
            (g for g in groups if same_audible_voice(i, g[0])),
            None,
        )
        if group is None:
            groups.append([int(i)])
        else:
            group.append(int(i))
    H = np.concatenate(
        [
            sum(H[i * len(PITCHES) : (i + 1) * len(PITCHES)] for i in group)
            for group in groups
        ]
    )
    representatives = []
    for group in groups:
        informative = min(group, key=lambda i: (lowest_supported[i], -energies[i]))
        available = SR * 0.45 / (440 * 2 ** ((lowest_supported[informative] - 69) / 12))
        # Prefer the richest observed high-register spectrum when merging
        # band-limited candidates. Else retain the strongest fitted candidate.
        representatives.append(informative if available <= 8 else group[0])
    selected = [selected[i] for i in representatives]
    fitted_patches = [fitted_patches[i] for i in representatives]
    fitting = [fitting[i] for i in representatives]
    D = np.concatenate([Ds[c] for c in selected], axis=1)
    H = activations(D, target, 160, warm=H)
    energies = [
        float(np.sum(H[i * len(PITCHES) : (i + 1) * len(PITCHES)] ** 2))
        for i in range(len(selected))
    ]
    total = sum(energies)
    keep = [i for i, e in enumerate(energies) if e / total >= 0.02]
    if len(keep) < len(selected):
        H = np.concatenate(
            [H[i * len(PITCHES) : (i + 1) * len(PITCHES)] for i in keep], axis=0
        )
        selected = [selected[i] for i in keep]
        fitted_patches = [fitted_patches[i] for i in keep]
        fitting = [fitting[i] for i in keep]
        D = np.concatenate([Ds[c] for c in selected], axis=1)
    distribution = np.stack(
        [
            np.sum(H[i * len(PITCHES) : (i + 1) * len(PITCHES)], axis=1)
            for i in range(len(selected))
        ]
    )
    distribution = ndimage.gaussian_filter1d(distribution, 2, axis=1)
    prior = (distribution + 0.01 * distribution.max()) / (
        distribution.sum(axis=0, keepdims=True)
        + 0.01 * distribution.max() * len(selected)
    )
    H = activations(D, target, 160, warm=H, prior=prior.reshape(-1))
    H = stabilize_voices(H, D, target, times, len(selected))
    energies = [
        float(np.sum(H[i * len(PITCHES) : (i + 1) * len(PITCHES)] ** 2))
        for i in range(len(selected))
    ]
    total = sum(energies)
    parts = []
    part_activity = []
    for i, c in enumerate(selected):
        h = H[i * len(PITCHES) : (i + 1) * len(PITCHES)]
        notes = supported_notes(decode(h, times), proposals)
        if not notes or energies[i] / total < 0.02:
            continue
        part_id = f"instrument-{len(parts)+1}"
        patch = fit_envelope(h, notes, times, fitted_patches[i])
        part_activity.append(h)
        parts.append(
            dict(
                id=part_id,
                name=f"Instrument {len(parts)+1}",
                patch=patch,
                automaticPatch=dict(patch),
                notes=notes,
                muted=False,
                locked=[],
                family=patch["family"],
                energyShare=round(energies[i] / total, 3),
                fitting=fitting[i],
            )
        )
    if not parts:
        raise ValueError(
            "No stable pitched instruments were found. Try a clearer electronic passage."
        )
    reconcile_continuations(parts)
    reconcile_masked_holds(parts)
    report("Fitting note envelopes", 0.78)
    for part in parts:
        fit_dynamics(part, mono, parts)
    report("Rebuilding instrument reference stems", 0.88)
    mismatch = extract_references(
        parts,
        mono,
        times,
        Z,
        target,
        weight,
        directory,
        np.concatenate(part_activity, axis=0),
    )
    waveform = [
        round(float(np.max(np.abs(c))), 4)
        for c in np.array_split(mono, min(600, len(mono)))
    ]
    result = dict(
        version=1,
        duration=round(duration, 4),
        sampleRate=SR,
        parts=parts,
        waveform=waveform,
        analysis=dict(
            method="synth-dictionary-pitch-consensus-v3",
            pitchModel="basic-pitch-0.4.0-onnx",
            pitchProposals=len(proposals),
            sourceLimit=max_parts,
            discoveryLimitReached=bool(discovery_limit_reached),
            searchMidiRange=[int(PITCHES[0]), int(PITCHES[-1])],
            spectralResidual=round(mismatch, 4),
            notes=sum(len(p["notes"]) for p in parts),
            warnings=(
                [
                    "The analysis reached its instrument search limit. More voices may remain unresolved."
                ]
                if discovery_limit_reached
                else []
            )
            + [
                "Instrument discovery is an estimate. Review similar or overlapping sounds before practice."
            ]
            + (
                ["Some attacks or harmonics remain outside the fitted synth model."]
                if mismatch > 0.35
                else []
            ),
        ),
    )
    (directory / "result.json").write_text(json.dumps(result, indent=2))
    report("Analysis ready", 1, parts=len(parts), residual=mismatch)
    return result


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--input", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--catalog", required=True)
    p.add_argument("--allow-empty", action="store_true")
    p.add_argument(
        "--max-parts",
        type=int,
        default=None,
        help="Optional discovery budget; by default use all supported candidates",
    )
    args = p.parse_args()
    folder = Path(args.output)
    folder.mkdir(parents=True, exist_ok=True)
    try:
        analyze(
            args.input,
            folder,
            json.loads(Path(args.catalog).read_text()),
            args.max_parts,
        )
    except ValueError as error:
        if not args.allow_empty or not str(error).startswith(("No reliable pitched notes", "No stable instrument candidates", "No stable pitched instruments")):
            report("Failed", 0, error=str(error))
            raise
        audio, sr = sf.read(args.input, always_2d=True)
        result = dict(engine="melodic", duration=len(audio)/sr, sampleRate=sr, parts=[], waveform=[], analysis=dict(notes=0, spectralResidual=0, warnings=[], method="No pitched instruments detected"))
        (folder / "result.json").write_text(json.dumps(result))
        report("No pitched instruments detected", 1)
    except Exception as error:
        report("Failed", 0, error=str(error))
        raise
