# Instrument Lab — initial implementation handoff

The browser feature is implemented and has passed its initial requirements audit. The next validation phase is the user's real audio. Do not reopen completed implementation work merely because the earlier goal checkpoints were still active. Improvements should respond to new evidence, especially real recordings.

## Scope and architecture

User requirements: electronic instruments; browser only; backend analysis chosen; variable instrument count; one instrument = one extracted reference stem = one editable synth patch; detected pitch/onset/duration events playable in practice; new pipeline independent of the legacy implementation. Drums/vocals are outside the initial targets. No Electron work.

Canonical repo `/Users/jimmylevagueresse/Code/PROJECTS/melodics`, feature `instrument-lab/`. Staging source is `/Users/jimmylevagueresse/Documents/Codex/2026-10-04/let/work/instrument-lab/`; sources are synchronized excluding `.venv`, `node_modules`, `data`, `dist`, `__pycache__`. The canonical repo is outside the writable sandbox, so explicit filesystem escalation was used for the specific new-feature files. Preserve unrelated user changes. Root package.json contains five feature scripts; no other existing application files were changed by this implementation. No commits or pushes were made. User AGENTS rule requires checking PR state before any future push.

- Shared custom harmonic/FM engine in `engine/synth.mjs`: six oscillator families, brightness/body/FM/pulse controls, ADSR, detune, gain. Identical Voice implementation used by Node offline rendering and AudioWorklet. Offline and live rendering keep the same ~9.9 kHz spectral bandwidth at different device sample rates. Wavetable preparation and practice rendering run in workers; stale requests are coalesced or cancelled.
- `analysis/analyze.py` method `synth-dictionary-pitch-consensus-v3`: sparse spectral discovery, continuous timbre fitting, supported-note consensus, common audible-harmonic candidate consolidation, register/identity stabilization, masked chord continuation reconciliation, smoothed demodulated envelope fitting, final note-constrained reference masks and RMS level calibration. Candidate discovery now ends on evidence, not a fixed eight-candidate limit. An optional explicit CLI max-parts budget remains for research. The finite dictionary and evidence thresholds still bound what can be discovered.
- `analysis/pitch_support.py`: Spotify Basic Pitch .4.0 packaged ONNX model, CPU two threads, MIDI 21–108. No numeric max-frequency filter is applied because the library rounds it to an exclusive bin and would exclude C8. Central MIDI30–89 discovery remains stable; extended pitches are opened where independent pitch evidence exists.
- High-register candidates compare only common observable harmonics, not their inaudible higher coefficients. When few harmonics remain, a different oscillator family may be observationally equivalent. Prefer a representative with a richer observed spectrum in that case. This fixed a single high lead being split into multiple patches. It does not prove physical source identity for indistinguishable sounds.
- `analysis/reextract.py`: rebuild reference masks from the original mixture after note or instrument-assignment corrections. Preserves `referencePatch` separately from manual playable patch controls. Uses actual assigned pitches, including manual notes outside the former limited register. No gain/ADSR overwrite during manual edits.
- `server/assignments.mjs` and revision-checked edit API: split selected notes into an independent patch/stem, move notes, merge rows, remove emptied assignment sources, reject invalid/stale changes. Exact duplicate merged events are deduplicated. Name/patch-only saves retain references; note/assignment changes re-extract them.
- Server job lifecycle: per-attempt UUID, guarded progress/error/ready transitions, serialized spawn/cancel/retry, separate attempt directories. Cancelled or obsolete jobs cannot publish. Final rendering checks cancellation. Shutdown stops dispatch and terminates subprocesses. Immutable generation-prefixed WAV/JSON files plus atomic `project.documentFile`/revision update form one commit. `analysisFile` preserves the automatic snapshot. Legacy projects fall back to `edited.json`. Failed extraction does not publish a partial revision.
- Browser: import/demo/progress/cancel/retry, original/rebuilt/reference/synth playback, live knobs and instrument names, editable note piano roll, split/move/merge controls, drafts, save-conflict protection, computer/onscreen/Web MIDI playing, loop/speed/count-in, target-muted backing, pitch-and-onset scoring. Pitch plots adapt to the actual register.
- `client/midi.mjs` attaches devices connected later, releases disconnected or deselected inputs, handles channel-specific note-off/all-notes-off, and avoids duplicate handlers. Physical MIDI hardware was unavailable; these paths have protocol-level tests.
- `engine/scoring.mjs` uses a constant 150 ms real-time window at different practice speeds, nearest matching unmatched note, exclusive loop-end boundary, no warm-up penalty, and independent chord-note credit. Delayed audio preparation cannot score against a different take or revive a cancelled/retriggered note. Focus loss clears pending live notes without stopping backing.

## Run and preview

