#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["httpx>=0.28"]
# ///
"""Phase 2.1 — the captions reality check.

THROWAWAY. This script exists to answer a go/no-go question before any product
code is written, and it should be deleted once docs/adr/0001-content-sourcing.md
records the answer. Do not import from it.

It answers, empirically, for each video:

  Q1  Does YouTube Data API v3 `captions.list` return tracks?
  Q2  Does `captions.download` 403 without the video owner's OAuth?
  Q3  Are auto-generated (ASR) captions reachable differently from
      manually-uploaded (standard) ones?
  Q4  How much of the recipe survives in the description alone?

Run:
    uv run scripts/spike_captions.py                     # the built-in video set
    uv run scripts/spike_captions.py VIDEO_ID VIDEO_ID   # any other videos

Requires YOUTUBE_API_KEY in the repo-root .env (see .env.example).

Guardrails, enforced in code below, not merely observed:
  * Official YouTube Data API only. No yt-dlp, no transcript scrapers. If the
    official API cannot do something, that is a FINDING, not an obstacle to
    route around.
  * Nothing fetched is ever written outside scripts/spike_output/, which is
    gitignored. See _write_output().
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Final

import httpx

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------

REPO_ROOT: Final = Path(__file__).resolve().parent.parent
SPIKE_OUTPUT_DIR: Final = REPO_ROOT / "scripts" / "spike_output"
ENV_FILE: Final = REPO_ROOT / ".env"

API_BASE: Final = "https://www.googleapis.com/youtube/v3"
REQUEST_TIMEOUT_S: Final = 30.0

# Documented YouTube Data API v3 quota costs, in units against the default
# 10,000/day budget. captions.* is expensive — that is itself a design
# constraint worth knowing before building on it.
QUOTA_COST: Final[dict[str, int]] = {
    "videos.list": 1,
    "captions.list": 50,
    "captions.download": 200,
}

# The videos under test. Replace or extend freely — that is the whole point of
# keeping this as a list. Each entry is (video_id, human label).
# Selection criteria that matter for a representative answer:
#   - five DIFFERENT creators (caption practice is a per-channel habit)
#   - a mix of channel sizes
#   - a mix of description styles (full recipe in description vs. "link in bio")
DEFAULT_VIDEOS: Final[list[tuple[str, str]]] = [
    ("bUounn_Bmy4", "Your Food Lab — paneer butter masala"),
    ("j3pDXY9fqSo", "aloo paratha"),
    ("sAnPUIvPc1I", "unlabelled #3"),
    ("cRsAQeR5dbI", "unlabelled #4"),
    ("j6VlT_jUVPc", "James Hoffmann"),
]


# --------------------------------------------------------------------------
# Guardrail: the only writer in this file
# --------------------------------------------------------------------------


def _write_output(filename: str, content: str) -> Path:
    """Write to scripts/spike_output/ and nowhere else, ever.

    Descriptions and (if they were ever obtainable) caption bodies are
    third-party copyrighted text. The project rule is that such text is working
    memory, never persisted. This function is the enforcement point: it refuses
    any path that escapes the gitignored spike directory.
    """
    SPIKE_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    root = SPIKE_OUTPUT_DIR.resolve()
    target = (root / filename).resolve()
    if not target.is_relative_to(root):
        raise RuntimeError(
            f"Refusing to write outside {root}: {target}. "
            "Raw fetched text may only ever land in scripts/spike_output/."
        )
    target.write_text(content, encoding="utf-8")
    return target


# --------------------------------------------------------------------------
# Env loading (hand-rolled: a throwaway script should not add python-dotenv)
# --------------------------------------------------------------------------


def load_api_key() -> str:
    if not ENV_FILE.exists():
        _die(
            f"No .env at {ENV_FILE}.\n"
            "  cp .env.example .env  and set YOUTUBE_API_KEY.\n"
            "  Key: console.cloud.google.com -> enable 'YouTube Data API v3'\n"
            "       -> Credentials -> Create credentials -> API key"
        )

    for raw in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        if key.strip() != "YOUTUBE_API_KEY":
            continue
        api_key = value.strip().strip("\"'")
        if not api_key or api_key.startswith("your-"):
            _die("YOUTUBE_API_KEY in .env is empty or still the placeholder.")
        return api_key

    _die("YOUTUBE_API_KEY not found in .env.")


def _die(message: str) -> Any:
    print(f"\n  ERROR: {message}\n", file=sys.stderr)
    raise SystemExit(1)


# --------------------------------------------------------------------------
# Result types
# --------------------------------------------------------------------------


@dataclass
class ApiCall:
    """One HTTP call, recorded verbatim.

    The exact error `reason` is the whole payload of this spike. "403" alone
    does not tell you whether creator OAuth would fix it; `forbidden` vs
    `insufficientPermissions` vs `quotaExceeded` do.
    """

    endpoint: str
    status: int
    ok: bool
    reason: str | None = None
    message: str | None = None
    quota_units: int = 0


@dataclass
class CaptionTrack:
    track_id: str
    language: str | None
    name: str | None
    track_kind: str | None  # "ASR" (auto-generated) | "standard" | "forced"
    audio_track_type: str | None
    is_auto_synced: bool | None
    is_draft: bool | None
    is_cc: bool | None
    status: str | None
    download: ApiCall | None = None

    @property
    def is_auto_generated(self) -> bool:
        return (self.track_kind or "").upper() == "ASR"


@dataclass
class DescriptionAnalysis:
    """Structural signal only — NOT a recall measurement.

    A real answer to Q4 needs the hand-labelled ground truth from Phase 2.2.
    This gives a first-order read plus the raw text so you can judge by eye.
    """

    char_count: int
    line_count: int
    nonempty_line_count: int
    quantity_line_count: int
    bullet_line_count: int
    # Step-like lines by any shape: "1." markers, bullets, or prose under a
    # method header. Counting only numbered steps under-reports badly.
    step_line_count: int
    section_headers_found: list[str]
    recipe_line_share: float
    verdict: str
    raw_path: str | None = None


@dataclass
class VideoResult:
    video_id: str
    label: str
    title: str | None = None
    channel: str | None = None
    published_at: str | None = None
    duration: str | None = None
    # YouTube's own claim, from videos.list contentDetails.caption
    youtube_says_has_captions: bool | None = None
    metadata_call: ApiCall | None = None
    captions_list_call: ApiCall | None = None
    tracks: list[CaptionTrack] = field(default_factory=list)
    description: DescriptionAnalysis | None = None
    errors: list[str] = field(default_factory=list)


# --------------------------------------------------------------------------
# API probes
# --------------------------------------------------------------------------


class YouTube:
    def __init__(self, api_key: str) -> None:
        self._key = api_key
        self._client = httpx.Client(timeout=REQUEST_TIMEOUT_S)
        self.quota_spent = 0

    def close(self) -> None:
        self._client.close()

    def _get(
        self, path: str, params: dict[str, str], cost_key: str
    ) -> tuple[ApiCall, dict[str, Any] | None, str | None]:
        cost = QUOTA_COST.get(cost_key, 0)
        self.quota_spent += cost
        url = f"{API_BASE}/{path}"
        try:
            response = self._client.get(url, params={**params, "key": self._key})
        except httpx.HTTPError as exc:
            return (
                ApiCall(cost_key, 0, False, "transport_error", str(exc), cost),
                None,
                None,
            )

        reason, message = _extract_error(response)
        call = ApiCall(
            endpoint=cost_key,
            status=response.status_code,
            ok=response.is_success,
            reason=reason,
            message=message,
            quota_units=cost,
        )

        if not response.is_success:
            return call, None, None

        content_type = response.headers.get("content-type", "")
        if "json" in content_type:
            return call, response.json(), None
        return call, None, response.text

    def video_metadata(self, video_id: str) -> tuple[ApiCall, dict[str, Any] | None]:
        call, payload, _ = self._get(
            "videos",
            {"part": "snippet,contentDetails,status", "id": video_id},
            "videos.list",
        )
        if payload is None:
            return call, None
        items = payload.get("items") or []
        if not items:
            call.ok = False
            call.reason = "videoNotFound"
            call.message = "videos.list returned zero items — bad ID, private, or removed."
            return call, None
        return call, items[0]

    def captions_list(self, video_id: str) -> tuple[ApiCall, list[dict[str, Any]]]:
        call, payload, _ = self._get(
            "captions", {"part": "snippet", "videoId": video_id}, "captions.list"
        )
        return call, (payload.get("items") or []) if payload else []

    def captions_download(self, track_id: str) -> tuple[ApiCall, str | None]:
        call, _, body = self._get(
            f"captions/{track_id}", {"tfmt": "srt"}, "captions.download"
        )
        return call, body


def _extract_error(response: httpx.Response) -> tuple[str | None, str | None]:
    """Pull Google's structured error reason out of a failed response."""
    if response.is_success:
        return None, None
    try:
        payload = response.json()
    except ValueError:
        return "non_json_error", response.text[:300].strip() or None

    error = payload.get("error")
    if not isinstance(error, dict):
        return "unknown", str(payload)[:300]

    message = error.get("message")
    details = error.get("errors") or []
    reason = details[0].get("reason") if details and isinstance(details[0], dict) else None
    return reason or error.get("status") or "unknown", message


