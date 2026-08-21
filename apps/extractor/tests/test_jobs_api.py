"""The asynchronous HTTP surface: enqueue, status, and the SSE stream."""

import json

import pytest
from fastapi.testclient import TestClient
from tests.test_queue import FakeRedis

from app.main import app, get_queue
from app.queue import QUEUE_KEY, ExtractionQueue

VIDEO = "j3pDXY9fqSo"


@pytest.fixture
def queue() -> ExtractionQueue:
    return ExtractionQueue(redis=FakeRedis())


@pytest.fixture
def client(queue):
    app.dependency_overrides[get_queue] = lambda: queue
    yield TestClient(app)
    app.dependency_overrides.clear()


class TestEnqueue:
    def test_a_url_is_accepted_and_returns_a_job(self, client):
        r = client.post("/jobs", json={"video": "https://youtu.be/" + VIDEO})
        assert r.status_code == 200
        body = r.json()
        assert body["created"] is True
        assert body["job"]["videoId"] == VIDEO
        assert body["job"]["state"] == "queued"

    def test_resubmitting_returns_the_same_job(self, client):
        a = client.post("/jobs", json={"video": VIDEO}).json()
        b = client.post("/jobs", json={"video": VIDEO}).json()
        assert b["job"]["jobId"] == a["job"]["jobId"]
        assert b["created"] is False

    def test_a_junk_url_is_a_typed_400(self, client):
        r = client.post("/jobs", json={"video": "https://example.com/x"})
        assert r.status_code == 400
        assert r.json()["error"] == "not_a_youtube_url"

    def test_a_full_queue_returns_429_with_retry_after(self, client, queue):
        queue.redis.lists[QUEUE_KEY] = [f"j{i}" for i in range(queue.max_depth)]
        r = client.post("/jobs", json={"video": VIDEO})

        assert r.status_code == 429
        # An actionable hint, not just a refusal.
        assert r.headers["Retry-After"] == "30"
        assert r.json()["detail"]["error"] == "queue_full"

    def test_the_queue_being_unconfigured_is_a_503(self):
        # No dependency override: app.state.queue is None without REDIS_URL.
        with TestClient(app) as bare:
            r = bare.post("/jobs", json={"video": VIDEO})
        assert r.status_code == 503
        assert r.json()["detail"]["error"] == "not_configured"


class TestStatus:
    def test_a_job_can_be_read_back(self, client):
        job_id = client.post("/jobs", json={"video": VIDEO}).json()["job"]["jobId"]
        r = client.get(f"/jobs/{job_id}")
        assert r.status_code == 200
        assert r.json()["jobId"] == job_id

    def test_an_unknown_job_is_404(self, client):
        r = client.get("/jobs/nope")
        assert r.status_code == 404
        assert r.json()["detail"]["error"] == "job_not_found"


def parse_sse(text: str) -> list[tuple[str, dict]]:
    out = []
    for block in text.strip().split("\n\n"):
        if not block.strip():
            continue
        event, data = None, None
        for line in block.splitlines():
            if line.startswith("event: "):
                event = line[7:]
            elif line.startswith("data: "):
                data = json.loads(line[6:])
        if event:
            out.append((event, data))
    return out


class TestEvents:
    def test_a_finished_job_streams_its_state_and_closes(self, client, queue):
        import asyncio

        job_id = client.post("/jobs", json={"video": VIDEO}).json()["job"]["jobId"]
        job = asyncio.run(queue.claim())
        asyncio.run(queue.succeed(job, json.dumps({"videoId": VIDEO, "title": "Aloo Paratha"})))

        with client.stream("GET", f"/jobs/{job_id}/events") as r:
            assert r.headers["content-type"].startswith("text/event-stream")
            # Proxies buffer SSE by default, which would deliver every event at
            # once and look exactly like the spinner this replaced.
            assert r.headers["X-Accel-Buffering"] == "no"
            events = parse_sse("".join(r.iter_text()))

        assert events[-1][0] == "status"
        assert events[-1][1]["state"] == "succeeded"
        # The recipe rides along, so the client needs no second request.
        assert events[-1][1]["recipe"]["title"] == "Aloo Paratha"

    def test_a_failed_job_streams_its_error_and_closes(self, client, queue):
        import asyncio

        job_id = client.post("/jobs", json={"video": VIDEO}).json()["job"]["jobId"]
        job = asyncio.run(queue.claim())
        for _ in range(queue.max_attempts - 1):
            asyncio.run(queue.fail(job, "llm_unavailable", "503"))
            job = asyncio.run(queue.claim())
        asyncio.run(queue.fail(job, "llm_unavailable", "503"))

        with client.stream("GET", f"/jobs/{job_id}/events") as r:
            events = parse_sse("".join(r.iter_text()))

        assert events[-1][1]["state"] == "failed"
        assert events[-1][1]["error"]["code"] == "llm_unavailable"

    def test_an_unknown_job_streams_an_error_event(self, client):
        with client.stream("GET", "/jobs/nope/events") as r:
            events = parse_sse("".join(r.iter_text()))
        assert events == [("error", {"error": "job_not_found", "detail": "nope"})]
