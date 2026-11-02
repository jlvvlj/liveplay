"""Evaluate a finished analysis; ground truth never enters the analyzer."""

import json
import sys
from pathlib import Path
import numpy as np
from scipy.optimize import linear_sum_assignment


def matches(predicted, truth, tolerance=0.05, with_offsets=False):
    used = set()
    errors = []
    offsets = []
    for note in sorted(predicted, key=lambda n: n["start"]):
        options = [
            (abs(note["start"] - n["start"]), i)
            for i, n in enumerate(truth)
            if n["pitch"] == note["pitch"] and i not in used
        ]
        if options and min(options)[0] <= tolerance:
            error, index = min(options)
            used.add(index)
            errors.append(error)
            offsets.append(abs(note["end"] - truth[index]["end"]))
    return (len(used), errors, offsets) if with_offsets else (len(used), errors)


def evaluate(result, truth):
    counts = np.array(
        [
            [matches(p["notes"], t["notes"])[0] for t in truth["parts"]]
            for p in result["parts"]
        ]
    )
    rows, columns = linear_sum_assignment(-counts)
    tp = 0
    details = []
    for i, j in zip(rows, columns):
        p = result["parts"][i]
        t = truth["parts"][j]
        correct, errors, offsets = matches(p["notes"], t["notes"], with_offsets=True)
        tp += correct
        precision = correct / max(1, len(p["notes"]))
        recall = correct / len(t["notes"])
        details.append(
            dict(
                part=p["id"],
                expected=t["name"],
                notes=len(p["notes"]),
                expectedNotes=len(t["notes"]),
                correct=correct,
                precision=round(precision, 4),
                recall=round(recall, 4),
                meanOnsetErrorMs=(
                    round(float(np.mean(errors)) * 1000, 2) if errors else None
                ),
                meanOffsetErrorMs=(
                    round(float(np.mean(offsets)) * 1000, 2) if offsets else None
                ),
                patch=p["patch"],
                truthPatch=t["patch"],
            )
        )
    predicted = sum(len(p["notes"]) for p in result["parts"])
    expected = sum(len(t["notes"]) for t in truth["parts"])
    return dict(
        instruments=len(result["parts"]),
        expectedInstruments=len(truth["parts"]),
        precision=round(tp / max(predicted, 1), 4),
        recall=round(tp / max(expected, 1), 4),
        f1=round(2 * tp / max(1, predicted + expected), 4),
        parts=details,
    )


if __name__ == "__main__":
    result = json.loads(Path(sys.argv[1]).read_text())
    truth = json.loads(Path(sys.argv[2]).read_text())
    print(json.dumps(evaluate(result, truth), indent=2))
