# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = [
#   "demucs @ git+https://github.com/adefossez/demucs.git@b9ab48cad45976ba42b2ff17b229c071f0df9390",
#   "torch==2.1.2",
#   "torchaudio==2.1.2",
#   "numpy<2",
#   "setuptools<70",
#   "soundfile",
#   "gdown",
# ]
# ///
"""Extract a playable one-shot drum kit from a song's separated drum stem.

Pipeline:
1. drumsep (a Hybrid Demucs fine-tune, checkpoint 49469ca8) splits drums.wav
   into kick / snare / toms / cymbals piece stems, removing bleed.
2. For each drum class transcribed by ADTOF (events JSON), the strongest
   isolated hit is located and a short one-shot is sliced from the matching
   piece stem (hihat and cymbals both slice from the cymbals stem).
3. One-shots are faded, peak-normalized and written to the output directory.

Prints JSON: {"kit": {"kick": "kick.wav", "snare": "snare.wav", ...}}
"""

import argparse
import contextlib
import json
import os
import sys
from pathlib import Path

import numpy as np

MODEL_NAME = "49469ca8"
GDRIVE_ID = "1-Dm666ScPkg8Gt2-lK3Ua0xOudWHZBGC"
MODEL_CACHE = Path.home() / ".cache" / "melodics" / "drumsep"

# our drum class -> (drumsep source substring, slice seconds)
CLASS_CONFIG = {
    "kick": ("bombo", 0.90),
    "snare": ("redoblante", 0.60),
    "hihat": ("platillo", 0.30),
    "toms": ("tom", 0.80),
    "cymbals": ("platillo", 1.80),
}
PRE_ROLL = 0.012  # start slightly before the detected onset
TARGET_RMS = 0.18  # ~ -15 dBFS: loudness-match one-shots so sub-heavy kicks aren't quiet
PEAK_CEILING = 0.95


def ensure_model() -> Path:
    model_file = MODEL_CACHE / f"{MODEL_NAME}.th"
    if not model_file.is_file():
        MODEL_CACHE.mkdir(parents=True, exist_ok=True)
        import gdown

        with contextlib.redirect_stdout(sys.stderr):
            gdown.download(id=GDRIVE_ID, output=str(model_file), quiet=False)
        if not model_file.is_file():
            raise RuntimeError("drumsep model download failed")
    return MODEL_CACHE


def pick_onset(events: list[dict], drum: str, audio: np.ndarray, sr: int) -> float | None:
    """The most energetic hit of `drum`, measured in the separated piece stem.

    drumsep already removed the other instruments, so isolation doesn't matter;
    what matters is picking a representative, full-power hit (e.g. the drop
    kick, not the filtered intro kick).
    """
    candidates = [e for e in events if e["drum"] == drum]
    if not candidates:
        return None

    mono = np.abs(audio).mean(axis=0)

    def energy(event: dict) -> float:
        start = int(event["time"] * sr)
        window = mono[start : start + int(0.12 * sr)]
        return float(np.sqrt(np.mean(window**2))) if len(window) else 0.0

    return float(max(candidates, key=energy)["time"])


def refine_start(mono_env: np.ndarray, sr: int, start: int) -> int:
    """Snap the slice start onto the transient so the attack click is kept."""
    lo = max(start - int(0.03 * sr), 0)
    hi = min(start + int(0.03 * sr), len(mono_env))
    region = mono_env[lo:hi]
    if len(region) == 0:
        return start
    threshold = region.max() * 0.2
    above = np.nonzero(region >= threshold)[0]
    if len(above) == 0:
        return start
    return lo + int(above[0])


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--drums", required=True, help="separated drum stem wav")
    parser.add_argument("--events", required=True, help="ADTOF events JSON file")
    parser.add_argument("--output", required=True, help="kit output directory")
    parser.add_argument("--device", default=os.environ.get("MELODICS_DEMUCS_DEVICE", "mps"))
    args = parser.parse_args()

    import soundfile as sf
    from demucs.api import Separator

    events = json.loads(Path(args.events).read_text())["events"]
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    repo = ensure_model()
    with contextlib.redirect_stdout(sys.stderr):
        separator = Separator(model=MODEL_NAME, repo=repo, device=args.device)
        _, separated = separator.separate_audio_file(Path(args.drums))
    sr = separator.samplerate

    # normalize source names (the model uses Spanish stem names)
    stems = {name.lower(): tensor for name, tensor in separated.items()}

    def stem_for(substring: str):
        for name, tensor in stems.items():
            if substring in name:
                return tensor
        return None

    kit: dict[str, str] = {}
    for drum, (source_key, length) in CLASS_CONFIG.items():
        tensor = stem_for(source_key)
        if tensor is None:
            continue
        audio = tensor.cpu().numpy()  # (channels, samples)
        onset = pick_onset(events, drum, audio, sr)
        if onset is None:
            continue
        mono_env = np.abs(audio).mean(axis=0)
        start = refine_start(mono_env, sr, int(onset * sr))
        start = max(start - int(PRE_ROLL * sr), 0)
        end = min(start + int(length * sr), audio.shape[-1])
        clip = audio[:, start:end].copy()
        if clip.shape[-1] < int(0.05 * sr):
            continue
        # fade the tail (last 25%) to avoid clicks
        fade_len = int(clip.shape[-1] * 0.25)
        clip[:, -fade_len:] *= np.linspace(1.0, 0.0, fade_len)[None, :]
        peak = np.abs(clip).max()
        if peak < 1e-4:
            continue  # separation produced silence for this piece
        # loudness-match one-shots (RMS target) with a peak-safety ceiling
        rms = float(np.sqrt(np.mean(clip**2)))
        gain = min(TARGET_RMS / max(rms, 1e-9), PEAK_CEILING / peak)
        clip = clip * gain
        filename = f"{drum}.wav"
        sf.write(str(output_dir / filename), clip.T, sr, subtype="PCM_16")
        kit[drum] = filename

    if not kit:
        print(json.dumps({"error": "No drum one-shots could be extracted"}))
        return 1
    print(json.dumps({"kit": kit}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        sys.exit(1)
