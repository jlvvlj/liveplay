import numpy as np, soundfile as sf, json
from scipy import signal
from pathlib import Path


def drum_fixture(seed=912):
    sr = 44100
    rng = np.random.default_rng(seed)
    t = np.arange(sr * 2) / sr
    # Independently authored reference sounds: chirped resonators and filtered noise.
    a = []
    a.append(
        np.sin(2 * np.pi * (49 * t + 105 * 0.021 * (1 - np.exp(-t / 0.021))))
        * np.exp(-t / 0.17)
    )
    a.append(
        0.8
        * np.sin(2 * np.pi * (78 * t + 140 * 0.012 * (1 - np.exp(-t / 0.012))))
        * np.exp(-t / 0.11)
    )
    n = rng.standard_normal(len(t))
    n = signal.sosfilt(signal.butter(2, 1100, fs=sr, btype="high", output="sos"), n)
    a.append((n * 0.24 + np.sin(2 * np.pi * 181 * t) * 0.32) * np.exp(-t / 0.085))
    n2 = signal.sosfilt(
        signal.butter(2, [900, 5800], fs=sr, btype="band", output="sos"),
        rng.standard_normal(len(t)),
    )
    a.append(
        n2
        * 0.8
        * (
            np.exp(-t / 0.045)
            + 0.6 * np.exp(-np.maximum(t - 0.018, 0) / 0.07) * (t > 0.018)
        )
    )
    metal = sum(np.sin(2 * np.pi * f * t) for f in [4123, 5719, 7327, 9013, 11417]) / 5
    h = (
        signal.sosfilt(
            signal.butter(2, 6300, fs=sr, btype="high", output="sos"),
            rng.standard_normal(len(t)),
        )
        * 0.18
        + metal * 0.4
    )
    a.extend([h * np.exp(-t / 0.032), h * np.exp(-t / 0.24)])
    a = [v * np.minimum(t / 0.0007, 1) * 0.65 for v in a]
    y = np.zeros((sr * 20, 2))
    truth = [[] for _ in a]
    # Clean exemplars appear only at the beginning; later held-out hits overlap.
    for j in range(6):
        for k in range(3):
            truth[j].append((0.3 + j * 1.25 + k * 0.32, 0.5 + 0.2 * k))
    for i in range(48):
        st = 8 + i * 0.24
        (
            truth[0 if i % 8 < 4 else 1].append((st, float(rng.uniform(0.5, 1))))
            if i % 2 == 0
            else None
        )
        if i % 4 == 2:
            truth[2 if i % 8 < 4 else 3].append((st + 0.006, 0.8))
        truth[5 if i % 8 == 7 else 4].append((st, float(rng.uniform(0.28, 0.8))))
        if i % 12 == 9:
            truth[2].extend([(st + 0.06, 0.14), (st + 0.105, 0.22), (st + 0.15, 0.32)])
    for j, events in enumerate(truth):
        for st, gain in events:
            start = round(st * sr)
            length = min(len(a[j]), len(y) - start)
            pan = 0.25 + 0.1 * j
            y[start : start + length, 0] += a[j][:length] * gain * np.sqrt(1 - pan)
            y[start : start + length, 1] += a[j][:length] * gain * np.sqrt(pan)
    return y, sr, truth, a
