"""Run explicit-target SAM Audio benchmarks on a configured inference machine.

This deliberately has no access to truth.json. It is not the automatic source
discovery implementation. Every extraction reads the original mixture; no
Demucs categories or previously extracted residuals are used as model inputs.
"""

import argparse
import hashlib
from importlib.metadata import distribution
import json
import math
import os
from pathlib import Path
import re
import time

import numpy as np
import soundfile as sf
from scipy import signal

SAM_COMMIT = "bb4c6999d2677c7402360e426afc01ddfad6dce0"


def windows(length, size, overlap):
    if size <= 0 or overlap < 0 or overlap >= size:
        raise ValueError("Require 0 <= overlap < chunk size")
    start = 0
    while start < length:
        end = min(length, start + size)
        yield start, end
        if end == length:
            return
        start += size - overlap


def local_anchors(anchors, start, end):
    return [(kind, max(a, start) - start, min(b, end) - start)
            for kind, a, b in anchors if min(b, end) > max(a, start)]


def validate_manifest(data, base=Path(".")):
    jobs = data.get("jobs")
    if not isinstance(jobs, list) or not jobs:
        raise ValueError("Manifest requires a nonempty jobs list")
    ids = set()
    for job in jobs:
        identifier = job.get("id", "")
        if not re.fullmatch(r"[a-zA-Z0-9_-]{1,120}", identifier) or identifier in ids:
            raise ValueError("Job IDs must be unique safe filenames")
        ids.add(identifier)
        if not isinstance(job.get("description"), str) or not job["description"].strip():
            raise ValueError("Each target requires a description")
        input_path = (base / job.get("input", "")).resolve()
        if not input_path.is_file():
            raise ValueError(f"Missing mixture for {identifier}")
        job["input"] = str(input_path)
        for anchor in job.get("anchors", []):
            if (not isinstance(anchor, list) or len(anchor) != 3 or
                    anchor[0] not in ["+", "-"] or
                    not all(isinstance(x, (float, int)) and math.isfinite(x) for x in anchor[1:]) or
                    not 0 <= anchor[1] < anchor[2]):
                raise ValueError(f"Invalid temporal anchor for {identifier}")
    return jobs


def atomic_json(path, data):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(data, indent=2, allow_nan=False) + "\n")
    temporary.replace(path)


