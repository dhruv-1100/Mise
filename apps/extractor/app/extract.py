"""Stage 3 of the extraction pipeline: normalized text in, structured recipe out.

The LLM is reached through `LlmProvider`, never directly, so everything below —
prompt construction, range handling, name cleanup, schema validation — is
tested offline against `FakeProvider`.

The mapping from raw model output to `Recipe` is not a formality. A probe
against a real description produced output that violated the contract in three
distinct ways on the first attempt, and each is corrected here rather than
hoped away in the prompt:

1. "8-10 CLOVES" came back as qty=null with unit="cloves". The schema rejects a
   unit without a quantity, correctly — a unit alone measures nothing.
2. qty_text was echoed for exact quantities ("4"), when it exists only to
   preserve wording a number cannot carry.
3. Names arrived shouted, because the source description shouts them.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Any

from app.llm import LlmProvider, LlmResponse
from app.schema import (
    Creator,
    ExtractionInsufficient,
    ExtractionOk,
    Ingredient,
    InsufficientReason,
    Recipe,
    SourceKind,
    Step,
    Yield,
)

#: Kept deliberately flat. Gemini's structured-output support covers a subset of
#: JSON Schema, and nested $ref or anyOf is where it stops being reliable.
RESPONSE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "found_recipe": {"type": "boolean"},
        "ingredients": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "qty": {"type": "number", "nullable": True},
                    "qty_text": {"type": "string", "nullable": True},
                    "unit": {"type": "string", "nullable": True},
                    "prep": {"type": "string", "nullable": True},
                    "optional": {"type": "boolean"},
                },
                "required": ["name", "optional"],
            },
        },
        "steps": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "text": {"type": "string"},
                    "duration_s": {"type": "integer", "nullable": True},
                    "temp_c": {"type": "number", "nullable": True},
                },
                "required": ["text"],
            },
        },
        "yield_qty": {"type": "number", "nullable": True},
        "yield_text": {"type": "string", "nullable": True},
        "yield_unit": {"type": "string", "nullable": True},
        "equipment": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["found_recipe", "ingredients", "steps", "equipment"],
}

PROMPT_TEMPLATE = """You are extracting a structured recipe from the description \
text of a cooking video. The description is the creator's own writing.

Rules, in order of importance:

1. NEVER invent a quantity. If the text says "to taste", "a good handful", or \
"as required", set qty to null and copy the exact wording into qty_text. A \
plausible number that nobody wrote down is worse than no number.
2. For a range like "8-10 cloves", set qty to the LOWER bound and copy the full \
range into qty_text. Do not average it.
3. qty_text is ONLY for wording a number cannot carry. If the quantity is an \
exact number, leave qty_text null.
4. Write ingredient names in lower case, however the source capitalises them. \
Keep the English name when the text gives one alongside another script.
5. Convert Fahrenheit to Celsius. Give durations in seconds.
6. Steps are the method in order. Do not invent steps that are not described.
7. If this description does not contain a real recipe — it is only a link, a \
sales pitch, or a list of links — set found_recipe to false and return empty \
arrays. That is a correct answer, not a failure.

TITLE: {title}

