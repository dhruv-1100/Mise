"""Shared pytest configuration.

`anyio_backend` is what the anyio pytest plugin uses to decide which event loop
to run `@pytest.mark.anyio` tests on. Pinning it to asyncio keeps async tests
available without adding pytest-asyncio, since anyio is already present as a
Starlette dependency.
"""

import pytest


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"