# --------------------------------------------------------------------------
# Q4 — description analysis
# --------------------------------------------------------------------------

_UNITS: Final = (
    r"cups?|c\.|tbsps?|tablespoons?|tsps?|tsss?|teaspoons?|g|gms?|grams?|kgs?|kilograms?|"
    r"mls?|millilitres?|milliliters?|l|litres?|liters?|ozs?|ounces?|lbs?|pounds?|"
    r"cloves?|pinch(?:es)?|handfuls?|cans?|sticks?|slices?|pieces?|bunch(?:es)?|"
    r"sprigs?|dash(?:es)?|quarts?|pints?|gal(?:lons?)?|sachets?|packets?|"
    r"knobs?|splash(?:es)?|drops?|bulbs?|heads?|stalks?|ribs?|fillets?|rashers?|"
    # Units that show up constantly in Indian recipe descriptions, which the
    # first pass of this heuristic missed entirely.
    r"nos?\.?|inch(?:es)?|katoris?|glass(?:es)?|medium(?:\s+sized)?|large|small"
)

# The "ambiguous" unicode below (en dash, curly quote, fraction glyphs) is
# deliberate: these are the characters creators actually type into YouTube
# descriptions, so matching them is the point.

# A number: 2 | 2.5 | 1/2 | 1 1/2 | ½ | 1½ | 2-3
_NUMBER: Final = r"(?:\d+\s*[-–/]\s*\d+|\d+\s+\d+/\d+|\d+(?:[.,]\d+)?|[¼-¾⅐-⅞])"  # noqa: RUF001

