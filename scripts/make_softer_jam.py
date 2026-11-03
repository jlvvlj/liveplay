# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = [
#   "librosa>=0.10",
#   "soundfile",
#   "numpy",
# ]
# ///
"""Makes the Jam tab's Softer backing track and Softer sound from the Softer
Ableton project folder (its Live Set and its tracks exported one by one with
File > Export Audio/Video > All Individual Tracks, rendered from 1.1.1).

Every track gets one sound, cut from its own export:
  - a MIDI track: one of its notes (or strummed chords), the one with the most
    room around it;
  - an audio track whose clips are one-shots (chops, swells, crash): one clip;
  - an audio loop (hats, percussion, vocal chops): one of its loudest hits.

The backing track is the song's last 8 bars, every track that plays there as
one grid row, on the nearest 16ths: a MIDI track's own notes, a one-shot
track's clips, and the hits found in a loop's export (vocal chops at the pitch
each one is sung at). A chord track plays a chord per note, cut from the song
for each chord it plays there.

    uv run scripts/make_softer_jam.py "<project folder>"

Writes lesson-engine/softer/*.wav and lesson-engine/jamSofter.ts.
"""

import argparse
import gzip
import json
import re
import xml.etree.ElementTree as ET
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf

ENGINE = Path(__file__).resolve().parent.parent / "apps/desktop/src/renderer/components/lesson-engine"
SAMPLE_RATE = 44100
WINDOW = (256, 288)  # beats: bars 65 to 72, the second drop's last 8 bars
STEPS = (WINDOW[1] - WINDOW[0]) * 4
LANES = 16  # rows of the Jam tab's highway
# Audio tracks whose clips are loops: their hits are found in the export
LOOPS = {"Hat Loop", "Percussion Loop", "Hat Loop 2", "Percussion Loop 2", "Vocal Chop"}
PITCHED_LOOPS = {"Vocal Chop"}
MAX_SOUND_SECONDS = 8.0
QUIETEST_HIT_DB = -36  # hits of a loop this far below its loudest are left out
END_DB = -50  # a sound ends where it stays this far below its peak
FADE_SECONDS = 0.02
STRUM_BEATS = 0.25  # notes on different keys starting this close together are one chord


def val(el, path, default=None):
    found = el.find(path) if el is not None else None
    return found.get("Value") if found is not None else default


def clip_notes(clip):
    """Every note of an arrangement MIDI clip, placed on the arrangement, as abletonImport.ts does."""
    if val(clip, "Disabled") == "true":
        return []
    start = float(clip.get("Time"))
    end = float(val(clip, "CurrentEnd"))
    loop = clip.find("Loop")
    loop_on = val(loop, "LoopOn") == "true"
    loop_start, loop_end = float(val(loop, "LoopStart")), float(val(loop, "LoopEnd"))
    relative = float(val(loop, "StartRelative", 0))
    length = loop_end - loop_start
    notes = []
    for key_track in clip.iter("KeyTrack"):
        key = int(val(key_track, "MidiKey"))
        for event in key_track.iter("MidiNoteEvent"):
            if event.get("IsEnabled") == "false":
                continue
            time = float(event.get("Time"))
            if time < loop_start or time >= loop_end:
                continue
            note = {"key": key, "dur": float(event.get("Duration")), "vel": round(float(event.get("Velocity")))}
            if loop_on and length > 0:
                offset = time - loop_start - relative
                if offset < 0:
                    offset += length
                beat = start + offset
                while beat < end - 1e-9:
                    notes.append({**note, "beat": beat})
                    beat += length
            elif start + time - loop_start < end - 1e-9:
                notes.append({**note, "beat": start + time - loop_start})
    return notes


