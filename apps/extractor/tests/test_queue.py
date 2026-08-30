"""Queue semantics, tested against an in-memory Redis.

The state machine is the interesting part, so it is tested without a server.
FakeRedis implements only what RedisLike declares, which keeps the two honest
about each other.
"""

import asyncio
import json

import pytest

from app.queue import (
    CACHE_KEY,
    CACHE_TTL_SECONDS,
    DLQ_KEY,
    NEGATIVE_CACHE_TTL_SECONDS,
    QUEUE_KEY,
    ExtractionQueue,
    QueueFull,
    backoff_seconds,
)
from app.schema import JobStage, JobState

VIDEO = "aaaaaaaaaaa"
OTHER = "bbbbbbbbbbb"


class FakeRedis:
    """In-memory stand-in.

    Expiry is not simulated — nothing here disappears on a timer, because that
    is Redis's job. The TTL *value* is recorded, though: how long a result is
    kept is a decision this code makes rather than a mechanic it inherits, and
    since ADR 0006 it differs between a recipe and a "no recipe here". See
    `test_negative_results_expire_sooner`.
    """

    def __init__(self) -> None:
        self.values: dict[str, str] = {}
        self.lists: dict[str, list[str]] = {}
        self.ttls: dict[str, int | None] = {}

    async def get(self, key):
        return self.values.get(key)

    async def set(self, key, value, ex=None):
        self.values[key] = value
        self.ttls[key] = ex

    async def delete(self, *keys):
        for k in keys:
            self.values.pop(k, None)

    async def llen(self, key):
        return len(self.lists.get(key, []))

    async def rpush(self, key, value):
        self.lists.setdefault(key, []).append(value)

    async def lpop(self, key):
        items = self.lists.get(key, [])
        return items.pop(0) if items else None


@pytest.fixture
def redis() -> FakeRedis:
    return FakeRedis()


@pytest.fixture
def queue(redis) -> ExtractionQueue:
    return ExtractionQueue(redis=redis)


def run(coro):
    return asyncio.run(coro)


class TestEnqueue:
    def test_a_new_video_creates_a_queued_job(self, queue, redis):
        job, is_new = run(queue.enqueue(VIDEO))
        assert is_new
        assert job.state is JobState.QUEUED
        assert job.attempt == 0
        assert job.cached is False
        assert redis.lists[QUEUE_KEY] == [job.job_id]

    def test_resubmitting_an_in_flight_video_returns_the_same_job(self, queue, redis):
        # Two workers on one video costs twice and can yield two different
        # recipes for the same input.
        first, _ = run(queue.enqueue(VIDEO))
        second, is_new = run(queue.enqueue(VIDEO))
        assert second.job_id == first.job_id
        assert not is_new
        assert len(redis.lists[QUEUE_KEY]) == 1

    def test_a_running_video_is_also_deduplicated(self, queue):
        first, _ = run(queue.enqueue(VIDEO))
        run(queue.claim())
        second, is_new = run(queue.enqueue(VIDEO))
        assert second.job_id == first.job_id
        assert not is_new

    def test_different_videos_get_different_jobs(self, queue, redis):
        a, _ = run(queue.enqueue(VIDEO))
        b, _ = run(queue.enqueue(OTHER))
        assert a.job_id != b.job_id
        assert len(redis.lists[QUEUE_KEY]) == 2

    def test_a_cached_video_never_reaches_the_queue(self, queue, redis):
        redis.values[CACHE_KEY.format(video_id=VIDEO)] = json.dumps({"videoId": VIDEO})
        job, is_new = run(queue.enqueue(VIDEO))

        assert job.state is JobState.SUCCEEDED
        assert job.cached is True
        assert not is_new
        assert redis.lists.get(QUEUE_KEY, []) == []

    def test_a_cache_hit_is_served_even_when_the_queue_is_full(self, queue, redis):
        # Serving it costs nothing, so backpressure must not reject it.
        redis.lists[QUEUE_KEY] = [f"j{i}" for i in range(queue.max_depth)]
        redis.values[CACHE_KEY.format(video_id=VIDEO)] = json.dumps({"videoId": VIDEO})
        job, _ = run(queue.enqueue(VIDEO))
        assert job.cached is True


