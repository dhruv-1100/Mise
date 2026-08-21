"""Contract test: the Python schema must agree with the TypeScript one.

Runs against the same fixtures as `packages/schema/tests/fixtures.test.ts`.
Every file under valid/ must parse; every file under invalid/ must be rejected.
Anything that parses in one language and not the other fails here rather than
in production.
"""

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.schema import Job, Recipe, extraction_result_adapter

FIXTURES = Path(__file__).resolve().parents[3] / "packages" / "schema" / "fixtures"


def _load(kind: str, bucket: str) -> list[tuple[str, dict]]:
    directory = FIXTURES / kind / bucket
    return [
        (path.name, json.loads(path.read_text(encoding="utf-8")))
        for path in sorted(directory.glob("*.json"))
    ]


def _parse(kind: str, data: dict) -> object:
    if kind == "recipe":
        return Recipe.model_validate(data)
    if kind == "job":
        return Job.model_validate(data)
    return extraction_result_adapter.validate_python(data)


def test_fixtures_directory_is_found() -> None:
    # A moved fixtures directory would turn every parametrised test below into
    # an empty parameter set, which pytest reports as passing.
    assert FIXTURES.is_dir(), f"fixtures not found at {FIXTURES}"


@pytest.mark.parametrize("kind", ["recipe", "result", "job"])
@pytest.mark.parametrize("bucket", ["valid", "invalid"])
def test_fixture_buckets_are_populated(kind: str, bucket: str) -> None:
    assert _load(kind, bucket), f"no fixtures in {kind}/{bucket}"


@pytest.mark.parametrize(
    ("kind", "name", "data"),
    [(k, n, d) for k in ("recipe", "result", "job") for n, d in _load(k, "valid")],
)
def test_valid_fixtures_parse(kind: str, name: str, data: dict) -> None:
    _parse(kind, data)


@pytest.mark.parametrize(
    ("kind", "name", "data"),
    [(k, n, d) for k in ("recipe", "result", "job") for n, d in _load(k, "invalid")],
)
def test_invalid_fixtures_are_rejected(kind: str, name: str, data: dict) -> None:
    with pytest.raises(ValidationError):
        _parse(kind, data)
