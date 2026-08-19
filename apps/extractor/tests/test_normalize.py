"""Tests for the description normalization stage.

All input here is synthetic, modelled on shapes observed in the Phase 2.1 spike.
Real descriptions are third-party copyrighted text and live only in the
gitignored `scripts/spike_output/`.

The asymmetry that drives these tests: keeping a noise line costs a few tokens,
while dropping an ingredient line silently corrupts the recipe. So there are
more tests here about what must *survive* than about what must be removed.
"""

import pytest

from app.normalize import (
    Chapter,
    DropReason,
    looks_like_recipe_content,
    normalize_description,
)


def reasons(result) -> set[DropReason]:
    return {r.reason for r in result.removed}


def kept_lines(result) -> list[str]:
    return [line for line in result.text.splitlines() if line]


class TestRemoval:
    @pytest.mark.parametrize(
        ("line", "reason"),
        [
            ("Subscribe here - https://goo.gl/MH3A4r", DropReason.URL),
            ("Website - http://example.com/", DropReason.URL),
            ("My kit: www.example.com", DropReason.URL),
            ("Business enquiries: hello@example.com", DropReason.EMAIL),
            ("***********************", DropReason.DECORATIVE),
            ("-----", DropReason.DECORATIVE),
            ("#Paratha #StuffedParatha #recipe", DropReason.HASHTAGS),
            ("Subscribe for weekly videos", DropReason.SOCIAL_CALL_TO_ACTION),
            ("Follow me on Instagram", DropReason.SOCIAL_CALL_TO_ACTION),
            ("This video is sponsored by a knife company", DropReason.SPONSOR),
            ("Use code COOK10 for a discount", DropReason.SPONSOR),
            ("Music by Epidemic Sound", DropReason.MUSIC_CREDIT),
            ("Download the android app", DropReason.APP_PROMO),
            ("Items I use:", DropReason.STOREFRONT),
        ],
    )
    def test_noise_line_is_removed_with_the_right_reason(self, line, reason):
        result = normalize_description(line)
        assert result.text == ""
        assert reasons(result) == {reason}


class TestPreservation:
    @pytest.mark.parametrize(
        "line",
        [
            "2 cups whole wheat flour",
            "Oil - 1 tbsp",
            "TOMATO | tamatar 4 NOS.",
            "Salt - to taste",
            "Water as required",
            "Ingredients",
            "For the Filling",
            "Method:",
            "Process",
            "Serves: 4",
            "Prep time: 15 minutes",
            "Add the tomatoes and simmer for 15 minutes.",
            "Knead a soft dough and rest it for 20 minutes.",
        ],
    )
    def test_recipe_content_survives(self, line):
        result = normalize_description(line)
        assert kept_lines(result) == [line]
        assert result.removed == ()

    def test_an_ingredient_mentioning_a_social_word_survives(self):
        # The soft rules must not fire on real content. "Follow" appears in
        # instructions constantly: "follow with the cream".
        line = "Follow with 2 tbsp cream"
        assert kept_lines(normalize_description(line)) == [line]

    def test_a_step_mentioning_a_brand_survives(self):
        line = "Add 1 tsp Kashmiri chilli powder for colour"
        assert kept_lines(normalize_description(line)) == [line]

    def test_an_affiliate_line_naming_an_ingredient_is_still_removed(self):
        # Observed shape: a spice named purely to sell it. The URL is decisive —
        # a real ingredient line does not carry a link.
        line = "Deghi mirch powder - better colour - https://amzn.to/4xUONF4"
        result = normalize_description(line)
        assert result.text == ""
        assert reasons(result) == {DropReason.URL}


class TestChapters:
    def test_chapter_markers_become_structured_data(self):
        raw = "00:00 Intro\n1:45 Base gravy\n2:55 Paneer\n"
        result = normalize_description(raw)

        assert result.text == ""
        assert result.chapters == (
            Chapter(offset_s=0, label="Intro"),
            Chapter(offset_s=105, label="Base gravy"),
            Chapter(offset_s=175, label="Paneer"),
        )

    def test_hour_long_chapters_parse(self):
        result = normalize_description("01:02:03 Plating")
        assert result.chapters == (Chapter(offset_s=3723, label="Plating"),)

    def test_a_quantity_is_not_mistaken_for_a_chapter(self):
        line = "Simmer for 2:30 minutes"
        # No leading timestamp, so this is prose and must survive.
        assert kept_lines(normalize_description(line)) == [line]