def read_set(folder):
    sets = [p for p in folder.rglob("*.als") if "Backup" not in p.parts]
    live_set = ET.fromstring(gzip.decompress(sets[0].read_bytes())).find("LiveSet")
    main = live_set.find("MainTrack")
    if main is None:
        main = live_set.find("MasterTrack")  # before Live 12
    tempo = float(val(main, ".//Tempo/Manual"))
    tracks = []
    for track in live_set.find("Tracks"):
        if track.tag not in ("MidiTrack", "AudioTrack"):
            continue
        name = val(track, "Name/EffectiveName")
        events = track.find(".//ArrangerAutomation/Events")
        if track.tag == "MidiTrack":
            notes = sorted(
                (n for clip in events.findall("MidiClip") for n in clip_notes(clip)), key=lambda n: (n["beat"], n["key"])
            )
            if notes:
                tracks.append({"name": name, "midi": True, "notes": notes})
        else:
            clips = [
                {"start": float(c.get("Time")), "end": float(val(c, "CurrentEnd"))}
                for c in events.findall("AudioClip")
                if val(c, "Disabled") != "true"
            ]
            if clips:
                tracks.append({"name": name, "midi": False, "clips": sorted(clips, key=lambda c: c["start"])})
    return tempo, tracks


def find_export(folder, name):
    """The newest WAV named after the track, outside the project's samples (as abletonImport.ts pairs them)."""
    norm = lambda s: re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()
    matches = [
        p
        for p in folder.rglob("*.wav")
        if not {"Samples", "Backup"} & set(p.parts) and norm(p.stem).endswith(" " + norm(name))
    ]
    return max(matches, key=lambda p: p.stat().st_mtime)


def trim(audio, start, seconds):
    """A sound from `start`, without its silent end, fading out over its last few ms."""
    sound = audio[int(start * SAMPLE_RATE) : int((start + min(seconds, MAX_SOUND_SECONDS)) * SAMPLE_RATE)].copy()
    level = np.abs(sound).max(axis=1)
    loud = np.nonzero(level > level.max() * 10 ** (END_DB / 20))[0]
    sound = sound[: (loud[-1] + 1 if len(loud) else 1)]
    fade = min(len(sound), int(FADE_SECONDS * SAMPLE_RATE))
    sound[len(sound) - fade :] *= np.linspace(1, 0, fade)[:, None]
    return sound


def chords(notes):
    """A track's notes as chords: notes on different keys starting within a strum of each other."""
    out = []
    for n in notes:
        last = out[-1] if out else None
        if last and n["beat"] - last[-1]["beat"] < STRUM_BEATS and n["key"] not in {m["key"] for m in last}:
            last.append(n)
        else:
            out.append([n])
    return out


def chord_key(chord):
    return tuple(sorted(n["key"] for n in chord))


def cut_chord(groups, audio, spb, wanted=None):
    """A chord (or note), of those playing `wanted` keys if given, in the window if the track
    plays there (elsewhere in the song it may be filtered or mixed differently): of those with
    at least half the longest gap after them (which holds their effects' tail), the loudest, as
    a sidechain may duck the others."""
    here = any(in_window(g[0]["beat"]) and (not wanted or chord_key(g) == wanted) for g in groups)
    candidates = []
    for i, chord in enumerate(groups):
        if wanted and chord_key(chord) != wanted or here and not in_window(chord[0]["beat"]):
            continue
        after = groups[i + 1][0]["beat"] - chord[0]["beat"] if i + 1 < len(groups) else 8
        start = int(chord[0]["beat"] * spb * SAMPLE_RATE)
        level = np.mean(audio[start : start + int(min(after, 1) * spb * SAMPLE_RATE)] ** 2)
        candidates.append((chord, after, level))
    longest = max(after for _, after, _ in candidates)
    best, after, _ = max((c for c in candidates if c[1] >= longest / 2), key=lambda c: c[2])
    root = min(best, key=lambda n: n["key"])
    return {
        "audio": trim(audio, best[0]["beat"] * spb, after * spb),
        "root": root["key"],
        "velocity": root["vel"],
        "held": max(n["dur"] for n in best) * 4,
    }


