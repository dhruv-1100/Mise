"""Stage 1 of the extraction pipeline: fetch the description.

Official YouTube Data API v3 only. No yt-dlp, no transcript scrapers — if the
API cannot do something that is a finding for an ADR, not an obstacle to route
around. See `docs/adr/0001-content-sourcing.md`, which established that captions
are unreachable without creator OAuth and that the description is therefore the
primary source. This module fetches only the description.

Cost is 1 quota unit per video against a 10,000/day default. `captions.list`
would be 50 and `captions.download` 200, which is a second, independent reason
the description-first design is the right one.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum
from typing import Protocol

import httpx

API_BASE = "https://www.googleapis.com/youtube/v3"
REQUEST_TIMEOUT_S = 20.0

#: YouTube video IDs are exactly 11 characters of URL-safe base64.
VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")

#: Every URL shape a user might paste. Anchored on the id, which is the only
#: part we trust.
_URL_PATTERNS = (
    re.compile(r"(?:youtube\.com|youtube-nocookie\.com)/watch\?(?:.*&)?v=([A-Za-z0-9_-]{11})"),
    re.compile(r"youtu\.be/([A-Za-z0-9_-]{11})"),
    re.compile(
        r"(?:youtube\.com|youtube-nocookie\.com)/(?:embed|shorts|v|live)/([A-Za-z0-9_-]{11})"
    ),
)


class FetchFailure(StrEnum):
    """Why a description could not be fetched. Never a raw exception."""

    NOT_A_YOUTUBE_URL = "not_a_youtube_url"
    VIDEO_NOT_FOUND = "video_not_found"
    QUOTA_EXCEEDED = "quota_exceeded"
    NOT_AUTHORISED = "not_authorised"
    UPSTREAM_ERROR = "upstream_error"


class FetchError(Exception):
    """A typed failure carrying the reason and the upstream detail."""

    def __init__(self, failure: FetchFailure, detail: str = "") -> None:
        super().__init__(f"{failure}: {detail}" if detail else str(failure))
        self.failure = failure
        self.detail = detail


@dataclass(frozen=True)
class VideoMetadata:
    """Everything the pipeline needs about a video. No caption data — see ADR 0001."""

    video_id: str
    title: str
    description: str
    channel_id: str
    channel_title: str
    published_at: str
    duration: str
    #: YouTube's own claim about caption availability. ADR 0001 found it
    #: disagreed with captions.list on 1 of 5 videos, so it is recorded rather
    #: than trusted.
    claims_captions: bool

    @property
    def channel_url(self) -> str:
        """Attribution is not optional (CLAUDE.md)."""
        return f"https://www.youtube.com/channel/{self.channel_id}"


def parse_video_id(value: str) -> str:
    """Accept a bare id or any YouTube URL shape, and return the id.

    Strict by design. The id is interpolated into an outbound request, so
    anything that is not exactly 11 URL-safe base64 characters is rejected
    rather than cleaned up — this is the boundary where user input stops.
    """
    candidate = value.strip()
    if VIDEO_ID_RE.match(candidate):
        return candidate

    for pattern in _URL_PATTERNS:
        match = pattern.search(candidate)
        if match is not None:
            return match.group(1)

    raise FetchError(FetchFailure.NOT_A_YOUTUBE_URL, candidate[:120])


class DescriptionFetcher(Protocol):
    """The pipeline depends on this, never on YouTube, so tests run offline."""

    async def fetch(self, video_id: str) -> VideoMetadata: ...


class YouTubeFetcher:
    """Fetches video metadata through the official Data API."""

    def __init__(self, api_key: str, client: httpx.AsyncClient | None = None) -> None:
        if not api_key:
            raise ValueError("YOUTUBE_API_KEY is empty")
        self._key = api_key
        self._client = client
        self._owns_client = client is None

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=REQUEST_TIMEOUT_S)
        return self._client

    async def aclose(self) -> None:
        if self._client is not None and self._owns_client:
            await self._client.aclose()
            self._client = None

    async def fetch(self, video_id: str) -> VideoMetadata:
        if not VIDEO_ID_RE.match(video_id):
            raise FetchError(FetchFailure.NOT_A_YOUTUBE_URL, video_id[:120])

        client = await self._get_client()
        try:
            response = await client.get(
                f"{API_BASE}/videos",
                params={
                    "part": "snippet,contentDetails",
                    "id": video_id,
                    "key": self._key,
                },
            )
        except httpx.HTTPError as exc:
            raise FetchError(FetchFailure.UPSTREAM_ERROR, str(exc)) from exc

        if response.status_code != 200:
            raise FetchError(*_classify_error(response))

        payload = response.json()
        items = payload.get("items") or []
        if not items:
            # A bad id, a private video, or a removed one. The API does not
            # distinguish, and neither can we.
            raise FetchError(FetchFailure.VIDEO_NOT_FOUND, video_id)

        item = items[0]
        snippet = item.get("snippet") or {}
        content = item.get("contentDetails") or {}

        return VideoMetadata(
            video_id=video_id,
            title=(snippet.get("title") or "").strip(),
            description=snippet.get("description") or "",
            channel_id=(snippet.get("channelId") or "").strip(),
            channel_title=(snippet.get("channelTitle") or "").strip(),
            published_at=snippet.get("publishedAt") or "",
            duration=content.get("duration") or "",
            claims_captions=str(content.get("caption", "")).lower() == "true",
        )


def _classify_error(response: httpx.Response) -> tuple[FetchFailure, str]:
    """Turn an HTTP error into a typed reason.

    Quota exhaustion is separated from other 403s because it is the one failure
    that resolves by waiting, and the caller should say so rather than reporting
    a generic permissions problem.
    """
    try:
        error = response.json().get("error", {})
    except ValueError:
        return FetchFailure.UPSTREAM_ERROR, f"HTTP {response.status_code}"

    message = error.get("message", "")
    details = error.get("errors") or []
    reason = details[0].get("reason", "") if details and isinstance(details[0], dict) else ""

    if reason in ("quotaExceeded", "dailyLimitExceeded", "rateLimitExceeded"):
        return FetchFailure.QUOTA_EXCEEDED, message
    if response.status_code in (401, 403):
        return FetchFailure.NOT_AUTHORISED, f"{reason}: {message}".strip(": ")
    if response.status_code == 404:
        return FetchFailure.VIDEO_NOT_FOUND, message
    return FetchFailure.UPSTREAM_ERROR, f"HTTP {response.status_code} {reason}: {message}"