class TestBackpressure:
    def test_a_full_queue_rejects_with_a_retry_hint(self, queue, redis):
        redis.lists[QUEUE_KEY] = [f"j{i}" for i in range(queue.max_depth)]
        with pytest.raises(QueueFull) as exc:
            run(queue.enqueue(VIDEO))
        assert exc.value.depth == queue.max_depth
        assert exc.value.retry_after_seconds > 0

    def test_capacity_is_reported(self, queue, redis):
        redis.lists[QUEUE_KEY] = ["a", "b", "c"]
        assert run(queue.depth()) == 3


class TestClaim:
    def test_claiming_marks_running_with_the_first_stage(self, queue):
        run(queue.enqueue(VIDEO))
        job = run(queue.claim())
        assert job.state is JobState.RUNNING
        assert job.started_at is not None
        assert job.stage is JobStage.FETCHING

    def test_claiming_removes_it_from_the_queue(self, queue, redis):
        run(queue.enqueue(VIDEO))
        run(queue.claim())
        assert redis.lists[QUEUE_KEY] == []

    def test_an_empty_queue_yields_nothing(self, queue):
        assert run(queue.claim()) is None

    def test_a_queue_entry_whose_record_vanished_is_skipped(self, queue, redis):
        # The record TTL'd out from under its queue entry; the worker must not
        # crash on a job nobody can observe.
        run(queue.enqueue(VIDEO))
        redis.values.clear()
        assert run(queue.claim()) is None

    def test_stages_advance(self, queue):
        run(queue.enqueue(VIDEO))
        job = run(queue.claim())
        job = run(queue.set_stage(job, JobStage.EXTRACTING))
        assert job.stage is JobStage.EXTRACTING
        assert run(queue.get(job.job_id)).stage is JobStage.EXTRACTING


class TestSuccess:
    def test_succeeding_caches_the_recipe_and_clears_the_stage(self, queue, redis):
        run(queue.enqueue(VIDEO))
        job = run(queue.claim())
        done = run(queue.succeed(job, json.dumps({"videoId": VIDEO})))

        assert done.state is JobState.SUCCEEDED
        assert done.finished_at is not None
        assert done.stage is None
        assert CACHE_KEY.format(video_id=VIDEO) in redis.values

    def test_a_second_submission_after_success_is_a_cache_hit(self, queue):
        run(queue.enqueue(VIDEO))
        job = run(queue.claim())
        run(queue.succeed(job, json.dumps({"videoId": VIDEO})))

        again, is_new = run(queue.enqueue(VIDEO))
        assert again.cached is True
        assert not is_new

    def test_the_cached_recipe_is_readable(self, queue):
        run(queue.enqueue(VIDEO))
        job = run(queue.claim())
        run(queue.succeed(job, json.dumps({"videoId": VIDEO, "title": "T"})))
        assert run(queue.cached_recipe(VIDEO))["title"] == "T"

    def test_a_recipe_is_kept_for_a_week(self, queue, redis):
        run(queue.enqueue(VIDEO))
        job = run(queue.claim())
        run(queue.succeed(job, json.dumps({"videoId": VIDEO, "title": "T"})))
        assert redis.ttls[CACHE_KEY.format(video_id=VIDEO)] == CACHE_TTL_SECONDS

    def test_negative_results_expire_sooner(self, queue, redis):
        """A "no recipe here" must not outlive the pipeline that produced it.

        This is the bug ADR 0006 shipped with. The video fallback recovers
        exactly the link-only descriptions that produce this result — and every
        video already cached as insufficient went on serving the old answer for
        up to seven days after the fallback deployed. The improvement was live
        and unreachable.

        A successful extraction is a fact about the video. An insufficient one
        is a statement about what this pipeline could manage today.
        """
        run(queue.enqueue(VIDEO))
        job = run(queue.claim())
        run(
            queue.succeed(
                job,
                json.dumps(
                    {
                        "status": "insufficient_source_material",
                        "videoId": VIDEO,
                        "reason": "description_is_link_only",
                        "sourcesTried": ["description"],
                    }
                ),
            )
        )

        ttl = redis.ttls[CACHE_KEY.format(video_id=VIDEO)]
        assert ttl == NEGATIVE_CACHE_TTL_SECONDS
        assert ttl < CACHE_TTL_SECONDS

        # Still cached, though: retrying the same failing video in one sitting
        # should not pay for a second extraction.
        assert run(queue.cached_recipe(VIDEO))["reason"] == "description_is_link_only"