# Every bullet glyph seen in the wild, defined once so the matcher and the
# stripper below can never drift apart.
_BULLET_CHARS: Final = r"-•*▢○●◦–—▪·+>"  # noqa: RUF001

QTY_LINE_RE: Final = re.compile(rf"^\W*{_NUMBER}\s*(?:{_UNITS})\b", re.IGNORECASE | re.UNICODE)
# Fallback: a bare leading number followed by a word ("2 eggs", "3 large onions")
BARE_QTY_LINE_RE: Final = re.compile(rf"^\W*{_NUMBER}\s+[a-z]", re.IGNORECASE | re.UNICODE)
BULLET_RE: Final = re.compile(rf"^\s*[{_BULLET_CHARS}]\s+\S")
BULLET_STRIP_RE: Final = re.compile(rf"^\s*[{_BULLET_CHARS}]\s+")
NUMBERED_STEP_RE: Final = re.compile(r"^\s*(?:step\s*)?\d+\s*[.)\]:-]\s+\S", re.IGNORECASE)

INGREDIENT_HEADER_RE: Final = re.compile(
    r"^\W*(ingredients?|shopping list|you(?:'|’)?ll need|what you need|for the\b.*)\W*:?\s*$",  # noqa: RUF001
    re.IGNORECASE,
)
METHOD_HEADER_RE: Final = re.compile(
    r"^\W*(method|directions?|instructions?|steps?|recipe|how to make|preparation|"
    r"process|procedure)\W*:?\s*$",
    re.IGNORECASE,
)