def main(args):
    manifest_bytes = args.manifest.read_bytes()
    jobs = validate_manifest(json.loads(manifest_bytes), args.manifest.parent)
    if args.only:
        jobs = [j for j in jobs if j["id"] in args.only]
        if set(args.only) != {j["id"] for j in jobs}:
            raise ValueError("An --only job is absent from the manifest")
    # Never turn old results into apparently current successful output.
    args.output.mkdir(parents=True, exist_ok=False)
    report = dict(status="starting", model=args.model, expectedCodeCommit=SAM_COMMIT,
                  manifestSha256=hashlib.sha256(manifest_bytes).hexdigest(),
                  supervision=("explicit-target-prompts-and-spans" if any(j.get("anchors") for j in jobs) else "explicit-target-prompts"),
                  automaticDiscoveryValidated=False, stereoPreserved=False,
                  chunkSeconds=args.chunk_seconds, overlapSeconds=args.overlap_seconds,
                  candidates=args.candidates, seed=args.seed, spanMode=args.span_mode, jobs=[])
    report_path = args.output / "run.json"
    atomic_json(report_path, report)
    try:
        import torch
        from huggingface_hub import HfApi, snapshot_download
        from sam_audio import SAMAudio, SAMAudioProcessor

        provenance = json.loads(distribution("sam_audio").read_text("direct_url.json") or "{}")
        report["codeCommit"] = provenance.get("vcs_info", {}).get("commit_id")
        if report["codeCommit"] != SAM_COMMIT:
            raise RuntimeError("Install SAM Audio from the pinned Git commit in README.md before benchmarking")

        if args.device == "cuda" and not torch.cuda.is_available():
            raise RuntimeError("CUDA is unavailable. Select a provisioned GPU machine, or explicitly use --device cpu/mps for a feasibility test.")
        if args.device == "mps" and not torch.backends.mps.is_available():
            raise RuntimeError("MPS is unavailable")
        # The inspected upstream BaseModel ignores its revision argument. Passing
        # a pinned local snapshot to both loaders avoids a moving model revision.
        revision = HfApi().model_info(args.model, revision=args.revision).sha
        checkpoint = snapshot_download(args.model, revision=revision)
        report.update(modelRevision=revision, torchVersion=torch.__version__, device=args.device)
        atomic_json(report_path, report)
        started = time.perf_counter()
        model = SAMAudio.from_pretrained(checkpoint).eval().to(args.device)
        processor = SAMAudioProcessor.from_pretrained(checkpoint)
        rate = processor.audio_sampling_rate
        report["loadSeconds"] = round(time.perf_counter() - started, 3)
        report["sampleRate"] = rate
        report["status"] = "running"
        atomic_json(report_path, report)
        for job in jobs:
            started = time.perf_counter()
            audio, input_rate = sf.read(job["input"], dtype="float32", always_2d=True)
            if not len(audio) or not np.isfinite(audio).all():
                raise ValueError("Input audio must contain finite samples")
            if input_rate != rate:
                divisor = math.gcd(input_rate, rate)
                audio = signal.resample_poly(audio, rate // divisor, input_rate // divisor, axis=0)
            count = len(audio)
            target = np.zeros(count, dtype=np.float32)
            residual = np.zeros(count, dtype=np.float32)
            weights = np.zeros(count, dtype=np.float32)
            chunk_logs = []
            overlap = round(args.overlap_seconds * rate)
            for index, (lo, hi) in enumerate(windows(count, round(args.chunk_seconds * rate), overlap)):
                anchors = local_anchors(job.get("anchors", []), lo / rate, hi / rate)
                torch.manual_seed(args.seed + index)
                batch = processor(audios=[torch.from_numpy(audio[lo:hi].T.copy())],
                                  descriptions=[job["description"]],
                                  anchors=[anchors] if anchors else None).to(args.device)
                with torch.inference_mode():
                    separated = model.separate(batch, predict_spans=(args.span_mode == 'predict' or (args.span_mode == 'auto' and not bool(anchors))),
                                               reranking_candidates=args.candidates)
                estimates = [x[0].detach().float().cpu().numpy().reshape(-1)
                             for x in [separated.target, separated.residual]]
                length = hi - lo
                if any(len(x) < length or not np.isfinite(x).all() for x in estimates):
                    raise RuntimeError("SAM returned truncated or non-finite audio")
                ramp = min(overlap, length)
                weight = np.ones(length, dtype=np.float32)
                if lo and ramp:
                    weight[:ramp] *= np.linspace(0, 1, ramp + 2, dtype=np.float32)[1:-1]
                if hi < count and ramp:
                    weight[-ramp:] *= np.linspace(1, 0, ramp + 2, dtype=np.float32)[1:-1]
                target[lo:hi] += estimates[0][:length] * weight
                residual[lo:hi] += estimates[1][:length] * weight
                weights[lo:hi] += weight
                chunk_logs.append(dict(start=lo / rate, end=hi / rate, anchors=anchors))
                print(json.dumps(dict(job=job["id"], processedSeconds=hi / rate, totalSeconds=count / rate)), flush=True)
            if np.any(weights <= 0):
                raise RuntimeError("Chunk assembly left uncovered samples")
            for suffix, samples in [("target", target), ("residual", residual)]:
                sf.write(args.output / f'{job["id"]}-{suffix}.wav', samples / weights, rate, subtype="FLOAT")
            report["jobs"].append(dict(id=job["id"], case=job["case"],
                                      target=f'{job["id"]}-target.wav', residual=f'{job["id"]}-residual.wav',
                                      seconds=round(time.perf_counter() - started, 3),
                                      inputChannels=audio.shape[1], outputChannels=1, chunks=chunk_logs))
            atomic_json(report_path, report)
        if args.device == "cuda":
            report["peakCudaBytes"] = torch.cuda.max_memory_allocated()
        report["status"] = "finished"
    except Exception as error:
        # Avoid storing request headers, tokens, or third-party exception text.
        report.update(status="failed", errorType=type(error).__name__)
        atomic_json(report_path, report)
        raise
    atomic_json(report_path, report)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--model", default="facebook/sam-audio-large")
    parser.add_argument("--revision", default="main")
    parser.add_argument("--device", choices=["cuda", "cpu", "mps"], default="cuda")
    parser.add_argument("--chunk-seconds", type=float, default=20)
    parser.add_argument("--overlap-seconds", type=float, default=4)
    parser.add_argument("--candidates", type=int, default=1)
    parser.add_argument("--seed", type=int, default=731)
    parser.add_argument("--span-mode", choices=["auto", "predict", "none"], default="auto")
    parser.add_argument("--only", nargs="+")
    args = parser.parse_args()
    if args.candidates < 1 or not 0 <= args.overlap_seconds < args.chunk_seconds:
        parser.error("Use positive candidates and 0 <= overlap < chunk size")
    main(args)
