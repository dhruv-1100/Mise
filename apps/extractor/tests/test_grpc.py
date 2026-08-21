"""gRPC surface, against a real in-process server.

Uses grpc.aio over a real socket rather than calling the servicer directly:
the mapping to protobuf, the status codes and the streaming completion are the
parts worth testing, and calling the methods as plain Python would exercise
none of them.
"""

import asyncio
import json

import grpc
import pytest
from tests.test_queue import FakeRedis

from app.gen import extractor_pb2 as pb
from app.gen import extractor_pb2_grpc as pb_grpc
from app.grpc_server import ExtractorService, to_proto
from app.queue import QUEUE_KEY, ExtractionQueue
from app.schema import JobState

VIDEO = "j3pDXY9fqSo"


def run(coro):
    return asyncio.run(coro)


class Harness:
    """Real server on an ephemeral port, real client channel."""

    def __init__(self, queue: ExtractionQueue):
        self.queue = queue

    async def __aenter__(self):
        self.server = grpc.aio.server()
        pb_grpc.add_ExtractorServicer_to_server(ExtractorService(self.queue), self.server)
        self.port = self.server.add_insecure_port("127.0.0.1:0")
        await self.server.start()
        self.channel = grpc.aio.insecure_channel(f"127.0.0.1:{self.port}")
        return pb_grpc.ExtractorStub(self.channel)

    async def __aexit__(self, *exc):
        await self.channel.close()
        await self.server.stop(None)


def fresh() -> ExtractionQueue:
    return ExtractionQueue(redis=FakeRedis())


class TestExtract:
    def test_a_url_is_accepted_and_enqueued(self):
        async def scenario():
            q = fresh()
            async with Harness(q) as stub:
                r = await stub.Extract(pb.ExtractRequest(video="https://youtu.be/" + VIDEO))
                return r, await q.depth()

        r, depth = run(scenario())
        assert r.created is True
        assert r.job.video_id == VIDEO
        assert r.job.state == pb.JOB_STATE_QUEUED
        assert depth == 1

    def test_resubmitting_returns_the_same_job_and_created_false(self):
        async def scenario():
            q = fresh()
            async with Harness(q) as stub:
                a = await stub.Extract(pb.ExtractRequest(video=VIDEO))
                b = await stub.Extract(pb.ExtractRequest(video=VIDEO))
                return a, b

        a, b = run(scenario())
        assert b.job.job_id == a.job.job_id
        assert b.created is False

    def test_a_non_youtube_url_is_invalid_argument(self):
        async def scenario():
            async with Harness(fresh()) as stub:
                with pytest.raises(grpc.aio.AioRpcError) as exc:
                    await stub.Extract(pb.ExtractRequest(video="https://example.com/x"))
                return exc.value

        err = run(scenario())
        assert err.code() is grpc.StatusCode.INVALID_ARGUMENT
        assert "not_a_youtube_url" in err.details()

    def test_backpressure_is_resource_exhausted_with_a_retry_hint(self):
        async def scenario():
            q = fresh()
            q.redis.lists[QUEUE_KEY] = [f"j{i}" for i in range(q.max_depth)]
            async with Harness(q) as stub:
                with pytest.raises(grpc.aio.AioRpcError) as exc:
                    await stub.Extract(pb.ExtractRequest(video=VIDEO))
                return exc.value

        err = run(scenario())
        # RESOURCE_EXHAUSTED is gRPC's 429.
        assert err.code() is grpc.StatusCode.RESOURCE_EXHAUSTED
        assert "retry in" in err.details()


class TestStatus:
    def test_get_status_returns_the_job(self):
        async def scenario():
            q = fresh()
            async with Harness(q) as stub:
                created = await stub.Extract(pb.ExtractRequest(video=VIDEO))
                return await stub.GetStatus(pb.GetStatusRequest(job_id=created.job.job_id))

        job = run(scenario())
        assert job.video_id == VIDEO
        assert job.state == pb.JOB_STATE_QUEUED

    def test_an_unknown_job_is_not_found(self):
        async def scenario():
            async with Harness(fresh()) as stub:
                with pytest.raises(grpc.aio.AioRpcError) as exc:
                    await stub.GetStatus(pb.GetStatusRequest(job_id="nope"))
                return exc.value

        assert run(scenario()).code() is grpc.StatusCode.NOT_FOUND

    def test_stream_emits_transitions_and_completes_on_terminal(self):
        async def scenario():
            q = fresh()
            async with Harness(q) as stub:
                created = await stub.Extract(pb.ExtractRequest(video=VIDEO))
                job_id = created.job.job_id

                async def advance():
                    await asyncio.sleep(0.2)
                    j = await q.claim()
                    await asyncio.sleep(0.6)
                    await q.succeed(j, json.dumps({"videoId": VIDEO, "title": "Aloo Paratha"}))

                seen = []

                async def listen():
                    async for msg in stub.StreamStatus(pb.StreamStatusRequest(job_id=job_id)):
                        seen.append(msg)

                await asyncio.wait_for(asyncio.gather(listen(), advance()), timeout=15)
                return seen

        seen = run(scenario())
        states = [m.state for m in seen]
        # Queued, then running, then the terminal state — and then the stream
        # ends by itself rather than making the client decide when to stop.
        assert states[0] == pb.JOB_STATE_QUEUED
        assert pb.JOB_STATE_RUNNING in states
        assert states[-1] == pb.JOB_STATE_SUCCEEDED
        assert json.loads(seen[-1].recipe_json)["title"] == "Aloo Paratha"

    def test_stream_on_an_unknown_job_is_not_found(self):
        async def scenario():
            async with Harness(fresh()) as stub:
                with pytest.raises(grpc.aio.AioRpcError) as exc:
                    async for _ in stub.StreamStatus(pb.StreamStatusRequest(job_id="nope")):
                        pass
                return exc.value

        assert run(scenario()).code() is grpc.StatusCode.NOT_FOUND


class TestHealth:
    def test_health_is_liveness_only(self):
        async def scenario():
            async with Harness(fresh()) as stub:
                return await stub.Health(pb.HealthRequest())

        r = run(scenario())
        assert r.status == "ok" and r.service == "mise-extractor"


class TestMapping:
    def test_absent_timestamps_become_empty_strings(self):
        q = fresh()
        job, _ = run(q.enqueue(VIDEO))
        msg = to_proto(job)
        # proto3 scalars have no presence; consumers read "" as absent.
        assert msg.started_at == "" and msg.finished_at == ""
        assert msg.stage == pb.JOB_STAGE_UNSPECIFIED

    def test_a_failed_job_carries_its_error(self):
        q = fresh()
        job, _ = run(q.enqueue(VIDEO))
        job = run(q.claim())
        for _ in range(q.max_attempts - 1):
            run(q.fail(job, "llm_unavailable", "503"))
            job = run(q.claim())
        dead, _ = run(q.fail(job, "llm_unavailable", "503"))

        msg = to_proto(dead)
        assert msg.state == pb.JOB_STATE_FAILED
        assert msg.error.code == "llm_unavailable"
        assert dead.state is JobState.FAILED
