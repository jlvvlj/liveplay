# /// script
# requires-python = ">=3.10,<3.12"
# dependencies = [
#   "basic-pitch==0.4.0",
#   "librosa>=0.10",
#   "soundfile",
#   "numpy<2",
#   "setuptools<70",
# ]
# ///
"""Transcribe a pitched stem (bass, synths/keys/guitar) into notes with
Spotify's Basic Pitch (CoreML backend on macOS, no TensorFlow).

Emits the stem-lesson contract shared with the other analyzers. Each
distinct pitch becomes one sound (a lane), ordered low to high and labelled
with its note name, with an exemplar clip sliced from the stem where that
pitch is played; a lane with a single pitch always plays the right note.

  {"duration": 155.1,
   "sounds": [{"id": 0, "label": "E1", "pitch": 28, "clip": "sound-0.wav",
               "centroidHz": 41.2, "start": 21.4, "end": 22.1}, ...],
   "events": [{"time": 21.41, "sound": 0, "velocity": 96, "pitch": 28,
               "noteEnd": 21.9}, ...]}

Profiles:
  bass     30-400Hz, one note at a time (lowest strong note wins), which
           removes the octave harmonics Basic Pitch tends to add; rarely
           used octaves fold into their pitch class's dominant octave
  melodic  full range, chords allowed (the charting stage caps polyphony)
"""

import argparse
import contextlib
import json
import sys
from pathlib import Path

import numpy as np

PROFILES = {
    "bass": {
        "minimum_frequency": 30.0,
        "maximum_frequency": 400.0,
        "onset_threshold": 0.5,
        "frame_threshold": 0.3,
        "minimum_note_length": 80.0,  # ms
        "monophonic": True,
    },
    "melodic": {
        "minimum_frequency": 55.0,
        "maximum_frequency": 4200.0,
        "onset_threshold": 0.5,
        "frame_threshold": 0.3,
        "minimum_note_length": 60.0,  # ms
        "monophonic": False,
    },
}
SIMULTANEOUS_SEC = 0.03  # onsets this close count as one attack (monophonic mode)
OCTAVE_FOLD_SHARE = 0.35  # an octave used < 35% as often as its pitch class's main octave folds into it
LOW_NOTE_PREFERENCE = 0.6  # a lower note wins if at least this fraction as loud
MIN_CLIP_SEC = 0.12
MAX_CLIP_SEC = 1.5
TARGET_RMS = 0.18
PEAK_CEILING = 0.95
NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def note_name(midi: int) -> str:
    return f"{NOTE_NAMES[midi % 12]}{midi // 12 - 1}"


def midi_to_hz(midi: int) -> float:
    return 440.0 * 2 ** ((midi - 69) / 12)


def to_monophonic(notes: list[dict]) -> list[dict]:
    """One note at a time: per attack keep the lowest note that is nearly as
    loud as the loudest (a fundamental beats its octave harmonic), then cut
    each note off at the next attack."""
    notes = sorted(notes, key=lambda n: n["start"])
    attacks: list[list[dict]] = []
    for note in notes:
        if attacks and note["start"] - attacks[-1][0]["start"] <= SIMULTANEOUS_SEC:
            attacks[-1].append(note)
        else:
            attacks.append([note])
    mono = []
    for group in attacks:
        loudest = max(n["amplitude"] for n in group)
        strong = [n for n in group if n["amplitude"] >= LOW_NOTE_PREFERENCE * loudest]
        mono.append(dict(min(strong, key=lambda n: n["pitch"])))
    for current, following in zip(mono, mono[1:]):
        current["end"] = min(current["end"], following["start"])
    return [n for n in mono if n["end"] > n["start"]]


