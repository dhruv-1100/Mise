"""The extraction pipeline, end to end.

    video_id
      -> fetch description        (youtube.py, 1 quota unit)
      -> normalize                (normalize.py, pure)
      -> LLM extraction           (extract.py via llm.py)
      -> unit canonicalisation    (units.py, pure)
      -> validation               (schema.py, on construction)

Every stage is a pure function or hidden behind a protocol, so the whole
pipeline runs offline in tests with a fake fetcher and a fake provider.

Entity resolution is deliberately absent. The canonical ingredient table it
would match against is guesswork until the Phase 2.2 labelled set says what is
actually in these recipes, and building it early means throwing it away.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.extract import extract_recipe
from app.llm import LlmProvider
from app.normalize import normalize_description
from app.schema import Creator, ExtractionInsufficient, ExtractionOk, SourceKind
from app.units import CanonicalQuantity, canonicalise
from app.youtube import DescriptionFetcher, VideoMetadata


@dataclass(frozen=True)
class PipelineStats:
    """What each stage did. Fed to the Phase 7 metrics and the eval harness."""

    description_lines: int
    lines_removed: int
    chapters_found: int
    input_tokens: int
    output_tokens: int
    model: str
    #: Ingredients whose quantity could be expressed in grams or millilitres.
    canonicalised_quantities: int

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens


@dataclass(frozen=True)
class PipelineOutput:
    result: ExtractionOk | ExtractionInsufficient
    metadata: VideoMetadata
    stats: PipelineStats
    #: Canonical gram/ml values, parallel to `result.recipe.ingredients`.
    #: Empty when the result is insufficient.
    canonical: tuple[CanonicalQuantity, ...] = field(default_factory=tuple)


async def run_pipeline(
    *,
    fetcher: DescriptionFetcher,
    provider: LlmProvider,
    video_id: str,
) -> PipelineOutput:
    """Fetch, clean, extract, canonicalise.

    Raises `FetchError` if the video cannot be reached; that is the caller's to
    turn into an error envelope. Everything after the fetch either produces a
    recipe or an explicit `insufficient_source_material`, never an exception.
    """
    metadata = await fetcher.fetch(video_id)

    normalized = normalize_description(metadata.description)

    creator = Creator(
        name=metadata.channel_title,
        channel_id=metadata.channel_id,
        # Attribution is non-negotiable, and it comes from here rather than from
        # the model, which has no way to know it and every incentive to guess.
        channel_url=metadata.channel_url,
    )

    result, response = await extract_recipe(
        provider,
        video_id=metadata.video_id,
        title=metadata.title,
        creator=creator,
        description=normalized.text,
    )

    canonical: tuple[CanonicalQuantity, ...] = ()
    if isinstance(result, ExtractionOk):
        canonical = tuple(
            canonicalise(ingredient.qty, ingredient.unit)
            for ingredient in result.recipe.ingredients
        )

    return PipelineOutput(
        result=result,
        metadata=metadata,
        canonical=canonical,
        stats=PipelineStats(
            description_lines=normalized.original_line_count,
            lines_removed=len(normalized.removed),
            chapters_found=len(normalized.chapters),
            input_tokens=response.input_tokens,
            output_tokens=response.output_tokens,
            model=response.model,
            canonicalised_quantities=sum(1 for c in canonical if c.is_canonical),
        ),
    )


__all__ = [
    "PipelineOutput",
    "PipelineStats",
    "SourceKind",
    "run_pipeline",
]
