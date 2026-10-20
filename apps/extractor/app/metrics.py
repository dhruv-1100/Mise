"""Publishing the one number nothing was watching.

`ExtractionQueue.dead_letter_depth()` has existed since Phase 4 with a docstring
saying "Non-zero is a Phase 7 alert: work was accepted and never done". Nothing
read it. A non-empty dead-letter queue is the single worst queue state —
silently wrong, no error anywhere, a reader waiting forever for a recipe — and
it was the state with no alarm on it.

This publishes it to CloudWatch, where `infra/aws.tf` has an alarm that mails
through SNS when it goes above zero.

Deliberately NOT the start of a metrics layer. Phase 7 brings Prometheus and
Grafana for the full surface, and that is where request counters and latency
histograms belong. This is one gauge, carried on the AWS the archive already
federates into, because the gap it closes is older than the plan for closing it.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any, Protocol

logger = logging.getLogger(__name__)

#: Matches the alarm's 300s period in infra/aws.tf. Publishing faster would cost
#: datapoints without moving the alarm; slower would leave periods empty.
PUBLISH_INTERVAL_SECONDS = 60.0

METRIC_NAME = "DeadLetterDepth"


class DepthSource(Protocol):
    async def dead_letter_depth(self) -> int: ...


class MetricSink(Protocol):
    async def gauge(self, name: str, value: float) -> None: ...


class NullSink:
    """No CloudWatch configured. Records nothing, raises nothing."""

    async def gauge(self, name: str, value: float) -> None:
        return None


class CloudWatchSink:
    """CloudWatch, using the same federated role the archive assumes.

    Shares `S3Archive`'s credential machinery rather than duplicating it: the
    role already carries `cloudwatch:PutMetricData` scoped to one namespace, and
    two independent assume-role loops would double the STS calls for no gain.
    """

    def __init__(self, *, namespace: str, region: str, credentials: Any) -> None:
        self._namespace = namespace
        self._region = region
        # An object exposing the same `_s3`-style credential refresh. Passed in
        # rather than constructed so this module never imports boto3 directly
        # and the tests never need AWS.
        self._credentials = credentials

    async def gauge(self, name: str, value: float) -> None:
        try:
            client = await self._credentials.cloudwatch()

            def put() -> None:
                client.put_metric_data(
                    Namespace=self._namespace,
                    MetricData=[{"MetricName": name, "Value": value, "Unit": "Count"}],
                )

            await asyncio.to_thread(put)
        except Exception as exc:
            # A metric that cannot be published must never take down the thing
            # it measures. The alarm treats missing data as not-breaching
            # (infra/aws.tf), so a publishing outage is quiet rather than noisy
            # — which is the correct trade for a gauge, and is called out in the
            # ADR as the one thing this design does not cover.
            logger.warning("could not publish %s: %s", name, exc)


async def publish_dead_letters(
    *,
    source: DepthSource,
    sink: MetricSink,
    stop: asyncio.Event,
    interval: float = PUBLISH_INTERVAL_SECONDS,
    sleep: Any = asyncio.sleep,
) -> None:
    """Publish the dead-letter depth until told to stop.

    `sleep` is injected for the same reason the worker's is: a loop that waits
    real seconds is a loop nobody tests.
    """
    while not stop.is_set():
        try:
            await sink.gauge(METRIC_NAME, float(await source.dead_letter_depth()))
        except Exception as exc:
            logger.warning("dead-letter depth unavailable: %s", exc)
        await sleep(interval)


def namespace_from_environment() -> str | None:
    """The configured namespace, or None when CloudWatch is off."""
    return os.environ.get("CLOUDWATCH_NAMESPACE") or None
