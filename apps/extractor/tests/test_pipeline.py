"""End-to-end pipeline and HTTP surface, entirely offline.

Both external boundaries are protocols, so the whole path from a pasted URL to
a validated recipe runs with no network, no API keys, and no cost.
"""

import pytest
from fastapi.testclient import TestClient

from app.llm import FakeProvider
from app.main import app, get_fetcher, get_provider
from app.pipeline import run_pipeline
from app.schema import ExtractionInsufficient, ExtractionOk, Recipe
from app.youtube import FetchError, FetchFailure, VideoMetadata

DESCRIPTION = "\n".join(
    [
        "The best paratha you will ever make!",
        "Subscribe: https://example.com/sub",
        "***********************",
        "Ingredients",
        "2 cups whole wheat flour",
        "1 tsp salt",
        "Water as required",
        "Process",
        "Mix the flour and salt.",
        "Knead a soft dough.",
        "00:00 Intro",
        "#paratha",
    ]
)

MODEL_OUTPUT = {
    "found_recipe": True,
    "ingredients": [
        {"name": "whole wheat flour", "qty": 2, "unit": "cups", "optional": False},
        {"name": "SALT", "qty": None, "qty_text": "to taste", "unit": None, "optional": False},
        {"name": "water", "qty": None, "qty_text": "as required", "unit": None, "optional": False},
    ],
    "steps": [{"text": "Mix the flour and salt."}, {"text": "Knead a soft dough."}],
    "yield_qty": 4,
    "yield_unit": "serving",
    "equipment": ["tawa"],
}


class FakeFetcher:
    def __init__(self, metadata: VideoMetadata | Exception):
        self._metadata = metadata
        self.calls: list[str] = []

    async def fetch(self, video_id: str) -> VideoMetadata:
        self.calls.append(video_id)
        if isinstance(self._metadata, Exception):
            raise self._metadata
        return self._metadata


def metadata(description: str = DESCRIPTION) -> VideoMetadata:
    return VideoMetadata(
        video_id="j3pDXY9fqSo",
        title="Aloo Paratha",
        description=description,
        channel_id="UCexampleexampleexample",
        channel_title="Chef Example",
        published_at="2019-06-07T03:57:43Z",
        duration="PT8M",
        claims_captions=True,
    )


class TestPipeline:
    @pytest.mark.anyio
    async def test_a_video_id_becomes_a_validated_recipe(self):
        out = await run_pipeline(
            fetcher=FakeFetcher(metadata()),
            provider=FakeProvider(responses=[MODEL_OUTPUT]),
            video_id="j3pDXY9fqSo",
        )
        assert isinstance(out.result, ExtractionOk)
        recipe = out.result.recipe

        # Round-trips through the shared contract.
        Recipe.model_validate(recipe.model_dump(by_alias=True, mode="json"))
        assert [i.name for i in recipe.ingredients] == [
            "whole wheat flour",
            "salt",
            "water",
        ]
        assert recipe.recipe_yield.qty == 4

    @pytest.mark.anyio
    async def test_attribution_comes_from_youtube_not_the_model(self):
        # The model has no way to know the channel and every incentive to guess.
        out = await run_pipeline(
            fetcher=FakeFetcher(metadata()),
            provider=FakeProvider(responses=[MODEL_OUTPUT]),
            video_id="j3pDXY9fqSo",
        )
        creator = out.result.recipe.creator
        assert creator.name == "Chef Example"
        assert str(creator.channel_url).rstrip("/").endswith("UCexampleexampleexample")

    @pytest.mark.anyio
    async def test_the_llm_never_sees_the_noise(self):
        provider = FakeProvider(responses=[MODEL_OUTPUT])
        await run_pipeline(
            fetcher=FakeFetcher(metadata()), provider=provider, video_id="j3pDXY9fqSo"
        )
        prompt = provider.calls[0]["prompt"]
        assert "https://example.com/sub" not in prompt
        assert "#paratha" not in prompt
        assert "***" not in prompt
        # ...but every bit of the recipe survives.
        assert "2 cups whole wheat flour" in prompt
        assert "Knead a soft dough." in prompt

    @pytest.mark.anyio
    async def test_quantities_are_canonicalised(self):
        out = await run_pipeline(
            fetcher=FakeFetcher(metadata()),
            provider=FakeProvider(responses=[MODEL_OUTPUT]),
            video_id="j3pDXY9fqSo",
        )
        # "2 cups" is a volume; "to taste" and "as required" are not convertible.
        assert out.stats.canonicalised_quantities == 1
        assert out.canonical[0].millilitres == pytest.approx(473.176473)
        assert not out.canonical[1].is_canonical

    @pytest.mark.anyio
    async def test_stats_are_reported_for_every_stage(self):
        out = await run_pipeline(
            fetcher=FakeFetcher(metadata()),
            provider=FakeProvider(responses=[MODEL_OUTPUT]),
            video_id="j3pDXY9fqSo",
        )
        assert out.stats.lines_removed > 0
        assert out.stats.chapters_found == 1
        assert out.stats.total_tokens > 0

    @pytest.mark.anyio
    async def test_a_link_only_description_refuses_rather_than_inventing(self):
        # The Hebbars Kitchen shape from ADR 0001.
        out = await run_pipeline(
            fetcher=FakeFetcher(metadata("full recipe: https://example.com/palak")),
            provider=FakeProvider(
                responses=[{"found_recipe": False, "ingredients": [], "steps": [], "equipment": []}]
            ),
            video_id="cRsAQeR5dbI",
        )
        assert isinstance(out.result, ExtractionInsufficient)
        assert out.canonical == ()


