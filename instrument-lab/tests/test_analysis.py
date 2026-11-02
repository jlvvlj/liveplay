"""Regression tests for agreement and final stem extraction, without model downloads."""

import sys
from copy import deepcopy
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy import signal

sys.path.insert(0, str(Path(__file__).parents[1] / "analysis"))
from analyze import (
    activations,
    fit_fixed,
    FFT,
    HOP,
    SR,
    PITCHES,
    extract_references,
    note_support,
    reconcile_masked_holds,
    select_candidates,
)
from pitch_support import supported_notes
from reextract import reextract


class BlockFactorizationTests(unittest.TestCase):
    def test_blocks_preserve_global_fit_and_boundary_frames(self):
        rng = np.random.default_rng(17)
        d = rng.random((20, 7), dtype=np.float32)
        d /= np.linalg.norm(d, axis=0)
        target = rng.random((20, 71), dtype=np.float32)
        warm = rng.random((7, 71), dtype=np.float32)
        prior = rng.random(7, dtype=np.float32)
        for initial in (None, warm):
            with patch("analyze.FRAME_BLOCK", 1000):
                whole = activations(d, target, 15, initial, prior)
            with patch("analyze.FRAME_BLOCK", 13):
                blocked = activations(d, target, 15, initial, prior)
            np.testing.assert_allclose(blocked, whole, rtol=3e-5, atol=1e-6)
        for size in (13, 1000):
            with patch("analyze.FRAME_BLOCK", size):
                fitted = fit_fixed(d, target, warm.copy(), 15, 0.018)
            if size == 13:
                expected = fitted
            else:
                np.testing.assert_allclose(fitted, expected, rtol=3e-5, atol=1e-6)


class DiscoveryCountTests(unittest.TestCase):
    def test_nine_distinct_supported_candidates_are_not_capped_at_eight(self):
        catalogue = [{"harmonics": row.tolist()} for row in np.eye(80)[:9]]
        selected, limited = select_candidates(catalogue, np.ones(9))
        self.assertEqual(len(selected), 9)
        self.assertFalse(limited)
        budgeted, limited = select_candidates(catalogue, np.ones(9), max_parts=8)
        self.assertEqual(len(budgeted), 8)
        self.assertTrue(limited)
        self.assertEqual(select_candidates(catalogue, np.zeros(9)), ([], False))


class NoteAgreementTests(unittest.TestCase):
    def test_requires_pitch_and_temporal_overlap(self):
        notes = [
            dict(pitch=60, start=0.2, end=0.5),
            dict(pitch=48, start=0.2, end=0.5),
            dict(pitch=60, start=1, end=1.3),
        ]
        result = supported_notes(
            notes, [dict(pitch=60, start=0.23, end=0.49, confidence=0.8)]
        )
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["start"], 0.2)
        self.assertEqual(result[0]["pitchSupport"], 0.8)

    def test_short_notes_use_proportional_overlap(self):
        result = supported_notes(
            [dict(pitch=72, start=0.1, end=0.14)],
            [dict(pitch=72, start=0.11, end=0.15, confidence=0.6)],
        )
        self.assertEqual(len(result), 1)

    def test_no_evidence_does_not_invent_notes(self):
        self.assertEqual(supported_notes([dict(pitch=60, start=0, end=1)], []), [])


class MaskedHoldTests(unittest.TestCase):
    def example(self):
        return [
            dict(
                notes=[
                    dict(pitch=60, start=0.5, end=1.1),
                    dict(pitch=60, start=1.4, end=1.9),
                    dict(pitch=64, start=0.52, end=1.88),
                ]
            ),
            dict(notes=[dict(pitch=48, start=1.08, end=1.38)]),
        ]

    def test_lower_octave_mask_and_continuing_chord_allow_join(self):
        parts = self.example()
        reconcile_masked_holds(parts)
        self.assertEqual(len(parts[0]["notes"]), 2)
        held = parts[0]["notes"][0]
        self.assertEqual(held["end"], 1.9)
        self.assertTrue(held["maskedContinuation"])

    def test_repeated_note_without_both_evidence_sources_is_preserved(self):
        for change in ["no_companion", "unrelated_pitch", "partial_gap", "same_pitch"]:
            parts = self.example()
            if change == "no_companion":
                parts[0]["notes"].pop()
            elif change == "unrelated_pitch":
                parts[1]["notes"][0]["pitch"] = 47
            elif change == "same_pitch":
                parts[1]["notes"][0]["pitch"] = 60
            else:
                parts[1]["notes"][0]["end"] = 1.12
            original = deepcopy(parts)
            for part in original:
                part["notes"].sort(key=lambda note: note["start"])
            reconcile_masked_holds(parts)
            self.assertEqual(parts, original, change)


