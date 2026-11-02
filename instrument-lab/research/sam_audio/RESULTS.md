# Hugging Face SAM Audio qualification results — 2026-10-05

**Decision: the tested configuration is not ready for automatic per-instrument separation.**

Both GPU jobs completed successfully; hosting and authentication work. The quality
failures below concern extraction of the requested source, not job execution.
No production separation or editor behavior was changed.

## Runs

- [Supplied spans, one candidate](https://huggingface.co/jobs/jlvvlj/6ac30d43fbc85ba6823a456f): 10 targets, 424.513 seconds running.
- [Text-only / predicted spans with four candidates](https://huggingface.co/jobs/jlvvlj/6ac30f79fbc85ba6823a4639): 20 extractions, 684.296 seconds running.

Official SAM Audio Large revision `5f2cd3a9471a08c7282c06036be6893e18de8b70`;
code commit `bb4c6999d2677c7402360e426afc01ddfad6dce0`.
Each input is a generated 12-second stereo electronic mixture; the model returns mono.
Each extraction reads the original mix and an explicit target description.
None of these runs validates automatic discovery or source count.

## Short-fixture extraction

Cells show magnitude spectral error and pass/fail of the complete per-source audio gate.
Lower error is better; thresholds are documented in README.md. Values are not perceptual similarity percentages.

| Requested source | Supplied spans | Text only | Predicted spans, 4 candidates |
|---|---|---|---|
| distinct-duet--bass | 0.066 · pass | 0.066 · pass | 0.065 · pass |
| distinct-duet--lead | 1.272 · fail | 1.273 · fail | 1.273 · fail |
| chords-and-drums--bass | 0.109 · pass | 0.108 · pass | 0.095 · pass |
| chords-and-drums--lead | 1.256 · fail | 1.254 · fail | 1.676 · fail |
| chords-and-drums--pad | 0.999 · fail | 0.983 · fail | 0.118 · pass |
| chords-and-drums--kick | 2.203 · fail | 2.205 · fail | 2.190 · fail |
| similar-overlapping-synths--pulse-a | 1.000 · fail | 0.054 · pass | 1.000 · fail |
| similar-overlapping-synths--pulse-b | 1.000 · fail | 1.327 · fail | 1.326 · fail |
| absent-target--kick | 1.000 · fail | 1.000 · fail | 1.000 · fail |
| absent-target--missing-lead | -30.37 dB vs mix · pass | -30.37 dB vs mix · pass | -30.28 dB vs mix · pass |

The absent-target row asks for a nonexistent lead; low output is desired only there.
Supplied spans recover bass but return effectively the same bass for the lead:
the duet bass/lead output correlation is 0.999970. Text-only has the same problem
(0.999980). Text-only also extracts effectively the same pulse synth for both
overlapping-synth prompts (correlation 0.999980), so these are not two distinct stems.
Predicted spans plus reranking recover the pad, but do not consistently recover leads,
percussion or both similar synths. No tested condition recovers the complete source set.

## Actual Instrument Lab reconstruction

These results use the existing Lab analyzer with `--max-parts 1` and its synth renderer
on actual extracted WAVs. They are distinct from raw Basic Pitch scores.

| Extracted source | Notes matched / expected | Detected | Note F1 | Rebuilt spectral error |
|---|---:|---:|---:|---:|
| supplied-spans: distinct-duet--bass | 20 / 20 | 20 | 1.000 | 0.137 |
| supplied-spans: distinct-duet--lead | 0 / 24 | 20 | 0.000 | 1.248 |
| supplied-spans: chords-and-drums--bass | 20 / 20 | 20 | 1.000 | 0.166 |
| supplied-spans: chords-and-drums--lead | 0 / 24 | 20 | 0.000 | 1.232 |
| supplied-spans: chords-and-drums--pad | analysis failed | — | — | — |
| supplied-spans: similar-overlapping-synths--pulse-a | 0 / 18 | 4 | 0.000 | 1.000 |
| supplied-spans: similar-overlapping-synths--pulse-b | 0 / 16 | 1 | 0.000 | 1.000 |
| text-only: similar-overlapping-synths--pulse-a | 18 / 18 | 18 | 1.000 | 0.130 |
| predicted-spans-four-candidates: chords-and-drums--pad | 9 / 9 | 15 | 0.750 | 0.322 |

Both recovered basses and the text-only pulse source reproduce every expected note.
The recovered pad retains 9 true notes but adds 6 extra notes and has mean matched
offset error of 210 ms. Wrong-source lead extraction produces bass notes instead.
Separation and downstream note refinement therefore need separate validation.

## Limits and next decision

- This rejects these tested configurations as a ready production path, not every possible use of SAM Audio.
- Synthetic fixtures and text prompts may be out of distribution. A bounded real-song comparison with manually identified targets is the next useful model check before any claim about real-song quality.
- Full-length identity continuity, stereo recovery, automatic source discovery, perceptual listening, and the requested browser workflow remain unvalidated.
- The original Audio editor separation, storage and waveform component files match their preflight hashes (7 protected files).
- Eight benchmark unit checks pass. No automatic fallback or substitute separation was added.

Raw scores and downstream metrics are in [measured-results.json](measured-results.json).
The second job runner used no supplied anchors; its `spanMode` and empty chunk anchors
are authoritative. Its old generic `supervision` string incorrectly said prompts-and-spans.
The reusable runner now records that label accurately; original run outputs remain unchanged.
Private bucket run prefixes: `20261005T023643Z-d7a0d444` and `20261005T024612Z-86f4012d`
in `jlvvlj/melodics-sam-benchmark`. Source bundles, dependency versions, WAV outputs,
and logs remain available there for reproduction. No credentials are included in this report.
