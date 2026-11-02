"""Private HF Jobs transport used by the Lab server; stdout is sanitized JSON events."""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import sys
import time
from huggingface_hub import HfApi, Volume, get_token, sync_bucket

HERE = Path(__file__).resolve().parent
TERMINAL = {'COMPLETED', 'ERROR', 'CANCELED', 'CANCELLED', 'DELETED'}

def event(stage, progress=0, **fields):
    print(json.dumps(dict(stage=stage, progress=progress, **fields)), flush=True)

def save(path, data):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(data, indent=2))
    temp.replace(path)

def credentials():
    # The user's selected token is read server-side; never sent to the browser.
    token = get_token()
    if not token:
        raise ValueError('Hugging Face is not signed in on the analysis server.')
    return token

def cancel(api, state):
    if state.get('id'):
        job = api.inspect_job(job_id=state['id'], namespace=state['namespace'])
        if job.status.stage not in TERMINAL:
            api.cancel_job(job_id=state['id'], namespace=state['namespace'])

def main(args):
    token = credentials()
    api = HfApi(token=token)
    if args.check:
        user = api.whoami()
        event('Connected', account=user['name'])
        return
    folder = args.output.resolve()
    folder.mkdir(parents=True, exist_ok=True)
    state_path = folder/'hf-job.json'
    state = json.loads(state_path.read_text()) if state_path.exists() else None
    if args.cancel:
        if state:
            if not state.get('id'):
                matches = [j for j in api.list_jobs(namespace=state['namespace']) if (j.labels or {}).get('run-id') == state['runId']]
                if len(matches) == 1:
                    state.update(id=matches[0].id, url=matches[0].url)
                    save(state_path, state)
            cancel(api, state)
        event('Cancelled')
        return
    if not state:
        account = api.whoami()['name']
        bucket = account + '/melodics-instrument-lab'
        api.create_bucket(bucket, private=True, exist_ok=True)
        if not api.bucket_info(bucket).private:
            raise ValueError('Instrument Lab bucket must be private.')
        run_id = folder.name
        prefix = 'hf://buckets/' + bucket + '/' + run_id
        bundle = folder/'hf-input'
        bundle.mkdir(exist_ok=True)
        for name in ['worker.py', 'separate.py']:
            shutil.copyfile(HERE/name, bundle/name)
        shutil.copyfile(args.input, bundle/'source.wav')
        shutil.copyfile(args.request, bundle/'request.json')
        event('Uploading recording to private Hugging Face storage', .02)
        sync_bucket(str(bundle), prefix+'/input', token=token, quiet=True)
        marker = folder/'hf-marker'
        marker.mkdir(exist_ok=True)
        (marker/'mount-check.json').write_text(json.dumps({'runId': run_id}))
        sync_bucket(str(marker), prefix+'/output', token=token, quiet=True)
        # Persist intent first: an ambiguous submit is recovered, never blindly retried.
        state = dict(namespace=account, runId=run_id, results=prefix+'/output', submission='pending')
        save(state_path, state)
        job = api.run_job(image='python:3.11-slim-bookworm', flavor='a100-large',
            command=['python', '/inputs/worker.py'], timeout=1800, attempts=1,
            name='melodics-instrument-lab', labels={'project':'melodics', 'run-id':run_id},
            volumes=[Volume(type='bucket', source=bucket, path=run_id+'/input', mount_path='/inputs', read_only=True),
                     Volume(type='bucket', source=bucket, path=run_id+'/output', mount_path='/outputs', read_only=False)],
            secrets={'HF_TOKEN':token})
        state.update(id=job.id, url=job.url, submission='accepted')
        save(state_path, state)
    if not state.get('id'):
        matches = [j for j in api.list_jobs(namespace=state['namespace']) if (j.labels or {}).get('run-id') == state['runId']]
        if len(matches) != 1:
            raise ValueError('Job submission could not be confirmed. Check Hugging Face Jobs before starting another run.')
        state.update(id=matches[0].id, url=matches[0].url, submission='recovered')
        save(state_path, state)
    def interrupted(*_):
        try:
            cancel(api, state)
        finally:
            raise SystemExit(130)
    signal.signal(signal.SIGTERM, interrupted)
    remote = folder/'hf-output'
    remote.mkdir(exist_ok=True)
    failures = 0
    while True:
        try:
            job = api.inspect_job(job_id=state['id'], namespace=state['namespace'])
            sync_bucket(state['results'], str(remote), include=['*.json'], token=token, quiet=True)
            status_file = remote/'status.json'
            status = json.loads(status_file.read_text()) if status_file.exists() else {}
            progress = min(.64, float(status.get('progress', 0))*.6)
            run_file = remote/'stems/run.json'
            if run_file.exists():
                run = json.loads(run_file.read_text())
                count = len(json.loads(args.request.read_text())['targets'])
                progress = .2 + .44*len(run.get('jobs', []))/count
            event(status.get('stage', 'Hugging Face '+job.status.stage.lower()), progress,
                  remoteJob={'id':state['id'], 'url':state['url'], 'status':job.status.stage})
            failures = 0
            if job.status.stage == 'COMPLETED':
                break
            if job.status.stage in TERMINAL:
                raise ValueError('Hugging Face job '+job.status.stage.lower()+'. Open the job log for details.')
        except json.JSONDecodeError:
            event("Waiting for remote status update", .15)
        except (ValueError, SystemExit):
            raise
        except Exception:
            failures += 1
            event('Reconnecting to Hugging Face; the same job continues', .15,
                  remoteJob={'id':state['id'], 'url':state['url'], 'status':'RECONNECTING'})
            if failures >= 20:
                raise ValueError('Connection to Hugging Face interrupted. Resume this run to retrieve its results.')
        time.sleep(5)
    event('Downloading separated stems', .66)
    sync_bucket(state['results'], str(remote), include=['*.json', '*-target.wav'], token=token, quiet=True)
    run = json.loads((remote/'stems/run.json').read_text())
    targets = json.loads(args.request.read_text())['targets']
    if run['status'] != 'finished' or len(run['jobs']) != len(targets):
        raise ValueError('The remote job returned an incomplete stem set.')
    event('Separated stems downloaded', .7, remoteJob={'id':state['id'], 'url':state['url'], 'status':'COMPLETED'})

if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--input', type=Path)
    p.add_argument('--request', type=Path)
    p.add_argument('--output', type=Path)
    p.add_argument('--cancel', action='store_true')
    p.add_argument('--check', action='store_true')
    try:
        main(p.parse_args())
    except Exception as error:
        # Known app errors are safe; provider errors can contain URLs/headers.
        message = str(error) if isinstance(error, ValueError) else 'Hugging Face request failed ('+type(error).__name__+'). Check account access and connection, then resume.'
        event('Failed', error=message)
        sys.exit(1)
