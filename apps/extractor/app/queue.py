"""Redis-backed extraction queue.

Extraction takes 10-40 seconds against the LLM, so it cannot be a synchronous
request (BUILD_PLAN.md §4). This is the job semantics layer: enqueue, claim,
retry with exponential backoff, dead-letter, and cache.

Redis sits behind `RedisLike` for the same reason the LLM and YouTube do —
the interesting logic here is the state machine, and it should be testable
without a server, a network, or a running Upstash instance.

Four behaviours are deliberate rather than incidental:

* **Idempotency by video_id.** Re-submitting a video already queued or running
  returns the existing job instead of creating a second one. Two workers
  extracting the same video costs twice and can produce two different recipes.
* **Cache before queue.** A video extracted once is never extracted again. The
  cache is checked at enqueue time, so a hit never occupies a worker at all.
* **Backpressure.** Queue depth is capped, and a full queue rejects with a
  retry hint rather than accepting work it cannot do.
* **Dead-letter.** A job that exhausts its retries lands somewhere inspectable
  instead of vanishing. An empty DLQ is a Phase 7 alert.
"""

from __future__ import annotations

import json
import logging
import secrets
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

from app.archive import NullArchive, RecipeArchive
from app.schema import Job, JobError, JobStage, JobState

QUEUE_KEY = "mise:queue"
DLQ_KEY = "mise:dlq"
logger = logging.getLogger(__name__)

JOB_KEY = "mise:job:{job_id}"
VIDEO_KEY = "mise:video:{video_id}"
CACHE_KEY = "mise:cache:{video_id}"
BUDGET_KEY = "mise:budget:{day}"

#: Above this, reject rather than accept work we cannot get to.
MAX_QUEUE_DEPTH = 100
#: Attempts before a job is dead-lettered.
MAX_ATTEMPTS = 3
#: New extractions accepted per UTC day.
#:
#: The token on Extract stops strangers calling the service directly. It does
#: nothing about the public form in front of it, and each new video can cost two
#: Gemini calls. Generous for one person cooking, and a hard ceiling on what a
#: script hammering the form can spend.
DAILY_EXTRACTION_LIMIT = 100
#: Extracted recipes are cached for a week; a description rarely changes.
CACHE_TTL_SECONDS = 7 * 24 * 3600
#: "No recipe here" is cached for hours, not a week.
#:
#: A successful extraction is a fact about the video. An insufficient one is a
#: statement about what THIS pipeline could get out of it today, and that
#: changes: ADR 0006 added a video fallback that recovers exactly these cases,
#: and every video already cached as insufficient kept serving the old answer
#: for up to seven days afterwards — the improvement shipped and users could not
#: see it. Short enough that a pipeline change reaches everyone the same day,
#: long enough that retrying a failing video in one sitting is still free.
NEGATIVE_CACHE_TTL_SECONDS = 6 * 3600
#: Job records outlive the work so a client can still poll a finished job.
JOB_TTL_SECONDS = 24 * 3600
#: How long a RUNNING job may go unfinished before it is presumed abandoned.
#:
#: Cloud Run gives a shutting-down instance ten seconds and an extraction takes
#: up to five minutes, so an instance can die holding a job. Nothing else will
#: ever finish that job, and until it is reclaimed every resubmission of the
#: video is handed the same dead record. Matches the request timeout in
#: infra/cloudrun.tf, which is the longest any request could have kept it alive.
JOB_LEASE_SECONDS = 15 * 60


class QueueFull(RuntimeError):
    """Backpressure. Carries how long the caller should wait."""

    def __init__(self, depth: int, retry_after_seconds: int = 30) -> None:
        super().__init__(f"queue depth {depth} is at capacity")
        self.depth = depth
        self.retry_after_seconds = retry_after_seconds


class DailyLimitReached(RuntimeError):
    """The day's budget of new extractions is spent."""


