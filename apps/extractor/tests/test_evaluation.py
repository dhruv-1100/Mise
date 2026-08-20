"""Tests for the eval metrics.

These matter more than their size suggests. Every accuracy number this project
reports, the Phase 2 exit gate, and the nightly regression job all read off
these functions — and a metric that is quietly wrong yields a number that looks
authoritative while measuring nothing.

The name matcher gets the most attention because it is the one with a tunable
threshold, and the threshold moves recall directly.
"""

import pytest

from app.evaluation import (
    kendall_tau,
    names_match,
    normalise_name,
    quantities_match,
    score_ingredients,
    step_order_tau,
)


class TestNameMatching:
    @pytest.mark.parametrize(
        ("a", "b"),
        [
            ("tomato", "tomato"),
            ("Tomato", "tomato"),
            ("tomatoes", "tomato"),
            ("chopped tomatoes", "tomato"),
            ("paneer, cubed", "paneer"),
            ("finely chopped onion", "onions"),
            ("fresh coriander leaves", "coriander leaves"),
            ("whole wheat flour", "wheat flour"),
            ("ginger garlic paste", "ginger-garlic paste"),
            ("green chilli (slit)", "green chillies"),
        ],
    )
    def test_the_same_ingredient_written_differently_matches(self, a, b):
        assert names_match(a, b)

    @pytest.mark.parametrize(
        ("a", "b"),
        [
            ("salt", "sugar"),
            ("onion", "garlic"),
            ("coriander leaves", "coriander powder"),
            ("green chilli", "red chilli powder"),
            ("milk", "buttermilk"),
            ("butter", "peanut butter"),
        ],
    )
    def test_different_ingredients_do_not_match(self, a, b):
        # Over-matching silently inflates recall, which is the failure mode
        # that would make this whole eval useless.
        assert not names_match(a, b)

    def test_a_shared_generic_token_is_not_enough(self):
        # "powder" alone must not join two unrelated spices.
        assert not names_match("baking powder", "chilli powder")

    def test_empty_names_never_match(self):
        assert not names_match("", "tomato")
        assert not names_match("   ", "")

    def test_modifiers_are_stripped_from_identity(self):
        assert normalise_name("finely chopped fresh tomatoes") == normalise_name("tomato")


class TestQuantityMatching:
    @pytest.mark.parametrize(
        ("qa", "ua", "qb", "ub"),
        [
            (500, "g", 500, "g"),
            (500, "g", 0.5, "kg"),
            (1, "l", 1000, "ml"),
            (1, "cup", 16, "tbsp"),
            (3, "tsp", 1, "tbsp"),
            (4, "cloves", 4, "clove"),
        ],
    )
    def test_equivalent_amounts_match(self, qa, ua, qb, ub):
        assert quantities_match(qa, ua, qb, ub)

    @pytest.mark.parametrize(
        ("qa", "ua", "qb", "ub"),
        [
            (500, "g", 400, "g"),
            (1, "cup", 1, "tbsp"),
            (2, "tsp", 3, "tsp"),
            (500, "g", 500, "ml"),  # mass vs volume is not the same amount
            (4, None, 5, None),
        ],
    )
    def test_different_amounts_do_not_match(self, qa, ua, qb, ub):
        assert not quantities_match(qa, ua, qb, ub)

    def test_two_vague_quantities_agree(self):
        # Both said "to taste". That is agreement, not a miss.
        assert quantities_match(None, None, None, None)

    def test_a_number_never_matches_a_vague_quantity(self):
        # The model inventing 2 tsp where the label says "to taste" is exactly
        # the error this project cares most about catching.
        assert not quantities_match(2, "tsp", None, None)
        assert not quantities_match(None, None, 2, "tsp")

    def test_small_float_drift_is_tolerated(self):
        assert quantities_match(236.588, "ml", 1, "cup")


class TestKendallTau:
    def test_perfect_order(self):
        assert kendall_tau([0, 1, 2, 3]) == 1.0

    def test_reversed_order(self):
        assert kendall_tau([3, 2, 1, 0]) == -1.0

    def test_one_swap(self):
        assert kendall_tau([1, 0, 2, 3]) == pytest.approx(4 / 6)

    def test_too_short_to_misorder(self):
        # Nothing to get wrong, so nothing is wrong.
        assert kendall_tau([]) == 1.0
        assert kendall_tau([5]) == 1.0

    def test_step_order_from_text(self):
        truth = ["Heat the oil.", "Add the onions.", "Simmer for ten minutes."]
        assert step_order_tau(truth, truth) == 1.0
        assert step_order_tau(list(reversed(truth)), truth) == -1.0

    def test_too_few_matched_steps_returns_none(self):
        # A tau over one point is not a measurement.
        assert step_order_tau(["Heat the oil."], ["Heat the oil.", "Add onions."]) is None
        assert step_order_tau([], ["Heat the oil."]) is None


class TestIngredientScoring:
    def ing(self, name, qty=None, unit=None):
        return {"name": name, "qty": qty, "unit": unit}

    def test_a_perfect_extraction_scores_one(self):
        truth = [self.ing("tomato", 4), self.ing("salt", 1, "tsp")]
        s = score_ingredients(truth, truth)
        assert s.recall == 1.0
        assert s.precision == 1.0
        assert s.quantity_accuracy == 1.0

    def test_a_missed_ingredient_lowers_recall_not_precision(self):
        truth = [self.ing("tomato", 4), self.ing("salt", 1, "tsp")]
        pred = [self.ing("tomato", 4)]
        s = score_ingredients(pred, truth)
        assert s.recall == 0.5
        assert s.precision == 1.0
        assert s.missed == ["salt"]

    def test_an_invented_ingredient_lowers_precision_not_recall(self):
        truth = [self.ing("tomato", 4)]
        pred = [self.ing("tomato", 4), self.ing("saffron", 1, "tsp")]
        s = score_ingredients(pred, truth)
        assert s.recall == 1.0
        assert s.precision == 0.5
        assert s.spurious == ["saffron"]

    def test_a_wrong_quantity_keeps_recall_but_loses_quantity_accuracy(self):
        truth = [self.ing("tomato", 4)]
        pred = [self.ing("tomatoes", 6)]
        s = score_ingredients(pred, truth)
        assert s.recall == 1.0
        assert s.quantity_accuracy == 0.0

    def test_each_prediction_is_consumed_once(self):
        # Two labelled onions must not both match a single predicted onion.
        truth = [self.ing("onion", 1), self.ing("onion", 2)]
        pred = [self.ing("onion", 1)]
        s = score_ingredients(pred, truth)
        assert s.matched == 1
        assert s.recall == 0.5

    def test_an_empty_extraction_scores_zero_recall(self):
        s = score_ingredients([], [self.ing("tomato", 4)])
        assert s.recall == 0.0
        assert s.missed == ["tomato"]

    def test_both_empty_is_not_a_failure(self):
        # A correctly-refused video should not be scored as 0% recall.
        s = score_ingredients([], [])
        assert s.recall == 1.0
        assert s.precision == 1.0
