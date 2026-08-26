"""Post-deploy smoke test: is the deployed revision actually usable?

`gcloud run deploy` returning success means the container bound its port and
passed a TCP probe. It does not mean the BFF can talk to it. This makes one real
gRPC call over TLS against the deployed URL, which exercises the whole path in a
single request:

  * TLS terminates at Cloud Run's frontend            (a wrong address fails here)
  * the frontend forwards HTTP/2 to the container     (a missing h2c port name fails here)
  * the servicer is registered on the port            (a wrong entrypoint fails here)
  * GetRecipe reads the cache, which reads Redis      (a missing REDIS_URL fails here)

Each of those was a real possibility when this was written, and none of them is
visible from a green deploy step.

    uv run --frozen python scripts/smoke_grpc.py mise-extractor-xyz.a.run.app:443
"""

from __future__ import annotations

import asyncio
import sys

import grpc

from app.gen import extractor_pb2 as pb
from app.gen import extractor_pb2_grpc as pb_grpc

#: Any well-formed id works — the point is a round trip, not a specific answer.
#: An id nothing has extracted is preferable: it exercises the cache-miss path
#: without depending on prior state.
PROBE_VIDEO = "aaaaaaaaaaa"

#: Cloud Run scales to zero, so the first request pays a cold start: pulling the
#: image, booting Python, opening Redis. Generous on purpose.
TIMEOUT_SECONDS = 60.0


async def probe(address: str) -> int:
    creds = grpc.ssl_channel_credentials()
    async with grpc.aio.secure_channel(address, creds) as channel:
        stub = pb_grpc.ExtractorStub(channel)
        try:
            response = await stub.GetRecipe(
                pb.GetRecipeRequest(video_id=PROBE_VIDEO),
                timeout=TIMEOUT_SECONDS,
            )
        except grpc.aio.AioRpcError as err:
            print(f"FAIL {address}: {err.code().name}: {err.details()}", file=sys.stderr)
            return 1

    # `found` being False is the expected answer and a complete success: the
    # request crossed every layer above and came back with a real reply.
    print(f"OK {address}: GetRecipe responded, found={response.found}")
    return 0


def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} HOST:PORT", file=sys.stderr)
        return 2
    return asyncio.run(probe(sys.argv[1]))


if __name__ == "__main__":
    raise SystemExit(main())
