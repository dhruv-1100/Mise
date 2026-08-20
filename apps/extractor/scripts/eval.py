"""Run the extraction pipeline over the labelled eval set and print the table.

    uv run python scripts/eval.py                 # everything labelled
    uv run python scripts/eval.py --limit 5       # a cheap smoke run
    uv run python scripts/eval.py --json out.json # for the nightly CI job

Reads ground truth from tests/fixtures/eval/, re-fetches each description at
run time (1 quota unit each), and scores with app/evaluation.py.

Descriptions are never committed, so the set travels as ids plus labels and the
text is fetched fresh. That costs 50 units of a 10,000/day budget and keeps
third-party copyrighted text out of the repository.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import statistics
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.evaluation import IngredientScore, score_ingredients, step_order_tau
from app.llm import GeminiProvider, LlmError
from app.pipeline import run_pipeline
from app.schema import ExtractionOk
from app.youtube import FetchError, YouTubeFetcher

LABELS_DIR = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "eval"

#: Phase 2 exit criteria, from BUILD_PLAN.md §2.2.
GATE_RECALL = 0.90
GATE_QUANTITY = 0.85


@dataclass
class VideoResult:
    video_id: str
    creator: str = ""
    expected: str = "ok"
    actual: str = ""
    ingredients: IngredientScore | None = None
    step_tau: float | None = None
    schema_valid: bool = True
    error: str = ""
    tokens: int = 0

    @property
    def refusal_correct(self) -> bool:
        return (self.expected == "insufficient") == (self.actual != "ok")

    @property
    def hallucinated(self) -> bool:
        """Produced a recipe for a video whose ground truth says there is none.

        The worst error this system can make, and the reason `expect` exists on
        every label.
        """
        return self.expected == "insufficient" and self.actual == "ok"


def is_labelled(data: dict) -> bool:
    """Has a human actually filled this stub in?"""
    if "_instructions" in data:
        return False
    if data.get("expect") == "insufficient":
        return True
    ings = data.get("ingredients") or []
    return any(str(i.get("name", "")).strip() for i in ings)


def load_labels(limit: int | None) -> list[dict]:
    labelled, stubs = [], 0
    for path in sorted(LABELS_DIR.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        if is_labelled(data):
            labelled.append(data)
        else:
            stubs += 1
    if stubs:
        print(f"  note: {stubs} stub(s) not yet labelled — skipped\n", file=sys.stderr)
    return labelled[:limit] if limit else labelled


async def evaluate(labels: list[dict]) -> list[VideoResult]:
    fetcher = YouTubeFetcher(os.environ["YOUTUBE_API_KEY"])
    provider = GeminiProvider(os.environ["GEMINI_API_KEY"])
    results: list[VideoResult] = []
    try:
        for i, truth in enumerate(labels, 1):
            vid = truth["video_id"]
            r = VideoResult(
                video_id=vid,
                creator=truth.get("creator", ""),
                expected=truth.get("expect", "ok"),
            )
            print(f"  [{i:>2}/{len(labels)}] {vid}  {r.creator[:24]:<24}", end="", flush=True)
            try:
                out = await run_pipeline(fetcher=fetcher, provider=provider, video_id=vid)
            except (FetchError, LlmError) as exc:
                r.error = f"{type(exc).__name__}: {exc}"
                r.actual = "error"
                r.schema_valid = False
                print(f"  ERROR {exc}")
                results.append(r)
                continue

            r.actual = out.result.status
            r.tokens = out.stats.total_tokens

            if isinstance(out.result, ExtractionOk):
                recipe = out.result.recipe
                r.ingredients = score_ingredients(
                    [
                        {"name": ing.name, "qty": ing.qty, "unit": ing.unit}
                        for ing in recipe.ingredients
                    ],
                    truth.get("ingredients") or [],
                )
                r.step_tau = step_order_tau(
                    [s.text for s in recipe.steps],
                    [str(s.get("text", "")) for s in (truth.get("steps") or [])],
                )
                print(
                    f"  recall={r.ingredients.recall:.2f} "
                    f"prec={r.ingredients.precision:.2f} "
                    f"qty={r.ingredients.quantity_accuracy:.2f}"
                )
            else:
                mark = "correct" if r.refusal_correct else "WRONG"
                print(f"  refused ({out.result.reason.value}) — {mark}")
            results.append(r)
    finally:
        await fetcher.aclose()
    return results


def report(results: list[VideoResult]) -> dict:
    extracted = [r for r in results if r.ingredients is not None]
    expected_refusals = [r for r in results if r.expected == "insufficient"]
    hallucinations = [r for r in results if r.hallucinated]
    taus = [r.step_tau for r in extracted if r.step_tau is not None]

    def mean(xs: list[float]) -> float | None:
        """None, not 0.0, when there is nothing to average.

        Reporting 0.000 for "no videos were extracted" reads as total failure
        and is really an absence of data. The distinction matters most exactly
        when the set is small or skewed toward refusals.
        """
        return statistics.fmean(xs) if xs else None

    summary = {
        "videos": len(results),
        "extracted": len(extracted),
        "errors": sum(1 for r in results if r.actual == "error"),
        "ingredient_recall": mean([r.ingredients.recall for r in extracted]),
        "ingredient_precision": mean([r.ingredients.precision for r in extracted]),
        "quantity_accuracy": mean([r.ingredients.quantity_accuracy for r in extracted]),
        "step_ordering_tau": mean(taus) if taus else None,
        "structural_validity": mean([1.0 if r.schema_valid else 0.0 for r in results]),
        "refusal_accuracy": mean([1.0 if r.refusal_correct else 0.0 for r in results]),
        # Recorded so the nightly job can tell "we got worse" from "we scored
        # fewer videos this run".
        "scored_videos": len(extracted),
        "hallucinations": len(hallucinations),
        "expected_refusals": len(expected_refusals),
        "total_tokens": sum(r.tokens for r in results),
    }

    w = 26
    print(f"\n{'=' * 62}\n  EXTRACTION EVAL — {len(results)} videos\n{'=' * 62}")
    for label, key, gate in (
        ("Ingredient recall", "ingredient_recall", GATE_RECALL),
        ("Ingredient precision", "ingredient_precision", None),
        ("Quantity accuracy", "quantity_accuracy", GATE_QUANTITY),
        ("Structural validity", "structural_validity", None),
        ("Refusal accuracy", "refusal_accuracy", None),
    ):
        v = summary[key]
        if v is None:
            print(f"  {label:<{w}}{'-':>7}   (no data)")
            continue
        flag = "" if gate is None else ("  PASS" if v >= gate else f"  FAIL (gate {gate:.2f})")
        print(f"  {label:<{w}}{v:>7.3f}{flag}")
    tau = summary["step_ordering_tau"]
    print(
        f"  {'Step ordering (Kendall tau)':<{w}}"
        + (f"{tau:>7.3f}" if tau is not None else "      —")
    )

    print(f"\n  {'Videos extracted':<{w}}{len(extracted):>7}")
    print(f"  {'Expected refusals':<{w}}{len(expected_refusals):>7}")
    print(
        f"  {'Hallucinated recipes':<{w}}{len(hallucinations):>7}"
        + ("   <-- invented a recipe where there is none" if hallucinations else "")
    )
    print(f"  {'Errors':<{w}}{summary['errors']:>7}")
    print(f"  {'Tokens':<{w}}{summary['total_tokens']:>7}")

    worst = sorted(extracted, key=lambda r: r.ingredients.recall)[:5]
    if worst:
        print("\n  Worst recall:")
        for r in worst:
            missed = ", ".join(r.ingredients.missed[:4]) or "-"
            print(
                f"    {r.video_id}  {r.ingredients.recall:.2f}  "
                f"{r.creator[:20]:<20} missed: {missed}"
            )

    recall, quantity = summary["ingredient_recall"], summary["quantity_accuracy"]
    if recall is None or quantity is None:
        gates_pass = False
        verdict = "INSUFFICIENT DATA — no video produced a recipe to score"
    else:
        gates_pass = recall >= GATE_RECALL and quantity >= GATE_QUANTITY
        verdict = "PASS" if gates_pass else "NOT MET"
    print(f"\n  Phase 2 exit gate: {verdict}")
    print(f"{'=' * 62}\n")
    summary["gates_pass"] = gates_pass
    return summary


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--limit", type=int, help="Only evaluate the first N labelled videos.")
    ap.add_argument("--json", type=Path, help="Write the summary here, for the nightly job.")
    ap.add_argument(
        "--fail-under-gate",
        action="store_true",
        help="Exit non-zero when the Phase 2 gates are not met.",
    )
    args = ap.parse_args()

    for key in ("YOUTUBE_API_KEY", "GEMINI_API_KEY"):
        if not os.environ.get(key):
            print(f"ERROR: {key} is not set. `set -a; . ../../.env; set +a`", file=sys.stderr)
            return 1

    labels = load_labels(args.limit)
    if not labels:
        print("No labelled videos yet. Fill in tests/fixtures/eval/*.json first.", file=sys.stderr)
        print(
            "Generate stubs with: uv run python scripts/build_eval_set.py --ids <file>",
            file=sys.stderr,
        )
        return 1

    print(f"Evaluating {len(labels)} labelled video(s)\n")
    summary = report(await evaluate(labels))

    if args.json:
        args.json.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
        print(f"  summary written to {args.json}")

    return 1 if args.fail_under_gate and not summary["gates_pass"] else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