class RedisLike(Protocol):
    """The subset of Redis this module uses."""

    async def get(self, key: str) -> str | None: ...
    async def set(self, key: str, value: str, ex: int | None = None) -> Any: ...
    async def delete(self, *keys: str) -> Any: ...
    async def llen(self, key: str) -> int: ...
    async def rpush(self, key: str, value: str) -> Any: ...
    async def lpop(self, key: str) -> str | None: ...
    async def incr(self, key: str) -> int: ...
    async def expire(self, key: str, seconds: int) -> Any: ...


def _now() -> datetime:
    return datetime.now(UTC)


def _dump(job: Job) -> str:
    return job.model_dump_json(by_alias=True)


def _is_insufficient(recipe_json: str) -> bool:
    """Whether this result is a "no recipe here" rather than a recipe.

    Reads the payload rather than taking a flag, because `succeed` is called
    from two places and a flag is one more thing a caller can get wrong. The
    marker is the same `status` field the BFF discriminates on, so the two
    cannot disagree about what an insufficient result looks like.
    """
    return '"insufficient_source_material"' in recipe_json


def _lease_lapsed(job: Job) -> bool:
    """Whether a RUNNING job has outlived any worker that could be holding it."""
    if job.state is not JobState.RUNNING or job.started_at is None:
        return False
    return _now() - job.started_at > timedelta(seconds=JOB_LEASE_SECONDS)


def backoff_seconds(attempt: int, *, base: float = 2.0, cap: float = 60.0) -> float:
    """Exponential backoff for retry `attempt` (1-based).

    Deterministic and without jitter: this is a single-queue system with a tiny
    worker pool, so the thundering-herd problem jitter solves does not exist,
    and a predictable delay is far easier to assert on and to reason about
    during an incident.
    """
    if attempt < 1:
        return 0.0
    return min(cap, base**attempt)


