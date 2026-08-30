"""Mise extraction service.

Owns all LLM calls, caption fetching, and recipe parsing. The Next.js BFF talks
to this service and never calls an LLM itself.

Phase 4 replaces the HTTP surface here with gRPC and moves extraction onto a
queue, since it takes 10-40 seconds and cannot stay synchronous. This exists so
the pipeline is reachable and demonstrable before then.
"""

import asyncio
import json
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated, Literal

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from app.llm import DEFAULT_MODEL_CHAIN, GeminiProvider, LlmError, LlmProvider
from app.pipeline import PipelineOutput, run_pipeline
from app.queue import ExtractionQueue, QueueFull
from app.schema import ExtractionOk, JobState
from app.youtube import (
    DescriptionFetcher,
    FetchError,
    FetchFailure,
    YouTubeFetcher,
    parse_video_id,
)


class ErrorEnvelope(BaseModel):
    """Every failure leaves this service in this shape, never as a raw exception.

    A non-negotiable in CLAUDE.md. The `code` is a stable machine-readable
    string so the BFF can branch on it without parsing prose.
    """

    error: str = Field(description="Stable machine-readable code.")
    detail: str = Field(default="", description="Human-readable context.")


class Health(BaseModel):
    """Liveness only.

    Deliberately carries no dependency status: conflating liveness with
    readiness makes an orchestrator restart a healthy service because a
    downstream is slow. Readiness arrives in Phase 7 with the Prometheus
    surface.
    """

    status: str
    service: str
    version: str


class ExtractRequest(BaseModel):
    """A bare video id or any YouTube URL shape."""

    video: str = Field(min_length=1, max_length=512, examples=["bUounn_Bmy4"])


class ExtractStats(BaseModel):
    description_lines: int
    lines_removed: int
    chapters_found: int
    input_tokens: int
    output_tokens: int
    total_tokens: int
    model: str
    canonicalised_quantities: int