# --- Quantity-last formats -------------------------------------------------
# The first pass of this heuristic only matched a leading quantity and scored a
# 36-ingredient description as "0 quantity lines". Creators overwhelmingly write
# the ingredient first:
#     Oil - 1 tbsp
#     TOMATO | टमाटर 4 NOS.
#     SALT | नमक TO TASTE
#     Aloo - 3
QTY_ANYWHERE_RE: Final = re.compile(rf"{_NUMBER}\s*(?:{_UNITS})\b", re.IGNORECASE | re.UNICODE)
# Vague quantities are still quantities — the plan calls for qty_text: "to taste"
# rather than an invented number, so these lines count as recoverable.
VAGUE_QTY_RE: Final = re.compile(
    r"\b(to taste|as required|as needed|as per taste|for garnish|for roasting|"
    r"for frying|a pinch|to serve|taste hisab se)\b",
    re.IGNORECASE,
)
# "Aloo - 3", "Capsicum - 2", "Beet - ½": separator then a bare number.
TRAILING_BARE_QTY_RE: Final = re.compile(
    rf"^.{{1,45}}?[-|:–—]\s*{_NUMBER}\s*\w{{0,12}}\.?\s*$", re.UNICODE  # noqa: RUF001
)
# Lines that look quantity-ish but are recipe metadata, not ingredients.
METADATA_LINE_RE: Final = re.compile(
    r"^\W*(prep(aration)?|cook(ing)?|total|rest(ing)?|proof(ing)?|chill)?\s*"
    r"(time|serves?|servings?|yield|course|cuisine|difficulty|makes)\b",
    re.IGNORECASE,
)
TIMESTAMP_RE: Final = re.compile(r"^\s*\d{1,2}:\d{2}")
PARENTHETICAL_RE: Final = re.compile(r"\s*\([^)]*\)\s*$")


def _is_noise(line: str) -> bool:
    """Links, socials, hashtags, timestamps — never recipe content."""
    lowered = line.lower()
    return (
        "http" in lowered
        or lowered.startswith("#")
        or bool(TIMESTAMP_RE.match(line))
        or bool(METADATA_LINE_RE.match(line))
    )


def _is_ingredient_line(line: str) -> bool:
    """Does this line carry an ingredient with some notion of quantity?

    Handles quantity-first ("2 cups flour"), quantity-last ("Oil - 1 tbsp",
    "TOMATO | टमाटर 4 NOS."), and vague quantities ("SALT | नमक TO TASTE"),
    because all three are common and only the first was caught originally.
    """
    if _is_noise(line):
        return False
    body = BULLET_STRIP_RE.sub("", line).strip()
    # A parenthetical is a note on the ingredient, not part of it. Stripping it
    # before the length check keeps "11g coffee (a long aside about grind...)"
    # from being discarded as prose.
    body = PARENTHETICAL_RE.sub("", body).strip()
    if not body or len(body) > 110:
        return False
    if QTY_LINE_RE.match(body) or BARE_QTY_LINE_RE.match(body):
        return True
    if QTY_ANYWHERE_RE.search(body):
        return True
    if TRAILING_BARE_QTY_RE.match(body):
        return True
    # "Water as required", "Ghee for roasting" — vague but real, and short
    # enough not to be a sentence of prose.
    return bool(VAGUE_QTY_RE.search(body)) and len(body) <= 60


def _count_method_block(nonempty: list[str], headers_at: list[int]) -> int:
    """Count instruction lines following a method header.

    Many creators write steps as unnumbered prose or bullets, so counting only
    "1." markers reports zero steps for a description with a complete method.
    """
    best = 0
    for start in headers_at:
        count = 0
        for line in nonempty[start + 1 :]:
            stripped = line.strip()
            if _is_noise(stripped) or INGREDIENT_HEADER_RE.match(stripped):
                break
            body = BULLET_STRIP_RE.sub("", stripped).strip()
            if len(body) > 20 and not _is_ingredient_line(stripped):
                count += 1
        best = max(best, count)
    return best


