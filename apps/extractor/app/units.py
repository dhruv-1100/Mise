"""Stage 4 of the extraction pipeline: canonicalise units.

Pure function, no I/O. Takes a quantity and the unit as the creator wrote it,
and returns a canonical form: grams for mass, millilitres for volume.

Deliberately does **not** convert volume to mass. A cup of flour and a cup of
honey differ by more than a factor of two, so that conversion needs a
per-ingredient density table and belongs after entity resolution, not here.
Guessing it would manufacture exactly the false precision the schema exists to
prevent.

Unit vocabulary was taken from the descriptions cached by the Phase 2.1 spike
rather than from imagination: tbsp and tsp dominate, followed by bare counts
("4 NOS."), dimensions ("1 INCH ginger"), then ml, g, cups and cloves.
"""

from dataclasses import dataclass
from enum import StrEnum


class UnitKind(StrEnum):
    """What sort of measurement this is, which decides what can be done with it."""

    MASS = "mass"
    VOLUME = "volume"
    #: Countable things: "4 nos", "2 cloves", "1 can".
    COUNT = "count"
    #: Imprecise by nature: "a pinch", "a handful". Carries no canonical value.
    VAGUE = "vague"
    #: A physical size rather than an amount: "1 inch ginger".
    DIMENSION = "dimension"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class CanonicalQuantity:
    """A quantity with its canonical value attached where one exists."""

    qty: float | None
    unit: str | None
    kind: UnitKind
    #: Populated only for MASS.
    grams: float | None = None
    #: Populated only for VOLUME.
    millilitres: float | None = None
    #: Conversions that required picking a convention. Surfaced, never hidden.
    assumptions: tuple[str, ...] = ()

    @property
    def is_canonical(self) -> bool:
        return self.grams is not None or self.millilitres is not None


# --- Conversion tables -----------------------------------------------------
#
# Every alias observed in the spike output, plus the obvious variants. Keys are
# lowercased and stripped of trailing periods before lookup.

_MASS_TO_GRAMS: dict[str, float] = {
    "g": 1.0,
    "gm": 1.0,
    "gms": 1.0,
    "gram": 1.0,
    "grams": 1.0,
    "gramme": 1.0,
    "grammes": 1.0,
    "kg": 1000.0,
    "kgs": 1000.0,
    "kilo": 1000.0,
    "kilos": 1000.0,
    "kilogram": 1000.0,
    "kilograms": 1000.0,
    "mg": 0.001,
    "milligram": 0.001,
    "milligrams": 0.001,
    "oz": 28.349523125,
    "ozs": 28.349523125,
    "ounce": 28.349523125,
    "ounces": 28.349523125,
    "lb": 453.59237,
    "lbs": 453.59237,
    "pound": 453.59237,
    "pounds": 453.59237,
}

# US customary. See _AMBIGUOUS_VOLUME below — this choice is not neutral.
_VOLUME_TO_ML: dict[str, float] = {
    "ml": 1.0,
    "mls": 1.0,
    "millilitre": 1.0,
    "millilitres": 1.0,
    "milliliter": 1.0,
    "milliliters": 1.0,
    "cc": 1.0,
    "l": 1000.0,
    "litre": 1000.0,
    "litres": 1000.0,
    "liter": 1000.0,
    "liters": 1000.0,
    "tsp": 4.92892159375,
    "tsps": 4.92892159375,
    "teaspoon": 4.92892159375,
    "teaspoons": 4.92892159375,
    "tbsp": 14.78676478125,
    "tbsps": 14.78676478125,
    "tablespoon": 14.78676478125,
    "tablespoons": 14.78676478125,
    "cup": 236.5882365,
    "cups": 236.5882365,
    "fl oz": 29.5735295625,
    "floz": 29.5735295625,
    "fluid ounce": 29.5735295625,
    "fluid ounces": 29.5735295625,
    "pint": 473.176473,
    "pints": 473.176473,
    "quart": 946.352946,
    "quarts": 946.352946,
    "gallon": 3785.411784,
    "gallons": 3785.411784,
}

