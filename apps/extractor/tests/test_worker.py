"""Worker loop, fully offline.

The clock is injected, so retry backoff is asserted rather than waited out —
a retry loop that sleeps for real seconds is a retry loop nobody tests.
"""

import asyncio

import pytest
from tests.test_pipeline import MODEL_OUTPUT, FakeFetcher, metadata
from tests.test_queue import FakeRedis

from app.llm import FakeProvider, LlmError
from app.queue import DLQ_KEY, ExtractionQueue
from app.schema import JobStage, JobState
from app.worker import Worker
from app.youtube import FetchError, FetchFailure

VIDEO = "j3pDXY9fqSo"


def run(coro):
    return asyncio.run(coro)


class Recorder:
    """Stand-in clock. Records what would have been waited, waits nothing.

    It still yields to the event loop. An async function that awaits nothing
    never gives control back, so a worker polling through this would spin
    forever and starve whatever is meant to stop it — which is exactly what
    happened the first time this was written.
    """

    def __init__(self) -> None:
        self.waits: list[float] = []

    async def __call__(self, seconds: float) -> None:
        self.waits.append(seconds)
        await asyncio.sleep(0)


@pytest.fixture
def redis() -> FakeRedis:
    return FakeRedis()


@pytest.fixture
def queue(redis) -> ExtractionQueue:
    return ExtractionQueue(redis=redis)


def worker(queue, *, responses=None, fetch_error=None, clock=None) -> Worker:
    return Worker(
        queue=queue,
        fetcher=FakeFetcher(fetch_error or metadata()),
        provider=FakeProvider(responses=responses if responses is not None else [MODEL_OUTPUT]),
        sleep=clock or Recorder(),
    )


class TestHappyPath:
    def test_a_queued_job_is_processed_to_success(self, queue):
        run(queue.enqueue(VIDEO))
        w = worker(queue)
        job = run(w.run_once())

        assert job.state is JobState.SUCCEEDED
        assert job.stage is None
        assert w.stats.succeeded == 1

    def test_the_recipe_is_cached_for_the_next_submission(self, queue):
        run(queue.enqueue(VIDEO))
        run(worker(queue).run_once())

        cached = run(queue.cached_recipe(VIDEO))
        assert cached["videoId"] == VIDEO
        again, is_new = run(queue.enqueue(VIDEO))
        assert again.cached is True and not is_new

    def test_stages_are_published_as_the_work_happens(self, queue, redis):
        seen = []
        original = queue.set_stage

        async def spy(job, stage):
            seen.append(stage)
            return await original(job, stage)

        queue.set_stage = spy
        run(queue.enqueue(VIDEO))
        run(worker(queue).run_once())

        # This is what makes the progress screen show stage names, not a spinner.
        assert seen == [
            JobStage.FETCHING,
            JobStage.NORMALIZING,
            JobStage.EXTRACTING,
            JobStage.CANONICALISING,
        ]

    def test_an_empty_queue_yields_nothing_and_does_not_raise(self, queue):
        assert run(worker(queue).run_once()) is None


#: Neither the description nor the video had anything in it.
EMPTY = {"found_recipe": False, "ingredients": [], "steps": [], "equipment": []}


class TestInsufficient:
    def test_no_recipe_is_a_success_not_a_retry(self, queue):
        # "This video has no recipe" is a correct answer about the video.
        # Retrying it would pay the same cost for the same answer.
        #
        # Two responses: the description finds nothing, then the video fallback
        # runs and also finds nothing. That is the case this asserts — a genuine
        # negative, not a fallback that could not run.
        run(queue.enqueue(VIDEO))
        w = worker(queue, responses=[EMPTY, EMPTY])
        job = run(w.run_once())

        assert job.state is JobState.SUCCEEDED
        assert w.stats.insufficient == 1
        assert w.stats.retried == 0

    def test_the_negative_result_is_cached_too(self, queue):
        run(queue.enqueue(VIDEO))
        run(worker(queue, responses=[EMPTY, EMPTY]).run_once())
        cached = run(queue.cached_recipe(VIDEO))
        assert cached["status"] == "insufficient_source_material"

    def test_a_fallback_that_could_not_run_retries_instead_of_caching(self, queue):
        """The bug a real production run surfaced.

        Every model in the chain 503'd on the video call, the description's
        "no recipe here" was cached as though it were the final answer, and the
        reader was told the creator keeps their recipe on their own site — when
        the truth was that we never managed to look at the video.

        "The description has no recipe" and "we could not check the video" are
        different facts, and only one of them is final.
        """
        run(queue.enqueue(VIDEO))
        w = worker(queue, responses=[EMPTY, LlmError("503 UNAVAILABLE")])
        job = run(w.run_once())

        assert job.state is JobState.QUEUED
        assert job.attempt == 1
        assert w.stats.retried == 1
        # `error` is deliberately cleared on a re-queue and only kept on the
        # final dead-letter, so the code is asserted there instead — see
        # test_exhausted_attempts_surface_the_model_being_down below.

        # Nothing cached: a retry must actually re-run rather than read back the
        # answer that caused it.
        assert run(queue.cached_recipe(VIDEO)) is None

    def test_exhausted_attempts_surface_the_model_being_down(self, queue):
        # If the video call never gets through, the honest outcome is
        # "llm_unavailable" — which JobProgress already words as "The model was
        # unavailable each time we tried" — and NOT a cached page telling the
        # reader the creator keeps their recipe elsewhere.
        run(queue.enqueue(VIDEO))
        w = Worker(
            queue=queue,
            fetcher=FakeFetcher(metadata()),
            provider=FakeProvider(
                responses=[EMPTY, LlmError("503"), EMPTY, LlmError("503"), EMPTY, LlmError("503")]
            ),
            sleep=Recorder(),
        )
        for _ in range(queue.max_attempts):
            job = run(w.run_once())

        assert job.state is JobState.FAILED
        assert job.error.code == "llm_unavailable"
        assert run(queue.cached_recipe(VIDEO)) is None


