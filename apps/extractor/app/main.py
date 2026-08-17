"""Mise extraction service.

Owns all LLM calls, caption fetching, and recipe parsing. The Next.js BFF talks
to this service and never calls an LLM itself.

Phase 0: healthcheck only. The extraction pipeline lands in Phase 2, and the
gRPC surface in Phase 4.
"""

from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(
    title="Mise Extractor",
    version="0.0.0",
    description="Video-to-recipe extraction service.",
)


class Health(BaseModel):
    """Liveness response. Deliberately carries no dependency status.

    A liveness probe answers "is this process up", not "is Postgres reachable" —
    conflating the two makes an orchestrator restart a healthy service because a
    downstream is slow. Readiness, with dependency checks, arrives in Phase 7
    alongside the Prometheus surface.
    """

    status: str
    service: str
    version: str


@app.get("/healthz", response_model=Health, tags=["ops"])
async def healthz() -> Health:
    return Health(status="ok", service="mise-extractor", version=app.version)
