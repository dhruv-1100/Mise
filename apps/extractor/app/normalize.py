"""Stage 2 of the extraction pipeline: clean the description before the LLM sees it.

Pure function, no I/O. Takes raw description text and returns cleaned text plus
what was removed and why.

Why this stage earns its place: across the five real descriptions sampled in the
Phase 2.1 spike, 28% of non-blank lines contained a URL and roughly half were
noise of some kind — affiliate links, social handles, chapter markers, music
credits. Sending that to an LLM costs money per token and actively degrades
extraction, because "Knives I use - https://amzn.to/..." reads like an
ingredient line to a model that is looking for ingredient lines.

The raw text passing through here is third-party copyrighted material. It is
working memory: it is never returned to a caller that persists it, never
logged, and never written to disk outside `scripts/spike_output/`. See
CLAUDE.md.

Bias throughout: **dropping a real ingredient is far worse than keeping a noise
line.** Rules that could plausibly match recipe content check for recipe
content first and decline to fire.
"""

import re
import unicodedata
from dataclasses import dataclass
from enum import StrEnum


class DropReason(StrEnum):
    """Why a line was removed. Recorded so the stage is auditable rather than magic."""

    CHAPTER_MARKER = "chapter_marker"
    URL = "url"
    EMAIL = "email"
    DECORATIVE = "decorative"
    HASHTAGS = "hashtags"
    SOCIAL_CALL_TO_ACTION = "social_call_to_action"
    SPONSOR = "sponsor"
    MUSIC_CREDIT = "music_credit"
    APP_PROMO = "app_promo"
    STOREFRONT = "storefront"


@dataclass(frozen=True)
class Chapter:
    """A creator-authored chapter marker.

    Kept rather than discarded: chapters are the creator's own segmentation of
    their method, which is a useful prior for step extraction.
    """

    offset_s: int
    label: str


@dataclass(frozen=True)
class RemovedLine:
    reason: DropReason
    text: str


@dataclass(frozen=True)
class NormalizedDescription:
    text: str
    chapters: tuple[Chapter, ...]
    removed: tuple[RemovedLine, ...]
    original_line_count: int
    kept_line_count: int

    @property
    def reduction(self) -> float:
        """Fraction of non-blank lines removed. A Phase 7 metric."""
        if self.original_line_count == 0:
            return 0.0
        return 1 - (self.kept_line_count / self.original_line_count)


# --- Patterns --------------------------------------------------------------

URL_RE = re.compile(r"https?://|www\.\w+\.\w+", re.IGNORECASE)
EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+")

# "00:00 Intro", "1:45 Base gravy", "01:02:03 Plating"
CHAPTER_RE = re.compile(r"^\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s+(\S.*)$")

# A line with no letters or digits at all: "***********", "-----", "🔪🔪🔪"
DECORATIVE_RE = re.compile(r"^[^\w]*$", re.UNICODE)

HASHTAG_RE = re.compile(r"#\w+")

SOCIAL_RE = re.compile(
    r"\b(subscribe|follow (?:me|us)|following me|hit the bell|like and share|"
    r"instagram|facebook|twitter|pinterest|tumblr|linkedin|patreon|tiktok|"
    r"business (?:enquir|inquir)|check out my|link in (?:bio|description))\b",
    re.IGNORECASE,
)

SPONSOR_RE = re.compile(
    r"\b(sponsor(?:ed|ship)?(?:\s+by)?|thanks to .{1,40} for sponsoring|"
    r"use (?:my )?code|discount code|promo code|affiliate|paid partnership|"
    r"ad\b|#ad\b)\b",
    re.IGNORECASE,
)

MUSIC_RE = re.compile(
    r"\b(music (?:by|from|credit)|epidemic sound|hooksounds|artlist|soundtrack|"
    r"song(?:s)? used)\b",
    re.IGNORECASE,
)

APP_PROMO_RE = re.compile(
    r"\b(download (?:the |my |our )?(?:android |ios )?app|play\.google|itunes|"
    r"app store|available on the app)\b",
    re.IGNORECASE,
)

STOREFRONT_RE = re.compile(
    r"\b(amazon|amzn|my (?:kitchen )?(?:gear|kit|store|shop)|items i use|"
    r"products i use|things i use|gear i use|shop the|storefront|"
    r"\w+ i use\s*[-:])\b",
    re.IGNORECASE,
)

# --- Recipe-content guard --------------------------------------------------

_UNITS = (
    r"cups?|tbsps?|tablespoons?|tsps?|teaspoons?|g|gms?|grams?|kgs?|ml|l|litres?|liters?|"
    r"ozs?|ounces?|lbs?|pounds?|cloves?|pinch(?:es)?|handfuls?|cans?|sticks?|slices?|"
    r"nos?\.?|inch(?:es)?|sprigs?|bunch(?:es)?|dash(?:es)?"
)
_NUMBER = r"(?:\d+\s*[-–/]\s*\d+|\d+\s+\d+/\d+|\d+(?:[.,]\d+)?|[¼-¾⅐-⅞])"

QUANTITY_RE = re.compile(rf"{_NUMBER}\s*(?:{_UNITS})\b", re.IGNORECASE)
VAGUE_QTY_RE = re.compile(
    r"\b(to taste|as required|as needed|a pinch|to serve|for garnish)\b", re.IGNORECASE
)
SECTION_HEADER_RE = re.compile(
    r"^\W*(ingredients?|method|directions?|instructions?|steps?|process|procedure|"
    r"for the\b.*|prep(?:aration)? time|cook(?:ing)? time|serves?|yield)\W*:?\s*$",
    re.IGNORECASE,
)


