# Mise extraction service.
#
# Two stages so the runtime image carries no build tooling and no uv. Built and
# pushed by CI; Cloud Run only ever sees the second stage.

FROM python:3.12-slim AS builder

# uv resolves from uv.lock, so the image gets exactly what CI and local dev got.
COPY --from=ghcr.io/astral-sh/uv:0.11.21 /uv /usr/local/bin/uv

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never

WORKDIR /app

# Dependencies before source: this layer is cached across every change that does
# not touch the lockfile, which is nearly all of them.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY app ./app
RUN uv sync --frozen --no-dev


FROM python:3.12-slim AS runtime

# Non-root. Cloud Run does not require it, but a container that never needs
# root should never have it.
RUN useradd --create-home --uid 1001 mise
WORKDIR /app

COPY --from=builder --chown=mise:mise /app/.venv /app/.venv
COPY --from=builder --chown=mise:mise /app/app /app/app

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

USER mise

# Cloud Run injects PORT and it is not always 8080. Honour it rather than
# hardcoding, or the container looks healthy and receives nothing.
ENV PORT=8080
EXPOSE 8080

# Single worker on purpose. Extraction is I/O-bound on the LLM call, so async
# concurrency inside one process is the right shape; horizontal scaling is Cloud
# Run's job. Phase 4 moves this work onto a queue anyway.
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
