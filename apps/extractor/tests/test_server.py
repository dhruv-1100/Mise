"""The production entrypoint, booted for real.

This is the test written for the gap it found. `grpc_server.serve()` and
`worker.run_pool()` both existed and were both well tested, and nothing in the
container started either of them — the image ran the HTTP app. Testing a
function nobody calls proves the function works, not that the service does. So
this boots `server.main()` the way the container does, speaks gRPC to it over a
real socket, and signals it the way Cloud Run does.
"""

from __future__ import annotations

import asyncio
import os
import signal
import socket

import grpc
import pytest
import redis.asyncio
from tests.test_queue import FakeRedis

from app import server
from app.gen import extractor_pb2 as pb
from app.gen import extractor_pb2_grpc as pb_grpc

VIDEO = "j3pDXY9fqSo"


class ClosableFakeRedis(FakeRedis):
    """FakeRedis implements RedisLike, which has no aclose. The entrypoint
    closes its client on shutdown, so the stand-in needs one to be closed."""

    def __init__(self) -> None:
        super().__init__()
        self.closed = False

    async def aclose(self) -> None:
        self.closed = True


class FakeFetcher:
    def __init__(self, *_args, **_kwargs) -> None:
        self.closed = False

    async def aclose(self) -> None:
        self.closed = True


class FakeProvider:
    def __init__(self, *_args, **_kwargs) -> None:
        pass


def free_port() -> int:
    """Ask the OS for a port nothing is using, then hand it to the server.

    There is a race between closing this socket and the server binding it, and
    it is the standard one: preferable to a hardcoded port that collides on a
    developer's machine for reasons they cannot see.
    """
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


class TestConfig:
    def test_a_missing_variable_names_itself(self):
        os.environ.pop("MISE_NOT_SET", None)
        with pytest.raises(server.MissingConfig, match="MISE_NOT_SET"):
            server._require("MISE_NOT_SET")

    def test_an_empty_variable_counts_as_missing(self, monkeypatch):
        # Cloud Run sets an unresolved secret reference to the empty string
        # rather than leaving it unset, so "" must fail the same way.
        monkeypatch.setenv("MISE_EMPTY", "")
        with pytest.raises(server.MissingConfig):
            server._require("MISE_EMPTY")

    @pytest.mark.parametrize("missing", ["YOUTUBE_API_KEY", "GEMINI_API_KEY", "REDIS_URL"])
    def test_the_service_refuses_to_boot_without_its_credentials(self, monkeypatch, missing):
        # Booting healthy and failing every extraction is worse than refusing to
        # boot: the first looks fine on a dashboard.
        for name in ("YOUTUBE_API_KEY", "GEMINI_API_KEY", "REDIS_URL"):
            monkeypatch.setenv(name, "set")
        monkeypatch.delenv(missing)

        with pytest.raises(server.MissingConfig, match=missing):
            asyncio.run(server.main())


class TestBind:
    def test_a_failed_bind_raises_instead_of_serving_nothing(self):
        """A failed bind must not produce a running server.

        Whichever it does, a bind failure must reach the caller. A server that
        started, logged that it was listening and accepted no connections would
        be visible only as a revision that never went healthy, with nothing in
        its own logs to say why.
        """
        from app.grpc_server import serve
        from app.queue import ExtractionQueue

        # grpcio's documented contract is a 0 return value; what it actually
        # does is raise. Either is fine — serving nothing is not — so this
        # pins the behaviour rather than the mechanism.

        # Hold the port so the server cannot have it.
        with socket.socket() as held:
            held.bind(("127.0.0.1", 0))
            held.listen(1)
            taken = int(held.getsockname()[1])

            async def scenario():
                await serve(ExtractionQueue(redis=FakeRedis()), port=taken, host="127.0.0.1")

            with pytest.raises(RuntimeError, match=r"[Ff]ailed to bind"):
                asyncio.run(scenario())

    def test_it_binds_all_interfaces_by_default(self):
        # Cloud Run requires 0.0.0.0. "[::]" is not guaranteed inside its
        # sandbox, and getting this wrong costs a deploy cycle to discover.
        from app.grpc_server import DEFAULT_BIND_HOST

        assert DEFAULT_BIND_HOST == "0.0.0.0"


class TestBoot:
    def test_it_serves_grpc_and_shuts_down_on_sigterm(self, monkeypatch):
        port = free_port()
        fake_redis = ClosableFakeRedis()

        monkeypatch.setenv("YOUTUBE_API_KEY", "key")
        monkeypatch.setenv("GEMINI_API_KEY", "key")
        monkeypatch.setenv("REDIS_URL", "redis://localhost:6379")
        monkeypatch.setenv("PORT", str(port))
        monkeypatch.setenv("WORKER_POOL_SIZE", "1")

        monkeypatch.setattr(redis.asyncio, "from_url", lambda *a, **k: fake_redis)
        monkeypatch.setattr(server, "YouTubeFetcher", FakeFetcher)
        monkeypatch.setattr(server, "GeminiProvider", FakeProvider)

        async def scenario():
            task = asyncio.create_task(server.main())

            # Wait for the port rather than sleeping a guessed interval. The
            # signal handlers are installed before serve() binds, so a listening
            # port also proves SIGTERM will be caught rather than killing pytest.
            async with asyncio.timeout(10):
                while True:
                    try:
                        with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                            break
                    except OSError:
                        await asyncio.sleep(0.05)

            # A real RPC over a real socket: proves the servicer is wired to the
            # port, not merely that something is listening on it.
            async with grpc.aio.insecure_channel(f"127.0.0.1:{port}") as channel:
                stub = pb_grpc.ExtractorStub(channel)
                found = await stub.GetRecipe(pb.GetRecipeRequest(video_id=VIDEO))

            os.kill(os.getpid(), signal.SIGTERM)
            async with asyncio.timeout(15):
                await task
            return found

        found = asyncio.run(scenario())

        # Nothing was ever extracted, so the cache is empty and the answer is a
        # clean "no" rather than an error.
        assert found.found is False
        assert fake_redis.closed is True
