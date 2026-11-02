"""Check model access and runtime without downloading weights or exposing tokens."""

import argparse
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import platform
import urllib.error
import urllib.request


def preflight(model):
    hf_root = Path(os.environ.get("HF_HOME", Path.home() / ".cache/huggingface"))
    token = os.environ.get("HF_TOKEN")
    token_path = Path(os.environ.get("HF_TOKEN_PATH", hf_root / "token"))
    if not token and token_path.is_file():
        token = token_path.read_text().strip()
    report = dict(checkedAt=datetime.now(timezone.utc).isoformat(), model=model,
                  platform=platform.system(), architecture=platform.machine(),
                  authenticationAvailable=bool(token), modelDownloaded=False,
                  modelAccess=None, samAudioInstalled=importlib.util.find_spec("sam_audio") is not None)
    request = urllib.request.Request(
        f"https://huggingface.co/{model}/resolve/main/config.json", method="HEAD",
        headers={"Authorization": "Bearer " + token} if token else {})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            report["modelAccess"] = {"status": response.status, "accessible": True}
    except urllib.error.HTTPError as error:
        report["modelAccess"] = dict(status=error.code, accessible=False, error=error.headers.get("X-Error-Code"))
    except urllib.error.URLError:
        report["modelAccess"] = dict(accessible=False, error="network-unavailable")
    if importlib.util.find_spec("torch"):
        import torch
        report.update(torchVersion=torch.__version__, cuda=torch.cuda.is_available(),
                      mps=bool(hasattr(torch.backends, "mps") and torch.backends.mps.is_available()))
        if report["cuda"]:
            report["gpu"] = torch.cuda.get_device_name()
            report["gpuMemoryBytes"] = torch.cuda.get_device_properties(0).total_memory
    else:
        report.update(torchVersion=None, cuda=False, mps=None)
    report["readyForCudaBenchmark"] = bool(report["modelAccess"]["accessible"] and report["cuda"] and report["samAudioInstalled"])
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", choices=["facebook/sam-audio-large", "facebook/sam-audio-small", "facebook/sam-audio-base"], default="facebook/sam-audio-large")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    report = preflight(args.model)
    text = json.dumps(report, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text)
    print(text, end="")
