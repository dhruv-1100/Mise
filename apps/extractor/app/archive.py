"""Durable storage for extracted recipes.

WHY THIS EXISTS. Redis is a cache: `CACHE_TTL_SECONDS` expires a recipe after
seven days. On 2026-09-08 the live recipe page returned 404 twice because the
entry had aged out, and each recovery cost a 90-295 second re-extraction plus a
Gemini call for a recipe that had already been extracted correctly. The cache
was doing its job; it was simply the only copy.

S3 is the copy that does not expire. The read path becomes Redis, then S3, then
re-extract — so an aged-out cache costs one object GET instead of a minute and a
half of model time.

NO CREDENTIALS. The container reaches AWS by asking the GCP metadata server for
an identity token and exchanging it for short-lived AWS credentials. There is no
access key in the environment, in Terraform state, or in this repository. See
`infra/aws.tf` and `docs/adr/0007-recipe-archive.md`.

Behind a Protocol for the same reason `LlmProvider` is: the tests run offline
against a fake, and nothing outside this module imports boto3.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any, Protocol

logger = logging.getLogger(__name__)

#: Objects live under one prefix, which is also the only prefix the IAM policy
#: grants. A key written outside it fails closed rather than scattering.
KEY_PREFIX = "recipes"

#: GCP identity tokens last an hour. Refreshing a few minutes early avoids a
#: request failing on a credential that expired between the check and the call.
REFRESH_MARGIN_SECONDS = 300

_METADATA_URL = (
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity"
)


class RecipeArchive(Protocol):
    """Durable recipe storage. The only shape the queue knows about."""

    async def get(self, video_id: str) -> dict[str, Any] | None: ...

    async def put(self, video_id: str, recipe_json: str) -> None: ...


class NullArchive:
    """No archive configured.

    A deployment without AWS must keep working exactly as it did before, so the
    absence of a bucket is a no-op rather than an error. `put` succeeding while
    storing nothing is correct here: the caller has already written to Redis,
    and the archive is an addition to that, never a replacement for it.
    """

    async def get(self, video_id: str) -> dict[str, Any] | None:
        return None

    async def put(self, video_id: str, recipe_json: str) -> None:
        return None


def object_key(video_id: str) -> str:
    return f"{KEY_PREFIX}/{video_id}.json"


class S3Archive:
    """S3, reached with credentials federated from this container's GCP identity.

    boto3 is synchronous and this service is entirely asyncio, so every call
    goes through a thread. That is the right trade for two calls per extraction
    against pulling in a second, less standard AWS client: the work is a single
    network round trip and the pool is idle while it happens.
    """

    def __init__(
        self,
        *,
        bucket: str,
        role_arn: str,
        audience: str,
        region: str,
    ) -> None:
        self._bucket = bucket
        self._role_arn = role_arn
        self._audience = audience
        self._region = region
        self._cache: dict[str, Any] | None = None
        self._expires_at: float = 0.0
        self._lock = asyncio.Lock()

    async def _identity_token(self) -> str:
        """A Google-signed OIDC token naming this service account.

        `format=full` is required: the default omits claims AWS needs to
        validate the token, and the failure is an opaque AccessDenied rather
        than anything naming the format.
        """
        import httpx

        async with httpx.AsyncClient(timeout=10.0) as http:
            response = await http.get(
                _METADATA_URL,
                params={"audience": self._audience, "format": "full"},
                headers={"Metadata-Flavor": "Google"},
            )
            response.raise_for_status()
            return response.text.strip()

    async def _clients(self) -> dict[str, Any]:
        """The boto3 clients, re-assuming the role when credentials near expiry.

        One assume-role cycle feeds both S3 and CloudWatch. Two independent
        refresh loops would double the STS calls to reach the same place, and
        the role already carries both permissions.
        """
        import time

        async with self._lock:
            if self._cache is not None and time.time() < self._expires_at:
                return self._cache

            import boto3

            token = await self._identity_token()
            region = self._region
            role_arn = self._role_arn

            def assume() -> tuple[dict[str, Any], float]:
                sts = boto3.client("sts", region_name=region)
                creds = sts.assume_role_with_web_identity(
                    RoleArn=role_arn,
                    RoleSessionName="mise-extractor",
                    WebIdentityToken=token,
                )["Credentials"]
                kwargs = {
                    "region_name": region,
                    "aws_access_key_id": creds["AccessKeyId"],
                    "aws_secret_access_key": creds["SecretAccessKey"],
                    "aws_session_token": creds["SessionToken"],
                }
                clients = {
                    "s3": boto3.client("s3", **kwargs),
                    "cloudwatch": boto3.client("cloudwatch", **kwargs),
                }
                return clients, creds["Expiration"].timestamp()

            self._cache, expiry = await asyncio.to_thread(assume)
            self._expires_at = expiry - REFRESH_MARGIN_SECONDS
            logger.info(
                "assumed %s; credentials valid for %.0fs",
                self._role_arn,
                expiry - time.time(),
            )
            return self._cache

    async def cloudwatch(self) -> Any:
        """The CloudWatch client, for app/metrics.py.

        Exposed here rather than giving metrics.py its own federation because
        the credentials are the same credentials and the role is the same role.
        """
        return (await self._clients())["cloudwatch"]

    async def get(self, video_id: str) -> dict[str, Any] | None:
        """The archived recipe, or None.

        Never raises. A miss and an outage are the same thing to the caller —
        both mean "extract it again" — and an archive that can take the recipe
        page down is worse than no archive.
        """
        try:
            client = (await self._clients())["s3"]
            bucket = self._bucket

            def fetch() -> bytes:
                obj = client.get_object(Bucket=bucket, Key=object_key(video_id))
                body: bytes = obj["Body"].read()
                return body

            raw = await asyncio.to_thread(fetch)
            parsed: dict[str, Any] = json.loads(raw)
            return parsed
        except Exception as exc:
            # A missing object is the ordinary case — a video nobody has
            # extracted yet — and logging it at warning would bury the failures
            # that matter under the ones that do not. Anything else is worth
            # seeing, even though neither changes what the caller does next.
            if "NoSuchKey" not in str(exc):
                logger.warning("archive read failed for %s: %s", video_id, exc)
            return None

    async def put(self, video_id: str, recipe_json: str) -> None:
        """Archive the recipe. Best-effort, like the read.

        The recipe is already in Redis and already returned to the caller by the
        time this runs. Failing the extraction because the durable copy did not
        land would trade a working result for no result.
        """
        try:
            client = (await self._clients())["s3"]
            bucket = self._bucket

            def store() -> None:
                client.put_object(
                    Bucket=bucket,
                    Key=object_key(video_id),
                    Body=recipe_json.encode(),
                    ContentType="application/json",
                )

            await asyncio.to_thread(store)
        except Exception as exc:
            logger.warning("archive write failed for %s: %s", video_id, exc)


def from_environment() -> RecipeArchive:
    """Build the archive from env, or NullArchive when AWS is not configured.

    All four variables or none. A partial configuration is a deployment mistake,
    and failing over to Null quietly would hide it until the next cache expiry —
    which is months of working normally followed by one inexplicable 404.
    """
    names = ("RECIPE_BUCKET", "AWS_ROLE_ARN", "AWS_TOKEN_AUDIENCE", "AWS_REGION")
    values = {name: os.environ.get(name, "") for name in names}

    if not any(values.values()):
        logger.info("no recipe archive configured; Redis is the only copy")
        return NullArchive()

    missing = [name for name, value in values.items() if not value]
    if missing:
        raise RuntimeError(f"recipe archive is partially configured; missing {', '.join(missing)}")

    logger.info("recipe archive: s3://%s/%s/", values["RECIPE_BUCKET"], KEY_PREFIX)
    return S3Archive(
        bucket=values["RECIPE_BUCKET"],
        role_arn=values["AWS_ROLE_ARN"],
        audience=values["AWS_TOKEN_AUDIENCE"],
        region=values["AWS_REGION"],
    )
