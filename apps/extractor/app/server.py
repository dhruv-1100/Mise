"""Production entrypoint: gRPC surface and worker pool in one process.

Until this existed, `grpc_server.serve()` and `worker.run_pool()` were library
functions with no caller outside the tests — the container ran `uvicorn
app.main:app`, which serves the HTTP surface and nothing else. A Cloud Run
revision built from that image answers health checks and is unreachable by the
BFF, which speaks gRPC.

WHY ONE PROCESS. Cloud Run routes traffic to exactly one port per container, so
the gRPC server takes $PORT and the FastAPI app is not exposed in production; it
stays the local development path documented in CLAUDE.md. The worker pool has no
port of its own and shares this process rather than taking a second service.

WHY THAT IS NOT MERELY CONVENIENT. Cloud Run throttles a container's CPU to
near-zero between requests unless CPU is always allocated, which is a billed
setting. This service scales to zero on purpose (see infra/cloudrun.tf), so the
worker only makes progress while some request is holding the instance awake. In
practice the BFF opens StreamStatus immediately after Extract and holds it for
the life of the job, which is exactly the window the worker needs. The failure
mode this leaves is real and documented in docs/adr/0005-cloud-run-topology.md:
if every client disconnects mid-extraction the job stalls until the next request
wakes an instance, at which point the worker claims it again.
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal

from app.grpc_server import serve
from app.llm import GeminiProvider
from app.queue import ExtractionQueue
from app.worker import run_pool
from app.youtube import YouTubeFetcher

logger = logging.getLogger(__name__)

#: Cloud Run injects PORT and it is not always 8080. Honouring it is not
#: optional: a container listening elsewhere passes its startup probe only if
#: the probe is wrong too, and then receives no traffic.
DEFAULT_PORT = 8080

#: Two workers (BUILD_PLAN.md §4). Extraction is I/O-bound on the LLM call, so
#: these are coroutines in one process — the parallelism that matters is waiting
#: on the network, not CPU.
DEFAULT_POOL_SIZE = 2

#: Cloud Run sends SIGTERM and follows with SIGKILL ten seconds later. Ask the
#: gRPC server for slightly less than that so in-flight RPCs get a chance to
#: finish and the process exits on its own terms rather than being killed.
SHUTDOWN_GRACE_SECONDS = 8.0


class MissingConfig(RuntimeError):
    """A required environment variable is absent.

    Raised at startup rather than on the first request. A service that boots
    healthy and fails every extraction is worse than one that refuses to boot:
    the first looks fine on a dashboard.
    """


def _require(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        raise MissingConfig(f"{name} is not set")
    return value


async def main() -> None:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    port = int(os.environ.get("PORT", DEFAULT_PORT))
    pool_size = int(os.environ.get("WORKER_POOL_SIZE", DEFAULT_POOL_SIZE))

    # Every one of these is required in production. The HTTP app tolerates their
    # absence because it degrades to a subset of routes; this process has no
    # useful subset — without Redis there is no queue, and without the API keys
    # there is nothing to put in it.
    youtube_key = _require("YOUTUBE_API_KEY")
    gemini_key = _require("GEMINI_API_KEY")
    redis_url = _require("REDIS_URL")

    from redis.asyncio import from_url

    redis = from_url(redis_url, decode_responses=True)
    queue = ExtractionQueue(redis=redis)
    fetcher = YouTubeFetcher(youtube_key)
    provider = GeminiProvider(gemini_key)

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()

    # SIGTERM is the normal way this process ends: Cloud Run sends it when
    # scaling an instance down. SIGINT is for Ctrl-C locally.
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)

    server = await serve(queue, port=port)
    logger.info("extractor up: gRPC on :%d, %d worker(s)", port, pool_size)

    workers = asyncio.create_task(
        run_pool(
            size=pool_size,
            queue=queue,
            fetcher=fetcher,
            provider=provider,
            stop=stop,
        )
    )

    try:
        await stop.wait()
        logger.info("shutting down")
    finally:
        # Order matters. Stop accepting new RPCs first, so nothing new is
        # enqueued while the workers are winding down.
        await server.stop(SHUTDOWN_GRACE_SECONDS)

        # run_forever checks `stop` between jobs, never mid-job: a job cancelled
        # halfway leaves a RUNNING record nobody will finish. If the grace period
        # expires first, Cloud Run kills the process and the job's lease lapses,
        # which the queue's retry path already handles.
        workers.cancel()
        await asyncio.gather(workers, return_exceptions=True)

        await fetcher.aclose()
        await redis.aclose()


if __name__ == "__main__":
    asyncio.run(main())