class TestFailure:
    def test_a_fetch_failure_retries(self, queue):
        run(queue.enqueue(VIDEO))
        w = worker(queue, fetch_error=FetchError(FetchFailure.UPSTREAM_ERROR, "boom"))
        job = run(w.run_once())

        assert job.state is JobState.QUEUED
        assert job.attempt == 1
        assert w.stats.retried == 1

    def test_an_llm_failure_retries(self, queue):
        run(queue.enqueue(VIDEO))
        w = worker(queue, responses=[LlmError("every model failed")])
        job = run(w.run_once())
        assert job.state is JobState.QUEUED
        assert w.stats.retried == 1

    def test_retries_wait_the_backoff_before_working(self, queue):
        clock = Recorder()
        run(queue.enqueue(VIDEO))
        w = Worker(
            queue=queue,
            fetcher=FakeFetcher(FetchError(FetchFailure.UPSTREAM_ERROR, "boom")),
            provider=FakeProvider(responses=[]),
            sleep=clock,
        )
        run(w.run_once())  # attempt 0 -> no wait
        run(w.run_once())  # attempt 1 -> 2s
        run(w.run_once())  # attempt 2 -> 4s
        assert clock.waits == [2.0, 4.0]

    def test_exhausting_attempts_dead_letters(self, queue, redis):
        run(queue.enqueue(VIDEO))
        w = Worker(
            queue=queue,
            fetcher=FakeFetcher(FetchError(FetchFailure.UPSTREAM_ERROR, "boom")),
            provider=FakeProvider(responses=[]),
            sleep=Recorder(),
        )
        for _ in range(queue.max_attempts):
            job = run(w.run_once())

        assert job.state is JobState.FAILED
        assert job.error.code == "upstream_error"
        assert w.stats.dead_lettered == 1
        assert redis.lists[DLQ_KEY] == [job.job_id]

    def test_an_unexpected_exception_does_not_kill_the_loop(self, queue):
        # A worker that dies on one bad video takes the whole queue with it.
        class Exploding:
            async def fetch(self, video_id):
                raise RuntimeError("something nobody predicted")

        run(queue.enqueue(VIDEO))
        w = Worker(
            queue=queue, fetcher=Exploding(), provider=FakeProvider(responses=[]), sleep=Recorder()
        )
        job = run(w.run_once())

        assert job.state is JobState.QUEUED  # retried, not crashed
        assert w.stats.retried == 1


class TestRunForever:
    def test_it_stops_when_asked_and_finishes_the_job_in_hand(self, queue):
        async def scenario():
            await queue.enqueue(VIDEO)
            stop = asyncio.Event()
            w = worker(queue)

            async def stop_soon():
                # Let the worker take and finish the queued job first.
                for _ in range(20):
                    await asyncio.sleep(0)
                stop.set()

            # Bounded: a loop that will not stop should fail this test in a
            # second, not hang the suite.
            await asyncio.wait_for(asyncio.gather(w.run_forever(stop), stop_soon()), timeout=5)
            return w

        w = run(scenario())
        # Whatever it claimed, it finished — a job abandoned mid-flight leaves a
        # RUNNING record nobody will ever complete.
        assert (
            w.stats.claimed
            == w.stats.succeeded + w.stats.insufficient + w.stats.retried + w.stats.dead_lettered
        )
