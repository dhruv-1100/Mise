"""Tests for the LLM extraction stage.

Every test runs offline against FakeProvider. The stage's value is not that it
calls a model — it is the mapping, coercion and validation around the call, and
all of that is deterministic.

The cases below are drawn from output a real model actually produced against a
real description during the Phase 2.1 probe, not from imagination.
"""

import asyncio

import pytest
from pydantic import ValidationError

from app.extract import RESPONSE_SCHEMA, build_prompt, extract_recipe, to_result
from app.llm import FakeProvider, LlmResponse
from app.schema import Creator, ExtractionInsufficient, ExtractionOk, InsufficientReason

CREATOR = Creator(
    name="Example Kitchen",
    channel_id="UCexampleexampleexample",
    channel_url="https://www.youtube.com/channel/UCexampleexampleexample",
)


def response(payload: dict) -> LlmResponse:
    return LlmResponse(data=payload, model="fake", input_tokens=10, output_tokens=20)


def ok(payload: dict) -> ExtractionOk:
    result = to_result(response(payload), video_id="aaaaaaaaaaa", title="Test", creator=CREATOR)
    assert isinstance(result, ExtractionOk)
    return result


def full(**overrides) -> dict:
    base = {
        "found_recipe": True,
        "ingredients": [
            {"name": "olive oil", "qty": 2, "qty_text": None, "unit": "tbsp", "optional": False}
        ],
        "steps": [{"text": "Heat the oil."}],
        "equipment": [],
    }
    base.update(overrides)
    return base


class TestQuantityCoercion:
    def test_a_range_takes_the_lower_bound_and_keeps_the_wording(self):
        # Observed: "8-10 CLOVES" came back as qty=null, unit="cloves".
        result = ok(
            full(
                ingredients=[
                    {
                        "name": "garlic",
                        "qty": None,
                        "qty_text": "8-10",
                        "unit": "cloves",
                        "optional": False,
                    }
                ]
            )
        )
        ing = result.recipe.ingredients[0]
        assert ing.qty == 8
        assert ing.qty_text == "8-10"
        assert ing.unit == "cloves"

    def test_a_unit_without_a_quantity_folds_into_the_wording(self):
        # The schema rejects unit-without-qty, correctly: a unit alone measures
        # nothing. The wording is the honest carrier.
        result = ok(
            full(
                ingredients=[
                    {
                        "name": "coriander",
                        "qty": None,
                        "qty_text": "a few",
                        "unit": "sprigs",
                        "optional": False,
                    }
                ]
            )
        )
        ing = result.recipe.ingredients[0]
        assert ing.qty is None
        assert ing.unit is None
        assert ing.qty_text == "a few sprigs"

    def test_a_bare_unit_with_no_wording_becomes_the_wording(self):
        result = ok(
            full(
                ingredients=[
                    {
                        "name": "salt",
                        "qty": None,
                        "qty_text": None,
                        "unit": "pinch",
                        "optional": False,
                    }
                ]
            )
        )
        assert result.recipe.ingredients[0].qty_text == "pinch"
        assert result.recipe.ingredients[0].unit is None

    def test_redundant_qty_text_is_dropped(self):
        # Observed: qty=4 alongside qty_text="4".
        result = ok(
            full(
                ingredients=[
                    {"name": "tomato", "qty": 4, "qty_text": "4", "unit": None, "optional": False}
                ]
            )
        )
        assert result.recipe.ingredients[0].qty == 4
        assert result.recipe.ingredients[0].qty_text is None

    def test_meaningful_qty_text_survives_alongside_a_quantity(self):
        result = ok(
            full(
                ingredients=[
                    {
                        "name": "stock",
                        "qty": 500,
                        "qty_text": "or as needed",
                        "unit": "ml",
                        "optional": False,
                    }
                ]
            )
        )
        assert result.recipe.ingredients[0].qty_text == "or as needed"

    def test_a_vague_quantity_is_never_given_a_number(self):
        result = ok(
            full(
                ingredients=[
                    {
                        "name": "salt",
                        "qty": None,
                        "qty_text": "to taste",
                        "unit": None,
                        "optional": False,
                    }
                ]
            )
        )
        assert result.recipe.ingredients[0].qty is None
        assert result.recipe.ingredients[0].qty_text == "to taste"


class TestNames:
    def test_shouted_names_are_lowercased(self):
        # Source descriptions shout: "KASHMIRI RED CHILLI POWDER".
        result = ok(
            full(
                ingredients=[
                    {
                        "name": "KASHMIRI RED CHILLI POWDER",
                        "qty": 1,
                        "unit": "tsp",
                        "optional": False,
                    }
                ]
            )
        )
        assert result.recipe.ingredients[0].name == "kashmiri red chilli powder"

    def test_deliberate_capitalisation_survives(self):
        for name in ["MSG", "Kashmiri chilli", "San Marzano tomatoes"]:
            result = ok(
                full(ingredients=[{"name": name, "qty": 1, "unit": "tsp", "optional": False}])
            )
            assert result.recipe.ingredients[0].name == name

    def test_an_unnamed_ingredient_is_dropped(self):
        result = ok(
            full(
                ingredients=[
                    {"name": "  ", "qty": 1, "unit": "tsp", "optional": False},
                    {"name": "salt", "qty": 1, "unit": "tsp", "optional": False},
                ]
            )
        )
        assert [i.name for i in result.recipe.ingredients] == ["salt"]


