"""Phase 2.1-shaped spike: can Gemini extract a recipe from the video itself?

ADR 0001 established that descriptions are the primary source because captions
are gated behind creator OAuth. It also measured roughly one description in five
carrying nothing usable, which is a dead end for the product today.

The Gemini API accepts a YouTube URL directly as video input — the model watches
and listens; nothing is downloaded here and no scraper is involved. This asks
whether that actually recovers those videos, and at what cost, BEFORE any of it
is designed into the pipeline.

Questions it must answer:
  1. Does it return a usable ingredient list for a video whose description has none?
  2. What does it cost, in tokens and in wall-clock seconds?
  3. Are the quantities real, or does it invent them when the creator was vague?

Throwaway. Nothing imports it.

    uv run --frozen python scripts/spike_video.py 641twGz83nM
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.extract import RESPONSE_SCHEMA

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "scripts" / "spike_output"

# The description prompt's rules, restated for a source that is spoken rather
# than written. Rule 1 matters MORE here, not less: people say "a good glug of
# oil" out loud far more often than they write it, so the pressure to invent a
# number is higher.
PROMPT = """You are extracting a structured recipe by WATCHING a cooking video. \
Use everything: what the cook says, what is shown on screen, and any text \
overlays or on-screen ingredient cards.

Rules, in order of importance:

1. NEVER invent a quantity. If the cook says "to taste", "a good handful", "as \
required", or shows an amount without naming it, set qty to null and put the \
spoken wording in qty_text. A plausible number nobody stated is worse than no \
number. This matters more here than in written text, because speech is vaguer.
2. Prefer an on-screen ingredient card or text overlay over the spoken word when \
they disagree — the card is the creator's considered version.
3. For a range like "8-10 cloves", set qty to the LOWER bound and copy the full \
range into qty_text.
4. qty_text is ONLY for wording a number cannot carry. An exact number leaves it null.
5. Ingredient names in lower case. Keep the English name when both are spoken.
6. Convert Fahrenheit to Celsius. Durations in seconds.
7. Steps are the method in the order performed. Do not invent steps.
8. If this is genuinely not a cooking video, set found_recipe false and return \
empty arrays.
"""


def load_key() -> str:
    for line in (ROOT / ".env").read_text().splitlines():
        if line.startswith("GEMINI_API_KEY="):
            return line.split("=", 1)[1].strip()
    return os.environ.get("GEMINI_API_KEY", "")


async def main() -> int:
    if len(sys.argv) < 2:
        print(f"usage: {sys.argv[0]} VIDEO_ID [VIDEO_ID ...]", file=sys.stderr)
        return 2

    from google import genai
    from google.genai import types

    client = genai.Client(api_key=load_key())
    OUT.mkdir(parents=True, exist_ok=True)

    for video_id in sys.argv[1:]:
        url = f"https://www.youtube.com/watch?v={video_id}"
        print(f"\n=== {video_id} ===")

        config = types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=RESPONSE_SCHEMA,
            temperature=0.0,
            automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
        )

        contents = types.Content(
            parts=[
                types.Part(file_data=types.FileData(file_uri=url, mime_type="video/*")),
                types.Part(text=PROMPT),
            ]
        )

        for model in ("gemini-3.5-flash", "gemini-3.6-flash", "gemini-3.1-flash-lite"):
            t0 = time.monotonic()
            try:
                response = await client.aio.models.generate_content(
                    model=model, contents=contents, config=config
                )
            except Exception as exc:
                print(f"  {model}: {str(exc)[:180]}")
                continue

            elapsed = time.monotonic() - t0
            usage = response.usage_metadata
            data = json.loads((response.text or "{}").strip())

            ings = data.get("ingredients") or []
            steps = data.get("steps") or []
            vague = sum(1 for i in ings if i.get("qty") is None)

            print(f"  model    : {model}")
            print(f"  elapsed  : {elapsed:.1f}s")
            print(
                f"  tokens   : in={getattr(usage, 'prompt_token_count', 0)} "
                f"out={getattr(usage, 'candidates_token_count', 0)}"
            )
            print(f"  found    : {data.get('found_recipe')}")
            print(f"  yield    : {data.get('yield_qty')} {data.get('yield_unit')}")
            print(f"  result   : {len(ings)} ingredients, {len(steps)} steps")
            print(f"  vague qty: {vague}/{len(ings)} left as null (0 would be suspicious)")

            for i in ings[:8]:
                q = i.get("qty")
                qt = i.get("qty_text")
                amount = qt if q is None else f"{q} {i.get('unit') or ''}".strip()
                print(f"      - {amount or '(none)'} {i.get('name')}")
            if len(ings) > 8:
                print(f"      ... {len(ings) - 8} more")

            # Model output is derived structured data, not raw fetched text, but
            # it is written to the gitignored spike directory anyway — CLAUDE.md
            # keeps everything a spike pulls down in one place.
            (OUT / f"video_{video_id}.json").write_text(
                json.dumps(data, indent=2, ensure_ascii=False)
            )
            break

    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
