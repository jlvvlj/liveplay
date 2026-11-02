"""Experimental event-level assignment, evaluated separately before integration."""

import sys, json
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "analysis"))
import analyze as a
import numpy as np
from scipy import signal, ndimage
import soundfile as sf


def refine(source, result, proposals):
    y, sr = sf.read(source)
    _, times, z = signal.stft(y, fs=sr, nperseg=a.FFT, noverlap=a.FFT - a.HOP)
    V = abs(z)
    weight = 1 / np.maximum(V.mean(axis=1), V.max() * 0.0008) ** 0.35
    weight[:4] = 0
    V *= weight[:, None]
    proposals = proposals + [n for p in result["parts"] for n in p["notes"]]
    # Join a model's attack/sustain split into a second, longer proposal.
    for n in list(proposals):
        following = [
            m
            for m in proposals
            if m is not n
            and m["pitch"] == n["pitch"]
            and 0 <= m["start"] - n["end"] < 0.06
        ]
        if following:
            proposals.append({**n, "end": max(m["end"] for m in following)})
    proposals = sorted(proposals, key=lambda n: (n["pitch"], n["start"], n["end"]))
    unique = []
    for n in proposals:
        if not any(
            n["pitch"] == m["pitch"]
            and abs(n["start"] - m["start"]) < 0.04
            and abs(n["end"] - m["end"]) < 0.08
            for m in unique
        ):
            unique.append(n)
    spectra = []
    envelopes = []
    atoms = []
    for i, part in enumerate(result["parts"]):
        p = part["patch"]
        for n in unique:
            if not 30 <= n["pitch"] < 90:
                continue
            d = a.basis(a.harmonics(p), [n["pitch"]])[:, 0] * weight
            d /= max(np.linalg.norm(d), 1e-9)
            t = times - n["start"]
            gate = n["end"] - n["start"]
            held = np.where(
                t < p["attack"],
                np.maximum(t, 0) / p["attack"],
                p["sustain"]
                + (1 - p["sustain"])
                * np.exp(np.minimum(0, -4 * (t - p["attack"]) / p["decay"])),
            )
            at = p["sustain"] + (1 - p["sustain"]) * np.exp(
                -4 * max(0, gate - p["attack"]) / p["decay"]
            )
            env = np.where(
                t <= gate,
                held,
                at * np.exp(np.minimum(0, -6 * (t - gate) / p["release"])),
            )
            env = np.where(t >= 0, env, 0)
            env = ndimage.gaussian_filter1d(env, 3)
            spectra.append(d)
            envelopes.append(env)
            atoms.append((i, n))
    D = np.stack(spectra, axis=1)
    E = np.stack(envelopes)
    gram = (D.T @ D) * (E @ E.T)
    b = np.sum((D.T @ V) * E, axis=1)
    x = np.maximum(b, 1e-9) / np.maximum(gram.sum(axis=1), 1e-9)
    penalty = b.max() * 0.012
    for _ in range(600):
        x *= np.maximum(b - penalty, 1e-12) / (gram @ x + 1e-12)
    for i, part in enumerate(result["parts"]):
        indexes = [j for j, (p, n) in enumerate(atoms) if p == i]
        peak = max(x[indexes])
        chosen = []
        for j in sorted(indexes, key=lambda j: -x[j]):
            if x[j] < peak * 0.2:
                continue
            _, n = atoms[j]
            if any(
                n["pitch"] == m["pitch"]
                and max(0, min(n["end"], m["end"]) - max(n["start"], m["start"]))
                > 0.5 * min(n["end"] - n["start"], m["end"] - m["start"])
                for m in chosen
            ):
                continue
            chosen.append({**n, "velocity": int(np.clip(95 * x[j] / peak, 30, 120))})
        part["notes"] = sorted(chosen, key=lambda n: n["start"])
    return result


if __name__ == "__main__":
    r = refine(
        sys.argv[1],
        json.loads(Path(sys.argv[2]).read_text()),
        json.loads(Path(sys.argv[3]).read_text()),
    )
    Path(sys.argv[4]).write_text(json.dumps(r, indent=2))