def analyse_description(video_id: str, description: str, dump: bool) -> DescriptionAnalysis:
    normalised = unicodedata.normalize("NFKC", description)
    lines = normalised.splitlines()
    nonempty = [ln.strip() for ln in lines if ln.strip()]

    qty_lines = 0
    bullets = 0
    numbered = 0
    bullet_steps = 0
    headers: list[str] = []
    method_header_indices: list[int] = []

    for index, stripped in enumerate(nonempty):
        if _is_ingredient_line(stripped):
            qty_lines += 1
        if BULLET_RE.match(stripped):
            bullets += 1
            body = BULLET_STRIP_RE.sub("", stripped).strip()
            if len(body) > 20 and not _is_noise(stripped) and not _is_ingredient_line(stripped):
                bullet_steps += 1
        if NUMBERED_STEP_RE.match(stripped):
            numbered += 1
        if INGREDIENT_HEADER_RE.match(stripped):
            headers.append(f"INGREDIENTS::{stripped[:60]}")
        elif METHOD_HEADER_RE.match(stripped):
            headers.append(f"METHOD::{stripped[:60]}")
            method_header_indices.append(index)

    has_ingredient_header = any(h.startswith("INGREDIENTS::") for h in headers)
    has_method_header = bool(method_header_indices)

    # Steps can present as numbers, bullets, or a prose block under a header.
    # Take the strongest signal rather than insisting on one shape.
    steps = max(numbered, bullet_steps, _count_method_block(nonempty, method_header_indices))

    recipe_lines = qty_lines + steps
    share = recipe_lines / len(nonempty) if nonempty else 0.0

    # Deliberately conservative. Over-claiming here would be the single most
    # expensive mistake in this spike: it would justify skipping captions.
    # Ingredient-light, technique-heavy recipes are a real category — coffee,
    # bread, cocktails. A ">= 4 ingredients" floor calls those PARTIAL forever,
    # so a short ingredient list with a long method also qualifies.
    if (qty_lines >= 4 and steps >= 3) or (qty_lines >= 2 and steps >= 5):
        verdict = "FULL_RECIPE"
    elif qty_lines >= 4 or (has_ingredient_header and qty_lines >= 2):
        verdict = "INGREDIENTS_ONLY"
    elif qty_lines >= 1 or has_ingredient_header or has_method_header:
        verdict = "PARTIAL"
    else:
        verdict = "NONE"

    raw_path: str | None = None
    if dump and description.strip():
        path = _write_output(f"{video_id}.description.txt", description)
        raw_path = str(path.relative_to(REPO_ROOT))

    return DescriptionAnalysis(
        char_count=len(description),
        line_count=len(lines),
        nonempty_line_count=len(nonempty),
        quantity_line_count=qty_lines,
        bullet_line_count=bullets,
        step_line_count=steps,
        section_headers_found=headers,
        recipe_line_share=round(share, 3),
        verdict=verdict,
        raw_path=raw_path,
    )


# --------------------------------------------------------------------------
# Orchestration
# --------------------------------------------------------------------------


def probe_video(
    yt: YouTube, video_id: str, label: str, *, limit_tracks: int | None, dump: bool
) -> VideoResult:
    result = VideoResult(video_id=video_id, label=label)

    # --- Q0: does the video exist, and does YouTube claim captions? ---
    meta_call, item = yt.video_metadata(video_id)
    result.metadata_call = meta_call
    if item is None:
        result.errors.append(
            f"videos.list failed ({meta_call.status} {meta_call.reason}): {meta_call.message}"
        )
        return result

    snippet = item.get("snippet") or {}
    content_details = item.get("contentDetails") or {}
    result.title = snippet.get("title")
    result.channel = snippet.get("channelTitle")
    result.published_at = snippet.get("publishedAt")
    result.duration = content_details.get("duration")
    result.youtube_says_has_captions = str(content_details.get("caption", "")).lower() == "true"

    # --- Q1: does captions.list return tracks? ---
    list_call, items = yt.captions_list(video_id)
    result.captions_list_call = list_call
    if not list_call.ok:
        result.errors.append(
            f"captions.list failed ({list_call.status} {list_call.reason}): {list_call.message}"
        )

    for entry in items:
        s = entry.get("snippet") or {}
        result.tracks.append(
            CaptionTrack(
                track_id=entry.get("id", ""),
                language=s.get("language"),
                name=s.get("name") or None,
                track_kind=s.get("trackKind"),
                audio_track_type=s.get("audioTrackType"),
                is_auto_synced=s.get("isAutoSynced"),
                is_draft=s.get("isDraft"),
                is_cc=s.get("isCC"),
                status=s.get("status"),
            )
        )

    # --- Q2 + Q3: attempt download on EVERY track, API key only ---
    # Per-track matters: it is the only way to see whether ASR and standard
    # tracks are gated identically.
    targets = result.tracks if limit_tracks is None else result.tracks[:limit_tracks]
    for track in targets:
        call, body = yt.captions_download(track.track_id)
        track.download = call
        if call.ok and body:
            # Did not expect to get here. If we ever do, the body is copyrighted
            # third-party text: it goes to the gitignored dir and NOWHERE else,
            # and never to stdout.
            path = _write_output(f"{video_id}.{track.track_id}.srt", body)
            call.message = f"DOWNLOAD SUCCEEDED — {len(body)} chars written to {path.name}"

    # --- Q4: description ---
    result.description = analyse_description(video_id, snippet.get("description") or "", dump)
    return result


