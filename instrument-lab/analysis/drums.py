"""Recording-specific electronic percussion discovery; no fixed class taxonomy.

Sound identity uses attack AND decay. Nonnegative mixture pruning removes
coincident combinations where constituent sounds have independent evidence.
Recovered details are explicitly disclosed, never presented as pure synthesis.
"""

import argparse
import json
from pathlib import Path
import numpy as np
import soundfile as sf
from scipy import signal, ndimage, cluster, optimize


def progress(stage, value):
    print(json.dumps({"stage": stage, "progress": value}), flush=True)


def discover(audio, sr):
    # Analysis envelopes at 5 ms; assets/references retain stereo at native rate.
    mono = np.mean(audio, axis=1)
    hop = round(sr * 0.005)
    size = 2048 if sr >= 40000 else 1024
    _, times, z = signal.stft(mono, fs=sr, nperseg=size, noverlap=size - hop)
    v = np.abs(z).astype(np.float32)
    edges = np.unique(np.r_[0, np.geomspace(1, len(v), 73).astype(int), len(v)])
    f = np.stack(
        [np.sqrt(np.sum(v[a:b] ** 2, axis=0)) for a, b in zip(edges[:-1], edges[1:])]
    )
    weight = 1 / np.maximum(np.mean(f, axis=1), np.max(f) * 0.0001) ** 0.2
    x = f * weight[:, None]
    smooth = ndimage.uniform_filter1d(x, 3, axis=1)
    previous = ndimage.maximum_filter1d(smooth, 9, axis=1, origin=4)
    flux = np.maximum(
        smooth - np.pad(previous[:, :-2], ((0, 0), (2, 0)), mode="edge"), 0
    ).sum(axis=0)
    peaks, _ = signal.find_peaks(
        flux, distance=max(1, round(0.015 * sr / hop)), prominence=max(flux) * 0.015
    )
    peaks = peaks[peaks < x.shape[1] - 1]
    if np.max(x[:, :4]) > np.max(x) * 0.02:
        peaks = np.unique(np.r_[0, peaks])
    if not len(peaks):
        raise ValueError(
            "No distinct drum attacks found. Choose a drum stem with audible hits."
        )
    # Time structure distinguishes short/long articulations with similar spectra.
    segments = []
    for t in peaks:
        before = np.mean(x[:, t - 6 : t - 2], axis=1) if t >= 6 else np.zeros(len(x))
        chunk = x[:, t : t + 24]
        chunk = np.pad(chunk, ((0, 0), (0, 24 - chunk.shape[1])))
        segments.append(
            np.maximum(
                chunk - before[:, None] * np.exp(-np.arange(24)[None, :] / 20), 0
            )
        )
    segments = np.array(segments)
    descriptors = np.stack(
        [segments[:, :, a:b].mean(2) for a, b in [(0, 5), (5, 12), (12, 24)]], axis=2
    ).reshape(len(peaks), -1)
    norms = np.linalg.norm(descriptors, axis=1)
    descriptors /= np.maximum(norms[:, None], 1e-12)
    # Bounded clustering memory, spread over the complete recording.
    gaps = np.diff(np.r_[0, peaks, x.shape[1]]) * hop / sr
    candidates = np.flatnonzero((gaps[:-1] > 0.09) & (gaps[1:] > 0.14))
    if len(candidates) < 4:
        candidates = np.arange(len(peaks))
    subset = candidates[
        np.unique(
            np.linspace(0, len(candidates) - 1, min(1200, len(candidates))).astype(int)
        )
    ]
    if len(subset) > 1:
        labels = cluster.hierarchy.fcluster(
            cluster.hierarchy.linkage(
                descriptors[subset], method="average", metric="cosine"
            ),
            0.15,
            criterion="distance",
        )
    else:
        labels = np.ones(1, dtype=int)
    atoms = []
    members = []
    for label in np.unique(labels):
        indices = subset[labels == label]
        if len(indices) < 2 and len(peaks) > 20:
            continue
        center = np.median(descriptors[indices], axis=0)
        center /= max(np.linalg.norm(center), 1e-12)
        atoms.append(center)
        members.append(indices)
    if not atoms:
        atoms = [descriptors[np.argmax(norms)]]
        members = [np.array([np.argmax(norms)])]
    dictionary = np.stack(atoms, axis=1)
    keep = list(range(len(atoms)))
    # Mixture atoms are tested against all remaining independent atoms.
    for i in sorted(keep, key=lambda i: len(members[i]), reverse=True):
        others = [j for j in keep if j != i]
        if not others:
            break
        _, error = optimize.nnls(
            dictionary[:, others], dictionary[:, i], maxiter=10 * len(others)
        )
        if error < 0.32:
            keep.remove(i)
    dictionary = dictionary[:, keep]
    activations = np.maximum(dictionary.T @ (descriptors * norms[:, None]).T, 1e-9)
    cross = dictionary.T @ dictionary
    target = dictionary.T @ (descriptors * norms[:, None]).T
    for _ in range(160):
        activations *= np.maximum(target - 0.002 * target.max(), 1e-10) / (
            cross @ activations + 1e-10
        )
    # Spectral masks use distinct sound attacks; long/short articulations share
    # spectral energy proportionally, while their hit identities remain separate.
    spectra = np.stack(
        [np.mean(segments[members[j], :, :8], axis=(0, 2)) for j in keep], axis=1
    )
    spectra /= np.maximum(np.linalg.norm(spectra, axis=0), 1e-12)
    h = np.maximum(spectra.T @ x, 1e-10)
    cross = spectra.T @ spectra
    target = spectra.T @ x
    for _ in range(100):
        h *= target / (cross @ h + 1e-10)
    return dict(
        weight=weight,
        hop=hop,
        size=size,
        z=z,
        v=v,
        x=x,
        edges=edges,
        peaks=peaks,
        times=times,
        spectra=spectra,
        h=h,
        activations=activations,
        members=[members[j] for j in keep],
    )


