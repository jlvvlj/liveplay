# Instrument Lab

Independent browser feature for electronic recordings → instrument stems, editable synth patches, and playable practice notes. It imports no legacy stem separation, charting, database, or lesson player code.

## Run

From the Melodics repository:

```sh
npm run setup:instruments
npm run dev
```

Open http://localhost:5173, choose **Songs**, then **Instrument Lab editor** on a track. **Edit sounds** and the existing practice routes remain separate and unchanged. The top-level **Instrument Lab** tab retains access to all prior Lab recordings, imports, editing and practice tools. `npm run dev` starts the browser, songs API and analysis service together.

The standalone preview remains available with `npm run dev:instruments` at http://127.0.0.1:5186. Requires Node, uv, Python 3.11, and FFmpeg. Setup is safe to rerun. The existing repository supplies React, Express, and Vite. The dedicated Python environment includes the packaged Basic Pitch model and a CPU ONNX runtime. No model service or account is needed.

The backend binds to loopback. Uploads and analyses stay in `instrument-lab/data/`, ignored by Git. `INSTRUMENT_LAB_DATA`, `INSTRUMENT_LAB_PYTHON`, `INSTRUMENT_LAB_PORT`, and `FFMPEG_PATH` override locations. A hosted multi-user deployment requires its own authentication, storage isolation, and quotas.

## Integration

The main Melodics React tree renders `client/InstrumentLabEditor.jsx` directly as a full-screen editor view, with a back/title bar and a recording selector. There is no iframe, nested app navigation, or separately built bundle needed for the integrated view. Styles are scoped beneath `.instrument-lab-ui`; playback and MIDI listeners stop when the editor unmounts. `server/instrument-lab.ts` proxies `/api/instruments/` to the independent analysis service. The standalone build remains available under `/instrument-lab/`. No Electron integration is used. `INSTRUMENT_LAB_ORIGIN` overrides the service URL (default `http://127.0.0.1:5186`).

Opening a song reads its stored original recording; it does not change the song row, legacy stems, edits, or lessons. Lab projects record linked song IDs. Reopening returns that project, and matching original-file hashes reuse standalone work without losing saved patches or note edits. Lab imports remain available in the Lab workspace. Existing song imports support their original 300 MB upload allowance through the bridge; standalone Lab uploads keep their 60 MB limit.

The integrated editor updates through the main browser app’s Vite server and is included in `npm run build:renderer`. `npm run build:instruments` builds the optional standalone preview. `npm run test:integration` checks the bridge; `npm run test:instruments` checks the Lab, including linked project reuse and preserved edits.

## Architecture

