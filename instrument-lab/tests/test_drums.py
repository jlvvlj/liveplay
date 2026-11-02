import sys, tempfile, unittest
from pathlib import Path
import numpy as np
import soundfile as sf
from scipy.optimize import linear_sum_assignment

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "analysis"))
from drums import analyze
from drum_fixture import drum_fixture


class DrumAnalysisTests(unittest.TestCase):
    def test_independent_overlapping_kit_and_ghost_rolls(self):
        audio, sr, truth, sounds = drum_fixture()
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "source.wav"
            sf.write(source, audio, sr, subtype="FLOAT")
            result = analyze(source, Path(folder) / "out")
        self.assertEqual(len(result["parts"]), 6)
        counts = np.zeros((6, len(result["parts"])))
        errors = {}
        for i, t in enumerate(truth):
            for j, p in enumerate(result["parts"]):
                dist = abs(
                    np.array([v[0] for v in t])[:, None]
                    - np.array([n["start"] for n in p["notes"]])[None, :]
                )
                a, b = linear_sum_assignment(dist)
                counts[i, j] = sum(dist[a, b] < 0.02)
                errors[i, j] = dist[a, b][dist[a, b] < 0.02]
        a, b = linear_sum_assignment(-counts)
        correct = counts[a, b].sum()
        self.assertGreater(
            correct / sum(len(p["notes"]) for p in result["parts"]), 0.93
        )
        self.assertGreater(correct / sum(len(t) for t in truth), 0.97)
        self.assertLess(
            np.median(np.concatenate([errors[i, j] for i, j in zip(a, b)])), 0.008
        )
        self.assertTrue(all(p["patch"]["engine"] == "drum" for p in result["parts"]))
        self.assertLess(result["parts"][0]["discovery"]["waveformResidual"], 0.2)
        # Ghost strokes remain quieter than the normal backbeat; no velocity floor.
        snare = result["parts"][b[list(a).index(2)]]
        self.assertTrue(any(n["velocity"] < 35 for n in snare["notes"]))
        self.assertEqual(result["sampleRate"], 44100)

    def test_silent_input_has_actionable_error(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "silent.wav"
            sf.write(source, np.zeros((44100, 2)), 44100)
            with self.assertRaisesRegex(ValueError, "silent"):
                analyze(source, folder)