# --------------------------------------------------------------------------
# Reporting
# --------------------------------------------------------------------------

RULE = "=" * 78
THIN = "-" * 78


def _fmt_call(call: ApiCall | None) -> str:
    if call is None:
        return "not attempted"
    if call.ok:
        return f"HTTP {call.status} OK"
    return f"HTTP {call.status} {call.reason or '?'} — {(call.message or '').strip()[:110]}"


def print_video_report(result: VideoResult, *, show_description: bool) -> None:
    print(f"\n{RULE}")
    print(f"  {result.video_id}   {result.label}")
    print(RULE)

    if result.title:
        print(f"  Title    : {result.title}")
        print(f"  Channel  : {result.channel}")
        print(f"  Published: {result.published_at}    Duration: {result.duration}")
    print(f"  videos.list          : {_fmt_call(result.metadata_call)}")

    if result.youtube_says_has_captions is not None:
        claim = "yes" if result.youtube_says_has_captions else "no"
        print(f"  contentDetails.caption: {claim}   (YouTube's own claim)")

    # Q1
    print(f"\n  [Q1] captions.list   : {_fmt_call(result.captions_list_call)}")
    print(f"       tracks returned : {len(result.tracks)}")
    for track in result.tracks:
        kind = "AUTO (ASR)" if track.is_auto_generated else (track.track_kind or "?")
        flags = []
        if track.is_auto_synced:
            flags.append("autoSynced")
        if track.is_draft:
            flags.append("DRAFT")
        if track.is_cc:
            flags.append("CC")
        suffix = f"  [{', '.join(flags)}]" if flags else ""
        name = f' "{track.name}"' if track.name else ""
        print(f"         - {track.language or '??':<6} {kind:<12}{name}{suffix}")

    # Q2 / Q3
    print("\n  [Q2/Q3] captions.download, API key only, per track:")
    if not result.tracks:
        print("       no tracks to attempt — nothing to download")
    for track in result.tracks:
        kind = "AUTO (ASR)" if track.is_auto_generated else (track.track_kind or "?")
        print(f"       - {track.language or '??':<6} {kind:<12} {_fmt_call(track.download)}")

    # Q4
    d = result.description
    print("\n  [Q4] description analysis:")
    if d is None:
        print("       unavailable")
    else:
        print(f"       verdict            : {d.verdict}")
        print(
            f"       length             : {d.char_count} chars, "
            f"{d.nonempty_line_count} non-blank lines"
        )
        print(f"       quantity-ish lines : {d.quantity_line_count}")
        print(f"       step-like lines    : {d.step_line_count}")
        print(f"       bullet lines       : {d.bullet_line_count}")
        print(f"       recipe line share  : {d.recipe_line_share:.0%}  (heuristic, not recall)")
        if d.section_headers_found:
            print("       section headers    :")
            for header in d.section_headers_found[:8]:
                print(f"                            {header}")
        else:
            print("       section headers    : none found")
        if d.raw_path:
            print(f"       raw description    : {d.raw_path}")

    for err in result.errors:
        print(f"\n  !! {err}")

    if show_description and d is not None and d.raw_path:
        print(f"\n{THIN}")
        print("  RAW DESCRIPTION (verbatim, for manual inspection)")
        print(THIN)
        raw = (REPO_ROOT / d.raw_path).read_text(encoding="utf-8")
        for line in raw.splitlines():
            print(f"  | {line}")
        print(THIN)


