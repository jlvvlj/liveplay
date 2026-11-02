# SAM Audio evaluation for Instrument Lab

Status: **not qualified; two Hugging Face GPU jobs completed on 2026-10-05**.
See [RESULTS.md](RESULTS.md) for measured separation and reconstruction results. This folder is a
benchmark and implementation design, not an enabled separation feature. The
Audio editor's Demucs process and its existing stems remain unchanged.

## Evidence and unresolved requirements

Inspected upstream commit: `bb4c6999d2677c7402360e426afc01ddfad6dce0`.

- [`processor.py`](https://github.com/facebookresearch/sam-audio/blob/bb4c6999d2677c7402360e426afc01ddfad6dce0/sam_audio/processor.py)
  averages channels and uses 48 kHz audio. Model target/residual outputs are mono.
  Feeding a stereo file does not establish stereo preservation.
- [`model/model.py`](https://github.com/facebookresearch/sam-audio/blob/bb4c6999d2677c7402360e426afc01ddfad6dce0/sam_audio/model/model.py)
  accepts target descriptions and positive/negative time anchors. It does not
  enumerate instrument identities or determine their count. A prompt such as
  “synthesizer” must not be mistaken for one physical instrument.
- The inspected public `separate()` method has no long-form chunking argument.
  This harness uses overlapping waveform chunks as an explicit baseline. That
  is not Meta's reported multidiffusion method, and may fail identity continuity.
- Access approved. The official Large checkpoint was tested on Hugging Face
  Jobs, using private bucket storage and the existing authenticated account.
  Model execution remains remote; model weights were not downloaded to the
  development machine.
- We cannot conclude the model meets the application's requirements from its
  published music benchmark, an install, or successful API calls.

## Validation sequence

1. **Prompted separation capability.** Run explicit descriptions/time anchors
   against generated independent electronic recordings with known stems.
   Fixtures cover different timbres, polyphonic pads plus percussion, two synths
   in the same register, a nonexistent target, and a 210-second arrangement with
   disappearing/reappearing instruments. This stage intentionally supplies the
   target identity; it cannot validate automatic discovery.
2. **Automatic discovery.** Run without source count, oracle descriptions, truth
   notes, or clean query audio. Propose recurring source identities from the
   imported mix; extract each candidate from that original mix. Check missed
   sources, duplicate extractions, overlapping sources and identity across song
   sections. The existing Lab's full-mix discovery can be an experimental source
   of proposals/anchors, but its reference WAVs must not become SAM inputs or be
   presented as SAM results. No fixed category list and no “other” instrument.
   If a compute budget is reached, report incomplete separation explicitly.
3. **End-to-end usefulness.** Analyze each accepted stem independently for notes
   and one patch, render the rebuilt stem, compare source timing/pitch/timbre,
   and compare summed stems against the original. Evaluate real songs as well as
   generated fixtures. Preserve the original stem when users edit notes/patches.
4. **Stereo and listening.** Mono model output does not satisfy original stereo
   reconstruction. Evaluate a stereo extraction strategy separately; copying mono
   to two channels is insufficient. Listen to targets and remaining audio for
   bleed, missing parts, changed attacks and artifacts. Do not force unexplained
   residual energy into a named instrument to make a sum metric pass.

Proposed numerical gates: per-source magnitude spectral error <=0.35, level
error within 3 dB, active five-second-window spectral error <=0.5, absent-target
output at least 30 dB below the mixture, and pitched-note F1 >=0.90 at exact MIDI
pitch/50 ms onset tolerance. These are engineering acceptance targets, not a
percentage of perceived sound similarity. SI-SDR is diagnostic because a
generative separator may change phase. Listening and real-song checks remain
necessary even if numerical gates pass.

## Running

Use a separate Python 3.11+ environment on the selected inference machine. Request
checkpoint access through Meta's Hugging Face page and authenticate there using
the normal Hugging Face mechanism. Never put tokens in manifests or logs.

```sh
python -m venv .venv-sam
.venv-sam/bin/pip install 'git+https://github.com/facebookresearch/sam-audio.git@bb4c6999d2677c7402360e426afc01ddfad6dce0' scipy soundfile
.venv-sam/bin/python instrument-lab/research/sam_audio/preflight.py --output /tmp/sam-preflight.json
.venv-sam/bin/python instrument-lab/research/sam_audio/fixtures.py /tmp/melodics-sam-fixtures
.venv-sam/bin/python instrument-lab/research/sam_audio/run.py /tmp/melodics-sam-fixtures/inference.json /tmp/melodics-sam-run --device cuda
instrument-lab/.venv/bin/python instrument-lab/research/sam_audio/score.py /tmp/melodics-sam-fixtures/truth.json /tmp/melodics-sam-run --notes
```

The official dependency tree includes dependencies on moving Git branches. Save
`pip freeze` with the run before comparing different machines. The runner records
the exact resolved Hugging Face model revision and uses its local snapshot, since
the inspected upstream loader ignores the passed revision argument. Verify the
installed SAM code commit matches the pinned one before running. Large/Small are
separate benchmark configurations; success with Small does not validate Large.

`run.py` loads one model for all targets, saves full-length float WAVs, records
runtime and chunk boundaries, and refuses to overwrite a previous run directory.
It never loads scoring truth. `score.py` cannot report production readiness:
automatic discovery, stereo, reconstruction and UI gates are separate evidence.
An incomplete run always fails coverage. Use a short-only fixture run for an
initial smoke test, then the complete fixture set for qualification.

Unit checks (no SAM dependency or weights needed):

```sh
instrument-lab/.venv/bin/python -m unittest discover -s instrument-lab/research/sam_audio -p 'test_*.py' -v
```

## Hugging Face execution

Two one-shot A100 Jobs completed. The first used supplied time anchors and one
candidate. The second compared text-only extraction against predicted anchors
with four reranking candidates. All three conditions used the same ten short
fixture targets and pinned official Large checkpoint at revision
`5f2cd3a9471a08c7282c06036be6893e18de8b70`.

The jobs used private Hugging Face bucket mounts for source scripts and results.
Only generated benchmark recordings were used; no user songs were uploaded.
The account token was passed through the encrypted job-secret parameter, never
written into source, logs or manifests. Both jobs completed and stopped.

The first job ran for 424.513 seconds; the second for 684.296 seconds. This is
18.48 minutes of measured running time combined, within the 30-minute initial
allowance. It is not a billing statement. Dependency installation and model
loading are included. Inference speed alone must not be presented as end-to-end
song processing time.

Results do not qualify the current configuration for automatic instrument
separation. Long-song identity, real recordings, listening, automatic source
discovery and stereo reconstruction remain unvalidated. Source identity failures
already occur on the short prompted fixtures; production integration is pending.

The clean-stem downstream baseline (without SAM) matched all note events in four
monophonic fixtures. The polyphonic pad detected 15 notes against 9 true notes
(F1 0.75). The actual SAM-stem reconstruction results are reported separately in
RESULTS.md so raw transcription is not confused with the Lab's refined notes.

## Integration design, conditional on validation

All new separation belongs to Instrument Lab. Do not edit `scripts/separate_stems.py`,
`server/separation-manager.ts`, Audio editor stem storage, or its separation UI.

- Add a new versioned analysis run to a Lab recording. Keep existing analyses and
  manual edits selectable until a replacement is explicitly adopted. Opening an
  old recording must not silently discard its notes, patches or merged tracks.
- Store stable source IDs, descriptions/anchors, exact model/code versions,
  extracted audio references, duration, analysis confidence and status in a
  separation manifest. Use the existing attempt IDs, cancellation checks and
  atomic document publish pattern. Never publish half-complete source sets.
- Treat separation, per-stem transcription/patch fitting, and rendering as three
  distinct stages. Each accepted stem owns one Lab part/patch; the transcription
  stage cannot silently split it into several instrument parts.
- Keep separated reference audio immutable on note/patch edits. The current
  melodic edit path re-extracts references from the mix when notes change; that
  behavior must be bypassed for SAM stems. A user merge sums source stems and
  preserves provenance; split/move behavior must be explicitly implemented and
  tested rather than duplicating full stem audio into multiple parts.
- The full mix uses all accepted instruments with existing solo/mute/loop and
  practice controls. Original mix comparison always uses the imported recording.
- Keep the requested waveform-above-note-lane comparison on the same timeline.
  Reuse or copy the Sound editor waveform behavior without changing the Audio
  editor's separation. Waveforms must read the exact SAM stem associated with
  the part. Existing Lab stem comparison, sound shaping and note review remain.
- Model loading/inference runs in a backend worker. No Electron work. A failed or
  unavailable SAM backend must report that state, not silently run the old model
  and label the resulting stems as SAM output.

Implementation is intentionally gated on real inference evidence. This design
is not a claim that automatic per-instrument separation has been solved.