def fold_octave_errors(notes: list[dict]) -> list[dict]:
    """Octave errors are the classic bass transcription mistake: a C2 line
    gets a few stray C3s. Rarely used octaves of a pitch class move to that
    pitch class's dominant octave; deliberate octave jumps that recur often
    enough keep their own pitch."""
    counts: dict[int, int] = {}
    for n in notes:
        counts[n["pitch"]] = counts.get(n["pitch"], 0) + 1
    dominant: dict[int, int] = {}
    for pitch, count in counts.items():
        pc = pitch % 12
        if pc not in dominant or count > counts[dominant[pc]]:
            dominant[pc] = pitch
    folded = []
    for n in notes:
        home = dominant[n["pitch"] % 12]
        if n["pitch"] != home and counts[n["pitch"]] < OCTAVE_FOLD_SHARE * counts[home]:
            n = {**n, "pitch": home}
        folded.append(n)
    return folded


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, help="stem wav")
    parser.add_argument("--output", required=True, help="directory for sound clips")
    parser.add_argument("--profile", choices=sorted(PROFILES), required=True)
    args = parser.parse_args()

    if not Path(args.input).is_file():
        print(json.dumps({"error": f"Input not found: {args.input}"}))
        return 1

    import soundfile as sf
    from basic_pitch.inference import predict

    profile = PROFILES[args.profile]
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    # the library prints model/backend info; keep stdout clean for JSON
    with contextlib.redirect_stdout(sys.stderr):
        _, _, note_events = predict(
            args.input,
            onset_threshold=profile["onset_threshold"],
            frame_threshold=profile["frame_threshold"],
            minimum_note_length=profile["minimum_note_length"],
            minimum_frequency=profile["minimum_frequency"],
            maximum_frequency=profile["maximum_frequency"],
            melodia_trick=True,
        )

    notes = [
        {"start": float(start), "end": float(end), "pitch": int(pitch), "amplitude": float(amp)}
        for start, end, pitch, amp, _bends in note_events
    ]
    if profile["monophonic"]:
        notes = fold_octave_errors(to_monophonic(notes))
    notes.sort(key=lambda n: (n["start"], n["pitch"]))
    if not notes:
        print(json.dumps({"error": "No notes were found in this stem"}))
        return 1

    stereo, sr = sf.read(args.input, always_2d=True)  # (samples, channels)
    duration = len(stereo) / sr

    # one lane per distinct pitch, low to high
    pitches = sorted({n["pitch"] for n in notes})
    sound_ids = {pitch: i for i, pitch in enumerate(pitches)}
    amplitudes = np.array([n["amplitude"] for n in notes])
    amp_ref = float(np.percentile(amplitudes, 95)) or 1.0

    sounds = []
    for pitch in pitches:
        candidates = [n for n in notes if n["pitch"] == pitch]
        # exemplar: a long, strong occurrence of this pitch
        exemplar = max(candidates, key=lambda n: (min(n["end"] - n["start"], MAX_CLIP_SEC), n["amplitude"]))
        start = int(exemplar["start"] * sr)
        length = int(min(max(exemplar["end"] - exemplar["start"], MIN_CLIP_SEC), MAX_CLIP_SEC) * sr)
        clip = stereo[start : start + length].copy()
        fade = max(int(len(clip) * 0.25), 1)
        clip[-fade:] *= np.linspace(1.0, 0.0, fade)[:, None]
        peak = np.abs(clip).max()
        if peak > 1e-4:
            rms = float(np.sqrt(np.mean(clip**2)))
            clip *= min(TARGET_RMS / max(rms, 1e-9), PEAK_CEILING / peak)
        sound_id = sound_ids[pitch]
        filename = f"sound-{sound_id}.wav"
        sf.write(str(output_dir / filename), clip, sr, subtype="PCM_16")
        sounds.append(
            {
                "id": sound_id,
                "label": note_name(pitch),
                "pitch": pitch,
                "clip": filename,
                # the fundamental: lets the charting stage fold rare pitches
                # into their nearest neighbour
                "centroidHz": round(midi_to_hz(pitch), 1),
                "start": round(start / sr, 4),
                "end": round((start + len(clip)) / sr, 4),
            }
        )

    events = [
        {
            "time": round(n["start"], 4),
            "sound": sound_ids[n["pitch"]],
            "velocity": int(40 + np.clip(n["amplitude"] / amp_ref, 0, 1) * 87),
            "pitch": n["pitch"],
            "noteEnd": round(n["end"], 4),
        }
        for n in notes
    ]

    print(json.dumps({"duration": round(duration, 2), "sounds": sounds, "events": events}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        sys.exit(1)