def print_summary(results: list[VideoResult], quota_spent: int) -> None:
    print(f"\n\n{RULE}")
    print("  SUMMARY — Phase 2.1 go/no-go")
    print(RULE)

    resolved = [r for r in results if r.title]
    print(f"\n  Videos probed: {len(results)}   resolved: {len(resolved)}")
    print(f"  Estimated quota spent: {quota_spent} units of the 10,000/day default")

    # ---- Q1 ----
    listed = [r for r in resolved if r.captions_list_call and r.captions_list_call.ok]
    with_tracks = [r for r in resolved if r.tracks]
    print("\n  [Q1] Does captions.list return tracks?")
    print(f"       captions.list succeeded : {len(listed)}/{len(resolved)}")
    print(f"       returned >=1 track      : {len(with_tracks)}/{len(resolved)}")
    if resolved and not listed:
        reasons = {
            r.captions_list_call.reason
            for r in resolved
            if r.captions_list_call and not r.captions_list_call.ok
        }
        print(f"       ANSWER: NO — every call failed. reasons: {sorted(filter(None, reasons))}")
    elif len(with_tracks) < len(listed):
        print("       ANSWER: PARTIAL — the call succeeds but some videos list zero tracks.")
    elif listed:
        print("       ANSWER: YES")

    # ---- Q2 ----
    downloads = [t.download for r in results for t in r.tracks if t.download]
    ok_downloads = [c for c in downloads if c.ok]
    print("\n  [Q2] Does captions.download 403 without owner OAuth?")
    if not downloads:
        print("       INCONCLUSIVE — no tracks were listed, so nothing could be attempted.")
    else:
        by_status: dict[str, int] = {}
        for call in downloads:
            key = f"{call.status} {call.reason or ''}".strip()
            by_status[key] = by_status.get(key, 0) + 1
        for key, count in sorted(by_status.items(), key=lambda kv: -kv[1]):
            print(f"       {count:>3} x  {key}")
        if not ok_downloads:
            print(
                f"       ANSWER: YES — 0/{len(downloads)} track downloads "
                "succeeded with an API key alone."
            )
        else:
            print(
                f"       ANSWER: NO — {len(ok_downloads)}/{len(downloads)} "
                "succeeded. Investigate before relying on it."
            )

    # ---- Q3 ----
    asr = [t for r in results for t in r.tracks if t.is_auto_generated]
    std = [t for r in results for t in r.tracks if not t.is_auto_generated]
    print("\n  [Q3] Are ASR captions reachable differently from manual ones?")
    print(f"       ASR tracks seen      : {len(asr)}")
    print(f"       standard tracks seen : {len(std)}")

    def _outcomes(tracks: list[CaptionTrack]) -> set[str]:
        return {
            f"{t.download.status} {t.download.reason or ''}".strip()
            for t in tracks
            if t.download
        }

    asr_out, std_out = _outcomes(asr), _outcomes(std)
    print(f"       ASR download outcomes      : {sorted(asr_out) or 'none attempted'}")
    print(f"       standard download outcomes : {sorted(std_out) or 'none attempted'}")
    if not asr or not std:
        print("       ANSWER: INCONCLUSIVE — need both kinds present to compare.")
    elif asr_out == std_out:
        print("       ANSWER: NO — both kinds are gated identically.")
    else:
        print("       ANSWER: YES — the two kinds behave differently. This is significant.")

    # ---- Q4 ----
    print("\n  [Q4] How much recipe is in the description alone?")
    tally: dict[str, int] = {}
    for r in resolved:
        if r.description:
            tally[r.description.verdict] = tally.get(r.description.verdict, 0) + 1
    for verdict in ("FULL_RECIPE", "INGREDIENTS_ONLY", "PARTIAL", "NONE"):
        count = tally.get(verdict, 0)
        bar = "#" * count
        print(f"       {verdict:<18} {count}/{len(resolved)}  {bar}")
    usable = tally.get("FULL_RECIPE", 0) + tally.get("INGREDIENTS_ONLY", 0)
    if resolved:
        print(
            f"       ANSWER: {usable}/{len(resolved)} descriptions carry a usable ingredient list."
        )
    print("       NOTE: heuristic only. Real recall needs the Phase 2.2 hand-labelled set.")

    print(f"\n{RULE}\n")


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------