def analyze(source, output):
    out = Path(output)
    out.mkdir(parents=True, exist_ok=True)
    audio, sr = sf.read(source, always_2d=True, dtype="float32")
    if sr != 44100:
        raise ValueError("Drum analysis requires the prepared 44.1 kHz stem.")
    if not np.isfinite(audio).all() or not np.max(np.abs(audio)) > 1e-6:
        raise ValueError("This drum stem is silent or invalid.")
    duration = len(audio) / sr
    progress("Finding recurring drum sounds", 0.06)
    d = discover(audio, sr)
    parts = []
    estimate = d["spectra"] @ d["h"]
    _, _, stereo = signal.stft(
        audio.T, fs=sr, nperseg=d["size"], noverlap=d["size"] - d["hop"], axis=-1
    )
    for j, row in enumerate(d["activations"]):
        threshold = max(row.max() * 0.045, 1e-8)
        hits = np.flatnonzero(row > threshold)
        if not len(hits):
            continue
        progress(
            f'Recovering drum sound {j+1} of {len(d["activations"])}',
            0.2 + 0.6 * j / len(d["activations"]),
        )
        pooled = (
            d["spectra"][:, j, None]
            * d["h"][j, None, :]
            / np.maximum(estimate, d["x"] * 0.2 + 1e-12)
        )
        mask = np.zeros_like(d["v"])
        for b, (a, e) in enumerate(zip(d["edges"][:-1], d["edges"][1:])):
            mask[a:e] = pooled[b]
        _, reference = signal.istft(
            stereo * mask[None, :, :],
            fs=sr,
            nperseg=d["size"],
            noverlap=d["size"] - d["hop"],
        )
        reference = reference.T[: len(audio)]
        # Choose an independently observed attack, preferring separation from
        # adjacent hits. No entire mixed passage is stored as a playable patch.
        purity = row / np.maximum(d["activations"].sum(0), 1e-12)
        candidates = sorted(
            [i for i in d["members"][j] if i in hits] or list(hits),
            key=lambda i: float(purity[i] * min(1, row[i] / (row.max() * 0.4))),
            reverse=True,
        )
        # Among clean repeated examples prefer the least spectrally compound one.
        pure = [i for i in candidates if purity[i] > 0.8 and row[i] > row.max() * 0.25]

        def isolation(i):
            at = d["peaks"][i]
            before = np.mean(d["x"][:, max(0, at - 20) : max(1, at - 5)] ** 2)
            attack = np.mean(d["x"][:, at : at + 12] ** 2)
            return float(before / max(attack, 1e-12))

        def entropy(i):
            spectrum = (
                np.mean(d["x"][:, d["peaks"][i] : d["peaks"][i] + 8], axis=1) ** 2
            )
            probability = spectrum / max(spectrum.sum(), 1e-12)
            return -float(np.sum(probability * np.log(probability + 1e-12)))

        low_bands = np.array(
            [
                (a + b) * sr / (2 * d["size"]) < 300
                for a, b in zip(d["edges"][:-1], d["edges"][1:])
            ]
        )
        tonal_share = float(np.sum(d["spectra"][low_bands, j] ** 2))
        selector = entropy if tonal_share > 0.55 else isolation
        exemplar = min(pure, key=selector) if pure else candidates[0]
        start = max(0, round(d["times"][d["peaks"][exemplar]] * sr))

        # STFT flux leads transients: sample onset comes from the stereo envelope.
        def refine(frame):
            center = round(d["times"][frame] * sr)
            a = max(0, center - round(0.014 * sr))
            b = min(len(audio), center + round(0.024 * sr))
            env = ndimage.uniform_filter1d(
                np.mean(reference[a:b] ** 2, axis=1), max(1, round(0.001 * sr))
            )
            if len(env) < 2:
                return center
            floor = np.quantile(env, 0.15)
            cross = np.flatnonzero(env > floor + 0.01 * (env.max() - floor))
            return a + int(cross[0]) if len(cross) else center

        start = refine(d["peaks"][exemplar])
        next_hits = [
            refine(frame) for frame in d["peaks"] if frame > d["peaks"][exemplar]
        ]
        length = min(
            round(1.8 * sr),
            len(audio) - start,
            max(
                round(0.08 * sr),
                min(next_hits, default=start + round(1.8 * sr)) - start,
            ),
        )
        clean_example = purity[exemplar] > 0.88
        sample = (audio if clean_example else reference)[start : start + length].copy()
        # Trim negligible tails, leaving a smooth edge.
        env = ndimage.uniform_filter1d(np.mean(sample**2, axis=1), round(0.008 * sr))
        audible = np.flatnonzero(env > max(env.max() * 1e-4, 1e-12))
        length = (
            min(len(sample), max(round(0.06 * sr), int(audible[-1]) + round(0.02 * sr)))
            if len(audible)
            else len(sample)
        )
        sample = sample[:length]
        fade = min(round(0.012 * sr), len(sample) // 4)
        if fade:
            sample[-fade:] *= np.linspace(1, 0, fade)[:, None]
        # Normalize the reusable sound once; MIDI velocity restores hit amplitude.
        base = float(row[exemplar])
        level = float(np.quantile(row[hits], 0.98))
        sample *= level / max(base, 1e-12)
        idx = len(parts) + 1
        pid = f"instrument-{idx}"
        refname = f"{pid}-reference.wav"
        samplename = f"{pid}-sample.wav"
        sf.write(out / refname, reference, sr, subtype="FLOAT")
        sf.write(out / samplename, sample, sr, subtype="FLOAT")
        notes = []
        for i in hits:
            start_time = refine(d["peaks"][i]) / sr
            notes.append(
                dict(
                    pitch=36 + idx - 1,
                    start=round(start_time, 6),
                    end=round(min(duration, start_time + 0.06), 6),
                    velocity=max(1, min(127, round(row[i] / max(level, 1e-12) * 127))),
                    confidence=round(float(purity[i]), 3),
                )
            )
        patch = fit_patch(sample, sr)
        parts.append(
            dict(
                id=pid,
                name=f"Drum sound {idx}",
                engine="drum",
                patch=patch,
                automaticPatch=patch,
                referenceFile=refname,
                sampleFile=samplename,
                notes=notes,
                confidence=round(float(purity[exemplar]), 3),
                discovery={
                    "examples": len(hits),
                    "exemplarTime": round(start / sr, 3),
                    "purity": round(float(purity[exemplar]), 3),
                    "needsReview": bool(purity[exemplar] < 0.7),
                },
            )
        )
    progress("Checking overlapping hits against recovered sounds", 0.83)
    refine_hits(parts, d, audio, sr, out)
    candidates_count = len(parts)
    parts = [p for p in parts if not p["discovery"].get("unsupported", False)]
    parts.sort(key=lambda p: p["discovery"].get("energyShare", 0), reverse=True)
    for i, part in enumerate(parts):
        part["name"] = f"Drum sound {i+1}"
        part["discovery"]["needsReview"] |= (
            part["discovery"].get("independentMatches", 0) < 5
            or part["discovery"].get("energyShare", 1) < 0.003
        )
    if not parts:
        raise ValueError(
            "No reliable repeating drum sounds found. Try a cleaner drum stem."
        )
    result = dict(
        engine="drum",
        duration=duration,
        sampleRate=sr,
        parts=parts,
        analysis={
            "notes": sum(len(p["notes"]) for p in parts),
            "spectralResidual": (
                parts[0]["discovery"]["spectralResidual"] if parts else 1
            ),
            "method": "recording-specific attack and decay discovery",
            "warnings": (
                [
                    f"{candidates_count-len(parts)} low-energy candidates lacked repeated independent evidence and were excluded."
                ]
                if candidates_count > len(parts)
                else []
            )
            + [
                "Recovered detail is part of each hybrid patch. Similar or always-overlapping sounds may need manual review."
            ],
        },
    )
    (out / "result.json").write_text(json.dumps(result, indent=2))
    progress("Drum sounds ready", 0.9)
    return result


def refine_hits(parts, d, audio, sr, out):
    # Coordinate descent over nonnegative event amplitudes, including simultaneous
    # sounds. A candidate can trigger several voices; no polyphony reduction.
    x = d["x"]
    hop = d["hop"]
    size = d["size"]
    residual = x.copy()
    events = []
    for j, part in enumerate(parts):
        sample, _ = sf.read(out / part["sampleFile"], always_2d=True, dtype="float32")
        _, _, z = signal.stft(sample.mean(1), fs=sr, nperseg=size, noverlap=size - hop)
        v = np.abs(z)
        template = (
            np.stack(
                [
                    np.sqrt(np.sum(v[a:b] ** 2, axis=0))
                    for a, b in zip(d["edges"][:-1], d["edges"][1:])
                ]
            )
            * d["weight"][:, None]
        )
        for peak in d["peaks"]:
            # Flux precedes the waveform attack; search a small alignment window.
            best = None
            for offset in range(-2, 4):
                at = int(peak + offset)
                length = min(template.shape[1], x.shape[1] - at)
                if at < 0 or length < 2:
                    continue
                atom = template[:, :length]
                norm = float(np.sum(atom**2)) + 1e-12
                fit = float(np.sum(x[:, at : at + length] * atom)) / norm
                score = fit * fit * norm
                if best is None or score > best[0]:
                    best = (score, at, atom, norm)
            if best:
                events.append([j, best[1], best[2], best[3], 0.0])
    for iteration in range(24):
        for event in events:
            j, at, atom, norm, old = event
            region = residual[:, at : at + atom.shape[1]]
            value = max(0, old + float(np.sum(region * atom)) / norm - 0.0002)
            region -= (value - old) * atom
            event[4] = value
    for j, part in enumerate(parts):
        candidates = [e for e in events if e[0] == j]
        top = max([e[4] for e in candidates], default=0)
        accepted = [e for e in candidates if e[4] > max(0.06, top * 0.055)]
        notes = []
        for e in sorted(accepted, key=lambda e: e[1]):
            time = e[1] * hop / sr
            if notes and time - notes[-1]["start"] < 0.018:
                if e[4] > notes[-1]["velocity"] / 127:
                    notes.pop()
                else:
                    continue
            notes.append(
                dict(
                    pitch=36 + j,
                    start=round(time, 6),
                    end=round(min(len(audio) / sr, time + 0.06), 6),
                    velocity=max(1, min(127, round(e[4] * 127))),
                    confidence=round(min(1, e[4] / max(top, 0.001)), 3),
                )
            )
        part["notes"] = notes
    refine_repeated_samples(parts, d, audio, sr, out)
    # This metric is spectral reconstruction, not a source separation claim.
    for part in parts:
        part["discovery"]["spectralResidual"] = round(
            float(np.linalg.norm(residual) / max(np.linalg.norm(x), 1e-12)), 4
        )


def refine_repeated_samples(parts, d, audio, sr, out):
    """Phase-coherent repeated electronic samples allow much firmer hit evidence.

    Fit all voices jointly. If the recording is not phase-coherent, keep the
    spectral pass and flag its uncertainty instead of claiming exact recovery.
    """
    residual = audio.copy()
    events = []
    templates = []
    for j, part in enumerate(parts):
        sample, _ = sf.read(out / part["sampleFile"], always_2d=True, dtype="float32")
        templates.append(sample)
        norm = float(np.sum(sample**2)) + 1e-12
        correlation = sum(
            signal.fftconvolve(audio[:, c], sample[::-1, c], mode="full")[
                len(sample) - 1 : len(audio)
            ]
            for c in range(audio.shape[1])
        )
        for peak in d["peaks"]:
            center = int(peak * d["hop"])
            a = max(0, center - round(0.025 * sr))
            b = min(len(audio) - len(sample), center + round(0.025 * sr))
            if b <= a:
                continue
            at = a + int(np.argmax(correlation[a:b]))
            gain = max(0, float(correlation[at]) / norm)
            if gain > 0.025:
                events.append([j, at, gain, 0.0])
    # Strong matches first avoids allocating a coherent hit to a weak lookalike.
    events.sort(
        key=lambda e: e[2] ** 2 * float(np.sum(templates[e[0]] ** 2)), reverse=True
    )
    for _ in range(10):
        for event in events:
            j, at, initial, old = event
            sample = templates[j]
            region = residual[at : at + len(sample)]
            norm = float(np.sum(sample**2)) + 1e-12
            gain = max(0, old + float(np.sum(region * sample)) / norm - 0.001)
            region -= (gain - old) * sample
            event[3] = gain
    error = float(np.linalg.norm(residual) / max(np.linalg.norm(audio), 1e-12))
    coherent = error < 0.55
    for j, part in enumerate(parts):
        part["discovery"]["waveformResidual"] = round(error, 4)
        part["discovery"]["phaseCoherent"] = coherent
        sample = templates[j]
        norm = float(np.sum(sample**2))
        own = [e for e in events if e[0] == j and e[3] > 0.06]
        contribution = sum(e[3] ** 2 * norm for e in own) / max(
            float(np.sum(audio**2)), 1e-12
        )
        support = sum(
            e[3] ** 2
            * norm
            / max(float(np.sum(audio[e[1] : e[1] + len(sample)] ** 2)), 1e-12)
            > 0.4
            for e in own
        )
        part["discovery"]["energyShare"] = round(contribution, 6)
        part["discovery"]["independentMatches"] = int(support)
        part["discovery"]["unsupported"] = bool(
            coherent and contribution < 0.001 and support < 3
        )
        part["discovery"]["needsReview"] = (
            not coherent or part["discovery"]["needsReview"]
        )
        if not coherent:
            continue
        accepted = [e for e in events if e[0] == j and e[3] > 0.06]
        notes = []
        for e in sorted(accepted, key=lambda e: e[1]):
            time = e[1] / sr
            if notes and time - notes[-1]["start"] < 0.012:
                if e[3] > notes[-1]["velocity"] / 127:
                    notes.pop()
                else:
                    continue
            notes.append(
                dict(
                    pitch=36 + j,
                    start=round(time, 6),
                    end=round(min(len(audio) / sr, time + 0.06), 6),
                    velocity=max(1, min(127, round(e[3] * 127))),
                    confidence=round(1 - error, 3),
                )
            )
        part["notes"] = notes


def fit_patch(sample, sr):
    mono = sample.mean(1)
    t = np.arange(len(mono)) / sr
    # Fit a damped pitch-sweeping resonator to the low-frequency body.
    low = signal.sosfilt(signal.butter(3, 1600, fs=sr, output="sos"), mono)
    spectrum = np.abs(np.fft.rfft(low * np.exp(-t / 0.15)))
    freqs = np.fft.rfftfreq(len(low), 1 / sr)
    valid = (freqs > 30) & (freqs < 1400)
    frequency = float(freqs[np.flatnonzero(valid)[np.argmax(spectrum[valid])]])
    envelope = ndimage.uniform_filter1d(low**2, max(1, round(0.01 * sr)))
    tail = np.flatnonzero(envelope > envelope.max() * 0.05)
    decay = float(np.clip((tail[-1] / sr if len(tail) else 0.1) / 1.5, 0.015, 1.2))
    # Variable projection fits phase/amplitude analytically while optimizing
    # resonant frequency, pitch fall and decay against the recovered low band.
    step = max(1, sr // 3000)
    fit_t = t[: round(0.35 * sr) : step]
    target = low[: len(fit_t) * step : step]

    def basis(parameters):
        hz, sweep, fall, tail = parameters
        phase = 2 * np.pi * (hz * fit_t + sweep * fall * (1 - np.exp(-fit_t / fall)))
        envelope = np.exp(-fit_t / tail) * np.minimum(1, fit_t / 0.0007)
        return np.stack([np.sin(phase) * envelope, np.cos(phase) * envelope], axis=1)

    def loss(parameters):
        design = basis(parameters)
        coeff = np.linalg.lstsq(design, target, rcond=None)[0]
        return design @ coeff - target

    options = []
    for initial in [frequency, frequency * 0.8]:
        fitted = optimize.least_squares(
            loss,
            [np.clip(initial, 25, 1500), frequency * 0.5, 0.018, decay],
            bounds=([20, 0, 0.002, 0.008], [1800, 2500, 0.15, 2]),
            max_nfev=70,
        )
        options.append(fitted)
    fitted = min(options, key=lambda r: np.sum(r.fun**2))
    design = basis(fitted.x)
    coefficients = np.linalg.lstsq(design, target, rcond=None)[0]
    frequency, sweep, fall, decay = map(float, fitted.x)
    amplitude = float(np.linalg.norm(coefficients))
    phase = float(np.arctan2(coefficients[1], coefficients[0]))
    noise = float(np.sqrt(np.mean((mono - low) ** 2)) * 2.8)
    return dict(
        engine="drum",
        tune=0,
        decay=1,
        transient=1,
        tone=1,
        noise=1,
        brightness=1,
        drive=0,
        gain=1,
        detail=1,
        chokeGroup="",
        model={
            "frequency": frequency,
            "sweep": sweep,
            "sweepDecay": fall,
            "phase": phase,
            "toneDecay": decay,
            "toneLevel": amplitude,
            "noiseLevel": noise,
            "noiseDecay": max(0.02, len(sample) / sr / 5),
            "pan": (
                float(np.sum(sample[:, 1] ** 2) / max(np.sum(sample**2), 1e-12))
                if sample.shape[1] > 1
                else 0.5
            ),
        },
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--catalog")
    args = parser.parse_args()
    try:
        analyze(args.input, args.output)
    except Exception as error:
        print(
            json.dumps({"stage": "Failed", "error": str(error), "progress": 0}),
            flush=True,
        )
        raise
