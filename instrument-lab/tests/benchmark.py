"""Run all supplied fixture WAVs blind, then evaluate against held-out labels.

Usage: .venv/bin/python tests/benchmark.py FIXTURE_FOLDER CATALOG_JSON OUTPUT_FOLDER
No truth filename or isolated source is ever passed to the analysis subprocess.
"""

import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from evaluate import evaluate


def main(fixtures, catalog, output):
    output.mkdir(parents=True, exist_ok=True)
    labels = sorted(fixtures.glob("*-truth.json"))
    if not labels:
        raise ValueError("Generate fixtures first; no evaluation labels were found.")
    analyzer = Path(__file__).parents[1] / "analysis/analyze.py"

    def run(label):
        name = label.name.removesuffix("-truth.json")
        folder = output / name
        folder.mkdir(exist_ok=True)
        start = time.perf_counter()
        with (folder / "analysis.log").open("w") as log:
            subprocess.run(
                [
                    sys.executable,
                    str(analyzer),
                    "--input",
                    str(fixtures / (name + ".wav")),
                    "--output",
                    str(folder),
                    "--catalog",
                    str(catalog),
                ],
                check=True,
                stdout=log,
                stderr=log,
                env={
                    **os.environ,
                    "OPENBLAS_NUM_THREADS": "1",
                    "VECLIB_MAXIMUM_THREADS": "1",
                },
            )
        result = json.loads((folder / "result.json").read_text())
        metrics = evaluate(result, json.loads(label.read_text()))
        metrics["seconds"] = round(time.perf_counter() - start, 2)
        return name, metrics

    results = {}
    with ThreadPoolExecutor(max_workers=2) as workers:
        for future in as_completed([workers.submit(run, label) for label in labels]):
            name, metrics = future.result()
            results[name] = metrics
            (output / "metrics.json").write_text(json.dumps(results, indent=2))
            print(
                json.dumps(
                    dict(
                        recording=name,
                        instruments=metrics["instruments"],
                        expected=metrics["expectedInstruments"],
                        f1=metrics["f1"],
                        seconds=metrics["seconds"],
                    )
                ),
                flush=True,
            )


if __name__ == "__main__":
    main(*(Path(p).resolve() for p in sys.argv[1:4]))