class TestStructure:
    def test_fancy_unicode_is_folded_to_plain_text(self):
        # Creators style headers with mathematical-alphanumeric characters.
        result = normalize_description("𝗜𝗻𝗴𝗿𝗲𝗱𝗶𝗲𝗻𝘁𝘀\n2 cups flour")
        assert "Ingredients" in result.text

    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("½ tsp carom seeds", "1/2 tsp carom seeds"),
            ("¼ tsp turmeric", "1/4 tsp turmeric"),
            ("⅔ cup milk", "2/3 cup milk"),
            ("⅛ tsp saffron", "1/8 tsp saffron"),
            # The case that matters: a mixed number must not collapse into a
            # different number. NFKC alone turns "1½" into "11/2".
            ("1½ cups flour", "1 1/2 cups flour"),
            ("2¾ cups water", "2 3/4 cups water"),
            ("Add 1½ tsp salt and 2¼ cups stock", "Add 1 1/2 tsp salt and 2 1/4 cups stock"),
        ],
    )
    def test_fraction_glyphs_become_unambiguous_ascii(self, raw, expected):
        result = normalize_description(raw)
        assert result.text == expected
        assert "⁄" not in result.text

    def test_runs_of_blank_lines_collapse_to_one(self):
        result = normalize_description("Ingredients\n\n\n\n2 cups flour")
        assert result.text == "Ingredients\n\n2 cups flour"

    def test_no_leading_or_trailing_blank_lines(self):
        result = normalize_description("\n\n2 cups flour\n\n\n")
        assert result.text == "2 cups flour"

    def test_counts_and_reduction_are_reported(self):
        raw = "\n".join(
            [
                "Ingredients",
                "2 cups flour",
                "Subscribe: https://example.com",
                "#recipe",
            ]
        )
        result = normalize_description(raw)

        assert result.original_line_count == 4
        assert result.kept_line_count == 2
        assert result.reduction == pytest.approx(0.5)

    def test_empty_input_is_handled(self):
        result = normalize_description("")
        assert result.text == ""
        assert result.chapters == ()
        assert result.removed == ()
        assert result.reduction == 0.0

    def test_a_description_that_is_only_noise_yields_nothing(self):
        # The Hebbars Kitchen shape from ADR 0001: a link and social handles.
        # Downstream this becomes insufficient_source_material rather than an
        # invented recipe.
        raw = "full recipe: http://example.com/palak-paneer\n\nInstagram - http://example.com/ig"
        result = normalize_description(raw)
        assert result.text == ""


class TestRecipeContentGuard:
    @pytest.mark.parametrize(
        "line",
        ["2 tbsp oil", "Salt to taste", "Ingredients", "For the dough", "Method"],
    )
    def test_recognises_recipe_content(self, line):
        assert looks_like_recipe_content(line)

    @pytest.mark.parametrize(
        "line",
        ["Subscribe for more", "", "   ", "Follow me on Instagram", "Music by someone"],
    )
    def test_rejects_non_recipe_content(self, line):
        assert not looks_like_recipe_content(line)


class TestFullDescription:
    def test_a_realistic_description_reduces_to_its_recipe(self):
        raw = "\n".join(
            [
                "The best paratha you will ever make!",
                "",
                "***********************",
                "Knives I use - https://example.com/knives",
                "Subscribe: https://example.com/sub",
                "***********************",
                "",
                "Prep time: 15 minutes",
                "Serves: 4",
                "",
                "Ingredients",
                "2 cups whole wheat flour",
                "1 tsp salt",
                "2 tbsp ghee",
                "Water as required",
                "",
                "Process",
                "Mix the flour, salt and ghee in a bowl.",
                "Add water and knead a soft dough.",
                "Rest for 20 minutes before rolling.",
                "",
                "00:00 Intro",
                "01:20 Dough",
                "",
                "Music by Epidemic Sound",
                "#paratha #recipe",
            ]
        )
        result = normalize_description(raw)
        lines = kept_lines(result)

        # Every ingredient and step survives.
        assert "2 cups whole wheat flour" in lines
        assert "1 tsp salt" in lines
        assert "Water as required" in lines
        assert "Add water and knead a soft dough." in lines
        assert "Ingredients" in lines
        assert "Process" in lines

        # All the noise is gone.
        assert not any("http" in line for line in lines)
        assert not any("Subscribe" in line for line in lines)
        assert not any(line.startswith("#") for line in lines)
        assert "Music by Epidemic Sound" not in lines

        # Chapters are kept as data rather than thrown away.
        assert result.chapters == (
            Chapter(offset_s=0, label="Intro"),
            Chapter(offset_s=80, label="Dough"),
        )

        assert result.reduction > 0.3
