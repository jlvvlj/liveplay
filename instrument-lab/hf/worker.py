"""Bounded HF Job: user recording -> prompted SAM stems. No app credentials in files."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

SOURCE, OUT = Path('/inputs'), Path('/outputs')
DEADLINE = time.monotonic() + 1680
COMMIT = 'bb4c6999d2677c7402360e426afc01ddfad6dce0'
REVISION = '5f2cd3a9471a08c7282c06036be6893e18de8b70'

def status(stage, progress, **extra):
    value = dict(stage=stage, progress=progress, **extra)
    (OUT / 'status.json').write_text(json.dumps(value))
    print(json.dumps(value), flush=True)

def command(name, args):
    with (OUT / (name + '.log')).open('w') as log:
        subprocess.run(args, stdout=log, stderr=subprocess.STDOUT, check=True,
                       timeout=max(1, DEADLINE-time.monotonic()))

def main():
    if not (OUT/'mount-check.json').exists():
        raise RuntimeError('Missing persistent output mount')
    os.environ.update(HF_HOME='/tmp/sam-model-cache', TOKENIZERS_PARALLELISM='false', PIP_NO_CACHE_DIR='1')
    try:
        status('Preparing Hugging Face worker', .05)
        command('system', ['sh', '-c', 'apt-get update && apt-get install -y --no-install-recommends git ffmpeg libsndfile1 build-essential'])
        command('dependencies', [sys.executable, '-m', 'pip', 'install',
            'torch==2.8.0', 'torchaudio==2.8.0', 'torchvision==0.23.0',
            'torchcodec==0.6.0', 'transformers==4.57.6', 'numpy<2', 'scipy', 'soundfile',
            'git+https://github.com/facebookresearch/sam-audio.git@'+COMMIT])
        status('Loading SAM Audio and separating instruments', .18)
        config = json.loads((SOURCE/'request.json').read_text())
        manifest = {'jobs': [dict(id='instrument-'+str(i+1), case='recording',
            input=str(SOURCE/'source.wav'), description=t['description'], anchors=[])
            for i,t in enumerate(config['targets'])]}
        Path('/tmp/manifest.json').write_text(json.dumps(manifest))
        command('separation', [sys.executable, str(SOURCE/'separate.py'), '/tmp/manifest.json',
            str(OUT/'stems'), '--revision', REVISION, '--device', 'cuda',
            '--span-mode', config['spanMode'], '--candidates', str(config['candidates'])])
        status('Separation complete', 1)
    except Exception as error:
        status('Remote separation failed', 0, errorType=type(error).__name__)
        raise

if __name__ == '__main__':
    main()