def looks_like_recipe_content(line: str) -> bool:
    """Would a cook recognise this line as part of the recipe?

    Used as a veto on the rules that could plausibly misfire. It deliberately
    does not veto URL or email removal: an ingredient line does not contain a
    link, and "Deghi mirch powder - better colour - https://amzn.to/..." is an
    affiliate line that happens to name a spice.
    """
    stripped = line.strip()
    if not stripped:
        return False
    return bool(
        QUANTITY_RE.search(stripped)
        or VAGUE_QTY_RE.search(stripped)
        or SECTION_HEADER_RE.match(stripped)
    )


# Rules that fire regardless of content, because content cannot coexist with them.
_HARD_RULES: tuple[tuple[DropReason, re.Pattern[str]], ...] = (
    (DropReason.URL, URL_RE),
    (DropReason.EMAIL, EMAIL_RE),
)

# Rules that decline to fire on anything resembling recipe content.
_SOFT_RULES: tuple[tuple[DropReason, re.Pattern[str]], ...] = (
    (DropReason.SPONSOR, SPONSOR_RE),
    (DropReason.APP_PROMO, APP_PROMO_RE),
    (DropReason.STOREFRONT, STOREFRONT_RE),
    (DropReason.MUSIC_CREDIT, MUSIC_RE),
    (DropReason.SOCIAL_CALL_TO_ACTION, SOCIAL_RE),
)


# Vulgar fractions, expanded with a leading space so "1½" becomes "1 1/2"
# rather than "11/2". U+2044 FRACTION SLASH is included because NFKC emits it.
_FRACTIONS = {
    "½": " 1/2",
    "⅓": " 1/3",
    "⅔": " 2/3",
    "¼": " 1/4",
    "¾": " 3/4",
    "⅕": " 1/5",
    "⅖": " 2/5",
    "⅗": " 3/5",
    "⅘": " 4/5",
    "⅙": " 1/6",
    "⅚": " 5/6",
    "⅐": " 1/7",
    "⅛": " 1/8",
    "⅜": " 3/8",
    "⅝": " 5/8",
    "⅞": " 7/8",
    "⅑": " 1/9",
    "⅒": " 1/10",
    "↉": " 0/3",
}

_MULTI_SPACE_RE = re.compile(r"[ \t]{2,}")


def _expand_fractions(text: str) -> str:
    for glyph, ascii_form in _FRACTIONS.items():
        text = text.replace(glyph, ascii_form)
    text = text.replace("⁄", "/")
    # The inserted spaces can double up an existing one.
    return _MULTI_SPACE_RE.sub(" ", text)


def _parse_chapter(line: str) -> Chapter | None:
    match = CHAPTER_RE.match(line)
    if match is None:
        return None
    hours, minutes, seconds = match.group(1), match.group(2), match.group(3)
    offset = int(minutes) * 60 + int(seconds)
    if hours is not None:
        offset += int(hours) * 3600
    return Chapter(offset_s=offset, label=match.group(4).strip())


def _is_mostly_hashtags(line: str) -> bool:
    tags = HASHTAG_RE.findall(line)
    if not tags:
        return False
    without = HASHTAG_RE.sub("", line).strip()
    # "#YFL #SanjyotKeer #paneerbuttermasala" is a tag block; "2 tbsp oil #tip"
    # is a recipe line with a tag stuck on the end.
    return len(without) <= 3


def _classify(line: str) -> DropReason | None:
    """Return the reason this line should be dropped, or None to keep it."""
    stripped = line.strip()

    if DECORATIVE_RE.match(stripped):
        return DropReason.DECORATIVE

    for reason, pattern in _HARD_RULES:
        if pattern.search(stripped):
            return reason

    if _is_mostly_hashtags(stripped):
        return DropReason.HASHTAGS

    if looks_like_recipe_content(stripped):
        return None

    for reason, pattern in _SOFT_RULES:
        if pattern.search(stripped):
            return reason

    return None


def normalize_description(raw: str) -> NormalizedDescription:
    """Strip noise from a video description.

    Returns the cleaned text, the creator's chapter markers as structured data,
    and a record of every removal.
    """
    # Fractions first, before NFKC gets to them. NFKC decomposes "1½" to
    # "11⁄2", which then reads as eleven halves rather than one and a half —
    # a silent corruption of exactly the field this pipeline is measured on.
    # Expanding to " 1/2" instead yields "1 1/2", which is how recipes write it.
    text = _expand_fractions(raw)

    # Creators style headers with mathematical-alphanumeric and fullwidth
    # characters ("𝗔𝗠𝗔𝗭𝗢𝗡"). NFKC folds those to plain ASCII so the patterns
    # here and the LLM both see ordinary words.
    text = unicodedata.normalize("NFKC", text)

    kept: list[str] = []
    chapters: list[Chapter] = []
    removed: list[RemovedLine] = []
    original_nonblank = 0

    for line in text.splitlines():
        stripped = line.strip()

        if not stripped:
            # Collapse runs of blank lines; paragraph breaks carry structure the
            # LLM can use, but six of them do not.
            if kept and kept[-1] != "":
                kept.append("")
            continue

        original_nonblank += 1

        chapter = _parse_chapter(stripped)
        if chapter is not None:
            chapters.append(chapter)
            removed.append(RemovedLine(DropReason.CHAPTER_MARKER, stripped))
            continue

        reason = _classify(stripped)
        if reason is not None:
            removed.append(RemovedLine(reason, stripped))
            continue

        kept.append(stripped)

    while kept and kept[-1] == "":
        kept.pop()

    return NormalizedDescription(
        text="\n".join(kept),
        chapters=tuple(chapters),
        removed=tuple(removed),
        original_line_count=original_nonblank,
        kept_line_count=sum(1 for line in kept if line),
    )
