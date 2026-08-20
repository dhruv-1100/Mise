"""Turn a list of video IDs into ground-truth stubs to hand-label.

    uv run python scripts/build_eval_set.py --ids ../../eval_videos.txt

For each video this fetches the description (1 quota unit), writes the cleaned
text somewhere you can read while labelling, and emits a JSON stub with the
metadata already filled in and the recipe left empty for you.

Two rules shaped this:

1. **The stub contains no predictions.** It would be easy to pre-fill it with the
   model's own extraction and let you correct that — and it would destroy the
   eval. Ground truth derived from the output being measured cannot measure it;
   every miss the model makes becomes a miss you agree with. So the recipe
   fields come out empty and you fill them from the video.
2. **Descriptions are never committed.** They are third-party copyrighted text,
   so the cleaned copies land in `scripts/spike_output/eval/`, which is
   gitignored. Only your labels are committed. `eval.py` re-fetches at run time,
   which costs 1 quota unit per video against a 10,000/day budget.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.normalize import normalize_description
from app.youtube import FetchError, YouTubeFetcher, parse_video_id

REPO_ROOT = Path(__file__).resolve().parents[3]
LABELS_DIR = REPO_ROOT / "apps" / "extractor" / "tests" / "fixtures" / "eval"
SCRATCH_DIR = REPO_ROOT / "scripts" / "spike_output" / "eval"


def stub(video_id: str, title: str, creator: str) -> dict:
    return {
        "video_id": video_id,
        "title": title,
        "creator": creator,
        "_instructions": (
            "Fill ingredients and steps from the VIDEO, not from any model output. "
            "Set expect to 'insufficient' if the description carries no usable "
            "recipe. Use qty: null with qty_text for vague amounts — never invent a "
            "number. Delete this field when done."
        ),
        "expect": "ok",
        "ingredients": [
            {
                "name": "",
                "qty": None,
                "qty_text": None,
                "unit": None,
                "prep": None,
                "optional": False,
            }
        ],
        "steps": [{"index": 1, "text": ""}],
        "yield": {"qty": None, "unit": "serving"},
        "equipment": [],
    }


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ids", type=Path, help="File of video IDs or URLs, one per line.")
    parser.add_argument("videos", nargs="*", help="Video IDs or URLs.")
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Replace stubs that already exist. Off by default so labelling is never lost.",
    )
    args = parser.parse_args()

    raw = list(args.videos)
    if args.ids:
        raw += [
            line.strip()
            for line in args.ids.read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.startswith("#")
        ]
    if not raw:
        parser.error("give video IDs, or --ids pointing at a file of them")

    key = os.environ.get("YOUTUBE_API_KEY", "")
    if not key:
        print("ERROR: YOUTUBE_API_KEY is not set. `set -a; . .env; set +a`", file=sys.stderr)
        return 1

    LABELS_DIR.mkdir(parents=True, exist_ok=True)
    SCRATCH_DIR.mkdir(parents=True, exist_ok=True)

    fetcher = YouTubeFetcher(key)
    written = skipped = failed = 0
    try:
        for entry in raw:
            try:
                video_id = parse_video_id(entry)
                meta = await fetcher.fetch(video_id)
            except FetchError as exc:
                print(f"  FAIL  {entry[:48]:<48} {exc.failure.value}")
                failed += 1
                continue

            cleaned = normalize_description(meta.description)
            (SCRATCH_DIR / f"{video_id}.txt").write_text(
                f"{meta.title}\n{meta.channel_title}\n{'-' * 70}\n{cleaned.text}\n",
                encoding="utf-8",
            )

            target = LABELS_DIR / f"{video_id}.json"
            if target.exists() and not args.overwrite:
                print(f"  keep  {video_id}  {meta.channel_title[:28]:<28} (already labelled)")
                skipped += 1
                continue

            target.write_text(
                json.dumps(
                    stub(video_id, meta.title, meta.channel_title), indent=2, ensure_ascii=False
                )
                + "\n",
                encoding="utf-8",
            )
            hint = "looks empty — likely 'insufficient'" if cleaned.kept_line_count < 5 else ""
            print(
                f"  stub  {video_id}  {meta.channel_title[:28]:<28} "
                f"{cleaned.kept_line_count:>3} usable lines  {hint}"
            )
            written += 1
    finally:
        await fetcher.aclose()

    print(f"\n{written} stubs written, {skipped} kept, {failed} failed")
    print(f"  label these : {LABELS_DIR.relative_to(REPO_ROOT)}")
    print(f"  read these  : {SCRATCH_DIR.relative_to(REPO_ROOT)}  (gitignored)")
    print(f"  quota spent : {len(raw)} units of 10,000/day")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
