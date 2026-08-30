"""The LLM boundary.

Everything that talks to a model goes through `LlmProvider`. The pipeline
depends on the protocol, never on Gemini, for three reasons:

1. Tests run offline. `FakeProvider` returns canned JSON, so the extraction
   stage is tested for its parsing, mapping and validation logic without a
   network call, an API key, or a bill.
2. The provider is swappable. See `docs/adr/0002-llm-provider.md` — the build
   plan assumed Anthropic and we are on Gemini, which is exactly the kind of
   decision worth not hard-wiring twice.
3. Model availability genuinely moves. On a single day, gemini-2.5-flash
   returned 404 "no longer available to new users", gemini-3.6-flash returned
   503 "high demand", and gemini-3.5-flash served fine. A hardcoded model name
   is an outage waiting to happen, so the Gemini provider walks an ordered list.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any, Protocol

logger = logging.getLogger(__name__)

#: Tried in order. Ahead of the first that answers, everything else is a
#: fallback for 404 (model retired) and 503 (model saturated).
DEFAULT_MODEL_CHAIN: tuple[str, ...] = (
    "gemini-3.5-flash",
    "gemini-3.6-flash",
    "gemini-3.7-flash",
    "gemini-3.1-flash-lite",
)


class LlmError(RuntimeError):
    """The model could not be reached or would not answer."""


class LlmRefusedError(LlmError):
    """The model answered, but not with usable JSON."""


@dataclass(frozen=True)
class LlmResponse:
    """One completion, plus what it cost.

    Token counts are carried because cost-per-extraction is a Phase 7 metric and
    reconstructing it later is impossible.
    """

    data: dict[str, Any]
    model: str
    input_tokens: int
    output_tokens: int
    #: Models tried and rejected before this one answered.
    fallbacks: tuple[str, ...] = ()


class LlmProvider(Protocol):
    """Structured JSON completion. The only shape the pipeline knows about.

    `video_url` is the one concession to a media model: when set, the provider
    asks the model to watch that video alongside the prompt. It stays optional
    and keyword-only so every existing caller is unchanged, and so a provider
    that cannot see video can refuse it explicitly rather than ignoring it and
    silently answering from the prompt alone. See ADR 0006.
    """

    async def complete_json(
        self,
        *,
        prompt: str,
        schema: dict[str, Any],
        temperature: float = 0.0,
        video_url: str | None = None,
    ) -> LlmResponse: ...


@dataclass
class FakeProvider:
    """Deterministic provider for tests.

    Holds a queue of payloads and returns them in order, so a test can drive the
    stage through malformed output, refusals, and happy paths without a network.
    """

    responses: list[dict[str, Any] | Exception] = field(default_factory=list)
    calls: list[dict[str, Any]] = field(default_factory=list)
    model: str = "fake-model"

    async def complete_json(
        self,
        *,
        prompt: str,
        schema: dict[str, Any],
        temperature: float = 0.0,
        video_url: str | None = None,
    ) -> LlmResponse:
        # video_url is recorded rather than ignored: the fallback's whole point
        # is that the second call watches the video, and a test asserting the
        # fallback happened needs to see that it did.
        self.calls.append(
            {
                "prompt": prompt,
                "schema": schema,
                "temperature": temperature,
                "video_url": video_url,
            }
        )
        if not self.responses:
            raise LlmError("FakeProvider ran out of queued responses")
        nxt = self.responses.pop(0)
        if isinstance(nxt, Exception):
            raise nxt
        return LlmResponse(
            data=nxt,
            model=self.model,
            input_tokens=len(prompt) // 4,
            output_tokens=len(json.dumps(nxt)) // 4,
        )


class GeminiProvider:
    """Google AI Studio, via the official SDK.

    Walks `model_chain` until one answers. A 404 means the model was retired and
    a 503 means it is saturated; both are worth stepping past rather than
    failing the extraction, and both happened on the day this was written.
    """

    def __init__(
        self,
        api_key: str,
        model_chain: tuple[str, ...] = DEFAULT_MODEL_CHAIN,
    ) -> None:
        if not api_key:
            raise ValueError("GEMINI_API_KEY is empty")
        # Imported here so the module can be imported, and the protocol used,
        # without the SDK installed.
        from google import genai

        self._client = genai.Client(api_key=api_key)
        self._model_chain = model_chain

    async def complete_json(
        self,
        *,
        prompt: str,
        schema: dict[str, Any],
        temperature: float = 0.0,
        video_url: str | None = None,
    ) -> LlmResponse:
        from google.genai import types

        config = types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=schema,
            temperature=temperature,
            # This stage extracts, it does not call tools. Saying so explicitly
            # silences the SDK's automatic-function-calling advisory and removes
            # a code path we do not want reachable.
            automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
        )

        # A YouTube URL passed straight to the model: nothing is downloaded here
        # and no scraper is involved — Google processes a video already on
        # Google's platform. ADR 0006 covers why that is a different act from
        # the captions.download 401 that ADR 0001 documented.
        contents: Any = prompt
        if video_url is not None:
            contents = types.Content(
                parts=[
                    types.Part(file_data=types.FileData(file_uri=video_url, mime_type="video/*")),
                    types.Part(text=prompt),
                ]
            )

        tried: list[str] = []
        last_error: Exception | None = None

        for model in self._model_chain:
            try:
                response = await self._client.aio.models.generate_content(
                    model=model, contents=contents, config=config
                )
            except Exception as exc:
                if not _is_worth_falling_back(exc):
                    raise LlmError(f"{model}: {exc}") from exc
                logger.warning("model %s unavailable, falling back: %s", model, exc)
                tried.append(model)
                last_error = exc
                continue

            text = (response.text or "").strip()
            if not text:
                raise LlmRefusedError(f"{model} returned an empty body")
            try:
                data = json.loads(text)
            except json.JSONDecodeError as exc:
                raise LlmRefusedError(f"{model} returned non-JSON: {text[:200]}") from exc

            usage = response.usage_metadata
            return LlmResponse(
                data=data,
                model=model,
                input_tokens=getattr(usage, "prompt_token_count", 0) or 0,
                output_tokens=getattr(usage, "candidates_token_count", 0) or 0,
                fallbacks=tuple(tried),
            )

        raise LlmError(f"every model in the chain failed ({', '.join(tried)}): {last_error}")


def _is_worth_falling_back(exc: Exception) -> bool:
    """Is this a 'try the next model' failure rather than a real error?

    404 means the model was retired; 503 and 429 mean it is saturated. A 400 is
    our own bad request and stepping to another model would only hide it.
    """
    text = str(exc)
    return any(code in text for code in ("404", "429", "503", "UNAVAILABLE", "NOT_FOUND"))