class TestSteps:
    def test_indices_are_assigned_here_not_trusted_from_the_model(self):
        # The schema requires 1..n contiguous. That is our invariant to keep.
        result = ok(full(steps=[{"text": "One."}, {"text": "Two."}, {"text": "Three."}]))
        assert [s.index for s in result.recipe.steps] == [1, 2, 3]

    def test_blank_steps_are_dropped_without_leaving_a_gap(self):
        result = ok(full(steps=[{"text": "One."}, {"text": "   "}, {"text": "Three."}]))
        assert [s.index for s in result.recipe.steps] == [1, 2]
        assert [s.text for s in result.recipe.steps] == ["One.", "Three."]

    def test_durations_and_temperatures_pass_through(self):
        result = ok(full(steps=[{"text": "Bake.", "duration_s": 1800, "temp_c": 180}]))
        assert result.recipe.steps[0].duration_s == 1800
        assert result.recipe.steps[0].temp_c == 180

    def test_a_recipe_with_no_steps_is_still_valid(self):
        # The CookingShooking shape: ingredients in the description, method only
        # in the video.
        assert ok(full(steps=[])).recipe.steps == []


class TestInsufficient:
    def test_found_recipe_false_produces_a_typed_outcome(self):
        result = to_result(
            response({"found_recipe": False, "ingredients": [], "steps": [], "equipment": []}),
            video_id="aaaaaaaaaaa",
            title="Test",
            creator=CREATOR,
        )
        assert isinstance(result, ExtractionInsufficient)
        assert result.reason is InsufficientReason.DESCRIPTION_IS_LINK_ONLY

    def test_no_ingredients_is_insufficient_even_if_the_model_claims_a_recipe(self):
        # Never let a confident model produce a recipe with nothing in it.
        result = to_result(
            response({"found_recipe": True, "ingredients": [], "steps": [], "equipment": []}),
            video_id="aaaaaaaaaaa",
            title="Test",
            creator=CREATOR,
        )
        assert isinstance(result, ExtractionInsufficient)
        assert result.reason is InsufficientReason.NO_INGREDIENTS_FOUND


class TestYield:
    def test_a_numeric_yield_is_kept(self):
        result = ok(full(yield_qty=4, yield_unit="serving"))
        assert result.recipe.recipe_yield.qty == 4

    def test_a_vague_yield_keeps_its_wording(self):
        result = ok(full(yield_text="serves a crowd"))
        assert result.recipe.recipe_yield.qty is None
        assert result.recipe.recipe_yield.qty_text == "serves a crowd"

    def test_a_missing_yield_is_null_not_invented(self):
        # Scaling refuses a recipe with no yield rather than guessing four.
        assert ok(full()).recipe.recipe_yield is None


class TestPrompt:
    def test_the_prompt_carries_the_rules_that_matter(self):
        prompt = build_prompt("Paneer Butter Masala", "2 tbsp oil")
        assert "NEVER invent a quantity" in prompt
        assert "LOWER bound" in prompt
        assert "Paneer Butter Masala" in prompt
        assert "2 tbsp oil" in prompt

    def test_the_response_schema_requires_the_load_bearing_fields(self):
        assert set(RESPONSE_SCHEMA["required"]) == {
            "found_recipe",
            "ingredients",
            "steps",
            "equipment",
        }


class TestEndToEnd:
    def test_the_stage_calls_the_provider_and_maps_the_result(self):
        provider = FakeProvider(responses=[full()])
        result, response = asyncio.run(
            extract_recipe(
                provider,
                video_id="aaaaaaaaaaa",
                title="Test",
                creator=CREATOR,
                description="2 tbsp olive oil",
            )
        )
        assert isinstance(result, ExtractionOk)
        assert result.recipe.ingredients[0].name == "olive oil"
        assert response.input_tokens > 0
        assert len(provider.calls) == 1
        assert provider.calls[0]["temperature"] == 0.0

    def test_output_always_satisfies_the_shared_contract(self):
        # The point of the mapping layer: whatever the model returns, what
        # leaves this stage is schema-valid or it is an explicit refusal.
        provider = FakeProvider(
            responses=[
                full(
                    ingredients=[
                        {
                            "name": "GARLIC",
                            "qty": None,
                            "qty_text": "8-10",
                            "unit": "cloves",
                            "optional": False,
                        },
                        {
                            "name": "SALT",
                            "qty": None,
                            "qty_text": "to taste",
                            "unit": None,
                            "optional": False,
                        },
                    ],
                    steps=[{"text": "Cook."}],
                )
            ]
        )
        result, _ = asyncio.run(
            extract_recipe(
                provider, video_id="aaaaaaaaaaa", title="T", creator=CREATOR, description="x"
            )
        )
        assert isinstance(result, ExtractionOk)
        # Round-trips through the validator without raising.
        from app.schema import Recipe

        Recipe.model_validate(result.recipe.model_dump(by_alias=True, mode="json"))

    def test_a_malformed_payload_raises_rather_than_producing_junk(self):
        with pytest.raises(ValidationError):
            to_result(
                response(
                    full(ingredients=[{"name": "flour", "qty": -5, "unit": "g", "optional": False}])
                ),
                video_id="aaaaaaaaaaa",
                title="T",
                creator=CREATOR,
            )