class ExtractResponse(BaseModel):
    status: Literal["ok", "insufficient_source_material"]
    video_id: str
    #: Present only when status is "ok".
    recipe: dict | None = None
    #: Present only when status is "insufficient_source_material".
    reason: str | None = None
    stats: ExtractStats


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Build the fetcher and provider once.

    Credentials are read at startup rather than per request, so a missing key is
    a loud failure on boot instead of a surprise on the first extraction.
    """
    youtube_key = os.environ.get("YOUTUBE_API_KEY", "")
    gemini_key = os.environ.get("GEMINI_API_KEY", "")
    redis_url = os.environ.get("REDIS_URL", "")

    app.state.fetcher = YouTubeFetcher(youtube_key) if youtube_key else None
    app.state.provider = GeminiProvider(gemini_key) if gemini_key else None

    app.state.redis = None
    app.state.queue = None
    if redis_url:
        # Imported here so the module loads without redis installed, and so
        # tests that never touch the queue never construct a client.
        from redis.asyncio import from_url

        app.state.redis = from_url(redis_url, decode_responses=True)
        app.state.queue = ExtractionQueue(redis=app.state.redis)

    try:
        yield
    finally:
        if app.state.fetcher is not None:
            await app.state.fetcher.aclose()
        if app.state.redis is not None:
            await app.state.redis.aclose()


#: How often the SSE stream re-reads the job. The queue has no pub/sub, so this
#: polls Redis; cheap, and it keeps the queue a plain data structure.
SSE_POLL_SECONDS = 0.5
#: A job that never terminates must not hold a connection open forever.
#: Matches STREAM_TIMEOUT_SECONDS in grpc_server.py — the two transports serve
#: the same queue and a job is not more patient over one than the other.
SSE_TIMEOUT_SECONDS = 600


app = FastAPI(
    title="Mise Extractor",
    version="0.0.0",
    description="Video-to-recipe extraction service.",
    lifespan=lifespan,
)


@app.exception_handler(FetchError)
async def _fetch_error_handler(_: Request, exc: FetchError) -> JSONResponse:
    status = {
        FetchFailure.NOT_A_YOUTUBE_URL: 400,
        FetchFailure.VIDEO_NOT_FOUND: 404,
        FetchFailure.QUOTA_EXCEEDED: 429,
        FetchFailure.NOT_AUTHORISED: 502,
        FetchFailure.UPSTREAM_ERROR: 502,
    }[exc.failure]
    return JSONResponse(
        status_code=status,
        content=ErrorEnvelope(error=exc.failure.value, detail=exc.detail).model_dump(),
    )


@app.exception_handler(LlmError)
async def _llm_error_handler(_: Request, exc: LlmError) -> JSONResponse:
    return JSONResponse(
        status_code=502,
        content=ErrorEnvelope(error="llm_unavailable", detail=str(exc)).model_dump(),
    )


def get_fetcher(request: Request) -> DescriptionFetcher:
    fetcher = request.app.state.fetcher
    if fetcher is None:
        raise HTTPException(
            status_code=503,
            detail=ErrorEnvelope(
                error="not_configured", detail="YOUTUBE_API_KEY is not set"
            ).model_dump(),
        )
    return fetcher


def get_queue(request: Request) -> ExtractionQueue:
    queue = request.app.state.queue
    if queue is None:
        raise HTTPException(
            status_code=503,
            detail=ErrorEnvelope(
                error="not_configured", detail="REDIS_URL is not set"
            ).model_dump(),
        )
    return queue


def get_provider(request: Request) -> LlmProvider:
    provider = request.app.state.provider
    if provider is None:
        raise HTTPException(
            status_code=503,
            detail=ErrorEnvelope(
                error="not_configured", detail="GEMINI_API_KEY is not set"
            ).model_dump(),
        )
    return provider


@app.get("/healthz", response_model=Health, tags=["ops"])
async def healthz() -> Health:
    return Health(status="ok", service="mise-extractor", version=app.version)


@app.post(
    "/extract",
    response_model=ExtractResponse,
    tags=["extraction"],
    responses={
        400: {"model": ErrorEnvelope},
        404: {"model": ErrorEnvelope},
        429: {"model": ErrorEnvelope},
        502: {"model": ErrorEnvelope},
        503: {"model": ErrorEnvelope},
    },
)
async def extract(
    body: ExtractRequest,
    fetcher: Annotated[DescriptionFetcher, Depends(get_fetcher)],
    provider: Annotated[LlmProvider, Depends(get_provider)],
) -> ExtractResponse:
    """Turn a YouTube video into a structured recipe.

    Synchronous, and it takes 10-40 seconds. Phase 4 moves this onto a Redis
    queue with SSE status, which is the only reason to accept that latency here.

    An `insufficient_source_material` response is a 200, not an error: ADR 0001
    measured one description in five carrying no recipe at all, and that is a
    correct answer about the video rather than a failure of the service.
    """
    video_id = parse_video_id(body.video)
    output: PipelineOutput = await run_pipeline(
        fetcher=fetcher, provider=provider, video_id=video_id
    )
    stats = output.stats

    return ExtractResponse(
        status=output.result.status,
        video_id=video_id,
        recipe=(
            output.result.recipe.model_dump(by_alias=True, mode="json")
            if isinstance(output.result, ExtractionOk)
            else None
        ),
        reason=(None if isinstance(output.result, ExtractionOk) else output.result.reason.value),
        stats=ExtractStats(
            description_lines=stats.description_lines,
            lines_removed=stats.lines_removed,
            chapters_found=stats.chapters_found,
            input_tokens=stats.input_tokens,
            output_tokens=stats.output_tokens,
            total_tokens=stats.total_tokens,
            model=stats.model,
            canonicalised_quantities=stats.canonicalised_quantities,
        ),
    )


class EnqueueResponse(BaseModel):
    job: dict
    #: False when an existing job was returned — already in flight, or cached.
    created: bool


@app.post(
    "/jobs",
    response_model=EnqueueResponse,
    tags=["extraction"],
    responses={
        400: {"model": ErrorEnvelope},
        429: {"model": ErrorEnvelope},
        503: {"model": ErrorEnvelope},
    },
)
async def enqueue(
    body: ExtractRequest,
    queue: Annotated[ExtractionQueue, Depends(get_queue)],
) -> EnqueueResponse:
    """Submit a video for extraction and get a job back immediately.

    The asynchronous counterpart to POST /extract, which blocks for the full
    10-40 seconds. Watch /jobs/{job_id}/events for progress.
    """
    video_id = parse_video_id(body.video)
    try:
        job, created = await queue.enqueue(video_id)
    except QueueFull as exc:
        # Backpressure with an actionable hint, rather than accepting work we
        # cannot get to (BUILD_PLAN.md §4).
        raise HTTPException(
            status_code=429,
            detail=ErrorEnvelope(
                error="queue_full",
                detail=f"queue depth {exc.depth} is at capacity",
            ).model_dump(),
            headers={"Retry-After": str(exc.retry_after_seconds)},
        ) from exc
    return EnqueueResponse(job=job.model_dump(by_alias=True, mode="json"), created=created)


@app.get("/jobs/{job_id}", tags=["extraction"], responses={404: {"model": ErrorEnvelope}})
async def job_status(
    job_id: str,
    queue: Annotated[ExtractionQueue, Depends(get_queue)],
) -> dict:
    job = await queue.get(job_id)
    if job is None:
        raise HTTPException(
            status_code=404,
            detail=ErrorEnvelope(error="job_not_found", detail=job_id).model_dump(),
        )
    return job.model_dump(by_alias=True, mode="json")


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


async def _job_events(queue: ExtractionQueue, job_id: str) -> AsyncIterator[str]:
    """Emit on every change, then close once the job is terminal.

    Only sending on CHANGE is the point: an idle job produces no traffic, and a
    client that connects late gets current state immediately rather than
    waiting for the next transition.
    """
    last: tuple | None = None
    waited = 0.0
    while waited < SSE_TIMEOUT_SECONDS:
        job = await queue.get(job_id)
        if job is None:
            yield _sse("error", {"error": "job_not_found", "detail": job_id})
            return

        fingerprint = (job.state, job.stage, job.attempt)
        if fingerprint != last:
            payload = job.model_dump(by_alias=True, mode="json")
            if job.state is JobState.SUCCEEDED:
                payload["recipe"] = await queue.cached_recipe(job.video_id)
            yield _sse("status", payload)
            last = fingerprint

        if job.state in (JobState.SUCCEEDED, JobState.FAILED):
            return

        await asyncio.sleep(SSE_POLL_SECONDS)
        waited += SSE_POLL_SECONDS

    yield _sse("error", {"error": "stream_timeout", "detail": job_id})


@app.get("/jobs/{job_id}/events", tags=["extraction"])
async def job_events(
    job_id: str,
    queue: Annotated[ExtractionQueue, Depends(get_queue)],
) -> StreamingResponse:
    """Server-Sent Events for job progress.

    SSE rather than gRPC streaming because the browser is the consumer here and
    cannot speak gRPC without a proxy. The BFF uses the gRPC StreamStatus for
    the same data.
    """
    return StreamingResponse(
        _job_events(queue, job_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            # Without this, an nginx or Cloud Run proxy may buffer the stream
            # and deliver every event at once when the job finishes — which
            # looks exactly like the spinner this replaced.
            "X-Accel-Buffering": "no",
        },
    )


__all__ = ["DEFAULT_MODEL_CHAIN", "app"]
