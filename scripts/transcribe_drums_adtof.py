# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = [
#   "adtof-pytorch @ git+https://github.com/xavriley/ADTOF-pytorch.git@85c192e78f716ea0b111cc8a5ee4a8f6a3a4f8a9",
#   "pretty_midi",
#   "librosa>=0.10",
#   "soundfile",
#   "numpy",
# ]
# ///
"""Transcribe a separated drum stem with the ADTOF CRNN (trained on real music).

Emits the stem-lesson contract shared with analyze_stem_sounds.py, so the
server and the sound editor treat both the same way. Each drum class the
model finds becomes one sound (a lane), with an exemplar clip sliced from
the stem:

  {"duration": 155.1,
   "sounds": [{"id": 0, "label": "Kick", "clip": "sound-0.wav",
               "centroidHz": 88.0, "start": 21.40, "end": 22.05}, ...],
   "events": [{"time": 21.4091, "sound": 0, "velocity": 104}, ...]}

Velocities come from the drum stem's onset-strength envelope at each hit
(the model itself does not predict dynamics). Tempo is not estimated here:
the server applies the song-wide beat grid.
"""

import argparse
import contextlib
import json
import os
import sys
import tempfile
from pathlib import Path

import numpy as np

# ADTOF class MIDI pitches -> our drum classes
PITCH_TO_DRUM = {
    35: "kick",
    36: "kick",
    38: "snare",
    40: "snare",
    42: "hihat",
    44: "hihat",
    46: "hihat",
    45: "toms",
    47: "toms",
    48: "toms",
    50: "toms",
    49: "cymbals",
    51: "cymbals",
    52: "cymbals",
    55: "cymbals",
    57: "cymbals",
    59: "cymbals",
}
# lane order, low to high, like a drum kit read left to right
DRUM_ORDER = ["kick", "snare", "hihat", "toms", "cymbals"]
DRUM_LABELS = {"kick": "Kick", "snare": "Snare", "hihat": "Hi-hat", "toms": "Toms", "cymbals": "Cymbals"}

MIN_CLIP_SEC = 0.12
MAX_CLIP_SEC = 1.0
ISOLATION_SEC = 0.04  # another class within this window counts as simultaneous
TARGET_RMS = 0.18
PEAK_CEILING = 0.95


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, help="drum stem wav")
    parser.add_argument("--output", required=True, help="directory for sound clips")
    args = parser.parse_args()

    if not Path(args.input).is_file():
        print(json.dumps({"error": f"Input not found: {args.input}"}))
        return 1

    import librosa
    import pretty_midi
    import soundfile as sf
    from adtof_pytorch import transcribe_to_midi

    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp:
        midi_path = str(Path(tmp) / "drums.mid")
        # The library logs to stdout; keep stdout clean for our JSON contract.
        with open(os.devnull, "w") as devnull, contextlib.redirect_stdout(devnull):
            transcribe_to_midi(args.input, midi_path)
        midi = pretty_midi.PrettyMIDI(midi_path)

    hits = []  # (time, drum)
    for instrument in midi.instruments:
        for note in instrument.notes:
            drum = PITCH_TO_DRUM.get(note.pitch)
            if drum is not None:
                hits.append((float(note.start), drum))
    hits.sort()
    if not hits:
        print(json.dumps({"error": "The drum model found no hits in this stem"}))
        return 1

    stereo, sr = sf.read(args.input, always_2d=True)  # (samples, channels)
    mono = stereo.mean(axis=1)
    duration = len(mono) / sr

    # velocity from the audio's onset envelope at each hit
    hop = 512
    onset_env = librosa.onset.onset_strength(y=mono, sr=sr, hop_length=hop)
    ref = np.percentile(onset_env, 98) if len(onset_env) else 1.0

    def velocity_at(time: float) -> int:
        frame = int(time * sr / hop)
        window = onset_env[max(frame - 1, 0) : frame + 3]
        strength = float(np.max(window)) if len(window) else 0.0
        return int(40 + np.clip(strength / max(ref, 1e-9), 0, 1) * 87)

    onset_times = sorted({t for t, _ in hits})

    def gap_after(time: float) -> float:
        later = [t for t in onset_times if t > time + 1e-4]
        return (later[0] if later else duration) - time

    def isolated(time: float, drum: str) -> bool:
        return not any(d != drum and abs(t - time) <= ISOLATION_SEC for t, d in hits)

    present = [d for d in DRUM_ORDER if any(drum == d for _, drum in hits)]
    sound_ids = {drum: i for i, drum in enumerate(present)}

    sounds = []
    for drum in present:
        times = [t for t, d in hits if d == drum]
        # exemplar: prefer a hit with no other drum at the same moment, then
        # the most room before the next onset, then the strongest
        exemplar = max(times, key=lambda t: (isolated(t, drum), min(gap_after(t), MAX_CLIP_SEC), velocity_at(t)))
        start = int(exemplar * sr)
        length = int(min(max(gap_after(exemplar), MIN_CLIP_SEC), MAX_CLIP_SEC) * sr)
        clip = stereo[start : start + length].copy()
        fade = max(int(len(clip) * 0.25), 1)
        clip[-fade:] *= np.linspace(1.0, 0.0, fade)[:, None]
        peak = np.abs(clip).max()
        if peak > 1e-4:
            rms = float(np.sqrt(np.mean(clip**2)))
            clip *= min(TARGET_RMS / max(rms, 1e-9), PEAK_CEILING / peak)
        sound_id = sound_ids[drum]
        filename = f"sound-{sound_id}.wav"
        sf.write(str(output_dir / filename), clip, sr, subtype="PCM_16")
        centroid = librosa.feature.spectral_centroid(y=clip.mean(axis=1), sr=sr).mean()
        sounds.append(
            {
                "id": sound_id,
                "label": DRUM_LABELS[drum],
                "clip": filename,
                "centroidHz": round(float(centroid), 1),
                "start": round(start / sr, 4),
                "end": round((start + len(clip)) / sr, 4),
            }
        )

    events = [
        {"time": round(t, 4), "sound": sound_ids[d], "velocity": velocity_at(t)}
        for t, d in hits
    ]

    print(json.dumps({"duration": round(duration, 2), "sounds": sounds, "events": events}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        sys.exit(1)
