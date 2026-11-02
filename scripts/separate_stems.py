# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = [
#   "demucs @ git+https://github.com/adefossez/demucs.git@b9ab48cad45976ba42b2ff17b229c071f0df9390",
#   "torch==2.1.2",
#   "torchaudio==2.1.2",
#   "numpy<2",
#   "setuptools<70",
#   "soundfile",
# ]
# ///
"""Separate an audio file into 4 stems (drums/bass/vocals/other) with Demucs.

Emits NDJSON progress on stdout so the Electron main process can stream it:
  {"type": "stage", "value": "loading-model"}
  {"type": "progress", "value": 0.42}
  {"type": "done", "duration": 213.4, "stems": {"drums": "drums.wav", ...}}
  {"type": "error", "message": "..."}
"""

import argparse
import json
import sys
import time
import traceback
from pathlib import Path


def emit(obj: dict) -> None:
    print(json.dumps(obj), flush=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model", default="htdemucs_ft")
    parser.add_argument("--device", default="cpu", choices=["cpu", "mps", "cuda"])
    args = parser.parse_args()

    input_path = Path(args.input)
    output_dir = Path(args.output)
    if not input_path.is_file():
        emit({"type": "error", "message": f"Input file not found: {input_path}"})
        return 1
    output_dir.mkdir(parents=True, exist_ok=True)

    emit({"type": "stage", "value": "loading-model"})

    import soundfile as sf
    from demucs.api import Separator

    last_emit = 0.0

    def callback(data: dict) -> None:
        nonlocal last_emit
        if data.get("state") != "end":
            return
        models = max(data.get("models", 1), 1)
        audio_length = max(data.get("audio_length", 1), 1)
        offset = data.get("segment_offset", 0)
        model_idx = data.get("model_idx_in_bag", 0)
        progress = min((model_idx + min(offset / audio_length, 1.0)) / models, 1.0)
        now = time.monotonic()
        if now - last_emit >= 1.0 or progress >= 1.0:
            last_emit = now
            emit({"type": "progress", "value": round(progress, 4)})

    separator = Separator(model=args.model, device=args.device, callback=callback)

    emit({"type": "stage", "value": "separating"})
    origin, separated = separator.separate_audio_file(input_path)

    duration = origin.shape[-1] / separator.samplerate

    emit({"type": "stage", "value": "exporting"})
    stems: dict[str, str] = {}
    for stem_name, tensor in separated.items():
        filename = f"{stem_name}.wav"
        # (channels, samples) float tensor -> 16-bit PCM WAV
        data = tensor.clamp(-1, 1).cpu().numpy().T
        sf.write(str(output_dir / filename), data, separator.samplerate, subtype="PCM_16")
        stems[stem_name] = filename

    emit({"type": "done", "duration": round(duration, 2), "stems": stems})
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # surface everything as a structured error, no fallbacks
        traceback.print_exc(file=sys.stderr)
        emit({"type": "error", "message": str(exc)})
        sys.exit(1)
