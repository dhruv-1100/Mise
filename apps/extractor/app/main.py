"""Mise extraction service.

Owns all LLM calls, caption fetching, and recipe parsing. The Next.js BFF talks
to this service and never calls an LLM itself.

Phase 4 replaces the HTTP surface here with gRPC and moves extraction onto a
queue, since it takes 10-40 seconds and cannot stay synchronous. This exists so
the pipeline is reachable and demonstrable before then.
"""

import os
from contextlib import asynccontextmanager
from typing import Annotated, Literal

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.llm import DEFAULT_MODEL_CHAIN, GeminiProvider, LlmError, LlmProvider
from app.pipeline import PipelineOutput, run_pipeline
from app.schema import ExtractionOk
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

    app.state.fetcher = YouTubeFetcher(youtube_key) if youtube_key else None
    app.state.provider = GeminiProvider(gemini_key) if gemini_key else None
    try:
        yield
    finally:
        if app.state.fetcher is not None:
            await app.state.fetcher.aclose()


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


__all__ = ["DEFAULT_MODEL_CHAIN", "app"]