From the canonical repo: `npm run setup:instruments`, then `npm run dev:instruments`; open http://127.0.0.1:5186. Setup was executed successfully; Python3.11 environment has numpy1.26.4, scipy1.17.1, soundfile.14, basic-pitch.4.0, onnxruntime1.23.2 and setuptools69.5.1. FFmpeg is installed. The experimental Python is `work/analysis-env/bin/python`; avoid the system Python for analysis tests.

The final preview server is session **91296**, verified through browser requests after restart; revalidate the handle when continuing. CUA IAB browser2/tab2 (`lab`), marked as a deliverable and left on the latest four-instrument example. Final live C4 and rebuilt mix playback both worked without browser errors/warnings. Playback was stopped before handoff. Main user-facing demo: **4d2fe180-0aa8-497e-84fe-598ff064c03f**, title **Four-instrument reference test**, fresh v3 analysis: 4 parts, 66 events, all 64 expected fixture notes plus 2 extras, MIDI range21–108, sourceLimit null. This is generated independent audio, not a real recording.

Other projects retained:

- `ea6dac0d-4028-41fb-abee-5fecad063603`: latest Neon duet, 2 parts/40 notes, revision4 after split/move/merge browser testing. Part1 **Glass lead · save check**. Original analysis preserved.
- `1337c0a6-7250-4637-8927-f69d4f236eb4`: older independent-four analysis, 4 parts/68 notes; **Warm chords** name persisted. Do not confuse it with the new 66-note v3 demo.
- `bf0a5c4e-29e1-4a28-b7c6-be2ad87a61fb`: older Neon duet test.

## Requirements evidence

All implementation lives in this feature; import scan found no legacy pipeline or Electron dependencies. Models are backend-only, live performance is browser Web Audio. Result JSON and API workflows retain one patch and one reference stem per instrument, with variable count and no other category. A candidate-selection regression explicitly verifies nine supported candidates are not capped at eight; this is not a claim of nine-instrument audio accuracy.

**29 regression tests: 20 Node + 9 Python.** Coverage includes shared/live spectral consistency, six-family synthesis, note-off, loop-held notes, pitch-preserving tempo, async cancellation/retriggering, rapid patch edits, MIDI lifecycle, scoring, source ownership, actual split WAV isolation, preservation of user sound, low/high manual pitches, automatic note evidence, masked holds, invalid API input, late cancelled workers, immediate retry, cancellation during final rendering, extraction failure rollback, immutable revisions, and concurrent saves (200 + 409). The API tests use temporary storage and fake processes to force races; the Python isolation test uses real generated WAVs and real factorization. Final canonical `npm run test:instruments` and `npm run build:instruments` both pass; production JS is171.80kB (55.82kB gzip).

Browser evidence on the canonical server:

- Imported independent-four through the actual file picker in an earlier turn; analysis, isolated/synth audition and target-muted practice completed without browser errors.
- Saved name/patch and added/edited/deleted notes; drafts survived switching/reload. Later corrected-note saves now also regenerate references.
- Shift-selected two lead notes, split them as **Opening phrase**, auditioned its isolated stem, moved one note back, merged the remaining note back. Counts went 2→3→2 instruments while preserving all40 notes. Reload verified persistence. Actual new stem early RMS .027910 and RMS after2s exactly zero; source stem later RMS .033204. This was re-extraction, not copied audio.
- Final scoring test set loop .4235–.7 seconds on C4: wrong-pitch warm-up during count-in left 0 extras; on-time onscreen C4 produced **1/1 notes hit, 0 extra notes**; take completed. No browser errors/warnings. Count-in now changes to “Your turn” when playback starts.
- WAV import ran end-to-end. Actual FFmpeg encode/decode smoke checks also passed MP3, FLAC, OGG/Vorbis, M4A/AAC and raw AAC using the server's decoder options; all yielded finite audible mono22050Hz PCM of the expected duration.

## Blind generated-audio benchmark

Final authoritative run: `work/benchmark-initial-release/metrics.json` plus per-recording result JSON/logs. Analyzer subprocesses receive only mixtures and the normal catalogue. Ground-truth labels and isolated source WAVs are read after analysis for evaluation. Independent fixtures use SciPy oscillators, Butterworth filtering and different envelopes. Two benchmark jobs run concurrently; runtimes are measurements, not guarantees.

| Case                | Found/expected instruments | Correct/expected notes | Extra notes | F1     | Seconds |
| ------------------- | -------------------------- | ---------------------- | ----------- | ------ | ------- |
| duet                | 2/2                        | 40/40                  | 0           | 1.0    | 10.13   |
| independent-duet    | 2/2                        | 40/40                  | 0           | 1.0    | 20.43   |
| independent-four    | 4/4                        | 64/64                  | 2           | 0.9846 | 18.13   |
| independent-overlap | 2/2                        | 35/40                  | 2           | 0.9091 | 9.57    |
| independent-solo    | 1/1                        | 24/24                  | 0           | 1.0    | 5.92    |
| independent-trio    | 3/3                        | 52/52                  | 2           | 0.9811 | 17.43   |
| range-duet          | 2/2                        | 40/40                  | 0           | 1.0    | 13.8    |
| range-high          | 1/1                        | 24/24                  | 0           | 1.0    | 6.89    |
| range-low           | 1/1                        | 16/16                  | 0           | 1.0    | 14.67   |
| solo                | 1/1                        | 24/24                  | 0           | 1.0    | 6.33    |
| trio                | 3/3                        | 48/52                  | 4           | 0.9231 | 15.55   |

