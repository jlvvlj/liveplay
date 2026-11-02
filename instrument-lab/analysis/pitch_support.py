"""Independent pitch evidence using Spotify Basic Pitch's packaged ONNX model.

The model proposes pitches, not instruments. Synth matching determines source
identity, and both estimates must agree before a practice note is retained.
Nothing in this module imports the legacy Melodics analysis pipeline.
"""

import contextlib
import sys


def propose(source):
    # Basic Pitch's console messages must not enter our JSON progress stream.
    with contextlib.redirect_stdout(sys.stderr):
        import onnxruntime as ort
        from basic_pitch import FilenameSuffix, build_icassp_2022_model_path
        from basic_pitch.inference import Model, predict

        class CpuModel(Model):
            def __init__(self):
                options = ort.SessionOptions()
                options.intra_op_num_threads = 2
                options.inter_op_num_threads = 1
                self.model_type = Model.MODEL_TYPES.ONNX
                self.model = ort.InferenceSession(
                    str(build_icassp_2022_model_path(FilenameSuffix.onnx)),
                    sess_options=options,
                    providers=["CPUExecutionProvider"],
                )

        _, _, events = predict(
            source,
            CpuModel(),
            onset_threshold=0.4,
            frame_threshold=0.25,
            minimum_note_length=70,
            # The packaged model covers the 88 piano keys, MIDI 21–108.
            # A numeric upper bound is exclusive after bin rounding.
            minimum_frequency=None,
            maximum_frequency=None,
        )
    return [
        dict(
            start=float(start),
            end=float(end),
            pitch=int(pitch),
            confidence=float(confidence),
        )
        for start, end, pitch, confidence, _ in events
    ]


def supported_notes(notes, proposals):
    by_pitch = {}
    for proposal in proposals:
        by_pitch.setdefault(proposal["pitch"], []).append(proposal)
    retained = []
    for note in notes:
        minimum_overlap = min(0.06, (note["end"] - note["start"]) * 0.5)
        support = [
            p
            for p in by_pitch.get(note["pitch"], [])
            if min(p["end"], note["end"]) - max(p["start"], note["start"])
            > minimum_overlap
        ]
        if support:
            retained.append(
                {
                    **note,
                    "pitchSupport": round(max(p["confidence"] for p in support), 3),
                }
            )
    return retained
