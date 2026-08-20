"""Scoring extraction against hand-labelled ground truth.

Pure functions, no I/O — `scripts/eval.py` supplies the data and prints the
table. Separated so the metrics themselves are unit-tested, which matters more
than it might seem: a metric that is subtly wrong produces a number that looks
authoritative and is worthless, and nothing downstream can tell.

The five metrics are BUILD_PLAN.md §2.2's, plus refusal handling that the plan
does not mention but ADR 0001 forces — roughly one video in five carries no
recipe, and a system that invents one for those is far worse than one that
misses an ingredient.
"""

from __future__ import annotations

import difflib
import re
import unicodedata
from dataclasses import dataclass, field

from app.units import UnitKind, canonicalise

# --- Ingredient name matching ---------------------------------------------
#
# The hard part of this whole file. Ground truth says "tomato", the model says
# "chopped tomatoes"; those are the same ingredient. Entity resolution would
# settle it properly, but that is a later phase and it would be circular to
# evaluate extraction using a component tuned on the same data.
#
# So: deterministic normalisation, then token overlap, then a similarity
# fallback. The threshold is explicit and tunable because it directly moves
# recall — too loose inflates it by matching unrelated ingredients, too strict
# deflates it by splitting genuine matches. It is a stated assumption, not a
# hidden one.

SIMILARITY_THRESHOLD = 0.82

#: Words that describe preparation or form rather than identity. "chopped
#: tomatoes" and "tomatoes" are the same thing to a shopping list.
#: Words describing preparation or size, not identity. "chopped tomatoes" and
#: "tomatoes" are the same thing to a shopping list.
#:
#: Note what is deliberately NOT here: powder, paste, leaves, seeds, oil. Those
#: change what the ingredient IS — coriander powder is not coriander leaves, and
#: treating them as noise silently merged the two.
_MODIFIERS = frozenset(
    [
        "chopped",
        "diced",
        "sliced",
        "minced",
        "grated",
        "crushed",
        "whole",
        "fresh",
        "dried",
        "frozen",
        "finely",
        "roughly",
        "thinly",
        "thickly",
        "small",
        "large",
        "medium",
        "big",
        "cut",
        "halved",
        "quartered",
        "peeled",
        "washed",
        "cleaned",
        "boiled",
        "cooked",
        "raw",
        "ripe",
        "unripe",
        "hot",
        "cold",
        "warm",
        "room",
        "temperature",
        "soaked",
        "drained",
        "rinsed",
        "beaten",
        "whisked",
        "melted",
        "softened",
        "pieces",
        "piece",
        "cubes",
        "cubed",
        "strips",
        "optional",
        "garnish",
        "garnishing",
        "serving",
        "taste",
        "needed",
        "required",
    ]
)

#: Tokens that define the FORM an ingredient takes. Two names whose form tokens
#: disagree are different ingredients however much else they share.
_FORM_TOKENS = frozenset(
    [
        "powder",
        "powdered",
        "paste",
        "puree",
        "leaf",
        "leave",
        "seed",
        "sauce",
        "oil",
        "extract",
        "juice",
        "flake",
        "ground",
        "syrup",
        "vinegar",
        "stock",
        "essence",
    ]
)

_PLURAL_EXCEPTIONS = {"molasses", "asafoetida", "greens", "oats", "peas", "chives"}