DESCRIPTION:
{description}
"""

_RANGE_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*[-–—]\s*(\d+(?:\.\d+)?)\s*$")


def build_prompt(title: str, description: str) -> str:
    return PROMPT_TEMPLATE.format(title=title, description=description)


def _clean_name(name: str) -> str:
    """Undo shouting without destroying deliberate capitalisation.

    Source descriptions frequently write ingredients in full caps. Lowercasing
    only fully-uppercase names leaves "Kashmiri chilli" and "MSG" alone.
    """
    stripped = name.strip()
    if len(stripped) > 3 and stripped.isupper():
        return stripped.lower()
    return stripped


def _coerce_quantity(
    qty: float | None, qty_text: str | None, unit: str | None
) -> tuple[float | None, str | None, str | None]:
    """Reconcile the three quantity fields into something the schema accepts.

    Returns (qty, qty_text, unit).
    """
    text = qty_text.strip() if isinstance(qty_text, str) and qty_text.strip() else None
    unit = unit.strip() if isinstance(unit, str) and unit.strip() else None

    # A range the model left in qty_text: take the lower bound so the recipe can
    # still be scaled, and keep the original wording so nothing is lost.
    if qty is None and text is not None:
        match = _RANGE_RE.match(text)
        if match is not None:
            qty = float(match.group(1))

    # qty_text echoing an exact number carries no information the number does
    # not already carry.
    if qty is not None and text is not None:
        try:
            if float(text) == float(qty):
                text = None
        except ValueError:
            pass

    # Schema invariant: a unit without a quantity measures nothing. The wording
    # is the honest carrier here, so fold the unit into it and clear it.
    if qty is None and unit is not None:
        text = f"{text} {unit}".strip() if text else unit
        unit = None

    return qty, text, unit


def _to_ingredient(raw: dict[str, Any]) -> Ingredient | None:
    name = _clean_name(str(raw.get("name") or ""))
    if not name:
        return None
    qty, qty_text, unit = _coerce_quantity(raw.get("qty"), raw.get("qty_text"), raw.get("unit"))
    prep = raw.get("prep")
    return Ingredient(
        name=name,
        qty=qty,
        qty_text=qty_text,
        unit=unit,
        prep=prep.strip() if isinstance(prep, str) and prep.strip() else None,
        optional=bool(raw.get("optional", False)),
        source=SourceKind.DESCRIPTION,
        # Description-sourced extraction of a stated quantity is high-confidence;
        # a quantity we had to interpret is not. Calibrated against the Phase 2.2
        # eval set once it exists.
        confidence=0.9 if qty is not None else 0.6,
    )


def _to_steps(raw_steps: list[dict[str, Any]]) -> list[Step]:
    steps: list[Step] = []
    for raw in raw_steps:
        text = str(raw.get("text") or "").strip()
        if not text:
            continue
        duration = raw.get("duration_s")
        temp = raw.get("temp_c")
        steps.append(
            Step(
                # Indices are assigned here, never taken from the model. The
                # schema requires them contiguous from 1, and that is our
                # invariant to keep rather than the model's to remember.
                index=len(steps) + 1,
                text=text,
                duration_s=int(duration) if isinstance(duration, int | float) else None,
                temp_c=float(temp) if isinstance(temp, int | float) else None,
                source=SourceKind.DESCRIPTION,
            )
        )
    return steps


def _to_yield(data: dict[str, Any]) -> Yield | None:
    qty = data.get("yield_qty")
    text = data.get("yield_text")
    unit = data.get("yield_unit")
    if qty is None and not text:
        return None
    return Yield(
        qty=float(qty) if isinstance(qty, int | float) else None,
        qty_text=text.strip() if isinstance(text, str) and text.strip() else None,
        unit=(unit or "serving").strip() or "serving",
    )


def to_result(
    response: LlmResponse,
    *,
    video_id: str,
    title: str,
    creator: Creator,
) -> ExtractionOk | ExtractionInsufficient:
    """Map raw model output onto the contract, or explain why there is no recipe."""
    data = response.data

    ingredients = [
        ing for raw in data.get("ingredients", []) if (ing := _to_ingredient(raw)) is not None
    ]

    # An empty ingredient list is the answer, not an error. ADR 0001 measured
    # one description in five carrying no recipe at all.
    if not data.get("found_recipe") or not ingredients:
        return ExtractionInsufficient(
            status="insufficient_source_material",
            video_id=video_id,
            reason=(
                InsufficientReason.NO_INGREDIENTS_FOUND
                if data.get("found_recipe")
                else InsufficientReason.DESCRIPTION_IS_LINK_ONLY
            ),
            sources_tried=[SourceKind.DESCRIPTION],
        )

    recipe = Recipe(
        video_id=video_id,
        title=title,
        creator=creator,
        ingredients=ingredients,
        steps=_to_steps(data.get("steps", [])),
        recipe_yield=_to_yield(data),
        equipment=[e.strip() for e in data.get("equipment", []) if str(e).strip()],
        sources=[SourceKind.DESCRIPTION],
        conflicts=[],
        extracted_at=datetime.now(UTC),
    )
    return ExtractionOk(status="ok", recipe=recipe)


async def extract_recipe(
    provider: LlmProvider,
    *,
    video_id: str,
    title: str,
    creator: Creator,
    description: str,
) -> tuple[ExtractionOk | ExtractionInsufficient, LlmResponse]:
    """Run the LLM extraction stage.

    `description` must already have been through `normalize.normalize_description`.
    Returns the result and the raw response, so the caller can record tokens
    against the Phase 7 cost-per-extraction metric.
    """
    response = await provider.complete_json(
        prompt=build_prompt(title, description),
        schema=RESPONSE_SCHEMA,
        temperature=0.0,
    )
    return to_result(response, video_id=video_id, title=title, creator=creator), response
