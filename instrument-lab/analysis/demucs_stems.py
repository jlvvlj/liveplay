"""Discover voices within Demucs groups, then fit each retained instrument stem.

The Sound editor's Demucs script owns the initial separation. This stage never
feeds the full mix into discovery and never changes the reference after fitting.
"""
import argparse
import contextlib
import json
from pathlib import Path
import shutil
import numpy as np
import soundfile as sf
from analyze import analyze as analyze_synth
from drums import analyze as analyze_drums
from sam_stems import peaks

EMPTY_ERRORS = ('No reliable pitched notes', 'No stable instrument candidates',
                'No stable pitched instruments', 'No distinct drum attacks',
                'No reliable repeating drum sounds', 'This drum stem is silent')


def report(stage, progress):
    print(json.dumps(dict(stage=stage, progress=progress)), flush=True)


def fit(source, folder, catalog, engine='melodic', limit=1):
    folder.mkdir(parents=True, exist_ok=True)
    audio, _ = sf.read(source, always_2d=True, dtype='float32')
    if not np.isfinite(audio).all():
        raise ValueError('Separated audio contains invalid samples.')
    if np.max(np.abs(audio)) < 1e-5:
        return dict(parts=[], analysis={})
    with (folder/'analysis.log').open('w') as log, contextlib.redirect_stdout(log):
        try:
            if engine == 'drum':
                return analyze_drums(str(source), str(folder), mixed=False)
            return analyze_synth(str(source), folder, catalog, max_parts=limit)
        except ValueError as error:
            if not str(error).startswith(EMPTY_ERRORS):
                raise
            return dict(parts=[], analysis={})


def main(args):
    folder = args.output
    source, sr = sf.read(args.input, always_2d=True, dtype='float32')
    duration = len(source)/sr
    catalog = json.loads(args.catalog.read_text())
    stems = folder/'demucs'
    for name in ('bass', 'drums', 'other', 'vocals'):
        audio, rate = sf.read(stems/(name+'.wav'), always_2d=True, dtype='float32')
        if rate != 44100 or abs(len(audio)/rate-duration) > .05 or not np.isfinite(audio).all():
            raise ValueError('Demucs returned invalid or misaligned '+name+' audio.')
    parts, warnings = [], [
        'Demucs groups are separated first. Instrument splits within other are spectral estimates; compare the original stems before practicing.',
        'Vocals are excluded from the rebuilt mix.'
    ]

    def retain(part, reference, name, engine, category, method, assets=None):
        pid = 'instrument-'+str(len(parts)+1)
        audio, rate = sf.read(reference, always_2d=True, dtype='float32')
        if abs(len(audio)/rate-duration) > .05:
            raise ValueError('An instrument stem is not aligned with the recording.')
        reference_file = pid+'-reference.wav'
        shutil.copyfile(reference, folder/reference_file)
        if engine == 'drum':
            sample_file = pid+'-sample.wav'
            shutil.copyfile(assets/part['sampleFile'], folder/sample_file)
            part['sampleFile'] = sample_file
        part.update(id=pid, name=name, engine=engine, referenceFile=reference_file,
                    referenceWaveform=peaks(audio), locked=part.get('locked', []),
                    automaticPatch=part.get('automaticPatch', part['patch']),
                    separation=dict(provider='demucs-lab', category=category, method=method))
        parts.append(part)

    report('Fitting the separated bass stem', .43)
    bass = fit(stems/'bass.wav', folder/'fit-bass', catalog)
    bass_part = bass['parts'][0] if bass['parts'] else dict(patch=catalog[0]['patch'].copy(), notes=[])
    retain(bass_part, stems/'bass.wav', 'Bass', 'melodic', 'bass', 'demucs')
    warnings.extend('Bass: '+warning for warning in bass.get('analysis', {}).get('warnings', []))
    if not bass['parts']:
        warnings.append('Bass: no reliable notes were found. The original stem is retained for review.')
    report('Discovering drum instruments in the separated drums', .51)
    drums_folder = folder/'fit-drums'
    drums = fit(stems/'drums.wav', drums_folder, catalog, engine='drum')
    for i, part in enumerate(drums['parts']):
        retain(part, drums_folder/part['referenceFile'], 'Drum '+str(i+1),
               'drum', 'drums', 'drum-hit-clustering', drums_folder)
    if not drums['parts']:
        warnings.append('No reliable drum instruments were found in the separated drums.')
    warnings.extend(drums.get('analysis', {}).get('warnings', []))

    report('Splitting instruments within the other stem', .61)
    discovery_folder = folder/'discover-other'
    discovery = fit(stems/'other.wav', discovery_folder, catalog, limit=12)
    candidates = discovery['parts']
    warnings.extend(discovery.get('analysis', {}).get('warnings', []))
    if not candidates:
        warnings.append('No reliable pitched instruments were identified in other. This audio is absent from the rebuilt mix.')
    if discovery.get('analysis', {}).get('discoveryLimitReached'):
        warnings.append('The 12-instrument discovery budget for other was reached; some sounds may remain unassigned.')
    for i, candidate in enumerate(candidates):
        report('Fitting synth '+str(i+1)+' of '+str(len(candidates)), .7+.23*i/max(1,len(candidates)))
        reference = stems/'other.wav' if len(candidates)==1 else discovery_folder/candidate['referenceFile']
        fitted = fit(reference, folder/('fit-other-'+str(i+1)), catalog)
        # Never silently recycle discovery notes if the independent fit fails.
        part = fitted['parts'][0] if fitted['parts'] else dict(patch=candidate['patch'].copy(), notes=[])
        warnings.extend('Synth '+str(i+1)+': '+warning for warning in fitted.get('analysis', {}).get('warnings', []))
        if not fitted['parts']:
            warnings.append('Synth '+str(i+1)+': no reliable notes in the individual stem. Its audio is retained for review.')
        retain(part, reference, 'Synth '+str(i+1), 'melodic', 'other',
               'demucs' if len(candidates)==1 else 'spectral-instrument-discovery')
    result = dict(version=1, engine='mixed', duration=duration, sampleRate=sr,
                  waveform=peaks(source,600), parts=parts,
                  separation=dict(provider='demucs-lab', model='htdemucs_ft',
                                  otherInstrumentLimit=12, excludedCategories=['vocals']),
                  analysis=dict(method='demucs-then-instrument-discovery-and-fitting',
                                notes=sum(len(p['notes']) for p in parts), spectralResidual=None,
                                warnings=list(dict.fromkeys(warnings))))
    (folder/'result.json').write_text(json.dumps(result, indent=2))
    report('Instrument stems ready', .95)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ('input', 'output', 'catalog'):
        parser.add_argument('--'+name, type=Path, required=True)
    try:
        main(parser.parse_args())
    except Exception as error:
        print(json.dumps(dict(stage='Failed', progress=0, error='Instrument stem analysis failed: '+str(error))), flush=True)
        raise