def onsets(audio, start, seconds, pitched):
    """Hits of a loop's export: (seconds from `start`, level in dB, MIDI pitch or None)."""
    mono = audio[int(start * SAMPLE_RATE) : int((start + seconds) * SAMPLE_RATE)].mean(axis=1)
    times = librosa.onset.onset_detect(y=mono, sr=SAMPLE_RATE, units="time", hop_length=256, backtrack=True)
    if pitched:
        f0, _, _ = librosa.pyin(mono, fmin=80, fmax=1000, sr=SAMPLE_RATE, hop_length=512)
    hits = []
    for t in times:
        window = mono[int(t * SAMPLE_RATE) : int(t * SAMPLE_RATE) + int(0.05 * SAMPLE_RATE)]
        level = 20 * np.log10(np.sqrt(np.mean(window**2)) + 1e-9)
        pitch = None
        if pitched:
            frames = f0[int(t * SAMPLE_RATE / 512) + 4 : int(t * SAMPLE_RATE / 512) + 14]
            frames = frames[~np.isnan(frames)]
            if not len(frames):
                continue
            pitch = int(round(librosa.hz_to_midi(np.median(frames))))
        hits.append((t, level, pitch))
    return hits


def slug(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def in_window(beat):
    return WINDOW[0] <= beat < WINDOW[1]


def step_of(beat):
    return int(round((beat - WINDOW[0]) * 4)) % STEPS


def midi_track(track, audio, spb):
    groups = chords(track["notes"])
    sound = cut_chord(groups, audio, spb)
    playing = [g for g in groups if in_window(g[0]["beat"])]
    if not playing:
        return sound, None
    if len({n["key"] for n in track["notes"]}) == 1:
        notes = [{"pitch": 0, "step": step_of(g[0]["beat"]), "length": 1, "velocity": g[0]["vel"]} for g in playing]
        return sound, {"kind": "drum", "sounds": [sound], "notes": notes}
    polyphonic = any(len(g) > 1 for g in groups)
    # A chord track has a sound for each chord it plays here, a note per chord at its lowest key
    sounds = [cut_chord(groups, audio, spb, key) for key in dict.fromkeys(chord_key(g) for g in playing)] if polyphonic else [sound]
    notes = [
        {
            "pitch": min(n["key"] for n in g),
            "step": step_of(g[0]["beat"]),
            "length": max(1, round(max(n["dur"] for n in g) * 4)),
            "velocity": min(g, key=lambda n: n["key"])["vel"],
        }
        for g in playing
    ]
    return sound, {"kind": "notes", "sounds": sounds, "notes": notes}


def loop_track(track, audio, spb):
    name = track["name"]
    playing = [c for c in track["clips"] if c["start"] < WINDOW[1] and c["end"] > WINDOW[0]]
    # Hits in the window, or (for the sound) wherever the loop first plays
    first = track["clips"][0]
    span = (WINDOW[0] * spb, (WINDOW[1] - WINDOW[0]) * spb) if playing else (first["start"] * spb, (first["end"] - first["start"]) * spb)
    hits = onsets(audio, *span, pitched=name in PITCHED_LOOPS)
    top = max(level for _, level, _ in hits)
    # the sound: of the hits nearly as loud as the loudest, the one with the longest gap after it
    gaps = [(hits[i + 1][0] if i + 1 < len(hits) else hits[i][0] + 1) - hits[i][0] for i in range(len(hits))]
    pick = max((i for i, (_, level, _) in enumerate(hits) if level >= top - 6), key=lambda i: gaps[i])
    t, level, pitch = hits[pick]
    sound = {
        "audio": trim(audio, span[0] + t, gaps[pick]),
        "root": pitch or 60,
        "velocity": round(127 * 10 ** ((level - top) / 20)),
        "held": gaps[pick] / spb * 4,
    }
    if not playing:
        return sound, None
    by_step = {}
    for t, level, pitch in hits:
        if level - top < QUIETEST_HIT_DB:
            continue
        step = int(round(t / spb * 4)) % STEPS
        velocity = max(1, min(127, round(127 * 10 ** ((level - top) / 20))))
        if step not in by_step or by_step[step]["velocity"] < velocity:
            by_step[step] = {"pitch": pitch or 0, "step": step, "length": 1, "velocity": velocity}
    notes = sorted(by_step.values(), key=lambda n: n["step"])
    if name in PITCHED_LOOPS:
        # each chop is held until the next one
        for i, n in enumerate(notes):
            n["length"] = ((notes[(i + 1) % len(notes)]["step"] - n["step"]) % STEPS) or STEPS
    return sound, {"kind": "notes" if name in PITCHED_LOOPS else "drum", "sounds": [sound], "notes": notes}


def one_shot_track(track, audio, spb):
    playing = [c for c in track["clips"] if c["start"] < WINDOW[1] and c["end"] > WINDOW[0]]
    # the first clip starting in the window (or the song) is the sound, with its
    # effects' tail up to the next clip
    first = next((c for c in playing if c["start"] >= WINDOW[0]), (playing or track["clips"])[0])
    following = [c["start"] for c in track["clips"] if c["start"] > first["start"]]
    sound = {
        "audio": trim(audio, first["start"] * spb, ((following[0] if following else first["end"] + 16) - first["start"]) * spb),
        "root": 60,
        "velocity": 127,
        "held": (first["end"] - first["start"]) * 4,
    }
    if not playing:
        return sound, None
    notes = [{"pitch": 0, "step": step_of(c["start"]), "length": 1, "velocity": 127} for c in playing]
    return sound, {"kind": "drum", "sounds": [sound], "notes": sorted(notes, key=lambda n: n["step"])}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("folder", type=Path)
    folder = parser.parse_args().folder
    tempo, tracks = read_set(folder)
    spb = 60 / tempo
    out_dir = ENGINE / "softer"
    out_dir.mkdir(exist_ok=True)
    for old in out_dir.glob("*.wav"):
        old.unlink()

    def write(name, sound, suffix=""):
        file = f"{slug(name)}{suffix}.wav"
        sf.write(out_dir / file, sound["audio"].astype(np.float32), SAMPLE_RATE, subtype="PCM_16")
        return {"file": file, "root": sound["root"], "velocity": sound["velocity"], "held": round(sound["held"], 2)}

    parts, preset = [], []
    for index, track in enumerate(tracks):
        name = track["name"]
        audio, rate = sf.read(find_export(folder, name), always_2d=True)
        assert rate == SAMPLE_RATE, f"{name}: {rate} Hz"
        make = midi_track if track["midi"] else loop_track if name in LOOPS else one_shot_track
        sound, part = make(track, audio, spb)
        if index < LANES:
            preset.append(write(name, sound)["file"])
        if part:
            sounds = [
                write(name, s, "" if s is sound or len(part["sounds"]) == 1 else f"-{s['root']}") for s in part["sounds"]
            ]
            parts.append({"name": name, "kind": part["kind"], "sounds": sounds, "notes": part["notes"]})
        print(f"{name:18s} {len(sound['audio']) / SAMPLE_RATE:5.2f}s  {len(part['sounds']) if part else '-'} sounds  {len(part['notes']) if part else '-':>3} notes")

    ts = (
        "// Generated by scripts/make_softer_jam.py from the Softer Ableton project; do not edit.\n"
        "import type { JamTrack } from './jamTracks';\n\n"
        f"// The song's last 8 bars at {tempo:g} BPM: every track that plays there, with its sounds in softer/\n"
        "export const SOFTER_TRACK: JamTrack = {\n"
        "  file: 'softer.wav',\n"
        f"  bpm: {tempo:g},\n"
        "  chords: [],\n"
        "  layers: [],\n"
        "  drums: [],\n"
        "  sampled: [\n"
        + "".join(
            f"    {{\n      name: {json.dumps(p['name'])},\n      kind: '{p['kind']}',\n"
            f"      sounds: {json.dumps(p['sounds'])},\n      notes: {json.dumps(p['notes'])},\n    }},\n"
            for p in parts
        )
        + "  ],\n"
        "};\n\n"
        "// One sound per track, in the song's track order, as many as the highway has rows\n"
        f"export const SOFTER_SOUNDS: string[] = {json.dumps(preset)};\n"
    )
    (ENGINE / "jamSofter.ts").write_text(ts)


if __name__ == "__main__":
    main()
