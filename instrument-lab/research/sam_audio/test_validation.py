import json
from pathlib import Path
import tempfile
import unittest

import numpy as np

from fixtures import prepare, RATE
from run import local_anchors, validate_manifest, windows
from score import measure, note_metrics, score


class ValidationTests(unittest.TestCase):
    def test_full_song_windows_cover_tail_with_and_without_overlap(self):
        for length, size, overlap in [(21000, 2000, 400), (21000, 2000, 0), (700, 2000, 400), (2001, 2000, 400)]:
            coverage = np.zeros(length, dtype=int)
            spans = list(windows(length, size, overlap))
            for a, b in spans:
                coverage[a:b] += 1
            self.assertTrue(np.all(coverage > 0))
            self.assertEqual(spans[-1][1], length)
        with self.assertRaises(ValueError):
            list(windows(100, 20, 20))

    def test_anchors_are_clipped_and_translated_not_repeated_in_later_chunks(self):
        anchors = [["+", 3, 6], ["-", 0, 1], ["+", 8, 12]]
        self.assertEqual(local_anchors(anchors, 4, 10), [("+", 0, 2), ("+", 4, 6)])
        self.assertEqual(local_anchors(anchors, 20, 30), [])

    def test_scoring_rejects_mixture_copy_silence_and_truncation(self):
        t = np.arange(RATE * 2) / RATE
        target = (np.sin(t * 2 * np.pi * 220) * 0.1)[:, None]
        unrelated = (np.sin(t * 2 * np.pi * 800) * 0.2)[:, None]
        mix = target + unrelated
        self.assertTrue(measure(target, target, mix)["audioGate"])
        self.assertFalse(measure(mix, target, mix)["audioGate"])
        self.assertFalse(measure(unrelated, target, mix)["audioGate"])
        self.assertFalse(measure(np.zeros_like(target), target, mix)["audioGate"])
        with self.assertRaises(ValueError):
            measure(target[:-100], target, mix)

    def test_absent_target_cannot_pass_with_existing_music(self):
        t = np.arange(RATE * 2) / RATE
        mix = (np.sin(t * 2 * np.pi * 220) * 0.1)[:, None]
        silence = np.zeros_like(mix)
        self.assertTrue(measure(silence, silence, mix, False)["audioGate"])
        self.assertFalse(measure(mix, silence, mix, False)["audioGate"])

    def test_silent_tail_is_preserved_and_not_mistaken_for_leakage(self):
        t = np.arange(RATE * 12) / RATE
        target = (np.sin(t * 2 * np.pi * 220) * 0.1)[:, None]
        target[5 * RATE:] = 0
        self.assertTrue(measure(target, target, target)["audioGate"])
        leaked = target.copy()
        leaked[5 * RATE:] = 0.01
        self.assertFalse(measure(leaked, target, target)["audioGate"])

    def test_note_assignment_penalizes_duplicates_wrong_pitch_and_late_onsets(self):
        truth = [dict(pitch=60, start=0.5), dict(pitch=64, start=1)]
        self.assertEqual(note_metrics(truth, truth)["f1"], 1)
        self.assertLess(note_metrics(truth + [truth[0]], truth)["f1"], 1)
        self.assertEqual(note_metrics([dict(pitch=61, start=.5), dict(pitch=64, start=1.06)], truth)["f1"], 0)

    def test_fixtures_are_portable_and_truth_is_not_an_inference_input(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            prepare(folder, include_long=False)
            data = json.loads((folder / "inference.json").read_text())
            for job in data["jobs"]:
                self.assertNotIn("target", job)
                self.assertNotIn("notes", job)
                self.assertNotIn("patch", job)
                self.assertFalse(Path(job["input"]).is_absolute())
            self.assertEqual(len(validate_manifest(data, folder)), 10)
            data["jobs"][0]["id"] = "../escape"
            with self.assertRaises(ValueError):
                validate_manifest(data, folder)

    def test_missing_results_never_pass_and_do_not_imply_production_readiness(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            (folder / "truth.json").write_text(json.dumps({"sources": [{"id": "missing"}]}))
            (folder / "run.json").write_text(json.dumps({"status": "failed", "jobs": []}))
            result = score(folder / "truth.json", folder)
            self.assertEqual(result["missing"], ["missing"])
            self.assertFalse(result["promptedAudioGate"])
            self.assertFalse(result["productionReady"])
            self.assertIsNone(result["noteGate"])


if __name__ == "__main__":
    unittest.main()
