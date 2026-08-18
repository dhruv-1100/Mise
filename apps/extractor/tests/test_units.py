"""Tests for unit canonicalisation.

The bias here matches the rest of the pipeline: a unit we cannot convert must
report itself as unconvertible, never guess. A wrong gram value is worse than
no gram value, because nothing downstream can tell it is wrong.
"""

import pytest

from app.units import CanonicalQuantity, UnitKind, canonicalise, classify_unit


class TestClassification:
    @pytest.mark.parametrize(
        ("unit", "kind"),
        [
            ("g", UnitKind.MASS),
            ("grams", UnitKind.MASS),
            ("KG", UnitKind.MASS),
            ("oz", UnitKind.MASS),
            ("ml", UnitKind.VOLUME),
            ("tbsp", UnitKind.VOLUME),
            ("TSP", UnitKind.VOLUME),
            ("cup", UnitKind.VOLUME),
            ("nos", UnitKind.COUNT),
            ("NOS.", UnitKind.COUNT),
            ("clove", UnitKind.COUNT),
            ("can", UnitKind.COUNT),
            ("pinch", UnitKind.VAGUE),
            ("handful", UnitKind.VAGUE),
            ("katori", UnitKind.VAGUE),
            ("inch", UnitKind.DIMENSION),
            ("cm", UnitKind.DIMENSION),
            ("bloops", UnitKind.UNKNOWN),
        ],
    )
    def test_units_are_classified(self, unit, kind):
        assert classify_unit(unit) is kind

    def test_a_missing_unit_is_a_count(self):
        # "3 eggs" has no unit and is a count of three things.
        assert classify_unit(None) is UnitKind.COUNT
        assert classify_unit("  ") is UnitKind.COUNT


class TestMass:
    @pytest.mark.parametrize(
        ("qty", "unit", "grams"),
        [
            (500, "g", 500),
            (1, "kg", 1000),
            (2.5, "kg", 2500),
            (1, "oz", 28.349523125),
            (1, "lb", 453.59237),
            (250, "grams", 250),
        ],
    )
    def test_mass_converts_to_grams(self, qty, unit, grams):
        result = canonicalise(qty, unit)
        assert result.kind is UnitKind.MASS
        assert result.grams == pytest.approx(grams)
        assert result.millilitres is None
        assert result.is_canonical


class TestVolume:
    @pytest.mark.parametrize(
        ("qty", "unit", "millilitres"),
        [
            (500, "ml", 500),
            (1, "l", 1000),
            (1, "tsp", 4.92892159375),
            (1, "tbsp", 14.78676478125),
            (1, "cup", 236.5882365),
            (2, "cups", 473.176473),
        ],
    )
    def test_volume_converts_to_millilitres(self, qty, unit, millilitres):
        result = canonicalise(qty, unit)
        assert result.kind is UnitKind.VOLUME
        assert result.millilitres == pytest.approx(millilitres)
        assert result.grams is None

    def test_volume_is_never_converted_to_mass(self):
        # A cup of flour and a cup of honey differ by more than 2x. That
        # conversion needs a density per ingredient and belongs after entity
        # resolution.
        assert canonicalise(1, "cup").grams is None


class TestAssumptions:
    def test_a_cup_records_which_cup_was_assumed(self):
        result = canonicalise(1, "cup")
        assert result.assumptions
        assert "236.6 ml" in result.assumptions[0]
        assert "250 ml" in result.assumptions[0]

    def test_a_tablespoon_records_the_australian_discrepancy(self):
        result = canonicalise(1, "tbsp")
        assert result.assumptions
        assert "20 ml" in result.assumptions[0]

    def test_unambiguous_units_record_nothing(self):
        # A gram is a gram everywhere.
        assert canonicalise(500, "g").assumptions == ()
        assert canonicalise(500, "ml").assumptions == ()


class TestRefusals:
    def test_a_vague_quantity_stays_vague(self):
        result = canonicalise(None, "tsp")
        assert result == CanonicalQuantity(qty=None, unit="tsp", kind=UnitKind.VAGUE)
        assert not result.is_canonical

    @pytest.mark.parametrize("unit", ["pinch", "handful", "glug", "katori"])
    def test_vague_units_get_no_canonical_value(self, unit):
        result = canonicalise(2, unit)
        assert result.kind is UnitKind.VAGUE
        assert not result.is_canonical

    def test_an_unknown_unit_is_reported_not_guessed(self):
        result = canonicalise(3, "bloops")
        assert result.kind is UnitKind.UNKNOWN
        assert not result.is_canonical
        # The original survives so the eval set can surface it as a missing alias.
        assert result.qty == 3
        assert result.unit == "bloops"

    def test_a_dimension_is_not_an_amount(self):
        # "1 INCH ginger" describes a size, not a quantity.
        result = canonicalise(1, "inch")
        assert result.kind is UnitKind.DIMENSION
        assert not result.is_canonical

    def test_a_count_has_no_canonical_value(self):
        result = canonicalise(4, "nos")
        assert result.kind is UnitKind.COUNT
        assert not result.is_canonical


class TestConsistency:
    @pytest.mark.parametrize(
        ("a_qty", "a_unit", "b_qty", "b_unit"),
        [
            (1, "kg", 1000, "g"),
            (1, "l", 1000, "ml"),
            (1, "tbsp", 3, "tsp"),
            (1, "cup", 16, "tbsp"),
            (1, "lb", 16, "oz"),
        ],
    )
    def test_equivalent_amounts_canonicalise_equally(self, a_qty, a_unit, b_qty, b_unit):
        a = canonicalise(a_qty, a_unit)
        b = canonicalise(b_qty, b_unit)
        left = a.grams if a.grams is not None else a.millilitres
        right = b.grams if b.grams is not None else b.millilitres
        assert left == pytest.approx(right)

    def test_case_and_trailing_period_do_not_matter(self):
        # Descriptions are written by hand: "4 NOS." and "4 nos" are the same.
        assert classify_unit("NOS.") is classify_unit("nos")
        assert canonicalise(500, "G").grams == canonicalise(500, "g").grams

    def test_scaling_a_quantity_scales_its_canonical_value(self):
        single = canonicalise(1, "cup")
        triple = canonicalise(3, "cup")
        assert triple.millilitres == pytest.approx(single.millilitres * 3)
