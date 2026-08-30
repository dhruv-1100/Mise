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

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from app.extract import extract_recipe, extract_recipe_from_video
from app.llm import LlmError, LlmProvider, LlmResponse
from app.normalize import normalize_description
from app.schema import Creator, ExtractionInsufficient, ExtractionOk, JobStage, SourceKind
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
    #: Set when the video fallback was attempted and failed for a transient
    #: reason — every model in the chain 503ing, most often. Distinct from the
    #: fallback running and finding nothing: the first means "we do not know
    #: yet", the second means "there is no recipe". They must not be cached the
    #: same way, and they must not be told to the reader the same way.
    fallback_error: str | None = None

    #: Empty when the result is insufficient.
    canonical: tuple[CanonicalQuantity, ...] = field(default_factory=tuple)


#: Called as each stage begins. The worker uses it to publish live status;
#: nothing else does, so it defaults to a no-op rather than being required.
logger = logging.getLogger(__name__)

StageCallback = Callable[[JobStage], Awaitable[None]]


async def run_pipeline(
    *,
    fetcher: DescriptionFetcher,
    provider: LlmProvider,
    video_id: str,
    on_stage: StageCallback | None = None,
    watch_video: bool = True,
) -> PipelineOutput:
    """Fetch, clean, extract, canonicalise.

    Raises `FetchError` if the video cannot be reached; that is the caller's to
    turn into an error envelope. Everything after the fetch either produces a
    recipe or an explicit `insufficient_source_material`, never an exception.

    `on_stage` fires as each stage begins, which is what makes the progress
    screen show stage names rather than a spinner.
    """

    async def stage(s: JobStage) -> None:
        if on_stage is not None:
            await on_stage(s)

    await stage(JobStage.FETCHING)
    metadata = await fetcher.fetch(video_id)

    await stage(JobStage.NORMALIZING)
    normalized = normalize_description(metadata.description)

    creator = Creator(
        name=metadata.channel_title,
        channel_id=metadata.channel_id,
        # Attribution is non-negotiable, and it comes from here rather than from
        # the model, which has no way to know it and every incentive to guess.
        channel_url=metadata.channel_url,
    )

    await stage(JobStage.EXTRACTING)
    result, response = await extract_recipe(
        provider,
        video_id=metadata.video_id,
        title=metadata.title,
        creator=creator,
        description=normalized.text,
    )

    # The fallback (ADR 0006). ADR 0001 measured roughly one description in five
    # carrying no recipe at all, and until this existed that was where the
    # product stopped — the reader got a page explaining there was nothing, for
    # a video that plainly contains a recipe.
    #
    # Strictly second, never first. Watching costs around fifty times the input
    # tokens of reading a description and tens of seconds of wall clock, so the
    # cheap path runs for every video and this runs only where the cheap path
    # came back empty-handed.
    watched: LlmResponse | None = None
    fallback_error: str | None = None
    if watch_video and isinstance(result, ExtractionInsufficient):
        await stage(JobStage.WATCHING)
        try:
            video_result, watched = await extract_recipe_from_video(
                provider,
                video_id=metadata.video_id,
                title=metadata.title,
                creator=creator,
            )
        except LlmError as exc:
            # Best-effort, deliberately: the description stage has already
            # produced a correct answer and discarding it would be worse than
            # keeping it. But the caller is told the fallback did not get to
            # run, because "the description has no recipe" and "we could not
            # check the video" are different facts and only one of them is
            # final.
            logger.warning(
                "video fallback failed for %s, keeping description result: %s",
                metadata.video_id,
                exc,
            )
            fallback_error = str(exc)
        else:
            # Only take the video's answer if it actually found something. A
            # video extraction that also comes back empty must not overwrite the
            # description's reason with its own — "not a recipe video" is a worse
            # and less accurate explanation than "the description is only links",
            # and the no-recipe page shows that reason verbatim.
            if isinstance(video_result, ExtractionOk):
                result = video_result

    await stage(JobStage.CANONICALISING)
    canonical: tuple[CanonicalQuantity, ...] = ()
    if isinstance(result, ExtractionOk):
        canonical = tuple(
            canonicalise(ingredient.qty, ingredient.unit)
            for ingredient in result.recipe.ingredients
        )

    return PipelineOutput(
        result=result,
        fallback_error=fallback_error,
        metadata=metadata,
        canonical=canonical,
        stats=PipelineStats(
            description_lines=normalized.original_line_count,
            lines_removed=len(normalized.removed),
            chapters_found=len(normalized.chapters),
            # Both calls, when there were two. Phase 7's cost-per-extraction
            # metric is the whole reason these are carried, and a fallback that
            # spent fifty times the tokens must not report only the cheap half.
            input_tokens=response.input_tokens + (watched.input_tokens if watched else 0),
            output_tokens=response.output_tokens + (watched.output_tokens if watched else 0),
            model=watched.model if watched else response.model,
            canonicalised_quantities=sum(1 for c in canonical if c.is_canonical),
        ),
    )


__all__ = [
    "PipelineOutput",
    "PipelineStats",
    "SourceKind",
    "run_pipeline",
]