def _strip_accents(text: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", text) if not unicodedata.combining(c))


def _singular(word: str) -> str:
    if word in _PLURAL_EXCEPTIONS or len(word) <= 3:
        return word
    if word.endswith("ies"):
        return word[:-3] + "y"
    if word.endswith("oes"):
        # tomatoes -> tomato, potatoes -> potato. Without this the generic
        # "-es" rule below produced "tomatoe".
        return word[:-2]
    if word.endswith("es") and word[-3:-2] in ("s", "x", "z", "h"):
        return word[:-2]
    if word.endswith("s"):
        return word[:-1]
    return word


def normalise_name(name: str) -> frozenset[str]:
    """Reduce an ingredient name to the tokens that carry its identity."""
    text = _strip_accents(name.lower())
    text = re.sub(r"\(.*?\)", " ", text)  # parenthetical notes
    text = re.sub(r"[^a-z0-9\s]", " ", text)
    tokens = {_singular(t) for t in text.split() if t and t not in _MODIFIERS}
    return frozenset(t for t in tokens if len(t) > 1)


def names_match(a: str, b: str) -> bool:
    """Do these two ingredient names refer to the same thing?"""
    ta, tb = normalise_name(a), normalise_name(b)
    if not ta or not tb:
        return False
    if ta == tb:
        return True

    # Disagreeing form beats any amount of shared vocabulary: coriander powder
    # is not coriander leaves, and chilli is not chilli powder.
    if (ta & _FORM_TOKENS) != (tb & _FORM_TOKENS):
        return False

    # Jaccard, not overlap-over-the-smaller-set. The latter scores 1.0 whenever
    # a one-word name appears inside a longer one, which matched "butter" to
    # "peanut butter".
    union = ta | tb
    if union and len(ta & tb) / len(union) >= 0.6:
        return True

    return (
        difflib.SequenceMatcher(None, " ".join(sorted(ta)), " ".join(sorted(tb))).ratio()
        >= SIMILARITY_THRESHOLD
    )


# --- Quantity comparison ---------------------------------------------------


def quantities_match(
    qty_a: float | None,
    unit_a: str | None,
    qty_b: float | None,
    unit_b: str | None,
    *,
    tolerance: float = 0.02,
) -> bool:
    """Do two quantities express the same amount?

    Compares canonical grams or millilitres when both sides convert, so
    "500 g" and "0.5 kg" agree. Falls back to comparing the raw number and unit
    when they do not — a count of 4 cloves is not convertible and should not be
    penalised for it.
    """
    if qty_a is None and qty_b is None:
        return True
    if qty_a is None or qty_b is None:
        return False

    ca, cb = canonicalise(qty_a, unit_a), canonicalise(qty_b, unit_b)
    if ca.is_canonical and cb.is_canonical:
        left = ca.grams if ca.grams is not None else ca.millilitres
        right = cb.grams if cb.grams is not None else cb.millilitres
        if left is None or right is None or ca.kind is not cb.kind:
            return False
        return abs(left - right) <= tolerance * max(left, right)

    # Not convertible on at least one side: require the same number and the
    # same unit family.
    if abs(qty_a - qty_b) > tolerance * max(abs(qty_a), abs(qty_b), 1e-9):
        return False
    if ca.kind is UnitKind.UNKNOWN or cb.kind is UnitKind.UNKNOWN:
        return (unit_a or "").strip().lower() == (unit_b or "").strip().lower()
    return ca.kind is cb.kind


# --- Step ordering ---------------------------------------------------------


def kendall_tau(order: list[int]) -> float:
    """Kendall tau of a permutation against the identity ordering.

    Hand-rolled rather than pulling in scipy: the lists are a handful of steps
    long, so an O(n^2) count is instant and the package stays lean.

    Returns 1.0 for perfect order, -1.0 for exactly reversed, and 1.0 for
    fewer than two elements — with nothing to misorder, nothing is misordered.
    """
    n = len(order)
    if n < 2:
        return 1.0
    concordant = discordant = 0
    for i in range(n):
        for j in range(i + 1, n):
            if order[i] < order[j]:
                concordant += 1
            elif order[i] > order[j]:
                discordant += 1
    total = concordant + discordant
    if total == 0:
        return 1.0
    return (concordant - discordant) / total


def step_order_tau(predicted: list[str], truth: list[str]) -> float | None:
    """Kendall tau of predicted step order against the labelled order.

    Steps are matched on text similarity. Returns None when fewer than two
    steps match, because a tau over one point is not a measurement.
    """
    matched: list[int] = []
    used: set[int] = set()
    for pred in predicted:
        best_i, best_score = None, 0.0
        for i, true in enumerate(truth):
            if i in used:
                continue
            score = difflib.SequenceMatcher(None, pred.lower(), true.lower()).ratio()
            if score > best_score:
                best_i, best_score = i, score
        if best_i is not None and best_score >= 0.5:
            matched.append(best_i)
            used.add(best_i)
    return kendall_tau(matched) if len(matched) >= 2 else None


# --- Per-video scoring -----------------------------------------------------


@dataclass
class IngredientScore:
    true_count: int
    predicted_count: int
    matched: int
    quantity_correct: int
    missed: list[str] = field(default_factory=list)
    spurious: list[str] = field(default_factory=list)

    @property
    def recall(self) -> float:
        return self.matched / self.true_count if self.true_count else 1.0

    @property
    def precision(self) -> float:
        return self.matched / self.predicted_count if self.predicted_count else 1.0

    @property
    def quantity_accuracy(self) -> float:
        return self.quantity_correct / self.matched if self.matched else 1.0


def score_ingredients(predicted: list[dict], truth: list[dict]) -> IngredientScore:
    """Greedy one-to-one match between predicted and labelled ingredients.

    Greedy rather than optimal assignment: with a good name matcher the two
    agree almost always, and an exact Hungarian match would add a dependency
    and obscure where a mismatch actually came from.
    """
    used: set[int] = set()
    matched = quantity_correct = 0
    missed: list[str] = []

    for true in truth:
        found = None
        for i, pred in enumerate(predicted):
            if i in used:
                continue
            if names_match(str(pred.get("name", "")), str(true.get("name", ""))):
                found = i
                break
        if found is None:
            missed.append(str(true.get("name", "")))
            continue
        used.add(found)
        matched += 1
        if quantities_match(
            predicted[found].get("qty"),
            predicted[found].get("unit"),
            true.get("qty"),
            true.get("unit"),
        ):
            quantity_correct += 1

    spurious = [str(p.get("name", "")) for i, p in enumerate(predicted) if i not in used]
    return IngredientScore(
        true_count=len(truth),
        predicted_count=len(predicted),
        matched=matched,
        quantity_correct=quantity_correct,
        missed=missed,
        spurious=spurious,
    )
