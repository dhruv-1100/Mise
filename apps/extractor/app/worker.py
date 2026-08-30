"""The worker loop: drains the queue and runs the pipeline.

Without this the queue is inert — jobs go in and nothing takes them out. It is
the piece that turns "extraction takes 10-40 seconds" from a problem into a
background job.

Everything it depends on is injected, including the clock. A retry loop that
sleeps for real seconds is a retry loop nobody tests, so `sleep` is a parameter
and the tests pass a recorder.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from app.llm import LlmError, LlmProvider
from app.pipeline import run_pipeline
from app.queue import ExtractionQueue, backoff_seconds
from app.schema import ExtractionOk, Job, JobStage
from app.youtube import DescriptionFetcher, FetchError

logger = logging.getLogger(__name__)

Sleep = Callable[[float], Awaitable[None]]

#: How long to wait when the queue is empty before looking again. Short enough
#: that a submitted job starts promptly, long enough not to hammer Redis.
IDLE_POLL_SECONDS = 1.0


@dataclass
class WorkerStats:
    claimed: int = 0
    succeeded: int = 0
    insufficient: int = 0
    retried: int = 0
    dead_lettered: int = 0
    slept: list[float] = field(default_factory=list)


@dataclass
class Worker:
    queue: ExtractionQueue
    fetcher: DescriptionFetcher
    provider: LlmProvider
    sleep: Sleep = asyncio.sleep
    stats: WorkerStats = field(default_factory=WorkerStats)

    async def run_once(self) -> Job | None:
        """Claim and process a single job. Returns None when the queue is empty.

        Never raises for an expected failure. A worker that dies on a bad video
        takes the whole queue down with it, so fetch and LLM failures become
        retries or dead letters rather than exceptions.
        """
        job = await self.queue.claim()
        if job is None:
            return None
        self.stats.claimed += 1

        # A retried job waits out its backoff here rather than in the queue, so
        # the queue stays a pure data structure with no notion of time.
        if job.attempt > 0:
            delay = backoff_seconds(job.attempt)
            self.stats.slept.append(delay)
            await self.sleep(delay)

        async def on_stage(stage: JobStage) -> None:
            await self.queue.set_stage(job, stage)

        try:
            out = await run_pipeline(
                fetcher=self.fetcher,
                provider=self.provider,
                video_id=job.video_id,
                on_stage=on_stage,
            )
        except FetchError as exc:
            return await self._fail(job, exc.failure.value, exc.detail or str(exc))
        except LlmError as exc:
            return await self._fail(job, "llm_unavailable", str(exc))
        except Exception as exc:
            logger.exception("unexpected failure on job %s", job.job_id)
            return await self._fail(job, "internal_error", repr(exc))

        if isinstance(out.result, ExtractionOk):
            self.stats.succeeded += 1
            recipe_json = out.result.recipe.model_dump_json(by_alias=True)
        elif out.fallback_error is not None:
            # The description had no recipe AND the video fallback could not run
            # — every model in the chain was saturated. That is not the same as
            # "there is no recipe here", and caching it as though it were tells
            # the reader the creator keeps their recipe elsewhere when the truth
            # is that we never managed to look.
            #
            # Retried rather than cached, using the backoff the queue already
            # has: a 503 across the whole chain is exactly the transient upstream
            # failure that machinery exists for. If every attempt fails the job
            # dead-letters as `llm_unavailable`, which the progress screen
            # already words honestly.
            self.stats.insufficient += 1
            return await self._fail(job, "llm_unavailable", out.fallback_error)
        else:
            # "No recipe here" is a correct answer about the video, not a
            # failure to retry. Caching it stops us paying for the same
            # negative result every time somebody pastes the link.
            self.stats.insufficient += 1
            recipe_json = out.result.model_dump_json(by_alias=True)

        return await self.queue.succeed(job, recipe_json)

    async def _fail(self, job: Job, code: str, message: str) -> Job:
        updated, will_retry = await self.queue.fail(job, code, message)
        if will_retry:
            self.stats.retried += 1
            logger.warning("job %s failed (%s), retrying", job.job_id, code)
        else:
            self.stats.dead_lettered += 1
            logger.error(
                "job %s dead-lettered after %s attempts: %s", job.job_id, updated.attempt, message
            )
        return updated

    async def run_forever(self, stop: asyncio.Event) -> None:
        """Drain until told to stop.

        Checks `stop` between jobs rather than cancelling mid-job: a job killed
        halfway leaves a RUNNING record nobody will ever finish, and the client
        watching it waits forever.
        """
        while not stop.is_set():
            job = await self.run_once()
            if job is None:
                await self.sleep(IDLE_POLL_SECONDS)


async def run_pool(
    *,
    size: int,
    queue: ExtractionQueue,
    fetcher: DescriptionFetcher,
    provider: LlmProvider,
    stop: asyncio.Event,
) -> list[Worker]:
    """Run `size` workers concurrently until `stop` is set.

    Two by default (BUILD_PLAN.md §4). Extraction is I/O-bound on the LLM call,
    so these are coroutines in one process rather than processes — the parallelism
    that matters is waiting on the network, not CPU.
    """
    workers = [Worker(queue=queue, fetcher=fetcher, provider=provider) for _ in range(size)]
    await asyncio.gather(*(w.run_forever(stop) for w in workers))
    return workers