@dataclass
class ExtractionQueue:
    redis: RedisLike
    max_depth: int = MAX_QUEUE_DEPTH
    max_attempts: int = MAX_ATTEMPTS
    daily_limit: int = DAILY_EXTRACTION_LIMIT

    #: Durable storage under the cache. Defaults to a no-op, so a deployment
    #: without AWS behaves exactly as it did before this existed — and so every
    #: test that does not care about archiving stays unchanged.
    archive: RecipeArchive = field(default_factory=NullArchive)

    # --- enqueue -----------------------------------------------------------

    async def enqueue(self, video_id: str) -> tuple[Job, bool]:
        """Submit a video. Returns (job, is_new).

        Checks cache first, then existing in-flight work, then capacity. Order
        matters: a cache hit must not be rejected for backpressure, because
        serving it costs nothing. "Cache" includes the archive, so a recipe
        that aged out of Redis costs one GET rather than another extraction.
        """
        if await self.cached_recipe(video_id) is not None:
            now = _now()
            job = Job(
                job_id=_new_job_id(),
                video_id=video_id,
                state=JobState.SUCCEEDED,
                attempt=0,
                queued_at=now,
                started_at=now,
                finished_at=now,
                stage=None,
                error=None,
                cached=True,
            )
            await self._save(job)
            return job, False

        existing = await self._job_for_video(video_id)
        if existing is not None and _lease_lapsed(existing):
            # Through `fail` so the attempt counts: a video that kills its
            # worker every time ends in the dead-letter queue, not in a loop.
            return await self.fail(
                existing, "worker_lost", "The instance running this job went away."
            )
        if existing is not None and existing.state in (JobState.QUEUED, JobState.RUNNING):
            # Idempotent: the same video in flight returns the same job rather
            # than a second one racing it.
            return existing, False

        depth = await self.redis.llen(QUEUE_KEY)
        if depth >= self.max_depth:
            raise QueueFull(depth)

        # Last, so only work that would really start spends the budget. Retries
        # and reclaimed jobs never reach this line.
        budget_key = BUDGET_KEY.format(day=_now().date().isoformat())
        spent = await self.redis.incr(budget_key)
        await self.redis.expire(budget_key, 48 * 3600)
        if spent > self.daily_limit:
            raise DailyLimitReached

        job = Job(
            job_id=_new_job_id(),
            video_id=video_id,
            state=JobState.QUEUED,
            attempt=0,
            queued_at=_now(),
            started_at=None,
            finished_at=None,
            stage=None,
            error=None,
            cached=False,
        )
        await self._save(job)
        await self.redis.set(VIDEO_KEY.format(video_id=video_id), job.job_id, ex=JOB_TTL_SECONDS)
        await self.redis.rpush(QUEUE_KEY, job.job_id)
        return job, True

    # --- worker side -------------------------------------------------------

    async def claim(self) -> Job | None:
        """Take the next job, marking it running."""
        job_id = await self.redis.lpop(QUEUE_KEY)
        if job_id is None:
            return None
        job = await self.get(job_id)
        if job is None:
            # The record expired out from under its queue entry. Skip rather
            # than crash the worker on a job nobody can observe any more.
            return await self.claim()
        updated = job.model_copy(
            update={
                "state": JobState.RUNNING,
                "started_at": _now(),
                "attempt": job.attempt,
                "stage": JobStage.FETCHING,
            }
        )
        await self._save(updated)
        return updated

    async def set_stage(self, job: Job, stage: JobStage) -> Job:
        updated = job.model_copy(update={"stage": stage})
        await self._save(updated)
        return updated

    async def succeed(self, job: Job, recipe_json: str) -> Job:
        insufficient = _is_insufficient(recipe_json)
        await self.redis.set(
            CACHE_KEY.format(video_id=job.video_id),
            recipe_json,
            ex=NEGATIVE_CACHE_TTL_SECONDS if insufficient else CACHE_TTL_SECONDS,
        )
        # Recipes only. "No recipe here" is a statement about what this pipeline
        # managed today, and archiving it would bring it back after every expiry
        # and undo NEGATIVE_CACHE_TTL_SECONDS.
        #
        # After Redis, and guarded here rather than only inside the archive.
        # The extraction has already succeeded; failing it because the durable
        # copy did not land would trade a working result for no result.
        #
        # S3Archive swallows its own errors too, so this looks redundant. It is
        # not: RecipeArchive is a Protocol, and a Protocol cannot require an
        # implementation to be best-effort. Guarding at the call site makes the
        # guarantee true for every implementation rather than for the one that
        # remembered.
        if not insufficient:
            try:
                await self.archive.put(job.video_id, recipe_json)
            except Exception as exc:
                logger.warning("archive write failed for %s: %s", job.video_id, exc)
        updated = job.model_copy(
            update={
                "state": JobState.SUCCEEDED,
                "finished_at": _now(),
                "stage": None,
                "error": None,
            }
        )
        await self._save(updated)
        await self.redis.delete(VIDEO_KEY.format(video_id=job.video_id))
        return updated

    async def fail(
        self, job: Job, code: str, message: str, *, permanent: bool = False
    ) -> tuple[Job, bool]:
        """Record a failure. Returns (job, will_retry).

        Retries re-queue with the attempt count incremented; the final failure
        dead-letters. `backoff_seconds` says how long a worker should wait
        before picking the retry up — enforcing that delay is the worker loop's
        job, not the queue's, so this stays free of sleeping.

        `permanent` is for a failure no retry could change. The job ends FAILED
        so the client hears about it, but it is not a dead letter: the DLQ is
        what the alarm watches, and a wrong link is not an incident.
        """
        attempt = job.attempt + 1
        if not permanent and attempt < self.max_attempts:
            retried = job.model_copy(
                update={
                    "state": JobState.QUEUED,
                    "attempt": attempt,
                    "started_at": None,
                    "stage": None,
                    "error": None,
                }
            )
            await self._save(retried)
            await self.redis.rpush(QUEUE_KEY, retried.job_id)
            return retried, True

        dead = job.model_copy(
            update={
                "state": JobState.FAILED,
                "attempt": attempt,
                "finished_at": _now(),
                "stage": None,
                "error": JobError(code=code, message=message),
            }
        )
        await self._save(dead)
        if not permanent:
            await self.redis.rpush(DLQ_KEY, dead.job_id)
        await self.redis.delete(VIDEO_KEY.format(video_id=job.video_id))
        return dead, False

    # --- reads -------------------------------------------------------------

    async def get(self, job_id: str) -> Job | None:
        raw = await self.redis.get(JOB_KEY.format(job_id=job_id))
        return Job.model_validate_json(raw) if raw else None

    async def cached_recipe(self, video_id: str) -> dict[str, Any] | None:
        """The recipe, from the cache or from under it.

        Redis first, then the archive. A hit in the archive is re-warmed into
        Redis on the way out: the next reader should not pay for the same S3
        round trip, and the entry that expired was a cache entry, not the
        recipe.

        Returns None only when neither tier has it — which is the one case that
        genuinely needs an extraction.

        Every Redis call here is guarded, which the write path deliberately is
        not. On 2026-10-20 Upstash deleted the free-tier database after fourteen
        days without traffic, which showed that an unguarded `get` on this line
        would have raised out of the servicer without ever consulting the
        archive. A dead cache must degrade to "slower", not to "down".

        Reads degrade; writes do not. An enqueue that cannot reach Redis has
        nowhere to put the job, and accepting one it cannot store is the worse
        failure — see `enqueue`.
        """
        try:
            raw = await self.redis.get(CACHE_KEY.format(video_id=video_id))
        except Exception as exc:
            logger.warning("cache read failed for %s, trying the archive: %s", video_id, exc)
            raw = None
        if raw:
            return json.loads(raw)

        try:
            archived = await self.archive.get(video_id)
        except Exception as exc:
            logger.warning("archive read failed for %s: %s", video_id, exc)
            return None
        if archived is None:
            return None

        # Re-warm, in the compact form `succeed` wrote. Always the positive TTL:
        # only recipes are archived.
        try:
            await self.redis.set(
                CACHE_KEY.format(video_id=video_id),
                json.dumps(archived, separators=(",", ":"), ensure_ascii=False),
                ex=CACHE_TTL_SECONDS,
            )
        except Exception as exc:
            # The recipe is already in hand. Discarding it because the cache
            # could not be re-warmed would throw away a successful read to
            # report a failure of an optimisation.
            logger.warning("cache re-warm failed for %s: %s", video_id, exc)
        return archived

    async def depth(self) -> int:
        return await self.redis.llen(QUEUE_KEY)

    async def dead_letter_depth(self) -> int:
        """Non-zero is a Phase 7 alert: work was accepted and never done."""
        return await self.redis.llen(DLQ_KEY)

    # --- internals ---------------------------------------------------------

    async def _save(self, job: Job) -> None:
        await self.redis.set(JOB_KEY.format(job_id=job.job_id), _dump(job), ex=JOB_TTL_SECONDS)

    async def _job_for_video(self, video_id: str) -> Job | None:
        job_id = await self.redis.get(VIDEO_KEY.format(video_id=video_id))
        return await self.get(job_id) if job_id else None


def _new_job_id() -> str:
    """Roughly time-ordered id: a microsecond prefix plus randomness.

    Not a UUID4, because job ids end up in logs and a lexicographic sort that
    approximates creation order is worth more during an incident than the extra
    entropy is.

    "Roughly" is the honest word. Ids created within the same microsecond are
    ordered by their random suffix, not by time. Tightening that further would
    need a shared counter, and with several Cloud Run instances enqueueing
    concurrently there is no ordering to recover anyway — clocks across
    instances do not agree at that resolution. The guarantee is therefore the
    timestamp prefix, not the whole id.
    """
    stamp = int(_now().timestamp() * 1_000_000)
    return f"{stamp:016d}{secrets.token_hex(6)}"


def next_retry_at(job: Job) -> datetime:
    """When a retried job becomes eligible."""
    return _now() + timedelta(seconds=backoff_seconds(job.attempt))