def replay_q4() -> int:
    """Re-analyse cached descriptions offline. Zero API calls, zero quota."""
    cached = sorted(SPIKE_OUTPUT_DIR.glob("*.description.txt"))
    if not cached:
        _die(
            f"No cached descriptions in {SPIKE_OUTPUT_DIR}.\n"
            "  Run a live pass first: uv run scripts/spike_captions.py"
        )
        return 1

    labels = dict(DEFAULT_VIDEOS)
    print(RULE)
    print("  Q4 REPLAY — cached descriptions, no API calls")
    print(RULE)
    tally: dict[str, int] = {}
    for path in cached:
        video_id = path.name.removesuffix(".description.txt")
        analysis = analyse_description(video_id, path.read_text(encoding="utf-8"), dump=False)
        tally[analysis.verdict] = tally.get(analysis.verdict, 0) + 1
        print(
            f"  {video_id:<12} {analysis.verdict:<17} "
            f"qty={analysis.quantity_line_count:<3} steps={analysis.step_line_count:<3} "
            f"share={analysis.recipe_line_share:>4.0%}   {labels.get(video_id, '')}"
        )

    print(f"\n  {'verdict':<18} count")
    for verdict in ("FULL_RECIPE", "INGREDIENTS_ONLY", "PARTIAL", "NONE"):
        print(f"  {verdict:<18} {tally.get(verdict, 0)}")
    print(f"{RULE}\n")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Phase 2.1 captions reality check (throwaway spike).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "video_ids",
        nargs="*",
        help="YouTube video IDs. Defaults to DEFAULT_VIDEOS in this file.",
    )
    parser.add_argument(
        "--limit-tracks",
        type=int,
        default=None,
        metavar="N",
        help="Attempt download on at most N tracks per video (each costs 200 quota units).",
    )
    parser.add_argument(
        "--no-print-description",
        action="store_true",
        help="Suppress the verbatim description dump in stdout (files are still written).",
    )
    parser.add_argument(
        "--replay-q4",
        action="store_true",
        help=(
            "Re-run only the Q4 description analysis against descriptions already "
            "cached in scripts/spike_output/. No API calls, no quota. Use this to "
            "iterate on the heuristic — a full live run costs ~1,500 units."
        ),
    )
    args = parser.parse_args()

    if args.replay_q4:
        return replay_q4()

    videos: list[tuple[str, str]]
    if args.video_ids:
        videos = [(vid, "(from argv)") for vid in args.video_ids]
    elif DEFAULT_VIDEOS:
        videos = DEFAULT_VIDEOS
    else:
        _die(
            "No videos to test.\n"
            "  Either pass IDs:  uv run scripts/spike_captions.py ID1 ID2 ID3\n"
            "  or populate DEFAULT_VIDEOS near the top of this file."
        )
        return 1

    api_key = load_api_key()

    print(RULE)
    print("  MISE — Phase 2.1 captions reality check")
    print(f"  {datetime.now(UTC).isoformat(timespec='seconds')}")
    print(f"  {len(videos)} video(s), official YouTube Data API v3 only")
    print(RULE)

    yt = YouTube(api_key)
    results: list[VideoResult] = []
    try:
        for video_id, label in videos:
            result = probe_video(
                yt,
                video_id,
                label,
                limit_tracks=args.limit_tracks,
                dump=True,
            )
            results.append(result)
            print_video_report(result, show_description=not args.no_print_description)
    finally:
        yt.close()

    print_summary(results, yt.quota_spent)

    payload = {
        "generated_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "quota_units_spent": yt.quota_spent,
        "videos": [asdict(r) for r in results],
    }
    out = _write_output("results.json", json.dumps(payload, indent=2, ensure_ascii=False))
    print(f"  Machine-readable results: {out.relative_to(REPO_ROOT)}")
    print("  (scripts/spike_output/ is gitignored — nothing here enters the repo)\n")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
