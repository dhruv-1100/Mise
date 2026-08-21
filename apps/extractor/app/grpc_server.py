"""gRPC surface, implementing packages/schema/extractor.proto.

Two transports serve the same queue: gRPC for the BFF (typed, streaming,
service-to-service) and HTTP/SSE for browsers, which cannot speak gRPC without
a proxy. Both call the same `ExtractionQueue`, so neither can drift into having
its own semantics.

`Job` exists three times — Pydantic, zod, protobuf — and this module is the only
place the protobuf form is converted. Keeping that mapping in one function is
what makes the third representation cheap rather than a third thing to drift.
"""

from __future__ import annotations

import asyncio
import logging

import grpc

from app.gen import extractor_pb2 as pb
from app.gen import extractor_pb2_grpc as pb_grpc
from app.queue import ExtractionQueue, QueueFull
from app.schema import Job, JobStage, JobState
from app.youtube import FetchError, parse_video_id

logger = logging.getLogger(__name__)

#: How often StreamStatus re-reads the job while waiting. The queue has no
#: pub/sub, so this polls Redis — cheap, and it keeps the queue a plain data
#: structure. Swap for a Redis channel when the cost shows up in Phase 7.
POLL_SECONDS = 0.5
#: A job that never terminates must not hold a stream open forever.
STREAM_TIMEOUT_SECONDS = 300

_STATE = {
    JobState.QUEUED: pb.JOB_STATE_QUEUED,
    JobState.RUNNING: pb.JOB_STATE_RUNNING,
    JobState.SUCCEEDED: pb.JOB_STATE_SUCCEEDED,
    JobState.FAILED: pb.JOB_STATE_FAILED,
}
_STAGE = {
    JobStage.FETCHING: pb.JOB_STAGE_FETCHING,
    JobStage.NORMALIZING: pb.JOB_STAGE_NORMALIZING,
    JobStage.EXTRACTING: pb.JOB_STAGE_EXTRACTING,
    JobStage.CANONICALISING: pb.JOB_STAGE_CANONICALISING,
}


def to_proto(job: Job, recipe_json: str = "") -> pb.Job:
    """Pydantic Job -> protobuf Job.

    proto3 scalars have no presence, so absent timestamps become "" rather than
    null. Consumers read empty-string as absent; making them optional would
    complicate every caller for nothing.
    """
    message = pb.Job(
        job_id=job.job_id,
        video_id=job.video_id,
        state=_STATE[job.state],
        attempt=job.attempt,
        queued_at=job.queued_at.isoformat(),
        started_at=job.started_at.isoformat() if job.started_at else "",
        finished_at=job.finished_at.isoformat() if job.finished_at else "",
        stage=_STAGE[job.stage] if job.stage else pb.JOB_STAGE_UNSPECIFIED,
        cached=job.cached,
        recipe_json=recipe_json,
    )
    if job.error is not None:
        message.error.CopyFrom(pb.JobError(code=job.error.code, message=job.error.message))
    return message


def is_terminal(job: Job) -> bool:
    return job.state in (JobState.SUCCEEDED, JobState.FAILED)


class ExtractorService(pb_grpc.ExtractorServicer):
    def __init__(self, queue: ExtractionQueue, version: str = "0.0.0") -> None:
        self._queue = queue
        self._version = version

    async def Extract(self, request: pb.ExtractRequest, context) -> pb.ExtractResponse:
        try:
            video_id = parse_video_id(request.video)
        except FetchError as exc:
            await context.abort(grpc.StatusCode.INVALID_ARGUMENT, exc.failure.value)

        try:
            job, created = await self._queue.enqueue(video_id)
        except QueueFull as exc:
            # RESOURCE_EXHAUSTED is the gRPC equivalent of 429; the retry hint
            # rides in trailing metadata so a client can honour it.
            await context.abort(
                grpc.StatusCode.RESOURCE_EXHAUSTED,
                f"queue at capacity ({exc.depth}); retry in {exc.retry_after_seconds}s",
            )

        recipe = "" if not job.cached else await self._recipe_json(job.video_id)
        return pb.ExtractResponse(job=to_proto(job, recipe), created=created)

    async def GetStatus(self, request: pb.GetStatusRequest, context) -> pb.Job:
        job = await self._queue.get(request.job_id)
        if job is None:
            await context.abort(grpc.StatusCode.NOT_FOUND, "no such job")
        return to_proto(job, await self._recipe_for(job))

    async def StreamStatus(self, request: pb.StreamStatusRequest, context):
        """Emit on every change, then complete once the job is terminal.

        Only pushing on CHANGE is the point: a client that reconnects gets the
        current state immediately, and an idle job produces no traffic.
        """
        job = await self._queue.get(request.job_id)
        if job is None:
            await context.abort(grpc.StatusCode.NOT_FOUND, "no such job")

        last: tuple | None = None
        waited = 0.0
        while True:
            fingerprint = (job.state, job.stage, job.attempt)
            if fingerprint != last:
                yield to_proto(job, await self._recipe_for(job))
                last = fingerprint
            if is_terminal(job):
                return
            if waited >= STREAM_TIMEOUT_SECONDS:
                await context.abort(grpc.StatusCode.DEADLINE_EXCEEDED, "job did not finish")
            await asyncio.sleep(POLL_SECONDS)
            waited += POLL_SECONDS
            refreshed = await self._queue.get(request.job_id)
            if refreshed is None:
                # The record expired mid-stream. Ending cleanly beats holding a
                # stream open on something nobody can observe any more.
                return
            job = refreshed

    async def Health(self, request: pb.HealthRequest, context) -> pb.HealthResponse:
        return pb.HealthResponse(status="ok", service="mise-extractor", version=self._version)

    async def _recipe_for(self, job: Job) -> str:
        return await self._recipe_json(job.video_id) if job.state is JobState.SUCCEEDED else ""

    async def _recipe_json(self, video_id: str) -> str:
        import json

        recipe = await self._queue.cached_recipe(video_id)
        return json.dumps(recipe) if recipe is not None else ""


async def serve(queue: ExtractionQueue, port: int = 50051) -> grpc.aio.Server:
    server = grpc.aio.server()
    pb_grpc.add_ExtractorServicer_to_server(ExtractorService(queue), server)
    server.add_insecure_port(f"[::]:{port}")
    await server.start()
    logger.info("gRPC listening on :%d", port)
    return server
