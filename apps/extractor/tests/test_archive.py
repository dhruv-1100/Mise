"""The durable tier under the cache, and the dead-letter gauge.

Both exist because of things that actually happened: the live recipe page
returned 404 twice when a cached recipe aged out, and `dead_letter_depth()` sat
unread from Phase 4 until Phase 7 was still unstarted. These assert the
behaviour, offline — nothing here touches AWS.
"""

from __future__ import annotations

import asyncio
import json

import pytest
from tests.test_queue import FakeRedis

from app.archive import NullArchive, from_environment, object_key
from app.metrics import METRIC_NAME, publish_dead_letters
from app.queue import CACHE_KEY, DLQ_KEY, ExtractionQueue
from app.schema import JobState

VIDEO = "aaaaaaaaaaa"
RECIPE = {"videoId": VIDEO, "title": "Archived"}


def run(coro):
    return asyncio.run(coro)


class FakeArchive:
    """In-memory stand-in implementing RecipeArchive."""

    def __init__(self, seed: dict[str, dict] | None = None) -> None:
        self.objects: dict[str, dict] = dict(seed or {})
        self.reads: list[str] = []
        self.writes: list[str] = []

    async def get(self, video_id):
        self.reads.append(video_id)
        return self.objects.get(video_id)

    async def put(self, video_id, recipe_json):
        self.writes.append(video_id)
        self.objects[video_id] = json.loads(recipe_json)


class BrokenArchive:
    """Every call fails. S3 being down must not take the recipe page with it."""

    async def get(self, video_id):
        raise RuntimeError("S3 unavailable")

    async def put(self, video_id, recipe_json):
        raise RuntimeError("S3 unavailable")


class TestKeys:
    def test_objects_live_under_the_granted_prefix(self):
        # The IAM policy in infra/aws.tf grants recipes/* and nothing else, so a
        # key shaped differently is an AccessDenied in production and a passing
        # test everywhere else.
        assert object_key(VIDEO) == f"recipes/{VIDEO}.json"


class TestReadFallthrough:
    def test_redis_is_preferred_and_the_archive_is_not_touched(
        self,
    ):
        redis = FakeRedis()
        archive = FakeArchive()
        q = ExtractionQueue(redis=redis, archive=archive)
        run(redis.set(CACHE_KEY.format(video_id=VIDEO), json.dumps(RECIPE)))

        assert run(q.cached_recipe(VIDEO))["title"] == "Archived"
        # A cache hit must not pay for a network round trip it does not need.
        assert archive.reads == []

    def test_an_expired_cache_falls_through_to_the_archive(self):
        """The bug this whole tier exists for.

        Redis expires a recipe after seven days; the live page 404'd twice
        because of it, and each recovery cost a 90-295 second re-extraction of
        something already extracted correctly.
        """
        archive = FakeArchive({VIDEO: RECIPE})
        q = ExtractionQueue(redis=FakeRedis(), archive=archive)

        assert run(q.cached_recipe(VIDEO))["title"] == "Archived"
        assert archive.reads == [VIDEO]

    def test_an_archive_hit_rewarms_the_cache(self):
        redis = FakeRedis()
        archive = FakeArchive({VIDEO: RECIPE})
        q = ExtractionQueue(redis=redis, archive=archive)

        run(q.cached_recipe(VIDEO))
        # The entry that expired was a cache entry, not the recipe. The next
        # reader should not pay for the same S3 round trip.
        assert redis.values[CACHE_KEY.format(video_id=VIDEO)]
        assert run(q.cached_recipe(VIDEO))["title"] == "Archived"
        assert archive.reads == [VIDEO]

    def test_missing_in_both_tiers_is_None(self):
        # The one case that genuinely needs an extraction.
        q = ExtractionQueue(redis=FakeRedis(), archive=FakeArchive())
        assert run(q.cached_recipe(VIDEO)) is None