class TestEndpoint:
    def client(self, fetcher, provider) -> TestClient:
        app.dependency_overrides[get_fetcher] = lambda: fetcher
        app.dependency_overrides[get_provider] = lambda: provider
        return TestClient(app)

    def teardown_method(self):
        app.dependency_overrides.clear()

    def test_healthz(self):
        with TestClient(app) as c:
            assert c.get("/healthz").json()["status"] == "ok"

    def test_a_pasted_url_returns_a_recipe(self):
        c = self.client(FakeFetcher(metadata()), FakeProvider(responses=[MODEL_OUTPUT]))
        r = c.post("/extract", json={"video": "https://youtu.be/j3pDXY9fqSo"})

        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "ok"
        assert body["video_id"] == "j3pDXY9fqSo"
        assert body["recipe"]["title"] == "Aloo Paratha"
        assert body["stats"]["chapters_found"] == 1

    def test_insufficient_material_is_a_200_not_an_error(self):
        # It is a correct answer about the video, not a failure of the service.
        c = self.client(
            FakeFetcher(metadata("full recipe: https://example.com/x")),
            FakeProvider(
                responses=[{"found_recipe": False, "ingredients": [], "steps": [], "equipment": []}]
            ),
        )
        r = c.post("/extract", json={"video": "cRsAQeR5dbI"})
        assert r.status_code == 200
        assert r.json()["status"] == "insufficient_source_material"
        assert r.json()["recipe"] is None
        assert r.json()["reason"] == "description_is_link_only"

    @pytest.mark.parametrize(
        ("failure", "status"),
        [
            (FetchFailure.NOT_A_YOUTUBE_URL, 400),
            (FetchFailure.VIDEO_NOT_FOUND, 404),
            (FetchFailure.QUOTA_EXCEEDED, 429),
            (FetchFailure.UPSTREAM_ERROR, 502),
        ],
    )
    def test_fetch_failures_become_typed_error_envelopes(self, failure, status):
        # CLAUDE.md: every route returns a typed error envelope, never a raw
        # exception.
        c = self.client(
            FakeFetcher(FetchError(failure, "detail")),
            FakeProvider(responses=[MODEL_OUTPUT]),
        )
        r = c.post("/extract", json={"video": "j3pDXY9fqSo"})
        assert r.status_code == status
        assert r.json() == {"error": failure.value, "detail": "detail"}

    def test_a_junk_url_is_rejected_before_any_upstream_call(self):
        fetcher = FakeFetcher(metadata())
        c = self.client(fetcher, FakeProvider(responses=[MODEL_OUTPUT]))
        r = c.post("/extract", json={"video": "https://example.com/not-youtube"})

        assert r.status_code == 400
        assert r.json()["error"] == "not_a_youtube_url"
        assert fetcher.calls == []

    def test_an_empty_body_is_a_validation_error(self):
        c = self.client(FakeFetcher(metadata()), FakeProvider(responses=[MODEL_OUTPUT]))
        assert c.post("/extract", json={"video": ""}).status_code == 422
