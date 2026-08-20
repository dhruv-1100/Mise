"""Validates hand-written eval labels as they are produced.

Labelling 50 videos by hand is exactly the task where a typo goes unnoticed
until the eval reports a number nobody can explain. This runs in the normal
pytest suite, so a malformed label fails CI rather than silently skewing recall.

Unlabelled stubs are skipped, not failed — the set is filled in over time.
"""

import json
from pathlib import Path

import pytest

EVAL_DIR = Path(__file__).parent / "fixtures" / "eval"
VALID_KEYS = {
    "video_id",
    "title",
    "creator",
    "expect",
    "ingredients",
    "steps",
    "yield",
    "equipment",
    "_instructions",
}


def load_all() -> list[tuple[str, dict]]:
    return [
        (p.name, json.loads(p.read_text(encoding="utf-8"))) for p in sorted(EVAL_DIR.glob("*.json"))
    ]


def is_labelled(data: dict) -> bool:
    if "_instructions" in data:
        return False
    if data.get("expect") == "insufficient":
        return True
    return any(str(i.get("name", "")).strip() for i in (data.get("ingredients") or []))


LABELLED = [(n, d) for n, d in load_all() if is_labelled(d)]
ALL = load_all()


def test_the_eval_directory_exists_and_is_populated():
    assert ALL, f"no label files in {EVAL_DIR}"


@pytest.mark.parametrize(("name", "data"), ALL, ids=[n for n, _ in ALL])
def test_every_file_has_the_expected_shape(name, data):
    unknown = set(data) - VALID_KEYS
    assert not unknown, f"{name}: unexpected key(s) {unknown}"
    assert data.get("video_id"), f"{name}: missing video_id"
    assert name == f"{data['video_id']}.json", f"{name}: filename must match video_id"


@pytest.mark.parametrize(("name", "data"), LABELLED, ids=[n for n, _ in LABELLED] or ["none"])
class TestLabelled:
    def test_instructions_removed(self, name, data):
        # The marker that says "still a stub". Leaving it in means the file is
        # skipped by the eval and the video silently never gets scored.
        assert "_instructions" not in data

    def test_expect_is_a_known_value(self, name, data):
        assert data.get("expect") in ("ok", "insufficient"), f"{name}: bad expect"

    def test_insufficient_labels_carry_no_recipe(self, name, data):
        if data.get("expect") != "insufficient":
            return
        assert not data.get("ingredients"), f"{name}: insufficient but has ingredients"
        assert not data.get("steps"), f"{name}: insufficient but has steps"

    def test_ok_labels_have_at_least_one_ingredient(self, name, data):
        if data.get("expect") != "ok":
            return
        named = [i for i in data.get("ingredients", []) if str(i.get("name", "")).strip()]
        assert named, f"{name}: expect=ok but no named ingredients"

    def test_ingredient_fields_are_sane(self, name, data):
        for i, ing in enumerate(data.get("ingredients") or []):
            where = f"{name}[{i}] {ing.get('name')!r}"
            qty, unit, text = ing.get("qty"), ing.get("unit"), ing.get("qty_text")

            assert str(ing.get("name", "")).strip(), f"{where}: empty name"
            if qty is not None:
                assert isinstance(qty, int | float), f"{where}: qty must be a number"
                assert qty > 0, f"{where}: qty must be positive"
            # A unit with no number measures nothing — the same invariant the
            # Recipe schema enforces.
            if unit is not None:
                assert qty is not None, f"{where}: unit {unit!r} without a qty"
            # A vague amount must say what the source said.
            if qty is None and unit is None:
                assert text, f"{where}: no qty and no qty_text — what did the source say?"

    def test_ingredient_names_are_not_shouted(self, name, data):
        for ing in data.get("ingredients") or []:
            n = str(ing.get("name", ""))
            assert not (len(n) > 3 and n.isupper()), f"{name}: {n!r} should be lower case"

    def test_step_indices_are_contiguous_from_one(self, name, data):
        steps = data.get("steps") or []
        indices = [s.get("index") for s in steps]
        assert indices == list(range(1, len(steps) + 1)), f"{name}: step indices {indices}"

    def test_steps_have_text(self, name, data):
        for s in data.get("steps") or []:
            assert str(s.get("text", "")).strip(), f"{name}: empty step text"

    def test_yield_is_sane(self, name, data):
        y = data.get("yield")
        if not y:
            return
        if y.get("qty") is not None:
            assert isinstance(y["qty"], int | float) and y["qty"] > 0, f"{name}: bad yield qty"


def test_progress_report(capsys):
    """Not an assertion — prints how far the labelling has got."""
    with capsys.disabled():
        total, done = len(ALL), len(LABELLED)
        insufficient = sum(1 for _, d in LABELLED if d.get("expect") == "insufficient")
        print(f"\n  eval labels: {done}/{total} done ({insufficient} marked insufficient)")