class TestWrite:
    def test_success_writes_both_tiers(self):
        redis = FakeRedis()
        archive = FakeArchive()
        q = ExtractionQueue(redis=redis, archive=archive)

        run(q.enqueue(VIDEO))
        job = run(q.claim())
        run(q.succeed(job, json.dumps(RECIPE)))

        assert redis.values[CACHE_KEY.format(video_id=VIDEO)]
        assert archive.writes == [VIDEO]

    def test_a_broken_archive_does_not_fail_the_extraction(self):
        """S3 being down must not cost a recipe that was extracted correctly.

        BrokenArchive raises rather than swallowing, which is the point:
        RecipeArchive is a Protocol and a Protocol cannot require an
        implementation to be best-effort. The guarantee has to hold at the call
        site, for every implementation, not just the one that remembered.
        """
        redis = FakeRedis()
        q = ExtractionQueue(redis=redis, archive=BrokenArchive())
        run(q.enqueue(VIDEO))
        job = run(q.claim())

        job = run(q.succeed(job, json.dumps(RECIPE)))

        assert job.state is JobState.SUCCEEDED
        assert run(q.cached_recipe(VIDEO))["title"] == "Archived"

    def test_a_broken_archive_does_not_break_the_read_either(self):
        q = ExtractionQueue(redis=FakeRedis(), archive=BrokenArchive())
        # No Redis entry and an archive that throws: the answer is "extract it",
        # not an exception on the recipe page.
        assert run(q.cached_recipe(VIDEO)) is None

    def test_no_archive_configured_behaves_exactly_as_before(self):
        redis = FakeRedis()
        q = ExtractionQueue(redis=redis, archive=NullArchive())
        run(q.enqueue(VIDEO))
        job = run(q.claim())
        run(q.succeed(job, json.dumps(RECIPE)))

        assert run(q.cached_recipe(VIDEO))["title"] == "Archived"


class TestDeadLetterGauge:
    def test_it_publishes_the_depth(self):
        published: list[tuple[str, float]] = []

        class Sink:
            async def gauge(self, name, value):
                published.append((name, value))

        redis = FakeRedis()
        redis.lists[DLQ_KEY] = ["job-1", "job-2"]
        q = ExtractionQueue(redis=redis)

        async def scenario():
            stop = asyncio.Event()
            waits: list[float] = []

            async def sleep(seconds):
                waits.append(seconds)
                stop.set()  # one iteration, then stop
                await asyncio.sleep(0)

            await publish_dead_letters(source=q, sink=Sink(), stop=stop, sleep=sleep)
            return waits

        waits = run(scenario())
        assert published == [(METRIC_NAME, 2.0)]
        assert waits  # it waited rather than spinning

    def test_a_failing_sink_does_not_stop_the_loop(self):
        # A metric that cannot be published must never take down the thing it
        # measures.
        class Exploding:
            async def gauge(self, name, value):
                raise RuntimeError("CloudWatch unreachable")

        q = ExtractionQueue(redis=FakeRedis())

        async def scenario():
            stop = asyncio.Event()

            async def sleep(seconds):
                stop.set()
                await asyncio.sleep(0)

            await publish_dead_letters(source=q, sink=Exploding(), stop=stop, sleep=sleep)

        run(scenario())  # returns rather than raising


class TestConfiguration:
    VARS = ("RECIPE_BUCKET", "AWS_ROLE_ARN", "AWS_TOKEN_AUDIENCE", "AWS_REGION")

    def test_no_aws_at_all_is_a_valid_deployment(self, monkeypatch):
        # BUILD_PLAN §6.1 requires the public surface to work without accounts;
        # the same applies to the archive. No AWS means Redis is the only copy,
        # exactly as it was before this existed.
        for name in self.VARS:
            monkeypatch.delenv(name, raising=False)
        assert isinstance(from_environment(), NullArchive)

    @pytest.mark.parametrize("missing", VARS)
    def test_partial_configuration_refuses_to_start(self, monkeypatch, missing):
        """Half-configured is a deployment mistake, not a reason to degrade.

        Falling back to NullArchive here would hide it for as long as the cache
        holds — months of working normally, then one inexplicable 404 when an
        entry finally expires. That is the failure this whole tier was built to
        remove, so it must not be the failure the tier introduces.
        """
        for name in self.VARS:
            monkeypatch.setenv(name, "set")
        monkeypatch.delenv(missing)

        with pytest.raises(RuntimeError, match=missing):
            from_environment()
