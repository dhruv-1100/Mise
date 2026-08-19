"""Tests for the YouTube fetch stage. No network.

Video-id parsing is the boundary where user input stops, so it is tested harder
than its size suggests: the id is interpolated into an outbound request.
"""

import httpx
import pytest

from app.youtube import (
    FetchError,
    FetchFailure,
    VideoMetadata,
    YouTubeFetcher,
    parse_video_id,
)


class TestParseVideoId:
    @pytest.mark.parametrize(
        "value",
        [
            "bUounn_Bmy4",
            "https://www.youtube.com/watch?v=bUounn_Bmy4",
            "https://www.youtube.com/watch?v=bUounn_Bmy4&pp=ygUieW91ciBmb29k",
            "https://www.youtube.com/watch?list=PL123&v=bUounn_Bmy4",
            "http://youtube.com/watch?v=bUounn_Bmy4",
            "https://youtu.be/bUounn_Bmy4",
            "https://youtu.be/bUounn_Bmy4?t=42",
            "https://www.youtube.com/embed/bUounn_Bmy4",
            "https://www.youtube.com/shorts/bUounn_Bmy4",
            "https://www.youtube.com/live/bUounn_Bmy4",
            "https://www.youtube-nocookie.com/embed/bUounn_Bmy4",
            "  bUounn_Bmy4  ",
        ],
    )
    def test_every_shape_a_user_might_paste(self, value):
        assert parse_video_id(value) == "bUounn_Bmy4"

    @pytest.mark.parametrize(
        "value",
        [
            "",
            "   ",
            "not a url",
            "https://example.com/watch?v=bUounn_Bmy4",
            "https://vimeo.com/123456",
            "bUounn_Bmy",  # 10 chars
            "bUounn_Bmy44",  # 12 chars
            "bUounn/Bmy4",  # illegal character
            "../../etc/passwd",
            "https://www.youtube.com/watch?v=../../../etc/passwd",
        ],
    )
    def test_anything_else_is_refused(self, value):
        # Strict rather than lenient: this id goes into an outbound URL.
        with pytest.raises(FetchError) as exc:
            parse_video_id(value)
        assert exc.value.failure is FetchFailure.NOT_A_YOUTUBE_URL

    def test_a_video_id_inside_a_foreign_host_is_not_accepted(self):
        # An 11-char id appearing in someone else's URL must not be harvested.
        with pytest.raises(FetchError):
            parse_video_id("https://evil.example.com/?x=bUounn_Bmy4")


def fetcher_with(handler) -> YouTubeFetcher:
    transport = httpx.MockTransport(handler)
    return YouTubeFetcher("test-key", client=httpx.AsyncClient(transport=transport))


def ok_payload(**overrides):
    snippet = {
        "title": "Paneer Butter Masala",
        "description": "2 tbsp oil\nsalt to taste",
        "channelId": "UCexampleexampleexample",
        "channelTitle": "Your Food Lab",
        "publishedAt": "2023-01-04T13:10:15Z",
    }
    snippet.update(overrides)
    return {
        "items": [
            {"snippet": snippet, "contentDetails": {"duration": "PT7M31S", "caption": "true"}}
        ]
    }


class TestFetch:
    @pytest.mark.anyio
    async def test_a_successful_fetch_maps_every_field(self):
        f = fetcher_with(lambda r: httpx.Response(200, json=ok_payload()))
        meta = await f.fetch("bUounn_Bmy4")

        assert isinstance(meta, VideoMetadata)
        assert meta.title == "Paneer Butter Masala"
        assert meta.channel_title == "Your Food Lab"
        assert meta.description.startswith("2 tbsp oil")
        assert meta.duration == "PT7M31S"
        assert meta.claims_captions is True
        # Attribution is non-negotiable and must be derivable.
        assert meta.channel_url == "https://www.youtube.com/channel/UCexampleexampleexample"

    @pytest.mark.anyio
    async def test_it_asks_for_only_what_it_needs(self):
        seen = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen.update(dict(request.url.params))
            return httpx.Response(200, json=ok_payload())

        await fetcher_with(handler).fetch("bUounn_Bmy4")
        # captions.list costs 50 quota units against videos.list's 1. ADR 0001
        # settled that we do not call it.
        assert seen["part"] == "snippet,contentDetails"
        assert seen["id"] == "bUounn_Bmy4"

    @pytest.mark.anyio
    async def test_an_empty_item_list_is_not_found(self):
        f = fetcher_with(lambda r: httpx.Response(200, json={"items": []}))
        with pytest.raises(FetchError) as exc:
            await f.fetch("bUounn_Bmy4")
        assert exc.value.failure is FetchFailure.VIDEO_NOT_FOUND

    @pytest.mark.anyio
    async def test_quota_exhaustion_is_distinguished_from_other_403s(self):
        # The one failure that resolves by waiting, so it gets its own reason.
        body = {
            "error": {
                "code": 403,
                "message": "The request cannot be completed because you have exceeded your quota.",
                "errors": [{"reason": "quotaExceeded"}],
            }
        }
        f = fetcher_with(lambda r: httpx.Response(403, json=body))
        with pytest.raises(FetchError) as exc:
            await f.fetch("bUounn_Bmy4")
        assert exc.value.failure is FetchFailure.QUOTA_EXCEEDED

    @pytest.mark.anyio
    async def test_a_bad_key_is_an_authorisation_failure(self):
        body = {
            "error": {
                "code": 400,
                "message": "API key not valid",
                "errors": [{"reason": "badRequest"}],
            }
        }
        f = fetcher_with(lambda r: httpx.Response(403, json=body))
        with pytest.raises(FetchError) as exc:
            await f.fetch("bUounn_Bmy4")
        assert exc.value.failure is FetchFailure.NOT_AUTHORISED

    @pytest.mark.anyio
    async def test_a_transport_failure_is_an_upstream_error(self):
        def handler(request):
            raise httpx.ConnectError("connection refused")

        with pytest.raises(FetchError) as exc:
            await fetcher_with(handler).fetch("bUounn_Bmy4")
        assert exc.value.failure is FetchFailure.UPSTREAM_ERROR

    @pytest.mark.anyio
    async def test_a_non_json_error_body_does_not_crash_the_classifier(self):
        f = fetcher_with(lambda r: httpx.Response(500, text="<html>gateway</html>"))
        with pytest.raises(FetchError) as exc:
            await f.fetch("bUounn_Bmy4")
        assert exc.value.failure is FetchFailure.UPSTREAM_ERROR

    @pytest.mark.anyio
    async def test_a_malformed_id_never_reaches_the_network(self):
        def handler(request):
            raise AssertionError("should not have been called")

        with pytest.raises(FetchError):
            await fetcher_with(handler).fetch("../../etc/passwd")

    def test_an_empty_api_key_is_rejected_at_construction(self):
        with pytest.raises(ValueError):
            YouTubeFetcher("")
