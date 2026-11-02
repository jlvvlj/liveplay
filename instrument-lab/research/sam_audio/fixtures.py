"""Electronic separation fixtures independent of Melodics' synth engine.

The inference manifest contains mixtures and explicit target prompts. Isolated
sources and note truth live in a separate scoring manifest. This is a prompted
separation test, NOT evidence of automatic source discovery.
"""

import argparse
import json
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy import signal

RATE = 24000


def voice(notes, duration, kind, pan, seed):
    output = np.zeros(round(duration * RATE), dtype=np.float32)
    rng = np.random.default_rng(seed)
    for note in notes:
        gate = note["end"] - note["start"]
        release = 0.3 if kind == "pad" else 0.08
        t = np.arange(round((gate + release) * RATE), dtype=np.float32) / RATE
        hz = 440 * 2 ** ((note["pitch"] - 69) / 12)
        phase = 2 * np.pi * hz * t
        if kind == "kick":
            raw = np.sin(2 * np.pi * (48 * t + 6 * (1 - np.exp(-t * 35))))
            raw += rng.normal(0, 0.12, len(t)) * np.exp(-t * 90)
            envelope = (1 - np.exp(-t * 1500)) * np.exp(-t * 18)
        else:
            # Additive oscillators avoid aliasing without using the app's engine.
            raw = np.zeros_like(t)
            if kind == "fm":
                raw = np.sin(phase + 1.2 * np.sin(2 * phase))
            else:
                cutoff = {"bass": 950, "pad": 1800, "pulse-a": 1400, "pulse-b": 2100}[kind]
                for h in range(1, min(32, int(RATE / 2 / hz))):
                    weight = 1 / h / np.sqrt(1 + (hz * h / cutoff) ** 4)
                    if kind.startswith("pulse") or kind == "bass":
                        duty = 0.31 if kind != "pulse-b" else 0.43
                        weight *= np.sin(np.pi * h * duty)
                    raw += weight * np.sin(h * phase)
                    if kind == "pad":
                        raw += weight * 0.3 * np.sin(h * phase * 1.003)
            attack = 0.08 if kind == "pad" else 0.006
            held = np.minimum(t / attack, 1) * (0.65 + 0.35 * np.exp(-t / 0.12))
            envelope = held * np.exp(-np.maximum(t - gate, 0) / (release / 5))
        start = round(note["start"] * RATE)
        size = min(len(t), len(output) - start)
        output[start:start + size] += (raw[:size] * envelope[:size] * 0.14).astype(np.float32)
    angle = (pan + 1) * np.pi / 4
    return np.stack([output * np.cos(angle), output * np.sin(angle)], axis=1)


def note(pitch, start, length):
    return dict(pitch=pitch, start=round(start, 4), end=round(start + length, 4), velocity=100)


def source(identifier, description, kind, notes, pan=0):
    return dict(id=identifier, description=description, kind=kind, notes=notes, pan=pan)


def cases(include_long):
    bass = source("bass", "low pulsing synth bass", "bass", [note([36, 39, 43, 41][i % 4], 0.5 + i * 0.5, 0.3) for i in range(20)], -0.35)
    lead = source("lead", "bright short electronic lead melody", "fm", [note([64, 69, 67, 72][i % 4], 1.2 + i * 0.4, 0.19) for i in range(24)], 0.45)
    pad = source("pad", "sustained warm synthesizer chords", "pad", [note(p, 2 + i * 2.5, 1.6) for i in range(3) for p in [48, 52, 55]], 0.15)
    kick = source("kick", "electronic kick drum", "kick", [note(36, 0.25 + i * 0.5, 0.15) for i in range(22)])
    a = source("pulse-a", "dark pulsing synthesizer melody", "pulse-a", [note([60, 64, 67, 62][i % 4], 0.5 + i * 0.5, 0.32) for i in range(18)], -0.6)
    b = source("pulse-b", "brighter pulsing synthesizer melody", "pulse-b", [note([67, 64, 60, 65][i % 4], 2.75 + i * 0.5, 0.3) for i in range(16)], 0.6)
    result = [
        ("distinct-duet", 12, [bass, lead]),
        ("chords-and-drums", 12, [bass, lead, pad, kick]),
        ("similar-overlapping-synths", 12, [a, b]),
        ("absent-target", 12, [kick]),
    ]
    if include_long:
        long_parts = []
        for original in [bass, lead, pad, kick]:
            expanded = {**original, "notes": []}
            for section in range(17):
                # Sources disappear and return; identities must survive gaps.
                if (section + len(original["id"])) % 4 == 0:
                    continue
                for n in original["notes"]:
                    expanded["notes"].append({**n, "start": n["start"] + section * 12, "end": n["end"] + section * 12})
            long_parts.append(expanded)
        result.append(("full-length-arrangement", 210, long_parts))
    return result


def prepare(folder, include_long=True):
    folder.mkdir(parents=True, exist_ok=True)
    jobs, truth = [], []
    for case, duration, sources in cases(include_long):
        case_dir = folder / case
        case_dir.mkdir(exist_ok=True)
        rendered = [voice(p["notes"], duration, p["kind"], p["pan"], i) for i, p in enumerate(sources)]
        mixture = sum(rendered)
        scale = min(1, 0.9 / max(float(np.max(np.abs(mixture))), 1e-9))
        mix_path = case_dir / "mix.wav"
        sf.write(mix_path, mixture * scale, RATE, subtype="FLOAT")
        for part, audio in zip(sources, rendered):
            target = case_dir / (part["id"] + "-truth.wav")
            sf.write(target, audio * scale, RATE, subtype="FLOAT")
            first = part["notes"][0]
            anchors = [["+", first["start"], first["end"]]]
            if first["start"] > 0.2:
                anchors.append(["-", 0, first["start"] - 0.1])
            job_id = case + "--" + part["id"]
            jobs.append(dict(id=job_id, case=case, input=str(mix_path.relative_to(folder)), description=part["description"], anchors=anchors))
            truth.append(dict(id=job_id, case=case, input=str(mix_path.relative_to(folder)), target=str(target.relative_to(folder)), notes=part["notes"], kind=part["kind"], duration=duration, expectedPresent=True))
        if case == "absent-target":
            target = case_dir / "missing-lead-truth.wav"
            sf.write(target, np.zeros_like(mixture), RATE, subtype="FLOAT")
            identifier = case + "--missing-lead"
            jobs.append(dict(id=identifier, case=case, input=str(mix_path.relative_to(folder)), description="bright short electronic lead melody", anchors=[]))
            truth.append(dict(id=identifier, case=case, input=str(mix_path.relative_to(folder)), target=str(target.relative_to(folder)), notes=[], kind="fm", duration=duration, expectedPresent=False))
    (folder / "inference.json").write_text(json.dumps(dict(version=1, supervision="explicit-target-prompts-and-spans", jobs=jobs), indent=2) + "\n")
    (folder / "truth.json").write_text(json.dumps(dict(version=1, sources=truth), indent=2) + "\n")
    return len(jobs)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    parser.add_argument("--short-only", action="store_true")
    args = parser.parse_args()
    print(json.dumps({"jobs": prepare(args.output, not args.short_only), "output": str(args.output)}))