- `engine/`: shared custom harmonic/FM synth, used by Node for offline rendering and AudioWorklet for live playing. Background workers prepare wavetables and practice accompaniment. Rapid slider changes replace obsolete pending preparation work. Live voices keep the spectral bandwidth used during analysis, even at higher device sample rates. Practice tempo changes note spacing and duration without transposing the oscillators.
- `analysis/analyze.py`: sparse spectral discovery, continuous patch fitting, consolidation of duplicate candidates, note decoding, envelope/level fitting, and reference extraction. Each retained instrument owns one patch, one note sequence, and one extracted stem.
- `analysis/pitch_support.py`: independent pitch evidence from [Spotify Basic Pitch 0.4.0](https://github.com/spotify/basic-pitch), an Apache-2.0 dependency. Its bundled ONNX model runs on the backend CPU. It proposes pitches; it does not assign instruments or supply the playable sound.
- `server/`: independent import/job API, cancellation, restart recovery, atomic persistence, instrument assignment transactions, and rendered comparison audio.
- `client/`: browser review, editable synth controls, piano roll, Web MIDI/computer/onscreen keyboard, and practice transport.

Final stem masks are re-estimated from the accepted instrument notes, including release tails. Unexplained audio is measured, never exposed as an `other` category. Automatic analysis and manual edits have separate stored documents. Each analysis attempt has its own identity and working directory; late cancelled work cannot publish. Each saved revision has immutable audio filenames and a document pointer committed atomically in the project metadata. Existing projects remain readable. Old revisions and interrupted run files are retained locally; automatic storage cleanup is not implemented. The Review notes tab supports single or Shift-click selection, selecting notes in the loop, splitting selected notes into a new instrument, moving them to an existing instrument, and merging whole instrument rows. Splits inherit an independently editable copy of the source patch; moves and merges keep the destination patch. Assignment changes and note edits rebuild all affected reference masks from the imported mixture via `analysis/reextract.py`, without changing manual synth parameters. The original spectral identity is kept separately from the playable patch. Invalid or failed extraction does not publish a partial revision.

## Validation

`npm run test:instruments` runs 20 Node tests and 9 Python analysis tests, including cancelled asynchronous playback, loop-start held notes, pitch-preserving tempo changes, superseded patch preparation, masked chord continuations, and removal of stale audio after automatic note rejection. The isolated API regression covers late cancelled workers, immediate retry, cancellation during rendering, invalid notes, concurrent saves, and preservation of previous audio revisions, assignment transactions, and failed reference extraction. A WAV extraction regression checks distinct split stems, clearing deleted notes, manual low/high pitches, and unchanged user sound controls. Input tests cover MIDI hot-plug/reconnection, device filtering, pending-note cancellation, and tempo-correct practice scoring. A browser take verified an on-time hit and unpenalized count-in warm-up. `npm run build:instruments` builds the production browser client.

Blind generated-audio checks use only mixture WAVs as analyzer input. Truth labels and isolated sources are evaluation-only artifacts.

| Recording                             | Sources found | Correct / expected notes | Extra notes |
| ------------------------------------- | ------------- | ------------------------ | ----------- |
| Shared-engine solo                    | 1 / 1         | 24 / 24                  | 0           |
| Shared-engine duet                    | 2 / 2         | 40 / 40                  | 0           |
| Shared-engine trio with chords        | 3 / 3         | 48 / 52                  | 4           |
| Independent filtered-oscillator solo  | 1 / 1         | 24 / 24                  | 0           |
| Independent filtered-oscillator duet  | 2 / 2         | 40 / 40                  | 0           |
| Independent filtered-oscillator trio  | 3 / 3         | 52 / 52                  | 2           |
| Independent four-instrument mixture   | 4 / 4         | 64 / 64                  | 2           |
| Independent pair in the same register | 2 / 2         | 35 / 40                  | 2           |
| Low bass, MIDI 21–28                  | 1 / 1         | 16 / 16                  | 0           |
| High lead, MIDI 96–108                | 1 / 1         | 24 / 24                  | 0           |
| Low bass + high lead                  | 2 / 2         | 40 / 40                  | 0           |

The independent generator uses SciPy pulse/FM/saw/triangle oscillators, Butterworth filters, and a different envelope. It is still generated audio, not proof of commercial-recording performance. Narrower harmonic measurements improve slow attacks, and a chord tone interrupted by a lower harmonic masker can be joined when a companion chord tone continues. Independent trio/four chord note-off errors now average 22/28 ms; the shared-engine trio still has roughly 220 ms error and unresolved note assignments. The full four-instrument analysis took 18.13 seconds for nine seconds of audio with two benchmark processes running; this is one measurement, not a runtime guarantee.

The independent four-instrument reference stems improved SI-SDR by 12.90 dB (lead), 13.21 dB (bass), 23.72 dB (pluck), and 19.24 dB (chords) over the mixture. Synth RMS levels were within about 2 dB of the isolated sources. Chord synth spectral error improved from .4204 to .3334. Raw bass error .4718 includes gated DC energy in the independent pulse fixture. Applying the same 20 Hz high-pass to both signals gives .1345; both metrics are retained in the evaluator. This is a diagnostic distinction, not a claim that the analyzer changed the fixture or that the metric measures perceived similarity. Spectral errors and SI-SDR are diagnostics, not perceived similarity percentages.

To reproduce independent fixtures:

```sh
instrument-lab/.venv/bin/python instrument-lab/tests/independent_fixtures.py /tmp/instrument-fixtures
```

Run analysis with its normal catalogue. Use `tests/evaluate.py RESULT_JSON TRUTH_JSON` for note metrics. Render fitted patches with `node instrument-lab/tests/render_result.mjs RESULT_JSON OUTPUT_FOLDER`, then use `tests/evaluate_audio.py RESULT_JSON TRUTH_JSON OUTPUT_FOLDER` for audio metrics. Run the Python tools with the feature's `.venv/bin/python`. `tests/benchmark.py FIXTURE_FOLDER CATALOG_JSON OUTPUT_FOLDER` analyzes all supplied fixture WAVs in isolated subprocesses, then writes `metrics.json`, including note-on and note-off errors. Ground truth is read only after each analysis subprocess finishes.

## Initial boundaries

- Electronic pitched audio. Drums and vocals are not practice targets.
- Files up to 60 MB. Full recordings are processed without a duration cutoff.
- Variable source count based on candidate evidence, with no fixed eight-instrument ceiling and no `other` category. The CLI has an optional explicit `--max-parts` research budget; normal imports do not set it. Distinct source identity remains an estimate, especially for indistinguishable overlapping timbres.
- Automatic pitch range is MIDI 21–108 (A0–C8). The finite synth model approximates the source; pitch bends, time-varying patches, layered detuning, stereo effects, and effects-heavy sources need broader validation. Working audio is mono at 22.05 kHz.
- Instrument identities and note boundaries are estimates. They require review before practice.

This initial browser implementation is ready for real-recording validation. Start with an electronic instrumental recording. Generated fixtures establish reproducible behavior, not guaranteed accuracy on finished commercial mixes. Physical MIDI hardware has not been tested in this environment; routing and reconnection are covered by protocol-level tests.
