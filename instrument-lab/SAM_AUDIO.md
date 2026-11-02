# SAM Audio in Instrument Lab

Open an imported song’s **Instrument Lab editor**, then **Separate with SAM Audio**.
Review the proposed sound descriptions, choose synth or drum for each, and click
**Start separation**. For a faster trial, enable **Test a passage** and enter its
start/end in seconds. The passage becomes its own timeline starting at zero; its
original source interval remains visible beside the analysis selector.

A run uploads that recording/passage into the account’s private
`melodics-instrument-lab` Hugging Face bucket and starts one A100 Job with a
30-minute timeout and no automatic retry. This uses paid HF compute. A link to
the actual job and progress appear in the editor. Cancel requests remote
cancellation too. If communication fails, use Resume to retrieve the same job;
starting a separate analysis is a separate GPU run.

The prior Lab analysis remains selectable as **Earlier analysis**. Every SAM run
is a separate project with separate documents and assets. The Audio editor’s
Demucs separation, sound edits and practice features are unchanged.

## Result behavior

- Every requested target produces one original stem and one synth/drum patch.
  Note/hit fitting runs on that stem, not on the original mix.
- The extracted waveform sits above the note lane on the same seek/zoom timeline.
- Original/Rebuilt stem playback, full Original/Rebuilt mix comparison, solo,
  mute, loops, note review, sound shaping and practice use existing Lab controls.
- Saving notes or a patch never re-extracts or overwrites the original SAM stem.
  Merging sums immutable source audio and keeps the destination patch.
- A stem with no reliable events remains visible and audible with a warning and
  an empty note lane, so it can be inspected and notes can be added manually.
- Split/move between SAM stems is not supported yet; whole-track merging is
  available. Earlier analyses retain their existing split/move behavior.

This is an experimental, user-testable integration. SAM uses explicit prompts;
proposed descriptions from the earlier Lab analysis are editable suggestions,
not verified source identities. It does not automatically discover every source
or ensure two prompts produce different stems. No fixed Demucs categories or
residual “other” track are used. Up to 24 targets can be requested per job. SAM’s
original stems are mono; the imported mix is preserved in stereo. The waveform
provides comparison/seek/zoom; it does not yet expose the Audio editor’s full
brush/selection editing tools.

## Server setup

The existing Instrument Lab analysis environment and FFmpeg are needed as usual.
Install the lightweight Jobs client with:

```sh
node instrument-lab/server/setup-hf.mjs
```

The server reads the existing Hugging Face login. Sign in using the client’s
`instrument-lab/.venv-hf/bin/hf auth login` command if needed. Gated SAM Audio
access and Hugging Face Jobs billing must be enabled for that account. Tokens
are never sent to the browser or saved in project metadata; the GPU worker
receives one through HF encrypted secrets. `INSTRUMENT_LAB_HF_PYTHON` can point
to another Python environment with `huggingface_hub==2.1.1`.

The worker pins SAM code and checkpoint revisions. It downloads weights only
inside the remote Job. Source uploads and results remain in the private bucket;
there is no automatic remote retention cleanup yet.

Run the lifecycle checks with:

```sh
node --test instrument-lab/tests/sam-api.test.mjs
```

These isolated tests use a fake transport, never charge the account, and cover
request validation, duplicate submissions, separate documents, immutable
references during edits, waveform merge, and remote cancellation. Real GPU
verification is performed from the browser separately.