All11 cases have the expected source count. Shared-engine trio still has four missed/four extra notes; the same-register pair has five misses/two extras. The independent four has no missed notes/two extras. This is useful initial behavior, not universal transcription accuracy.

Independent chord mean note-off errors improved from ~180–220ms to 22/28ms in the three/four-part cases; shared-engine trio remains ~220ms. Original four-part raw synth spectral errors lead/bass/pluck/chord were .1335/.4718/.1394/.3334 after envelope improvements. Investigation found much of the bass metric was gated DC/very-low-frequency energy in the independent pulse generator: the same20Hz high-pass on both signals gives .1345. Raw and high-passed metrics are both retained; neither is a perceived-similarity percentage. The extreme low-bass/high-lead pair has raw errors .4868/.1292, with low-bass high-passed error ~.247. High lead solo error .1298 and RMS level error−.6dB. Solo SI-SDR “improvement over mixture” is not meaningful because its mixture is already the isolated source.

Useful history: `work/benchmark-v2-final/`, `work/benchmark-dynamics-v3/`, `work/dynamics-join-four/`. Intermediate range experiments are superseded by `benchmark-initial-release`; some showed regressions and must not be presented as current results. Fitting masked reference audio directly softened attacks excessively and was rejected. Filtering discovery to every Basic Pitch proposal, instead of only gating the extended register, destabilized core chord detection and was rejected.

## Initial limits / next validation phase

The user explicitly intends to test real audio after this initial result. Start with instrumental electronic recordings up to60MB. Working audio is mono22.05kHz; real recordings, effects-heavy sources, evolving patches, pitch bends, stereo effects and indistinguishable simultaneous timbres need user feedback. Auto source count and note boundaries are estimates; the review/correction tools are part of the intended workflow. Drums/vocals are not targets. Physical MIDI hardware and subjective listening were not verified here. The local server is loopback-only; multi-user hosting/auth/storage quotas are outside this initial scope. Old/failed immutable generations are retained; storage cleanup is future maintenance.

No outstanding implementation blocker remains for the initial browser feature. Do not equate these known model/deployment boundaries with missing promised implementation, or claim they are solved. Gather real-recording feedback before choosing the next algorithm changes.


Full-song import correction (2026-10-04): removed the analyzer's 180-second rejection and FFmpeg's 181-second truncation. Float32 audio/STFT, blocked sparse discovery/factorization, and one-at-a-time reference masks reduce scratch memory; this is not fully streaming (whole-song audio, spectrograms and activations remain resident). Block boundaries do not restart voices or split note decoding. Structured analysis errors reach the UI; raw child diagnostics stay in server logs. Regression tests cover block-equivalent estimates, nontruncating conversion arguments, and structured/unexpected child errors. The user's 209.76-second MP3 completed a full analysis with six candidate instruments, 572 events, 28 starts after 180 seconds, and six full-duration reference WAVs. This verifies processing coverage, not separation/transcription accuracy. The independent four-part short fixture retains 64/64 expected notes plus two extras. Active preview was restarted as session 94582; revalidate it before further runtime work.


Melodics integration (2026-10-04): the browser at localhost:5173 now has an Instrument Lab tab and a separate Instrument Lab editor button on every imported song. Original Edit sounds / practice actions and implementation files are retained. The complete Lab editor/practice runs in an iframe under /instrument-lab/, served by the existing songs API; audio/worker URLs and API namespace are adapted for this location. server/instrument-lab.ts provides a read-only source bridge and proxy. Song-ID linking plus original-byte hashes preserve existing Lab documents. npm run dev builds the embedded bundle and starts all three services. Standalone Lab preview still works. Lab server session after integration: 85049 (revalidate). Baseline feature checksums are in the task work/preserved-features.json. Existing renderer typecheck reports unused variables in LessonPlayer, NoteHighway and midiToLesson; do not change those unrelated features for this integration.


Native editor correction: supersedes the iframe integration described above. `InstrumentLabEditor.jsx` exports the full editor as a shared React component; `main.jsx` now only boots the standalone preview. Melodics imports the component directly and opens it full-screen like StemSoundEditor. Native layout removes duplicate sidebar/branding and replaces the recordings sidebar with a header selector while retaining all import/edit/practice tools. CSS rules are scoped to .instrument-lab-ui; keyframes are namespaced. configureLabPaths(true) selects the in-app API/worker namespace. Original editor/practice implementation files remain byte-identical to the prior snapshot. No predev Lab build is required for native mode.
