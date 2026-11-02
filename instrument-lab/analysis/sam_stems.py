"""Fit exactly one playable instrument per SAM stem, retaining the extracted audio."""
import argparse
import contextlib
import math
import json
from pathlib import Path
import shutil
import subprocess
import sys
import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

HERE = Path(__file__).resolve().parent

def peaks(audio, count=12000):
    mono = np.max(np.abs(audio), axis=1)
    return [round(float(np.max(chunk)), 5) for chunk in np.array_split(mono, min(count, len(mono)))]

def main(args):
    folder = args.output
    request = json.loads(args.request.read_text())
    run = json.loads((folder/'hf-output/stems/run.json').read_text())
    source, sr = sf.read(args.input, always_2d=True, dtype='float32')
    duration = len(source)/sr
    catalog = json.loads(args.catalog.read_text())
    parts, warnings = [], ['SAM Audio extraction is experimental. Compare each original stem with the imported mix; descriptions can select the same sound.']
    for i, target in enumerate(request['targets']):
        pid = 'instrument-'+str(i+1)
        print(json.dumps(dict(stage='Fitting '+target['name'], progress=.7+.23*i/len(request['targets']))), flush=True)
        stem = folder/'hf-output/stems'/f'{pid}-target.wav'
        audio, stem_sr = sf.read(stem, always_2d=True, dtype='float32')
        if abs(len(audio)/stem_sr-duration) > .05 or not np.isfinite(audio).all():
            raise ValueError('Separated stem duration or samples are invalid')
        fitted = folder/('fit-'+pid)
        fitted.mkdir(exist_ok=True)
        engine = target['engine']
        if np.max(np.abs(audio)) <= 1e-6:
            analyzed = {'parts': []}
        elif engine == 'drum':
            # Resample only the fitting input; the SAM reference stays untouched.
            from drums import analyze as analyze_drums
            divisor = math.gcd(stem_sr, 44100)
            prepared = resample_poly(audio, 44100//divisor, stem_sr//divisor, axis=0)
            if prepared.shape[1] == 1:
                prepared = np.repeat(prepared, 2, axis=1)
            drum_input = fitted/'analysis-input.wav'
            sf.write(drum_input, prepared, 44100, subtype='FLOAT')
            with (fitted/'analysis.log').open('w') as log, contextlib.redirect_stdout(log):
                try:
                    analyzed = analyze_drums(str(drum_input), str(fitted), mixed=False)
                except ValueError as error:
                    if not str(error).startswith(('No distinct drum attacks', 'No reliable repeating drum sounds', 'This drum stem is silent')):
                        raise
                    analyzed = {'parts': []}
        else:
            command = [sys.executable, str(HERE/'analyze.py'),
                '--input', str(stem), '--output', str(fitted), '--catalog', str(args.catalog),
                '--max-parts','1','--allow-empty']
            with (fitted/'analysis.log').open('w') as log:
                subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, check=True)
            analyzed = json.loads((fitted/'result.json').read_text())
        candidates = analyzed['parts']
        if candidates:
            part = max(candidates, key=lambda p: len(p['notes']))
            if engine == 'drum':
                # One requested sound remains one instrument, even when hit clustering
                # proposes variants. Keep the most-supported patch and all detected hits.
                notes = [dict(n, pitch=36) for p in candidates for n in p['notes']]
                unique = {}
                for n in notes:
                    key = round(n['start']/.02)
                    if key not in unique or unique[key]['velocity'] < n['velocity']:
                        unique[key] = n
                part['notes'] = sorted(unique.values(), key=lambda n:n['start'])
                sample = f'{pid}-sample.wav'
                shutil.copyfile(fitted/part['sampleFile'], folder/sample)
                part['sampleFile'] = sample
                if len(candidates) > 1:
                    warnings.append(target['name']+': multiple hit variants were fitted to one drum patch; review the sound.')
        else:
            part = dict(patch=catalog[0]['patch'].copy(), notes=[], locked=[])
            if engine == 'drum':
                silent = np.zeros((4410, 2), dtype=np.float32)
                part['patch'] = dict(engine='drum', tune=0, decay=1, transient=1, tone=1, noise=1, brightness=1, drive=0, gain=1, detail=1, chokeGroup='', model=dict(frequency=60,sweep=0,sweepDecay=.02,phase=0,toneDecay=.15,toneLevel=0,noiseLevel=0,noiseDecay=.1,pan=.5))
                part['sampleFile'] = f'{pid}-sample.wav'
                sf.write(folder/part['sampleFile'], silent, 44100, subtype='FLOAT')
            warnings.append(target['name']+': no reliable events were found. The extracted audio is retained for review.')
        reference = f'{pid}-reference.wav'
        shutil.copyfile(stem, folder/reference)
        part.update(id=pid, name=target['name'], engine=engine, referenceFile=reference,
            referenceWaveform=peaks(audio), automaticPatch=part.get('automaticPatch',part['patch']),
            separation=dict(provider='sam-audio', description=target['description'], sourceId=pid,
                modelRevision=run['modelRevision']), locked=part.get('locked',[]))
        parts.append(part)
    result = dict(version=1, engine='mixed', duration=duration, sampleRate=sr,
        waveform=peaks(source,600), parts=parts,
        separation=dict(provider='sam-audio', model=run['model'], modelRevision=run['modelRevision'],
            codeCommit=run['codeCommit'], candidates=run['candidates'], spanMode=request['spanMode'],
            sourceRange=request.get('range'), outputChannels=1),
        analysis=dict(method='sam-audio-per-instrument', notes=sum(len(p['notes']) for p in parts),
            spectralResidual=None, warnings=warnings))
    (folder/'result.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(dict(stage='Instrument stems ready', progress=.94)), flush=True)

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ['input','output','request','catalog']:
        parser.add_argument('--'+name, type=Path, required=True)
    try:
        main(parser.parse_args())
    except Exception as error:
        print(json.dumps(dict(stage='Failed',progress=0,error='Could not fit the separated stems ('+type(error).__name__+'). Remote stems are preserved; resume to retry fitting.')),flush=True)
        raise