class TestFailureAndRetry:
    def test_a_first_failure_re_queues_with_a_higher_attempt(self, queue, redis):
        run(queue.enqueue(VIDEO))
        job = run(queue.claim())
        retried, will_retry = run(queue.fail(job, "llm_unavailable", "503"))

        assert will_retry
        assert retried.state is JobState.QUEUED
        assert retried.attempt == 1
        assert retried.error is None  # not a failure yet
        assert redis.lists[QUEUE_KEY] == [retried.job_id]

    def test_exhausting_attempts_dead_letters(self, queue, redis):
        run(queue.enqueue(VIDEO))
        job = run(queue.claim())
        for _ in range(queue.max_attempts - 1):
            job, will_retry = run(queue.fail(job, "llm_unavailable", "503"))
            assert will_retry
            job = run(queue.claim())
        dead, will_retry = run(queue.fail(job, "llm_unavailable", "503"))

        assert not will_retry
        assert dead.state is JobState.FAILED
        assert dead.error.code == "llm_unavailable"
        assert dead.finished_at is not None
        assert redis.lists[DLQ_KEY] == [dead.job_id]

    def test_a_dead_lettered_video_can_be_submitted_again(self, queue):
        # The idempotency key is released, so a fix-and-retry is possible.
        run(queue.enqueue(VIDEO))
        job = run(queue.claim())
        for _ in range(queue.max_attempts - 1):
            run(queue.fail(job, "x", "y"))
            job = run(queue.claim())
        run(queue.fail(job, "x", "y"))

        fresh, is_new = run(queue.enqueue(VIDEO))
        assert is_new
        assert fresh.state is JobState.QUEUED

    def test_dead_letter_depth_is_observable(self, queue):
        assert run(queue.dead_letter_depth()) == 0


class TestBackoff:
    def test_it_grows_exponentially_and_is_capped(self):
        assert backoff_seconds(1) == 2
        assert backoff_seconds(2) == 4
        assert backoff_seconds(3) == 8
        assert backoff_seconds(99) == 60

    def test_attempt_zero_does_not_wait(self):
        assert backoff_seconds(0) == 0

    def test_it_is_monotonic(self):
        values = [backoff_seconds(a) for a in range(1, 10)]
        assert values == sorted(values)


class TestJobRecords:
    def test_an_unknown_job_is_none(self, queue):
        assert run(queue.get("nope")) is None

    def test_a_saved_job_round_trips_through_the_contract(self, queue):
        job, _ = run(queue.enqueue(VIDEO))
        loaded = run(queue.get(job.job_id))
        assert loaded == job

    def test_job_id_timestamp_prefixes_are_non_decreasing(self, queue):
        # The guarantee is the timestamp prefix, not the whole id: ids minted
        # inside the same microsecond are ordered by their random suffix, and
        # across Cloud Run instances there is no finer ordering to recover.
        a, _ = run(queue.enqueue(VIDEO))
        b, _ = run(queue.enqueue(OTHER))
        assert a.job_id[:16] <= b.job_id[:16]
        assert a.job_id != b.job_id

    def test_job_ids_are_unique_under_rapid_creation(self, redis):
        # A cap of 100 is the production default, so raise it here rather than
        # testing fewer ids — collisions are likeliest under rapid creation.
        q = ExtractionQueue(redis=redis, max_depth=10_000)
        ids = {run(q.enqueue(f"v{i:010d}"[:11]))[0].job_id for i in range(500)}
        assert len(ids) == 500