class ReferenceStemTests(unittest.TestCase):
    def test_removed_note_has_no_stale_audio_and_remaining_level_is_calibrated(self):
        patch = dict(
            family="sine",
            brightness=0.5,
            body=0,
            odd=0.5,
            fm=1.5,
            ratio=2,
            attack=0.005,
            decay=0.2,
            sustain=0.5,
            release=0.05,
            detune=0,
            gain=1,
        )
        note = dict(pitch=60, start=0.2, end=0.6, velocity=100)
        parts = [dict(id="instrument-1", notes=[note], patch=patch)]
        audio = np.zeros(2 * SR)
        for start in [0.2, 1.2]:
            t = np.arange(round(0.5 * SR)) / SR
            env = np.where(
                t < 0.005,
                t / 0.005,
                0.5 + 0.5 * np.exp(np.minimum(0, -4 * (t - 0.005) / 0.2)),
            )
            gate = 0.5 + 0.5 * np.exp(-4 * (0.4 - 0.005) / 0.2)
            env = np.where(
                t <= 0.4, env, gate * np.exp(np.minimum(0, -6 * (t - 0.4) / 0.05))
            )
            voice = (
                0.3
                * 0.7
                * (100 / 127)
                * env
                * np.sin(2 * np.pi * 440 * 2 ** ((60 - 69) / 12) * t)
            )
            lo = round(start * SR)
            audio[lo : lo + len(voice)] += voice
        _, times, z = signal.stft(audio, fs=SR, nperseg=FFT, noverlap=FFT - HOP)
        weight = np.ones(z.shape[0], dtype=np.float32)
        support = note_support(parts, times)
        self.assertEqual(np.count_nonzero(support[:, times > 1]), 0)
        with tempfile.TemporaryDirectory() as folder:
            extract_references(
                parts,
                audio,
                times,
                z,
                abs(z),
                weight,
                Path(folder),
                np.ones((len(PITCHES), len(times)), dtype=np.float32),
            )
            stem, _ = sf.read(Path(folder) / parts[0]["referenceFile"])
        self.assertGreater(np.max(abs(stem[:SR])), 0.01)
        self.assertLess(np.max(abs(stem[SR:])), 1e-6)
        self.assertAlmostEqual(parts[0]["patch"]["gain"], 0.7, delta=0.1)


class ManualReferenceTests(unittest.TestCase):
    def test_split_rebuilds_distinct_stems_and_preserves_manual_sound(self):
        reference = dict(
            family="sine",
            brightness=0.5,
            body=0,
            odd=0.5,
            fm=1.5,
            ratio=2,
            attack=0.005,
            decay=0.2,
            sustain=0.5,
            release=0.05,
            detune=0,
            gain=0.7,
        )
        manual = {**reference, "family": "pulse", "gain": 0.12, "attack": 0.3}
        notes = [
            dict(pitch=24, start=0.2, end=0.6, velocity=90),
            dict(pitch=96, start=1.2, end=1.6, velocity=90),
        ]
        audio = np.zeros(2 * SR)
        for n in notes:
            t = np.arange(round((n["end"] - n["start"]) * SR)) / SR
            audio[
                round(n["start"] * SR) : round(n["start"] * SR) + len(t)
            ] += 0.15 * np.sin(2 * np.pi * 440 * 2 ** ((n["pitch"] - 69) / 12) * t)
        result = dict(
            parts=[
                dict(
                    id=f"instrument-{i+1}",
                    notes=[n],
                    patch=deepcopy(manual),
                    referencePatch=reference,
                )
                for i, n in enumerate(notes)
            ]
        )
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            sf.write(folder / "source.wav", audio, SR)
            updated = reextract(folder / "source.wav", result, folder)
            stems = [sf.read(folder / p["referenceFile"])[0] for p in updated["parts"]]
            self.assertGreater(np.max(abs(stems[0][:SR])), 0.05)
            self.assertLess(np.max(abs(stems[0][SR:])), 1e-5)
            self.assertGreater(np.max(abs(stems[1][SR:])), 0.05)
            self.assertLess(np.max(abs(stems[1][:SR])), 1e-5)
            for p in updated["parts"]:
                self.assertEqual(p["patch"], manual)
            # Deleting the remaining notes must also clear the reference audio.
            for p in updated["parts"]:
                p["notes"] = []
            emptied = reextract(folder / "source.wav", updated, folder)
            for p in emptied["parts"]:
                self.assertLess(
                    np.max(abs(sf.read(folder / p["referenceFile"])[0])), 1e-6
                )


if __name__ == "__main__":
    unittest.main()
