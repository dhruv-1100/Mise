"""Scaffold smoke test.

This exists so `uv run pytest` has something real to assert against rather than
exiting 5 on an empty suite. Golden-file fixtures for the extraction pipeline
land in Phase 2.
"""

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_healthz_reports_ok() -> None:
    response = client.get("/healthz")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "service": "mise-extractor",
        "version": "0.0.0",
    }
