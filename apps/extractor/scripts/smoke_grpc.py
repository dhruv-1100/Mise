"""Post-deploy smoke test: is the deployed revision actually usable?

`gcloud run deploy` returning success means the container bound its port and
passed a TCP probe. It does not mean the BFF can talk to it. This makes one real
gRPC call over TLS against the deployed URL, which exercises the whole path in a
single request:

  * TLS terminates at Cloud Run's frontend            (a wrong address fails here)
  * the frontend forwards HTTP/2 to the container     (a missing h2c port name fails here)
  * the servicer is registered on the port            (a wrong entrypoint fails here)
  * GetRecipe reads the cache, then the archive       (a broken read path fails here)
  * GetStatus reads Redis, unguarded                  (a missing REDIS_URL fails here)

Each of those was a real possibility when this was written, and none of them is
visible from a green deploy step.

WHY THERE ARE TWO CALLS. There was one until 2026-10-20. On that day Upstash
deleted the free-tier database for inactivity, and the fix — falling through to
the S3 archive instead of propagating the ConnectionError — had a consequence
nobody would have noticed until the next outage: GetRecipe stopped being able
to fail because of Redis. It now answers `found: false` whether the cache is
empty or absent, which is correct for a caller and useless for a probe.

GetStatus is the probe that still fails. `queue.get` reads Redis without a
guard, deliberately, so a job id nothing has ever created returns NOT_FOUND
when Redis is reachable and UNKNOWN when it is not. It writes nothing, costs
one GET, and is the only call here whose answer depends on Redis existing.

Health is not used for this. It is liveness-only on purpose (see the comment on
the rpc in extractor.proto) and returned `ok` throughout the 2026-10-20 outage,
which is exactly what it promises and exactly why it cannot be the signal.

    uv run --frozen python scripts/smoke_grpc.py mise-extractor-xyz.a.run.app:443
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import grpc

# `python scripts/foo.py` puts scripts/ on sys.path, not the project root, and
# this project is not installed as a package — there is no [build-system] in
# pyproject.toml. Without this line the import below raises ModuleNotFoundError
# before any argument is parsed. scripts/eval.py and scripts/build_eval_set.py
# carry the same line for the same reason.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.gen import extractor_pb2 as pb
from app.gen import extractor_pb2_grpc as pb_grpc

#: Any well-formed id works — the point is a round trip, not a specific answer.
#: An id nothing has extracted is preferable: it exercises the cache-miss path
#: without depending on prior state.
PROBE_VIDEO = "aaaaaaaaaaa"

#: A job id nothing has ever created. NOT_FOUND is the pass; it is the proof
#: that Redis answered. Reading a key that does not exist leaves no trace.
PROBE_JOB = "canary-probe-no-such-job"

#: Cloud Run scales to zero, so the first request pays a cold start: pulling the
#: image, booting Python, opening Redis. Generous on purpose.
TIMEOUT_SECONDS = 60.0


async def probe(address: str) -> int:
    creds = grpc.ssl_channel_credentials()
    async with grpc.aio.secure_channel(address, creds) as channel:
        stub = pb_grpc.ExtractorStub(channel)

        try:
            recipe = await stub.GetRecipe(
                pb.GetRecipeRequest(video_id=PROBE_VIDEO),
                timeout=TIMEOUT_SECONDS,
            )
        except grpc.aio.AioRpcError as err:
            print(f"FAIL {address}: GetRecipe: {err.code().name}: {err.details()}", file=sys.stderr)
            return 1

        # NOT_FOUND is the success. Any other code means the read never reached
        # Redis — which is the failure GetRecipe can no longer report.
        try:
            await stub.GetStatus(
                pb.GetStatusRequest(job_id=PROBE_JOB),
                timeout=TIMEOUT_SECONDS,
            )
        except grpc.aio.AioRpcError as err:
            if err.code() is not grpc.StatusCode.NOT_FOUND:
                print(
                    f"FAIL {address}: Redis unreachable: {err.code().name}: {err.details()}",
                    file=sys.stderr,
                )
                return 1
        else:
            # A job id nothing created came back as a real job. Either the
            # probe id collided with a real one or the servicer is not the one
            # this script thinks it is.
            print(
                f"FAIL {address}: GetStatus({PROBE_JOB}) found a job",
                file=sys.stderr,
            )
            return 1

    # `found` being False is the expected answer and a complete success: the
    # request crossed every layer above and came back with a real reply.
    print(f"OK {address}: GetRecipe found={recipe.found}, Redis reachable")
    return 0


def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} HOST:PORT", file=sys.stderr)
        return 2
    return asyncio.run(probe(sys.argv[1]))


if __name__ == "__main__":
    raise SystemExit(main())
