"""Out-of-model fixtures: SciPy oscillators/filters, not the application synth.

Truth and isolated sources are evaluation artifacts only. The analyzer receives
the mixture WAV and its ordinary catalogue, never these labels or parameters.
"""

import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy import signal

SR = 22050
DURATION = 9


def render(notes, waveform, cutoff, attack, release, amplitude):
    oversampling = 4
    rate = SR * oversampling
    output = np.zeros(DURATION * rate)
    for note in notes:
        gate = note["end"] - note["start"]
        t = np.arange(int((gate + release) * rate)) / rate
        phase = 2 * np.pi * 440 * 2 ** ((note["pitch"] - 69) / 12) * t
        if waveform == "pulse":
            raw = signal.square(phase, duty=0.31)
        elif waveform == "triangle":
            raw = signal.sawtooth(phase, width=0.5)
        elif waveform == "saw":
            raw = signal.sawtooth(phase)
        else:
            raw = np.sin(phase + 1.35 * np.sin(2 * phase))
        raw = signal.sosfilt(signal.butter(2, cutoff, fs=rate, output="sos"), raw)
        envelope = np.minimum(t / attack, 1) * (0.62 + 0.38 * np.exp(-t / 0.16))
        envelope *= np.clip((gate + release - t) / release, 0, 1)
        voice = raw * envelope * amplitude
        start = round(note["start"] * rate)
        length = min(len(voice), len(output) - start)
        output[start : start + length] += voice[:length]
    return signal.resample_poly(output, 1, oversampling)


def main(folder):
    folder.mkdir(parents=True, exist_ok=True)
    bass = dict(
        name="Filtered pulse bass",
        patch=None,
        notes=[
            dict(
                pitch=[36, 39, 43, 41][i % 4],
                start=0.3 + i * 0.5,
                end=0.64 + i * 0.5,
                velocity=95,
            )
            for i in range(16)
        ],
    )
    lead = dict(
        name="Filtered FM lead",
        patch=None,
        notes=[
            dict(
                pitch=[64, 69, 67, 72][i % 4],
                start=0.41 + i / 3,
                end=0.63 + i / 3,
                velocity=95,
            )
            for i in range(24)
        ],
    )
    pad = dict(
        name="Filtered saw chords",
        patch=None,
        notes=[
            dict(
                pitch=p + (5 if i % 2 else 0),
                start=0.55 + 2 * i,
                end=1.85 + 2 * i,
                velocity=85,
            )
            for i in range(4)
            for p in [48, 52, 55]
        ],
    )
    sources = [
        render(bass["notes"], "pulse", 900, 0.008, 0.09, 0.16),
        render(lead["notes"], "fm", 4500, 0.009, 0.15, 0.22),
        render(pad["notes"], "saw", 1800, 0.1, 0.24, 0.07),
    ]
    bell = dict(
        name="Triangle plucks",
        patch=None,
        notes=[
            dict(
                pitch=[76, 79, 83, 81][i % 4],
                start=0.7 + i * 2 / 3,
                end=0.82 + i * 2 / 3,
                velocity=90,
            )
            for i in range(12)
        ],
    )
    sources.append(render(bell["notes"], "triangle", 6500, 0.004, 0.08, 0.2))
    for name, indexes in [
        ("independent-solo", [1]),
        ("independent-duet", [0, 1]),
        ("independent-trio", [0, 1, 2]),
        ("independent-four", [0, 1, 2, 3]),
    ]:
        parts = [[bass, lead, pad, bell][i] for i in indexes]
        sf.write(folder / f"{name}.wav", sum(sources[i] for i in indexes), SR)
        for j, i in enumerate(indexes):
            sf.write(folder / f"{name}-source-{j}.wav", sources[i], SR)
        (folder / f"{name}-truth.json").write_text(
            json.dumps(dict(parts=parts, duration=DURATION, sr=SR), indent=2)
        )

    # Two contrasting timbres occupying the same register.
    overlap_bass = {
        **bass,
        "name": "Pulse sequence in lead register",
        "notes": [{**n, "pitch": n["pitch"] + 24} for n in bass["notes"]],
    }
    overlap_sources = [
        render(overlap_bass["notes"], "pulse", 900, 0.008, 0.09, 0.16),
        sources[1],
    ]
    sf.write(folder / "independent-overlap.wav", sum(overlap_sources), SR)
    for i, source in enumerate(overlap_sources):
        sf.write(folder / f"independent-overlap-source-{i}.wav", source, SR)
    (folder / "independent-overlap-truth.json").write_text(
        json.dumps(dict(parts=[overlap_bass, lead], duration=DURATION, sr=SR), indent=2)
    )

    # Exercise both ends of the model's 88-note range using the independent
    # oscillator generator. Labels and individual WAVs are evaluation-only.
    low = dict(
        name="Low electronic bass",
        patch=None,
        notes=[
            dict(
                pitch=[21, 24, 28, 26][i % 4],
                start=0.3 + i * 0.5,
                end=0.64 + i * 0.5,
                velocity=95,
            )
            for i in range(16)
        ],
    )
    high = dict(
        name="High electronic lead",
        patch=None,
        notes=[
            dict(
                pitch=[96, 100, 103, 108][i % 4],
                start=0.41 + i / 3,
                end=0.63 + i / 3,
                velocity=95,
            )
            for i in range(24)
        ],
    )
    edge_sources = [
        render(low["notes"], "pulse", 900, 0.008, 0.09, 0.16),
        render(high["notes"], "fm", 8500, 0.009, 0.15, 0.22),
    ]
    for name, indexes in [
        ("range-low", [0]),
        ("range-high", [1]),
        ("range-duet", [0, 1]),
    ]:
        sf.write(folder / f"{name}.wav", sum(edge_sources[i] for i in indexes), SR)
        for j, i in enumerate(indexes):
            sf.write(folder / f"{name}-source-{j}.wav", edge_sources[i], SR)
        (folder / f"{name}-truth.json").write_text(
            json.dumps(
                dict(parts=[[low, high][i] for i in indexes], duration=DURATION, sr=SR),
                indent=2,
            )
        )


if __name__ == "__main__":
    main(Path(sys.argv[1]))