#: Units whose size depends on where the creator is. The conversion above picks
#: US customary; these are the ones where that choice materially changes the
#: answer, and the assumption is recorded on every quantity that uses one.
_AMBIGUOUS_VOLUME: dict[str, str] = {
    "cup": "US cup (236.6 ml); a metric cup is 250 ml and an imperial cup 284 ml",
    "cups": "US cup (236.6 ml); a metric cup is 250 ml and an imperial cup 284 ml",
    "tbsp": "US tablespoon (14.8 ml); an Australian tablespoon is 20 ml",
    "tbsps": "US tablespoon (14.8 ml); an Australian tablespoon is 20 ml",
    "tablespoon": "US tablespoon (14.8 ml); an Australian tablespoon is 20 ml",
    "tablespoons": "US tablespoon (14.8 ml); an Australian tablespoon is 20 ml",
}

_COUNT_UNITS: frozenset[str] = frozenset(
    {
        "no",
        "nos",
        "number",
        "numbers",
        "piece",
        "pieces",
        "pc",
        "pcs",
        "clove",
        "cloves",
        "can",
        "cans",
        "tin",
        "tins",
        "stick",
        "sticks",
        "slice",
        "slices",
        "sprig",
        "sprigs",
        "bunch",
        "bunches",
        "head",
        "heads",
        "stalk",
        "stalks",
        "rib",
        "ribs",
        "bulb",
        "bulbs",
        "fillet",
        "fillets",
        "rasher",
        "rashers",
        "sheet",
        "sheets",
        "packet",
        "packets",
        "sachet",
        "sachets",
        "ball",
        "balls",
        "whole",
        "medium",
        "large",
        "small",
    }
)

#: Imprecise by nature. These carry no canonical value, and inventing one for
#: them would be exactly the false precision the schema forbids.
_VAGUE_UNITS: frozenset[str] = frozenset(
    {
        "pinch",
        "pinches",
        "handful",
        "handfuls",
        "dash",
        "dashes",
        "splash",
        "splashes",
        "glug",
        "glugs",
        "knob",
        "knobs",
        "drop",
        "drops",
        "sprinkle",
        "squeeze",
        "squeezes",
        "katori",
        "katoris",
        "glass",
        "glasses",
        "bowl",
        "bowls",
        "scoop",
        "scoops",
    }
)

_DIMENSION_UNITS: frozenset[str] = frozenset(
    {
        "inch",
        "inches",
        "in",
        "cm",
        "centimetre",
        "centimetres",
        "centimeter",
        "centimeters",
        "mm",
        "foot",
        "feet",
    }
)


def _key(unit: str) -> str:
    return unit.strip().lower().rstrip(".").strip()


def classify_unit(unit: str | None) -> UnitKind:
    """What kind of measurement is this unit?"""
    if unit is None:
        return UnitKind.COUNT

    key = _key(unit)
    if not key:
        return UnitKind.COUNT
    if key in _MASS_TO_GRAMS:
        return UnitKind.MASS
    if key in _VOLUME_TO_ML:
        return UnitKind.VOLUME
    if key in _COUNT_UNITS:
        return UnitKind.COUNT
    if key in _VAGUE_UNITS:
        return UnitKind.VAGUE
    if key in _DIMENSION_UNITS:
        return UnitKind.DIMENSION
    return UnitKind.UNKNOWN


def canonicalise(qty: float | None, unit: str | None) -> CanonicalQuantity:
    """Attach a canonical gram or millilitre value where one can be derived.

    A vague quantity (`qty is None`) stays vague. An unrecognised unit is
    reported as UNKNOWN rather than guessed at, so it shows up in the eval set
    as a missing alias instead of a wrong number.
    """
    kind = classify_unit(unit)

    if qty is None:
        return CanonicalQuantity(qty=None, unit=unit, kind=UnitKind.VAGUE)

    if kind is UnitKind.MASS:
        key = _key(unit or "")
        return CanonicalQuantity(qty=qty, unit=unit, kind=kind, grams=qty * _MASS_TO_GRAMS[key])

    if kind is UnitKind.VOLUME:
        key = _key(unit or "")
        assumptions = ()
        if key in _AMBIGUOUS_VOLUME:
            assumptions = (f"Assumed {_AMBIGUOUS_VOLUME[key]}.",)
        return CanonicalQuantity(
            qty=qty,
            unit=unit,
            kind=kind,
            millilitres=qty * _VOLUME_TO_ML[key],
            assumptions=assumptions,
        )

    return CanonicalQuantity(qty=qty, unit=unit, kind=kind)
